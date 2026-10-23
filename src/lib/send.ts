import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import {
  createSilentOutputs,
  decodeSilentAddress,
  encodeSilentAddress,
  spendSecret,
  taprootScriptPubKey,
} from "./bip352.ts";
import { evenPriv } from "./schnorr-util.ts";
import { concatBytes, fromHex, hex } from "./bytes.ts";
import { coinSelect, estimateVbytes, maxSendable } from "./coinselect.ts";
import type { Account } from "./keys.ts";
import { CHANGE_LABEL, FRACTAL } from "./network.ts";
import { parseBip21, type PaymentRequest } from "./bip21.ts";
import type { LabeledUtxo, OwnedOutput } from "./scan.ts";
import { extractEligibleVins } from "./extract-inputs.ts";
import { scureIdHex, voutFromParentHex } from "./tx.ts";
import { previewPsbtBase64 } from "./psbt-preview.ts";
import type { ChainSource } from "./chain.ts";

const NETWORK: typeof btc.NETWORK = {
  bech32: FRACTAL.bech32,
  pubKeyHash: FRACTAL.pubKeyHash,
  scriptHash: FRACTAL.scriptHash,
  wif: FRACTAL.wif,
};

export type SignableInput = {
  txid: string;
  vout: number;
  tweak: string;
  label: number | null;
  value: string;
  scriptPubKey: string;
  kind?: "sp" | "bip86";
  index?: number;
};

/**
 * Private key for one of our inputs. Silent Payment coins use spendSecret + tweak (unchanged).
 * A migration one-time coin uses its BIP86 key-path secret (internal key tweaked by TapTweak).
 */
export function inputSecret(
  account: Account,
  u: { tweak: string; label: number | null; kind?: "sp" | "bip86"; index?: number; scriptPubKey?: string },
): Uint8Array {
  if (u.kind === "bip86") {
    if (u.index === undefined) throw new Error("one-time coin without an index");
    const k = account.oneTime(u.index);
    if (u.scriptPubKey && u.scriptPubKey !== k.scriptPubKey) throw new Error("one-time coin script mismatch");
    return k.secret;
  }
  return spendSecret({
    spendSecret: account.spendSecret,
    tweak: fromHex(u.tweak),
    label: u.label,
    scanSecret: account.scanSecret,
  });
}

export type BuiltSend = {
  psbtBase64: string;
  txHex: string;
  previewNote: string;
  request: PaymentRequest;
  change: bigint;
  fee: bigint;
  amount: bigint;
  vbytes: number;
  silentOutputs: string[];
  ourOutputs: OwnedOutput[];
  signableInputs: SignableInput[];
};

export type PlanPayload = {
  psbtBase64: string;
  previewNote: string;
  request: { address: string; silent: boolean; pj?: string; amount?: string };
  change: string;
  fee: string;
  /** Amount paid to the destination, sats. */
  amount: string;
  /** Outpoints spent. */
  inputs: string[];
  vbytes: number;
  ourOutputs: OwnedOutput[];
  hasPayjoin: boolean;
  preview: {
    warnings: string[];
    outputs: { index: number; value: string; note: string }[];
    inputs: { index: number; value: string; note: string }[];
    fee: string | null;
  };
};

/** JSON-safe PLAN reply. Chrome cannot clone bigint; that was the Preview "no response". */
export function planPayload(built: BuiltSend): PlanPayload {
  const p = previewPsbtBase64(built.psbtBase64);
  return {
    psbtBase64: built.psbtBase64,
    previewNote: built.previewNote,
    request: {
      address: built.request.address,
      silent: built.request.silent,
      pj: built.request.pj,
      amount: built.request.amount?.toString(),
    },
    change: built.change.toString(),
    fee: built.fee.toString(),
    amount: built.amount.toString(),
    inputs: built.signableInputs.map((u) => `${u.txid}:${u.vout}`),
    vbytes: built.vbytes,
    ourOutputs: built.ourOutputs,
    hasPayjoin: destinationNeedsPayjoin(built.request),
    preview: {
      warnings: p.warnings,
      outputs: p.outputs.map((o) => ({ index: o.index, value: o.value, note: o.note })),
      inputs: p.inputs.map((o) => ({ index: o.index, value: o.value, note: o.note })),
      fee: p.fee === null ? null : p.fee.toString(),
    },
  };
}

export function signPayjoinProposal(args: {
  proposalB64: string;
  account: Account;
  inputs: SignableInput[];
}): { txHex: string } {
  const bin = atob(args.proposalB64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const tx = btc.Transaction.fromPSBT(bytes, { allowUnknownOutputs: true, disableScriptCheck: true });
  const prevScripts: Uint8Array[] = [];
  const amounts: bigint[] = [];
  const ours: (SignableInput | null)[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const txid = scureIdHex(inp.txid!);
    const vout = inp.index ?? 0;
    const match = args.inputs.find((u) => u.txid === txid && u.vout === vout) ?? null;
    ours.push(match);
    const script = inp.witnessUtxo?.script ?? (match ? fromHex(match.scriptPubKey) : undefined);
    const amount = inp.witnessUtxo?.amount ?? (match ? BigInt(match.value) : undefined);
    if (!script || amount === undefined) throw new Error(`Payjoin proposal input ${i} missing witness UTXO`);
    prevScripts.push(script);
    amounts.push(amount);
  }
  if (!ours.some(Boolean)) throw new Error("Payjoin proposal contains none of our inputs");
  for (let i = 0; i < ours.length; i++) {
    const u = ours[i];
    if (!u) continue;
    const sighash = tx.getInput(i).sighashType;
    if (sighash !== undefined) {
      const base = sighash & 0x1f;
      if ((sighash & 0x80) !== 0 || base === 2 || base === 3) {
        throw new Error("Payjoin proposal uses a forbidden sighash on our input");
      }
    }
    const d = evenPriv(inputSecret(args.account, u));
    const preimage = tx.preimageWitnessV1(i, prevScripts, btc.SigHash.DEFAULT, amounts);
    const sig = schnorr.sign(preimage, d);
    tx.updateInput(i, { finalScriptWitness: [sig] });
  }
  return { txHex: hex(tx.extract()) };
}

function destScript(address: string): Uint8Array {
  if (address.toLowerCase().startsWith("sp") || address.toLowerCase().startsWith("tsp")) {
    throw new Error("silent destination must be tweaked, not encoded as script");
  }
  const decoded = btc.Address(NETWORK).decode(address);
  if (decoded.type === "tr") return taprootScriptPubKey(decoded.pubkey);
  if (decoded.type === "wpkh") {
    return concatBytes(new Uint8Array([0x00, 0x14]), decoded.hash);
  }
  if (decoded.type === "wsh") {
    return concatBytes(new Uint8Array([0x00, 0x20]), decoded.hash);
  }
  throw new Error(`unsupported destination ${decoded.type}`);
}

export async function buildSend(args: {
  account: Account;
  utxos: LabeledUtxo[];
  destination: string;
  amount: bigint;
  feeRate: number;
  source: ChainSource;
  skipOutpoints?: Set<string>;
  /** Manual coin choice: exactly these outpoints, nothing else is added. */
  include?: string[];
  /** Send everything spendable (or everything chosen) in one output, no change. */
  max?: boolean;
}): Promise<BuiltSend> {
  const request = parseBip21(args.destination);
  if (args.max && request.amount !== undefined) throw new Error("Max is not allowed when the link sets the amount");
  const payAmount = args.max
    ? maxSendable(args.utxos, args.feeRate, args.skipOutpoints, args.include).amount
    : request.amount ?? args.amount;
  if (payAmount <= 0n) throw new Error("amount required");

  const extraOut = args.max ? 0 : 1; // change
  const selected = coinSelect(args.utxos, payAmount, args.feeRate, extraOut, args.skipOutpoints, args.include);

  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  const prevScripts: Uint8Array[] = [];
  const amounts: bigint[] = [];

  for (const u of selected.inputs) {
    const script = fromHex(u.scriptPubKey);
    const amount = BigInt(u.value);
    tx.addInput({
      txid: fromHex(u.txid),
      index: u.vout,
      witnessUtxo: { script, amount },
    });
    prevScripts.push(script);
    amounts.push(amount);
  }

  const silentOutputs: string[] = [];
  const ourOutputs: OwnedOutput[] = [];
  const changeAddr = encodeSilentAddress(
    args.account.scanPub,
    args.account.changeSpendPub,
    FRACTAL.spHrp,
  );
  const paySelf =
    request.silent &&
    (request.address === args.account.receive || request.address === changeAddr);

  const keepOurs = (o: {
    xonly: Uint8Array;
    tweak: Uint8Array;
    k: number;
  }, vout: number, value: bigint, label: number | null): void => {
    ourOutputs.push({
      vout,
      value: value.toString(),
      scriptPubKey: hex(taprootScriptPubKey(o.xonly)),
      tweak: hex(o.tweak),
      label,
      k: o.k,
    });
  };

  if (request.silent) {
    const vins = [];
    for (const u of selected.inputs) {
      const parent = await args.source.getTxHex(u.txid);
      const prev = voutFromParentHex(parent, u.vout);
      const d = inputSecret(args.account, u);
      vins.push({
        txid: u.txid,
        vout: u.vout,
        scriptSig: "",
        txinwitness: "",
        prevout: { scriptPubKey: { hex: hex(prev.scriptPubKey) } },
        private_key: hex(evenPriv(d)),
      });
    }
    const eligible = extractEligibleVins(vins);
    if (!eligible || eligible.length === 0) {
      throw new Error("no eligible inputs for Silent Payment shared secret");
    }
    const recips = [
      { address: request.address, count: 1 },
      ...(selected.change > 0n ? [{ address: changeAddr, count: 1 }] : []),
    ];
    const outs = createSilentOutputs(eligible, recips);
    const values = selected.change > 0n ? [payAmount, selected.change] : [payAmount];
    outs.forEach((o, i) => {
      const amount = values[i] ?? payAmount;
      tx.addOutput({ script: taprootScriptPubKey(o.xonly), amount });
      silentOutputs.push(hex(o.xonly));
      const isChange = selected.change > 0n && i === outs.length - 1;
      if (isChange) keepOurs(o, i, amount, CHANGE_LABEL);
      else if (paySelf) keepOurs(o, i, amount, request.address === changeAddr ? CHANGE_LABEL : null);
    });
  } else {
    tx.addOutput({ script: destScript(request.address), amount: payAmount });
    if (selected.change > 0n) {
      const vins = [];
      for (const u of selected.inputs) {
        const parent = await args.source.getTxHex(u.txid);
        const prev = voutFromParentHex(parent, u.vout);
        const d = inputSecret(args.account, u);
        vins.push({
          txid: u.txid,
          vout: u.vout,
          scriptSig: "",
          txinwitness: "",
          prevout: { scriptPubKey: { hex: hex(prev.scriptPubKey) } },
          private_key: hex(evenPriv(d)),
        });
      }
      const eligible = extractEligibleVins(vins);
      if (eligible && eligible.length) {
        const o = createSilentOutputs(eligible, [{ address: changeAddr, count: 1 }])[0];
        tx.addOutput({ script: taprootScriptPubKey(o.xonly), amount: selected.change });
        silentOutputs.push(hex(o.xonly));
        keepOurs(o, 1, selected.change, CHANGE_LABEL);
      } else {
        throw new Error("cannot create Silent Payment change without eligible inputs");
      }
    }
  }

  for (let i = 0; i < selected.inputs.length; i++) {
    const u = selected.inputs[i];
    const d = evenPriv(inputSecret(args.account, u));
    const preimage = tx.preimageWitnessV1(i, prevScripts, btc.SigHash.DEFAULT, amounts);
    const sig = schnorr.sign(preimage, d);
    tx.updateInput(i, { finalScriptWitness: [sig] });
  }

  const psbt = tx.toPSBT();
  const raw = tx.extract();
  return {
    psbtBase64: btoa(String.fromCharCode(...psbt)),
    txHex: hex(raw),
    previewNote: destinationNeedsPayjoin(request)
      ? "Payjoin payment link (BIP77 HPKE + OHTTP). The mailbox cannot read this PSBT. You can close the window after Confirm send; don't lock."
      : request.pj
        ? "This is not a PrivateBit payment link (missing RK/OH). Payjoin will not run. Inputs are yours alone."
        : request.silent
          ? "Silent Payment — this send's inputs are yours alone. Payjoin only runs when both people use a PrivateBit payment link."
          : "Transparent destination; change is Silent Payment label m=0",
    request,
    change: selected.change,
    fee: selected.fee,
    amount: payAmount,
    vbytes: estimateVbytes(selected.inputs.length, tx.outputsLength),
    silentOutputs,
    ourOutputs,
    signableInputs: selected.inputs.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      tweak: u.tweak,
      label: u.label,
      value: u.value,
      scriptPubKey: u.scriptPubKey,
      ...(u.kind === "bip86" ? { kind: "bip86" as const, index: u.index } : {}),
    })),
  };
}

/** Payjoin only on a PrivateBit payment link (mailbox + RK). A plain pj= URL is not enough. */
export function destinationNeedsPayjoin(request: PaymentRequest): boolean {
  return Boolean(request.pj && request.receiverKey && request.receiverKey.length === 33);
}

export { decodeSilentAddress, NETWORK };
