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
export type SealedBox = { kid: string; iv: string; ct: string };

/** Keys by id. Each sealed box has its own key, so wallets and boxes never share one. */
const mem = new Map<string, CryptoKey>();
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

async function keyFor(kid: string): Promise<CryptoKey | undefined> {
  const m = mem.get(kid);
  if (m) return m;
  if (!useIdb()) return undefined;
  const k = (await idb<CryptoKey>("readonly", (s) => s.get(kid) as IDBRequest<CryptoKey>)) ?? undefined;
  if (k) mem.set(kid, k);
  return k;
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Seal bytes under a new non-extractable key. The caller keeps only the box. */
export async function seal(data: Uint8Array, aad: string): Promise<SealedBox> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  if (key.extractable) throw new Error("session key must not be extractable");
  const kid = toHex(crypto.getRandomValues(new Uint8Array(16)));
  mem.set(kid, key);
  if (useIdb()) await idb("readwrite", (s) => s.put(key, kid));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, data as BufferSource));
  return { kid, iv: toHex(iv), ct: toHex(ct) };
}

/** Open a box. Null when its key is gone (locked, browser restarted) or the box was altered. */
export async function open(box: SealedBox | undefined, aad: string): Promise<Uint8Array | null> {
  if (!box || typeof box.kid !== "string" || typeof box.iv !== "string" || typeof box.ct !== "string") return null;
  const key = await keyFor(box.kid);
  if (!key) return null;
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(box.iv) as BufferSource, additionalData: new TextEncoder().encode(aad) }, key, fromHex(box.ct) as BufferSource));
  } catch {
    return null;
  }
}

/** Forget a box's key: the box becomes unreadable for good. */
export async function dropBox(box: { kid?: unknown } | undefined | null): Promise<void> {
  const kid = box && typeof box.kid === "string" ? box.kid : undefined;
  if (!kid) return;
  mem.delete(kid);
  if (useIdb()) await idb("readwrite", (s) => s.delete(kid));
}

/** Forget every session key (browser start). */
export async function dropAllKeys(): Promise<void> {
  mem.clear();
  if (useIdb()) await idb("readwrite", (s) => s.clear());
}

/** For tests: true when the box's key exists and cannot be exported. */
export async function boxKeyIsNonExtractable(box: SealedBox): Promise<boolean> {
  const k = await keyFor(box.kid);
  return !!k && k.extractable === false;
}
