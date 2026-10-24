/**
 * Fail-closed rules. Tests import these symbols; if a wallet path bypasses
 * them, the tests fail.
 */

export const INTENT_PAYJOIN = "payjoin" as const;
export const INTENT_SIMPLE_SEND = "simple-send" as const;
export type BroadcastIntent = typeof INTENT_PAYJOIN | typeof INTENT_SIMPLE_SEND;

export type PayjoinOutcome =
  | { ok: true; psbtBase64: string; intent: typeof INTENT_PAYJOIN }
  | { ok: false; reason: string; originalPsbtBase64: string };

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Address-UTXO REST is not a Silent Payment source of truth. */
export function rejectAddressUtxoAsSot(kind: string): never {
  throw new PolicyError(
    `HTTP prevout/address-UTXO (${kind}) must not be the only source of truth for Silent Payment scan`,
  );
}

export function assertParentTxHex(hex: string | null | undefined, txid: string): string {
  if (!hex || hex.length < 8) {
    throw new PolicyError(`missing parent tx hex for ${txid}; refuse to invent prevouts`);
  }
  return hex;
}

/**
 * Payjoin failure never yields a broadcastable original.
 * Simple send is a different intent, constructed only after the user says so.
 */
export function psbtForBroadcast(
  intent: BroadcastIntent,
  payjoin: PayjoinOutcome | null,
  simplePsbt: string | null,
): string {
  if (intent === INTENT_PAYJOIN) {
    if (!payjoin || !payjoin.ok) {
      const why = !payjoin ? "no Payjoin session" : payjoin.reason;
      throw new PolicyError(`Payjoin failed (${why}); original PSBT is not broadcast`);
    }
    return payjoin.psbtBase64;
  }
  if (intent !== INTENT_SIMPLE_SEND) {
    throw new PolicyError("unknown broadcast intent");
  }
  if (!simplePsbt) throw new PolicyError("simple send requires an explicit PSBT");
  if (payjoin && !payjoin.ok) {
    // allowed: user confirmed simple send AFTER seeing the Payjoin failure
  }
  return simplePsbt;
}

export function noAutoFallback(payjoin: PayjoinOutcome): asserts payjoin is Extract<PayjoinOutcome, { ok: true }> {
  if (!payjoin.ok) {
    throw new PolicyError(`no auto-fallback: ${payjoin.reason}`);
  }
}

export const BIP78_CHECKS = [
  "proposal is a PSBT",
  "receiver added at least one input",
  "receiver added at most one extra output (optional payjoin output)",
  "our inputs are unchanged",
  "pjos=0: original outputs were not removed or decreased",
  "no SIGHASH_NONE/SINGLE/ANYONECANPAY on inputs",
  "receiver inputs match our input type",
  "absolute fee must not decrease",
] as const;

/** Receiver side, checked on the original before anything is added or signed. */
export const BIP78_RECEIVER_CHECKS = [
  "original is a complete signed transaction paying a positive fee",
  "original pays this payment link at least the requested amount",
  "original spends none of our coins",
  "original inputs are all Taproot (the type we add)",
  "the reserved coin is unspent, not frozen and still ours when we sign",
  "fee share: our added vbytes at the original fee rate",
] as const;

export const BIP77_CHECKS = [
  "two parties: one sender, one receiver (Payjoin is not a waiting-room mix)",
  "mailbox GET returns 202 until original exists",
  "sender POSTs original to pj= mailbox, never broadcasts it",
  "receiver adds at least one input before posting proposal",
  "proposal passes BIP78 subset plus v2 expiry",
  "HPKE (PjV2MsgA/B, ElligatorSwift, 7168-byte pad) so the mailbox cannot read PSBTs",
  "OHTTP (RFC 9458, 8192-byte pad) so a relay, not the directory, sees the client IP",
  "RK/EX/OH in the pj= URL fragment; Payjoin does not run on a plain sp1 send or a BIP78 https pj=",
  "receiver and sender poll from the extension alarm (window may be closed; lock wipes HPKE)",
] as const;
