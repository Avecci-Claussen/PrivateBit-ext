import { describe, expect, it } from "vitest";
import { openChain } from "../src/lib/chain.ts";
import { DEFAULT_CHAIN } from "../src/lib/network.ts";
import { envUnisatToken } from "./live-env.ts";

const live = !!envUnisatToken();

describe.skipIf(!live)("UniSat Fractal Open API (live)", () => {
  it("reads tip, fees, one block page, and rawtx", async () => {
    const src = openChain({ ...DEFAULT_CHAIN, unisatToken: envUnisatToken() || undefined });
    const tip = await src.getTip();
    expect(tip.height).toBeGreaterThan(2_000_000);
    expect(tip.hash.length).toBe(64);

    const fee = await src.estimateFeeSatPerVb();
    expect(fee).toBeGreaterThanOrEqual(1);

    const height = 2_228_000;
    const hash = await src.getBlockHash(height);
    expect(hash.length).toBe(64);

    const txids = await src.getBlockTxids(height);
    expect(txids.length).toBe(3);
    expect(txids.length).toBeGreaterThan(0);
    expect(txids[0]).toMatch(/^[0-9a-f]{64}$/i);

    const hex = await src.getTxHex(txids[0]);
    expect(hex.length).toBeGreaterThan(8);
    expect(hex).toMatch(/^[0-9a-f]+$/i);
  });
});
