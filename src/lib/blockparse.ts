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

/** Merkle root of txids (display order hex), in header byte order. */
export function merkleRoot(txids: string[]): Uint8Array {
  if (!txids.length) throw new Error("no transactions");
  let level: Uint8Array[] = txids.map((t) => {
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++) b[i] = parseInt(t.slice(62 - i * 2, 64 - i * 2), 16);
    return b;
  });
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(sha256(concatBytes(level[i]!, level[i + 1] ?? level[i]!))));
    level = next;
  }
  return level[0]!;
}

/** Header target from compact bits. */
export function bitsTarget(bits: number): bigint {
  const exp = bits >>> 24;
  const mant = BigInt(bits & 0x7fffff);
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
}

export class BlockCheckError extends Error {
  constructor(msg: string) {
    super(`block data failed a check: ${msg}`);
    this.name = "BlockCheckError";
  }
}

/** Least work a header must show: 2^56 hashes (Fractal's own blocks are about 2^62 today). */
const MIN_WORK_BITS = 56;

/**
 * Audit M2 (independent): check a raw block from a public explorer before matching payments in it.
 * The transactions must hash to the header's merkle root, the header must hash to the block hash
 * asked for, and the header must carry proof of work. Fractal merge-mined blocks (version bit 8)
 * have their work in the parent chain header, which explorers leave out, so for those only the
 * merkle root and hash are checked.
 */
export function checkRawBlock(raw: Uint8Array, expectedHash?: string, txs?: { txid: string }[] | null): void {
  if (raw.length < 81) throw new BlockCheckError("too short");
  const header = raw.subarray(0, 80);
  const hashLE = sha256(sha256(header));
  const hashHex = hex(hashLE.slice().reverse());
  if (expectedHash && hashHex !== expectedHash.toLowerCase()) throw new BlockCheckError("hash does not match the block asked for");
  const list = txs === undefined ? parseBlockTransactions(raw) : txs;
  if (!list) return; // Not a layout we read; the caller refuses it as unsupported.
  const root = merkleRoot(list.map((t) => t.txid));
  if (hex(root) !== hex(header.subarray(36, 68))) throw new BlockCheckError("transactions do not match the merkle root");
  const version = header[0]! | (header[1]! << 8) | (header[2]! << 16) | (header[3]! << 24);
  if (version & 0x100) return;
  const bits = header[72]! | (header[73]! << 8) | (header[74]! << 16) | (header[75]! << 24);
  const target = bitsTarget(bits >>> 0);
  let h = 0n;
  for (let i = 31; i >= 0; i--) h = (h << 8n) | BigInt(hashLE[i]!);
  if (target <= 0n || target >= 1n << BigInt(256 - MIN_WORK_BITS)) throw new BlockCheckError("header target is too easy");
  if (h > target) throw new BlockCheckError("header has no valid proof of work");
}
