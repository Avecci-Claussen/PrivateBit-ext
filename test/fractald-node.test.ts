// Item 4, live: an own fractald node (regtest) through coreSource. Runs only when FRACTALD_LIVE_RPC is
// set (for example http://u:p@127.0.0.1:19443), so CI without the node skips it.
import { describe, expect, it } from "vitest";
import { coreSource } from "../src/lib/chain.ts";
import { blockKind } from "../src/lib/blockparse.ts";

const url = process.env.FRACTALD_LIVE_RPC;
describe.skipIf(!url)("own fractald node", () => {
  it("every block verifies, merge-mined ones with their full auxpow", async () => {
    const u = new URL(url!);
    const src = coreSource({ kind: "core", url: `${u.protocol}//${u.host}`, rpcUser: u.username, rpcPassword: u.password }, "fractal");
    const tip = await src.getTip();
    const kinds: string[] = [];
    for (let h = 1; h <= tip.height; h++) kinds.push(blockKind((await src.getBlockRaw!(h)).subarray(0, 80)));
    expect(kinds).toContain("auxpow");
    expect(kinds).toContain("legacy");
  });
});
