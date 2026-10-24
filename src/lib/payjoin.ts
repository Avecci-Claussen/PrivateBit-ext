import { encodeBip21 } from "./bip21.ts";
import type { PaymentRequest } from "./bip21.ts";
import {
  decryptMessageA,
  decryptMessageB,
  encryptMessageA,
  encryptMessageB,
  genHpkeKeyPair,
  stripHpkePadding,
  type HpkeKeyPair,
} from "./bip77-hpke.ts";
import { attachFragment, encodeFragment, mailboxIdFromRk, parseFragment, splitMailbox } from "./bip77-uri.ts";
import { hex } from "./bytes.ts";
import {
  MAILBOX_EMPTY,
  MAILBOX_OK,
  getOriginal,
  getProposal,
  isMailboxPj,
  mailboxBase,
  mailboxUrls,
  ohttpGatewayTransport,
  ohttpRelayTransport,
  pollProposal,
  postOriginal,
  postProposal,
  type MailboxTransport,
} from "./mailbox.ts";
import { DEFAULT_PAYJOIN_DIRECTORY } from "./network.ts";
import { parseOhttpKeys, type OhttpKeyConfig } from "./ohttp.ts";
import {
  BIP77_CHECKS,
  BIP78_CHECKS,
  INTENT_PAYJOIN,
  noAutoFallback,
  type PayjoinOutcome,
} from "./policy.ts";
import {
  PAYJOIN_PARTIES,
  looksLikePsbt,
  validatePayjoinProposal,
} from "./payjoin-proposal.ts";
import type { SignableInput } from "./send.ts";

export { BIP77_CHECKS, BIP78_CHECKS, PAYJOIN_PARTIES, looksLikePsbt, validatePayjoinProposal };
export { DEFAULT_PAYJOIN_DIRECTORY };

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Kept for tests that poll in-process. Production sender uses the alarm. */
export const SENDER_POLL_ATTEMPTS = 90;
export const SENDER_POLL_MS = 8_000;

export type PayjoinConfig = {
  directory?: string;
  ohttpRelay?: string;
  receiverOnline: boolean;
  transport?: MailboxTransport;
  ohttp?: OhttpKeyConfig;
};

function isNtfyHost(s: string): boolean {
  return /ntfy\.sh/i.test(s);
}

function assertHpkeMailbox(pj: string, directory?: string): void {
  const hint = `${pj} ${directory ?? ""}`;
  if (isNtfyHost(hint)) {
    throw new Error("ntfy.sh cannot carry BIP77 HPKE payloads (7168 bytes). Use payjo.in or a local directory.");
  }
}

export function ohttpFromPj(pj: string, cfg: PayjoinConfig): OhttpKeyConfig | undefined {
  const { fragment } = splitMailbox(pj);
  const oh = fragment ? parseFragment(fragment).ohttp : undefined;
  if (oh) return { keyId: oh.keyId[1] ?? oh.keyId[0] ?? 0, compressedPub: oh.compressedPub };
  return cfg.ohttp;
}

function transportOf(cfg: PayjoinConfig, pj?: string): MailboxTransport {
  assertHpkeMailbox(pj ?? "", cfg.directory);
  if (cfg.transport) return cfg.transport;
  if (!pj) throw new Error("BIP77 mailbox URL required");
  const oh = ohttpFromPj(pj, cfg);
  if (!oh) {
    throw new Error("BIP77 Payjoin needs OH in the payment link. The mailbox must not see your IP.");
  }
  if (cfg.ohttpRelay) return ohttpRelayTransport(oh, cfg.ohttpRelay);
  const directory = cfg.directory?.trim() || mailboxBase(splitMailbox(pj).url);
  return ohttpGatewayTransport(oh, directory);
}

function receiverKeyOf(request: PaymentRequest, pj: string): Uint8Array {
  if (request.receiverKey?.length === 33) return request.receiverKey;
  const { fragment } = splitMailbox(pj);
  const rk = fragment ? parseFragment(fragment).receiverKeyCompressed : undefined;
  if (!rk) {
    throw new Error(
      "BIP77 Payjoin needs RK in the payment link fragment. A plain sp1 send cannot Payjoin.",
    );
  }
  return rk;
}

export function assertPayjoinLink(request: PaymentRequest): string {
  const pj = request.pj;
  if (!pj) throw new Error("no pj= / BIP77 endpoint");
  if (!isMailboxPj(pj) && !(request.receiverKey && request.receiverKey.length === 33)) {
    throw new Error("pj= is not a BIP77 mailbox URL");
  }
  if (!isMailboxPj(pj)) throw new Error("pj= is not a BIP77 mailbox URL");
  receiverKeyOf(request, pj);
  if (!request.ohttp && !ohttpFromPj(pj, {} as PayjoinConfig)) {
    throw new Error("BIP77 Payjoin needs OH in the payment link");
  }
  return pj;
}

export type PostedOriginal = {
  ok?: undefined;
  pj: string;
  replySk: Uint8Array;
  replyPk: Uint8Array;
  rk: Uint8Array;
};

/** HPKE-encrypt Message A and POST. Caller stores replySk in session storage. */
export async function postOriginalV2(args: {
  originalPsbt: string;
  request: PaymentRequest;
  cfg: PayjoinConfig;
  reply?: HpkeKeyPair;
}): Promise<PostedOriginal | { ok: false; reason: string }> {
  const pj = args.request.pj;
  if (!pj) return { ok: false, reason: "no pj= / BIP77 endpoint" };
  if (!isMailboxPj(pj, args.cfg.directory) && !isMailboxPj(pj)) {
    return { ok: false, reason: "pj= is not a BIP77 mailbox URL" };
  }
  try {
    const rk = receiverKeyOf(args.request, pj);
    const t = transportOf(args.cfg, pj);
    const reply = args.reply ?? genHpkeKeyPair();
    const messageA = encryptMessageA(new TextEncoder().encode(args.originalPsbt), reply.pkCompressed, rk);
    const posted = await postOriginal(t, pj, messageA);
    if (posted.status !== MAILBOX_OK) {
      return { ok: false, reason: `mailbox POST original ${posted.status} ${posted.body}`.trim() };
    }
    return { pj, replySk: reply.sk, replyPk: reply.pkCompressed, rk };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "bip77 mailbox" };
  }
}

export async function takeProposalV2(args: {
  pj: string;
  originalPsbt: string;
  rk: Uint8Array;
  replySk: Uint8Array;
  cfg: PayjoinConfig;
  validate?: (proposal: string, original: string) => string[];
}): Promise<PayjoinOutcome | { empty: true }> {
  const t = transportOf(args.cfg, args.pj);
  const got = await getProposal(t, args.pj);
  if (got.status === 410) {
    return { ok: false, reason: "BIP77 session expired", originalPsbtBase64: args.originalPsbt };
  }
  if (got.status === MAILBOX_EMPTY || got.bytes.length < 64) return { empty: true };
  if (got.status !== MAILBOX_OK) {
    return {
      ok: false,
      reason: `no BIP77 proposal (mailbox ${got.status}; receiver must add an input and post)`,
      originalPsbtBase64: args.originalPsbt,
    };
  }
  try {
    const proposal = stripHpkePadding(decryptMessageB(got.bytes, args.rk, args.replySk));
    if (!looksLikePsbt(proposal)) {
      return { ok: false, reason: "proposal is not a PSBT", originalPsbtBase64: args.originalPsbt };
    }
    const violations = (args.validate ?? validatePayjoinProposal)(proposal, args.originalPsbt);
    if (violations.length) {
      return {
        ok: false,
        reason: `BIP78 checklist: ${violations.join("; ")}`,
        originalPsbtBase64: args.originalPsbt,
      };
    }
    const ok: PayjoinOutcome = { ok: true, psbtBase64: proposal, intent: INTENT_PAYJOIN };
    noAutoFallback(ok);
    return ok;
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "bip77 mailbox",
      originalPsbtBase64: args.originalPsbt,
    };
  }
}

/**
 * Test helper: post original then poll. Production uses postOriginalV2 + takeProposalV2
 * from the alarm so Confirm send does not block.
 */
export async function sendPayjoinV2(args: {
  originalPsbt: string;
  request: PaymentRequest;
  cfg: PayjoinConfig;
  validate?: (proposal: string, original: string) => string[];
  poll?: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<void> };
}): Promise<PayjoinOutcome> {
  const posted = await postOriginalV2(args);
  if ("ok" in posted && posted.ok === false) {
    return { ok: false, reason: posted.reason, originalPsbtBase64: args.originalPsbt };
  }
  const t = transportOf(args.cfg, posted.pj);
  const got = await pollProposal(t, posted.pj, {
    attempts: args.poll?.attempts ?? SENDER_POLL_ATTEMPTS,
    delayMs: args.poll?.delayMs ?? SENDER_POLL_MS,
    sleep: args.poll?.sleep,
  });
  if (got.status === 410) {
    return { ok: false, reason: "BIP77 session expired", originalPsbtBase64: args.originalPsbt };
  }
  if (got.status !== MAILBOX_OK || got.bytes.length < 64) {
    return {
      ok: false,
      reason: `no BIP77 proposal (mailbox ${got.status}; receiver must add an input and post)`,
      originalPsbtBase64: args.originalPsbt,
    };
  }
  try {
    const proposal = stripHpkePadding(decryptMessageB(got.bytes, posted.rk, posted.replySk));
    if (!looksLikePsbt(proposal)) {
      return { ok: false, reason: "proposal is not a PSBT", originalPsbtBase64: args.originalPsbt };
    }
    const violations = (args.validate ?? validatePayjoinProposal)(proposal, args.originalPsbt);
    if (violations.length) {
      return {
        ok: false,
        reason: `BIP78 checklist: ${violations.join("; ")}`,
        originalPsbtBase64: args.originalPsbt,
      };
    }
    const ok: PayjoinOutcome = { ok: true, psbtBase64: proposal, intent: INTENT_PAYJOIN };
    noAutoFallback(ok);
    return ok;
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "bip77 mailbox",
      originalPsbtBase64: args.originalPsbt,
    };
  }
}

export type PayjoinReceiveSession = {
  id: string;
  directory: string;
  pj: string;
  bip21: string;
  address: string;
  tweak: string;
  extraTweak: string;
  scriptPubKey: string;
  extraScriptPubKey: string;
  amount?: string;
  createdAt: number;
  expiresAt: number;
  status: "waiting" | "proposed" | "done" | "failed";
  error?: string;
  checkedAt?: number;
  reserved?: {
    txid: string;
    vout: number;
    value: string;
    scriptPubKey: string;
    tweak: string;
    label: number | null;
    k: number;
    height: number;
  };
  hpkePub?: string;
  replyPk?: string;
  inputSecret?: string;
  /** Set when the Payjoin output is seen in this wallet. */
  txid?: string;
  /** When the session reached a final state (done, failed, expired, cancelled). */
  closedAt?: number;
  /** After a proposal is posted: the payer must broadcast before this, or the link expires. */
  proposedAt?: number;
  proposalDeadline?: number;
  /** Final transaction id, known from our proposal (signatures do not change a segwit txid). */
  proposedTxid?: string;
};

export type PayjoinSendSession = {
  id: string;
  pj: string;
  originalPsbt: string;
  signableInputs: SignableInput[];
  destination: string;
  amount: string;
  rk: string;
  replyPk?: string;
  createdAt: number;
  expiresAt: number;
  status: "waiting" | "done" | "failed";
  error?: string;
  checkedAt?: number;
  txid?: string;
  /** When the payment reached a final state. */
  closedAt?: number;
};

export function createReceiverSession(args: {
  directory: string;
  address: string;
  scriptPubKey: string;
  tweak: string;
  extraScriptPubKey: string;
  extraTweak: string;
  amount?: bigint;
  hpke?: HpkeKeyPair;
  ohttp: OhttpKeyConfig;
}): { session: PayjoinReceiveSession; hpke: HpkeKeyPair } {
  const directory = mailboxBase(args.directory);
  if (!directory) throw new Error("BIP77 directory required");
  if (isNtfyHost(directory)) {
    throw new Error("ntfy.sh cannot carry BIP77 HPKE payloads (7168 bytes). Use payjo.in or a local directory.");
  }
  const hpke = args.hpke ?? genHpkeKeyPair();
  const id = mailboxIdFromRk(hpke.pkCompressed);
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;
  const fragment = encodeFragment({
    expiresAt,
    receiverKeyCompressed: hpke.pkCompressed,
    ohttp: {
      keyId: Uint8Array.of(0, args.ohttp.keyId & 0xff),
      compressedPub: args.ohttp.compressedPub,
    },
  });
  const { original } = mailboxUrls(directory, id);
  const pj = attachFragment(original, fragment);
  return {
    hpke,
    session: {
      id,
      directory,
      pj,
      bip21: encodeBip21({
        address: args.address,
        amount: args.amount,
        pj,
        pjos: false,
      }),
      address: args.address,
      tweak: args.tweak,
      extraTweak: args.extraTweak,
      scriptPubKey: args.scriptPubKey,
      extraScriptPubKey: args.extraScriptPubKey,
      amount: args.amount?.toString(),
      createdAt,
      expiresAt,
      status: "waiting",
      hpkePub: hex(hpke.pkCompressed),
    },
  };
}

export async function receiverTakeOriginal(
  session: PayjoinReceiveSession,
  cfg: PayjoinConfig,
  receiverSk: Uint8Array,
): Promise<{ original: string; replyPk: Uint8Array } | { empty: true } | { expired: true }> {
  if (Date.now() > session.expiresAt) return { expired: true };
  const t = transportOf(cfg, session.pj);
  const got = await getOriginal(t, session.pj);
  if (got.status === 410) return { expired: true };
  if (got.status === MAILBOX_EMPTY || got.bytes.length === 0) return { empty: true };
  if (got.status !== MAILBOX_OK) throw new Error(`mailbox original ${got.status}`);
  const opened = decryptMessageA(got.bytes, receiverSk);
  const original = stripHpkePadding(opened.body);
  if (!looksLikePsbt(original)) throw new Error("mailbox original is not a PSBT");
  return { original, replyPk: opened.replyPkCompressed };
}

export async function receiverPostProposal(
  session: PayjoinReceiveSession,
  proposalB64: string,
  cfg: PayjoinConfig,
  receiver: HpkeKeyPair,
  replyPkCompressed: Uint8Array,
): Promise<void> {
  const t = transportOf(cfg, session.pj);
  const messageB = encryptMessageB(new TextEncoder().encode(proposalB64), receiver, replyPkCompressed);
  const posted = await postProposal(t, session.pj, messageB);
  if (posted.status !== MAILBOX_OK) throw new Error(`mailbox POST proposal ${posted.status}`);
}

/** Default checklist used when we cannot fully decode a foreign proposal in tests. */
export function bip78ValidateStub(proposal: string, original: string): string[] {
  return validatePayjoinProposal(proposal, original);
}

/** GET directory /.well-known/ohttp-gateway as RFC 9540 `application/ohttp-keys`. */
export async function fetchDirectoryOhttp(directory: string): Promise<OhttpKeyConfig> {
  const res = await fetch(`${mailboxBase(directory)}/.well-known/ohttp-gateway`, {
    headers: { Accept: "application/ohttp-keys" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`OHTTP keys HTTP ${res.status}`);
  return parseOhttpKeys(new Uint8Array(await res.arrayBuffer()));
}
