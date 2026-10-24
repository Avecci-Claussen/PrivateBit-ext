import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { taprootScriptPubKey } from "./bip352.ts";
import { equalBytes, fromHex, hex } from "./bytes.ts";
import type { LabeledUtxo, OwnedOutput } from "./scan.ts";
import { evenPriv } from "./schnorr-util.ts";
import { scureIdHex } from "./tx.ts";

export const PAYJOIN_PARTIES = 2;
/**
 * What the receiver's addition costs in block space: one Taproot key-path input (57.5 vB)
 * plus one Taproot output (43 vB). The receiver pays for it at the original fee rate, so
 * the Payjoin confirms as fast as the original would have (audit M6; was a fixed 200 sats).
 */
export const RECEIVER_ADDED_VBYTES = 101;
/** Never contribute less than 1 sat/vB worth. */
export const MIN_RECEIVER_CONTRIB_SATS = BigInt(RECEIVER_ADDED_VBYTES);
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

/** Rough vbytes per input by script type, for PSBTs whose inputs are not finalized. */
function inputVbytes(script: Uint8Array | undefined): number {
  if (!script) return 68;
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return 57.5; // P2TR key path
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return 68; // P2WPKH
  if (script.length === 23 && script[0] === 0xa9) return 91; // P2SH-P2WPKH
  return 148; // legacy
}

/** Virtual size of the transaction a PSBT describes (finalized if possible, else estimated). */
export function psbtVsize(tx: btc.Transaction): number {
  try {
    const v = tx.vsize;
    if (Number.isFinite(v) && v > 0) {
      let complete = true;
      for (let i = 0; i < tx.inputsLength; i++) {
        const inp = tx.getInput(i);
        if (!inp.finalScriptWitness && !inp.finalScriptSig) complete = false;
      }
      if (complete) return v;
    }
  } catch {
    /* not finalized: estimate */
  }
  let vb = 10.5;
  for (let i = 0; i < tx.inputsLength; i++) vb += inputVbytes(tx.getInput(i).witnessUtxo?.script);
  for (let i = 0; i < tx.outputsLength; i++) vb += 9 + (tx.getOutput(i).script?.length ?? 34);
  return Math.ceil(vb);
}

/** Original fee rate in sat/vB, or null when an input amount is missing. */
export function originalFeeRate(originalB64: string): number | null {
  const tx = parsePsbt(originalB64);
  const fee = psbtFee(tx);
  if (fee === null || fee < 0n) return null;
  return Number(fee) / psbtVsize(tx);
}

/** Receiver fee share: its added vbytes at the original fee rate (at least 1 sat/vB). */
export function receiverContribution(feeRate: number | null): bigint {
  const rate = Math.max(1, feeRate ?? 1);
  const sats = BigInt(Math.ceil(RECEIVER_ADDED_VBYTES * rate));
  return sats > MIN_RECEIVER_CONTRIB_SATS ? sats : MIN_RECEIVER_CONTRIB_SATS;
}

function scriptType(script: Uint8Array | undefined): string {
  if (!script) return "unknown";
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return "p2tr";
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return "p2wpkh";
  if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) return "p2wsh";
  if (script.length === 23 && script[0] === 0xa9) return "p2sh";
  if (script.length === 25 && script[0] === 0x76) return "p2pkh";
  return "other";
}

/**
 * BIP78 receiver checklist, run on the original before we add and sign anything (audit H8).
 * Returns the problems found; an empty list means it is safe to build a proposal.
 * - it is a complete, signed transaction that pays a positive fee (broadcastable as far as we
 *   can tell without a node),
 * - it pays this link's address, at least the requested amount,
 * - none of its inputs is ours (otherwise someone is probing which coins we own),
 * - all its inputs are Taproot, the only type we can add (same input type rule),
 * - no dangerous sighash flags.
 */
export function checkOriginal(args: {
  originalB64: string;
  payScript: string;
  amount?: bigint;
  ourOutpoints: ReadonlySet<string>;
  ourScripts: ReadonlySet<string>;
}): string[] {
  const bad: string[] = [];
  if (!looksLikePsbt(args.originalB64)) return ["original is not a PSBT"];
  let tx: btc.Transaction;
  try {
    tx = parsePsbt(args.originalB64);
  } catch {
    return ["original cannot be read"];
  }
  if (tx.inputsLength === 0 || tx.outputsLength === 0) bad.push("original has no inputs or no outputs");
  const pay = args.payScript.toLowerCase();
  let paid = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    if (!o.script || o.amount === undefined) {
      bad.push("original output incomplete");
      continue;
    }
    if (hex(o.script) === pay) paid += o.amount;
    if (o.amount < DUST && !(o.script[0] === 0x6a)) bad.push("original has a dust output");
  }
  if (paid === 0n) bad.push("original does not pay this payment link");
  else if (args.amount !== undefined && args.amount > 0n && paid < args.amount) bad.push("original pays less than requested");
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const key = inputKey(tx, i);
    if (args.ourOutpoints.has(key)) bad.push("original spends one of our coins");
    const spk = inp.witnessUtxo?.script;
    if (!spk || inp.witnessUtxo?.amount === undefined) bad.push("original input without amount and script");
    else {
      if (args.ourScripts.has(hex(spk))) bad.push("original spends one of our coins");
      if (scriptType(spk) !== "p2tr") bad.push("original inputs are not all Taproot");
    }
    if (!inp.finalScriptWitness && !inp.finalScriptSig) bad.push("original is not signed");
    if (dangerousSighash(inp.sighashType)) bad.push("original uses a forbidden sighash");
  }
  const fee = psbtFee(tx);
  if (fee === null || fee <= 0n) bad.push("original pays no fee");
  return [...new Set(bad)];
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
 * That is payment-output substitution disabled: a malicious mailbox cannot redirect the pay.
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
    if (prop.outputsLength > orig.outputsLength + 1) {
      bad.push("receiver added at most one extra output (optional payjoin output)");
    }
    // Same input type: if every original input has one script type, added inputs must match.
    const origTypes = new Set<string>();
    for (let i = 0; i < orig.inputsLength; i++) origTypes.add(scriptType(orig.getInput(i).witnessUtxo?.script));
    if (origTypes.size === 1) {
      const origKeys = new Set<string>();
      for (let i = 0; i < orig.inputsLength; i++) origKeys.add(inputKey(orig, i));
      for (let i = 0; i < prop.inputsLength; i++) {
        if (origKeys.has(inputKey(prop, i))) continue;
        if (!origTypes.has(scriptType(prop.getInput(i).witnessUtxo?.script))) bad.push("receiver inputs match our input type");
      }
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

/**
 * Txid of the proposal once the payer signs it. Sender inputs are Taproot (checked), so
 * signatures only add witness data and the txid is already fixed. Undefined if not computable.
 */
export function proposalTxid(proposalB64: string): string | undefined {
  try {
    const tx = parsePsbt(proposalB64);
    const unsigned = new btc.Transaction({ allowUnknownOutputs: true, disableScriptCheck: true, version: tx.version, lockTime: tx.lockTime });
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      unsigned.addInput({ txid: inp.txid!, index: inp.index ?? 0, sequence: inp.sequence });
    }
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      unsigned.addOutput({ script: o.script!, amount: o.amount! });
    }
    // Legacy (non-witness) serialization of the unsigned tx is exactly what the txid hashes.
    return hex(sha256(sha256(unsigned.toBytes(false, false))).reverse());
  } catch {
    return undefined;
  }
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
  const contribution = receiverContribution(originalFeeRate(args.originalB64));
  const extraValue = inValue - contribution;
  if (extraValue < DUST) throw new Error("the reserved coin is too small to pay its share of the fee");

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
