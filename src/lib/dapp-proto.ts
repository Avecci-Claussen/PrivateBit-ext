/**
 * Messages between a web page and PrivateBit. Everything from a page is untrusted: each request
 * is checked here before the background looks at it. The origin never comes from the page; the
 * background takes it from the browser (port sender).
 */
import { chainFromEnum, type ToSignInput } from "./sites.ts";
import type { NetworkId } from "./network.ts";

export const DAPP_PORT = "pb-dapp";

/** Provider errors, same numbers wallets commonly use. */
export const ERR = {
  rejected: 4001,
  unauthorized: 4100,
  unsupported: 4200,
  disconnected: 4900,
  invalid: -32602,
  busy: -32002,
  internal: -32603,
} as const;
export class DappError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const MAX_HEX = 400_000; // 200 kB PSBT
const MAX_TEXT = 10_000;
const MAX_PSBTS = 20;

export type DappRequest =
  | { method: "requestAccounts" }
  | { method: "getAccounts" }
  | { method: "getNetwork" }
  | { method: "switchNetwork"; network: string }
  | { method: "getChain" }
  | { method: "switchChain"; chain: NetworkId }
  | { method: "getPublicKey" }
  | { method: "getBalance" }
  | { method: "getInscriptions"; cursor: number; size: number }
  | { method: "signMessage"; text: string; type: "ecdsa" | "bip322-simple" }
  | { method: "signPsbt"; psbt: string; options: { autoFinalized: boolean; toSignInputs?: ToSignInput[] } }
  | { method: "signPsbts"; psbts: string[]; options: { autoFinalized: boolean; toSignInputs?: ToSignInput[] }[] }
  | { method: "pushPsbt"; psbt: string }
  | { method: "pushTx"; rawtx: string }
  | { method: "sendBitcoin"; to: string; sats: number; feeRate?: number; memos: string[] }
  | { method: "disconnect" };

export type DappMethod = DappRequest["method"];
/** Methods that need a popup the user approves. */
export const NEEDS_APPROVAL: ReadonlySet<DappMethod> = new Set(["requestAccounts", "signMessage", "signPsbt", "signPsbts", "sendBitcoin", "switchChain", "switchNetwork"]);

const bad = (m: string): never => {
  throw new DappError(ERR.invalid, m);
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function str(v: unknown, name: string, max = MAX_TEXT): string {
  if (typeof v !== "string") bad(`${name} must be a string`);
  if ((v as string).length > max) bad(`${name} is too long`);
  return v as string;
}
function hexStr(v: unknown, name: string): string {
  const s = str(v, name, MAX_HEX).trim();
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 || !s.length) bad(`${name} must be hex`);
  return s.toLowerCase();
}
function psbtStr(v: unknown, name: string): string {
  const s = str(v, name, MAX_HEX).trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return s.toLowerCase();
  if (/^[A-Za-z0-9+/=]+$/.test(s) && s.length % 4 === 0) return s;
  return bad(`${name} must be a hex or base64 PSBT`);
}
function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) bad(`${name} must be a whole number from ${min} to ${max}`);
  return v as number;
}

function signOptions(v: unknown): { autoFinalized: boolean; toSignInputs?: ToSignInput[] } {
  if (v === undefined || v === null) return { autoFinalized: true };
  if (!isObj(v)) bad("options must be an object");
  const o = v as Record<string, unknown>;
  const autoFinalized = o.autoFinalized === undefined ? true : o.autoFinalized === true ? true : o.autoFinalized === false ? false : bad("autoFinalized must be true or false");
  if (o.toSignInputs === undefined) return { autoFinalized };
  if (!Array.isArray(o.toSignInputs) || o.toSignInputs.length > 500) bad("toSignInputs must be a list");
  const toSignInputs = (o.toSignInputs as unknown[]).map((t, i): ToSignInput => {
    if (!isObj(t)) bad(`toSignInputs[${i}] must be an object`);
    const e = t as Record<string, unknown>;
    const out: ToSignInput = { index: int(e.index, `toSignInputs[${i}].index`, 0, 10_000) };
    if (e.address !== undefined) out.address = str(e.address, "address", 200);
    if (e.publicKey !== undefined) out.publicKey = hexStr(e.publicKey, "publicKey");
    if (e.sighashTypes !== undefined) {
      if (!Array.isArray(e.sighashTypes) || e.sighashTypes.length > 1) bad("sighashTypes must be a list with one type");
      out.sighashTypes = (e.sighashTypes as unknown[]).map((s) => int(s, "sighashTypes", 0, 255));
    }
    if (e.disableTweakSigner !== undefined) out.disableTweakSigner = e.disableTweakSigner === true;
    if (e.useTweakedSigner !== undefined) out.useTweakedSigner = e.useTweakedSigner === true;
    return out;
  });
  return { autoFinalized, toSignInputs };
}

/** Check one request from a page. Throws DappError with -32602 for anything malformed. */
export function parseRequest(method: unknown, params: unknown): DappRequest {
  if (typeof method !== "string") bad("method must be a string");
  // Port messages are JSON: an omitted optional argument arrives as null.
  const p: unknown[] = (Array.isArray(params) ? params : params === undefined || params === null ? [] : bad("params must be a list")).map((x) => (x === null ? undefined : x));
  if (p.length > 4) bad("too many params");
  switch (method) {
    case "requestAccounts":
    case "getAccounts":
    case "getNetwork":
    case "getChain":
    case "getPublicKey":
    case "getBalance":
    case "disconnect":
      return { method };
    case "switchNetwork": {
      const n = str(p[0], "network", 20);
      if (n !== "livenet") throw new DappError(ERR.unsupported, "only livenet is supported");
      return { method, network: n };
    }
    case "switchChain": {
      const chain = chainFromEnum(p[0]);
      if (!chain) throw new DappError(ERR.unsupported, "supported chains: BITCOIN_MAINNET, FRACTAL_BITCOIN_MAINNET");
      return { method, chain };
    }
    case "getInscriptions":
      return { method, cursor: p[0] === undefined ? 0 : int(p[0], "cursor", 0, 1e9), size: p[1] === undefined ? 20 : int(p[1], "size", 1, 100) };
    case "signMessage": {
      const text = str(p[0], "message");
      const type = p[1] === undefined || p[1] === "ecdsa" ? "ecdsa" : p[1] === "bip322-simple" ? "bip322-simple" : bad("type must be ecdsa or bip322-simple");
      return { method, text, type };
    }
    case "signPsbt":
      return { method, psbt: psbtStr(p[0], "psbt"), options: signOptions(p[1]) };
    case "signPsbts": {
      if (!Array.isArray(p[0]) || !p[0].length || p[0].length > MAX_PSBTS) bad(`psbts must be a list of 1 to ${MAX_PSBTS}`);
      const psbts = (p[0] as unknown[]).map((x, i) => psbtStr(x, `psbts[${i}]`));
      const rawOpts = p[1];
      const optsIn = rawOpts === undefined ? [] : Array.isArray(rawOpts) ? rawOpts : isObj(rawOpts) ? psbts.map(() => rawOpts) : bad("options must be an object or a list");
      return { method, psbts, options: psbts.map((_, i) => signOptions(optsIn[i])) };
    }
    case "pushPsbt":
      return { method, psbt: psbtStr(p[0], "psbt") };
    case "pushTx": {
      const a = p[0];
      const raw = isObj(a) ? a.rawtx : a;
      return { method, rawtx: hexStr(raw, "rawtx") };
    }
    case "sendBitcoin": {
      const to = str(p[0], "to", 200).trim();
      const sats = int(p[1], "satoshis", 330, 21e14);
      const o = p[2] === undefined ? {} : isObj(p[2]) ? (p[2] as Record<string, unknown>) : bad("options must be an object");
      const feeRate = o.feeRate === undefined ? undefined : typeof o.feeRate === "number" && o.feeRate > 0 && o.feeRate <= 5000 ? o.feeRate : bad("feeRate must be a number above 0 and at most 5000");
      const memos: string[] = [];
      if (o.memo !== undefined) memos.push(str(o.memo, "memo", 80));
      if (o.memos !== undefined) {
        if (!Array.isArray(o.memos) || o.memos.length > 4) bad("memos must be a list of up to 4");
        for (const m of o.memos as unknown[]) memos.push(str(m, "memo", 80));
      }
      return { method, to, sats, ...(feeRate !== undefined ? { feeRate } : {}), memos };
    }
    default:
      throw new DappError(ERR.unsupported, `${String(method).slice(0, 40)} is not supported`);
  }
}

/** Envelope checks for what the content script relays. */
export function parseEnvelope(m: unknown): { id: number; method: unknown; params: unknown } | null {
  if (!isObj(m)) return null;
  if (typeof m.id !== "number" || !Number.isInteger(m.id) || m.id < 0) return null;
  return { id: m.id, method: m.method, params: m.params };
}

/** Per origin: at most `max` requests per `windowMs`. */
export class RateLimit {
  private hits = new Map<string, number[]>();
  constructor(private max = 30, private windowMs = 10_000) {}
  take(key: string, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}
