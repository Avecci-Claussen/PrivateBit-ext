import type { LabeledUtxo } from "./scan.ts";

/** Per-coin notes, stored encrypted in privatebit.coinmeta (DATA.md section 5). */
export type CoinMeta = {
  label?: string;
  frozen?: boolean;
  reason?: string;
  linked?: boolean;
  /** The user unlocked a protected coin by hand after the warning. */
  assetOk?: boolean;
  /** What an ord server said about this outpoint: "none" (checked, plain) or "held" (inscription or rune). */
  asset?: "none" | "held";
};
export type CoinMetaMap = Record<string, CoinMeta>;
export type CoinStatus = "private" | "linked" | "reserved" | "frozen" | "protected";

/**
 * 1.0.0 asset guard. PrivateBit does not read inscriptions or runes yet (planned for 1.0.1), so a
 * small Taproot coin (330, 546, 10,000 sats and anything else at or under this size) is treated
 * as if it may hold one: automatic selection, Max, Payjoin and delayed sends never use it. The user
 * can unlock it by hand, and an ord server the user set up can clear or confirm it.
 */
export const ASSET_PROTECT_MAX_SATS = 10_000n;

export function isTaprootScript(spk: string): boolean {
  return /^5120[0-9a-f]{64}$/i.test(spk);
}

export function mayHoldAsset(u: { value: string; scriptPubKey: string }, m?: CoinMeta): boolean {
  if (m?.assetOk) return false;
  if (m?.asset === "held") return true;
  if (m?.asset === "none") return false;
  return isTaprootScript(u.scriptPubKey) && BigInt(u.value) <= ASSET_PROTECT_MAX_SATS;
}

export function protectedOutpoints(utxos: readonly LabeledUtxo[], meta: CoinMetaMap): Set<string> {
  return new Set(utxos.filter((u) => !u.spent && mayHoldAsset(u, meta[outpointOf(u)])).map(outpointOf));
}

/** Reads an ord server's /output answer. Only a full index that lists nothing counts as plain. */
export function ordOutputVerdict(body: unknown): "none" | "held" | undefined {
  if (!body || typeof body !== "object") return undefined;
  const o = body as { inscriptions?: unknown; runes?: unknown; indexed?: unknown };
  const insc = Array.isArray(o.inscriptions) ? o.inscriptions.length : undefined;
  const runes = Array.isArray(o.runes) ? o.runes.length : o.runes && typeof o.runes === "object" ? Object.keys(o.runes).length : o.runes == null ? 0 : undefined;
  if ((insc ?? 0) > 0 || (runes ?? 0) > 0) return "held";
  if (insc === 0 && runes === 0 && o.indexed === true) return "none";
  return undefined;
}

export const MAX_LABEL = 64;

export function outpointOf(u: { txid: string; vout: number }): string {
  return `${u.txid}:${u.vout}`;
}

export function coinStatus(u: LabeledUtxo, meta: CoinMetaMap, reserved: Set<string>): CoinStatus {
  const op = outpointOf(u);
  const m = meta[op];
  if (m?.frozen) return "frozen";
  if (reserved.has(op)) return "reserved";
  if (mayHoldAsset(u, m)) return "protected";
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
  if ("assetOk" in patch) cur.assetOk = patch.assetOk ? true : undefined;
  if ("asset" in patch) cur.asset = patch.asset === "none" || patch.asset === "held" ? patch.asset : undefined;
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
