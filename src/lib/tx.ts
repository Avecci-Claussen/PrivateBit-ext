import * as btc from "@scure/btc-signer";
import { concatBytes, fromHex, hex } from "./bytes.ts";
import { isTaprootScript } from "./bip352.ts";
import { assertParentTxHex } from "./policy.ts";

export type Prevout = {
  txid: string;
  vout: number;
  scriptPubKey: Uint8Array;
  value: bigint;
};

export type ParsedTx = {
  txid: string;
  hex: string;
  vin: { txid: string; vout: number; scriptSig: string; witness: string[] }[];
  vout: { scriptPubKey: Uint8Array; value: bigint }[];
};

/** @scure/btc-signer 1.8 returns tx.id as hex string; older builds used bytes. */
export function scureIdHex(id: string | Uint8Array): string {
  return typeof id === "string" ? id : hex(id);
}

export function parseTxHex(txHex: string): ParsedTx {
  const raw = fromHex(txHex);
  const tx = btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true, disableScriptCheck: true });
  const vin = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const txid = scureIdHex(inp.txid!);
    const vout = inp.index ?? 0;
    const scriptSig = inp.finalScriptSig ? hex(inp.finalScriptSig) : "";
    const witness = (inp.finalScriptWitness ?? []).map((w) => hex(w));
    vin.push({ txid, vout, scriptSig, witness });
  }
  const vout = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    vout.push({
      scriptPubKey: o.script!,
      value: o.amount ?? 0n,
    });
  }
  return { txid: scureIdHex(tx.id), hex: txHex, vin, vout };
}

export function voutFromParentHex(parentHex: string, vout: number): { scriptPubKey: Uint8Array; value: bigint } {
  const parent = parseTxHex(assertParentTxHex(parentHex, "parent"));
  if (vout < 0 || vout >= parent.vout.length) {
    throw new Error(`vout ${vout} missing in parent`);
  }
  return parent.vout[vout];
}

export function taprootOutputs(tx: ParsedTx): { xonly: Uint8Array; vout: number; value: bigint }[] {
  const out = [];
  for (let i = 0; i < tx.vout.length; i++) {
    const spk = tx.vout[i].scriptPubKey;
    if (isTaprootScript(spk)) {
      out.push({ xonly: spk.slice(2), vout: i, value: tx.vout[i].value });
    }
  }
  return out;
}

export function p2trScript(xonly: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([0x51, 0x20]), xonly);
}
