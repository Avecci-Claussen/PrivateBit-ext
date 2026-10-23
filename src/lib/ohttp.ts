/**
 * RFC 9458 Oblivious HTTP using the BIP77 HPKE suite
 * (DHKEM secp256k1, HKDF-SHA256, ChaCha20Poly1305).
 * Encapsulated request/response are padded to 8192 bytes as in BIP77.
 * RFC 9458: HPKE info is `message/bhttp request || 0x00 || header`; Seal AAD is empty.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { expand, extract } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, fromHex, randomBytes } from "./bytes.ts";
import { compressedFromUncompressed, uncompressedFromCompressed } from "./ellswift.ts";
import {
  AEAD_ID,
  KDF_ID,
  KEM_ID,
  NK,
  NN,
  NPK,
  NT,
  type HpkeContext,
  genKeyPair,
  hpkeExport,
  i2osp,
  open,
  seal,
  setupReceiverBase,
  setupSenderBase,
  skToCompressed,
} from "./hpke.ts";
import { decodeRequest, decodeResponse, encodeRequest, encodeResponse, type BhttpRequest, type BhttpResponse } from "./bhttp.ts";

export const OHTTP_ENCAPSULATED_LEN = 8192;
export const OHTTP_HEADER_LEN = 7;
export const OHTTP_KEM_LEN = 65;
export const OHTTP_REQ_PLAIN_LEN = OHTTP_ENCAPSULATED_LEN - OHTTP_HEADER_LEN - OHTTP_KEM_LEN - NT;
export const OHTTP_RES_NONCE_LEN = 32;
export const OHTTP_RES_PLAIN_LEN = OHTTP_ENCAPSULATED_LEN - OHTTP_RES_NONCE_LEN - NT;

/** BIP77 Relay/Directory allowed_purposes magic (TLS ALPN list encoding). */
export const BIP77_OHTTP_PURPOSE = "BIP77 454403bb-9f7b-4385-b31f-acd2dae20b7e";

const INFO_REQ = new TextEncoder().encode("message/bhttp request");
const EXP_RES = new TextEncoder().encode("message/bhttp response");

/** RFC 9458 §4.3: info = "message/bhttp request" || 0x00 || hdr */
function requestInfo(hdr: Uint8Array): Uint8Array {
  return concatBytes(INFO_REQ, Uint8Array.of(0), hdr);
}

export type OhttpKeyConfig = {
  keyId: number;
  compressedPub: Uint8Array;
};

export type OhttpKeyPair = OhttpKeyConfig & { sk: Uint8Array };

export type OhttpSenderSession = {
  enc: Uint8Array;
  ctx: HpkeContext;
};

export function genOhttpKeyPair(keyId = 1): OhttpKeyPair {
  const { sk } = genKeyPair();
  return { keyId, sk, compressedPub: skToCompressed(sk) };
}

export function ohttpHeader(keyId: number): Uint8Array {
  return concatBytes(Uint8Array.of(keyId & 0xff), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
}

/** RFC 9458 Key Configuration for DHKEM(secp256k1) + HKDF-SHA256 + ChaCha20Poly1305. */
export function encodeOhttpKeyConfig(cfg: OhttpKeyConfig): Uint8Array {
  const pub = uncompressedFromCompressed(cfg.compressedPub);
  return concatBytes(
    Uint8Array.of(cfg.keyId & 0xff),
    i2osp(KEM_ID, 2),
    pub,
    i2osp(4, 2),
    i2osp(KDF_ID, 2),
    i2osp(AEAD_ID, 2),
  );
}

export function encodeAllowedPurposes(purposes: string[] = [BIP77_OHTTP_PURPOSE]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const p of purposes) {
    const b = new TextEncoder().encode(p);
    if (b.length > 255) throw new Error("purpose too long");
    chunks.push(Uint8Array.of(b.length), b);
  }
  const inner = concatBytes(...chunks);
  return concatBytes(i2osp(inner.length, 2), inner);
}

function npkForKem(kem: number): number | undefined {
  if (kem === KEM_ID) return NPK;
  if (kem === 0x0020) return 32;
  return undefined;
}

function parseOneKeyConfig(bytes: Uint8Array, offset: number): { cfg?: OhttpKeyConfig; next: number } | undefined {
  if (offset + 3 > bytes.length) return undefined;
  const keyId = bytes[offset]!;
  const kem = (bytes[offset + 1]! << 8) | bytes[offset + 2]!;
  const npk = npkForKem(kem);
  if (npk === undefined) return undefined;
  const pkStart = offset + 3;
  const pkEnd = pkStart + npk;
  if (pkEnd + 2 > bytes.length) return undefined;
  const algsLen = (bytes[pkEnd]! << 8) | bytes[pkEnd + 1]!;
  const algsStart = pkEnd + 2;
  const next = algsStart + algsLen;
  if (next > bytes.length || algsLen < 4 || algsLen % 4 !== 0) return undefined;
  let suiteOk = false;
  for (let i = algsStart; i + 4 <= next; i += 4) {
    const kdf = (bytes[i]! << 8) | bytes[i + 1]!;
    const aead = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (kdf === KDF_ID && aead === AEAD_ID) suiteOk = true;
  }
  if (kem !== KEM_ID || !suiteOk) return { next };
  const pk = bytes.subarray(pkStart, pkEnd);
  let compressed: Uint8Array;
  if (pk[0] === 4 && pk.length === 65) compressed = compressedFromUncompressed(pk);
  else if ((pk[0] === 2 || pk[0] === 3) && pk.length === 33) compressed = pk;
  else return { next };
  return { cfg: { keyId, compressedPub: compressed }, next };
}

/**
 * RFC 9540 GET body (`application/ohttp-keys`).
 * payjo.in sends one unprefixed Key Configuration (74 bytes for secp256k1).
 * Also accepts RFC 9458 length-prefixed lists and the legacy 33-byte compressed / 66-hex forms.
 */
export function parseOhttpKeys(bytes: Uint8Array): OhttpKeyConfig {
  const single = parseOneKeyConfig(bytes, 0);
  if (single?.cfg && single.next === bytes.length) return single.cfg;

  let i = 0;
  let listed = false;
  while (i + 2 <= bytes.length) {
    const len = (bytes[i]! << 8) | bytes[i + 1]!;
    if (len < 8 || i + 2 + len > bytes.length) break;
    listed = true;
    const parsed = parseOneKeyConfig(bytes.subarray(i + 2, i + 2 + len), 0);
    i += 2 + len;
    if (parsed?.cfg) return parsed.cfg;
  }
  if (!listed) {
    i = 0;
    while (i < bytes.length) {
      const parsed = parseOneKeyConfig(bytes, i);
      if (!parsed) break;
      if (parsed.cfg) return parsed.cfg;
      i = parsed.next;
    }
  }

  if (bytes.length === 33 && (bytes[0] === 2 || bytes[0] === 3)) {
    return { keyId: 1, compressedPub: bytes };
  }
  const text = new TextDecoder().decode(bytes).trim();
  if (/^[0-9a-fA-F]{66}$/.test(text)) return { keyId: 1, compressedPub: fromHex(text) };
  throw new Error("directory OHTTP keys are not DHKEM(secp256k1)+ChaCha20Poly1305");
}

function responseAead(enc: Uint8Array, ctx: HpkeContext, responseNonce: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const secret = hpkeExport(ctx, EXP_RES, NK);
  const salt = concatBytes(enc, responseNonce);
  const prk = extract(sha256, secret, salt);
  return {
    key: expand(sha256, prk, new TextEncoder().encode("key"), NK),
    nonce: expand(sha256, prk, new TextEncoder().encode("nonce"), NN),
  };
}

export function encapsulateRequest(req: BhttpRequest, cfg: OhttpKeyConfig): { wire: Uint8Array; session: OhttpSenderSession } {
  const pkR = uncompressedFromCompressed(cfg.compressedPub);
  const hdr = ohttpHeader(cfg.keyId);
  const { enc, ctx } = setupSenderBase(pkR, requestInfo(hdr));
  const ct = seal(ctx, encodeRequest(req, OHTTP_REQ_PLAIN_LEN));
  const wire = concatBytes(hdr, enc, ct);
  if (wire.length !== OHTTP_ENCAPSULATED_LEN) throw new Error("OHTTP request must be 8192 bytes");
  return { wire, session: { enc, ctx } };
}

export function decapsulateRequest(encap: Uint8Array, kp: OhttpKeyPair): { req: BhttpRequest; enc: Uint8Array; ctx: HpkeContext } {
  if (encap.length !== OHTTP_ENCAPSULATED_LEN) throw new Error("OHTTP request must be 8192 bytes");
  const hdr = encap.subarray(0, OHTTP_HEADER_LEN);
  if (hdr[0] !== (kp.keyId & 0xff)) throw new Error("OHTTP key id mismatch");
  const enc = encap.subarray(OHTTP_HEADER_LEN, OHTTP_HEADER_LEN + OHTTP_KEM_LEN);
  const ctx = setupReceiverBase(kp.sk, enc, requestInfo(hdr));
  const pt = open(ctx, encap.subarray(OHTTP_HEADER_LEN + OHTTP_KEM_LEN));
  return { req: decodeRequest(pt), enc, ctx };
}

export function encapsulateResponse(res: BhttpResponse, enc: Uint8Array, ctx: HpkeContext): Uint8Array {
  const responseNonce = randomBytes(OHTTP_RES_NONCE_LEN);
  const { key, nonce } = responseAead(enc, ctx, responseNonce);
  const ct = chacha20poly1305(key, nonce).encrypt(encodeResponse(res, OHTTP_RES_PLAIN_LEN));
  const out = concatBytes(responseNonce, ct);
  if (out.length !== OHTTP_ENCAPSULATED_LEN) throw new Error("OHTTP response must be 8192 bytes");
  return out;
}

export function decapsulateResponse(wire: Uint8Array, session: OhttpSenderSession): BhttpResponse {
  if (wire.length !== OHTTP_ENCAPSULATED_LEN) throw new Error("OHTTP response must be 8192 bytes");
  const responseNonce = wire.subarray(0, OHTTP_RES_NONCE_LEN);
  const { key, nonce } = responseAead(session.enc, session.ctx, responseNonce);
  const pt = chacha20poly1305(key, nonce).decrypt(wire.subarray(OHTTP_RES_NONCE_LEN));
  return decodeResponse(pt);
}

export function gatewayHandle(encap: Uint8Array, kp: OhttpKeyPair, dispatch: (req: BhttpRequest) => BhttpResponse): Uint8Array {
  const { req, enc, ctx } = decapsulateRequest(encap, kp);
  return encapsulateResponse(dispatch(req), enc, ctx);
}
