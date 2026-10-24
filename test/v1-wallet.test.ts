import { scopedName } from "../src/lib/layout.ts";
import { describe, expect, it } from "vitest";
import { isSealed } from "../src/lib/datastore.ts";
import { memoryKv, type Kv } from "../src/lib/vault.ts";
import { ALL_KEYS, PrivateBit } from "../src/lib/wallet.ts";
import type { LabeledUtxo, ScanStore } from "../src/lib/scan.ts";

function utxo(txid: string, value: string, extra: Partial<LabeledUtxo> = {}): LabeledUtxo {
  return { txid, vout: 0, value, scriptPubKey: "5120" + "ab".repeat(32), tweak: "cc".repeat(32), label: null, k: 0, height: 9, spent: false, ...extra };
}

function spyKv(): Kv & { dump(): Record<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    async get(keys) {
      const o: Record<string, unknown> = {};
      for (const k of keys) if (m.has(k)) o[k] = structuredClone(m.get(k));
      return o;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) m.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of keys) m.delete(k);
    },
    dump: () => Object.fromEntries(m),
  };
}

describe("encryption at rest", () => {
  it("never writes the scan, history, coin labels or one-time data in plaintext", async () => {
    const kv = spyKv();
    const w = new PrivateBit(kv);
    await w.create({ password: "pw", birthday: 8 });
    const scan = await w.loadScan();
    scan.utxos.push(utxo("aa".repeat(32), "12345"));
    await w.saveScan(scan);
    await w.setCoinMeta("aa".repeat(32) + ":0", { label: "Savings", frozen: true });
    await w.issueOneTime();
    const d = kv.dump();
    for (const k of ["privatebit.scan", "privatebit.history", "privatebit.coinmeta", "privatebit.onetime"]) {
      expect(isSealed(d[scopedName(w.activeId!, k)]), k).toBe(true);
    }
    const text = JSON.stringify(d);
    expect(text).not.toContain("aa".repeat(32));
    expect(text).not.toContain("Savings");
    expect(text).not.toContain("bc1p");
  });

  it("migrates a plaintext scan and chain secrets from an older version without losing coins", async () => {
    const kv = spyKv();
    const w = new PrivateBit(kv);
    await w.create({ password: "pw", birthday: 8 });
    await w.lock();
    // What an older build left behind.
    const legacyScan: ScanStore = { utxos: [utxo("bb".repeat(32), "50000")], lastHeight: 20, tip: 20 };
    await w.kv.set({
      "privatebit.scan": legacyScan,
      "privatebit.chain": { kind: "unisat", url: "https://open-api-fractal.unisat.io", unisatToken: "user-token-123", payjoinDirectory: "https://payjo.in" },
    });
    // Still readable while locked so nothing disappears before the first unlock.
    expect((await w.loadChain()).unisatToken).toBe("user-token-123");
    await w.unlock("pw");
    const d = kv.dump();
    const at = (k: string) => d[scopedName(w.activeId!, k)];
    expect(isSealed(at("privatebit.scan"))).toBe(true);
    expect(isSealed(at("privatebit.chain.secrets"))).toBe(true);
    expect(JSON.stringify(d)).not.toContain("user-token-123");
    expect((at("privatebit.chain") as { url: string }).url).toBe("https://open-api-fractal.unisat.io");
    const st = await w.state();
    expect(st.balance).toBe("50000");
    expect((await w.loadChain()).unisatToken).toBe("user-token-123");
    // Locked: state shows nothing and history is unreadable. Only the scan grant (no words,
    // no seed, no spend key) can still read the coin list so new payments are found.
    await w.lock();
    expect((await w.state()).balance).toBeUndefined();
    await expect(w.history()).rejects.toThrow(/locked/);
    // After the browser quits the grant is gone too: nothing is readable.
    await w.kv.remove(["privatebit.scan.grant"]);
    expect((await w.loadScan()).utxos).toHaveLength(0);
    await expect(w.saveScan(legacyScan)).rejects.toThrow(/locked/);
  });

  it("frozen coins leave the spendable balance and automatic selection", async () => {
    const w = new PrivateBit(memoryKv());
    await w.create({ password: "pw", birthday: 8 });
    const scan = await w.loadScan();
    scan.utxos.push(utxo("cc".repeat(32), "40000"), utxo("dd".repeat(32), "60000"));
    await w.saveScan(scan);
    await w.setCoinMeta("dd".repeat(32) + ":0", { frozen: true });
    const st = await w.state();
    expect(st.balance).toBe("40000");
    const coins = await w.coins();
    expect(coins.find((c) => c.outpoint.startsWith("dd"))?.status).toBe("frozen");
    const max = await w.maxAmount(1);
    expect(BigInt(max.amount) + BigInt(max.fee)).toBe(40000n);
  });
});

describe("one-time address and restore", () => {
  it("issues a single-use address and watches it", async () => {
    const w = new PrivateBit(memoryKv());
    await w.create({ password: "pw", birthday: 8 });
    const a = await w.issueOneTime();
    expect(a.index).toBe(0);
    expect((await w.issueOneTime()).address).toBe(a.address); // same open one until it is used
    const scan = await w.loadScan();
    expect(scan.watch?.some((x) => x.kind === "bip86" && x.index === 0)).toBe(true);
  });

  it("restore wipes local history and watches one-time indexes 0 to 4", async () => {
    const w = new PrivateBit(memoryKv());
    const mnemonic = await w.create({ password: "pw", birthday: 8 });
    const scan0 = await w.loadScan();
    scan0.utxos.push(utxo("ee".repeat(32), "1000"));
    await w.saveScan(scan0);
    await w.setCoinMeta("ee".repeat(32) + ":0", { label: "x" });
    expect((await w.history()).entries).toHaveLength(1);
    await w.restore({ mnemonic, password: "pw2", birthday: 8 });
    expect(Object.keys(await w.loadCoinMeta())).toHaveLength(0);
    const h = await w.history();
    expect(h.entries).toHaveLength(0);
    expect(h.rebuilding).toBe(true);
    const scan = await w.loadScan();
    const idx = (scan.watch ?? []).filter((x) => x.kind === "bip86").map((x) => x.index).sort();
    expect(idx).toEqual([0, 1, 2, 3, 4]);
    // A new one-time address after restore never reuses a watched index.
    expect((await w.issueOneTime()).index).toBe(5);
  });
});

describe("remove wallet", () => {
  it("needs the password and leaves nothing behind", async () => {
    const kv = spyKv();
    const w = new PrivateBit(kv);
    await w.create({ password: "pw", birthday: 8 });
    await w.issueOneTime();
    await kv.set({ "privatebit.prefs": { lockMinutes: 5 } });
    await expect(w.removeWallet("nope")).rejects.toThrow();
    await w.removeWallet("pw");
    expect(Object.keys(kv.dump())).toEqual([]);
    // The screens keep asking for state after removal; that must not write defaults back.
    await w.state();
    await w.loadChain();
    expect(Object.keys(kv.dump())).toEqual([]);
    expect(ALL_KEYS).toContain("privatebit.history");
  });
});

describe("no sync storage and no identity", () => {
  it("source never uses chrome.storage.sync or identity APIs", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(join(__dirname, "../src")).filter((f) => f.endsWith(".ts"))) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/storage\.sync|chrome\.identity|import\.meta\.env\.VITE_/);
    }
  });
});
