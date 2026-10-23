import type { LabeledUtxo } from "./scan.ts";

export type Selected = {
  inputs: LabeledUtxo[];
  change: bigint;
  fee: bigint;
};

const P2TR_VBYTES = 57.5;
const P2TR_OUT_VBYTES = 43;
const OVERHEAD = 10.5;

export function coinSelect(
  utxos: LabeledUtxo[],
  target: bigint,
  feeRate: number,
  extraOutputs = 1,
  skip: Set<string> = new Set(),
): Selected {
  const available = utxos
    .filter((u) => !u.spent && !skip.has(`${u.txid}:${u.vout}`))
    .slice()
    .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  if (available.length === 0) throw new Error("no coins");

  const selected: LabeledUtxo[] = [];
  let total = 0n;
  const outCount = 1 + extraOutputs;
  for (const u of available) {
    selected.push(u);
    total += BigInt(u.value);
    const vbytes = OVERHEAD + selected.length * P2TR_VBYTES + outCount * P2TR_OUT_VBYTES;
    const fee = BigInt(Math.ceil(vbytes * feeRate));
    if (total >= target + fee) {
      const change = total - target - fee;
      const dust = 330n;
      if (change < dust) {
        return { inputs: selected, change: 0n, fee: fee + change };
      }
      return { inputs: selected, change, fee };
    }
  }
  throw new Error("insufficient funds");
}
