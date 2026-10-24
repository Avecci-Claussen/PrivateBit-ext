import { parseBlockTransactions, type LightTx } from "./blockparse.ts";
import { hex } from "./bytes.ts";
import type { ChainSource } from "./chain.ts";
import { extractEligibleVins, type RawVin } from "./extract-inputs.ts";
import { mempoolBlockRaw, mempoolTxHex } from "./mempool.ts";
import { parseTxHex } from "./tx.ts";

/** One transaction another wallet can match without downloading the block again. */
export type SharedTx = {
  txid: string;
  inputs: { txid: string; vout: number }[];
  taps: { vout: number; value: string; xonly: string }[];
  eligible: { txid: string; vout: number; pubkey: string; taproot: boolean }[];
};

export type SharedBlock = {
  height: number;
  txs: SharedTx[];
};

export class UnsupportedBlock extends Error {
  constructor() {
    super("block layout");
    this.name = "UnsupportedBlock";
  }
}

type Backend = {
  getBlock(height: number): Promise<SharedBlock | undefined>;
  putBlock(height: number, block: SharedBlock): Promise<void>;
  getScripts(height: number): Promise<Record<string, string> | undefined>;
  putScripts(height: number, rows: Record<string, string>): Promise<void>;
  scriptHeights(): Promise<number[]>;
};

const memoryBlocks = new Map<number, SharedBlock>();
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

const DB = "privatebit-chain";

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("blocks")) db.createObjectStore("blocks");
      if (!db.objectStoreNames.contains("scripts")) db.createObjectStore("scripts");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
};

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

async function indexHeight(height: number, source: ChainSource): Promise<void> {
  if (indexedHeights.has(height)) return;
  const existing = await backend().getScripts(height);
  if (existing) {
    for (const [key, script] of Object.entries(existing)) scriptCache.set(key, script);
    indexedHeights.add(height);
    return;
  }
  const raw = await fetchRaw(source, height);
  const txs = parseBlockTransactions(raw);
  const added: Record<string, string> = {};
  if (txs) {
    for (const tx of txs) rememberOutput(tx, added);
  }
  await backend().putScripts(height, added);
  indexedHeights.add(height);
}

/** Output scripts for recent blocks, so this block's inputs are already known. */
async function ensureLookback(height: number, source: ChainSource): Promise<void> {
  const from = Math.max(1, height - SCRIPT_LOOKBACK);
  const heights: number[] = [];
  for (let h = from; h < height; h++) heights.push(h);
  await mapLimited(heights, 4, (h) => indexHeight(h, source));
}

function rememberOutput(tx: LightTx, added: Record<string, string>): void {
  for (let i = 0; i < tx.vout.length; i++) {
    const script = tx.vout[i]!.script;
    if (!isPaymentScript(script)) continue;
    const key = `${tx.txid}:${i}`;
    const hexScript = hex(script);
    scriptCache.set(key, hexScript);
    added[key] = hexScript;
  }
}

function rememberParent(parentHex: string, added: Record<string, string>): void {
  const parent = parseTxHex(parentHex);
  for (let i = 0; i < parent.vout.length; i++) {
    const script = parent.vout[i]!.scriptPubKey;
    if (!isPaymentScript(script)) continue;
    const key = `${parent.txid}:${i}`;
    const hexScript = hex(script);
    scriptCache.set(key, hexScript);
    added[key] = hexScript;
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
): Promise<{ block: SharedBlock; scripts: Record<string, string> }> {
  const txs = parseBlockTransactions(raw);
  if (!txs) throw new UnsupportedBlock();
  const added: Record<string, string> = {};
  const missingParents = new Set<string>();
  for (const tx of txs) {
    if (taprootOutputs(tx).length === 0) continue;
    for (const vin of tx.vin) {
      if (isCoinbase(vin.txid)) continue;
      if (!scriptCache.has(`${vin.txid}:${vin.vout}`)) missingParents.add(vin.txid);
    }
  }
  await mapLimited([...missingParents], 8, async (txid) => {
    const parent = await fetchParent(txid);
    if (parent) rememberParent(parent, added);
  });
  const kept: SharedTx[] = [];
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
      if (!script) continue;
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
  return { block: { height, txs: kept }, scripts: added };
}

async function fetchRaw(source: ChainSource, height: number): Promise<Uint8Array> {
  if (source.getBlockRaw) return source.getBlockRaw(height);
  return mempoolBlockRaw(height);
}

async function fetchParent(source: ChainSource, txid: string): Promise<string | undefined> {
  if (source.kind === "core") return source.getTxHex(txid);
  return mempoolTxHex(txid);
}

async function buildAndStore(height: number, source: ChainSource): Promise<SharedBlock> {
  await ensureLookback(height, source);
  const raw = await fetchRaw(source, height);
  const built = await buildSharedBlock(raw, height, (txid) => fetchParent(source, txid));
  await backend().putBlock(height, built.block);
  await backend().putScripts(height, built.scripts);
  indexedHeights.add(height);
  return built.block;
}

/** Download a block once. Later wallets read the saved copy. */
export async function loadSharedBlock(height: number, source: ChainSource): Promise<SharedBlock> {
  const saved = await backend().getBlock(height);
  if (saved) return saved;
  let job = pending.get(height);
  if (!job) {
    job = buildAndStore(height, source).finally(() => pending.delete(height));
    pending.set(height, job);
  }
  return job;
}
