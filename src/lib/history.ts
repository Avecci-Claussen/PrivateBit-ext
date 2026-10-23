import type { CoinMetaMap } from "./coinmeta.ts";
import type { LabeledUtxo, ScanStore } from "./scan.ts";

/**
 * Activity history (DATA.md section 4). Stored encrypted in privatebit.history,
 * chrome.storage.local only. Everything except typed labels and destinations can be
 * rebuilt from the local scan store, which is what deriveHistory does.
 */
export type HistoryKind = "received" | "sent" | "payjoin-received" | "payjoin-sent" | "moved-in" | "self";
export type HistoryStatus = "incoming" | "pending" | "confirmed" | "failed" | "cancelled";

export type HistoryEntry = {
  txid: string;
  kind: HistoryKind;
  /** Net effect on the wallet in sats, signed. For sends this is minus the amount paid (fee shown apart). */
  amount: string;
  fee?: string;
  feeRate?: number;
  height: number | null;
  /** Unix seconds. First seen, or estimated from the block height when found while catching up. */
  time: number;
  approxTime?: boolean;
  status: HistoryStatus;
  to?: string;
  outpoints: string[];
  label?: string;
  linked?: boolean;
  /** Set by PrivateBit when it built the transaction, so the scan does not reclassify it. */
  fromWallet?: boolean;
  change?: string;
};

export type HistoryStore = {
  v: 1;
  entries: Record<string, HistoryEntry>;
  /** True after a restore or an unreadable history, until the scan reaches the tip. */
  rebuilding?: boolean;
};

export const BLOCK_SECONDS = 30;

export function emptyHistory(rebuilding = false): HistoryStore {
  return rebuilding ? { v: 1, entries: {}, rebuilding: true } : { v: 1, entries: {} };
}

const op = (u: LabeledUtxo): string => `${u.txid}:${u.vout}`;

export function deriveHistory(
  scan: ScanStore,
  prev: HistoryStore | null,
  opts: { now: number; meta?: CoinMetaMap; payjoinTxids?: Set<string> },
): HistoryStore {
  const nowS = Math.floor(opts.now / 1000);
  const meta = opts.meta ?? {};
  const base = prev ?? emptyHistory();
  const entries: Record<string, HistoryEntry> = {};
  for (const [k, v] of Object.entries(base.entries)) entries[k] = { ...v, outpoints: v.outpoints.slice() };

  const outs = new Map<string, LabeledUtxo[]>();
  const ins = new Map<string, LabeledUtxo[]>();
  for (const u of scan.utxos) {
    (outs.get(u.txid) ?? outs.set(u.txid, []).get(u.txid)!).push(u);
    if (u.spentBy) (ins.get(u.spentBy) ?? ins.set(u.spentBy, []).get(u.spentBy)!).push(u);
  }
  const txids = new Set([...outs.keys(), ...ins.keys()]);
  const tip = scan.tip ?? scan.lastHeight;
  for (const txid of txids) {
    const o = outs.get(txid) ?? [];
    const i = ins.get(txid) ?? [];
    const outSum = o.reduce((a, u) => a + BigInt(u.value), 0n);
    const inSum = i.reduce((a, u) => a + BigInt(u.value), 0n);
    const net = outSum - inSum;
    const heights = [...o.map((u) => u.height), ...i.map((u) => u.spentHeight ?? 0)].filter((h) => h > 0);
    const height = heights.length ? Math.max(...heights) : null;
    const old = entries[txid];
    let kind: HistoryKind;
    if (old?.fromWallet) kind = old.kind;
    else if (i.length === 0) kind = o.some((u) => u.kind === "bip86") ? "moved-in" : "received";
    else if (opts.payjoinTxids?.has(txid) && net > 0n) kind = "payjoin-received";
    else if (net > 0n) kind = "payjoin-received";
    else if (o.length > 0 && net === 0n) kind = "self";
    else kind = "sent";
    const outpoints = [...i.map(op), ...o.map(op)];
    const linked =
      [...i, ...o].some((u) => u.kind === "bip86" || meta[op(u)]?.linked) || undefined;
    let time = old?.time ?? nowS;
    let approxTime = old ? old.approxTime : undefined;
    if (!old && height !== null && tip - height > 20) {
      time = nowS - (tip - height) * BLOCK_SECONDS;
      approxTime = true;
    }
    const incoming = kind === "received" || kind === "payjoin-received" || kind === "moved-in";
    const status: HistoryStatus =
      old?.status === "failed" || old?.status === "cancelled"
        ? old.status
        : height !== null
          ? "confirmed"
          : incoming
            ? "incoming"
            : "pending";
    const amount = old?.fromWallet ? old.amount : net.toString();
    const entry: HistoryEntry = {
      ...(old ?? {}),
      txid,
      kind,
      amount,
      height,
      time,
      status,
      outpoints: Array.from(new Set([...(old?.outpoints ?? []), ...outpoints])),
    };
    if (approxTime) entry.approxTime = true;
    else delete entry.approxTime;
    if (linked) entry.linked = true;
    entries[txid] = entry;
  }
  const out: HistoryStore = { v: 1, entries };
  if (base.rebuilding && !(scan.tip !== undefined && scan.lastHeight >= scan.tip && !scan.inflight)) out.rebuilding = true;
  return out;
}

export function recordBroadcast(
  prev: HistoryStore | null,
  e: {
    txid: string;
    kind: HistoryKind;
    amount: bigint;
    fee: bigint;
    feeRate: number;
    to?: string;
    label?: string;
    outpoints: string[];
    change?: bigint;
    now: number;
    linked?: boolean;
  },
): HistoryStore {
  const base = prev ?? emptyHistory();
  const old = base.entries[e.txid];
  const entry: HistoryEntry = {
    ...(old ?? {}),
    txid: e.txid,
    kind: e.kind,
    amount: e.kind === "self" ? (-e.fee).toString() : (-e.amount).toString(),
    fee: e.fee.toString(),
    feeRate: e.feeRate,
    height: old?.height ?? null,
    time: old?.time ?? Math.floor(e.now / 1000),
    status: old?.status === "confirmed" ? "confirmed" : "pending",
    outpoints: Array.from(new Set([...(old?.outpoints ?? []), ...e.outpoints])),
    fromWallet: true,
  };
  if (e.to) entry.to = e.to;
  if (e.label) entry.label = e.label;
  if (e.change !== undefined && e.change > 0n) entry.change = e.change.toString();
  if (e.linked) entry.linked = true;
  return { ...base, entries: { ...base.entries, [e.txid]: entry } };
}

export function setHistoryLabel(prev: HistoryStore, txid: string, label: string | undefined): HistoryStore {
  const old = prev.entries[txid];
  if (!old) throw new Error("no such activity");
  const entry = { ...old };
  if (label) entry.label = label;
  else delete entry.label;
  return { ...prev, entries: { ...prev.entries, [txid]: entry } };
}

/** Newest first. */
export function historyList(h: HistoryStore): HistoryEntry[] {
  return Object.values(h.entries).sort((a, b) => b.time - a.time || (b.height ?? 1e12) - (a.height ?? 1e12));
}
