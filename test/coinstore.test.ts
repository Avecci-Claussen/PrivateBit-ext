import { describe, expect, it, vi } from "vitest";

const seeds = vi.hoisted(() => ({ n: 0 }));
vi.mock("@scure/bip39", async (importOriginal) => {
  const real = await importOriginal<typeof import("@scure/bip39")>();
  return {
    ...real,
    mnemonicToSeedSync: (...a: Parameters<typeof real.mnemonicToSeedSync>) => {
      seeds.n += 1;
      return real.mnemonicToSeedSync(...a);
    },
  };
});

import { CoinStore, StaleWriteError } from "../src/lib/coinstore.ts";
import { emptyScanStore, type LabeledUtxo, type ScanStore } from "../src/lib/scan.ts";
import { PrivateBit } from "../src/lib/wallet.ts";
import { dumpKv } from "./helpers/kv.ts";

function coin(txid: string, value: string): LabeledUtxo {
  return { txid, vout: 0, value, scriptPubKey: "5120" + "22".repeat(32), tweak: "00".repeat(32), label: null, k: 0, height: 1, spent: false };
}

function memoryIo() {
  let disk: ScanStore = emptyScanStore(10);
  let writes = 0;
  return {
    io: {
      load: async () => ({ store: structuredClone(disk), marker: writes }),
      marker: async () => writes,
      persist: async (s: ScanStore) => {
        writes += 1;
        disk = structuredClone(s);
        return { store: s, marker: writes };
      },
    },
    get writes() {
      return writes;
    },
    get disk() {
      return disk;
    },
  };
}

describe("coin list single writer", () => {
  it("rejects a write prepared from an older rev", async () => {
    const m = memoryIo();
    const store = new CoinStore(m.io, 10);
    const snap = await store.read();
    await store.update((s) => ({ ...s, utxos: [...s.utxos, coin("aa".repeat(32), "5")] }));
    await expect(store.commit(snap.rev, { ...snap.store, lastHeight: 99 })).rejects.toBeInstanceOf(StaleWriteError);
    expect((await store.read()).store.utxos).toHaveLength(1);
    expect((await store.read()).store.lastHeight).toBe(9);
  });

  it("a send during a scan step is never overwritten by that step", async () => {
    const m = memoryIo();
    const store = new CoinStore(m.io, 10);
    // The scan reads, then spends time matching a block.
    const scanSnap = await store.read();
    const scanResult = { ...scanSnap.store, lastHeight: 50, utxos: [...scanSnap.store.utxos, coin("bb".repeat(32), "10")] };
    // Meanwhile a broadcast lands through the queue.
    await store.update((s) => ({ ...s, utxos: [...s.utxos, coin("cc".repeat(32), "3")] }), { flush: true });
    await expect(store.commit(scanSnap.rev, scanResult)).rejects.toBeInstanceOf(StaleWriteError);
    // The scan retries from a fresh read and keeps both.
    const again = await store.read();
    await store.commit(again.rev, { ...again.store, lastHeight: 50, utxos: [...again.store.utxos, coin("bb".repeat(32), "10")] });
    await store.flush();
    expect(m.disk.utxos.map((u) => u.value).sort()).toEqual(["10", "3"]);
    expect(m.disk.lastHeight).toBe(50);
  });

  it("coalesces scan steps into one write", async () => {
    const m = memoryIo();
    const store = new CoinStore(m.io, 30);
    for (let h = 10; h < 40; h++) {
      const snap = await store.read();
      await store.commit(snap.rev, { ...snap.store, lastHeight: h });
    }
    expect(m.writes).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(m.writes).toBe(1);
    expect(m.disk.lastHeight).toBe(39);
    expect(m.disk.rev).toBe(30);
  });

  it("a wallet rejects saveScan from a stale read", async () => {
    const w = new PrivateBit(dumpKv());
    await w.create({ password: "password1", birthday: 10 });
    const a = await w.loadScan();
    const b = await w.loadScan();
    a.utxos.push(coin("dd".repeat(32), "7"));
    await w.saveScan(a);
    b.lastHeight = 1000;
    await expect(w.saveScan(b)).rejects.toBeInstanceOf(StaleWriteError);
    const now = await w.loadScan();
    expect(now.utxos).toHaveLength(1);
    expect(now.lastHeight).toBe(9);
  });

  it("derives the seed once per unlock, not on every call", async () => {
    const w = new PrivateBit(dumpKv());
    await w.create({ password: "password1", birthday: 10 });
    await w.lock();
    await w.unlock("password1");
    const before = seeds.n;
    for (let i = 0; i < 10; i++) {
      await w.state();
      await w.coins();
      await w.loadScan();
      await w.history();
    }
    expect(seeds.n - before).toBe(0);
  });
});
