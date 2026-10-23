import type { LabeledUtxo } from "./scan.ts";

/** Per-coin notes, stored encrypted in privatebit.coinmeta (DATA.md section 5). */
export type CoinMeta = { label?: string; frozen?: boolean; reason?: string; linked?: boolean };
export type CoinMetaMap = Record<string, CoinMeta>;
export type CoinStatus = "private" | "linked" | "reserved" | "frozen";

export const MAX_LABEL = 64;

export function outpointOf(u: { txid: string; vout: number }): string {
  return `${u.txid}:${u.vout}`;
}

export function coinStatus(u: LabeledUtxo, meta: CoinMetaMap, reserved: Set<string>): CoinStatus {
  const op = outpointOf(u);
  const m = meta[op];
  if (m?.frozen) return "frozen";
  if (reserved.has(op)) return "reserved";
  if (m?.linked || u.kind === "bip86") return "linked";
  return "private";
}

export function frozenOutpoints(meta: CoinMetaMap): Set<string> {
  return new Set(Object.entries(meta).filter(([, m]) => m.frozen).map(([op]) => op));
}

/** Spending a Linked coin together with a Private one tells both sides they belong to one wallet. */
export function mixesLinkedAndPrivate(statuses: CoinStatus[]): boolean {
  return statuses.includes("linked") && statuses.includes("private");
}

export function cleanLabel(label: string | undefined): string | undefined {
  const t = (label ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  return t || undefined;
}

export function setCoinMeta(map: CoinMetaMap, op: string, patch: Partial<CoinMeta>): CoinMetaMap {
  const next: CoinMetaMap = { ...map };
  const cur: CoinMeta = { ...(next[op] ?? {}) };
  if ("label" in patch) cur.label = cleanLabel(patch.label);
  if ("frozen" in patch) cur.frozen = patch.frozen ? true : undefined;
  if ("reason" in patch) cur.reason = cleanLabel(patch.reason);
  if ("linked" in patch) cur.linked = patch.linked ? true : undefined;
  const pruned = Object.fromEntries(Object.entries(cur).filter(([, v]) => v !== undefined)) as CoinMeta;
  if (Object.keys(pruned).length) next[op] = pruned;
  else delete next[op];
  return next;
}

/** A coin PrivateBit moved itself (the migration sweep) keeps its label and Linked flag. */
export function carryCoinMeta(map: CoinMetaMap, from: string[], to: string[]): CoinMetaMap {
  const src = from.map((op) => map[op]).filter(Boolean) as CoinMeta[];
  if (!src.length) return map;
  const label = src.find((m) => m.label)?.label;
  const linked = src.some((m) => m.linked);
  let next = map;
  for (const op of to) next = setCoinMeta(next, op, { label: next[op]?.label ?? label, linked: linked || next[op]?.linked });
  return next;
}
