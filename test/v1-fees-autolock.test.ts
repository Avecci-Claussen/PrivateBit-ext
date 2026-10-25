import { describe, expect, it } from "vitest";
import { autoLockDecision, touch } from "../src/lib/autolock.ts";
import { checkCustomFee, parsePrice, parseRecommendedFees, priceIsStale, PRICE_STALE_MS } from "../src/lib/requests.ts";
import { normalizePrefs } from "../src/lib/prefs.ts";

describe("fee parsing", () => {
  it("maps recommended fees to fast, normal and slow", () => {
    const f = parseRecommendedFees({ fastestFee: 3, halfHourFee: 2, hourFee: 2, economyFee: 1, minimumFee: 1, updateTime: 1_700_000_000 });
    expect(f).toMatchObject({ fast: 3, normal: 2, slow: 1, minimum: 1 });
    expect(f.updatedAt).toBe(1_700_000_000_000);
  });
  it("keeps fast >= normal >= slow >= minimum", () => {
    const f = parseRecommendedFees({ fastestFee: 1, halfHourFee: 5, economyFee: 9, minimumFee: 1 });
    expect(f.fast).toBeGreaterThanOrEqual(f.normal);
    expect(f.normal).toBeGreaterThanOrEqual(f.slow);
    expect(f.slow).toBeGreaterThanOrEqual(f.minimum);
  });
  it("rejects garbage", () => {
    expect(() => parseRecommendedFees({})).toThrow();
    expect(() => parseRecommendedFees(null)).toThrow();
  });
  it("guards custom rates", () => {
    expect(checkCustomFee(2, 1, 5)).toEqual({ ok: true });
    expect(checkCustomFee(0.5, 1, 5)).toEqual({ ok: false, reason: "too-low" });
    expect(checkCustomFee(Number.NaN, 1, 5)).toEqual({ ok: false, reason: "invalid" });
    expect(checkCustomFee(-1, 1, 5)).toEqual({ ok: false, reason: "invalid" });
    expect(checkCustomFee(1500, 1, 5)).toEqual({ ok: false, reason: "too-high" });
  });
  it("parses price and marks it stale after 30 minutes", () => {
    const p = parsePrice({ "fractal-bitcoin": { usd: 0.42, last_updated_at: 1000 } }, 2_000_000);
    expect(p.usd).toBe(0.42);
    expect(priceIsStale(p, p.fetchedAt + PRICE_STALE_MS - 1)).toBe(false);
    expect(priceIsStale(p, p.fetchedAt + PRICE_STALE_MS + 1)).toBe(true);
    expect(priceIsStale(null)).toBe(true);
    expect(() => parsePrice({})).toThrow();
  });
});

describe("auto-lock timing", () => {
  const M = 60_000;
  it("defaults to 15 minutes and only allows 5/15/30/60", () => {
    expect(normalizePrefs({}).lockMinutes).toBe(15);
    expect(normalizePrefs({ lockMinutes: 7 }).lockMinutes).toBe(15);
    expect(normalizePrefs({ lockMinutes: 60 }).lockMinutes).toBe(60);
  });
  it("locks after the idle span", () => {
    const s = touch(undefined, 0);
    expect(autoLockDecision(s, 15 * M - 1, 15).lock).toBe(false);
    expect(autoLockDecision(s, 15 * M, 15).lock).toBe(true);
  });
  it("activity resets the timer", () => {
    const s = touch(touch(undefined, 0), 10 * M);
    expect(autoLockDecision(s, 20 * M, 15).lock).toBe(false);
    expect(autoLockDecision(s, 25 * M, 15).lock).toBe(true);
  });
  it("never waits for a payment in progress (security audit v1)", () => {
    const s = { last: 0 };
    expect(autoLockDecision(s, 15 * M, 15).lock).toBe(true);
  });
  it("treats a 403 request-limit answer as rate limited, for fees and for chain reads", async () => {
    const { openChain } = await import("../src/lib/chain.ts");
    const { RateLimitedError } = await import("../src/lib/requests.ts");
    const { DEFAULT_CHAIN } = await import("../src/lib/network.ts");
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: -2004, msg: "exceeded the request limit for unauthenticated requests", data: null }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const chain = openChain(DEFAULT_CHAIN);
      await expect(chain.feeRates!()).rejects.toBeInstanceOf(RateLimitedError);
      await expect(chain.getTip()).rejects.toBeInstanceOf(RateLimitedError);
    } finally {
      globalThis.fetch = real;
    }
  });
});
