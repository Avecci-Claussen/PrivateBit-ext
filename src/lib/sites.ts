/**
 * Website accounts.
 *
 * Each connected website gets its own Taproot (BIP86) account, derived from the wallet seed:
 *
 *   m/86'/coin'/siteIndex'/0/0     coin = 8228 on Fractal, 0 on Bitcoin
 *   siteIndex = (first 4 bytes of sha256("PrivateBit site account" 0x00 origin [0x00 attempt]) & 0x3fffffff) | 0x40000000
 *
 * siteIndex is hardened and always 2^30 or more, so it can never meet the wallet's own BIP86
 * accounts (0 for migration one-time addresses, 352 on Bitcoin). The same origin gives the same
 * account after a restore. A website only ever sees this account: never the sp1 code, the private
 * coins, other websites' accounts or the wallet name.
 *
 * Everything here is pure and unit tested: derivation inputs, PSBT review, signing, messages.
 */
import * as btc from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, fromHex, hex } from "./bytes.ts";
import { estimateVbytes, DUST } from "./coinselect.ts";
import type { LabeledUtxo } from "./scan.ts";
import { FRACTAL, type NetworkId } from "./network.ts";

const NETWORK: typeof btc.NETWORK = {
  bech32: FRACTAL.bech32,
  pubKeyHash: FRACTAL.pubKeyHash,
  scriptHash: FRACTAL.scriptHash,
  wif: FRACTAL.wif,
};
const te = new TextEncoder();

export type SiteRecord = {
  origin: string;
  index: number;
  connected: boolean;
  connectedAt: number;
  lastUsed?: number;
};
export type SiteStore = { v: 1; sites: SiteRecord[] };
export function emptySites(): SiteStore {
  return { v: 1, sites: [] };
}

/** "https://app.example.com:8443" style origin, or throws. Paths, users and fragments are dropped. */
export function normalizeOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("bad origin");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only http and https pages can connect");
  if (!u.hostname) throw new Error("bad origin");
  return u.origin.toLowerCase();
}

/**
 * Plain http is allowed only for loopback and private IP literals (a node or app on
 * this computer or the home network). Names other than localhost are refused because
 * anyone on the path can answer for them.
 */
export function cleartextAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

/** Host part shown to the user ("app.example.com", port kept when not default). */
export function siteHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function siteIndex(origin: string, attempt = 0): number {
  const parts = [te.encode("PrivateBit site account"), new Uint8Array([0]), te.encode(normalizeOrigin(origin))];
  if (attempt > 0) parts.push(new Uint8Array([0, attempt & 0xff]));
  const h = sha256(concatBytes(...parts));
  const u32 = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  return ((u32 & 0x3fffffff) | 0x40000000) >>> 0;
}

/** A free index for origin given the records already stored (another origin with the same hash moves on). */
export function pickSiteIndex(origin: string, existing: SiteRecord[]): number {
  for (let attempt = 0; attempt < 256; attempt++) {
    const index = siteIndex(origin, attempt);
    const taken = existing.find((s) => s.index === index);
    if (!taken || taken.origin === origin) return index;
  }
  throw new Error("no free site index");
}

export function upsertSite(store: SiteStore, origin: string, now: number): { store: SiteStore; site: SiteRecord } {
  const o = normalizeOrigin(origin);
  const prev = store.sites.find((s) => s.origin === o);
  const site: SiteRecord = prev
    ? { ...prev, connected: true, lastUsed: now }
    : { origin: o, index: pickSiteIndex(o, store.sites), connected: true, connectedAt: now, lastUsed: now };
  return { store: { v: 1, sites: [...store.sites.filter((s) => s.origin !== o), site] }, site };
}

export type SiteKey = {
  index: number;
  path: string;
  scriptPubKey: string;
  address: string;
  /** Compressed internal public key, what getPublicKey returns. */
  publicKey: string;
  /** x-only output key. */
  output: string;
  /** Tweaked key path secret (even Y). */
  secret: Uint8Array;
  /** Untweaked secret matching publicKey (ECDSA message signing). */
  internalSecret: Uint8Array;
};

/** Chain names a dApp sees. */
export type ChainInfo = { enum: string; name: string; network: "livenet" };
export function chainInfo(net: NetworkId): ChainInfo {
  return net === "bitcoin"
    ? { enum: "BITCOIN_MAINNET", name: "Bitcoin Mainnet", network: "livenet" }
    : { enum: "FRACTAL_BITCOIN_MAINNET", name: "Fractal Bitcoin Mainnet", network: "livenet" };
}
export function chainFromEnum(e: unknown): NetworkId | null {
  if (e === "BITCOIN_MAINNET") return "bitcoin";
  if (e === "FRACTAL_BITCOIN_MAINNET") return "fractal";
  return null;
}

// ---------- PSBT review ----------

export type Owner = "site" | "private" | "other-site" | "unknown";
export type ReviewInput = {
  index: number;
  txid: string;
  vout: number;
  value: string | null;
  address?: string;
  owner: Owner;
  sign: boolean;
  sighash: number;
  /** Script path spend: the leaf (hex), its version and which of this site's keys it names. */
  script?: { leaf: string; version: number; key: "internal" | "output" };
};
export type ReviewOutput = { index: number; value: string; address?: string; memo?: string; owner: Owner; /** False when a signed input does not commit to this output. */ locked: boolean };
export type PsbtReview = {
  inputs: ReviewInput[];
  outputs: ReviewOutput[];
  toSign: number[];
  /** Sum of this site's inputs being signed. */
  spent: string;
  /** Outputs back to this site's account. */
  returned: string;
  /** Outputs that go anywhere else. */
  leaves: string;
  /** Network fee, when every input amount is known. */
  fee: string | null;
  warnings: string[];
  /** Set when PrivateBit will not sign this. */
  refuse?: string;
};

export type ToSignInput = {
  index: number;
  address?: string;
  publicKey?: string;
  sighashTypes?: number[];
  disableTweakSigner?: boolean;
  useTweakedSigner?: boolean;
};
export type SignPsbtOptions = { autoFinalized?: boolean; toSignInputs?: ToSignInput[] };

/**
 * DEFAULT and ALL commit to every output. ALL|ANYONECANPAY commits to every output and lets
 * the buyer add inputs. SINGLE and SINGLE|ANYONECANPAY are the listing signatures: only the
 * output at the same index stays locked, and the review says so. NONE locks nothing, so it
 * is refused. A SINGLE signature with no output at that index is the one-hash, valid on any
 * later transaction, so that one is refused too.
 */
const SIGHASH_OK = new Set([0x00, 0x01, 0x03, 0x81, 0x83]);
const MAX_SITE_LOOKUPS = 16;
const SIGHASH_NAMES: Record<number, string> = {
  0x00: "DEFAULT",
  0x01: "ALL",
  0x02: "NONE",
  0x03: "SINGLE",
  0x81: "ALL|ANYONECANPAY",
  0x82: "NONE|ANYONECANPAY",
  0x83: "SINGLE|ANYONECANPAY",
};
export function sighashName(t: number): string {
  return SIGHASH_NAMES[t] ?? `0x${t.toString(16)}`;
}

/** useTweakedSigner wins over disableTweakSigner, matching the provider sites already call. */
function signerFor(t: ToSignInput | undefined, leafKey: "internal" | "output" | undefined): "tweaked" | "internal" {
  if (typeof t?.useTweakedSigner === "boolean") return t.useTweakedSigner ? "tweaked" : "internal";
  if (typeof t?.disableTweakSigner === "boolean") return t.disableTweakSigner ? "internal" : "tweaked";
  return leafKey === "internal" ? "internal" : "tweaked";
}

function partialSighash(sighash: number): boolean {
  const base = sighash & 0x1f;
  return base === 2 || base === 3 || (sighash & 0x80) !== 0;
}

export function psbtBytes(input: string): Uint8Array {
  const s = input.trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return fromHex(s);
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    throw new Error("PSBT must be hex or base64");
  }
}

export function parsePsbt(input: string): btc.Transaction {
  try {
    return btc.Transaction.fromPSBT(psbtBytes(input), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  } catch (e) {
    throw new Error(`not a valid PSBT (${e instanceof Error ? e.message : String(e)})`);
  }
}

export function addressOf(script: Uint8Array | string): string | undefined {
  try {
    const s = typeof script === "string" ? fromHex(script) : script;
    return btc.Address(NETWORK).encode(btc.OutScript.decode(s));
  } catch {
    return undefined;
  }
}

/** Text of an OP_RETURN output, or its hex. */
export function memoOf(script: Uint8Array): string | undefined {
  if (script[0] !== 0x6a) return undefined;
  const data: Uint8Array[] = [];
  let i = 1;
  while (i < script.length) {
    const op = script[i++]!;
    let n = 0;
    if (op >= 1 && op <= 75) n = op;
    else if (op === 0x4c) n = script[i++] ?? 0;
    else if (op === 0x4d) {
      n = (script[i] ?? 0) | ((script[i + 1] ?? 0) << 8);
      i += 2;
    } else continue;
    data.push(script.slice(i, i + n));
    i += n;
  }
  const joined = concatBytes(...data);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(joined);
  return /^[\x20-\x7e]*$/.test(text) ? text : hex(joined);
}

export type OwnerOf = (scriptHex: string, outpoint: string) => Owner;

function tapBranch(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [x, y] = hex(a) < hex(b) ? [a, b] : [b, a];
  return schnorr.utils.taggedHash("TapBranch", x, y);
}

/**
 * A script path leaf in this input that names one of this site's keys, after checking that the
 * leaf really is committed in the coin being spent (control block and merkle path rebuild the
 * output key). Returns undefined when there is none, or a reason when the input lies about it.
 */
export function siteLeafOf(
  inp: ReturnType<btc.Transaction["getInput"]>,
  key: Pick<SiteKey, "publicKey" | "output">,
): { leaf: Uint8Array; version: number; leafHash: Uint8Array; key: "internal" | "output" } | { bad: string } | undefined {
  const prev = inp.witnessUtxo;
  if (!inp.tapLeafScript?.length || !prev) return undefined;
  const internalX = key.publicKey.length === 66 ? key.publicKey.slice(2) : key.publicKey;
  for (const [cb, scriptVer] of inp.tapLeafScript) {
    const leaf = scriptVer.subarray(0, -1);
    const version = scriptVer[scriptVer.length - 1]!;
    let pushes: string[];
    try {
      pushes = btc.Script.decode(leaf).filter((x): x is Uint8Array => x instanceof Uint8Array).map((x) => hex(x));
    } catch {
      continue;
    }
    const which = pushes.includes(internalX) ? "internal" : pushes.includes(key.output) ? "output" : undefined;
    if (!which) continue;
    if ((cb.version & 0xfe) !== version) return { bad: "the script's leaf version does not match its control block" };
    const leafHash = tapLeafHash(leaf, version);
    let root = leafHash;
    for (const step of cb.merklePath) root = tapBranch(root, step);
    let outKey: Uint8Array;
    try {
      outKey = btc.utils.taprootTweakPubkey(cb.internalKey, root)[0];
    } catch {
      return { bad: "the script's control block is not valid" };
    }
    if (prev.script.length !== 34 || prev.script[0] !== 0x51 || prev.script[1] !== 0x20 || hex(prev.script.subarray(2)) !== hex(outKey)) {
      return { bad: "the script is not part of the coin it claims to spend" };
    }
    return { leaf, version, leafHash, key: which };
  }
  return undefined;
}

/**
 * What a PSBT does, from this site's point of view. Never throws on content the user should
 * see: problems become warnings, or refuse when PrivateBit will not sign.
 */
export function reviewPsbt(tx: btc.Transaction, key: Pick<SiteKey, "scriptPubKey" | "address" | "publicKey" | "output">, ownerOf: OwnerOf, opts: SignPsbtOptions = {}): PsbtReview {
  const warnings: string[] = [];
  let refuse: string | undefined;
  const inputs: ReviewInput[] = [];
  const wanted = new Map<number, ToSignInput>();
  if (opts.toSignInputs) {
    for (const t of opts.toSignInputs) {
      if (!Number.isInteger(t.index) || t.index < 0 || t.index >= tx.inputsLength) {
        refuse ??= `input ${t.index} does not exist in this transaction`;
        continue;
      }
      const pk = t.publicKey?.toLowerCase();
      const keyOk = t.address ? t.address === key.address : pk ? pk === key.publicKey || pk === key.publicKey.slice(2) || pk === key.output : true;
      if (!keyOk) refuse ??= `input ${t.index} asks for a key that is not this site's account`;
      wanted.set(t.index, t);
    }
  }
  let inSum = 0n;
  let allKnown = true;
  let spent = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const txid = inp.txid ? hex(inp.txid) : "";
    const vout = inp.index ?? 0;
    const prev = inp.witnessUtxo;
    const scriptHex = prev ? hex(prev.script) : "";
    let owner: Owner = scriptHex === key.scriptPubKey ? "site" : ownerOf(scriptHex, `${txid}:${vout}`);
    if (scriptHex && scriptHex === key.scriptPubKey) owner = "site";
    const t = wanted.get(i);
    const sign = opts.toSignInputs ? !!t : owner === "site";
    const sighash = t?.sighashTypes?.[0] ?? inp.sighashType ?? 0;
    if (prev) inSum += prev.amount;
    else allKnown = false;
    // A leaf is accepted only when it is committed in the coin. The flag then picks which key signs it.
    const leaf = sign && inp.tapLeafScript?.length ? siteLeafOf(inp, key) : undefined;
    if (leaf && "bad" in leaf) refuse ??= `Input ${i}: ${leaf.bad}.`;
    const leafOk = leaf && !("bad" in leaf) ? leaf : undefined;
    const choice = signerFor(t, leafOk?.key);
    const scriptAgrees = !!leafOk && ((choice === "internal" && leafOk.key === "internal") || (choice === "tweaked" && leafOk.key === "output"));
    const script = scriptAgrees && leafOk ? { leaf: hex(leafOk.leaf), version: leafOk.version, key: leafOk.key } : undefined;
    inputs.push({ index: i, txid, vout, value: prev ? prev.amount.toString() : null, address: prev ? addressOf(prev.script) : undefined, owner, sign, sighash, ...(script ? { script } : {}) });
    if (owner === "private") refuse ??= "This includes coins from your private balance. PrivateBit never signs those for a website.";
    if (owner === "other-site") refuse ??= "This includes coins from another website's account.";
    if (sign) {
      if (!prev) refuse ??= `input ${i} has no amount or script, so it cannot be checked`;
      else if (leafOk && !script) refuse ??= choice === "internal" ? `Input ${i} asks for the untweaked key, but the script checks the tweaked key.` : `Input ${i} asks for the tweaked key, but the script checks the untweaked key.`;
      else if (choice === "internal" && !script) refuse ??= `Input ${i} asks for the untweaked key, and this coin has no script that checks it. A key-path spend needs the tweaked key.`;
      else if (!script && owner !== "site") refuse ??= `input ${i} is not paid to this site's account`;
      if (script) warnings.push(`Input ${i} is a script spend that names this site's key. Your signature lets that script move ${prev ? prev.amount.toString() : "its"} sats to the outputs shown.`);
      if (!SIGHASH_OK.has(sighash)) {
        const base = sighash & 0x1f;
        refuse ??= base === 2
          ? `Input ${i} uses ${sighashName(sighash)}. That signature locks no output, so the coin could be sent anywhere after you sign. PrivateBit does not sign it.`
          : `Input ${i} asks for signature type ${sighashName(sighash)}. PrivateBit does not sign that type.`;
      } else if ((sighash & 0x1f) === 3 && i >= tx.outputsLength) refuse ??= `Input ${i} uses SINGLE, but there is no output at that position. That signature would fit any transaction, so PrivateBit does not sign it.`;
      else if (sighash === 0x81) warnings.push(`Input ${i} uses signature type ALL|ANYONECANPAY. Others can add their own inputs after you sign. The outputs stay exactly as shown.`);
      else if (sighash === 0x83) warnings.push(`Input ${i} uses SINGLE|ANYONECANPAY. Only output ${i} stays as shown. The site can change every other output, and the buyer can add inputs.`);
      else if (sighash === 0x03) warnings.push(`Input ${i} uses SINGLE. Only output ${i} stays as shown. The site can change every other output.`);
      if (prev) spent += prev.amount;
    } else if (owner === "unknown") {
      warnings.push(`Input ${i} is not yours. You are not signing it.`);
    }
  }
  const toSign = inputs.filter((x) => x.sign).map((x) => x.index);
  if (!toSign.length) refuse ??= "Nothing in this request is paid from this site's account.";
  // Taproot signatures commit to every input amount unless ANYONECANPAY.
  if (!allKnown && inputs.some((x) => x.sign && (x.sighash & 0x80) === 0)) refuse ??= "Some inputs have no amount, so the signature cannot be made safely.";
  const outputs: ReviewOutput[] = [];
  let outSum = 0n;
  let returned = 0n;
  let leaves = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    const script = o.script ?? new Uint8Array();
    const value = o.amount ?? 0n;
    outSum += value;
    const sh = hex(script);
    const owner: Owner = sh === key.scriptPubKey ? "site" : ownerOf(sh, "");
    if (owner === "site") returned += value;
    else leaves += value;
    outputs.push({ index: i, value: value.toString(), address: addressOf(script), memo: memoOf(script), owner, locked: true });
  }
  const fee = allKnown ? inSum - outSum : null;
  const signed = inputs.filter((x) => x.sign);
  const partial = signed.some((x) => partialSighash(x.sighash));
  if (fee !== null && fee < 0n) {
    if (partial) warnings.push("The inputs shown do not cover the outputs. The buyer adds coins after you sign, so this is not the final fee.");
    else refuse ??= "Outputs are larger than inputs.";
  }
  const commitsAll = signed.some((x) => {
    const base = x.sighash & 0x1f;
    return base === 0 || base === 1;
  });
  const singleAt = new Set(signed.filter((x) => (x.sighash & 0x1f) === 3).map((x) => x.index));
  for (const o of outputs) o.locked = commitsAll || singleAt.has(o.index);
  return { inputs, outputs, toSign, spent: spent.toString(), returned: returned.toString(), leaves: leaves.toString(), fee: fee === null ? null : fee.toString(), warnings, ...(refuse ? { refuse } : {}) };
}

/** Sign the reviewed inputs with the site key (key path). Returns hex. Throws if the review refused. */
export function signReviewedPsbt(tx: btc.Transaction, review: PsbtReview, key: Pick<SiteKey, "secret"> & Partial<Pick<SiteKey, "internalSecret">>, autoFinalized = true): string {
  if (review.refuse) throw new Error(review.refuse);
  const prevScripts: Uint8Array[] = [];
  const amounts: bigint[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const w = tx.getInput(i).witnessUtxo;
    prevScripts.push(w?.script ?? new Uint8Array());
    amounts.push(w?.amount ?? 0n);
  }
  for (const i of review.toSign) {
    const r = review.inputs[i]!;
    const sighash = r.sighash;
    const withType = (sig: Uint8Array) => (sighash === 0 ? sig : concatBytes(sig, new Uint8Array([sighash])));
    if (r.script) {
      // Script path (BIP342): sign the reviewed leaf with the key it names.
      const leaf = fromHex(r.script.leaf);
      const secret = r.script.key === "internal" ? key.internalSecret : key.secret;
      if (!secret) throw new Error("no key for this script");
      const pre = tx.preimageWitnessV1(i, prevScripts, sighash, amounts, -1, leaf, r.script.version);
      const sig = schnorr.sign(pre, secret);
      tx.updateInput(i, { tapScriptSig: [[{ pubKey: schnorr.getPublicKey(secret), leafHash: tapLeafHash(leaf, r.script.version) }, withType(sig)]] }, true);
      if (autoFinalized) {
        try {
          tx.finalizeIdx(i);
        } catch {
          throw new Error(`PrivateBit signed input ${i}, but its script needs more than this signature to finish. Ask the site to send it with autoFinalized set to false.`);
        }
      }
      continue;
    }
    const pre = tx.preimageWitnessV1(i, prevScripts, sighash, amounts);
    const sig = schnorr.sign(pre, key.secret);
    tx.updateInput(i, { tapKeySig: withType(sig) }, true);
    if (autoFinalized) tx.finalizeIdx(i);
  }
  return hex(tx.toPSBT());
}

/**
 * The first input that spends this site's account. Coins the scan has already seen match
 * immediately. Coins the scan has not seen yet are checked from the previous transaction,
 * up to a small cap so a site cannot make the wallet fetch an arbitrary list.
 */
export async function siteSpendIn(
  tx: btc.Transaction,
  scriptPubKey: string,
  known: ReadonlySet<string>,
  lookup: (txid: string, vout: number) => Promise<{ script: string; value: bigint } | undefined>,
): Promise<{ txid: string; vout: number; value: bigint } | undefined> {
  const unknown: { txid: string; vout: number }[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    if (!inp.txid) continue;
    const txid = hex(inp.txid);
    const vout = inp.index ?? 0;
    if (known.has(`${txid}:${vout}`)) return { txid, vout, value: inp.witnessUtxo?.amount ?? 0n };
    unknown.push({ txid, vout });
  }
  for (const u of unknown.slice(0, MAX_SITE_LOOKUPS)) {
    let found: { script: string; value: bigint } | undefined;
    try {
      found = await lookup(u.txid, u.vout);
    } catch {
      found = undefined;
    }
    if (found?.script === scriptPubKey) return { txid: u.txid, vout: u.vout, value: found.value };
  }
  return undefined;
}

// ---------- Sends from a site account ----------

export type SiteSendPlan = { txHex: string; txid: string; fee: string; change: string; amount: string; inputs: string[]; vbytes: number };

/**
 * Pay from a site account only. Change goes back to the same site account, never to the private
 * coins, so the site account and the private balance stay apart.
 */
export function buildSiteSend(args: { coins: LabeledUtxo[]; key: SiteKey; to: string; amount: bigint; feeRate: number; memos?: string[] }): SiteSendPlan {
  const { key, amount, feeRate } = args;
  if (amount < DUST) throw new Error("amount is below the dust limit");
  if (!(feeRate > 0) || feeRate > 5000) throw new Error("bad fee rate");
  let toScript: Uint8Array;
  try {
    toScript = btc.OutScript.encode(btc.Address(NETWORK).decode(args.to));
  } catch {
    throw new Error("not a valid address");
  }
  const memos = (args.memos ?? []).filter((m) => m.length);
  const memoScripts = memos.map((m) => {
    const b = te.encode(m);
    if (b.length > 80) throw new Error("memo is longer than 80 bytes");
    return btc.Script.encode(["RETURN", b]);
  });
  const coins = args.coins.filter((u) => !u.spent && u.scriptPubKey === key.scriptPubKey).sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const memoVb = memoScripts.reduce((a, s) => a + 9 + s.length, 0);
  const picked: LabeledUtxo[] = [];
  let sum = 0n;
  let fee = 0n;
  let change = 0n;
  for (const c of coins) {
    picked.push(c);
    sum += BigInt(c.value);
    const feeWith = BigInt(Math.ceil((estimateVbytes(picked.length, 2) + memoVb) * feeRate));
    const feeNo = BigInt(Math.ceil((estimateVbytes(picked.length, 1) + memoVb) * feeRate));
    if (sum >= amount + feeWith + DUST) {
      fee = feeWith;
      change = sum - amount - feeWith;
      break;
    }
    if (sum >= amount + feeNo) {
      fee = sum - amount;
      change = 0n;
      break;
    }
    fee = -1n;
  }
  if (!picked.length || fee < 0n || sum < amount + fee) throw new Error("not enough in this site's account");
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  const script = fromHex(key.scriptPubKey);
  for (const c of picked) tx.addInput({ txid: c.txid, index: c.vout, witnessUtxo: { script, amount: BigInt(c.value) }, sequence: 0xfffffffd });
  tx.addOutput({ script: toScript, amount });
  for (const s of memoScripts) tx.addOutput({ script: s, amount: 0n });
  if (change > 0n) tx.addOutput({ script, amount: change });
  const scripts = picked.map(() => script);
  const amounts = picked.map((c) => BigInt(c.value));
  for (let i = 0; i < picked.length; i++) {
    const pre = tx.preimageWitnessV1(i, scripts, btc.SigHash.DEFAULT, amounts);
    tx.updateInput(i, { finalScriptWitness: [schnorr.sign(pre, key.secret)] });
  }
  return {
    txHex: hex(tx.extract()),
    txid: tx.id,
    fee: fee.toString(),
    change: change.toString(),
    amount: amount.toString(),
    inputs: picked.map((c) => `${c.txid}:${c.vout}`),
    vbytes: tx.vsize,
  };
}

// ---------- Messages ----------

function varint(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, n >> 8]);
  return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
}
const sha256d = (b: Uint8Array): Uint8Array => sha256(sha256(b));

/** Legacy "Bitcoin Signed Message" ECDSA signature, base64, compressed key header. */
export function signMessageEcdsa(message: string, internalSecret: Uint8Array): string {
  const m = te.encode(message);
  const prefix = te.encode("\x18Bitcoin Signed Message:\n");
  const h = sha256d(concatBytes(prefix, varint(m.length), m));
  const sig = secp256k1.sign(h, internalSecret, { lowS: true });
  const out = new Uint8Array(65);
  out[0] = 27 + sig.recovery + 4;
  out.set(sig.toCompactRawBytes(), 1);
  return btoa(String.fromCharCode(...out));
}

export function ecdsaMessageHash(message: string): Uint8Array {
  const m = te.encode(message);
  return sha256d(concatBytes(te.encode("\x18Bitcoin Signed Message:\n"), varint(m.length), m));
}

function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(te.encode(tag));
  return sha256(concatBytes(t, t, msg));
}
export function bip322MessageHash(message: string): Uint8Array {
  return taggedHash("BIP0322-signed-message", te.encode(message));
}

/** BIP322 to_spend txid (display order hex) for a message and script. */
export function bip322ToSpendTxid(message: string, scriptHex: string): string {
  const script = fromHex(scriptHex);
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), bip322MessageHash(message));
  const raw = concatBytes(
    new Uint8Array([0, 0, 0, 0]), // version 0
    new Uint8Array([1]),
    new Uint8Array(32),
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    varint(scriptSig.length),
    scriptSig,
    new Uint8Array([0, 0, 0, 0]), // sequence 0
    new Uint8Array([1]),
    new Uint8Array(8), // value 0
    varint(script.length),
    script,
    new Uint8Array([0, 0, 0, 0]), // locktime 0
  );
  return hex(sha256d(raw).reverse());
}

/** The BIP341 digest a BIP322 simple P2TR signature commits to. */
export function bip322Sighash(message: string, scriptHex: string): Uint8Array {
  const script = fromHex(scriptHex);
  const tx = new btc.Transaction({ version: 0, allowUnknownOutputs: true, disableScriptCheck: true, allowUnknownInputs: true });
  tx.addInput({ txid: bip322ToSpendTxid(message, scriptHex), index: 0, sequence: 0, witnessUtxo: { script, amount: 0n } });
  tx.addOutput({ script: new Uint8Array([0x6a]), amount: 0n });
  return tx.preimageWitnessV1(0, [script], btc.SigHash.DEFAULT, [0n]);
}

/** BIP322 "simple" signature for a P2TR key path account, base64 of the witness stack. */
export function signMessageBip322(message: string, key: Pick<SiteKey, "scriptPubKey" | "secret">): string {
  const sig = schnorr.sign(bip322Sighash(message, key.scriptPubKey), key.secret);
  const w = concatBytes(new Uint8Array([1, 64]), sig);
  return btoa(String.fromCharCode(...w));
}

