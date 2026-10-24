import { afterEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { concatBytes, hex } from "../src/lib/bytes.ts";
import { buildSharedBlock, IncompleteBlock, loadSharedBlock, resetSharedChainForTests, UnsupportedBlock } from "../src/lib/blockshare.ts";
import type { ChainSource } from "../src/lib/chain.ts";
import { backoffMs, coolingDown, netFetch, setHostLimitForTests } from "../src/lib/net.ts";
import { RateLimitedError } from "../src/lib/requests.ts";
import { emptyScanStore, scanStep, upsertUtxo, type LabeledUtxo } from "../src/lib/scan.ts";
import { accountFromVault } from "../src/lib/keys.ts";
import { createMnemonic, memoryKv, vaultFromMnemonic } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A chain of empty blocks with settable hashes. Raw blocks unsupported, so the per-transaction path runs. */
function chain(tip: number, hashes: Record<number, string> = {}) {
  const calls: number[] = [];
  const txids: Record<number, string[]> = {};
  const hexes: Record<string, string> = {};
  let gate: Promise<void> | undefined;
  let reached: () => void = () => {};
  const source: ChainSource = {
    kind: "unisat",
    async getTip() {
      return { height: state.tip, hash: hashes[state.tip] ?? "00" };
    },
    async getBlockHash(h) {
      return hashes[h] ?? `${h.toString(16).padStart(64, "0")}`;
    },
    async getBlockTxids(h) {
      calls.push(h);
      if (gate && h === state.gateAt) {
        reached();
        await gate;
      }
      return txids[h] ?? [];
    },
    async getBlockRaw() {
      throw new UnsupportedBlock();
    },
    async getTxHex(txid) {
      const h = hexes[txid];
      if (!h) throw new Error("429");
      return h;
    },
    async broadcast() {
      throw new Error("tests never broadcast");
    },
    async estimateFeeSatPerVb() {
      return 1;
    },
  };
  const state = {
    tip,
    gateAt: -1,
    source,
    calls,
    txids,
    hexes,
    hashes,
    /** Block the given height's fetch until release(); resolves `atGate` when the scan gets there. */
    hold(h: number) {
      state.gateAt = h;
      let release: () => void = () => {};
      gate = new Promise<void>((r) => (release = r));
      const atGate = new Promise<void>((r) => (reached = r));
      return { atGate, release };
    },
  };
  return state;
}

function opReturnTx(tag: number): { txid: string; hex: string } {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addOutput({ script: new Uint8Array([0x6a, 0x01, tag]), amount: 0n });
  tx.addInput({ txid: "11".repeat(32), index: tag, sequence: 0xffffffff, finalScriptSig: new Uint8Array([0x51]) });
  return { txid: tx.id, hex: tx.hex };
}

describe("network guard", () => {
  it("times out a call that never answers", async () => {
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
    }));
    await expect(netFetch("https://slow.test/x", {}, { timeoutMs: 30 })).rejects.toThrow(/timed out/);
  });

  it("cools down a host after a rate-limit answer and fails fast meanwhile", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("", { status: 429 });
    });
    await expect(netFetch("https://busy.test/a")).rejects.toBeInstanceOf(RateLimitedError);
    expect(coolingDown("https://busy.test/b")).toBe(true);
    await expect(netFetch("https://busy.test/b")).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toBe(1);
    // Other hosts are not affected.
    expect(coolingDown("https://other.test/")).toBe(false);
  });

  it("caps parallel requests per host", async () => {
    setHostLimitForTests("cap.test", { gapMs: 0, parallel: 2 });
    let active = 0;
    let peak = 0;
    vi.stubGlobal("fetch", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return new Response("ok");
    });
    await Promise.all(Array.from({ length: 6 }, (_, i) => netFetch(`https://cap.test/${i}`)));
    expect(peak).toBe(2);
  });

  it("backs off exponentially with jitter, within bounds", () => {
    expect(backoffMs(0, 1000, 60_000, () => 0)).toBe(500);
    expect(backoffMs(0, 1000, 60_000, () => 1)).toBe(1000);
    expect(backoffMs(3, 1000, 60_000, () => 0.5)).toBe(6000);
    expect(backoffMs(20, 1000, 60_000, () => 1)).toBe(60_000);
  });
});

describe("complete input data only", () => {
  it("refuses a block whose inputs cannot all be resolved, and caches nothing", async () => {
    resetSharedChainForTests();
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    tx.addOutput({ script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(7)]), amount: 1000n });
    tx.addInput({ txid: "22".repeat(32), index: 0, sequence: 0xffffffff, finalScriptSig: new Uint8Array([0x51]) });
    const raw = concatBytes(new Uint8Array(80), new Uint8Array([1]), tx.toBytes(true));
    await expect(buildSharedBlock(raw, 10, async () => undefined)).rejects.toBeInstanceOf(IncompleteBlock);

    let rawCalls = 0;
    const source = {
      kind: "core",
      async getBlockRaw() {
        rawCalls++;
        return raw;
      },
      async getBlockHash() {
        return "00";
      },
      async getTxHex() {
        return undefined as unknown as string;
      },
    } as unknown as ChainSource;
    await expect(loadSharedBlock(10, source)).rejects.toBeInstanceOf(IncompleteBlock);
    await expect(loadSharedBlock(10, source)).rejects.toBeInstanceOf(IncompleteBlock);
    expect(rawCalls).toBeGreaterThanOrEqual(2);
  });

  it("does not skip a block when its transaction list cannot be fetched", async () => {
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 5 }));
    const c = chain(6);
    c.source.getBlockTxids = async () => {
      throw new RateLimitedError("slow down");
    };
    await expect(scanStep(account, c.source, emptyScanStore(5), 6)).rejects.toThrow();
  });
});

describe("scanner runs", () => {
  it("rolls back and rescans after a reorg, dropping coins from replaced blocks", async () => {
    resetSharedChainForTests();
    const c = chain(103);
    const w = new PrivateBit(memoryKv());
    w.sourceOverride = c.source;
    await w.create({ password: "pw", birthday: 100 });
    let p = await w.scanOnce();
    expect(p.lastHeight).toBe(103);
    const core = await w.core();
    const coin: LabeledUtxo = {
      txid: "ab".repeat(32),
      vout: 0,
      value: "5000",
      scriptPubKey: "5120" + "cd".repeat(32),
      tweak: "ef".repeat(32),
      label: null,
      k: 0,
      height: 103,
      spent: false,
    };
    const older: LabeledUtxo = { ...coin, txid: "aa".repeat(32), height: 101 };
    await core.coins_.update((s) => {
      const next = { ...s, utxos: [...s.utxos] };
      upsertUtxo(next.utxos, coin);
      upsertUtxo(next.utxos, older);
      return next;
    }, { flush: true });

    // Blocks 102 and 103 are replaced.
    c.hashes[102] = "f2".repeat(32);
    c.hashes[103] = "f3".repeat(32);
    c.calls.length = 0;
    p = await w.scanOnce();
    expect(p.lastHeight).toBe(103);
    expect(c.calls).toEqual([102, 103]);
    const after = (await core.coins_.read()).store;
    expect(after.utxos.map((u) => u.txid)).toEqual([older.txid]);
    expect(after.recent?.find((r) => r[0] === 103)?.[1]).toBe("f3".repeat(32));
  });

  it("resumes mid-block from the saved checkpoint after a worker restart", async () => {
    resetSharedChainForTests();
    const kv = memoryKv();
    const c = chain(102);
    const a = opReturnTx(1);
    const b = opReturnTx(2);
    c.txids[101] = [a.txid, b.txid];
    c.hexes[a.txid] = a.hex; // the second one fails: rate limited
    const first = new PrivateBit(kv);
    first.sourceOverride = c.source;
    await first.create({ password: "pw", birthday: 100 });
    await first.scanOnce();
    const saved = (await (await first.core()).coins_.read()).store;
    expect(saved.lastHeight).toBe(100);
    expect(saved.inflight?.height).toBe(101);
    await (await first.core()).settle();

    // Worker restarts: a new instance on the same storage. No block list refetch for 101.
    c.hexes[b.txid] = b.hex;
    c.calls.length = 0;
    const second = new PrivateBit(kv);
    second.sourceOverride = c.source;
    const p = await second.scanOnce();
    expect(p.lastHeight).toBe(102);
    expect(c.calls).not.toContain(101);
    expect(c.calls).toContain(102);
  });

  it("switching wallets cancels the scan in progress, and nothing lands in the new wallet", async () => {
    resetSharedChainForTests();
    const c = chain(105);
    const w = new PrivateBit(memoryKv());
    w.sourceOverride = c.source;
    await w.create({ password: "one", birthday: 100 });
    const held = c.hold(102);
    const running = w.scanOnce();
    await held.atGate;
    await w.addWallet({ mnemonic: createMnemonic(256), password: "two", birthday: 104, name: "Two", kind: "create" });
    // The old run gives up without waiting for the stuck request.
    const result = await Promise.race([running.then(() => "stopped"), new Promise((r) => setTimeout(() => r("hung"), 2000))]);
    expect(result).toBe("stopped");
    held.release();
    const now = (await (await w.core()).coins_.read()).store;
    expect(now.lastHeight).toBe(103);
    expect(now.utxos).toEqual([]);
  });

  it("locking cancels the scan in progress", async () => {
    resetSharedChainForTests();
    const c = chain(105);
    const w = new PrivateBit(memoryKv());
    w.sourceOverride = c.source;
    await w.create({ password: "one", birthday: 100 });
    const held = c.hold(103);
    const running = w.scanOnce();
    await held.atGate;
    await w.lock();
    const result = await Promise.race([running.then(() => "stopped"), new Promise((r) => setTimeout(() => r("hung"), 2000))]);
    expect(result).toBe("stopped");
    held.release();
  });
});
