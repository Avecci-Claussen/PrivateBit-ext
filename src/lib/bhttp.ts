/**
 * Minimal RFC 9292 Binary HTTP (known-length requests and responses).
 * Only what BIP77 OHTTP needs: method/scheme/authority/path, a few fields, body.
 */
import { concatBytes, randomBytes } from "./bytes.ts";

export type BhttpRequest = {
  method: string;
  scheme: string;
  authority: string;
  path: string;
  headers?: [string, string][];
  body?: Uint8Array;
};

export type BhttpResponse = {
  status: number;
  headers?: [string, string][];
  body: Uint8Array;
};

function encodeVarint(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error("varint");
  if (n < 64) return Uint8Array.of(n);
  if (n < 16384) return Uint8Array.of(0x40 | (n >> 8), n & 0xff);
  if (n < 1073741824) {
    return Uint8Array.of(0x80 | (n >> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  const o = new Uint8Array(8);
  const big = BigInt(n);
  o[0] = 0xc0;
  for (let i = 7; i >= 1; i--) o[i] = Number((big >> BigInt((7 - i) * 8)) & 0xffn);
  return o;
}

function readVarint(buf: Uint8Array, i: number): { n: number; i: number } {
  const b = buf[i];
  if (b === undefined) throw new Error("bhttp truncated varint");
  const prefix = b >> 6;
  const len = 1 << prefix;
  if (i + len > buf.length) throw new Error("bhttp truncated varint");
  let n = b & 0x3f;
  for (let k = 1; k < len; k++) n = (n << 8) | buf[i + k]!;
  return { n, i: i + len };
}

function encodeString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concatBytes(encodeVarint(bytes.length), bytes);
}

function readString(buf: Uint8Array, i: number): { s: string; i: number } {
  const len = readVarint(buf, i);
  const end = len.i + len.n;
  if (end > buf.length) throw new Error("bhttp truncated string");
  return { s: new TextDecoder().decode(buf.subarray(len.i, end)), i: end };
}

function encodeFields(headers: [string, string][]): Uint8Array {
  const chunks: Uint8Array[] = [encodeVarint(headers.length)];
  for (const [k, v] of headers) {
    chunks.push(encodeString(k.toLowerCase()), encodeString(v));
  }
  return concatBytes(...chunks);
}

function readFields(buf: Uint8Array, i: number): { headers: [string, string][]; i: number } {
  const n = readVarint(buf, i);
  i = n.i;
  const headers: [string, string][] = [];
  for (let k = 0; k < n.n; k++) {
    const name = readString(buf, i);
    const val = readString(buf, name.i);
    headers.push([name.s, val.s]);
    i = val.i;
  }
  return { headers, i };
}

/** Known-length request, framing 0. Optional random padding to `paddedLen`. */
export function encodeRequest(req: BhttpRequest, paddedLen?: number): Uint8Array {
  const headers = req.headers ?? [];
  const body = req.body ?? new Uint8Array(0);
  const core = concatBytes(
    Uint8Array.of(0),
    encodeString(req.method),
    encodeString(req.scheme),
    encodeString(req.authority),
    encodeString(req.path),
    encodeFields(headers),
    concatBytes(encodeVarint(body.length), body),
    encodeFields([]),
  );
  if (paddedLen === undefined) return core;
  if (core.length > paddedLen) throw new Error(`BHTTP request ${core.length} exceeds pad ${paddedLen}`);
  const out = new Uint8Array(paddedLen);
  out.set(core);
  out.set(randomBytes(paddedLen - core.length), core.length);
  return out;
}

export function decodeRequest(buf: Uint8Array): BhttpRequest {
  if (buf[0] !== 0) throw new Error("only known-length BHTTP requests");
  let i = 1;
  const method = readString(buf, i);
  const scheme = readString(buf, method.i);
  const authority = readString(buf, scheme.i);
  const path = readString(buf, authority.i);
  const fields = readFields(buf, path.i);
  const blen = readVarint(buf, fields.i);
  const end = blen.i + blen.n;
  if (end > buf.length) throw new Error("bhttp truncated body");
  const body = buf.subarray(blen.i, end);
  return {
    method: method.s,
    scheme: scheme.s,
    authority: authority.s,
    path: path.s,
    headers: fields.headers,
    body,
  };
}

/** Known-length response, framing 1. */
export function encodeResponse(res: BhttpResponse, paddedLen?: number): Uint8Array {
  const headers = res.headers ?? [];
  const core = concatBytes(
    Uint8Array.of(1),
    encodeVarint(res.status),
    encodeFields(headers),
    concatBytes(encodeVarint(res.body.length), res.body),
    encodeFields([]),
  );
  if (paddedLen === undefined) return core;
  if (core.length > paddedLen) throw new Error(`BHTTP response ${core.length} exceeds pad ${paddedLen}`);
  const out = new Uint8Array(paddedLen);
  out.set(core);
  out.set(randomBytes(paddedLen - core.length), core.length);
  return out;
}

export function decodeResponse(buf: Uint8Array): BhttpResponse {
  if (buf[0] !== 1) throw new Error("only known-length BHTTP responses");
  const st = readVarint(buf, 1);
  const fields = readFields(buf, st.i);
  const blen = readVarint(buf, fields.i);
  const end = blen.i + blen.n;
  if (end > buf.length) throw new Error("bhttp truncated body");
  return { status: st.n, headers: fields.headers, body: buf.subarray(blen.i, end) };
}
