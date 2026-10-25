/**
 * Session sealing (security audit v1, item M6/L13).
 *
 * While unlocked, PrivateBit keeps no recovery words and no plain seed. The seed is sealed with
 * AES-256-GCM under a WebCrypto key created with extractable=false, and only the ciphertext is in
 * chrome.storage.session (memory only, gone when the browser quits). The key itself never exists
 * as bytes in JavaScript:
 * - In the extension it lives in this worker's memory and, so a restart of the MV3 service
 *   worker does not lock the wallet, as a non-extractable CryptoKey in this extension's
 *   IndexedDB. It is deleted on Lock and at browser start. Without the session ciphertext
 *   (memory only) the key opens nothing.
 * - In the Android app it lives only in memory: the app process ending locks the wallet.
 * The seed is opened only for the operation that needs it (signing, deriving), then zeroed.
 */
export type SealedBox = { iv: string; ct: string };
export type KeySlot = "session" | "pj";

const mem = new Map<KeySlot, CryptoKey>();
const DB = "privatebit-session-keys";
const STORE = "keys";

const onPhone = typeof (globalThis as { Capacitor?: unknown }).Capacitor !== "undefined";
function useIdb(): boolean {
  const c = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome;
  return !onPhone && typeof indexedDB !== "undefined" && !!c?.runtime?.id;
}

function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB, 1);
    } catch {
      resolve(undefined);
      return;
    }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => resolve(undefined);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(STORE, mode);
        const r = f(tx.objectStore(STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(undefined);
        tx.oncomplete = () => db.close();
      } catch {
        db.close();
        resolve(undefined);
      }
    };
  });
}

async function getKey(slot: KeySlot, create: boolean): Promise<CryptoKey | undefined> {
  const m = mem.get(slot);
  if (m) return m;
  if (useIdb()) {
    const k = (await idb<CryptoKey>("readonly", (s) => s.get(slot) as IDBRequest<CryptoKey>)) ?? undefined;
    if (k) {
      mem.set(slot, k);
      return k;
    }
  }
  if (!create) return undefined;
  const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  if (k.extractable) throw new Error("session key must not be extractable");
  mem.set(slot, k);
  if (useIdb()) await idb("readwrite", (s) => s.put(k, slot));
  return k;
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Seal bytes under the slot's key, creating the key on first use. The input is not kept. */
export async function seal(slot: KeySlot, data: Uint8Array, aad: string): Promise<SealedBox> {
  const key = (await getKey(slot, true))!;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, data as BufferSource));
  return { iv: toHex(iv), ct: toHex(ct) };
}

/** Open a sealed box. Null when the key is gone (locked, browser restarted) or the box was altered. */
export async function open(slot: KeySlot, box: SealedBox | undefined, aad: string): Promise<Uint8Array | null> {
  if (!box || typeof box.iv !== "string" || typeof box.ct !== "string") return null;
  const key = await getKey(slot, false);
  if (!key) return null;
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(box.iv) as BufferSource, additionalData: new TextEncoder().encode(aad) }, key, fromHex(box.ct) as BufferSource));
  } catch {
    return null;
  }
}

/** Forget the slot's key: everything sealed under it becomes unreadable. */
export async function dropKey(slot: KeySlot): Promise<void> {
  mem.delete(slot);
  if (useIdb()) await idb("readwrite", (s) => s.delete(slot));
}

/** For tests: true when the slot's key exists and cannot be exported. */
export async function keyIsNonExtractable(slot: KeySlot): Promise<boolean> {
  const k = await getKey(slot, false);
  return !!k && k.extractable === false;
}
