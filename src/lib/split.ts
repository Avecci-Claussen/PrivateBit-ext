import { DUST, estimateVbytes, feeFor } from "./coinselect.ts";

/**
 * Break one of our coins into several Silent Payment outputs we still own.
 * This is coin control, not CoinJoin: one wallet, one owner, no coordinator,
 * no one else's coins. Amounts are chosen by the user, then optionally shuffled
 * by the user, before anything is signed.
 */
export const SPLIT_MIN = 2;
export const SPLIT_MAX = 6;

export function splitBudget(
  value: bigint,
  pieces: number,
  feeRate: number,
): { fee: bigint; spendable: bigint; vbytes: number } {
  if (!Number.isInteger(pieces) || pieces < SPLIT_MIN || pieces > SPLIT_MAX) {
    throw new Error(`Split into ${SPLIT_MIN} to ${SPLIT_MAX} coins`);
  }
  const vbytes = estimateVbytes(1, pieces);
  const fee = feeFor(1, pieces, feeRate);
  const spendable = value - fee;
  if (spendable < DUST * BigInt(pieces)) throw new Error("This coin is too small to break into that many pieces");
  return { fee, spendable, vbytes };
}

export type SplitCheck =
  | { ok: true; amounts: bigint[] }
  | { ok: false; reason: string };

/** The user-chosen amounts must spend exactly the coin minus fee, stay above dust, and never match. */
export function checkSplit(amounts: bigint[], spendable: bigint): SplitCheck {
  if (amounts.length < SPLIT_MIN || amounts.length > SPLIT_MAX) {
    return { ok: false, reason: `Split into ${SPLIT_MIN} to ${SPLIT_MAX} coins` };
  }
  if (amounts.some((a) => a < DUST)) {
    return { ok: false, reason: "Each piece must be at least 330 sats so it can be spent later" };
  }
  const sum = amounts.reduce((a, b) => a + b, 0n);
  if (sum !== spendable) {
    const delta = sum > spendable ? sum - spendable : spendable - sum;
    return {
      ok: false,
      reason:
        sum > spendable
          ? `Pieces add up to more than this coin can hold after the fee (${delta} sats over)`
          : `Pieces leave ${delta} sats unassigned. Put the rest on a piece.`,
    };
  }
  if (new Set(amounts.map(String)).size !== amounts.length) {
    return { ok: false, reason: "Pieces must be different amounts. Equal outputs look like a mix." };
  }
  return { ok: true, amounts };
}

/** Fisher-Yates. Entropy is supplied at the moment the user hits Shuffle, not earlier. */
export function shufflePieces<T>(items: T[], entropy: Uint8Array): T[] {
  if (items.length < 2) return items.slice();
  if (entropy.length < items.length) throw new Error("shuffle entropy too short");
  const out = items.slice();
  let e = 0;
  for (let i = out.length - 1; i > 0; i--) {
    const mod = i + 1;
    let x = entropy[e++] ?? 0;
    const limit = 256 - (256 % mod);
    while (x >= limit) {
      if (e >= entropy.length) throw new Error("shuffle entropy exhausted");
      x = entropy[e++]!;
    }
    const j = x % mod;
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}
