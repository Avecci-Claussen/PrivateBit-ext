import { afterEach, describe, expect, it } from "vitest";
import { openChain } from "../src/lib/chain.ts";
import { FRACTAL } from "../src/lib/network.ts";

const HASH = "ab".repeat(32);
const LIMIT = JSON.stringify({ code: -2004, msg: "exceeded the request limit for unauthenticated requests", data: null });
const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

function mock(handler: (url: URL) => Response): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push(`${url.host}${url.pathname}`);
    return handler(url);
  }) as typeof fetch;
  return seen;
}

const cfg = { kind: "unisat" as const, url: FRACTAL.defaultUnisat, unisatToken: "" };

describe("public mode without a data service key", () => {
  it("reads the tip, block hashes and fees from the block explorer and never asks the data service", async () => {
    const seen = mock((url) => {
      if (url.host.includes("unisat")) return new Response(LIMIT, { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/blocks/tip/height") return new Response("2234567");
      if (url.pathname.startsWith("/api/block-height/")) return new Response(HASH);
      if (url.pathname === "/api/v1/fees/recommended")
        return new Response(JSON.stringify({ fastestFee: 3, halfHourFee: 2, hourFee: 2, economyFee: 1, minimumFee: 1 }));
      return new Response("nope", { status: 404 });
    });
    const src = openChain(cfg);
    expect(await src.getTip()).toEqual({ height: 2234567, hash: HASH });
    expect(await src.getBlockHash(2234500)).toBe(HASH);
    expect(await src.estimateFeeSatPerVb()).toBeGreaterThanOrEqual(1);
    const rates = await src.feeRates!();
    expect(rates.fast).toBeGreaterThanOrEqual(rates.slow);
    expect(seen.some((s) => s.includes("unisat"))).toBe(false);
  });

  it("falls back to the data service when the explorer is down", async () => {
    const seen = mock((url) => {
      if (url.host.includes("mempool")) return new Response("down", { status: 502 });
      if (url.pathname === "/v1/indexer/blockchain/info")
        return Response.json({ code: 0, msg: "ok", data: { blocks: 2234567, bestBlockHash: HASH } });
      if (url.pathname.includes("/block")) return Response.json({ code: 0, msg: "ok", data: { blockid: HASH, height: 2234567 } });
      return new Response("nope", { status: 404 });
    });
    const tip = await openChain(cfg).getTip();
    expect(tip.height).toBe(2234567);
    expect(seen.some((s) => s.includes("unisat"))).toBe(true);
  });

  it("reports the explorer error when both are unavailable", async () => {
    mock((url) => (url.host.includes("mempool") ? new Response("busy", { status: 429 }) : new Response(LIMIT, { status: 200 })));
    await expect(openChain(cfg).getTip()).rejects.toThrow(/mempool/);
  });
});
