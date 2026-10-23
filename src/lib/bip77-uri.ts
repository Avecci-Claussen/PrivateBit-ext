/**
 * BIP77 receiver fragment parameters on the pj= mailbox URL.
 * HRP1 + bech32 charset, no checksum. `-` separator. Lex order EX-OH-RK.
 * `#` is percent-encoded as %23 in the BIP21 query.
 */
import { bech32 } from "@scure/base";
import { mailboxShortId } from "./mailbox.ts";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export type Bip77Fragment = {
  expiresAt: number;
  receiverKeyCompressed: Uint8Array;
  ohttp?: { keyId: Uint8Array; compressedPub: Uint8Array };
};

export function bech32NoChecksum(hrp: string, data: Uint8Array): string {
  const words = bech32.toWords(data);
  return `${hrp.toUpperCase()}1${words.map((w) => CHARSET[w]!).join("").toUpperCase()}`;
}

export function decodeBech32NoChecksum(token: string): { hrp: string; data: Uint8Array } {
  const raw = token.trim();
  const i = raw.indexOf("1");
  if (i <= 0) throw new Error("BIP77 fragment token missing 1");
  const hrp = raw.slice(0, i).toLowerCase();
  const payload = raw.slice(i + 1).toLowerCase();
  const words: number[] = [];
  for (const ch of payload) {
    const w = CHARSET.indexOf(ch);
    if (w < 0) throw new Error("BIP77 fragment bech32 char");
    words.push(w);
  }
  return { hrp, data: new Uint8Array(bech32.fromWords(words)) };
}

function unixToBytes(unix: number): Uint8Array {
  const n = BigInt(unix);
  const hex = n.toString(16);
  const even = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(even.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(even.slice(i * 2, i * 2 + 2), 16);
  return out.length ? out : new Uint8Array([0]);
}

function bytesToUnix(b: Uint8Array): number {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return Number(n);
}

/** Encode EX, OH, RK in lexicographical order (BIP77 example). */
export function encodeFragment(f: Bip77Fragment): string {
  const parts = [bech32NoChecksum("ex", unixToBytes(Math.floor(f.expiresAt / 1000)))];
  if (f.ohttp) {
    const ki = f.ohttp.keyId.length === 2 ? f.ohttp.keyId : Uint8Array.of(0, f.ohttp.keyId[0] ?? 0);
    parts.push(bech32NoChecksum("oh", concat(ki, f.ohttp.compressedPub)));
  }
  parts.push(bech32NoChecksum("rk", f.receiverKeyCompressed));
  return parts.join("-");
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
}

export function parseFragment(frag: string): Partial<Bip77Fragment> & { raw: Record<string, Uint8Array> } {
  const raw: Record<string, Uint8Array> = {};
  const cleaned = frag.replace(/^#/, "");
  if (!cleaned) return { raw };
  const sep = cleaned.includes("-") || !cleaned.includes("+") ? "-" : "+";
  for (const tok of cleaned.split(sep)) {
    if (!tok) continue;
    const { hrp, data } = decodeBech32NoChecksum(tok);
    raw[hrp] = data;
  }
  const out: Partial<Bip77Fragment> & { raw: Record<string, Uint8Array> } = { raw };
  if (raw.ex) out.expiresAt = bytesToUnix(raw.ex) * 1000;
  if (raw.rk) {
    if (raw.rk.length !== 33) throw new Error("RK must be a 33-byte compressed pubkey");
    out.receiverKeyCompressed = raw.rk;
  }
  if (raw.oh) {
    if (raw.oh.length === 35) {
      out.ohttp = { keyId: raw.oh.subarray(0, 2), compressedPub: raw.oh.subarray(2) };
    } else if (raw.oh.length === 33) {
      out.ohttp = { keyId: Uint8Array.of(0, 0), compressedPub: raw.oh };
    } else {
      throw new Error("OH must be 33-byte pubkey or 2-byte key id + 33-byte pubkey");
    }
  }
  return out;
}

export function attachFragment(mailboxUrl: string, fragment: string): string {
  const hash = fragment.replace(/^#/, "");
  const base = mailboxUrl.split("#")[0]!.replace(/\/$/, "");
  return `${base}#${hash}`;
}

/**
 * pj= in BIP21 is uppercase. Fragment `#` becomes %23 so it is the mailbox
 * URL's fragment, not the bitcoin: URI's.
 */
export function pjQueryValue(mailboxWithFragment: string): string {
  const { url, fragment } = splitMailbox(mailboxWithFragment);
  const upper = url.toUpperCase();
  if (!fragment) return upper;
  return `${upper}%23${fragment.toUpperCase()}`;
}

export function splitMailbox(pj: string): { url: string; fragment: string } {
  const raw = pj.trim();
  const decoded = raw.replace(/%23/gi, "#");
  const i = decoded.indexOf("#");
  if (i < 0) return { url: decoded, fragment: "" };
  return { url: decoded.slice(0, i), fragment: decoded.slice(i + 1) };
}

export function mailboxIdFromRk(rkCompressed: Uint8Array): string {
  return mailboxShortId(rkCompressed);
}

export { CHARSET as BIP77_BECH32_CHARSET };
