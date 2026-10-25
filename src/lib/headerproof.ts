// Full verification of Fractal merge-mined (AuxPoW) and indexer (FIP-101) header proofs.
// Public explorers strip these proofs, so this runs with an own Fractal node, which returns them
// from `getblockheader <hash> false true`. Mirrors fractald v0.4.0 src/auxpow.cpp CAuxPow::check
// and src/primitives/indexer.cpp; checked against blocks a real fractald regtest node accepted.
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, fromHex, hex } from "./bytes.ts";
import {
  BlockCheckError,
  FRACTAL_AUXPOW_CHAIN_ID,
  FRACTAL_POW_LIMIT_BITS,
  assertTargetHard,
  bitsTarget,
  blockKind,
  headerBits,
  headerTime,
  readTx,
  readVarint,
  type BlockKind,
} from "./blockparse.ts";

/** Fractal mainnet indexer cold key (fractald chainparams consensus.indexerParams.coldPubKey). */
export const FRACTAL_INDEXER_COLD_KEY = "da8d7239fdb567d62b38f371a77d2d3fe40d0d1a84dc21d7ab0fb0188c506b83";
/** Regtest powLimit (compact) and indexer key, used only by tests against fractald's own vectors. */
export const FRACTAL_REGTEST_POW_LIMIT_BITS = 0x207fffff;
export const FRACTAL_REGTEST_INDEXER_COLD_KEY = "5cd26f06fb752947bd414bafeedbaefe5461c543e6f7b404a7900d0ad4f0247d";

const MERGED_MINING_HEADER = Uint8Array.of(0xfa, 0xbe, 0x6d, 0x6d);
const dsha = (b: Uint8Array): Uint8Array => sha256(sha256(b));

export type AuxPow = {
  coinbase: { txidLE: Uint8Array; scriptSig: Uint8Array; inputs: number };
  merkleBranch: Uint8Array[];
  merkleIndex: number;
  chainMerkleBranch: Uint8Array[];
  chainIndex: number;
  parent: Uint8Array;
};
export type IndexerProof = {
  hotPubKey: Uint8Array;
  authTimestamp: number;
  rangeStart: number;
  rangeEnd: number;
  coldSignature: Uint8Array;
  hotSignature: Uint8Array;
};
export type HeaderWithProof = { header: Uint8Array; hashLE: Uint8Array; kind: BlockKind; aux?: AuxPow; indexer?: IndexerProof };

const u32 = (b: Uint8Array, i: number): number => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const i32 = (b: Uint8Array, i: number): number => u32(b, i) | 0;
const u16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);

function hashes(b: Uint8Array, at: number): { list: Uint8Array[]; i: number } {
  const n = readVarint(b, at);
  if (n.n > 64) throw new BlockCheckError("merkle branch too long");
  const list: Uint8Array[] = [];
  let i = n.i;
  for (let k = 0; k < n.n; k++, i += 32) {
    if (i + 32 > b.length) throw new BlockCheckError("short merkle branch");
    list.push(b.slice(i, i + 32));
  }
  return { list, i };
}

/** Parse fractald's `getblockheader <hash> false true` bytes: the 80-byte header plus its proof. */
export function parseHeaderWithProof(raw: Uint8Array): HeaderWithProof {
  if (raw.length < 80) throw new BlockCheckError("header too short");
  const header = raw.slice(0, 80);
  const hashLE = dsha(header);
  const kind = blockKind(header, "fractal");
  if (kind === "legacy") {
    if (raw.length !== 80) throw new BlockCheckError("unexpected data after a normal header");
    return { header, hashLE, kind };
  }
  if (kind === "indexer") {
    if (raw.length !== 80 + 168) throw new BlockCheckError("indexer proof is not 168 bytes");
    const p = raw.subarray(80);
    return {
      header,
      hashLE,
      kind,
      indexer: {
        hotPubKey: p.slice(0, 32),
        authTimestamp: u32(p, 32),
        rangeStart: u16(p, 36),
        rangeEnd: u16(p, 38),
        coldSignature: p.slice(40, 104),
        hotSignature: p.slice(104, 168),
      },
    };
  }
  const cb = readTx(raw, 80);
  let i = cb.i;
  const cbBytes = cb.tx;
  i += 32; // hashBlock: never used (CAuxPow serialisation)
  const mb = hashes(raw, i);
  i = mb.i;
  if (i + 4 > raw.length) throw new BlockCheckError("short auxpow");
  const merkleIndex = i32(raw, i);
  i += 4;
  const cmb = hashes(raw, i);
  i = cmb.i;
  if (i + 4 + 80 !== raw.length) throw new BlockCheckError("auxpow length does not add up");
  const chainIndex = i32(raw, i);
  i += 4;
  return {
    header,
    hashLE,
    kind,
    aux: {
      coinbase: { txidLE: fromHex(cbBytes.txid).reverse(), scriptSig: cbBytes.vin[0]?.scriptSig ?? new Uint8Array(), inputs: cbBytes.vin.length },
      merkleBranch: mb.list,
      merkleIndex,
      chainMerkleBranch: cmb.list,
      chainIndex,
      parent: raw.slice(i, i + 80),
    },
  };
}

function checkMerkleBranch(leaf: Uint8Array, branch: Uint8Array[], index: number): Uint8Array {
  let h = leaf;
  let n = index;
  for (const node of branch) {
    h = n & 1 ? dsha(concatBytes(node, h)) : dsha(concatBytes(h, node));
    n >>>= 1;
  }
  return h;
}

/** CAuxPow::getExpectedIndex. */
export function expectedChainIndex(nonce: number, chainId: number, h: number): number {
  const M64 = (1n << 64n) - 1n;
  const mod = 1n << BigInt(h);
  let r = BigInt(nonce >>> 0);
  r = (r * 1103515245n + 12345n) & M64;
  r %= mod;
  r += BigInt(chainId);
  r = (r * 1103515245n + 12345n) & M64;
  r %= mod;
  return Number(r);
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const big = (le: Uint8Array): bigint => BigInt(`0x${hex(le.slice().reverse())}`);

/** CAuxPow::check plus the parent-header proof of work against the Fractal header's bits. */
export function verifyAuxPow(p: HeaderWithProof, minWorkBits = 0): void {
  const a = p.aux;
  if (!a) throw new BlockCheckError("no auxpow");
  const parentVersion = i32(a.parent, 0);
  if (((parentVersion >>> 16) & 0xffff) === FRACTAL_AUXPOW_CHAIN_ID) throw new BlockCheckError("auxpow parent has our chain ID");
  if (a.chainMerkleBranch.length > 30) throw new BlockCheckError("auxpow chain merkle branch too long");
  if (a.merkleIndex !== 0) throw new BlockCheckError("auxpow coinbase is not the first transaction");
  const rootLE = checkMerkleBranch(p.hashLE, a.chainMerkleBranch, a.chainIndex);
  const rootBE = rootLE.slice().reverse();
  if (hex(checkMerkleBranch(a.coinbase.txidLE, a.merkleBranch, 0)) !== hex(a.parent.subarray(36, 68))) {
    throw new BlockCheckError("auxpow merkle root incorrect");
  }
  if (a.coinbase.inputs < 1) throw new BlockCheckError("auxpow coinbase has no inputs");
  const script = a.coinbase.scriptSig;
  const head = indexOf(script, MERGED_MINING_HEADER);
  const pc = indexOf(script, rootBE);
  if (pc < 0) throw new BlockCheckError("auxpow chain merkle root missing from the parent coinbase");
  if (head >= 0) {
    if (indexOf(script, MERGED_MINING_HEADER, head + 1) >= 0) throw new BlockCheckError("several merged mining headers");
    if (head + MERGED_MINING_HEADER.length !== pc) throw new BlockCheckError("merged mining header is not just before the root");
  } else if (pc > 20) {
    throw new BlockCheckError("auxpow chain merkle root must start in the first 20 bytes");
  }
  const after = pc + 32;
  if (script.length - after < 8) throw new BlockCheckError("auxpow tree size and nonce missing");
  const size = u32(script, after);
  const h = a.chainMerkleBranch.length;
  if (size !== 2 ** h) throw new BlockCheckError("auxpow merkle branch size does not match");
  const nonce = u32(script, after + 4);
  if (a.chainIndex !== expectedChainIndex(nonce, FRACTAL_AUXPOW_CHAIN_ID, h)) throw new BlockCheckError("auxpow wrong index");
  const target = bitsTarget(headerBits(p.header));
  if (minWorkBits) assertTargetHard(target, minWorkBits, "merge-mined header");
  if (big(dsha(a.parent)) > target) throw new BlockCheckError("auxpow parent header has no valid proof of work");
}

/** FIP-101 CheckProofOfWork phase for indexer blocks. */
export function verifyIndexerProof(p: HeaderWithProof, coldKey = FRACTAL_INDEXER_COLD_KEY, powLimitBits = FRACTAL_POW_LIMIT_BITS): void {
  const x = p.indexer;
  if (!x) throw new BlockCheckError("no indexer proof");
  if (headerBits(p.header) !== powLimitBits) throw new BlockCheckError("indexer block bits are not the powLimit");
  if (headerTime(p.header) > x.authTimestamp) throw new BlockCheckError("indexer authorization expired");
  const prevLE = p.header.subarray(4, 36);
  const cursor = prevLE[0]! | (prevLE[1]! << 8);
  if (x.rangeStart > x.rangeEnd || cursor < x.rangeStart || cursor > x.rangeEnd) throw new BlockCheckError("indexer cursor outside its range");
  const powHash = dsha(concatBytes(x.hotPubKey, p.header));
  if (big(powHash) > bitsTarget(headerBits(p.header))) throw new BlockCheckError("indexer proof of work invalid");
  const coldMsg = indexerColdMessage(x);
  if (!schnorr.verify(x.coldSignature, coldMsg, fromHex(coldKey))) throw new BlockCheckError("indexer cold signature invalid");
  if (!schnorr.verify(x.hotSignature, p.hashLE, x.hotPubKey)) throw new BlockCheckError("indexer hot signature invalid");
}

/** Double SHA-256 of hotPubKey || nAuthTimestamp || nRangeStart || nRangeEnd (little endian). */
export function indexerColdMessage(x: Pick<IndexerProof, "hotPubKey" | "authTimestamp" | "rangeStart" | "rangeEnd">): Uint8Array {
  const tail = new Uint8Array(8);
  new DataView(tail.buffer).setUint32(0, x.authTimestamp, true);
  new DataView(tail.buffer).setUint16(4, x.rangeStart, true);
  new DataView(tail.buffer).setUint16(6, x.rangeEnd, true);
  return dsha(concatBytes(x.hotPubKey, tail));
}

/** Verify a header with its proof, and that it is the block asked for. Returns its kind. */
export function verifyHeaderWithProof(raw: Uint8Array, expectedHash: string, opts: { coldKey?: string; minAuxWorkBits?: number } = {}): BlockKind {
  const p = parseHeaderWithProof(raw);
  if (hex(p.hashLE.slice().reverse()) !== expectedHash.toLowerCase()) throw new BlockCheckError("header hash does not match the block asked for");
  if (p.kind === "auxpow") verifyAuxPow(p, opts.minAuxWorkBits ?? 0);
  else if (p.kind === "indexer") verifyIndexerProof(p, opts.coldKey);
  return p.kind;
}
