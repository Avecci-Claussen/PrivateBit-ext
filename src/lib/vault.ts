import { scrypt } from "@noble/hashes/scrypt";
import { gcm } from "@noble/ciphers/aes";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { fromHex, hex, randomBytes } from "./bytes.ts";

export const VAULT_VERSION = 1;
const SCRYPT_N = 1 << 15;
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

export function createMnemonic(strength: 128 | 256 = 128): string {
  return generateMnemonic(wordlist, strength);
}

export function assertMnemonic(mnemonic: string): void {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("invalid mnemonic");
}

function kdf(password: string, salt: Uint8Array, params: VaultBlob["kdf"]): Uint8Array {
  if (params.name !== "scrypt") throw new Error("unknown kdf");
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
const SESSION_KEY = "privatebit.session";

export async function persistVault(kv: Kv, blob: VaultBlob): Promise<void> {
  await kv.set({ [VAULT_KEY]: blob });
}

export async function loadVaultBlob(kv: Kv): Promise<VaultBlob | null> {
  const got = await kv.get([VAULT_KEY]);
  return (got[VAULT_KEY] as VaultBlob) ?? null;
}

export async function saveSession(kv: Kv, vault: UnlockedVault): Promise<void> {
  await kv.set({
    [SESSION_KEY]: {
      mnemonic: vault.mnemonic,
      passphrase: vault.passphrase,
      birthday: vault.birthday,
    },
  });
}

export async function loadSession(kv: Kv): Promise<UnlockedVault | null> {
  const got = await kv.get([SESSION_KEY]);
  const s = got[SESSION_KEY] as { mnemonic: string; passphrase: string; birthday: number } | undefined;
  if (!s) return null;
  return vaultFromMnemonic(s);
}

export async function clearSession(kv: Kv): Promise<void> {
  await kv.remove([SESSION_KEY]);
}
