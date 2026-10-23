import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import { taprootScriptPubKey } from "./bip352.ts";
import { equalBytes, fromHex, hex } from "./bytes.ts";
import type { LabeledUtxo, OwnedOutput } from "./scan.ts";
import { evenPriv } from "./schnorr-util.ts";
import { scureIdHex } from "./tx.ts";

export const PAYJOIN_PARTIES = 2;
export const RECEIVER_FEE_CONTRIB_SATS = 200n;
const DUST = 330n;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ""));
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}

function bytesToB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

export function looksLikePsbt(b64: string): boolean {
  try {
    const b = b64ToBytes(b64);
    return b[0] === 0x70 && b[1] === 0x73 && b[2] === 0x62 && b[3] === 0x74;
  } catch {
    return false;
  }
}

function parsePsbt(b64: string): btc.Transaction {
  return btc.Transaction.fromPSBT(b64ToBytes(b64), { allowUnknownOutputs: true, disableScriptCheck: true });
}

function inputKey(tx: btc.Transaction, i: number): string {
  const inp = tx.getInput(i);
  return `${scureIdHex(inp.txid!)}:${inp.index ?? 0}`;
}

function psbtFee(tx: btc.Transaction): bigint | null {
  let ins = 0n;
  let outs = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const a = tx.getInput(i).witnessUtxo?.amount;
    if (a === undefined) return null;
    ins += a;
  }
  for (let i = 0; i < tx.outputsLength; i++) {
    outs += tx.getOutput(i).amount ?? 0n;
  }
  return ins - outs;
}

const SIGHASH_NONE = 2;
const SIGHASH_SINGLE = 3;
const SIGHASH_ANYONECANPAY = 0x80;

function dangerousSighash(t: number | undefined): boolean {
  if (t === undefined) return false;
  const base = t & 0x1f;
  return (t & SIGHASH_ANYONECANPAY) !== 0 || base === SIGHASH_NONE || base === SIGHASH_SINGLE;
}

/**
 * BIP78 sender checklist (unsecured directory / pjos=0).
 * Original outputs must remain a subsequence: same scripts, amounts not decreased.
 * That is payment-output substitution disabled — a malicious mailbox cannot redirect the pay.
 */
export function validatePayjoinProposal(proposalB64: string, originalB64: string): string[] {
  const bad: string[] = [];
  if (proposalB64 === originalB64) bad.push("proposal equals original (receiver added nothing)");
  if (!looksLikePsbt(proposalB64)) bad.push("proposal is a PSBT");
  if (!looksLikePsbt(originalB64)) bad.push("original is a PSBT");
  if (bad.length) return bad;
  try {
    const orig = parsePsbt(originalB64);
    const prop = parsePsbt(proposalB64);
    if ((prop.version ?? 2) !== (orig.version ?? 2)) bad.push("transaction version unchanged");
    if ((prop.lockTime ?? 0) !== (orig.lockTime ?? 0)) bad.push("nLockTime unchanged");
    if (prop.inputsLength < orig.inputsLength + 1) {
      bad.push("receiver added at least one input");
    }
    let pi = 0;
    for (let i = 0; i < orig.inputsLength; i++) {
      const want = inputKey(orig, i);
      let found = false;
      while (pi < prop.inputsLength) {
        const got = inputKey(prop, pi);
        const seqO = orig.getInput(i).sequence;
        const seqP = prop.getInput(pi).sequence;
        pi += 1;
        if (got === want) {
          if (seqO !== undefined && seqP !== undefined && seqO !== seqP) {
            bad.push("sender input sequence unchanged");
          }
          found = true;
          break;
        }
      }
      if (!found) bad.push("our inputs are unchanged");
    }
    let po = 0;
    for (let i = 0; i < orig.outputsLength; i++) {
      const os = orig.getOutput(i).script;
      const oa = orig.getOutput(i).amount;
      if (!os || oa === undefined) {
        bad.push("original output incomplete");
        continue;
      }
      let found = false;
      while (po < prop.outputsLength) {
        const ps = prop.getOutput(po).script;
        const pa = prop.getOutput(po).amount;
        po += 1;
        if (ps && equalBytes(os, ps) && pa !== undefined && pa >= oa) {
          found = true;
          break;
        }
      }
      if (!found) bad.push("pjos=0: original outputs were not removed or decreased");
    }
    for (let i = 0; i < prop.inputsLength; i++) {
      if (dangerousSighash(prop.getInput(i).sighashType)) {
        bad.push("SIGHASH_NONE/SINGLE/ANYONECANPAY forbidden");
      }
    }
    const origFee = psbtFee(orig);
    const propFee = psbtFee(prop);
    if (origFee !== null && propFee !== null && propFee < origFee) {
      bad.push("absolute fee must not decrease");
    }
  } catch (e) {
    bad.push(e instanceof Error ? e.message : "proposal decode");
  }
  return bad;
}

export function originalInputKeys(originalB64: string): Set<string> {
  const tx = parsePsbt(originalB64);
  const keys = new Set<string>();
  for (let i = 0; i < tx.inputsLength; i++) keys.add(inputKey(tx, i));
  return keys;
}

/**
 * Receiver side of BIP78/77: add exactly one of our UTXOs and take it back as a
 * unique P2TR. Two parties. Fails if we cannot add an input.
 */
export function buildPayjoinProposal(args: {
  originalB64: string;
  receiverInput: LabeledUtxo;
  receiverSecret: Uint8Array;
  extraScript: Uint8Array;
  extraTweak: string;
}): { proposalB64: string; ourOutputs: OwnedOutput[]; added: { txid: string; vout: number; value: string } } {
  if (!looksLikePsbt(args.originalB64)) throw new Error("original is not a PSBT");
  const tx = parsePsbt(args.originalB64);
  const already = originalInputKeys(args.originalB64);
  const key = `${args.receiverInput.txid}:${args.receiverInput.vout}`;
  if (already.has(key)) throw new Error("receiver input already in original");

  const inValue = BigInt(args.receiverInput.value);
  let extraValue = inValue - RECEIVER_FEE_CONTRIB_SATS;
  if (extraValue < DUST) extraValue = inValue;
  if (extraValue > inValue) throw new Error("payjoin extra output exceeds receiver input");

  const next = new btc.Transaction({ allowUnknownOutputs: true, disableScriptCheck: true });
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const spk = inp.witnessUtxo?.script;
    const amt = inp.witnessUtxo?.amount;
    if (!spk || amt === undefined) throw new Error(`Payjoin original input ${i} missing witness UTXO`);
    next.addInput({
      txid: inp.txid!,
      index: inp.index ?? 0,
      witnessUtxo: { script: spk, amount: amt },
    });
  }
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    if (!o.script || o.amount === undefined) throw new Error(`Payjoin original output ${i} incomplete`);
    next.addOutput({ script: o.script, amount: o.amount });
  }
  const script = fromHex(args.receiverInput.scriptPubKey);
  next.addInput({
    txid: fromHex(args.receiverInput.txid),
    index: args.receiverInput.vout,
    witnessUtxo: { script, amount: inValue },
  });
  next.addOutput({ script: args.extraScript, amount: extraValue });

  const prevScripts: Uint8Array[] = [];
  const amounts: bigint[] = [];
  for (let i = 0; i < next.inputsLength; i++) {
    const inp = next.getInput(i);
    const spk = inp.witnessUtxo?.script;
    const amt = inp.witnessUtxo?.amount;
    if (!spk || amt === undefined) throw new Error(`Payjoin original input ${i} missing witness UTXO`);
    prevScripts.push(spk);
    amounts.push(amt);
  }

  const ourIndex = next.inputsLength - 1;
  const d = evenPriv(args.receiverSecret);
  const preimage = next.preimageWitnessV1(ourIndex, prevScripts, btc.SigHash.DEFAULT, amounts);
  const sig = schnorr.sign(preimage, d);
  next.updateInput(ourIndex, { finalScriptWitness: [sig] });

  const extraVout = next.outputsLength - 1;
  const ourOutputs: OwnedOutput[] = [
    {
      vout: extraVout,
      value: extraValue.toString(),
      scriptPubKey: hex(args.extraScript.length === 34 ? args.extraScript : taprootScriptPubKey(args.extraScript)),
      tweak: args.extraTweak,
      label: null,
      k: 0,
    },
  ];
  if (args.extraScript.length === 34) {
    ourOutputs[0]!.scriptPubKey = hex(args.extraScript);
  }

  const proposalB64 = bytesToB64(next.toPSBT());
  const violations = validatePayjoinProposal(proposalB64, args.originalB64);
  if (violations.length) throw new Error(`BIP78 checklist: ${violations.join("; ")}`);

  return {
    proposalB64,
    ourOutputs,
    added: { txid: args.receiverInput.txid, vout: args.receiverInput.vout, value: args.receiverInput.value },
  };
}

export function pickReceiverInput(utxos: LabeledUtxo[], originalB64: string): LabeledUtxo {
  const used = originalInputKeys(originalB64);
  const available = utxos
    .filter((u) => !u.spent && !used.has(`${u.txid}:${u.vout}`) && BigInt(u.value) >= DUST)
    .slice()
    .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  if (available.length === 0) {
    throw new Error("Payjoin needs a receiver UTXO to add as the second party's input");
  }
  return available[0]!;
}
