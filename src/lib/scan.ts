import { detectOurUtxos, type DetectedOutput, type EligibleVin } from "./bip352.ts";
import type { SharedBlock } from "./blockshare.ts";
import type { ScanAccount } from "./keys.ts";
import { extractEligibleVins, type RawVin } from "./extract-inputs.ts";
import type { ChainSource, TxInputScript } from "./chain.ts";
import { parseTxHex, taprootOutputs, voutFromParentHex, type ParsedTx } from "./tx.ts";
import { fromHex, hex } from "./bytes.ts";
import { assertParentTxHex } from "./policy.ts";
import { RateLimitedError } from "./requests.ts";

export type LabeledUtxo = {
  txid: string;
  vout: number;
  value: string;
  scriptPubKey: string;
  tweak: string;
  label: number | null;
  k: number;
  height: number;
  spent: boolean;
  /**
   * "bip86" for a migration one-time address coin (m/86'/8228'/0'/0/index). "site" for a coin of a
   * connected website's own account (sites.ts), never part of the private balance. Absent means Silent Payment.
   */
  kind?: CoinKind;
  index?: number;
  /** Txid that spent this coin, when the scan saw it. Used to rebuild activity history. */
  spentBy?: string;
  spentHeight?: number;
};

export type ScanInflight = {
  height: number;
  nextTx: number;
  txids: string[];
  /** Set when the block is the shared copy, so the txid list does not have to be stored. */
  txCount?: number;
};

/** One-shot P2TR we created for a BIP77 session (not an sp1). */
export type WatchedOutput = {
  scriptPubKey: string;
  tweak: string;
  label: number | null;
  k: number;
  kind?: CoinKind;
  index?: number;
};

export type CoinKind = "sp" | "bip86" | "site";

/** The private wallet's view: a website's account coins are kept out of every balance, list and plan. */
export function privateUtxos<T extends { kind?: CoinKind }>(utxos: T[]): T[] {
  return utxos.filter((u) => u.kind !== "site");
}

export type ScanStore = {
  utxos: LabeledUtxo[];
  lastHeight: number;
  /** Last chain tip we asked the source for. Used to keep following new blocks. */
  tip?: number;
  inflight?: ScanInflight;
  watch?: WatchedOutput[];
  /** Tx hex fetches that failed often enough to stop blocking the block. Retried later. */
  deferred?: ScanHole[];
  /** Write counter kept by CoinStore. A change prepared from an older rev is refused. */
  rev?: number;
  /** Hashes of the last matched blocks, newest last, to notice a reorg. */
  recent?: [number, string][];
};

export type ScanProgress = {
  done: boolean;
  lastHeight: number;
  tip: number;
  height: number;
  txIndex: number;
  txCount: number;
  skipped: number;
};

/** Txs applied per height before we persist. Hex and input lists are fetched together. */
export const SCAN_TX_BATCH = 48;
/** In-flight block transactions. Each one may use two requests (raw tx and its inputs). */
export const SCAN_FETCH_CONCURRENCY = 8;
/** Work between yields. The service worker continues immediately after this; it does not wait on an alarm. */
export const SCAN_BUDGET_MS = 12_000;
/** A missing tx hex is retried, then the block moves on and the tx is tried again later. */
export const SCAN_HEX_TRIES = 3;

export type ScanHole = { txid: string; height: number; tries: number };

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (!items.length) return out;
  let next = 0;
  const n = Math.min(Math.max(1, limit), items.length);
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

/** Reuse raw tx hex within one catch-up so parent prevouts are not refetched. */
export function withTxHexCache(source: ChainSource, max = 512): ChainSource {
  const cache = new Map<string, string>();
  const inflight = new Map<string, Promise<string>>();
  return {
    kind: source.kind,
    net: source.net,
    blockPrevouts: source.blockPrevouts,
    getTip: () => source.getTip(),
    getBlockHash: (h) => source.getBlockHash(h),
    getBlockTxids: (h) => source.getBlockTxids(h),
    // Passed through so an own node's raw blocks are used (without it, blocks came from the public explorer).
    getBlockRaw: source.getBlockRaw ? (h) => source.getBlockRaw!(h) : undefined,
    broadcast: (hexTx) => source.broadcast(hexTx),
    estimateFeeSatPerVb: () => source.estimateFeeSatPerVb(),
    feeRates: source.feeRates ? () => source.feeRates!() : undefined,
    getTxHeight: source.getTxHeight ? (txid) => source.getTxHeight!(txid) : undefined,
    listInputScripts: source.listInputScripts ? (txid) => source.listInputScripts!(txid) : undefined,
    async getTxHex(txid) {
      const hit = cache.get(txid);
      if (hit) return hit;
      let pending = inflight.get(txid);
      if (!pending) {
        pending = source.getTxHex(txid).then(
          (h) => {
            inflight.delete(txid);
            cache.set(txid, h);
            if (cache.size > max) {
              const oldest = cache.keys().next().value;
              if (oldest) cache.delete(oldest);
            }
            return h;
          },
          (e) => {
            inflight.delete(txid);
            throw e;
          },
        );
        inflight.set(txid, pending);
      }
      return pending;
    },
  };
}

export function emptyScanStore(birthday: number): ScanStore {
  return { utxos: [], lastHeight: Math.max(0, birthday - 1) };
}

export function isCoinbaseTxid(txid: string): boolean {
  return /^0+$/i.test(txid);
}

function toRawVin(
  vin: { txid: string; vout: number; scriptSig: string; witness: string[] },
  prev: { scriptPubKey: Uint8Array },
): RawVin {
  return {
    txid: vin.txid,
    vout: vin.vout,
    scriptSig: vin.scriptSig,
    txinwitness: vin.witness,
    prevout: { scriptPubKey: { hex: hex(prev.scriptPubKey) } },
  };
}

export async function scanTransaction(
  account: ScanAccount,
  source: ChainSource,
  txHex: string,
  _height: number,
  inputs?: TxInputScript[],
): Promise<(DetectedOutput & { txid: string; value: bigint })[]> {
  const tx = parseTxHex(txHex);
  const taps = taprootOutputs(tx);
  if (taps.length === 0) return [];

  const tapsIn = taps.map((t) => ({ xonly: t.xonly, vout: t.vout }));
  const raw = inputs
    ? vinsFromListed(tx, inputs)
    : source.listInputScripts
      ? await rawVinsFromInputList(tx, source)
      : await rawVinsFromParents(tx, source);
  if (raw.length === 0) return [];
  const eligible = extractEligibleVins(raw);
  if (!eligible || eligible.length === 0) return [];

  const found = detectOurUtxos({
    vins: eligible,
    taprootOutputs: tapsIn,
    scanSecret: account.scanSecret,
    spendPub: account.spendPub,
    labels: account.labels,
    outpoints: tx.vin.map((v) => ({ txid: v.txid, vout: v.vout })),
  });
  const hits = found.map((f) => {
    const t = taps.find((x) => x.vout === f.vout)!;
    return { ...f, txid: tx.txid, value: t.value };
  });
  return hits;
}

/** Every input must be listed. Matching with an input missing could miss a payment. */
function vinsFromListed(tx: ParsedTx, listed: TxInputScript[]): RawVin[] {
  const byOutpoint = new Map(listed.map((row) => [`${row.txid}:${row.vout}`, row.scriptPubKey]));
  const raw: RawVin[] = [];
  for (const vin of tx.vin) {
    if (isCoinbaseTxid(vin.txid)) continue;
    const script = byOutpoint.get(`${vin.txid}:${vin.vout}`);
    if (!script) throw new Error(`input ${vin.txid}:${vin.vout} of ${tx.txid} not listed`);
    raw.push(toRawVin(vin, { scriptPubKey: fromHex(script) }));
  }
  return raw;
}

/** Indexed input page: one request per 500 inputs, instead of one raw parent tx each. */
async function rawVinsFromInputList(tx: ParsedTx, source: ChainSource): Promise<RawVin[]> {
  return vinsFromListed(tx, await source.listInputScripts!(tx.txid));
}

async function rawVinsFromParents(
  tx: ParsedTx,
  source: ChainSource,
): Promise<RawVin[]> {
  const parentIds = [...new Set(tx.vin.map((v) => v.txid).filter((id) => !isCoinbaseTxid(id)))];
  const parents = new Map<string, string>();
  await mapLimited(parentIds, SCAN_FETCH_CONCURRENCY, async (id) => {
    parents.set(id, assertParentTxHex(await source.getTxHex(id), id));
  });
  const raw: RawVin[] = [];
  for (const vin of tx.vin) {
    if (isCoinbaseTxid(vin.txid)) continue;
    const parentHex = parents.get(vin.txid);
    if (!parentHex) throw new Error(`parent ${vin.txid} missing`);
    const prev = voutFromParentHex(parentHex, vin.vout);
    raw.push(toRawVin(vin, prev));
  }
  return raw;
}

function cloneStore(store: ScanStore): ScanStore {
  return {
    utxos: store.utxos.map((u) => ({ ...u })),
    lastHeight: store.lastHeight,
    tip: store.tip,
    inflight: store.inflight
      ? {
          height: store.inflight.height,
          nextTx: store.inflight.nextTx,
          txids: store.inflight.txids.slice(),
          ...(store.inflight.txCount !== undefined ? { txCount: store.inflight.txCount } : {}),
        }
      : undefined,
    watch: store.watch?.map((w) => ({ ...w })),
    deferred: store.deferred?.map((d) => ({ ...d })),
    ...(store.rev !== undefined ? { rev: store.rev } : {}),
    ...(store.recent ? { recent: store.recent.map((r) => [r[0], r[1]] as [number, string]) } : {}),
  };
}

function bumpHole(store: ScanStore, txid: string, height: number): number {
  const prev = store.deferred?.find((d) => d.txid === txid);
  const tries = (prev?.tries ?? 0) + 1;
  const rest = (store.deferred ?? []).filter((d) => d.txid !== txid);
  store.deferred = [...rest, { txid, height, tries }];
  return tries;
}

function clearHole(store: ScanStore, txid: string): void {
  if (!store.deferred?.some((d) => d.txid === txid)) return;
  const rest = store.deferred.filter((d) => d.txid !== txid);
  store.deferred = rest.length ? rest : undefined;
}

/**
 * Confirmed watched coins the indexer no longer lists are spent.
 * An empty or failed lookup does not do this: the caller only passes a successful hint list.
 */
export function markAbsentWatchSpent(store: ScanStore, scriptPubKey: string, liveTxids: ReadonlySet<string>): ScanStore {
  let changed = false;
  const utxos = store.utxos.map((u) => {
    if (u.spent || u.scriptPubKey !== scriptPubKey || u.height <= 0) return u;
    if (liveTxids.has(u.txid)) return u;
    changed = true;
    return { ...u, spent: true };
  });
  return changed ? { ...store, utxos } : store;
}

/** Retry txids we stepped past. Does not block the sequential scan. */
export async function retryDeferred(
  account: ScanAccount,
  source: ChainSource,
  store: ScanStore,
  limit = 8,
): Promise<ScanStore> {
  const waiting = (store.deferred ?? []).filter((h) => h.tries < SCAN_HEX_TRIES);
  const due = (store.deferred ?? []).filter((h) => h.tries >= SCAN_HEX_TRIES);
  if (!due.length) return store;
  let next = store;
  const keep: ScanHole[] = [];
  const now = due.slice(0, limit);
  for (const h of now) {
    try {
      const hexTx = await source.getTxHex(h.txid);
      next = await applyTxHex(account, source, next, hexTx, h.height);
    } catch {
      keep.push(h);
    }
  }
  keep.push(...due.slice(limit));
  const deferred = [...waiting, ...keep];
  return { ...next, deferred: deferred.length ? deferred : undefined };
}

export function addWatch(store: ScanStore, w: WatchedOutput): ScanStore {
  const next = cloneStore(store);
  const list = next.watch ?? [];
  if (!list.some((x) => x.scriptPubKey === w.scriptPubKey)) list.push(w);
  next.watch = list;
  return next;
}

/** Credit a watched output from the address index, before the raw transaction is fetched. */
export function noteWatchedOutput(
  store: ScanStore,
  hit: { txid: string; vout: number; value: string; scriptPubKey: string; height: number },
): ScanStore {
  const w = store.watch?.find((x) => x.scriptPubKey.toLowerCase() === hit.scriptPubKey.toLowerCase());
  if (!w) return store;
  const next = cloneStore(store);
  const prev = next.utxos.find((u) => u.txid === hit.txid && u.vout === hit.vout);
  upsertUtxo(next.utxos, {
    txid: hit.txid,
    vout: hit.vout,
    value: hit.value,
    scriptPubKey: w.scriptPubKey,
    tweak: w.tweak,
    label: w.label,
    k: w.k,
    height: hit.height,
    spent: false,
    ...(w.kind === "bip86" || w.kind === "site" ? { kind: w.kind, index: w.index } : {}),
  });
  // A sweep used to mark every coin at this address spent, including one the indexer still lists.
  // A real spend names the transaction that spent it. An unnamed spend is that mistake, so take the coin back.
  if (prev?.spent && !prev.spentBy) {
    const i = next.utxos.findIndex((u) => u.txid === hit.txid && u.vout === hit.vout);
    if (i >= 0) next.utxos[i] = { ...next.utxos[i]!, spent: false };
  }
  return next;
}

function applyWatch(store: ScanStore, txHex: string, height: number): void {
  if (!store.watch?.length) return;
  const parsed = parseTxHex(txHex);
  const taps = taprootOutputs(parsed);
  for (const t of taps) {
    const spk = hex(Uint8Array.from([0x51, 0x20, ...t.xonly]));
    const w = store.watch.find((x) => x.scriptPubKey === spk);
    if (!w) continue;
    upsertUtxo(store.utxos, {
      txid: parsed.txid,
      vout: t.vout,
      value: t.value.toString(),
      scriptPubKey: spk,
      tweak: w.tweak,
      label: w.label,
      k: w.k,
      height,
      spent: false,
      ...(w.kind === "bip86" || w.kind === "site" ? { kind: w.kind, index: w.index } : {}),
    });
  }
}

export function upsertUtxo(utxos: LabeledUtxo[], u: LabeledUtxo): void {
  const i = utxos.findIndex((x) => x.txid === u.txid && x.vout === u.vout);
  if (i < 0) {
    utxos.push(u);
    return;
  }
  const prev = utxos[i];
  utxos[i] = {
    ...prev,
    ...u,
    spent: prev.spent || u.spent,
    height: u.height > 0 ? u.height : prev.height,
  };
}

export function markSpent(utxos: LabeledUtxo[], tx: ReturnType<typeof parseTxHex>, height = 0): void {
  for (const vin of tx.vin) {
    const u = utxos.find((x) => x.txid === vin.txid && x.vout === vin.vout && !x.spent);
    if (u) {
      u.spent = true;
      u.spentBy = tx.txid;
      u.spentHeight = height;
    } else {
      const seen = utxos.find((x) => x.txid === vin.txid && x.vout === vin.vout && x.spentBy === tx.txid);
      if (seen && height > 0) seen.spentHeight = height;
    }
  }
}

function hitToUtxo(
  hit: Awaited<ReturnType<typeof scanTransaction>>[number],
  height: number,
): LabeledUtxo {
  return {
    txid: hit.txid,
    vout: hit.vout,
    value: hit.value.toString(),
    scriptPubKey: hex(Uint8Array.from([0x51, 0x20, ...hit.xonly])),
    tweak: hex(hit.tweak),
    label: hit.label,
    k: hit.k,
    height,
    spent: false,
  };
}

function ingestSeenTx(store: ScanStore, txHex: string, height: number): void {
  const parsed = parseTxHex(txHex);
  markSpent(store.utxos, parsed, height);
  applyWatch(store, txHex, height);
  if (height > 0) {
    for (const u of store.utxos) {
      if (u.txid === parsed.txid) u.height = height;
      if (u.spentBy === parsed.txid) u.spentHeight = height;
    }
  }
}

/**
 * Pull known watched scripts into the store from raw txs (one-time addresses, Payjoin outputs).
 * Does not replace Silent Payment sequential scan: hints are only candidate txids.
 */
export async function recoverWatchedFromHints(
  account: ScanAccount,
  source: ChainSource,
  store: ScanStore,
  hints: { txid: string; height: number }[],
): Promise<ScanStore> {
  let next = store;
  const seen = new Set<string>();
  for (const h of hints) {
    if (seen.has(h.txid)) continue;
    seen.add(h.txid);
    try {
      const hexTx = await source.getTxHex(h.txid);
      const height = h.height > 0 ? h.height : (source.getTxHeight ? ((await source.getTxHeight(h.txid)) ?? 0) : 0);
      next = await applyTxHex(account, source, next, hexTx, height);
    } catch {
      /* sequential scan still has to cover this */
    }
  }
  return next;
}

/**
 * Payjoin change. As a Payjoin sender, our change output is a Silent Payment to our own change
 * code, made from our inputs only (the original). The receiver then adds an input, so a scan
 * over all inputs of the final transaction no longer finds it. For a transaction that spends our
 * coins next to someone else's, also match with our spent coins alone. Runs only for transactions
 * that spend our coins, needs no network, and uses the same BIP352 matching as every other coin.
 */
export function detectOwnInputChange(
  account: ScanAccount,
  store: ScanStore,
  txid: string,
  inputs: { txid: string; vout: number }[],
  taps: { xonly: Uint8Array; vout: number; value: bigint }[],
): (DetectedOutput & { txid: string; value: bigint })[] {
  if (taps.length === 0) return [];
  const real = inputs.filter((v) => !isCoinbaseTxid(v.txid));
  const vins: EligibleVin[] = [];
  for (const v of real) {
    const u = store.utxos.find((x) => x.txid === v.txid && x.vout === v.vout && x.spentBy === txid);
    if (!u) continue;
    const spk = fromHex(u.scriptPubKey);
    if (spk.length !== 34 || spk[0] !== 0x51 || spk[1] !== 0x20) return [];
    vins.push({ txid: v.txid, vout: v.vout, pubkey: Uint8Array.from([0x02, ...spk.slice(2)]), taproot: true });
  }
  // None of ours, or all of them ours: the normal full-input match already covers it.
  if (vins.length === 0 || vins.length === real.length) return [];
  const found = detectOurUtxos({
    vins,
    taprootOutputs: taps.map((t) => ({ xonly: t.xonly, vout: t.vout })),
    scanSecret: account.scanSecret,
    spendPub: account.spendPub,
    labels: account.labels,
    outpoints: vins.map((v) => ({ txid: v.txid, vout: v.vout })),
  });
  return found.map((f) => ({ ...f, txid, value: taps.find((t) => t.vout === f.vout)!.value }));
}

function applyOwnInputChange(account: ScanAccount, store: ScanStore, txHex: string, height: number): void {
  const tx = parseTxHex(txHex);
  for (const hit of detectOwnInputChange(account, store, tx.txid, tx.vin, taprootOutputs(tx))) {
    upsertUtxo(store.utxos, hitToUtxo(hit, height));
  }
}

/** Apply a tx we already have (broadcast or mempool) without waiting for its block. */
export async function applyTxHex(
  account: ScanAccount,
  source: ChainSource,
  store: ScanStore,
  txHex: string,
  height = 0,
): Promise<ScanStore> {
  const next = cloneStore(store);
  ingestSeenTx(next, txHex, height);
  applyOwnInputChange(account, next, txHex, height);
  try {
    const hits = await scanTransaction(account, source, txHex, height);
    for (const hit of hits) upsertUtxo(next.utxos, hitToUtxo(hit, height));
  } catch {
    /* still persist spends and watched Payjoin outputs */
  }
  return next;
}

/** Match one slice of a saved block to this wallet. No network. */
export function applySharedSlice(
  account: ScanAccount,
  store: ScanStore,
  block: SharedBlock,
  from: number,
  tip: number,
  limit = 80,
): { store: ScanStore; progress: ScanProgress } {
  if (from === 0) assertExtends(store, block.height, block.prev);
  const next = cloneStore(store);
  next.tip = tip;
  const end = Math.min(block.txs.length, from + limit);
  for (let i = from; i < end; i++) {
    const tx = block.txs[i]!;
    markSpent(
      next.utxos,
      {
        txid: tx.txid,
        hex: "",
        vin: tx.inputs.map((vin) => ({ txid: vin.txid, vout: vin.vout, scriptSig: "", witness: [] })),
        vout: [],
      },
      block.height,
    );
    for (const hit of detectOwnInputChange(
      account,
      next,
      tx.txid,
      tx.inputs,
      tx.taps.map((tap) => ({ xonly: fromHex(tap.xonly), vout: tap.vout, value: BigInt(tap.value) })),
    )) {
      upsertUtxo(next.utxos, hitToUtxo(hit, block.height));
    }
    for (const tap of tx.taps) {
      const spk = "5120" + tap.xonly.toLowerCase();
      const w = next.watch?.find((item) => item.scriptPubKey.toLowerCase() === spk);
      if (!w) continue;
      upsertUtxo(next.utxos, {
        txid: tx.txid,
        vout: tap.vout,
        value: tap.value,
        scriptPubKey: w.scriptPubKey,
        tweak: w.tweak,
        label: w.label,
        k: w.k,
        height: block.height,
        spent: false,
        ...(w.kind === "bip86" || w.kind === "site" ? { kind: w.kind, index: w.index } : {}),
      });
    }
    if (tx.eligible.length > 0 && tx.taps.length > 0) {
      const found = detectOurUtxos({
        vins: tx.eligible.map((vin) => ({
          txid: vin.txid,
          vout: vin.vout,
          pubkey: fromHex(vin.pubkey),
          taproot: vin.taproot,
        })),
        taprootOutputs: tx.taps.map((tap) => ({ xonly: fromHex(tap.xonly), vout: tap.vout })),
        scanSecret: account.scanSecret,
        spendPub: account.spendPub,
        labels: account.labels,
        outpoints: tx.inputs,
      });
      for (const hit of found) {
        const tap = tx.taps.find((item) => item.vout === hit.vout);
        if (!tap) continue;
        upsertUtxo(next.utxos, hitToUtxo({ ...hit, txid: tx.txid, value: BigInt(tap.value) }, block.height));
      }
    }
    if (block.height > 0) {
      for (const u of next.utxos) {
        if (u.txid === tx.txid) u.height = block.height;
        if (u.spentBy === tx.txid) u.spentHeight = block.height;
      }
    }
  }
  const blockDone = end >= block.txs.length;
  if (blockDone) {
    next.lastHeight = block.height;
    next.inflight = undefined;
    noteBlockHash(next, block.height, block.hash);
  } else {
    next.inflight = { height: block.height, nextTx: end, txids: [], txCount: block.txs.length };
  }
  return {
    store: next,
    progress: {
      done: next.lastHeight >= tip && !next.inflight,
      lastHeight: next.lastHeight,
      tip,
      height: block.height,
      txIndex: end,
      txCount: block.txs.length,
      skipped: 0,
    },
  };
}

/** One batch so a Chrome MV3 worker can persist before it is killed. */
export async function scanStep(
  account: ScanAccount,
  source: ChainSource,
  store: ScanStore,
  tip: number,
  batch = SCAN_TX_BATCH,
): Promise<{ store: ScanStore; progress: ScanProgress }> {
  const next = cloneStore(store);
  next.tip = tip;
  if (next.lastHeight >= tip && !next.inflight) {
    return {
      store: next,
      progress: {
        done: true,
        lastHeight: next.lastHeight,
        tip,
        height: next.lastHeight,
        txIndex: 0,
        txCount: 0,
        skipped: 0,
      },
    };
  }

  const height = next.inflight?.height ?? next.lastHeight + 1;
  if (height > tip) {
    return {
      store: next,
      progress: {
        done: true,
        lastHeight: next.lastHeight,
        tip,
        height: next.lastHeight,
        txIndex: 0,
        txCount: 0,
        skipped: 0,
      },
    };
  }

  if (!next.inflight || next.inflight.height !== height) {
    // A failure here is thrown, not reported as "no progress": the caller backs off instead of
    // asking again at once (that was a retry storm against a rate-limited service).
    next.inflight = { height, nextTx: 0, txids: await source.getBlockTxids(height) };
  }

  const { txids } = next.inflight;
  const start = next.inflight.nextTx;
  const end = Math.min(txids.length, start + batch);
  let skipped = 0;
  const slice = txids.slice(start, end);
  const fetched = await mapLimited(slice, SCAN_FETCH_CONCURRENCY, async (txid) => {
    const hexP = source.getTxHex(txid);
    const insP = source.listInputScripts ? source.listInputScripts(txid) : undefined;
    const [hexR, insR] = await Promise.allSettled(insP ? [hexP, insP] : [hexP]);
    const hexRejected = hexR.status === "rejected" ? hexR.reason : undefined;
    const insRejected = insR && insR.status === "rejected" ? insR.reason : undefined;
    if (hexRejected instanceof RateLimitedError || insRejected instanceof RateLimitedError) {
      throw hexRejected instanceof RateLimitedError ? hexRejected : insRejected;
    }
    return {
      hex: hexR.status === "fulfilled" ? hexR.value : undefined,
      inputs: insR && insR.status === "fulfilled" ? insR.value : undefined,
    };
  });
  const hold = (i: number, whySkipped: number): { store: ScanStore; progress: ScanProgress } => {
    next.inflight!.nextTx = start + i;
    return {
      store: next,
      progress: {
        done: false,
        lastHeight: next.lastHeight,
        tip,
        height,
        txIndex: start + i,
        txCount: txids.length,
        skipped: whySkipped,
      },
    };
  };
  let cursor = start;
  for (let i = 0; i < fetched.length; i++) {
    const txid = slice[i]!;
    const hexTx = fetched[i]?.hex;
    const inputs = fetched[i]?.inputs;
    if (!hexTx) {
      const tries = bumpHole(next, txid, height);
      if (tries < SCAN_HEX_TRIES) return hold(i, fetched.length - i);
      skipped += 1;
      cursor = start + i + 1;
      continue;
    }
    try {
      ingestSeenTx(next, hexTx, height);
    } catch {
      const tries = bumpHole(next, txid, height);
      if (tries < SCAN_HEX_TRIES) return hold(i, fetched.length - i);
      skipped += 1;
      cursor = start + i + 1;
      continue;
    }
    clearHole(next, txid);
    applyOwnInputChange(account, next, hexTx, height);
    try {
      const hits = await scanTransaction(account, source, hexTx, height, inputs);
      for (const hit of hits) upsertUtxo(next.utxos, hitToUtxo(hit, height));
    } catch (e) {
      if (e instanceof RateLimitedError) throw e;
      // Input data incomplete: hold here and retry; after a few tries it waits in deferred.
      const tries = bumpHole(next, txid, height);
      if (tries < SCAN_HEX_TRIES) return hold(i, fetched.length - i);
      skipped += 1;
      cursor = start + i + 1;
      continue;
    }
    cursor = start + i + 1;
    if ((i & 7) === 7) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  next.inflight.nextTx = cursor;
  if (next.inflight.nextTx >= txids.length) {
    next.lastHeight = height;
    next.inflight = undefined;
  }

  return {
    store: next,
    progress: {
      done: next.lastHeight >= tip && !next.inflight,
      lastHeight: next.lastHeight,
      tip,
      height,
      txIndex: end,
      txCount: txids.length,
      skipped,
    },
  };
}

export async function scanRange(
  account: ScanAccount,
  source: ChainSource,
  store: ScanStore,
  toHeight: number,
  onProgress?: (h: number, tip: number) => void,
): Promise<ScanStore> {
  let next = cloneStore(store);
  for (;;) {
    const step = await scanStep(account, source, next, toHeight, SCAN_TX_BATCH);
    next = step.store;
    onProgress?.(step.progress.height, toHeight);
    if (step.progress.done) return next;
  }
}

export function spendableBalance(store: ScanStore): bigint {
  return store.utxos.filter((u) => !u.spent).reduce((a, u) => a + BigInt(u.value), 0n);
}

export function confirmedBalance(store: ScanStore): bigint {
  return store.utxos.filter((u) => !u.spent && u.height > 0).reduce((a, u) => a + BigInt(u.value), 0n);
}

export function pendingBalance(store: ScanStore): bigint {
  return store.utxos.filter((u) => !u.spent && u.height === 0).reduce((a, u) => a + BigInt(u.value), 0n);
}

export type OwnedOutput = {
  vout: number;
  value: string;
  scriptPubKey: string;
  tweak: string;
  label: number | null;
  k: number;
  kind?: CoinKind;
  index?: number;
};

/** Debit spent inputs and credit our change/self-pay from the tx we just built. */
export function applyBuiltSend(store: ScanStore, txHex: string, ours: OwnedOutput[]): ScanStore {
  const next = cloneStore(store);
  const parsed = parseTxHex(txHex);
  markSpent(next.utxos, parsed);
  for (const o of ours) {
    upsertUtxo(next.utxos, {
      txid: parsed.txid,
      vout: o.vout,
      value: o.value,
      scriptPubKey: o.scriptPubKey,
      tweak: o.tweak,
      label: o.label,
      k: o.k,
      height: 0,
      spent: false,
      ...(o.kind === "site" ? { kind: "site" as const, index: o.index } : {}),
    });
  }
  return next;
}

/** How many recent block hashes are kept for reorg detection. */
export const RECENT_HASHES = 12;

/** The chain changed under blocks we already matched. */
export class ReorgError extends Error {
  constructor(readonly height: number) {
    super(`reorg below block ${height}`);
    this.name = "ReorgError";
  }
}

export function noteBlockHash(store: ScanStore, height: number, hash: string | undefined): void {
  if (!hash) return;
  const recent = (store.recent ?? []).filter((r) => r[0] < height);
  recent.push([height, hash.toLowerCase()]);
  store.recent = recent.slice(-RECENT_HASHES);
}

/** Block at height must sit on the block we matched at height - 1. */
export function assertExtends(store: ScanStore, height: number, prev: string | undefined): void {
  if (!prev) return;
  const last = store.recent?.[store.recent.length - 1];
  if (last && last[0] === height - 1 && last[1] !== prev.toLowerCase()) throw new ReorgError(height);
}

/**
 * Undo everything learned from blocks at fork and above: coins found there are dropped
 * (they come back if the new chain has them), spends seen there become unconfirmed.
 */
export function rollbackTo(store: ScanStore, fork: number): ScanStore {
  const next = cloneStore(store);
  next.utxos = next.utxos
    .filter((u) => !(u.height >= fork))
    .map((u) => (u.spentHeight !== undefined && u.spentHeight >= fork ? { ...u, spentHeight: 0 } : u));
  next.lastHeight = Math.min(next.lastHeight, fork - 1);
  next.inflight = undefined;
  next.recent = (next.recent ?? []).filter((r) => r[0] < fork);
  next.deferred = next.deferred?.filter((d) => d.height < fork);
  return next;
}

/**
 * Keep the watch list bounded. One-time address watches always stay (they are few and an
 * address can be paid again). Others stay while a coin sits there or the caller still needs
 * them (an open or recent payment link); the rest are dropped.
 */
export function pruneWatches(store: ScanStore, keep: ReadonlySet<string>, max = 400): ScanStore {
  const live = new Set(store.utxos.filter((u) => !u.spent).map((u) => u.scriptPubKey.toLowerCase()));
  const watch = (store.watch ?? []).filter((w) => {
    const spk = w.scriptPubKey.toLowerCase();
    return w.kind === "bip86" || w.kind === "site" || live.has(spk) || keep.has(spk);
  });
  const bounded = watch.length > max ? [...watch.filter((w) => w.kind === "bip86" || w.kind === "site"), ...watch.filter((w) => w.kind !== "bip86" && w.kind !== "site").slice(-max)] : watch;
  if (bounded.length === (store.watch ?? []).length) return store;
  return { ...store, watch: bounded };
}
