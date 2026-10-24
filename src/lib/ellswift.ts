/**
 * BIP324 / libsecp256k1 ElligatorSwift, full (x, y) as used by BIP77 HPKE.
 * Decode and encode follow bitcoin-core/secp256k1 doc/ellswift.md §4.1
 * (sign(t) carries Y). Do not invent a mapping.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { randomBytes } from "./bytes.ts";

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const B = 7n;

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function mul(a: bigint, b: bigint): bigint {
  return mod(a * b);
}

function add(a: bigint, b: bigint): bigint {
  return mod(a + b);
}

function sub(a: bigint, b: bigint): bigint {
  return mod(a - b);
}

function powMod(b: bigint, e: bigint): bigint {
  let r = 1n;
  let x = mod(b);
  let n = e;
  while (n > 0n) {
    if (n & 1n) r = mul(r, x);
    x = mul(x, x);
    n >>= 1n;
  }
  return r;
}

function inv(a: bigint): bigint {
  const x = mod(a);
  if (x === 0n) throw new Error("ellswift invert 0");
  return powMod(x, P - 2n);
}

function sqrt(a: bigint): bigint | null {
  const v = mod(a);
  if (v === 0n) return 0n;
  const s = powMod(v, (P + 1n) / 4n);
  return mul(s, s) === v ? s : null;
}

function isSquare(a: bigint): boolean {
  return sqrt(a) !== null;
}

function g(x: bigint): bigint {
  return add(mul(mul(x, x), x), B);
}

/** √(-3) mod p. Same constant BIP324 reference.py uses. */
const MINUS_3_SQRT = sqrt(mod(-3n))!;

function signFe(x: bigint): boolean {
  return (mod(x) & 1n) === 1n;
}

function feFromBytes(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return mod(n);
}

function feToBytes(x: bigint): Uint8Array {
  const o = new Uint8Array(32);
  let n = mod(x);
  for (let i = 31; i >= 0; i--) {
    o[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return o;
}

/**
 * xswiftec (BIP324) then Y from sign(t): secp256k1_ellswift_swiftec_var.
 */
export function ellswiftDecodeUncompressed(ell: Uint8Array): Uint8Array {
  if (ell.length !== 64) throw new Error("ellswift is 64 bytes");
  let u = feFromBytes(ell.subarray(0, 32));
  const tOrig = feFromBytes(ell.subarray(32, 64));
  let t = tOrig;
  if (u === 0n) u = 1n;
  if (t === 0n) t = 1n;
  if (add(g(u), mul(t, t)) === 0n) t = mul(2n, t);
  const X = mul(sub(g(u), mul(t, t)), inv(mul(2n, t)));
  const Y = mul(add(X, t), inv(mul(MINUS_3_SQRT, u)));
  const candidates = [
    add(u, mul(4n, mul(Y, Y))),
    sub(mul(sub(0n, X), inv(mul(2n, Y))), mul(u, inv(2n))),
    sub(mul(X, inv(mul(2n, Y))), mul(u, inv(2n))),
  ];
  let x: bigint | undefined;
  for (const c of candidates) {
    if (isSquare(g(c))) {
      x = c;
      break;
    }
  }
  if (x === undefined) throw new Error("ellswift decode: no curve x");
  let y = sqrt(g(x));
  if (y === null) throw new Error("ellswift decode: no y");
  if (signFe(y) !== signFe(tOrig)) y = sub(0n, y);
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(feToBytes(x), 1);
  out.set(feToBytes(y), 33);
  secp256k1.ProjectivePoint.fromHex(out);
  return out;
}

/** G_{c,u}(x) from ellswift.md §3.5 (x-only inverse). */
function xswiftecInv(x: bigint, u: bigint, c: number): bigint | null {
  if (u === 0n) return null;
  let s: bigint;
  let v: bigint;
  if ((c & 2) === 0) {
    if (isSquare(g(sub(0n, add(u, x))))) return null;
    s = mul(sub(0n, g(u)), inv(add(add(mul(u, u), mul(u, x)), mul(x, x))));
    v = x;
  } else {
    s = sub(x, u);
    if (s === 0n) return null;
    const r2 = mul(sub(0n, s), add(mul(4n, g(u)), mul(mul(3n, s), mul(u, u))));
    const r = sqrt(r2);
    if (r === null) return null;
    if ((c & 1) !== 0 && r === 0n) return null;
    v = mul(sub(mul(r, inv(s)), u), inv(2n));
  }
  const w = sqrt(s);
  if (w === null) return null;
  const half = inv(2n);
  const c5 = c & 5;
  if (c5 === 0) return mul(sub(0n, w), add(mul(u, mul(sub(1n, MINUS_3_SQRT), half)), v));
  if (c5 === 1) return mul(w, add(mul(u, mul(add(1n, MINUS_3_SQRT), half)), v));
  if (c5 === 4) return mul(w, add(mul(u, mul(sub(1n, MINUS_3_SQRT), half)), v));
  return mul(sub(0n, w), add(mul(u, mul(add(1n, MINUS_3_SQRT), half)), v));
}

/**
 * Encode uncompressed secp256k1 pubkey as 64-byte ellswift.
 * x-only inverse, then negate t so sign(t) = sign(y) (ellswift.md §4.1).
 */
export function ellswiftEncodeUncompressed(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error("ellswift encode expects uncompressed 65-byte pubkey");
  }
  secp256k1.ProjectivePoint.fromHex(uncompressed);
  const x = feFromBytes(uncompressed.subarray(1, 33));
  const y = feFromBytes(uncompressed.subarray(33, 65));
  for (let i = 0; i < 10_000; i++) {
    const u = feFromBytes(randomBytes(32));
    if (u === 0n) continue;
    const c = randomBytes(1)[0]! & 7;
    let t = xswiftecInv(x, u, c);
    if (t === null || t === 0n) continue;
    if (signFe(t) !== signFe(y)) t = sub(0n, t);
    if (t === 0n) continue;
    const out = new Uint8Array(64);
    out.set(feToBytes(u), 0);
    out.set(feToBytes(t), 32);
    const round = ellswiftDecodeUncompressed(out);
    if (round[0] === 0x04 && uncompressed.every((b, j) => round[j] === b)) return out;
  }
  throw new Error("ellswift encode failed");
}

export function uncompressedFromCompressed(compressed: Uint8Array): Uint8Array {
  if (compressed.length !== 33) throw new Error("compressed pubkey is 33 bytes");
  return secp256k1.ProjectivePoint.fromHex(compressed).toRawBytes(false);
}

export function compressedFromUncompressed(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.length !== 65) throw new Error("uncompressed pubkey is 65 bytes");
  return secp256k1.ProjectivePoint.fromHex(uncompressed).toRawBytes(true);
}
