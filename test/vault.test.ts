import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { describe, expect, it } from "vitest";
import { accountFromVault } from "../src/lib/keys.ts";
import { hex } from "../src/lib/bytes.ts";
import { DEFAULT_BIRTHDAY } from "../src/lib/network.ts";
import { PrivateBit } from "../src/lib/wallet.ts";
import {
  clearSession,
  createMnemonic,
  loadSession,
  loadVaultBackup,
  loadVaultBlob,
  lockVault,
  memoryKv,
  persistVault,
  restoreVaultBackup,
  saveSession,
  seedBackupMatches,
  unlockVault,
  vaultFromMnemonic,
} from "../src/lib/vault.ts";

describe("vault", () => {
  it("create / lock / unlock round-trip", () => {
    const mnemonic = createMnemonic(128);
    const unlocked = vaultFromMnemonic({ mnemonic, birthday: 2_200_000 });
    const blob = lockVault(unlocked, "correct horse");
    const again = unlockVault(blob, "correct horse");
    expect(again.mnemonic).toBe(mnemonic);
    expect(again.birthday).toBe(2_200_000);
    expect(() => unlockVault(blob, "wrong")).toThrow(/wrong password/);
  });

  it("passphrase changes the spend key", () => {
    const mnemonic = createMnemonic(128);
    const a = accountFromVault(vaultFromMnemonic({ mnemonic, passphrase: "", birthday: 1 }));
    const b = accountFromVault(vaultFromMnemonic({ mnemonic, passphrase: "x", birthday: 1 }));
    expect(hex(a.spendSecret)).not.toBe(hex(b.spendSecret));
    expect(a.receive).not.toBe(b.receive);
    expect(a.receive.startsWith("sp1")).toBe(true);
  });

  it("setBirthday rewinds scan to birthday-1 and drops cached utxos", async () => {
    const w = new PrivateBit(memoryKv());
    await w.create({ password: "pw", birthday: 2_300_000 });
    await w.saveScan({
      utxos: [
        {
          txid: "aa".repeat(32),
          vout: 0,
          value: "1000000",
          scriptPubKey: "5120" + "ab".repeat(32),
          tweak: "cc".repeat(32),
          label: null,
          k: 0,
          height: 2_300_000,
          spent: false,
        },
      ],
      lastHeight: 2_300_000,
    });
    expect((await w.state()).balance).toBe("1000000");
    await w.setBirthday(DEFAULT_BIRTHDAY);
    const st = await w.state();
    expect(st.birthday).toBe(DEFAULT_BIRTHDAY);
    expect(st.lastHeight).toBe(DEFAULT_BIRTHDAY - 1);
    expect(st.balance).toBe("0");
  });

  it("lock wipes session material", async () => {
    const kv = memoryKv();
    const mnemonic = createMnemonic(128);
    const unlocked = vaultFromMnemonic({ mnemonic, birthday: 1 });
    await persistVault(kv, lockVault(unlocked, "pw"));
    await saveSession(kv, unlocked);
    const open = await loadSession(kv);
    expect(open?.seed).toEqual(unlocked.seed);
    expect(open?.words).toBe(12);
    // Security audit v1: the session holds neither the words nor the plain seed.
    const raw = JSON.stringify(await kv.get(["privatebit.session"]));
    expect(raw).not.toContain(mnemonic.split(" ")[0] + " ");
    expect(raw).not.toContain(Buffer.from(unlocked.seed).toString("hex"));
    await clearSession(kv);
    expect(await loadSession(kv)).toBeNull();
  });

  it("keeps the previous vault when a new one is written, and can restore it", async () => {
    const kv = memoryKv();
    const first = vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 1 });
    const second = vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 1 });
    await persistVault(kv, lockVault(first, "pw"));
    expect(await loadVaultBackup(kv)).toBeNull();
    await persistVault(kv, lockVault(second, "pw2"), { keepPrevious: true });
    const bak = await loadVaultBackup(kv);
    expect(bak).toBeTruthy();
    expect(unlockVault(bak!, "pw").mnemonic).toBe(first.mnemonic);
    await expect(restoreVaultBackup(kv, "wrong")).rejects.toThrow(/wrong password/);
    expect(unlockVault((await loadVaultBlob(kv))!, "pw2").mnemonic).toBe(second.mnemonic);
    await restoreVaultBackup(kv, "pw");
    expect(unlockVault((await loadVaultBlob(kv))!, "pw").mnemonic).toBe(first.mnemonic);
    expect(unlockVault((await loadVaultBackup(kv))!, "pw2").mnemonic).toBe(second.mnemonic);
  });

  it("refuses createChecked when a vault is already on this computer", async () => {
    const w = new PrivateBit(memoryKv());
    await w.create({ password: "pw", birthday: DEFAULT_BIRTHDAY });
    await expect(
      w.createChecked({ mnemonic: createMnemonic(128), password: "pw", birthday: DEFAULT_BIRTHDAY }),
    ).rejects.toThrow(/already on this computer/);
  });

  it("draws a new wallet as 24 words from 256 bits", () => {
    const a = createMnemonic();
    const b = createMnemonic();
    expect(a.split(" ")).toHaveLength(24);
    expect(b.split(" ")).toHaveLength(24);
    expect(a).not.toBe(b);
    expect(validateMnemonic(a, wordlist)).toBe(true);
    expect(validateMnemonic(b, wordlist)).toBe(true);
  });

  it("refuses to create a new wallet from 12 words", async () => {
    const kv = memoryKv();
    const w = new PrivateBit(kv);
    await expect(w.create({ password: "pw", birthday: DEFAULT_BIRTHDAY, words: 12 })).rejects.toThrow(/24 words/);
    await expect(
      w.createChecked({ mnemonic: createMnemonic(128), password: "pw", birthday: DEFAULT_BIRTHDAY }),
    ).rejects.toThrow(/24 words/);
    expect(await loadVaultBlob(kv)).toBeNull();
  });

  it("the backup check matches the words that were shown, not a later guess", () => {
    const mnemonic = createMnemonic(256);
    const words = mnemonic.split(" ");
    expect(seedBackupMatches(mnemonic, [0, 8, 16].map((index) => ({ index, word: words[index]! })))).toBe(true);
    expect(seedBackupMatches(mnemonic, [{ index: 0, word: words[1]! }, { index: 1, word: words[0]! }, { index: 2, word: words[2]! }])).toBe(false);
    expect(seedBackupMatches(mnemonic, undefined)).toBe(false);
    expect(seedBackupMatches(mnemonic, [{ index: 0, word: words[0]! }])).toBe(false);
  });
});
