import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bech32m } from "@scure/base";
import {
  compareBytes,
  concatBytes,
  fromHex,
  hex,
  ser32,
  txidToOutpointBytes,
} from "./bytes.ts";
import { FRACTAL, SP_K_MAX } from "./network.ts";

const Point = secp256k1.ProjectivePoint;
const n = secp256k1.CURVE.n;

export type Outpoint = { txid: string; vout: number };

export type EligibleVin = Outpoint & {
  /** Compressed 33-byte pubkey used for shared-secret derivation. */
  pubkey: Uint8Array;
  /** True if this input is P2TR (x-only even-Y assumed on receive). */
  taproot: boolean;
  /** Sender-only: 32-byte secret. Taproot secrets must already match even Y. */
  secret?: Uint8Array;
};

export type SilentAddress = {
  hrp: string;
  version: number;
  scan: Uint8Array;
  spend: Uint8Array;
};

export type DetectedOutput = {
  xonly: Uint8Array;
  tweak: Uint8Array;
  label: number | null;
  k: number;
  vout: number;
};

function tagged(tag: string, data: Uint8Array): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, data));
}

function scalar(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

function ser256(x: bigint): Uint8Array {
  let v = x;
  const o = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    o[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return o;
}

function isValidScalar(bytes: Uint8Array): boolean {
  const x = scalar(bytes);
  return x > 0n && x < n;
}

function parsePoint(compressed33: Uint8Array) {
  return Point.fromHex(hex(compressed33));
}

function serP(p: InstanceType<typeof Point>): Uint8Array {
  return p.toRawBytes(true);
}

function xonly(p: InstanceType<typeof Point>): Uint8Array {
  return p.toRawBytes(true).slice(1);
}

function smallestOutpoint(outpoints: Outpoint[]): Uint8Array {
  const packed = outpoints.map((v) => txidToOutpointBytes(v.txid, v.vout));
  packed.sort(compareBytes);
  return packed[0];
}

export function encodeSilentAddress(
  scan: Uint8Array,
  spend: Uint8Array,
  hrp = FRACTAL.spHrp,
): string {
  if (scan.length !== 33 || spend.length !== 33) {
    throw new Error("scan and spend must be compressed pubkeys");
  }
  const payload = concatBytes(scan, spend);
  const words = [0, ...bech32m.toWords(payload)];
  return bech32m.encode(hrp, words, 1023);
}

export function decodeSilentAddress(addr: string): SilentAddress {
  const { prefix, words } = bech32m.decode(addr as `${string}1${string}`, 1023);
  if (words.length < 1) throw new Error("empty silent address");
  const version = words[0];
  if (version === 31) throw new Error("silent payment v31 is incompatible");
  const data = bech32m.fromWords(words.slice(1));
  if (version === 0 && data.length !== 66) {
    throw new Error("v0 silent address must be 66 bytes");
  }
  if (data.length < 66) throw new Error("silent address too short");
  return {
    hrp: prefix,
    version,
    scan: data.slice(0, 33),
    spend: data.slice(33, 66),
  };
}

export function labelTweak(scanSecret: Uint8Array, m: number): Uint8Array {
  return tagged("BIP0352/Label", concatBytes(scanSecret, ser32(m)));
}

export function labeledSpendPub(spend: Uint8Array, scanSecret: Uint8Array, m: number): Uint8Array {
  const t = labelTweak(scanSecret, m);
  if (!isValidScalar(t)) throw new Error("invalid label scalar");
  const Bm = parsePoint(spend).add(Point.fromPrivateKey(t));
  return serP(Bm);
}

export function inputHash(outpoints: Outpoint[], A: InstanceType<typeof Point>): Uint8Array {
  const outL = smallestOutpoint(outpoints);
  return tagged("BIP0352/Inputs", concatBytes(outL, serP(A)));
}

function negateSecretIfTaprootOdd(secret: Uint8Array, taproot: boolean): Uint8Array {
  if (!taproot) return secret;
  const pub = secp256k1.getPublicKey(secret, true);
  if (pub[0] === 0x03) {
    const d = (n - scalar(secret)) % n;
    return ser256(d);
  }
  return secret;
}

export function sumInputSecrets(vins: EligibleVin[]): Uint8Array | null {
  let acc = 0n;
  for (const v of vins) {
    if (!v.secret) throw new Error("missing input secret");
    const s = negateSecretIfTaprootOdd(v.secret, v.taproot);
    acc = (acc + scalar(s)) % n;
  }
  if (acc === 0n) return null;
  return ser256(acc);
}

export function sumInputPubs(vins: EligibleVin[]): InstanceType<typeof Point> {
  let acc: InstanceType<typeof Point> | null = null;
  for (const v of vins) {
    let p = parsePoint(v.pubkey);
    if (v.taproot && v.pubkey[0] === 0x03) {
      p = p.negate();
    }
    acc = acc ? acc.add(p) : p;
  }
  if (!acc) throw new Error("no eligible inputs");
  return acc;
}

function sharedSecretFromA(
  outpoints: Outpoint[],
  A: InstanceType<typeof Point>,
  scanMul: Uint8Array,
): Uint8Array {
  const ih = inputHash(outpoints, A);
  if (!isValidScalar(ih)) throw new Error("invalid input_hash");
  const s = (scalar(ih) * scalar(scanMul)) % n;
  const shared = A.multiply(s);
  return serP(shared);
}

export function senderSharedSecret(
  vins: EligibleVin[],
  Bscan: Uint8Array,
  outpoints: Outpoint[] = vins,
): Uint8Array {
  const a = sumInputSecrets(vins);
  if (!a) throw new Error("input secret sum is zero");
  const A = Point.fromPrivateKey(a);
  const ih = inputHash(outpoints, A);
  if (!isValidScalar(ih)) throw new Error("invalid input_hash");
  const s = (scalar(ih) * scalar(a)) % n;
  return serP(parsePoint(Bscan).multiply(s));
}

export function receiverSharedSecret(
  vins: EligibleVin[],
  bScan: Uint8Array,
  outpoints: Outpoint[] = vins,
): Uint8Array {
  const A = sumInputPubs(vins);
  return sharedSecretFromA(outpoints, A, bScan);
}

export function outputTweak(sharedCompressed: Uint8Array, k: number): Uint8Array {
  const t = tagged("BIP0352/SharedSecret", concatBytes(sharedCompressed, ser32(k)));
  if (!isValidScalar(t)) throw new Error("invalid t_k");
  return t;
}

export function silentOutputXonly(Bm: Uint8Array, tweak: Uint8Array): Uint8Array {
  const P = parsePoint(Bm).add(Point.fromPrivateKey(tweak));
  return xonly(P);
}

export type SendRecipient = {
  address: string;
  /** How many outputs to this B_m. Default 1. */
  count?: number;
};

/**
 * BIP352 sender: group by B_scan, increment k across B_m in the group.
 * Recipients should be sorted by amount by the caller (test-vector determinism).
 */
export function createSilentOutputs(
  vins: EligibleVin[],
  recipients: SendRecipient[],
  outpoints: Outpoint[] = vins,
): { xonly: Uint8Array; shared: Uint8Array; tweak: Uint8Array; k: number; scan: Uint8Array }[] {
  const decoded = recipients.map((r) => ({
    ...decodeSilentAddress(r.address),
    count: r.count ?? 1,
  }));
  const groups = new Map<string, typeof decoded>();
  for (const r of decoded) {
    const key = hex(r.scan);
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const a = sumInputSecrets(vins);
  if (!a) return [];
  for (const group of groups.values()) {
    const n = group.reduce((s, r) => s + r.count, 0);
    if (n > SP_K_MAX) return [];
  }
  const out: { xonly: Uint8Array; shared: Uint8Array; tweak: Uint8Array; k: number; scan: Uint8Array }[] = [];
  for (const group of groups.values()) {
    const Bscan = group[0].scan;
    const shared = senderSharedSecret(vins, Bscan, outpoints);
    let k = 0;
    for (const r of group) {
      for (let i = 0; i < r.count; i++) {
        if (k >= SP_K_MAX) return [];
        const t = outputTweak(shared, k);
        out.push({
          xonly: silentOutputXonly(r.spend, t),
          shared,
          tweak: t,
          k,
          scan: Bscan,
        });
        k += 1;
      }
    }
  }
  return out;
}

export type LabelBook = Map<string, number>;

export function addLabel(book: LabelBook, scanSecret: Uint8Array, m: number): void {
  const t = labelTweak(scanSecret, m);
  if (!isValidScalar(t)) return;
  const L = Point.fromPrivateKey(t);
  // Audit L6 (independent): only L. The match compares x(P_k + L) with the x-only output, which
  // already covers both parities (BIP352). A -L entry matched P_k - L, a key this wallet cannot sign
  // for, so a crafted output showed as an unspendable coin.
  book.set(hex(serP(L)), m);
}

/** Always includes change label m=0, plus each requested m. Does not fill 0..max. */
export function precomputeLabels(scanSecret: Uint8Array, labels: Iterable<number> = []): LabelBook {
  const book: LabelBook = new Map();
  addLabel(book, scanSecret, 0);
  for (const m of labels) addLabel(book, scanSecret, m);
  return book;
}

/**
 * detectOurUtxos: trial t_k against taproot x-only outputs.
 * `outputs` are 32-byte x-only keys (or 33-byte compressed).
 */
export function detectOurUtxos(args: {
  vins: EligibleVin[];
  taprootOutputs: { xonly: Uint8Array; vout: number }[];
  scanSecret: Uint8Array;
  spendPub: Uint8Array;
  labels: LabelBook;
  outpoints?: Outpoint[];
}): DetectedOutput[] {
  if (args.vins.length === 0) return [];
  let A: InstanceType<typeof Point>;
  try {
    A = sumInputPubs(args.vins);
    if (A.equals(Point.ZERO)) return [];
  } catch {
    return [];
  }
  let shared: Uint8Array;
  try {
    shared = sharedSecretFromA(args.outpoints ?? args.vins, A, args.scanSecret);
  } catch {
    return [];
  }
  const Bspend = parsePoint(args.spendPub);
  const labelPoints = [...args.labels].map(([pointHex, m]) => ({
    m,
    point: parsePoint(fromHex(pointHex)),
  }));
  const remaining = args.taprootOutputs.map((o) => {
    const xonlyKey = o.xonly.length === 33 ? o.xonly.slice(1) : o.xonly;
    return { xonly: xonlyKey, vout: o.vout, x: hex(xonlyKey) };
  });
  const found: DetectedOutput[] = [];
  let k = 0;
  while (k < SP_K_MAX && remaining.length > 0) {
    let t: Uint8Array;
    try {
      t = outputTweak(shared, k);
    } catch {
      break;
    }
    const Pk = Bspend.add(Point.fromPrivateKey(t));
    const plain = hex(xonly(Pk));
    let matched = remaining.find((o) => o.x === plain);
    let label: number | null = null;
    if (!matched && labelPoints.length > 0) {
      const labeled = labelPoints.map((L) => ({ m: L.m, x: hex(xonly(Pk.add(L.point))) }));
      for (const o of remaining) {
        const hit = labeled.find((L) => L.x === o.x);
        if (hit) {
          matched = o;
          label = hit.m;
          break;
        }
      }
    }
    if (!matched) break;
    remaining.splice(remaining.indexOf(matched), 1);
    found.push({ xonly: matched.xonly, tweak: t, label, k, vout: matched.vout });
    k += 1;
  }
  return found;
}

export function spendSecret(args: {
  spendSecret: Uint8Array;
  tweak: Uint8Array;
  label?: number | null;
  scanSecret: Uint8Array;
}): Uint8Array {
  let d = (scalar(args.spendSecret) + scalar(args.tweak)) % n;
  if (args.label !== null && args.label !== undefined) {
    d = (d + scalar(labelTweak(args.scanSecret, args.label))) % n;
  }
  if (d === 0n) throw new Error("zero spend secret");
  return ser256(d);
}

export function taprootScriptPubKey(xonly: Uint8Array): Uint8Array {
  if (xonly.length !== 32) throw new Error("x-only key must be 32 bytes");
  return concatBytes(new Uint8Array([0x51, 0x20]), xonly);
}

export function isTaprootScript(spk: Uint8Array): boolean {
  return spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20;
}

export { tagged as taggedHash, isValidScalar, parsePoint, serP, xonly, n as CURVE_N };
