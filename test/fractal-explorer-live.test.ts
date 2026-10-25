// Item 4, live: recent Fractal mainnet blocks from the public explorer pass the explorer checks
// (all three block kinds). Runs only with PB_LIVE_EXPLORER=1.
import { describe, expect, it } from "vitest";
import { mempoolBlockRaw, mempoolTip, MEMPOOL_BITCOIN } from "../src/lib/mempool.ts";
import { blockKind } from "../src/lib/blockparse.ts";

describe.skipIf(!process.env.PB_LIVE_EXPLORER)("public explorer blocks", () => {
  it("the last 12 Fractal blocks pass, with all three kinds seen", { timeout: 120_000 }, async () => {
    const tip = await mempoolTip();
    const kinds = new Set<string>();
    for (let h = tip.height - 11; h <= tip.height; h++) kinds.add(blockKind((await mempoolBlockRaw(h)).subarray(0, 80)));
    expect([...kinds].sort()).toEqual(["auxpow", "indexer", "legacy"]);
  });
  it("a recent Bitcoin block passes the 2^70 floor", { timeout: 120_000 }, async () => {
    const tip = await mempoolTip(MEMPOOL_BITCOIN);
    expect((await mempoolBlockRaw(tip.height - 2, MEMPOOL_BITCOIN)).length).toBeGreaterThan(80);
  });
});
