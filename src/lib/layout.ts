/**
 * Storage layout, version 2: every wallet has its own namespace.
 *
 *   privatebit.wallets              directory { v: 2, active, wallets[] } (no secrets)
 *   privatebit.w.<id>.vault         that wallet's encrypted vault, and so on for each key below
 *   privatebit.prefs, .price, ...   settings shared by every wallet
 *
 * A wallet's code only ever gets a Kv scoped to its own id (scopedKv), so a scan or a
 * Payjoin that is still running for one wallet cannot write into another. Switching
 * changes the active id; nothing is copied, packed or unpacked.
 *
 * Version 1 (the multi-wallet build before this) kept the open wallet under the bare
 * names and every other wallet in privatebit.pack.<id>. migrateLayout moves both into
 * namespaces once, writing and verifying the new copies before the old keys are removed.
 */
import type { Kv } from "./vault.ts";

export const INDEX_KEY = "privatebit.wallets";
export const LEGACY_ID = "legacy";
const PREFIX = "privatebit.";

/** Keys that belong to one wallet. Session-only ones are routed to session storage by name. */
export const WALLET_SCOPED = [
  "privatebit.vault",
  "privatebit.vault.bak",
  "privatebit.scan",
  "privatebit.chain",
  "privatebit.chain.secrets",
  "privatebit.history",
  "privatebit.coinmeta",
  "privatebit.onetime",
  "privatebit.pj.sessions",
  "privatebit.pj.send",
  "privatebit.pj.hpke",
  "privatebit.session",
  "privatebit.scan.grant",
] as const;
const SCOPED = new Set<string>(WALLET_SCOPED);

/** Shared by all wallets on this computer. */
export const GLOBAL_KEYS = [
  INDEX_KEY,
  "privatebit.prefs",
  "privatebit.price",
  "privatebit.activity",
  "privatebit.lockinfo",
  "privatebit.health",
  "privatebit.onboard",
  "privatebit.fees",
  "privatebit.theme",
] as const;

/** Version 1 names, kept only so migration and a full wipe can find them. */
export const V1_LIVE_KEYS = [
  "privatebit.vault",
  "privatebit.vault.bak",
  "privatebit.scan",
  "privatebit.chain",
  "privatebit.chain.secrets",
  "privatebit.history",
  "privatebit.coinmeta",
  "privatebit.onetime",
  "privatebit.pj.sessions",
  "privatebit.pj.send",
  "privatebit.pj.hpke",
] as const;
export const V1_MOUNTED_KEY = "privatebit.mounted";
export function v1PackKey(id: string): string {
  return `privatebit.pack.${id}`;
}

export type WalletEntry = {
  id: string;
  name: string;
  createdAt: number;
  birthday: number;
  words?: number;
  hasPassphrase?: boolean;
  /** Last block this wallet has matched. */
  checked?: number;
};

export type WalletIndex = { v: 2; active: string; wallets: WalletEntry[] };

export function assertWalletId(id: string): void {
  if (id !== LEGACY_ID && !/^[0-9a-f]{16}$/.test(id)) throw new Error("bad wallet id");
}

export function scopedName(id: string, key: string): string {
  assertWalletId(id);
  if (!SCOPED.has(key)) throw new Error(`not a wallet key: ${key}`);
  return `privatebit.w.${id}.${key.slice(PREFIX.length)}`;
}

/** privatebit.w.<id>.session -> privatebit.session, for routing to session storage. */
export function baseName(key: string): string {
  const m = /^privatebit\.w\.[^.]+\.(.+)$/.exec(key);
  return m ? `${PREFIX}${m[1]}` : key;
}

export function walletKeys(id: string): string[] {
  return WALLET_SCOPED.map((k) => scopedName(id, k));
}

/** Storage for one wallet. Wallet keys are mapped into its namespace; shared keys pass through. */
export function scopedKv(root: Kv, id: string): Kv {
  assertWalletId(id);
  const map = (k: string): string => (SCOPED.has(k) ? scopedName(id, k) : k);
  return {
    async get(keys) {
      const mapped = keys.map(map);
      const got = await root.get(mapped);
      const out: Record<string, unknown> = {};
      keys.forEach((k, i) => {
        const v = got[mapped[i]!];
        if (v !== undefined) out[k] = v;
      });
      return out;
    },
    async set(items) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(items)) out[map(k)] = v;
      await root.set(out);
    },
    async remove(keys) {
      await root.remove(keys.map(map));
    },
  };
}

export async function loadIndex(kv: Kv): Promise<WalletIndex | null> {
  const index = (await kv.get([INDEX_KEY]))[INDEX_KEY] as WalletIndex | undefined;
  if (!index || index.v !== 2 || !Array.isArray(index.wallets) || index.wallets.length === 0) return null;
  return index;
}

export async function saveIndex(kv: Kv, index: WalletIndex): Promise<void> {
  await kv.set({ [INDEX_KEY]: index });
}

type V1Index = { v: 1; active: string; wallets: WalletEntry[] };
type V1Pack = { v: 1; values: Record<string, unknown> };

/**
 * One-time move from the version 1 layout. Order matters for crash safety:
 * 1. write every wallet's data under its namespace and read it back,
 * 2. write the v2 directory (the commit point),
 * 3. only then delete the v1 keys.
 * If the worker stops before 2, the next start repeats the copy from the untouched v1 keys.
 * The old scan grant is dropped, not moved: it held the recovery words.
 */
export async function migrateLayout(kv: Kv): Promise<"current" | "empty" | "migrated"> {
  const raw = (await kv.get([INDEX_KEY]))[INDEX_KEY] as WalletIndex | V1Index | undefined;
  if (raw && raw.v === 2) return "current";
  const liveNames = [...V1_LIVE_KEYS, "privatebit.session"];
  const live = await kv.get(liveNames);
  const writes: Record<string, unknown> = {};
  const oldKeys: string[] = [...liveNames, "privatebit.scan.grant", V1_MOUNTED_KEY];
  let index: WalletIndex;
  const v1 = raw && raw.v === 1 && Array.isArray(raw.wallets) && raw.wallets.length > 0 ? (raw as V1Index) : null;
  if (v1 && live["privatebit.vault"]) {
    const kept: WalletEntry[] = [];
    for (const w of v1.wallets) {
      if (w.id === v1.active) {
        for (const [k, v] of Object.entries(live)) writes[scopedName(w.id, k)] = v;
        kept.push(w);
        continue;
      }
      const pack = (await kv.get([v1PackKey(w.id)]))[v1PackKey(w.id)] as V1Pack | undefined;
      // A wallet whose pack is missing was already lost by v1. Leave anything that is there alone.
      if (!pack || pack.v !== 1 || !pack.values?.["privatebit.vault"]) continue;
      for (const [k, v] of Object.entries(pack.values)) {
        if (SCOPED.has(k)) writes[scopedName(w.id, k)] = v;
      }
      kept.push(w);
      oldKeys.push(v1PackKey(w.id));
    }
    index = { v: 2, active: v1.active, wallets: kept };
  } else if (live["privatebit.vault"]) {
    for (const [k, v] of Object.entries(live)) writes[scopedName(LEGACY_ID, k)] = v;
    const birthday = (live["privatebit.vault"] as { birthday?: number }).birthday ?? 0;
    index = { v: 2, active: LEGACY_ID, wallets: [{ id: LEGACY_ID, name: "Wallet", createdAt: 0, birthday }] };
  } else {
    return "empty";
  }
  await kv.set(writes);
  const back = await kv.get(Object.keys(writes));
  for (const [k, v] of Object.entries(writes)) {
    if (JSON.stringify(back[k]) !== JSON.stringify(v)) throw new Error("storage migration check failed; nothing was removed");
  }
  await saveIndex(kv, index);
  await kv.remove(oldKeys);
  return "migrated";
}
