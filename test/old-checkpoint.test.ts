import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, hex } from "../src/lib/bytes.ts";
import { resetSharedChainForTests } from "../src/lib/blockshare.ts";
import type { ChainSource } from "../src/lib/chain.ts";
import { RateLimitedError } from "../src/lib/requests.ts";
import { memoryKv } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";

function coinbase(tag: number): Uint8Array {
  return concatBytes(
    new Uint8Array([2, 0, 0, 0, 1]),
    new Uint8Array(32),
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 2, 1, tag & 255, 0xff, 0xff, 0xff, 0xff, 1]),
    new Uint8Array(8),
    new Uint8Array([1, 0x51, 0, 0, 0, 0]),
  );
}

describe("a checkpoint saved by an older build", () => {
  it("finishes the half read block from the shared copy instead of asking the data service per transaction", async () => {
    resetSharedChainForTests();
    const raws = new Map<number, Uint8Array>();
    const hashes = new Map<number, string>();
    let prev: Uint8Array = new Uint8Array(32);
    for (let h = 60; h <= 103; h++) {
      const header = new Uint8Array(80);
      header.set(prev, 4);
      const raw = concatBytes(header, new Uint8Array([1]), coinbase(h));
      raws.set(h, raw);
      prev = sha256(sha256(header));
      hashes.set(h, hex(prev.slice().reverse()));
    }
    let perTx = 0;
    const source = {
      kind: "unisat",
      getTip: async () => ({ height: 103, hash: hashes.get(103)! }),
      getBlockHash: async (h: number) => hashes.get(h)!,
      getBlockRaw: async (h: number) => raws.get(h)!,
      getBlockTxids: async () => {
        perTx++;
        throw new RateLimitedError("data service limit");
      },
      getTxHex: async () => {
        perTx++;
        throw new RateLimitedError("data service limit");
      },
      broadcast: async () => {
        throw new Error("no broadcast in tests");
      },
      estimateFeeSatPerVb: async () => 1,
    } as unknown as ChainSource;

    const w = new PrivateBit(memoryKv());
    w.sourceOverride = source;
    await w.create({ password: "pw", birthday: 100 });
    const core = await w.core();
    // What an older build left behind: block 100 half read on the per-transaction path.
    await core.coins_.update((s) => ({ ...s, inflight: { height: 100, nextTx: 1, txids: ["ab".repeat(32), "cd".repeat(32)] } }), { flush: true });

    let p = await w.scanOnce();
    for (let i = 0; i < 5 && p.lastHeight < 103; i++) p = await w.scanOnce();
    expect(p.lastHeight).toBe(103);
    expect(perTx).toBe(0);
    const store = (await core.coins_.read()).store;
    expect(store.inflight).toBeUndefined();
  });
});
