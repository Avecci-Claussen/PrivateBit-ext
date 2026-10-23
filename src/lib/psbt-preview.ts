import * as btc from "@scure/btc-signer";
import { hex } from "./bytes.ts";
import { isTaprootScript } from "./bip352.ts";
import { scureIdHex } from "./tx.ts";

export type PreviewRow = {
  kind: "in" | "out";
  index: number;
  value: string;
  script: string;
  note: string;
};

export type PsbtPreview = {
  inputs: PreviewRow[];
  outputs: PreviewRow[];
  inValue: bigint;
  outValue: bigint;
  fee: bigint | null;
  warnings: string[];
};

export function previewPsbt(psbtBytes: Uint8Array): PsbtPreview {
  const tx = btc.Transaction.fromPSBT(psbtBytes, {
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  });
  const inputs: PreviewRow[] = [];
  const outputs: PreviewRow[] = [];
  const warnings: string[] = [];
  let inValue = 0n;
  let outValue = 0n;
  let missingPrev = false;

  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const prev = inp.witnessUtxo;
    const value = prev?.amount ?? 0n;
    if (!prev) {
      missingPrev = true;
      warnings.push(`input ${i} missing witness UTXO`);
    } else {
      inValue += value;
    }
    const sighash = inp.sighashType;
    if (sighash !== undefined && (sighash & 0x80) !== 0) {
      warnings.push(`input ${i} uses SIGHASH_ANYONECANPAY, which is forbidden for Silent Payments`);
    }
    inputs.push({
      kind: "in",
      index: i,
      value: value.toString(),
      script: prev?.script ? hex(prev.script) : "",
      note: `${scureIdHex(inp.txid ?? new Uint8Array(32)).slice(0, 12)}…:${inp.index ?? 0}`,
    });
  }

  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    const value = o.amount ?? 0n;
    outValue += value;
    const spk = o.script ?? new Uint8Array();
    outputs.push({
      kind: "out",
      index: i,
      value: value.toString(),
      script: hex(spk),
      note: isTaprootScript(spk) ? "P2TR (Silent Payment or taproot)" : "non-taproot",
    });
  }

  return {
    inputs,
    outputs,
    inValue,
    outValue,
    fee: missingPrev ? null : inValue - outValue,
    warnings,
  };
}

export function previewPsbtBase64(b64: string): PsbtPreview {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return previewPsbt(bytes);
}
