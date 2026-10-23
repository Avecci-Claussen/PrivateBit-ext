import { detectOurUtxos, type DetectedOutput } from "./bip352.ts";
import type { Account } from "./keys.ts";
import { extractEligibleVins, type RawVin } from "./extract-inputs.ts";
import type { ChainSource } from "./chain.ts";
import { parseTxHex, taprootOutputs, voutFromParentHex } from "./tx.ts";
import { hex } from "./bytes.ts";
import { assertParentTxHex } from "./policy.ts";

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
};

export type ScanInflight = {
  height: number;
  nextTx: number;
  txids: string[];
};

/** One-shot P2TR we created for a BIP77 session (not an sp1). */
export type WatchedOutput = {
  scriptPubKey: string;
  tweak: string;
  label: number | null;
  k: number;
};

export type ScanStore = {
  utxos: LabeledUtxo[];
  lastHeight: number;
  /** Last chain tip we asked the source for. Used to keep following new blocks. */
  tip?: number;
  inflight?: ScanInflight;
  watch?: WatchedOutput[];
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

export const SCAN_TX_BATCH = 8;

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
  account: Account,
  source: ChainSource,
  txHex: string,
  _height: number,
): Promise<DetectedOutput & { txid: string; value: bigint }[]> {
  const tx = parseTxHex(txHex);
  const taps = taprootOutputs(tx);
  if (taps.length === 0) return [];

  const raw: RawVin[] = [];
  for (const vin of tx.vin) {
    if (isCoinbaseTxid(vin.txid)) continue;
    const parentHex = assertParentTxHex(await source.getTxHex(vin.txid), vin.txid);
    const prev = voutFromParentHex(parentHex, vin.vout);
    raw.push(toRawVin(vin, prev));
  }
  if (raw.length === 0) return [];
  const eligible = extractEligibleVins(raw);
  if (!eligible || eligible.length === 0) return [];

  const tapsIn = taps.map((t) => ({ xonly: t.xonly, vout: t.vout }));
  let found = detectOurUtxos({
    vins: eligible,
    taprootOutputs: tapsIn,
    scanSecret: account.scanSecret,
    spendPub: account.spendPub,
    labels: account.labels,
    outpoints: tx.vin.map((v) => ({ txid: v.txid, vout: v.vout })),
  });
  if (found.length === 0 && eligible.length > 1) {
    for (let drop = 0; drop < eligible.length; drop++) {
      const subset = eligible.filter((_, i) => i !== drop);
      found = detectOurUtxos({
        vins: subset,
        taprootOutputs: tapsIn,
        scanSecret: account.scanSecret,
        spendPub: account.spendPub,
        labels: account.labels,
        outpoints: tx.vin.map((v) => ({ txid: v.txid, vout: v.vout })),
      });
      if (found.length) break;
    }
  }
  const hits = found.map((f) => {
    const t = taps.find((x) => x.vout === f.vout)!;
    return { ...f, txid: tx.txid, value: t.value };
  });
  return hits;
}

function cloneStore(store: ScanStore): ScanStore {
  return {
    utxos: store.utxos.map((u) => ({ ...u })),
    lastHeight: store.lastHeight,
    tip: store.tip,
    inflight: store.inflight
      ? { height: store.inflight.height, nextTx: store.inflight.nextTx, txids: store.inflight.txids.slice() }
      : undefined,
    watch: store.watch?.map((w) => ({ ...w })),
  };
}

export function addWatch(store: ScanStore, w: WatchedOutput): ScanStore {
  const next = cloneStore(store);
  const list = next.watch ?? [];
  if (!list.some((x) => x.scriptPubKey === w.scriptPubKey)) list.push(w);
  next.watch = list;
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

export function markSpent(utxos: LabeledUtxo[], tx: ReturnType<typeof parseTxHex>): void {
  for (const vin of tx.vin) {
    const u = utxos.find((x) => x.txid === vin.txid && x.vout === vin.vout && !x.spent);
    if (u) u.spent = true;
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

/** Apply a tx we already have (broadcast or mempool) without waiting for its block. */
export async function applyTxHex(
  account: Account,
  source: ChainSource,
  store: ScanStore,
  txHex: string,
  height = 0,
): Promise<ScanStore> {
  const next = cloneStore(store);
  const parsed = parseTxHex(txHex);
  markSpent(next.utxos, parsed);
  applyWatch(next, txHex, height);
  try {
    const hits = await scanTransaction(account, source, txHex, height);
    for (const hit of hits) upsertUtxo(next.utxos, hitToUtxo(hit, height));
  } catch {
    /* still persist spends and watched Payjoin outputs */
  }
  return next;
}

/** One batch so a Chrome MV3 worker can persist before it is killed. */
export async function scanStep(
  account: Account,
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
    try {
      next.inflight = { height, nextTx: 0, txids: await source.getBlockTxids(height) };
    } catch {
      return {
        store: next,
        progress: {
          done: false,
          lastHeight: next.lastHeight,
          tip,
          height,
          txIndex: 0,
          txCount: 0,
          skipped: 0,
        },
      };
    }
  }

  const { txids } = next.inflight;
  const start = next.inflight.nextTx;
  const end = Math.min(txids.length, start + batch);
  let skipped = 0;
  for (let i = start; i < end; i++) {
    try {
      const hexTx = await source.getTxHex(txids[i]);
      const hits = await scanTransaction(account, source, hexTx, height);
      for (const hit of hits) upsertUtxo(next.utxos, hitToUtxo(hit, height));
      applyWatch(next, hexTx, height);
      markSpent(next.utxos, parseTxHex(hexTx));
    } catch {
      skipped += 1;
    }
  }
  next.inflight.nextTx = end;
  if (end >= txids.length) {
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
  account: Account,
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
    });
  }
  return next;
}
