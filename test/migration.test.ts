import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { spendSecret, taprootScriptPubKey } from "../src/lib/bip352.ts";
import { hex } from "../src/lib/bytes.ts";
import { deriveDataKey, sealJson } from "../src/lib/datastore.ts";
import { recordBroadcast, setHistoryLabel } from "../src/lib/history.ts";
import { accountFromVault } from "../src/lib/keys.ts";
import { INDEX_KEY, migrateLayout, scopedName } from "../src/lib/layout.ts";
import type { LabeledUtxo, ScanStore } from "../src/lib/scan.ts";
import { createMnemonic, lockVault, vaultFromMnemonic, type Kv } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";
import { dumpKv } from "./helpers/kv.ts";

/** One wallet as the v1 multi-wallet build wrote it: everything sealed with the data key. */
function v1Wallet(password: string, txid: string, value: string, label: string) {
  const mnemonic = createMnemonic(256);
  const unlocked = vaultFromMnemonic({ mnemonic, birthday: 100 });
  const account = accountFromVault(unlocked);
  const key = deriveDataKey(unlocked.seed);
  const tweak = new Uint8Array(32).fill(3);
  const sec = spendSecret({ spendSecret: account.spendSecret, tweak, label: null, scanSecret: account.scanSecret });
  const coin: LabeledUtxo = {
    txid,
    vout: 0,
    value,
    scriptPubKey: hex(taprootScriptPubKey(secp256k1.getPublicKey(sec, true).slice(1))),
    tweak: hex(tweak),
    label: null,
    k: 0,
    height: 150,
    spent: false,
  };
  const scan: ScanStore = { utxos: [coin], lastHeight: 160, tip: 160 };
  let history = recordBroadcast(null, {
    txid,
    kind: "self",
    amount: BigInt(value),
    fee: 0n,
    feeRate: 1,
    outpoints: [`${txid}:0`],
    now: 1_700_000_000_000,
  });
  history = setHistoryLabel(history, txid, `${label} history`);
  const values: Record<string, unknown> = {
    "privatebit.vault": lockVault(unlocked, password),
    "privatebit.scan": sealJson(key, "privatebit.scan", scan),
    "privatebit.history": sealJson(key, "privatebit.history", history),
    "privatebit.coinmeta": sealJson(key, "privatebit.coinmeta", { [`${txid}:0`]: { label, frozen: true } }),
    "privatebit.chain": { kind: "unisat", url: "https://open-api-fractal.unisat.io", payjoinDirectory: "https://payjo.in" },
  };
  return { mnemonic, values };
}

async function expectWallet(w: PrivateBit, password: string, txid: string, value: string, label: string): Promise<void> {
  await w.unlock(password);
  expect((await w.state()).balance).toBe("0"); // frozen coins are not spendable
  expect((await w.state()).frozen).toBe(value);
  const coins = await w.coins();
  expect(coins).toHaveLength(1);
  expect(coins[0]).toMatchObject({ txid, value, label, frozen: true, status: "frozen" });
  const hist = await w.history();
  expect(hist.entries.find((e) => e.txid === txid)?.label).toBe(`${label} history`);
}

describe("storage migration to per-wallet namespaces", () => {
  it("moves a single-wallet install (no directory) without losing coins, labels, frozen marks or history", async () => {
    const kv = dumpKv();
    const one = v1Wallet("pw-one", "a1".repeat(32), "5000", "Rent");
    await kv.set({ ...one.values, "privatebit.prefs": { lockMinutes: 5 } });
    const w = new PrivateBit(kv);
    expect((await w.state()).hasVault).toBe(true);
    const d = kv.dump();
    expect(d["privatebit.vault"]).toBeUndefined();
    expect(d[scopedName("legacy", "privatebit.vault")]).toEqual(one.values["privatebit.vault"]);
    expect(d["privatebit.prefs"]).toEqual({ lockMinutes: 5 });
    await expectWallet(w, "pw-one", "a1".repeat(32), "5000", "Rent");
  });

  it("moves the v1 multi-wallet layout (open wallet live, others packed) and keeps every wallet", async () => {
    const kv = dumpKv();
    const one = v1Wallet("pw-one", "b1".repeat(32), "7000", "Savings");
    const two = v1Wallet("pw-two", "b2".repeat(32), "9000", "Trip");
    const idTwo = "0123456789abcdef";
    await kv.set({
      ...one.values,
      "privatebit.session": { mnemonic: one.mnemonic, passphrase: "", birthday: 100 },
      // v1 grants held the words; migration must drop this, not move it.
      "privatebit.scan.grant": { mnemonic: one.mnemonic, passphrase: "", birthday: 100 },
      "privatebit.pack.0123456789abcdef": { v: 1, values: two.values },
      "privatebit.mounted": "legacy",
      [INDEX_KEY]: {
        v: 1,
        active: "legacy",
        wallets: [
          { id: "legacy", name: "Main", createdAt: 0, birthday: 100 },
          { id: idTwo, name: "Travel", createdAt: 1, birthday: 100 },
        ],
      },
    });
    const w = new PrivateBit(kv);
    const st = await w.state();
    expect(st.wallets?.map((x) => x.name)).toEqual(["Main", "Travel"]);
    const text = kv.text();
    expect(text).not.toContain("privatebit.pack.");
    expect(text).not.toContain('"privatebit.mounted"');
    expect(kv.dump()[scopedName("legacy", "privatebit.scan.grant")]).toBeUndefined();
    expect(kv.dump()["privatebit.scan.grant"]).toBeUndefined();
    await w.lock();
    await expectWallet(w, "pw-one", "b1".repeat(32), "7000", "Savings");
    await w.openWallet(idTwo);
    await expectWallet(w, "pw-two", "b2".repeat(32), "9000", "Trip");
  });

  it("is safe to repeat after a crash before the old keys were removed", async () => {
    const kv = dumpKv();
    const one = v1Wallet("pw-one", "c1".repeat(32), "1234", "Gift");
    await kv.set(one.values);
    let failRemove = true;
    const flaky: Kv = {
      get: (k) => kv.get(k),
      set: (i) => kv.set(i),
      async remove(keys) {
        if (failRemove) {
          failRemove = false;
          throw new Error("worker stopped");
        }
        return kv.remove(keys);
      },
    };
    await expect(migrateLayout(flaky)).rejects.toThrow(/worker stopped/);
    // The directory is the commit point; old keys are still there, nothing is lost.
    expect(kv.dump()["privatebit.vault"]).toBeDefined();
    expect(await migrateLayout(kv)).toBe("current");
    const w = new PrivateBit(kv);
    await expectWallet(w, "pw-one", "c1".repeat(32), "1234", "Gift");
  });

  it("does nothing on a fresh install", async () => {
    const kv = dumpKv();
    expect(await migrateLayout(kv)).toBe("empty");
    expect(kv.dump()).toEqual({});
  });
});
