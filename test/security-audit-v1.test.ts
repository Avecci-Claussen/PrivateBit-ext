import { describe, expect, it } from "vitest";
import { scrypt } from "@noble/hashes/scrypt";
import { gcm } from "@noble/ciphers/aes";
import { hex, randomBytes } from "../src/lib/bytes.ts";
import { SCRYPT_N, unlockVault, vaultNeedsStrongerKdf, type Kv, type VaultBlob } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";
import { messageRisks, visibleMessage } from "../src/lib/message-check.ts";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** A vault as an older build saved it, with scrypt N=2^15. */
function legacyBlob(mnemonic: string, password: string, N = 1 << 15, r = 8, p = 1): VaultBlob {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = scrypt(new TextEncoder().encode(password), salt, { N, r, p, dkLen: 32 });
  const ct = gcm(key, nonce).encrypt(new TextEncoder().encode(JSON.stringify({ mnemonic, passphrase: "" })));
  return { v: 1, kdf: { name: "scrypt", N, r, p }, salt: hex(salt), nonce: hex(nonce), ct: hex(ct), birthday: 0 } as VaultBlob;
}

function mapKv(): Kv & { m: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    m,
    async get(keys) { const o: Record<string, unknown> = {}; for (const k of keys) if (m.has(k)) o[k] = m.get(k); return o; },
    async set(items) { for (const [k, v] of Object.entries(items)) m.set(k, v); },
    async remove(keys) { for (const k of keys) m.delete(k); },
  };
}

describe("audit L9: vault KDF", () => {
  it("new desktop vaults use 2^17 and older ones are flagged for upgrade", () => {
    expect(SCRYPT_N).toBe(1 << 17);
    expect(vaultNeedsStrongerKdf({ ...legacyBlob(WORDS, "pw", 1 << 16) })).toBe(true);
    const old = legacyBlob(WORDS, "pw");
    expect(vaultNeedsStrongerKdf(old)).toBe(true);
    expect(unlockVault(old, "pw").mnemonic).toBe(WORDS);
  });

  it("refuses edited KDF settings instead of hanging or weakening", () => {
    const good = legacyBlob(WORDS, "pw");
    for (const kdf of [{ N: 1 << 10 }, { N: 1 << 20 }, { N: 3 * (1 << 14) }, { r: 16 }, { p: 2 }]) {
      const b = { ...good, kdf: { ...good.kdf, ...kdf } } as VaultBlob;
      expect(() => unlockVault(b, "pw")).toThrow(/unsupported vault settings/);
    }
  });

  it("unlock re-saves an older vault with the current cost, same words and password", async () => {
    const kv = mapKv();
    const w = new PrivateBit(kv);
    await w.create({ password: "pw", birthday: 8 });
    const words = (await (w as unknown as { revealMnemonic?: (p: string) => Promise<string> }).revealMnemonic?.("pw")) ?? null;
    // Swap every stored vault for an old style one with the same words.
    let swapped = 0;
    for (const [k, v] of kv.m) {
      const b = v as VaultBlob;
      if (b && typeof b === "object" && (b as VaultBlob).kdf?.name === "scrypt" && "ct" in b) {
        const mn = unlockVault(b, "pw").mnemonic;
        kv.m.set(k, { ...legacyBlob(mn, "pw"), birthday: b.birthday });
        swapped++;
      }
    }
    expect(swapped).toBeGreaterThan(0);
    await w.lock();
    await w.unlock("pw");
    const after = [...kv.m.values()].filter((v) => (v as VaultBlob)?.kdf?.name === "scrypt" && "ct" in (v as object)) as VaultBlob[];
    expect(after.some((b) => b.kdf.N === SCRYPT_N)).toBe(true);
    for (const b of after.filter((x) => x.kdf.N === SCRYPT_N)) expect(unlockVault(b, "pw").mnemonic.split(" ").length).toBeGreaterThanOrEqual(12);
    if (words) expect(after.some((b) => b.kdf.N === SCRYPT_N && unlockVault(b, "pw").mnemonic === words)).toBe(true);
  }, 30000);
});

describe("audit F-04: message signing review", () => {
  it("flags hidden and direction changing characters and shows them", () => {
    const t = "Log in to example.com\u202Enoc.live\u202C";
    expect(messageRisks(t)[0]).toMatch(/hidden characters/);
    expect(visibleMessage(t)).toBe("Log in to example.com[U+202E]noc.live[U+202C]");
    expect(visibleMessage("a\u200Bb")).toBe("a[U+200B]b");
  });

  it("keeps ordinary text, new lines and tabs as they are", () => {
    const t = "Welcome!\nSign to log in.\tNonce: 42";
    expect(messageRisks(t)).toEqual([]);
    expect(visibleMessage(t)).toBe(t);
  });

  it("warns on a bare hash and on transaction looking text", () => {
    expect(messageRisks("ab".repeat(32))[0]).toMatch(/64 character hash/);
    expect(messageRisks("0x" + "ab".repeat(32))[0]).toMatch(/64 character hash/);
    expect(messageRisks("cHNidP8BAHECAAAAA")[0]).toMatch(/looks like a transaction/);
    expect(messageRisks("70736274ff0100")[0]).toMatch(/looks like a transaction/);
  });
});
