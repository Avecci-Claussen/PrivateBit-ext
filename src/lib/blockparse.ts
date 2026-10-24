import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, hex } from "./bytes.ts";

export type LightVin = {
  txid: string;
  vout: number;
  scriptSig: Uint8Array;
  witness: Uint8Array[];
};

export type LightTx = {
  txid: string;
  vin: LightVin[];
  vout: { value: bigint; script: Uint8Array }[];
};

function readU32(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
}

function readVarint(b: Uint8Array, i: number): { n: number; i: number } {
  if (i >= b.length) throw new Error("varint");
  const v = b[i]!;
  if (v < 0xfd) return { n: v, i: i + 1 };
  if (v === 0xfd) {
    if (i + 3 > b.length) throw new Error("varint");
    return { n: b[i + 1]! | (b[i + 2]! << 8), i: i + 3 };
  }
  if (v === 0xfe) {
    if (i + 5 > b.length) throw new Error("varint");
    return { n: readU32(b, i + 1), i: i + 5 };
  }
  throw new Error("varint too large");
}

function txidOf(body: Uint8Array): string {
  const hash = sha256(sha256(body));
  return hex(hash.reverse());
}

function readTx(raw: Uint8Array, offset: number): { tx: LightTx; i: number } {
  if (offset + 4 > raw.length) throw new Error("tx");
  let i = offset;
  const version = raw.subarray(i, i + 4);
  i += 4;
  let segwit = false;
  if (raw[i] === 0 && raw[i + 1] === 1) {
    segwit = true;
    i += 2;
  }
  const legacy: Uint8Array[] = [version];
  const vinCountAt = i;
  const vinCount = readVarint(raw, i);
  i = vinCount.i;
  legacy.push(raw.subarray(vinCountAt, i));
  const vin: LightVin[] = [];
  for (let n = 0; n < vinCount.n; n++) {
    if (i + 36 > raw.length) throw new Error("vin");
    const vinStart = i;
    const id = raw.slice(i, i + 32);
    const txid = hex(id.reverse());
    const vout = readU32(raw, i + 32);
    i += 36;
    const scriptLen = readVarint(raw, i);
    i = scriptLen.i;
    if (i + scriptLen.n + 4 > raw.length) throw new Error("scriptSig");
    const scriptSig = raw.subarray(i, i + scriptLen.n);
    i += scriptLen.n + 4;
    legacy.push(raw.subarray(vinStart, i));
    vin.push({ txid, vout, scriptSig, witness: [] });
  }
  const voutStart = i;
  const voutCount = readVarint(raw, i);
  i = voutCount.i;
  const vout: { value: bigint; script: Uint8Array }[] = [];
  for (let n = 0; n < voutCount.n; n++) {
    if (i + 8 > raw.length) throw new Error("vout");
    let value = 0n;
    for (let b = 0; b < 8; b++) value |= BigInt(raw[i + b]!) << BigInt(8 * b);
    i += 8;
    const scriptLen = readVarint(raw, i);
    i = scriptLen.i;
    if (i + scriptLen.n > raw.length) throw new Error("scriptPubKey");
    const script = raw.subarray(i, i + scriptLen.n);
    i += scriptLen.n;
    vout.push({ value, script });
  }
  legacy.push(raw.subarray(voutStart, i));
  if (segwit) {
    for (let n = 0; n < vin.length; n++) {
      const stackCount = readVarint(raw, i);
      i = stackCount.i;
      const stack: Uint8Array[] = [];
      for (let s = 0; s < stackCount.n; s++) {
        const item = readVarint(raw, i);
        i = item.i;
        if (i + item.n > raw.length) throw new Error("witness");
        stack.push(raw.subarray(i, i + item.n));
        i += item.n;
      }
      vin[n]!.witness = stack;
    }
  }
  if (i + 4 > raw.length) throw new Error("locktime");
  legacy.push(raw.subarray(i, i + 4));
  i += 4;
  return { tx: { txid: txidOf(concatBytes(...legacy)), vin, vout }, i };
}

/** Transactions in a standard block. Returns null when the bytes are not that layout. */
export function parseBlockTransactions(raw: Uint8Array): LightTx[] | null {
  if (raw.length < 81) return null;
  try {
    let i = 80;
    const count = readVarint(raw, i);
    i = count.i;
    if (count.n < 1 || count.n > 100_000) return null;
    const txs: LightTx[] = [];
    for (let n = 0; n < count.n; n++) {
      const next = readTx(raw, i);
      txs.push(next.tx);
      i = next.i;
    }
    if (i !== raw.length) return null;
    return txs;
  } catch {
    return null;
  }
}
