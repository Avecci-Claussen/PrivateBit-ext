import { describe, expect, it } from "vitest";
import { hex } from "../src/lib/bytes.ts";
import { accountFromVault } from "../src/lib/keys.ts";
import { createMnemonic, unlockVault, vaultFromMnemonic, type VaultBlob } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";
import { dumpKv } from "./helpers/kv.ts";
import { scopedName } from "../src/lib/layout.ts";

describe("audit: emergency fixes", () => {
  it("lock leaves no recovery words, seed or spend key anywhere in storage", async () => {
    const kv = dumpKv();
    const w = new PrivateBit(kv);
    const words = await w.create({ password: "password1", birthday: 100 });
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: words, birthday: 100 }));
    // Security audit v1: not even while unlocked. Only the sealed seed is in session storage.
    const seed = vaultFromMnemonic({ mnemonic: words, birthday: 100 }).seed;
    expect(kv.text()).not.toContain(words);
    expect(kv.text()).not.toContain(hex(seed));
    expect(kv.text()).not.toContain(hex(account.spendSecret));
    expect((await w.requireAccount()).account.spendPub).toEqual(account.spendPub);
    await w.lock();
    const text = kv.text();
    for (const word of new Set(words.split(" "))) {
      // Each word could appear inside unrelated hex by chance only if it were hex; words are letters.
      expect(text.includes(`"${word} `) || text.includes(` ${word} `) || text.includes(` ${word}"`)).toBe(false);
    }
    expect(text).not.toContain(words);
    expect(text).not.toContain(hex(account.spendSecret));
    const grant = kv.dump()[scopedName(w.activeId!, "privatebit.scan.grant")] as Record<string, unknown>;
    expect(Object.keys(grant).sort()).toEqual(["birthday", "scanKey", "scanSecret", "spendPub", "v"]);
    expect(await w.canIndex()).toBe(true);
    await expect(w.history()).rejects.toThrow(/locked/);
    await expect(w.requireAccount()).rejects.toThrow(/locked/);
  });

  it("an older build's grant that held the words is deleted, not used", async () => {
    const kv = dumpKv();
    const w = new PrivateBit(kv);
    const words = await w.create({ password: "password1", birthday: 100 });
    await w.lock();
    await w.kv.set({ "privatebit.scan.grant": { mnemonic: words, passphrase: "", birthday: 100 } });
    expect(await w.canIndex()).toBe(false);
    expect(kv.text()).not.toContain(words);
  });

  it("a password change retires the old password, including any copy older builds left", async () => {
    const kv = dumpKv();
    const w = new PrivateBit(kv);
    await w.create({ password: "password1", birthday: 100 });
    // An older build kept the vault under the old password as the "previous" copy.
    await w.kv.set({ "privatebit.vault.bak": kv.dump()[scopedName(w.activeId!, "privatebit.vault")] });
    await w.changePassword("password1", "password2-longer");
    const d = kv.dump();
    expect(() => unlockVault(d[scopedName(w.activeId!, "privatebit.vault")] as VaultBlob, "password1")).toThrow(/wrong password/);
    expect(d[scopedName(w.activeId!, "privatebit.vault.bak")]).toBeUndefined();
    expect((await w.state()).hasBackup).toBe(false);
    await w.lock();
    await expect(w.unlock("password1")).rejects.toThrow(/wrong password/);
    await w.unlock("password2-longer");
  });

  it("a birthday edit does not create a previous wallet banner", async () => {
    const w = new PrivateBit(dumpKv());
    await w.create({ password: "password1", birthday: 100 });
    await w.setBirthday(200);
    expect((await w.state()).hasBackup).toBe(false);
  });

  it("restoring the previous wallet needs its password", async () => {
    const kv = dumpKv();
    const w = new PrivateBit(kv);
    await w.create({ password: "first-pw", birthday: 100 });
    await w.restore({ mnemonic: createMnemonic(256), password: "second-pw", birthday: 100 });
    expect((await w.state()).hasBackup).toBe(true);
    await expect(w.restoreBackup("second-pw")).rejects.toThrow(/wrong password/);
    await w.restoreBackup("first-pw");
    await w.unlock("first-pw");
  });

  it("removing one of two wallets keeps the other with its coins", async () => {
    const kv = dumpKv();
    const w = new PrivateBit(kv);
    await w.create({ password: "first-pw", birthday: 100 });
    const scan = await w.loadScan();
    scan.utxos.push({ txid: "ab".repeat(32), vout: 0, value: "777", scriptPubKey: "51" + "20" + "11".repeat(32), tweak: "00".repeat(32), label: null, k: 0, height: 5, spent: false });
    await w.saveScan(scan);
    await w.addWallet({ mnemonic: createMnemonic(256), password: "second-pw", birthday: 100, kind: "create", name: "Second" });
    const res = await w.removeWallet("second-pw");
    expect(res.wiped).toBe(false);
    const st = await w.state();
    expect(st.hasVault).toBe(true);
    expect(st.wallets).toHaveLength(1);
    await w.unlock("first-pw");
    expect((await w.loadScan()).utxos.map((u) => u.value)).toEqual(["777"]);
  });

  it("removing the last wallet reports a full wipe", async () => {
    const kv = dumpKv();
    const w = new PrivateBit(kv);
    await w.create({ password: "first-pw", birthday: 100 });
    expect((await w.removeWallet("first-pw")).wiped).toBe(true);
    expect(Object.keys(kv.dump())).toEqual([]);
  });
});
