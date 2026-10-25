import * as btc from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import {
  createSilentOutputs,
  decodeSilentAddress,
  encodeSilentAddress,
  spendSecret,
  taprootScriptPubKey,
} from "./bip352.ts";
import { evenPriv, tweakSpend } from "./schnorr-util.ts";
import { concatBytes, fromHex, hex } from "./bytes.ts";
import { sha256 } from "@noble/hashes/sha256";
import { coinSelect, estimateVbytes, maxSendable } from "./coinselect.ts";
import { checkSplit, splitBudget } from "./split.ts";
import { deRoundChange, FEE_JITTER, newPlanSeed, shuffleOutputs } from "./plan-random.ts";
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
  kind?: "sp" | "bip86" | "site";
  index?: number;
};

/**
 * Private key for one of our inputs. Silent Payment coins use spendSecret + tweak (unchanged).
 * A migration one-time coin uses its BIP86 key-path secret (internal key tweaked by TapTweak).
 */
export function inputSecret(
  account: Account,
  u: { tweak: string; label: number | null; kind?: "sp" | "bip86" | "site"; index?: number; scriptPubKey?: string },
): Uint8Array {
  if (u.kind === "site") {
    if (u.index === undefined || !account.site) throw new Error("site coin without an index");
    const k = account.site(u.index);
    if (u.scriptPubKey && u.scriptPubKey !== k.scriptPubKey) throw new Error("site coin script mismatch");
    return k.secret;
  }
  if (u.kind === "bip86") {
    if (u.index === undefined) throw new Error("one-time coin without an index");
    const k = account.oneTime(u.index);
    if (u.scriptPubKey && u.scriptPubKey !== k.scriptPubKey) throw new Error("one-time coin script mismatch");
    return k.secret;
  }
  const d = spendSecret({
    spendSecret: account.spendSecret,
    tweak: fromHex(u.tweak),
    label: u.label,
    scanSecret: account.scanSecret,
  });
  // Audit H1: a Payjoin link output is even(spend key) + tweak (tweakSpend), not the BIP352
  // spend key + tweak. They differ when the spend key has an odd Y. Pick the secret whose key is
  // the coin's output key, so coins already received this way can be spent.
  if (u.label === null && u.tweak.length === 64 && u.scriptPubKey && u.scriptPubKey.length === 68) {
    const want = u.scriptPubKey.slice(4).toLowerCase();
    if (hex(secp256k1.getPublicKey(d, true).slice(1)) !== want) {
      const pj = tweakSpend(account.spendSecret, fromHex(u.tweak));
      if (hex(pj.xonly) === want) return pj.secret;
    }
  }
  return d;
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
  /** Plan seed used for output order and the rounding fix (plan-random.ts). */
  seed?: string;
  /** No change output: `extra` sats above the plain fee went to the network instead. */
  changeless?: { extra: bigint };
  /** Paying an older address type: change is still Taproot (see buildSend). */
  changeTypeDiffers?: boolean;
};

export type PlanPayload = {
  /** Digest of exactly what Confirm will send (planDigest). Confirm is refused if it changed. */
  planId?: string;
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
  /** Plan seed. The review sends it back with Confirm so the same plan is rebuilt. */
  seed?: string;
  /** Fee rate actually used, after "Randomize fee slightly". */
  feeRate?: number;
  /** No change output; this many sats above the plain fee go to the network. */
  changeless?: { extra: string };
  changeTypeDiffers?: boolean;
  /** Coins being spent, grouped by their "who knows" label (null = not labelled). */
  inputLabels?: { label: string | null; outpoints: string[] }[];
  preview: {
    warnings: string[];
    outputs: { index: number; value: string; note: string }[];
    inputs: { index: number; value: string; note: string }[];
    fee: string | null;
  };
};

/**
 * Immutable id of a planned payment (audit M10): network, wallet, every input (outpoint,
 * value, script) and every output (script, value) in order. The fee follows from those.
 * Signatures are left out, so the same plan signed twice has the same id.
 */
export function planDigest(psbtBase64: string, ctx: { chain: string; wallet: string }): string {
  const bin = atob(psbtBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const tx = btc.Transaction.fromPSBT(bytes);
  const inputs: string[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const w = inp.witnessUtxo;
    inputs.push(`${hex(inp.txid!)}:${inp.index}:${w ? w.amount.toString() : "?"}:${w ? hex(w.script) : "?"}:${inp.sequence ?? ""}`);
  }
  const outputs: string[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    outputs.push(`${hex(o.script!)}:${o.amount!.toString()}`);
  }
  const text = JSON.stringify({ v: 1, chain: ctx.chain, wallet: ctx.wallet, version: tx.version, lockTime: tx.lockTime, inputs, outputs });
  return hex(sha256(new TextEncoder().encode(text)));
}

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
    ...(built.seed ? { seed: built.seed } : {}),
    ...(built.changeless ? { changeless: { extra: built.changeless.extra.toString() } } : {}),
    ...(built.changeTypeDiffers ? { changeTypeDiffers: true } : {}),
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
  /** The full account, or (while locked) only the secrets of these inputs, by "txid:vout". */
  account: Account | { scoped: Record<string, string> };
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
    let d: Uint8Array;
    if ("scoped" in args.account) {
      const h = args.account.scoped[`${u.txid}:${u.vout}`];
      if (!h) throw new Error("no key for this Payjoin input");
      d = evenPriv(fromHex(h));
    } else d = evenPriv(inputSecret(args.account, u));
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

/** Address type of a plain destination, for the change-type rule. */
export function destinationType(address: string): "tr" | "wpkh" | "wsh" | "other" {
  try {
    const t = btc.Address(NETWORK).decode(address).type;
    return t === "tr" || t === "wpkh" || t === "wsh" ? t : "other";
  } catch {
    return "other";
  }
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
  /** Leftover under this goes to the fee instead of a change output (default: dust only). */
  leftover?: bigint;
  /** Plan seed (plan-random.ts): output order and the rounding fix. Same seed, same plan. */
  seed?: string;
}): Promise<BuiltSend> {
  const request = parseBip21(args.destination);
  if (args.max && request.amount !== undefined) throw new Error("Max is not allowed when the link sets the amount");
  const payAmount = args.max
    ? maxSendable(args.utxos, args.feeRate, args.skipOutpoints, args.include).amount
    : request.amount ?? args.amount;
  if (payAmount <= 0n) throw new Error("amount required");
  const seed = args.seed ?? newPlanSeed();

  const extraOut = args.max ? 0 : 1; // change
  const selected = coinSelect(args.utxos, payAmount, args.feeRate, extraOut, {
    skip: args.skipOutpoints,
    include: args.include,
    leftover: args.leftover,
  });
  let change = selected.change;
  let fee = selected.fee;
  if (change > 0n) {
    // Change ending in 000 looks typed by a person. Nudge it with a few sats of fee, within
    // the fee band the user allows; the payment amount itself never changes.
    const band = BigInt(Math.floor(estimateVbytes(selected.inputs.length, 2) * args.feeRate * FEE_JITTER));
    const extra = deRoundChange(change, band, seed);
    change -= extra;
    fee += extra;
  }

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

  type Planned = { script: Uint8Array; amount: bigint; silent?: Uint8Array; ours?: { tweak: Uint8Array; k: number; label: number | null } };
  const planned: Planned[] = [];
  const ourVins = () => {
    const vins = [];
    for (const u of selected.inputs) {
      // Our own coin: its script is already known. Not looked up, so the txid is not sent anywhere.
      const d = inputSecret(args.account, u);
      vins.push({
        txid: u.txid,
        vout: u.vout,
        scriptSig: "",
        txinwitness: "",
        prevout: { scriptPubKey: { hex: u.scriptPubKey } },
        private_key: hex(evenPriv(d)),
      });
    }
    return extractEligibleVins(vins);
  };

  if (request.silent) {
    const eligible = ourVins();
    if (!eligible || eligible.length === 0) {
      throw new Error("no eligible inputs for Silent Payment shared secret");
    }
    const recips = [
      { address: request.address, count: 1 },
      ...(change > 0n ? [{ address: changeAddr, count: 1 }] : []),
    ];
    const outs = createSilentOutputs(eligible, recips);
    const values = change > 0n ? [payAmount, change] : [payAmount];
    outs.forEach((o, i) => {
      const amount = values[i] ?? payAmount;
      const isChange = change > 0n && i === outs.length - 1;
      const label = isChange ? CHANGE_LABEL : paySelf ? (request.address === changeAddr ? CHANGE_LABEL : null) : undefined;
      planned.push({ script: taprootScriptPubKey(o.xonly), amount, silent: o.xonly, ...(label !== undefined ? { ours: { tweak: o.tweak, k: o.k, label } } : {}) });
    });
  } else {
    planned.push({ script: destScript(request.address), amount: payAmount });
    if (change > 0n) {
      // Change is a Taproot output (a Silent Payment to our own change code). For a Taproot
      // payment that matches the payment's type. For an older address type (P2WPKH, P2WSH) a
      // matching change type would need a separate key path and a second signing scheme that
      // this wallet does not have, so change stays Taproot and the review says so.
      const eligible = ourVins();
      if (!eligible || eligible.length === 0) throw new Error("cannot create Silent Payment change without eligible inputs");
      const o = createSilentOutputs(eligible, [{ address: changeAddr, count: 1 }])[0]!;
      planned.push({ script: taprootScriptPubKey(o.xonly), amount: change, silent: o.xonly, ours: { tweak: o.tweak, k: o.k, label: CHANGE_LABEL } });
    }
  }

  // Random position for every output (no fixed "payment first, change last" pattern).
  shuffleOutputs(planned, seed).forEach((p, vout) => {
    tx.addOutput({ script: p.script, amount: p.amount });
    if (p.silent) silentOutputs.push(hex(p.silent));
    if (p.ours) {
      ourOutputs.push({
        vout,
        value: p.amount.toString(),
        scriptPubKey: hex(p.script),
        tweak: hex(p.ours.tweak),
        label: p.ours.label,
        k: p.ours.k,
      });
    }
  });

  for (let i = 0; i < selected.inputs.length; i++) {
    const u = selected.inputs[i];
    const d = evenPriv(inputSecret(args.account, u));
    const preimage = tx.preimageWitnessV1(i, prevScripts, btc.SigHash.DEFAULT, amounts);
    const sig = schnorr.sign(preimage, d);
    tx.updateInput(i, { finalScriptWitness: [sig] });
  }

  const psbt = tx.toPSBT();
  const raw = tx.extract();
  const destType = request.silent ? "sp" : destinationType(request.address);
  return {
    psbtBase64: btoa(String.fromCharCode(...psbt)),
    txHex: hex(raw),
    previewNote: destinationNeedsPayjoin(request)
      ? "Payjoin payment link (BIP77 HPKE + OHTTP). The mailbox cannot read this PSBT. You can close the window after Confirm send; don't lock."
      : request.pj
        ? "This is not a PrivateBit payment link (missing RK/OH). Payjoin will not run. Inputs are yours alone."
        : request.silent
          ? "Silent Payment. This send's inputs are yours alone. Payjoin only runs when both people use a PrivateBit payment link."
          : "Transparent destination; change is Silent Payment label m=0",
    request,
    change,
    fee,
    amount: payAmount,
    vbytes: estimateVbytes(selected.inputs.length, tx.outputsLength),
    silentOutputs,
    ourOutputs,
    seed,
    ...(selected.changeless && selected.changeless.extra > 0n ? { changeless: { extra: selected.changeless.extra } } : selected.changeless ? { changeless: { extra: 0n } } : {}),
    ...(change > 0n && destType !== "sp" && destType !== "tr" ? { changeTypeDiffers: true } : {}),
    signableInputs: selected.inputs.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      tweak: u.tweak,
      label: u.label,
      value: u.value,
      scriptPubKey: u.scriptPubKey,
      ...(u.kind === "bip86" || u.kind === "site" ? { kind: u.kind, index: u.index } : {}),
    })),
  };
}

/** One of our coins, broken into several Silent Payment outputs we still own. Not a mix. */
export async function buildSplit(args: {
  account: Account;
  coin: LabeledUtxo;
  amounts: bigint[];
  feeRate: number;
  source: ChainSource;
}): Promise<BuiltSend> {
  if (args.coin.spent) throw new Error("this coin was already spent");
  if (args.coin.height === 0) throw new Error("wait until this coin is in a block");
  if (args.coin.kind === "bip86") throw new Error("move this into your receive code first");
  const budget = splitBudget(BigInt(args.coin.value), args.amounts.length, args.feeRate);
  const checked = checkSplit(args.amounts, budget.spendable);
  if (!checked.ok) throw new Error(checked.reason);
  const planned = { pieces: checked.amounts, fee: budget.fee, amount: budget.spendable };
  const request = parseBip21(args.account.receive);
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  const script = fromHex(args.coin.scriptPubKey);
  const amountIn = BigInt(args.coin.value);
  tx.addInput({
    txid: fromHex(args.coin.txid),
    index: args.coin.vout,
    witnessUtxo: { script, amount: amountIn },
  });
  const prev = { scriptPubKey: fromHex(args.coin.scriptPubKey) };
  const d = evenPriv(inputSecret(args.account, args.coin));
  const eligible = extractEligibleVins([
    {
      txid: args.coin.txid,
      vout: args.coin.vout,
      scriptSig: "",
      txinwitness: "",
      prevout: { scriptPubKey: { hex: hex(prev.scriptPubKey) } },
      private_key: hex(d),
    },
  ]);
  if (!eligible || eligible.length === 0) {
    throw new Error("no eligible inputs for Silent Payment shared secret");
  }
  const outs = createSilentOutputs(eligible, [{ address: args.account.receive, count: planned.pieces.length }]);
  if (outs.length !== planned.pieces.length) throw new Error("could not create Silent Payment pieces");
  const paired = outs.map((o, i) => ({ o, amount: planned.pieces[i]! }));
  paired.sort((a, b) => hex(a.o.xonly).localeCompare(hex(b.o.xonly)));
  const silentOutputs: string[] = [];
  const ourOutputs: OwnedOutput[] = [];
  paired.forEach((p, i) => {
    tx.addOutput({ script: taprootScriptPubKey(p.o.xonly), amount: p.amount });
    silentOutputs.push(hex(p.o.xonly));
    ourOutputs.push({
      vout: i,
      value: p.amount.toString(),
      scriptPubKey: hex(taprootScriptPubKey(p.o.xonly)),
      tweak: hex(p.o.tweak),
      label: null,
      k: p.o.k,
    });
  });
  const preimage = tx.preimageWitnessV1(0, [script], btc.SigHash.DEFAULT, [amountIn]);
  const sig = schnorr.sign(preimage, d);
  tx.updateInput(0, { finalScriptWitness: [sig] });
  const psbt = tx.toPSBT();
  const raw = tx.extract();
  return {
    psbtBase64: btoa(String.fromCharCode(...psbt)),
    txHex: hex(raw),
    previewNote:
      "Breaks this coin into Silent Payment pieces you still own. Anyone who sees this transaction can tell the pieces were created together. Later you can spend one without spending the others. This is not a mix.",
    request,
    change: 0n,
    fee: planned.fee,
    amount: planned.amount,
    vbytes: estimateVbytes(1, planned.pieces.length),
    silentOutputs,
    ourOutputs,
    signableInputs: [
      {
        txid: args.coin.txid,
        vout: args.coin.vout,
        tweak: args.coin.tweak,
        label: args.coin.label,
        value: args.coin.value,
        scriptPubKey: args.coin.scriptPubKey,
      },
    ],
  };
}

/** Address for an output script (same prefixes on Fractal and Bitcoin). Null for scripts without one. */
export function addressOfScript(script: Uint8Array): string | null {
  try {
    return btc.Address(NETWORK).encode(btc.OutScript.decode(script));
  } catch {
    return null;
  }
}

/** The payment output of a transaction we built: the first output that is not one of ours. */
export function paymentOutputAddress(txHex: string, ourVouts: number[]): string | undefined {
  try {
    const tx = btc.Transaction.fromRaw(fromHexLocal(txHex), { allowUnknownOutputs: true, disableScriptCheck: true });
    for (let i = 0; i < tx.outputsLength; i++) {
      if (ourVouts.includes(i)) continue;
      const script = tx.getOutput(i).script;
      if (script) return addressOfScript(script) ?? undefined;
    }
  } catch {
    /* unknown layout: the row shows the entered recipient only */
  }
  return undefined;
}

function fromHexLocal(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Spending coins that different people know about in one payment tells each of them that the
 * coins belong to the same person. Groups the inputs by label; more than one group means warn.
 */
export function groupInputLabels(inputs: string[], labelOf: (outpoint: string) => string | undefined): { label: string | null; outpoints: string[] }[] {
  const groups = new Map<string, { label: string | null; outpoints: string[] }>();
  for (const op of inputs) {
    const l = labelOf(op)?.trim() || null;
    const key = l === null ? "\u0000none" : l.toLowerCase();
    const g = groups.get(key) ?? { label: l, outpoints: [] };
    g.outpoints.push(op);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function mergesLabels(groups: { label: string | null }[] | undefined): boolean {
  return (groups?.length ?? 0) > 1;
}

/** Payjoin only on a PrivateBit payment link (mailbox + RK). A plain pj= URL is not enough. */
export function destinationNeedsPayjoin(request: PaymentRequest): boolean {
  return Boolean(request.pj && request.receiverKey && request.receiverKey.length === 33);
}

export { decodeSilentAddress, NETWORK };
