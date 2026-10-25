import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bech32 } from "@scure/base";
import type { BhttpRequest, BhttpResponse } from "./bhttp.ts";
import { hex, randomBytes } from "./bytes.ts";
import {
  BIP77_OHTTP_PURPOSE,
  encodeAllowedPurposes,
  encodeOhttpKeyConfig,
  decapsulateResponse,
  encapsulateRequest,
  gatewayHandle,
  genOhttpKeyPair,
  type OhttpKeyConfig,
  type OhttpKeyPair,
} from "./ohttp.ts";

/** BIP77 mailbox GET is empty until a payload arrives. */
export const MAILBOX_EMPTY = 202;
export const MAILBOX_OK = 200;

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

/**
 * BIP77 Short ID: SHA-256(compressed pubkey)[:8] encoded with the bech32
 * charset, uppercase, no HRP/checksum. For v2 this MUST be the HPKE RK.
 */
export function mailboxShortId(compressedPub: Uint8Array): string {
  if (compressedPub.length !== 33) throw new Error("mailbox key must be 33-byte compressed");
  const words = bech32.toWords(sha256(compressedPub).slice(0, 8));
  return words.map((w) => BECH32_CHARSET[w]!).join("").toUpperCase();
}

export function newMailboxId(): { id: string; pubHex: string } {
  const pub = secp256k1.getPublicKey(randomBytes(32), true);
  return { id: mailboxShortId(pub), pubHex: hex(pub) };
}

export type MailboxSlot = "original" | "proposal";

export type MailboxUrls = {
  id: string;
  original: string;
  proposal: string;
};

export function mailboxBase(directory: string): string {
  return directory.replace(/\/$/, "");
}

function stripFrag(raw: string): string {
  return raw.replace(/%23/gi, "#").split("#")[0]!;
}

export function mailboxUrls(pjOrDirectory: string, id?: string): MailboxUrls {
  const raw = stripFrag(pjOrDirectory.trim());
  if (id) {
    const base = `${mailboxBase(raw)}/${id}`;
    return { id, original: base, proposal: `${base}/proposal` };
  }
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const sid = last.toLowerCase() === "proposal" ? (parts[parts.length - 2] ?? last) : last;
  if (!sid) throw new Error("pj= mailbox has no short id");
  url.hash = "";
  url.pathname = `/${sid}`;
  const original = url.toString().replace(/\/$/, "");
  return { id: sid, original, proposal: `${original}/proposal` };
}

export function isMailboxPj(pj: string, directory?: string): boolean {
  try {
    mailboxUrls(pj);
  } catch {
    return false;
  }
  if (directory) {
    return stripFrag(pj).toLowerCase().startsWith(mailboxBase(directory).toLowerCase());
  }
  const path = (() => {
    try {
      return new URL(stripFrag(pj.includes("://") ? pj : `https://${pj}`)).pathname;
    } catch {
      return "";
    }
  })();
  return /\/[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8,24}$/i.test(path);
}

export type MailboxResponse = { status: number; body: string; bytes: Uint8Array };

export type MailboxBody = string | Uint8Array;

export type MailboxTransport = {
  get(url: string): Promise<MailboxResponse>;
  post(url: string, body: MailboxBody): Promise<MailboxResponse>;
  put(url: string, body: MailboxBody): Promise<MailboxResponse>;
};

export function asBytes(body: MailboxBody): Uint8Array {
  return typeof body === "string" ? utf8.encode(body) : body;
}

function toResponse(status: number, payload: Uint8Array | string): MailboxResponse {
  const bytes = typeof payload === "string" ? utf8.encode(payload) : payload;
  return { status, bytes, body: utf8d.decode(bytes) };
}

function ohttpSend(
  cfg: OhttpKeyConfig,
  inner: { method: string; url: string; body?: MailboxBody },
  postWire: (wire: Uint8Array) => Promise<Uint8Array>,
): Promise<MailboxResponse> {
  const u = new URL(inner.url.includes("://") ? inner.url : `https://${inner.url}`);
  const { wire, session } = encapsulateRequest(
    {
      method: inner.method,
      scheme: u.protocol.replace(":", ""),
      authority: u.host,
      path: `${u.pathname}${u.search}`,
      body: inner.body === undefined ? undefined : asBytes(inner.body),
    },
    cfg,
  );
  return postWire(wire).then((respWire) => {
    if (respWire.length !== 8192) {
      return { status: 502, bytes: respWire, body: utf8d.decode(respWire).trim() };
    }
    const innerRes = decapsulateResponse(respWire, session);
    return { status: innerRes.status, bytes: innerRes.body, body: utf8d.decode(innerRes.body) };
  });
}

/**
 * A directory holds a GET on an empty mailbox open for about 30 seconds before it answers
 * "nothing yet". Waiting less than that turned every quiet poll into a timeout error.
 */
export const LONG_POLL_MS = 45_000;

function emptyOnLongPoll(method: string, e: unknown): MailboxResponse {
  const name = (e as { name?: string })?.name;
  if (method === "GET" && (name === "TimeoutError" || name === "AbortError")) return toResponse(MAILBOX_EMPTY, "");
  throw e;
}

/** POST encapsulated requests to an OHTTP relay (RFC 9458). */
export function ohttpRelayTransport(cfg: OhttpKeyConfig, relay: string): MailboxTransport {
  const send = (method: string, url: string, body?: MailboxBody): Promise<MailboxResponse> =>
    ohttpSend(cfg, { method, url, body }, async (wire) => {
      const res = await fetch(relay, {
        method: "POST",
        headers: { "content-type": "message/ohttp-req" },
        body: wire as unknown as BodyInit,
        signal: AbortSignal.timeout(method === "GET" ? LONG_POLL_MS : 20_000),
      });
      return new Uint8Array(await res.arrayBuffer());
    }).catch((e) => emptyOnLongPoll(method, e));
  return {
    get: (url) => send("GET", url),
    post: (url, body) => send("POST", url, body),
    put: (url, body) => send("PUT", url, body),
  };
}

/** Encapsulate and POST to the directory's own `/.well-known/ohttp-gateway` (localhost / self-host). */
export function ohttpGatewayTransport(cfg: OhttpKeyConfig, directory: string): MailboxTransport {
  const gateway = `${mailboxBase(directory)}/.well-known/ohttp-gateway`;
  const send = (method: string, url: string, body?: MailboxBody): Promise<MailboxResponse> =>
    ohttpSend(cfg, { method, url, body }, async (wire) => {
      const res = await fetch(gateway, {
        method: "POST",
        headers: { "content-type": "message/ohttp-req" },
        body: wire as unknown as BodyInit,
        signal: AbortSignal.timeout(method === "GET" ? LONG_POLL_MS : 20_000),
      });
      return new Uint8Array(await res.arrayBuffer());
    }).catch((e) => emptyOnLongPoll(method, e));
  return {
    get: (url) => send("GET", url),
    post: (url, body) => send("POST", url, body),
    put: (url, body) => send("PUT", url, body),
  };
}

export function fetchTransport(): MailboxTransport {
  return {
    async get(url) {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(20_000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, bytes, body: utf8d.decode(bytes).trim() };
    },
    async post(url, body) {
      const bytes = asBytes(body);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": bytes.length > 1000 ? "application/octet-stream" : "text/plain" },
        body: bytes as unknown as BodyInit,
        signal: AbortSignal.timeout(20_000),
      });
      const out = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, bytes: out, body: utf8d.decode(out).trim() };
    },
    async put(url, body) {
      const bytes = asBytes(body);
      const res = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes as unknown as BodyInit,
        signal: AbortSignal.timeout(20_000),
      });
      const out = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, bytes: out, body: utf8d.decode(out).trim() };
    },
  };
}

type Box = { original?: Uint8Array; proposal?: Uint8Array; expiresAt: number };

/** In-process BIP77 mailbox + OHTTP gateway. Same paths as directory/server.ts. */
export class MemoryDirectory {
  readonly boxes = new Map<string, Box>();
  readonly ohttp: OhttpKeyPair;
  readonly ttlMs: number;
  constructor(ttlMs = 24 * 60 * 60 * 1000, ohttp?: OhttpKeyPair) {
    this.ttlMs = ttlMs;
    this.ohttp = ohttp ?? genOhttpKeyPair(1);
  }

  private box(id: string): Box {
    const key = id.toUpperCase();
    let b = this.boxes.get(key);
    if (!b) {
      b = { expiresAt: Date.now() + this.ttlMs };
      this.boxes.set(key, b);
    }
    return b;
  }

  handle(method: string, path: string, body: MailboxBody = "", search = ""): MailboxResponse {
    const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length === 0) {
      return toResponse(200, JSON.stringify({ name: "PrivateBit BIP77 mailbox", v: 2 }));
    }
    if (parts[0] === ".well-known" && parts[1] === "ohttp-gateway") {
      if (method.toUpperCase() === "GET") {
        const q = search.startsWith("?") ? search.slice(1) : search;
        if (/(?:^|&)allowed_purposes(?:&|=|$)/.test(q)) {
          return { status: 200, bytes: encodeAllowedPurposes([BIP77_OHTTP_PURPOSE]), body: BIP77_OHTTP_PURPOSE };
        }
        const keys = encodeOhttpKeyConfig(this.ohttp);
        return { status: 200, bytes: keys, body: "" };
      }
      if (method.toUpperCase() === "POST") {
        const wire = asBytes(body);
        const out = gatewayHandle(wire, this.ohttp, (req) => this.dispatchBhttp(req));
        return { status: 200, bytes: out, body: "" };
      }
    }
    const id = parts[0]!;
    const slot: MailboxSlot = parts[1]?.toLowerCase() === "proposal" ? "proposal" : "original";
    const b = this.box(id);
    if (Date.now() > b.expiresAt) {
      this.boxes.delete(id.toUpperCase());
      return toResponse(410, "expired");
    }
    const m = method.toUpperCase();
    if (m === "GET") {
      const payload = slot === "proposal" ? b.proposal : b.original;
      if (!payload) return toResponse(MAILBOX_EMPTY, "");
      return { status: MAILBOX_OK, bytes: payload, body: utf8d.decode(payload) };
    }
    if (m === "POST" || m === "PUT") {
      const bytes = asBytes(body);
      if (bytes.length === 0) return toResponse(400, "empty payload");
      if (slot === "proposal") b.proposal = bytes;
      else b.original = bytes;
      return toResponse(MAILBOX_OK, "ok");
    }
    return toResponse(405, "method");
  }

  dispatchBhttp(req: BhttpRequest): BhttpResponse {
    const got = this.handle(req.method, req.path, req.body ?? new Uint8Array());
    return { status: got.status, body: got.bytes };
  }

  transport(origin = "http://127.0.0.1:17777"): MailboxTransport {
    const run = (method: string, url: string, body: MailboxBody = ""): MailboxResponse => {
      const u = new URL(url, origin);
      return this.handle(method, u.pathname, body, u.search);
    };
    return {
      get: async (url) => run("GET", url),
      post: async (url, body) => run("POST", url, body),
      put: async (url, body) => run("PUT", url, body),
    };
  }

  /** Mailbox HTTP inside OHTTP so the store never sees client identity on the inner URL from the caller. */
  ohttpTransport(origin = "http://127.0.0.1:17777"): MailboxTransport {
    const cfg = this.ohttp;
    const target = new URL(origin);
    const send = async (method: string, url: string, body?: MailboxBody): Promise<MailboxResponse> => {
      const u = new URL(url, origin);
      const { wire, session } = encapsulateRequest(
        {
          method,
          scheme: target.protocol.replace(":", ""),
          authority: target.host,
          path: u.pathname,
          body: body === undefined ? undefined : asBytes(body),
        },
        cfg,
      );
      const resp = gatewayHandle(wire, this.ohttp, (req) => this.dispatchBhttp(req));
      const inner = decapsulateResponse(resp, session);
      return { status: inner.status, bytes: inner.body, body: utf8d.decode(inner.body) };
    };
    return {
      get: (url) => send("GET", url),
      post: (url, body) => send("POST", url, body),
      put: (url, body) => send("PUT", url, body),
    };
  }
}

export async function postOriginal(
  transport: MailboxTransport,
  pj: string,
  payload: MailboxBody,
): Promise<MailboxResponse> {
  return transport.post(mailboxUrls(pj).original, payload);
}

export async function getOriginal(transport: MailboxTransport, pj: string): Promise<MailboxResponse> {
  return transport.get(mailboxUrls(pj).original);
}

/**
 * BIP77: the proposal goes to the sender's own reply mailbox, named by the short id of the
 * sender's reply key. A directory only has "/<id>" mailboxes; "/<id>/proposal" is a 404 on
 * payjo.in (this was why every Payjoin through payjo.in stopped after the receiver's step).
 */
export function replyMailboxUrl(pj: string, replyPkCompressed: Uint8Array): string {
  const raw = stripFrag(pj.trim());
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  // The pj= URL is "<directory>/<receiver id>"; the reply mailbox sits next to it.
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  parts[parts.length ? parts.length - 1 : 0] = mailboxShortId(replyPkCompressed);
  url.hash = "";
  url.search = "";
  url.pathname = `/${parts.join("/")}`;
  return url.toString();
}

export async function postProposal(
  transport: MailboxTransport,
  pj: string,
  payload: MailboxBody,
  replyPkCompressed?: Uint8Array,
): Promise<MailboxResponse> {
  return transport.post(replyPkCompressed ? replyMailboxUrl(pj, replyPkCompressed) : mailboxUrls(pj).proposal, payload);
}

export async function getProposal(transport: MailboxTransport, pj: string, replyPkCompressed?: Uint8Array): Promise<MailboxResponse> {
  return transport.get(replyPkCompressed ? replyMailboxUrl(pj, replyPkCompressed) : mailboxUrls(pj).proposal);
}

export async function pollProposal(
  transport: MailboxTransport,
  pj: string,
  args: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<void>; replyPk?: Uint8Array },
): Promise<MailboxResponse> {
  const sleep = args.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last: MailboxResponse = toResponse(MAILBOX_EMPTY, "");
  for (let i = 0; i < args.attempts; i++) {
    last = await getProposal(transport, pj, args.replyPk);
    if (last.status === MAILBOX_OK && last.bytes.length > 0) return last;
    if (last.status === 410) return last;
    if (i + 1 < args.attempts) await sleep(args.delayMs);
  }
  return last;
}
