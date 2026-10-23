import type { LabeledUtxo } from "./scan.ts";

export type Selected = {
  inputs: LabeledUtxo[];
  change: bigint;
  fee: bigint;
};

const P2TR_VBYTES = 57.5;
const P2TR_OUT_VBYTES = 43;
const OVERHEAD = 10.5;

/** Virtual size estimate for n Taproot key-path inputs and m Taproot outputs. */
export function estimateVbytes(inputs: number, outputs: number): number {
  return Math.ceil(OVERHEAD + inputs * P2TR_VBYTES + outputs * P2TR_OUT_VBYTES);
}

export function feeFor(inputs: number, outputs: number, feeRate: number): bigint {
  return BigInt(Math.ceil((OVERHEAD + inputs * P2TR_VBYTES + outputs * P2TR_OUT_VBYTES) * feeRate));
}

const DUST = 330n;

export class CoinChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoinChoiceError";
  }
}

/**
 * Largest first. `skip` holds frozen and reserved outpoints and is always honored.
 * When `include` is given, exactly those coins are used (manual coin choice) and the
 * call fails instead of adding other coins.
 */
export function coinSelect(
  utxos: LabeledUtxo[],
  target: bigint,
  feeRate: number,
  extraOutputs = 1,
  skip: Set<string> = new Set(),
  include?: string[],
): Selected {
  const outCount = 1 + extraOutputs;
  if (include) {
    const want = new Set(include);
    if (want.size === 0) throw new CoinChoiceError("no coins chosen");
    for (const op of want) {
      if (skip.has(op)) throw new CoinChoiceError("a chosen coin is frozen or reserved");
    }
    const chosen = utxos.filter((u) => !u.spent && want.has(`${u.txid}:${u.vout}`));
    if (chosen.length !== want.size) throw new CoinChoiceError("a chosen coin is not in this wallet or already spent");
    const total = chosen.reduce((a, u) => a + BigInt(u.value), 0n);
    const fee = feeFor(chosen.length, outCount, feeRate);
    if (total < target + fee) throw new CoinChoiceError("not enough in the chosen coins");
    const change = total - target - fee;
    if (change < DUST) return { inputs: chosen, change: 0n, fee: fee + change };
    return { inputs: chosen, change, fee };
  }
  const available = utxos
    .filter((u) => !u.spent && !skip.has(`${u.txid}:${u.vout}`))
    .slice()
    .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  if (available.length === 0) throw new Error("no coins");

  const selected: LabeledUtxo[] = [];
  let total = 0n;
  for (const u of available) {
    selected.push(u);
    total += BigInt(u.value);
    const vbytes = OVERHEAD + selected.length * P2TR_VBYTES + outCount * P2TR_OUT_VBYTES;
    const fee = BigInt(Math.ceil(vbytes * feeRate));
    if (total >= target + fee) {
      const change = total - target - fee;
      if (change < DUST) {
        return { inputs: selected, change: 0n, fee: fee + change };
      }
      return { inputs: selected, change, fee };
    }
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
