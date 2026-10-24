import { describe, expect, it } from "vitest";
import { DUST, feeFor } from "../src/lib/coinselect.ts";
import { checkSplit, shufflePieces, splitBudget } from "../src/lib/split.ts";

describe("coin split amounts", () => {
  it("budget is one input and N taproot outputs", () => {
    const b = splitBudget(50_000_000n, 3, 1);
    expect(b.fee).toBe(feeFor(1, 3, 1));
    expect(b.spendable).toBe(50_000_000n - b.fee);
    expect(b.vbytes).toBeGreaterThan(100);
  });

  it("accepts user-chosen unequal amounts that spend the coin minus fee", () => {
    const { spendable } = splitBudget(10_000_000n, 3, 2);
    const a = 1_234_567n;
    const b = 2_222_222n;
    const c = spendable - a - b;
    const ok = checkSplit([a, b, c], spendable);
    expect(ok).toEqual({ ok: true, amounts: [a, b, c] });
  });

  it("rejects equal amounts, dust, and leftovers", () => {
    expect(checkSplit([1_000_000n, 1_000_000n], 2_000_000n).ok).toBe(false);
    expect(checkSplit([DUST - 1n, 2_000_000n], 2_000_000n + DUST - 1n).ok).toBe(false);
    expect(checkSplit([1_000_000n, 2_000_000n], 4_000_000n).ok).toBe(false);
    expect(checkSplit([3_000_000n, 2_000_000n], 4_000_000n).ok).toBe(false);
  });

  it("shuffles only when the user supplies entropy, and is stable for that entropy", () => {
    const items = ["0.4", "0.1", "0.25", "0.07"];
    const e1 = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const e2 = Uint8Array.from([200, 10, 50, 3, 9, 1, 8, 4]);
    const a = shufflePieces(items, e1);
    const b = shufflePieces(items, e1);
    const c = shufflePieces(items, e2);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...items].sort());
    expect([...c].sort()).toEqual([...items].sort());
    expect(a).not.toEqual(c);
  });
});
