/**
 * BIP77 end-to-end HPKE. Wire layout and info strings from the BIP and
 * payjoin/rust-payjoin `core/hpke.rs`. Padding is zeros, 7168-byte messages.
 */
import { concatBytes } from "./bytes.ts";
import { compressedFromUncompressed, ellswiftDecodeUncompressed, ellswiftEncodeUncompressed, uncompressedFromCompressed } from "./ellswift.ts";
import {
  genKeyPair,
  NT,
  open,
  seal,
  setupReceiverAuth,
  setupReceiverBase,
  setupSenderAuth,
  setupSenderBase,
  skToCompressed,
  skToUncompressed,
} from "./hpke.ts";

export const PADDED_MESSAGE_BYTES = 7168;
export const ELLSWIFT_SIZE = 64;
export const COMPRESSED_SIZE = 33;
export const PADDED_PLAINTEXT_A_LENGTH = PADDED_MESSAGE_BYTES - (ELLSWIFT_SIZE + COMPRESSED_SIZE + NT);
export const PADDED_PLAINTEXT_B_LENGTH = PADDED_MESSAGE_BYTES - (ELLSWIFT_SIZE + NT);
export const INFO_A = new TextEncoder().encode("PjV2MsgA");
export const INFO_B = new TextEncoder().encode("PjV2MsgB");

export type HpkeKeyPair = { sk: Uint8Array; pkUncompressed: Uint8Array; pkCompressed: Uint8Array };

export function hpkeKeyPairFromSecret(sk: Uint8Array): HpkeKeyPair {
  return { sk, pkUncompressed: skToUncompressed(sk), pkCompressed: skToCompressed(sk) };
}

export function genHpkeKeyPair(): HpkeKeyPair {
  const { sk, pk } = genKeyPair();
  return { sk, pkUncompressed: pk, pkCompressed: compressedFromUncompressed(pk) };
}

function padZeros(msg: Uint8Array, padded: number): Uint8Array {
  if (msg.length > padded) {
    throw new Error(`Payjoin HPKE plaintext ${msg.length} exceeds ${padded} bytes`);
  }
  const out = new Uint8Array(padded);
  out.set(msg);
  return out;
}

/** Message A: sender → receiver. Original PSBT (plus optional sender params). */
export function encryptMessageA(body: Uint8Array, replyPkCompressed: Uint8Array, receiverPkCompressed: Uint8Array): Uint8Array {
  const receiverPk = uncompressedFromCompressed(receiverPkCompressed);
  const { enc, ctx } = setupSenderBase(receiverPk, INFO_A);
  const padded = padZeros(body, PADDED_PLAINTEXT_A_LENGTH);
  const plaintext = concatBytes(replyPkCompressed, padded);
  const ct = seal(ctx, plaintext);
  const out = concatBytes(ellswiftEncodeUncompressed(enc), ct);
  if (out.length !== PADDED_MESSAGE_BYTES) throw new Error("Message A must be 7168 bytes");
  return out;
}

export function decryptMessageA(messageA: Uint8Array, receiverSk: Uint8Array): { body: Uint8Array; replyPkCompressed: Uint8Array } {
  if (messageA.length < ELLSWIFT_SIZE + NT + COMPRESSED_SIZE) throw new Error("Message A too short");
  const enc = ellswiftDecodeUncompressed(messageA.subarray(0, ELLSWIFT_SIZE));
  const ctx = setupReceiverBase(receiverSk, enc, INFO_A);
  const pt = open(ctx, messageA.subarray(ELLSWIFT_SIZE));
  if (pt.length < COMPRESSED_SIZE) throw new Error("Message A plaintext too short");
  return { body: pt.subarray(COMPRESSED_SIZE), replyPkCompressed: pt.subarray(0, COMPRESSED_SIZE) };
}

/** Message B: receiver → sender. Auth mode with the receiver's HPKE key. */
export function encryptMessageB(body: Uint8Array, receiver: HpkeKeyPair, senderPkCompressed: Uint8Array): Uint8Array {
  const senderPk = uncompressedFromCompressed(senderPkCompressed);
  const { enc, ctx } = setupSenderAuth(senderPk, receiver.sk, INFO_B);
  const ct = seal(ctx, padZeros(body, PADDED_PLAINTEXT_B_LENGTH));
  const out = concatBytes(ellswiftEncodeUncompressed(enc), ct);
  if (out.length !== PADDED_MESSAGE_BYTES) throw new Error("Message B must be 7168 bytes");
  return out;
}

export function decryptMessageB(messageB: Uint8Array, receiverPkCompressed: Uint8Array, senderSk: Uint8Array): Uint8Array {
  if (messageB.length < ELLSWIFT_SIZE + NT) throw new Error("Message B too short");
  const enc = ellswiftDecodeUncompressed(messageB.subarray(0, ELLSWIFT_SIZE));
  const receiverPk = uncompressedFromCompressed(receiverPkCompressed);
  const ctx = setupReceiverAuth(senderSk, enc, receiverPk, INFO_B);
  return open(ctx, messageB.subarray(ELLSWIFT_SIZE));
}

export function stripHpkePadding(body: Uint8Array): string {
  let end = body.length;
  while (end > 0 && body[end - 1] === 0) end--;
  return new TextDecoder().decode(body.subarray(0, end)).split("\n")[0]?.trim() ?? "";
}
