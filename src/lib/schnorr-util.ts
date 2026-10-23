import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { CURVE_N } from "./bip352.ts";
import { concatBytes, fromHex, ser32 } from "./bytes.ts";

const n = CURVE_N;

export function scalar(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

export function ser256(x: bigint): Uint8Array {
  let v = ((x % n) + n) % n;
  const o = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    o[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return o;
}

/** BIP340: secret must produce even-Y P. Negate d if needed. */
export function evenPriv(d: Uint8Array): Uint8Array {
  const pub = secp256k1.getPublicKey(d, true);
  if (pub[0] === 0x03) return ser256(n - scalar(d));
  return d;
}

export function sessionTweak(sessionIdHex: string, index: number): Uint8Array {
  return sha256(
    concatBytes(new TextEncoder().encode("privatebit/pj-out/v1"), fromHex(sessionIdHex), ser32(index)),
  );
}

/** Q = P + t·G. Secret = even(d+t). Used for a BIP77 session P2TR (not an sp1). */
export function tweakSpend(spendSecret: Uint8Array, tweak: Uint8Array): {
  secret: Uint8Array;
  xonly: Uint8Array;
  compressed: Uint8Array;
} {
  const d = evenPriv(spendSecret);
  const secret = evenPriv(ser256(scalar(d) + scalar(tweak)));
  const compressed = secp256k1.getPublicKey(secret, true);
  return { secret, compressed, xonly: compressed.slice(1) };
}
