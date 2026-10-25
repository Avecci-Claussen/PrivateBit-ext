import type { LabeledUtxo } from "./scan.ts";

export type Selected = {
  inputs: LabeledUtxo[];
  change: bigint;
  fee: bigint;
  /** Set when no change output is made: this much above the plain fee goes to the network. */
  changeless?: { extra: bigint };
};

export const P2TR_VBYTES = 57.5;
export const P2TR_OUT_VBYTES = 43;
const OVERHEAD = 10.5;

/** Virtual size estimate for n Taproot key-path inputs and m Taproot outputs. */
export function estimateVbytes(inputs: number, outputs: number): number {
  return Math.ceil(OVERHEAD + inputs * P2TR_VBYTES + outputs * P2TR_OUT_VBYTES);
}

export function feeFor(inputs: number, outputs: number, feeRate: number): bigint {
  return BigInt(Math.ceil((OVERHEAD + inputs * P2TR_VBYTES + outputs * P2TR_OUT_VBYTES) * feeRate));
}

export const DUST = 330n;

/** What one more Taproot change output costs now plus what spending it later costs. */
export const CHANGE_LIFETIME_VBYTES = P2TR_OUT_VBYTES + P2TR_VBYTES;

/**
 * "Small leftover" rule: when the coins exceed amount plus fee by less than this, no change
 * output is made and the leftover goes to the network fee. "auto" is the larger of 1,000 sats
 * and what that change would cost to create and spend later at this fee rate. A number is a
 * fixed limit in sats; 0 keeps only the dust rule (330 sats).
 */
export type LeftoverPref = "auto" | number;
export const LEFTOVER_CHOICES: LeftoverPref[] = ["auto", 0, 500, 1000, 2500, 5000];

export function leftoverLimit(feeRate: number, pref: LeftoverPref = "auto"): bigint {
  if (pref === "auto") {
    const lifetime = BigInt(Math.ceil(CHANGE_LIFETIME_VBYTES * feeRate));
    return lifetime > 1000n ? lifetime : 1000n;
  }
  const n = BigInt(Math.max(0, Math.floor(pref)));
  return n > DUST ? n : DUST;
}

export class CoinChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoinChoiceError";
  }
}

export type SelectOptions = {
  /** Frozen and reserved outpoints. Always honored. */
  skip?: Set<string>;
  /** Manual coin choice: exactly these coins, nothing added. */
  include?: string[];
  /** Leftover below this is added to the fee instead of becoming change. Default: dust only. */
  leftover?: bigint;
};

const opOf = (u: LabeledUtxo): string => `${u.txid}:${u.vout}`;

/**
 * Fee and change for a fixed set of inputs. `outCount` counts the change output when there
 * is one. Returns null when the inputs do not cover amount plus fee.
 */
function settle(inputs: LabeledUtxo[], target: bigint, feeRate: number, outCount: number, leftover: bigint): Selected | null {
  const total = inputs.reduce((a, u) => a + BigInt(u.value), 0n);
  const hasChangeSlot = outCount > 1;
  const feeNoChange = feeFor(inputs.length, hasChangeSlot ? outCount - 1 : outCount, feeRate);
  if (total < target + feeNoChange) return null;
  if (!hasChangeSlot) return { inputs, change: 0n, fee: total - target, ...(total - target > feeNoChange ? { changeless: { extra: total - target - feeNoChange } } : {}) };
  const excess = total - target - feeNoChange;
  const feeWithChange = feeFor(inputs.length, outCount, feeRate);
  const change = total - target - feeWithChange;
  if (excess < leftover || change < DUST) {
    return { inputs, change: 0n, fee: feeNoChange + excess, changeless: { extra: excess } };
  }
  return { inputs, change, fee: feeWithChange };
}

/**
 * Coin choice, in this order:
 * 1. One coin that pays amount plus fee with no change (smallest leftover wins).
 * 2. One coin that pays with change (the smallest such coin, so the least change goes back
 *    and the bigger coins stay untouched).
 * 3. Several coins, largest first.
 * Leftover under `leftover` (and always under dust) becomes fee, never a change output.
 * Manual choice (`include`) uses exactly the chosen coins and fails instead of adding others.
 */
export function coinSelect(
  utxos: LabeledUtxo[],
  target: bigint,
  feeRate: number,
  extraOutputs = 1,
  skipOrOpts: Set<string> | SelectOptions = new Set(),
  include?: string[],
): Selected {
  const opts: SelectOptions = skipOrOpts instanceof Set ? { skip: skipOrOpts, include } : skipOrOpts;
  const skip = opts.skip ?? new Set<string>();
  const leftover = opts.leftover ?? DUST;
  const outCount = 1 + extraOutputs;
  if (opts.include) {
    const want = new Set(opts.include);
    if (want.size === 0) throw new CoinChoiceError("no coins chosen");
    for (const op of want) {
      if (skip.has(op)) throw new CoinChoiceError("a chosen coin is frozen, reserved or protected (it may hold an inscription or rune; unlock it in Coins first)");
    }
    const chosen = utxos.filter((u) => !u.spent && want.has(opOf(u)));
    if (chosen.length !== want.size) throw new CoinChoiceError("a chosen coin is not in this wallet or already spent");
    const done = settle(chosen, target, feeRate, outCount, leftover);
    if (!done) throw new CoinChoiceError("not enough in the chosen coins");
    return done;
  }
  const available = utxos
    .filter((u) => !u.spent && !skip.has(opOf(u)))
    .slice()
    .sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0));
  if (available.length === 0) throw new Error("no coins");

  // 1 and 2: a single coin.
  let bestNoChange: Selected | null = null;
  let bestWithChange: Selected | null = null;
  for (const u of available) {
    const r = settle([u], target, feeRate, outCount, leftover);
    if (!r) continue;
    if (r.change === 0n) {
      if (!bestNoChange || r.fee < bestNoChange.fee) bestNoChange = r;
    } else if (!bestWithChange || r.change < bestWithChange.change) {
      bestWithChange = r;
    }
  }
  if (bestNoChange) return bestNoChange;
  if (bestWithChange) return bestWithChange;

  // 3: several coins, largest first.
  const selected: LabeledUtxo[] = [];
  for (const u of available) {
    selected.push(u);
    const r = settle(selected.slice(), target, feeRate, outCount, leftover);
    if (r) return r;
  }
  throw new Error("insufficient funds");
}

/** Everything spendable in one output with no change: the Max amount. */
export function maxSendable(
  utxos: LabeledUtxo[],
  feeRate: number,
  skip: Set<string> = new Set(),
  include?: string[],
): { amount: bigint; fee: bigint; inputs: number } {
  const want = include ? new Set(include) : null;
  const coins = utxos.filter(
    (u) => !u.spent && !skip.has(`${u.txid}:${u.vout}`) && (!want || want.has(`${u.txid}:${u.vout}`)),
  );
  if (coins.length === 0) return { amount: 0n, fee: 0n, inputs: 0 };
  const total = coins.reduce((a, u) => a + BigInt(u.value), 0n);
  const fee = feeFor(coins.length, 1, feeRate);
  const amount = total - fee;
  return { amount: amount > DUST ? amount : 0n, fee, inputs: coins.length };
}
