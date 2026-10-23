import { bytesToHex, concatBytes, hexToBytes, randomBytes } from "@noble/hashes/utils";

export { bytesToHex, concatBytes, hexToBytes, randomBytes };

export function hex(u8: Uint8Array): string {
  return bytesToHex(u8);
}

export function fromHex(s: string): Uint8Array {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  if (h.length % 2 !== 0) throw new Error("odd hex");
  return hexToBytes(h);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function ser32(n: number): Uint8Array {
  const o = new Uint8Array(4);
  const v = n >>> 0;
  o[0] = (v >>> 24) & 0xff;
  o[1] = (v >>> 16) & 0xff;
  o[2] = (v >>> 8) & 0xff;
  o[3] = v & 0xff;
  return o;
}

export function ser32le(n: number): Uint8Array {
  const o = new Uint8Array(4);
  const v = n >>> 0;
  o[0] = v & 0xff;
  o[1] = (v >>> 8) & 0xff;
  o[2] = (v >>> 16) & 0xff;
  o[3] = (v >>> 24) & 0xff;
  return o;
}

export function txidToOutpointBytes(txidHex: string, vout: number): Uint8Array {
  const raw = fromHex(txidHex);
  if (raw.length !== 32) throw new Error("txid must be 32 bytes");
  const le = raw.slice().reverse();
  return concatBytes(le, ser32le(vout));
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
