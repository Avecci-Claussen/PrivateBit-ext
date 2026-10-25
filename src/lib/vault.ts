import { scrypt } from "@noble/hashes/scrypt";
import { gcm } from "@noble/ciphers/aes";
import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { sha256 } from "@noble/hashes/sha2";
import { fromHex, hex, randomBytes } from "./bytes.ts";
import { dropBox, open, seal, type SealedBox } from "./sessionkeys.ts";

export const VAULT_VERSION = 1;
/**
 * scrypt cost for new and re-saved vaults (audit L9, independent audit M1). Desktop: 2^17
 * (128 MiB, about 0.4 s). The Android app: 2^16 (64 MiB), because 128 MiB is too close to what a
 * phone WebView may get, and its storage already sits under a hardware Keystore key. Older
 * vaults are re-saved with this cost after the next successful unlock.
 */
const onPhone = typeof (globalThis as { Capacitor?: unknown }).Capacitor !== "undefined";
export const SCRYPT_N = onPhone ? 1 << 16 : 1 << 17;
const MIN_N = 1 << 14;
const MAX_N = 1 << 18;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

export type VaultBlob = {
  v: typeof VAULT_VERSION;
  kdf: { name: "scrypt"; N: number; r: number; p: number };
  salt: string;
  nonce: string;
  ct: string;
  birthday: number;
};

export type UnlockedVault = {
  mnemonic: string;
  passphrase: string;
  seed: Uint8Array;
  birthday: number;
};

/**
 * BIP39 entropy from crypto.getRandomValues. New wallets are 256 bits (24 words).
 * 128 is only for tests of an older backup. A stuck generator is refused.
 */
export function createMnemonic(strength: 128 | 256 = 256): string {
  if (strength !== 128 && strength !== 256) throw new Error("mnemonic strength must be 128 or 256 bits");
  const entropy = randomBytes(strength / 8);
  if (entropy.length !== strength / 8) throw new Error("entropy generator returned the wrong length");
  if (entropy.every((b) => b === entropy[0])) throw new Error("entropy generator failed");
  return entropyToMnemonic(entropy, wordlist);
}

export function assertMnemonic(mnemonic: string): void {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("invalid mnemonic");
}

function kdf(password: string, salt: Uint8Array, params: VaultBlob["kdf"]): Uint8Array {
  if (params.name !== "scrypt") throw new Error("unknown kdf");
  // Refuse edited parameters: too weak to be ours, or so large that unlocking would hang.
  if (!Number.isInteger(params.N) || params.N < MIN_N || params.N > MAX_N || (params.N & (params.N - 1)) !== 0 || params.r !== 8 || params.p !== 1) throw new Error("unsupported vault settings");
  const pw = new TextEncoder().encode(password);
  return scrypt(pw, salt, { N: params.N, r: params.r, p: params.p, dkLen: KEY_LEN });
}

export function lockVault(
  vault: UnlockedVault,
  password: string,
): VaultBlob {
  if (!password) throw new Error("password required");
  assertMnemonic(vault.mnemonic);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const params: VaultBlob["kdf"] = { name: "scrypt", N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
  const key = kdf(password, salt, params);
  const payload = new TextEncoder().encode(
    JSON.stringify({
      mnemonic: vault.mnemonic.trim(),
      passphrase: vault.passphrase,
    }),
  );
  const ct = gcm(key, nonce).encrypt(payload);
  return {
    v: VAULT_VERSION,
    kdf: params,
    salt: hex(salt),
    nonce: hex(nonce),
    ct: hex(ct),
    birthday: vault.birthday,
  };
}

/** True when the vault was saved with a lower scrypt cost than new vaults use. */
export function vaultNeedsStrongerKdf(blob: VaultBlob): boolean {
  return blob.kdf.name === "scrypt" && blob.kdf.N < SCRYPT_N;
}

export function unlockVault(blob: VaultBlob, password: string): UnlockedVault {
  if (blob.v !== VAULT_VERSION) throw new Error("unknown vault version");
  const key = kdf(password, fromHex(blob.salt), blob.kdf);
  let pt: Uint8Array;
  try {
    pt = gcm(key, fromHex(blob.nonce)).decrypt(fromHex(blob.ct));
  } catch {
    throw new Error("wrong password");
  }
  const parsed = JSON.parse(new TextDecoder().decode(pt)) as {
    mnemonic: string;
    passphrase: string;
  };
  assertMnemonic(parsed.mnemonic);
  return {
    mnemonic: parsed.mnemonic,
    passphrase: parsed.passphrase ?? "",
    seed: mnemonicToSeedSync(parsed.mnemonic, parsed.passphrase ?? ""),
    birthday: blob.birthday,
  };
}

export function vaultFromMnemonic(args: {
  mnemonic: string;
  passphrase?: string;
  birthday: number;
}): UnlockedVault {
  assertMnemonic(args.mnemonic);
  const mnemonic = args.mnemonic.trim().replace(/\s+/g, " ");
  const passphrase = args.passphrase ?? "";
  return {
    mnemonic,
    passphrase,
    seed: mnemonicToSeedSync(mnemonic, passphrase),
    birthday: args.birthday,
  };
}

export type Kv = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

export function memoryKv(): Kv {
  const m = new Map<string, unknown>();
  return {
    async get(keys) {
      const o: Record<string, unknown> = {};
      for (const k of keys) if (m.has(k)) o[k] = m.get(k);
      return o;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) m.set(k, v);
    },
    async remove(keys) {
      for (const k of keys) m.delete(k);
    },
  };
}

const VAULT_KEY = "privatebit.vault";
/** Previous vault, one generation. Reloading the extension must never destroy this. */
export const VAULT_BAK_KEY = "privatebit.vault.bak";
const SESSION_KEY = "privatebit.session";
/**
 * What block matching needs after Lock: the scan secret, the public spend key and the key that
 * seals the coin list. Never the recovery words, the seed or the spend secret. Session storage only
 * (memory, cleared when the browser quits), and removed on switch and remove.
 */
export const SCAN_GRANT_KEY = "privatebit.scan.grant";

export type ScanGrant = {
  v: 2;
  scanSecret: string;
  spendPub: string;
  /** Seals the coin list and the chain settings, not history or labels. */
  scanKey: string;
  birthday: number;
};

/**
 * Write the vault. The previous vault is kept only when a different wallet replaces it
 * (keepPrevious). A password change or a birthday edit never leaves an older copy behind,
 * so the old password stops working.
 */
export async function persistVault(kv: Kv, blob: VaultBlob, opts: { keepPrevious?: boolean } = {}): Promise<void> {
  const prev = await loadVaultBlob(kv);
  if (opts.keepPrevious && prev && JSON.stringify(prev) !== JSON.stringify(blob)) {
    await kv.set({ [VAULT_BAK_KEY]: prev });
  }
  await kv.set({ [VAULT_KEY]: blob });
}

export async function loadVaultBlob(kv: Kv): Promise<VaultBlob | null> {
  const got = await kv.get([VAULT_KEY]);
  return (got[VAULT_KEY] as VaultBlob) ?? null;
}

export async function loadVaultBackup(kv: Kv): Promise<VaultBlob | null> {
  const got = await kv.get([VAULT_BAK_KEY]);
  return (got[VAULT_BAK_KEY] as VaultBlob) ?? null;
}

/**
 * Put the previous vault back. Its own password is required, so whoever is at the computer
 * cannot swap wallets without knowing it. The wallet that was current becomes the backup.
 */
export async function restoreVaultBackup(kv: Kv, password: string): Promise<void> {
  const bak = await loadVaultBackup(kv);
  if (!bak) throw new Error("No previous wallet is saved on this computer.");
  unlockVault(bak, password);
  const cur = await loadVaultBlob(kv);
  await clearSession(kv);
  await clearScanGrant(kv);
  const next: Record<string, unknown> = { [VAULT_KEY]: bak };
  if (cur) next[VAULT_BAK_KEY] = cur;
  await kv.set(next);
}

/**
 * What an unlocked wallet keeps: the seed, sealed (see sessionkeys.ts), plus facts the screens
 * show. Never the recovery words or the passphrase. Opened per operation by loadSession.
 */
export type SessionVault = {
  seed: Uint8Array;
  birthday: number;
  words: number;
  hasPassphrase: boolean;
  /** Stable id of this seed for caches: a hash, not the seed. */
  sig: string;
};

type SessionRecord = { v: 2; box: SealedBox; birthday: number; words: number; hasPassphrase: boolean; sig: string };
const SESSION_AAD = "privatebit/session/v2";

export function sessionSig(seed: Uint8Array): string {
  return hex(sha256(new Uint8Array([...new TextEncoder().encode("privatebit/session-sig"), ...seed]))).slice(0, 32);
}

export async function saveSession(kv: Kv, vault: UnlockedVault | SessionVault): Promise<void> {
  const words = "words" in vault ? vault.words : vault.mnemonic.trim().split(/\s+/).length;
  const hasPassphrase = "hasPassphrase" in vault ? vault.hasPassphrase : vault.passphrase.length > 0;
  const prev = (await kv.get([SESSION_KEY]))[SESSION_KEY] as Partial<SessionRecord> | undefined;
  const body: SessionRecord = {
    v: 2,
    box: await seal(vault.seed, SESSION_AAD),
    birthday: vault.birthday,
    words,
    hasPassphrase,
    sig: sessionSig(vault.seed),
  };
  await kv.set({ [SESSION_KEY]: body });
  if (prev?.box) await dropBox(prev.box);
}

/** The session with a freshly opened seed. The caller zeroes the seed when it is done. */
export async function loadSession(kv: Kv): Promise<SessionVault | null> {
  const got = await kv.get([SESSION_KEY]);
  const s = got[SESSION_KEY] as Partial<SessionRecord> & { mnemonic?: string } | undefined;
  if (!s) return null;
  if (s.v !== 2 || s.mnemonic !== undefined) {
    // An older build kept the words here. Delete on sight; the user unlocks again.
    await kv.remove([SESSION_KEY]);
    return null;
  }
  const seed = await open(s.box, SESSION_AAD);
  if (!seed) return null;
  return { seed, birthday: s.birthday ?? 0, words: s.words ?? 24, hasPassphrase: !!s.hasPassphrase, sig: s.sig ?? sessionSig(seed) };
}

/** Facts about the session without opening the seed. */
export async function sessionInfo(kv: Kv): Promise<Omit<SessionVault, "seed"> | null> {
  const s = (await kv.get([SESSION_KEY]))[SESSION_KEY] as Partial<SessionRecord> | undefined;
  if (!s || s.v !== 2 || !s.box) return null;
  return { birthday: s.birthday ?? 0, words: s.words ?? 24, hasPassphrase: !!s.hasPassphrase, sig: s.sig ?? "" };
}

export async function clearSession(kv: Kv): Promise<void> {
  const prev = (await kv.get([SESSION_KEY]))[SESSION_KEY] as Partial<SessionRecord> | undefined;
  await kv.remove([SESSION_KEY]);
  await dropBox(prev?.box);
}

export async function saveScanGrant(kv: Kv, grant: ScanGrant): Promise<void> {
  await kv.set({ [SCAN_GRANT_KEY]: grant });
}

/**
 * Keys for finding coins while the wallet is locked. Absent after a switch or a browser quit.
 * An older build stored the recovery words here; that copy is deleted on sight and not used.
 */
export async function loadScanGrant(kv: Kv): Promise<ScanGrant | null> {
  const got = await kv.get([SCAN_GRANT_KEY]);
  const s = got[SCAN_GRANT_KEY] as Partial<ScanGrant> & { mnemonic?: string } | undefined;
  if (!s) return null;
  if (s.mnemonic !== undefined || s.v !== 2 || typeof s.scanSecret !== "string" || typeof s.scanKey !== "string") {
    await kv.remove([SCAN_GRANT_KEY]);
    return null;
  }
  return s as ScanGrant;
}

export async function clearScanGrant(kv: Kv): Promise<void> {
  await kv.remove([SCAN_GRANT_KEY]);
}
