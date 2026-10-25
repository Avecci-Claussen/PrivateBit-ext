/**
 * Randomness for one planned payment. Every random choice (output order, fee nudge, rounding
 * fix) comes from one 32-byte seed made with the system's secure random generator when the
 * payment is reviewed. Confirm rebuilds the plan from the same seed, so what is sent is exactly
 * what was reviewed (audit M10), and a new review gets new random choices.
 */
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, fromHex, hex } from "./bytes.ts";
import { DUST } from "./coinselect.ts";
import { shufflePieces } from "./split.ts";

export function newPlanSeed(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return hex(b);
}

export function isPlanSeed(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

/** `n` bytes for one purpose, derived from the seed (sha256 in counter mode). */
export function seedBytes(seed: string, tag: string, n = 32): Uint8Array {
  const base = concatBytes(fromHex(seed), new TextEncoder().encode(`PrivateBit plan v1:${tag}`));
  const out = new Uint8Array(n);
  for (let i = 0, ctr = 0; i < n; ctr++) {
    const block = sha256(concatBytes(base, new Uint8Array([ctr & 255, (ctr >>> 8) & 255])));
    out.set(block.slice(0, Math.min(32, n - i)), i);
    i += 32;
  }
  return out;
}

/** A uniform number in [0, 1) from 6 bytes. */
function unit(b: Uint8Array): number {
  let x = 0;
  for (let i = 0; i < 6; i++) x = x * 256 + (b[i] ?? 0);
  return x / 2 ** 48;
}

/** Fisher-Yates over the outputs, without modulo bias (rejection sampling in shufflePieces). */
export function shuffleOutputs<T>(items: T[], seed: string): T[] {
  return shufflePieces(items, seedBytes(seed, "outputs", 64));
}

/** How far "Randomize fee slightly" may move the rate, either way. */
export const FEE_JITTER = 0.05;

/**
 * The chosen rate moved by up to 5% either way, rounded to 0.01 sat/vB, and never below the
 * network minimum (or 1 sat/vB when the minimum is unknown).
 */
export function jitterFeeRate(rate: number, seed: string, minimum?: number): number {
  const u = unit(seedBytes(seed, "fee")) * 2 - 1;
  const floor = Math.max(minimum && Number.isFinite(minimum) && minimum > 0 ? minimum : 1, 0.01);
  const moved = Math.round(rate * (1 + u * FEE_JITTER) * 100) / 100;
  return Math.max(floor, moved);
}

/** Change that ends in 000 sats or more looks typed by a person, which can point at the payment. */
export function looksRound(sats: bigint): boolean {
  return sats > 0n && sats % 1000n === 0n;
}

/**
 * If the change looks round, take 1 to 97 sats from it and add them to the fee, but only
 * while the fee stays within `maxExtra` (the user's fee band) and the change stays above dust.
 * The payment amount never changes. Returns the extra fee taken (0 when nothing was done).
 */
export function deRoundChange(change: bigint, maxExtra: bigint, seed: string): bigint {
  if (!looksRound(change)) return 0n;
  const pick = BigInt(1 + (seedBytes(seed, "round")[0]! % 97));
  const extra = pick <= maxExtra ? pick : maxExtra;
  if (extra < 1n || change - extra < DUST) return 0n;
  return looksRound(change - extra) ? 0n : extra;
}

/**
 * `n` different amounts that add up to `total`, each at least a quarter of an even share and
 * never below dust. Used by "Randomize amounts" when splitting a coin.
 */
export function randomSplitAmounts(total: bigint, n: number, entropy: Uint8Array): bigint[] {
  if (!Number.isInteger(n) || n < 2) throw new Error("Split into at least 2 coins");
  const floor = total / BigInt(n * 4) > DUST ? total / BigInt(n * 4) : DUST;
  const free = total - floor * BigInt(n);
  if (free < BigInt(n)) throw new Error("This coin is too small to split into that many pieces");
  if (entropy.length < n * 6) throw new Error("split entropy too short");
  const weights: bigint[] = [];
  for (let i = 0; i < n; i++) weights.push(BigInt(1 + Math.floor(unit(entropy.slice(i * 6, i * 6 + 6)) * 1_000_000)));
  const sumW = weights.reduce((a, b) => a + b, 0n);
  const amounts = weights.map((w) => floor + (free * w) / sumW);
  let rest = total - amounts.reduce((a, b) => a + b, 0n);
  for (let i = 0; rest > 0n; i = (i + 1) % n, rest--) amounts[i]! += 1n;
  // Never two equal pieces: equal outputs look like a mix.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (amounts[i] === amounts[j] && amounts[j]! > DUST + 1n) {
        amounts[j]! -= 1n;
        amounts[i]! += 1n;
      }
    }
  }
  return amounts;
}

/** Random delay choices for "Delay sending by a random time". */
export type DelayChoice = "off" | "1m" | "10m" | "1h";
export const DELAY_CHOICES: DelayChoice[] = ["off", "1m", "10m", "1h"];
const DELAY_MAX: Record<DelayChoice, number> = { off: 0, "1m": 60_000, "10m": 600_000, "1h": 3_600_000 };

/** A secure random wait between a tenth of the chosen maximum and the maximum. */
export function randomDelayMs(choice: DelayChoice, entropy?: Uint8Array): number {
  const max = DELAY_MAX[choice] ?? 0;
  if (!max) return 0;
  const b = entropy ?? crypto.getRandomValues(new Uint8Array(8));
  return Math.round(max * 0.1 + unit(b) * max * 0.9);
}
