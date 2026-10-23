/**
 * HPKE (RFC 9180) with DHKEM(secp256k1, HKDF-SHA256) + ChaCha20Poly1305.
 * KEM ID 0x0016 from draft-wahby-cfrg-hpke-kem-secp256k1-01.
 * SerializePublicKey = uncompressed 65-byte SEC1. DH = x-coordinate (32 bytes).
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { expand, extract } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, randomBytes } from "./bytes.ts";

export const KEM_ID = 0x0016;
export const KDF_ID = 0x0001;
export const AEAD_ID = 0x0003;
export const NSECRET = 32;
export const NENC = 65;
export const NPK = 65;
export const NSK = 32;
export const NK = 32;
export const NN = 12;
export const NH = 32;
export const NT = 16;

export const MODE_BASE = 0x00;
export const MODE_AUTH = 0x02;

const HPKE_V1 = new TextEncoder().encode("HPKE-v1");
const KEM_SUITE = concatBytes(new TextEncoder().encode("KEM"), i2osp(KEM_ID, 2));
const HPKE_SUITE = concatBytes(
  new TextEncoder().encode("HPKE"),
  i2osp(KEM_ID, 2),
  i2osp(KDF_ID, 2),
  i2osp(AEAD_ID, 2),
);

export function i2osp(n: number, len: number): Uint8Array {
  if (n < 0 || !Number.isFinite(n)) throw new Error("i2osp");
  const o = new Uint8Array(len);
  let x = n;
  for (let i = len - 1; i >= 0; i--) {
    o[i] = x & 0xff;
    x = Math.floor(x / 256);
  }
  return o;
}

function labeledExtract(suiteId: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  const labeled = concatBytes(HPKE_V1, suiteId, new TextEncoder().encode(label), ikm);
  return extract(sha256, labeled, salt);
}

function labeledExpand(
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  L: number,
): Uint8Array {
  const labeled = concatBytes(i2osp(L, 2), HPKE_V1, suiteId, new TextEncoder().encode(label), info);
  return expand(sha256, prk, labeled, L);
}

function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const eae = labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE, eae, "shared_secret", kemContext, NSECRET);
}

export function skToUncompressed(sk: Uint8Array): Uint8Array {
  if (sk.length !== NSK) throw new Error("HPKE secret is 32 bytes");
  return secp256k1.getPublicKey(sk, false);
}

export function skToCompressed(sk: Uint8Array): Uint8Array {
  if (sk.length !== NSK) throw new Error("HPKE secret is 32 bytes");
  return secp256k1.getPublicKey(sk, true);
}

/** RFC 9180 DeriveKeyPair + draft-wahby bitmask 0xff. */
export function deriveKeyPair(ikm: Uint8Array): { sk: Uint8Array; pk: Uint8Array } {
  const dkp = labeledExtract(KEM_SUITE, new Uint8Array(0), "dkp_prk", ikm);
  for (let counter = 0; counter <= 255; counter++) {
    const cand = labeledExpand(KEM_SUITE, dkp, "candidate", Uint8Array.of(counter), NSK);
    cand[0] &= 0xff;
    try {
      const pk = secp256k1.getPublicKey(cand, false);
      return { sk: cand, pk };
    } catch {
      cand.fill(0);
    }
  }
  throw new Error("DeriveKeyPair failed");
}

export function genKeyPair(): { sk: Uint8Array; pk: Uint8Array } {
  return deriveKeyPair(randomBytes(32));
}

function dhX(sk: Uint8Array, pkUncompressed: Uint8Array): Uint8Array {
  const shared = secp256k1.getSharedSecret(sk, pkUncompressed, false);
  const x = shared.subarray(1, 33);
  let z = 0;
  for (const b of x) z |= b;
  if (z === 0) throw new Error("DH all-zero");
  return x;
}

export function encap(
  pkR: Uint8Array,
  skE?: Uint8Array,
): { shared: Uint8Array; enc: Uint8Array } {
  const eph = skE ? { sk: skE, pk: skToUncompressed(skE) } : genKeyPair();
  const dh = dhX(eph.sk, pkR);
  const enc = eph.pk;
  const shared = extractAndExpand(dh, concatBytes(enc, pkR));
  return { shared, enc };
}

export function decap(enc: Uint8Array, skR: Uint8Array): Uint8Array {
  const pkR = skToUncompressed(skR);
  const dh = dhX(skR, enc);
  return extractAndExpand(dh, concatBytes(enc, pkR));
}

export function authEncap(
  pkR: Uint8Array,
  skS: Uint8Array,
  skE?: Uint8Array,
): { shared: Uint8Array; enc: Uint8Array } {
  const eph = skE ? { sk: skE, pk: skToUncompressed(skE) } : genKeyPair();
  const pkS = skToUncompressed(skS);
  const dh = concatBytes(dhX(eph.sk, pkR), dhX(skS, pkR));
  const enc = eph.pk;
  const shared = extractAndExpand(dh, concatBytes(enc, pkR, pkS));
  return { shared, enc };
}

export function authDecap(enc: Uint8Array, skR: Uint8Array, pkS: Uint8Array): Uint8Array {
  const pkR = skToUncompressed(skR);
  const dh = concatBytes(dhX(skR, enc), dhX(skR, pkS));
  return extractAndExpand(dh, concatBytes(enc, pkR, pkS));
}

function keySchedule(
  mode: number,
  shared: Uint8Array,
  info: Uint8Array,
): { key: Uint8Array; baseNonce: Uint8Array; exporterSecret: Uint8Array } {
  const psk = new Uint8Array(0);
  const pskId = new Uint8Array(0);
  const pskIdHash = labeledExtract(HPKE_SUITE, new Uint8Array(0), "psk_id_hash", pskId);
  const infoHash = labeledExtract(HPKE_SUITE, new Uint8Array(0), "info_hash", info);
  const ctx = concatBytes(Uint8Array.of(mode), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, shared, "secret", psk);
  return {
    key: labeledExpand(HPKE_SUITE, secret, "key", ctx, NK),
    baseNonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", ctx, NN),
    exporterSecret: labeledExpand(HPKE_SUITE, secret, "exp", ctx, NH),
  };
}

function nonceFor(base: Uint8Array, seq: number): Uint8Array {
  const n = base.slice();
  const s = i2osp(seq, NN);
  for (let i = 0; i < NN; i++) n[i]! ^= s[i]!;
  return n;
}

export type HpkeContext = {
  key: Uint8Array;
  baseNonce: Uint8Array;
  exporterSecret: Uint8Array;
  seq: number;
};

export function setupSenderBase(pkR: Uint8Array, info: Uint8Array, skE?: Uint8Array): { enc: Uint8Array; ctx: HpkeContext } {
  const { shared, enc } = encap(pkR, skE);
  const ks = keySchedule(MODE_BASE, shared, info);
  return { enc, ctx: { ...ks, seq: 0 } };
}

export function setupReceiverBase(skR: Uint8Array, enc: Uint8Array, info: Uint8Array): HpkeContext {
  const shared = decap(enc, skR);
  const ks = keySchedule(MODE_BASE, shared, info);
  return { ...ks, seq: 0 };
}

export function setupSenderAuth(
  pkR: Uint8Array,
  skS: Uint8Array,
  info: Uint8Array,
  skE?: Uint8Array,
): { enc: Uint8Array; ctx: HpkeContext } {
  const { shared, enc } = authEncap(pkR, skS, skE);
  const ks = keySchedule(MODE_AUTH, shared, info);
  return { enc, ctx: { ...ks, seq: 0 } };
}

export function setupReceiverAuth(skR: Uint8Array, enc: Uint8Array, pkS: Uint8Array, info: Uint8Array): HpkeContext {
  const shared = authDecap(enc, skR, pkS);
  const ks = keySchedule(MODE_AUTH, shared, info);
  return { ...ks, seq: 0 };
}

export function seal(ctx: HpkeContext, plaintext: Uint8Array, aad: Uint8Array = new Uint8Array(0)): Uint8Array {
  const nonce = nonceFor(ctx.baseNonce, ctx.seq);
  ctx.seq += 1;
  return chacha20poly1305(ctx.key, nonce, aad).encrypt(plaintext);
}

export function open(ctx: HpkeContext, ciphertext: Uint8Array, aad: Uint8Array = new Uint8Array(0)): Uint8Array {
  const nonce = nonceFor(ctx.baseNonce, ctx.seq);
  ctx.seq += 1;
  try {
    return chacha20poly1305(ctx.key, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new Error("HPKE open failed");
  }
}

/** RFC 9180 Context.Export */
export function hpkeExport(ctx: HpkeContext, exporterContext: Uint8Array, L: number): Uint8Array {
  return labeledExpand(HPKE_SUITE, ctx.exporterSecret, "sec", exporterContext, L);
}
