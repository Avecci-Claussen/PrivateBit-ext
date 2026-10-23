import { describe, expect, it } from "vitest";
import { accountFromVault } from "../src/lib/keys.ts";
import { hex } from "../src/lib/bytes.ts";
import { DEFAULT_BIRTHDAY } from "../src/lib/network.ts";
import { PrivateBit } from "../src/lib/wallet.ts";
import {
  clearSession,
  createMnemonic,
  loadSession,
  lockVault,
  memoryKv,
  persistVault,
  saveSession,
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
    expect((await loadSession(kv))?.mnemonic).toBe(mnemonic);
    await clearSession(kv);
    expect(await loadSession(kv)).toBeNull();
  });
});
