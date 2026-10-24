/**
 * Several wallets on one computer. The open wallet keeps the original storage keys, so an
 * existing install does not move its coins. Every other wallet is a sealed pack until it is opened.
 */
import type { Kv } from "./vault.ts";
import { SCAN_GRANT_KEY, type VaultBlob } from "./vault.ts";

export const INDEX_KEY = "privatebit.wallets";
export const MOUNTED_KEY = "privatebit.mounted";
export const LEGACY_ID = "legacy";

/** Live keys that belong to the open wallet. Session is never packed: it holds the words. */
export const LIVE_KEYS = [
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

export type WalletEntry = {
  id: string;
  name: string;
  createdAt: number;
  birthday: number;
  words?: number;
  hasPassphrase?: boolean;
  /** Last block this wallet has matched. Only advances while that wallet is unlocked. */
  checked?: number;
};

export type WalletIndex = { v: 1; active: string; wallets: WalletEntry[] };

export type WalletPack = { v: 1; values: Record<string, unknown> };

export function packKey(id: string): string {
  if (id !== LEGACY_ID && !/^[0-9a-f]{16}$/.test(id)) throw new Error("bad wallet id");
  return `privatebit.pack.${id}`;
}

export async function loadIndex(kv: Kv): Promise<WalletIndex | null> {
  const got = await kv.get([INDEX_KEY]);
  const index = got[INDEX_KEY] as WalletIndex | undefined;
  if (!index || index.v !== 1 || !Array.isArray(index.wallets)) return null;
  return index;
}

export async function saveIndex(kv: Kv, index: WalletIndex): Promise<void> {
  await kv.set({ [INDEX_KEY]: index });
}

/** Adopt the wallet already on disk. Writes nothing when there is no vault. */
export async function ensureIndex(kv: Kv): Promise<WalletIndex | null> {
  const existing = await loadIndex(kv);
  if (existing) return existing;
  const got = await kv.get(["privatebit.vault"]);
  const blob = got["privatebit.vault"] as VaultBlob | undefined;
  if (!blob) return null;
  const index: WalletIndex = {
    v: 1,
    active: LEGACY_ID,
    wallets: [{ id: LEGACY_ID, name: "Wallet", createdAt: 0, birthday: blob.birthday }],
  };
  await kv.set({ [INDEX_KEY]: index, [MOUNTED_KEY]: LEGACY_ID });
  return index;
}

export async function stagePack(kv: Kv, id: string, values: Record<string, unknown>): Promise<void> {
  const pack: WalletPack = { v: 1, values };
  await kv.set({ [packKey(id)]: pack });
}

/**
 * Open another wallet. The one that was open is packed first, then the target is written
 * into the live keys in one storage update together with the directory.
 */
export async function switchWallet(kv: Kv, id: string): Promise<void> {
  const index = await ensureIndex(kv);
  if (!index) throw new Error("no wallet on this computer");
  if (!index.wallets.some((w) => w.id === id)) throw new Error("no such wallet");
  await kv.remove(["privatebit.session", SCAN_GRANT_KEY]);
  if (index.active === id) return;
  const live = await kv.get([...LIVE_KEYS]);
  const packed: Record<string, unknown> = {};
  for (const key of LIVE_KEYS) {
    if (live[key] !== undefined) packed[key] = JSON.parse(JSON.stringify(live[key])) as unknown;
  }
  await kv.set({ [packKey(index.active)]: { v: 1, values: packed } satisfies WalletPack });
  const incoming = (await kv.get([packKey(id)]))[packKey(id)] as WalletPack | undefined;
  if (!incoming || incoming.v !== 1 || !incoming.values["privatebit.vault"]) {
    throw new Error("that wallet's data is missing");
  }
  const next: WalletIndex = { ...index, active: id };
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming.values)) restored[key] = JSON.parse(JSON.stringify(value)) as unknown;
  await kv.set({ ...restored, [INDEX_KEY]: next, [MOUNTED_KEY]: id });
  const drop = LIVE_KEYS.filter((key) => incoming.values[key] === undefined);
  await kv.remove(["privatebit.session", packKey(id), ...drop]);
}
