import { BlockCheckError, blockKind, headerPrev, parseBlockTransactions, type LightTx } from "./blockparse.ts";
import { fromHex, hex } from "./bytes.ts";
import type { ChainSource } from "./chain.ts";
import { extractEligibleVins, type RawVin } from "./extract-inputs.ts";
import { MEMPOOL_BITCOIN, MEMPOOL_FRACTAL, mempoolBlockRaw, mempoolTxHex } from "./mempool.ts";
import type { NetworkId } from "./network.ts";
import { parseTxHex } from "./tx.ts";
import { sha256 } from "@noble/hashes/sha256";

/** One transaction another wallet can match without downloading the block again. */
export type SharedTx = {
  txid: string;
  inputs: { txid: string; vout: number }[];
  taps: { vout: number; value: string; xonly: string }[];
  eligible: { txid: string; vout: number; pubkey: string; taproot: boolean }[];
};

export type SharedBlock = {
  height: number;
  /** Block hash and its parent, from the header. A mismatch with the last block we matched is a reorg. */
  hash: string;
  prev: string;
  txs: SharedTx[];
};

/** What building one block took. Logged by the worker, read by the live probe. */
export type BlockStats = {
  height: number;
  /** Earlier blocks downloaded to learn this block's input scripts. */
  lookbackBlocks: number;
  bytes: number;
  txs: number;
  /** Transactions with a taproot output: the only ones a payment to us can be in. */
  taprootTxs: number;
  parentsNeeded: number;
  parentsFetched: number;
  parentsNotFound: number;
  /** Transactions kept with a usable set of inputs (one BIP352 tweak each when matched). */
  eligibleTxs: number;
  eligibleInputs: number;
  incomplete: number;
  ms: { lookback: number; raw: number; parents: number; total: number };
};
let statsListener: ((s: BlockStats) => void) | undefined;
export function onBlockStats(fn: ((s: BlockStats) => void) | undefined): void {
  statsListener = fn;
}
/** One line per block for the service worker console. Counts only, nothing about the wallet. */
export function formatBlockStats(s: BlockStats): string {
  return `block ${s.height}: ${s.txs} txs, ${s.taprootTxs} with taproot outputs, ${s.parentsNeeded} parents needed (${s.parentsFetched} fetched, ${s.parentsNotFound} not found), ${s.eligibleTxs} eligible txs, ${s.eligibleInputs} inputs, lookback ${s.lookbackBlocks} blocks, ${Math.round(s.bytes / 1024)} KB, ${s.ms.total} ms (lookback ${s.ms.lookback}, raw ${s.ms.raw}, parents ${s.ms.parents})${s.incomplete ? `, waiting for ${s.incomplete} input transactions` : ""}`;
}

export class UnsupportedBlock extends Error {
  constructor() {
    super("block layout");
    this.name = "UnsupportedBlock";
  }
}

/**
 * Some input scripts could not be found. Matching such a block could miss a payment
 * (BIP352 needs every eligible input), so it is neither matched nor saved. Retried later.
 */
export class IncompleteBlock extends Error {
  constructor(
    readonly height: number,
    readonly missing: string[],
  ) {
    super(`block ${height}: ${missing.length} input scripts missing`);
    this.name = "IncompleteBlock";
  }
}

function headerHashes(raw: Uint8Array): { hash: string; prev: string } {
  if (raw.length < 80) throw new UnsupportedBlock();
  const header = raw.subarray(0, 80);
  const hash = sha256(sha256(header)).slice().reverse();
  const prev = header.slice(4, 36).reverse();
  return { hash: hex(hash), prev: hex(prev) };
}

/** Script marker for an output type BIP352 ignores. Known, so not a missing input. */
const INELIGIBLE = "";

/** Witness v2..v16 output: a spend of one disqualifies the whole transaction (BIP352). */
function isFutureWitness(script: Uint8Array): boolean {
  const len = script.length;
  return len >= 4 && len <= 42 && script[0]! >= 0x52 && script[0]! <= 0x60 && script[1] === len - 2;
}

/** What to remember about an output: its script when BIP352 needs it, a marker otherwise. */
function scriptToKeep(script: Uint8Array): string {
  return isPaymentScript(script) || isFutureWitness(script) ? hex(script) : INELIGIBLE;
}

type Backend = {
  getBlock(height: number): Promise<SharedBlock | undefined>;
  putBlock(height: number, block: SharedBlock): Promise<void>;
  getScripts(height: number): Promise<Record<string, string> | undefined>;
  putScripts(height: number, rows: Record<string, string>): Promise<void>;
  scriptHeights(): Promise<number[]>;
  forgetFrom(height: number): Promise<void>;
  pruneBelow(height: number): Promise<void>;
};

const memoryBlocks = new Map<number, SharedBlock>();
/** Bound on output scripts kept in memory. Oldest are dropped first; IndexedDB keeps the rest. */
const SCRIPT_CACHE_MAX = 250_000;
const memoryScripts = new Map<number, Record<string, string>>();

const memoryBackend: Backend = {
  async getBlock(height) {
    return memoryBlocks.get(height);
  },
  async putBlock(height, block) {
    memoryBlocks.set(height, block);
  },
  async getScripts(height) {
    return memoryScripts.get(height);
  },
  async putScripts(height, rows) {
    memoryScripts.set(height, rows);
  },
  async scriptHeights() {
    return [...memoryScripts.keys()];
  },
  async forgetFrom(height) {
    for (const h of [...memoryBlocks.keys()]) if (h >= height) memoryBlocks.delete(h);
    for (const h of [...memoryScripts.keys()]) if (h >= height) memoryScripts.delete(h);
  },
  async pruneBelow(height) {
    for (const h of [...memoryBlocks.keys()]) if (h < height) memoryBlocks.delete(h);
    for (const h of [...memoryScripts.keys()]) if (h < height) memoryScripts.delete(h);
  },
};

let backendOverride: Backend | undefined;

/** Tests keep blocks in memory. The extension uses IndexedDB. */
export function useMemoryBlocks(): void {
  backendOverride = memoryBackend;
}

export function resetSharedChainForTests(): void {
  memoryBlocks.clear();
  memoryScripts.clear();
  scriptCache.clear();
  indexedHeights.clear();
  backendOverride = memoryBackend;
}

function backend(): Backend {
  if (backendOverride) return backendOverride;
  if (typeof indexedDB === "undefined") return memoryBackend;
  return idbBackend;
}

/** One cache per chain. Fractal keeps the original name so nothing already saved is lost. */
let sharedNet: NetworkId = "fractal";
const dbName = (): string => (sharedNet === "fractal" ? "privatebit-chain" : `privatebit-chain-${sharedNet}`);

/** The open wallet's network. Changing it closes the other chain's cache and clears memory copies. */
export function setSharedChainNetwork(net: NetworkId): void {
  if (net === sharedNet) return;
  sharedNet = net;
  scriptCache.clear();
  indexedHeights.clear();
  memoryBlocks.clear();
  memoryScripts.clear();
  pending.clear();
  const old = dbConn;
  dbConn = undefined;
  void old?.then((db) => db.close()).catch(() => undefined);
}

export function sharedChainNetwork(): NetworkId {
  return sharedNet;
}
/** v2: blocks carry their hash, incomplete blocks were never stored. v1 copies are dropped. */
const DB_VERSION = 2;
let dbConn: Promise<IDBDatabase> | undefined;

/** One connection for the life of the worker (v1 opened a new one on every call and never closed it). */
function idbOpen(): Promise<IDBDatabase> {
  if (dbConn) return dbConn;
  dbConn = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName(), DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ["blocks", "scripts"]) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbConn = undefined;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbConn = undefined;
      reject(req.error);
    };
  });
  return dbConn;
}

/** Delete the shared block cache (last wallet removed). */
export async function clearSharedChain(): Promise<void> {
  scriptCache.clear();
  indexedHeights.clear();
  memoryBlocks.clear();
  memoryScripts.clear();
  if (typeof indexedDB === "undefined" || backendOverride) return;
  const db = dbConn ? await dbConn.catch(() => undefined) : undefined;
  db?.close();
  dbConn = undefined;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(dbName());
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const idbBackend: Backend = {
  async getBlock(height) {
    const db = await idbOpen();
    const row = await idbReq(db.transaction("blocks").objectStore("blocks").get(height));
    return row as SharedBlock | undefined;
  },
  async putBlock(height, block) {
    const db = await idbOpen();
    await idbReq(db.transaction("blocks", "readwrite").objectStore("blocks").put(block, height));
  },
  async getScripts(height) {
    const db = await idbOpen();
    const row = await idbReq(db.transaction("scripts").objectStore("scripts").get(height));
    return row as Record<string, string> | undefined;
  },
  async putScripts(height, rows) {
    const db = await idbOpen();
    await idbReq(db.transaction("scripts", "readwrite").objectStore("scripts").put(rows, height));
  },
  async scriptHeights() {
    const db = await idbOpen();
    const keys = await idbReq(db.transaction("scripts").objectStore("scripts").getAllKeys());
    return keys.filter((k): k is number => typeof k === "number");
  },
  async forgetFrom(height) {
    const db = await idbOpen();
    const tx = db.transaction(["blocks", "scripts"], "readwrite");
    tx.objectStore("blocks").delete(IDBKeyRange.lowerBound(height));
    tx.objectStore("scripts").delete(IDBKeyRange.lowerBound(height));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async pruneBelow(height) {
    const db = await idbOpen();
    const tx = db.transaction(["blocks", "scripts"], "readwrite");
    tx.objectStore("blocks").delete(IDBKeyRange.upperBound(height, true));
    tx.objectStore("scripts").delete(IDBKeyRange.upperBound(height, true));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

function cacheScript(key: string, script: string): void {
  if (scriptCache.size >= SCRIPT_CACHE_MAX) {
    // Map keeps insertion order: drop the oldest tenth in one go.
    let drop = Math.floor(SCRIPT_CACHE_MAX / 10);
    for (const k of scriptCache.keys()) {
      scriptCache.delete(k);
      if (--drop <= 0) break;
    }
  }
  scriptCache.set(key, script);
}

const scriptCache = new Map<string, string>();
const indexedHeights = new Set<number>();
const pending = new Map<number, Promise<SharedBlock>>();
/** Inputs are usually only a few blocks old. Read those blocks once instead of each parent transaction. */
const SCRIPT_LOOKBACK = 32;

function isPaymentScript(script: Uint8Array): boolean {
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return true;
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return true;
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9) return true;
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) return true;
  return false;
}

function taprootOutputs(tx: LightTx): { vout: number; value: string; xonly: string }[] {
  const out = [];
  for (let i = 0; i < tx.vout.length; i++) {
    const script = tx.vout[i]!.script;
    if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
      out.push({ vout: i, value: tx.vout[i]!.value.toString(), xonly: hex(script.subarray(2)) });
    }
  }
  return out;
}

function isCoinbase(txid: string): boolean {
  return /^0+$/.test(txid);
}

async function mapLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (!items.length) return;
  let next = 0;
  const n = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]!);
      }
    }),
  );
}

async function indexHeight(height: number, source: ChainSource): Promise<boolean> {
  if (indexedHeights.has(height)) return false;
  const existing = await backend().getScripts(height);
  if (existing) {
    for (const [key, script] of Object.entries(existing)) cacheScript(key, script);
    indexedHeights.add(height);
    return false;
  }
  const raw = await fetchRaw(source, height);
  const txs = parseBlockTransactions(raw);
  const added: Record<string, string> = {};
  if (txs) {
    for (const tx of txs) rememberOutput(tx, added);
  }
  await backend().putScripts(height, added);
  indexedHeights.add(height);
  return true;
}

/** Output scripts for recent blocks, so this block's inputs are already known. Returns blocks downloaded. */
async function ensureLookback(height: number, source: ChainSource): Promise<number> {
  const from = Math.max(1, height - SCRIPT_LOOKBACK);
  const heights: number[] = [];
  for (let h = from; h < height; h++) heights.push(h);
  let fetched = 0;
  await mapLimited(heights, 4, async (h) => {
    if (await indexHeight(h, source)) fetched++;
  });
  return fetched;
}

function rememberOutput(tx: LightTx, added: Record<string, string>): void {
  for (let i = 0; i < tx.vout.length; i++) {
    const key = `${tx.txid}:${i}`;
    const keep = scriptToKeep(tx.vout[i]!.script);
    cacheScript(key, keep);
    added[key] = keep;
  }
}

function rememberParent(parentHex: string, added: Record<string, string>): void {
  const parent = parseTxHex(parentHex);
  for (let i = 0; i < parent.vout.length; i++) {
    const key = `${parent.txid}:${i}`;
    const keep = scriptToKeep(parent.vout[i]!.scriptPubKey);
    cacheScript(key, keep);
    added[key] = keep;
  }
}

/**
 * Compact block: taproot outputs, the inputs needed to recognize a payment,
 * and transactions that spend a taproot output we have already seen.
 * Output scripts stay in a shared cache so the next block does not ask again.
 */
export async function buildSharedBlock(
  raw: Uint8Array,
  height: number,
  fetchParent: (txid: string) => Promise<string | undefined>,
  stats?: Partial<BlockStats>,
): Promise<{ block: SharedBlock; scripts: Record<string, string> }> {
  const txs = parseBlockTransactions(raw);
  if (!txs) throw new UnsupportedBlock();
  const { hash, prev } = headerHashes(raw);
  const added: Record<string, string> = {};
  const missingParents = new Set<string>();
  for (const tx of txs) {
    if (taprootOutputs(tx).length === 0) continue;
    for (const vin of tx.vin) {
      if (isCoinbase(vin.txid)) continue;
      if (!scriptCache.has(`${vin.txid}:${vin.vout}`)) missingParents.add(vin.txid);
    }
  }
  const t0 = Date.now();
  let fetched = 0;
  let notFound = 0;
  await mapLimited([...missingParents], 8, async (txid) => {
    const parent = await fetchParent(txid);
    if (parent) {
      fetched++;
      rememberParent(parent, added);
    } else notFound++;
  });
  if (stats) {
    stats.bytes = raw.length;
    stats.txs = txs.length;
    stats.parentsNeeded = missingParents.size;
    stats.parentsFetched = fetched;
    stats.parentsNotFound = notFound;
    stats.ms = { lookback: 0, raw: 0, parents: Date.now() - t0, total: 0 };
  }
  const kept: SharedTx[] = [];
  const stillMissing = new Set<string>();
  for (const tx of txs) {
    const taps = taprootOutputs(tx);
    const spendsTracked = tx.vin.some((vin) => {
      if (isCoinbase(vin.txid)) return false;
      return scriptCache.get(`${vin.txid}:${vin.vout}`)?.startsWith("5120") === true;
    });
    rememberOutput(tx, added);
    if (taps.length === 0 && !spendsTracked) continue;
    const rawVins: RawVin[] = [];
    for (const vin of tx.vin) {
      if (isCoinbase(vin.txid)) continue;
      const script = scriptCache.get(`${vin.txid}:${vin.vout}`);
      if (script === undefined) {
        // Only matters where a payment to us could be: transactions with taproot outputs.
        if (taps.length > 0) stillMissing.add(vin.txid);
        continue;
      }
      if (script === INELIGIBLE) continue;
      rawVins.push({
        txid: vin.txid,
        vout: vin.vout,
        scriptSig: hex(vin.scriptSig),
        txinwitness: vin.witness,
        prevout: { scriptPubKey: { hex: script } },
      });
    }
    const eligibleVins = taps.length > 0 ? extractEligibleVins(rawVins) : [];
    kept.push({
      txid: tx.txid,
      inputs: tx.vin.map((vin) => ({ txid: vin.txid, vout: vin.vout })),
      taps,
      eligible:
        eligibleVins?.map((vin) => ({
          txid: vin.txid,
          vout: vin.vout,
          pubkey: hex(vin.pubkey),
          taproot: vin.taproot,
        })) ?? [],
    });
  }
  if (stats) {
    stats.taprootTxs = kept.filter((t) => t.taps.length > 0).length;
    stats.eligibleTxs = kept.filter((t) => t.eligible.length > 0 && t.taps.length > 0).length;
    stats.eligibleInputs = kept.reduce((n, t) => n + (t.taps.length > 0 ? t.eligible.length : 0), 0);
    stats.incomplete = stillMissing.size;
  }
  if (stillMissing.size > 0) throw new IncompleteBlock(height, [...stillMissing]);
  return { block: { height, hash, prev, txs: kept }, scripts: added };
}

async function fetchRaw(source: ChainSource, height: number): Promise<Uint8Array> {
  const raw = source.getBlockRaw ? await source.getBlockRaw(height) : await mempoolBlockRaw(height, source.net === "bitcoin" ? MEMPOOL_BITCOIN : undefined);
  if (source.kind !== "core" && source.net !== "bitcoin") noteExplorerHeader(height, raw.subarray(0, 80));
  return raw;
}

/**
 * Item 4: public explorers strip Fractal's merge-mined and indexer proofs, so those headers cannot
 * be checked for work. A linked run of more than this many such blocks in a row is refused: in
 * 1050 recent mainnet blocks the longest run was 12, so a forged chain must still include real
 * normally mined work (at least 2^58 hashes) every 41 blocks. An own node verifies every proof.
 */
export const MAX_UNPROVEN_RUN = 40;
const explorerHeaders = new Map<number, { hash: string; prev: string; legacy: boolean }>();

export function noteExplorerHeader(height: number, header: Uint8Array): void {
  const hash = hex(sha256(sha256(header)).reverse());
  const legacy = blockKind(header, "fractal") === "legacy";
  explorerHeaders.set(height, { hash, prev: headerPrev(header), legacy });
  if (explorerHeaders.size > 4 * MAX_UNPROVEN_RUN + 64) {
    const keep = [...explorerHeaders.keys()].sort((a, b) => b - a).slice(0, 2 * MAX_UNPROVEN_RUN + 32);
    for (const k of [...explorerHeaders.keys()]) if (!keep.includes(k)) explorerHeaders.delete(k);
  }
  if (legacy) return;
  let run = 1;
  let at = explorerHeaders.get(height)!;
  for (let h = height - 1; ; h--) {
    const below = explorerHeaders.get(h);
    if (!below || below.hash !== at.prev || below.legacy) break;
    run += 1;
    at = below;
  }
  if (run > MAX_UNPROVEN_RUN) {
    explorerHeaders.delete(height);
    throw new BlockCheckError(`${run} blocks in a row without checkable work from the public explorer; use your own node`);
  }
}

export function resetExplorerHeadersForTests(): void {
  explorerHeaders.clear();
}

async function fetchParent(source: ChainSource, txid: string): Promise<string | undefined> {
  // Bitcoin must not fall through to the Fractal explorer. Its own source already knows
  // mempool.space and, when a key is set, the Bitcoin UniSat host.
  const got = source.kind === "core" || source.net === "bitcoin"
    ? await source.getTxHex(txid).catch(() => undefined)
    : await mempoolTxHex(txid, MEMPOOL_FRACTAL);
  // Audit M2 (independent): a parent transaction must hash to the txid asked for.
  if (got !== undefined) {
    let id = "";
    try {
      id = parseTxHex(got).txid.toLowerCase();
    } catch {
      return undefined;
    }
    if (id !== txid.toLowerCase()) return undefined;
  }
  return got;
}

/** Bitcoin: fill the script cache for this block's taproot transactions from block pages. */
async function prefillPrevouts(source: ChainSource, raw: Uint8Array, height: number): Promise<void> {
  if (source.net !== "bitcoin" || !source.blockPrevouts) return;
  const txs = parseBlockTransactions(raw);
  if (!txs) return;
  const indexes: number[] = [];
  txs.forEach((tx, i) => {
    if (taprootOutputs(tx).length === 0) return;
    if (tx.vin.some((v) => !isCoinbase(v.txid) && !scriptCache.has(`${v.txid}:${v.vout}`))) indexes.push(i);
  });
  if (!indexes.length) return;
  const { hash } = headerHashes(raw);
  try {
    const got = await source.blockPrevouts(height, hash, indexes);
    for (const [k, script] of Object.entries(got)) cacheScript(k, scriptToKeep(fromHex(script)));
  } catch {
    // Parents are fetched one by one instead (slow, but complete).
  }
}

/** A reorg replaced these heights: drop their saved copies and scripts. */
export async function forgetSharedFrom(height: number): Promise<void> {
  for (const h of [...indexedHeights]) if (h >= height) indexedHeights.delete(h);
  await backend().forgetFrom(height);
}

/** Keep the cache bounded: blocks far below every wallet's position are not needed again. */
export async function pruneSharedBelow(height: number): Promise<void> {
  for (const h of [...indexedHeights]) if (h < height) indexedHeights.delete(h);
  await backend().pruneBelow(height);
}

async function buildAndStore(height: number, source: ChainSource): Promise<SharedBlock> {
  const t0 = Date.now();
  const stats: Partial<BlockStats> = { height };
  try {
    // Bitcoin blocks are about 2 MB: reading earlier blocks for scripts costs more than the page lookups.
    stats.lookbackBlocks = source.net === "bitcoin" ? 0 : await ensureLookback(height, source);
    const t1 = Date.now();
    const raw = await fetchRaw(source, height);
    await prefillPrevouts(source, raw, height);
    const t2 = Date.now();
    const built = await buildSharedBlock(raw, height, (txid) => fetchParent(source, txid), stats);
    await backend().putBlock(height, built.block);
    await backend().putScripts(height, built.scripts);
    indexedHeights.add(height);
    stats.ms = { lookback: t1 - t0, raw: t2 - t1, parents: stats.ms?.parents ?? 0, total: Date.now() - t0 };
    return built.block;
  } finally {
    if (statsListener && stats.txs !== undefined) {
      stats.ms = { lookback: 0, raw: 0, parents: 0, ...stats.ms, total: Date.now() - t0 };
      statsListener(stats as BlockStats);
    }
  }
}

/** Download a block once. Later wallets read the saved copy. */
export async function loadSharedBlock(height: number, source: ChainSource): Promise<SharedBlock> {
  const saved = await backend().getBlock(height);
  if (saved && typeof saved.hash === "string") return saved;
  let job = pending.get(height);
  if (!job) {
    job = buildAndStore(height, source).finally(() => pending.delete(height));
    pending.set(height, job);
  }
  return job;
}
