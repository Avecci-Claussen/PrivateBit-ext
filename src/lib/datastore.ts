import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { fromHex, hex, randomBytes } from "./bytes.ts";

/**
 * Encryption at rest for wallet data (DATA.md section 3).
 * dataKey = HKDF-SHA256(ikm = BIP39 seed, salt = "PrivateBit data v1", info = "privatebit.data").
 * Each value is AES-256-GCM with a fresh 12-byte nonce and the storage key name as
 * additional data, so a blob cannot be moved to another key. The key only exists in memory
 * while the wallet is unlocked and is never written anywhere.
 */
export type SealedBlob = { v: 1; nonce: string; ct: string };

const SALT = new TextEncoder().encode("PrivateBit data v1");
const INFO = new TextEncoder().encode("privatebit.data");

export function deriveDataKey(seed: Uint8Array): Uint8Array {
  if (seed.length < 16) throw new Error("seed too short");
  return hkdf(sha256, seed, SALT, INFO, 32);
}

const SCAN_INFO = new TextEncoder().encode("privatebit.scan");

/**
 * Second key from the same seed for what block matching must read and write after Lock:
 * the coin list and the chain settings. History, labels, frozen marks, one-time records and
 * Payjoin sessions stay under the data key, which is dropped at Lock.
 * Same HKDF construction as deriveDataKey, different info string.
 */
export function deriveScanKey(seed: Uint8Array): Uint8Array {
  if (seed.length < 16) throw new Error("seed too short");
  return hkdf(sha256, seed, SALT, SCAN_INFO, 32);
}

export function isSealed(value: unknown): value is SealedBlob {
  return (
    !!value &&
    typeof value === "object" &&
    (value as SealedBlob).v === 1 &&
    typeof (value as SealedBlob).nonce === "string" &&
    typeof (value as SealedBlob).ct === "string" &&
    Object.keys(value as object).length === 3
  );
}

export function sealJson(key: Uint8Array, name: string, value: unknown): SealedBlob {
  const nonce = randomBytes(12);
  const pt = new TextEncoder().encode(JSON.stringify(value));
  const ct = gcm(key, nonce, new TextEncoder().encode(name)).encrypt(pt);
  return { v: 1, nonce: hex(nonce), ct: hex(ct) };
}

/** Throws if the blob was written under another key name or another wallet's key. */
export function openJson<T>(key: Uint8Array, name: string, blob: SealedBlob): T {
  if (!isSealed(blob)) throw new Error(`${name}: not a sealed blob`);
  let pt: Uint8Array;
  try {
    pt = gcm(key, fromHex(blob.nonce), new TextEncoder().encode(name)).decrypt(fromHex(blob.ct));
  } catch {
    throw new Error(`${name}: cannot decrypt`);
  }
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
