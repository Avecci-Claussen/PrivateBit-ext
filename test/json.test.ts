import { describe, expect, it } from "vitest";
import { jsonSafe } from "../src/lib/json.ts";

describe("jsonSafe", () => {
  it("turns bigint into strings so Chrome sendResponse can clone PLAN/PSBT payloads", () => {
    const raw = { fee: 226n, change: 8999860n, request: { amount: 1000000n, pj: undefined } };
    expect(() => JSON.stringify(raw)).toThrow(/BigInt/);
    const safe = jsonSafe(raw);
    expect(JSON.stringify(safe)).toBe(JSON.stringify({ fee: "226", change: "8999860", request: { amount: "1000000" } }));
  });
});
