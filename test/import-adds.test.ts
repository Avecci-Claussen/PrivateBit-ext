// Audit M5: import never replaces a wallet; the same words open the wallet already here.
import { describe, expect, it } from "vitest";
import { createMnemonic } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";
import { loadIndex } from "../src/lib/layout.ts";
import { dumpKv } from "./helpers/kv.ts";

const coin = (value: string) => ({ txid: "ab".repeat(32), vout: 0, value, scriptPubKey: "5120" + "11".repeat(32), tweak: "00".repeat(32), label: null, k: 0, height: 5, spent: false });

describe("import from words", () => {
  it("creates the first wallet when there is none", async () => {
    const w = new PrivateBit(dumpKv());
    const r = await w.importWallet({ mnemonic: createMnemonic(256), password: "pw-first-1", birthday: 100 });
    expect(r.result).toBe("created");
    expect((await w.state()).wallets).toHaveLength(1);
  });

  it("adds a wallet next to the open one instead of replacing it", async () => {
    const w = new PrivateBit(dumpKv());
    await w.create({ password: "pw-a-1234", birthday: 100 });
    const a = w.activeId!;
    const scan = await w.loadScan();
    scan.utxos.push(coin("777"));
    await w.saveScan(scan);
    const r = await w.importWallet({ mnemonic: createMnemonic(256), password: "pw-b-1234", birthday: 100, name: "Imported" });
    expect(r.result).toBe("added");
    expect((await w.state()).wallets!.map((x) => x.name)).toEqual(["Wallet", "Imported"]);
    await w.openWallet(a);
    await w.unlock("pw-a-1234");
    expect((await w.loadScan()).utxos.map((u) => u.value)).toEqual(["777"]);
  });

  it("the same words open the wallet already here, with its coins and its password", async () => {
    const w = new PrivateBit(dumpKv());
    const words = createMnemonic(256);
    await w.importWallet({ mnemonic: words, password: "pw-a-1234", birthday: 100, name: "Daily" });
    const a = w.activeId!;
    const scan = await w.loadScan();
    scan.utxos.push(coin("555"));
    await w.saveScan(scan);
    await w.importWallet({ mnemonic: createMnemonic(256), password: "pw-b-1234", birthday: 100, name: "Other" });
    const r = await w.importWallet({ mnemonic: words, password: "something-new", birthday: 50 });
    expect(r).toMatchObject({ result: "existing", id: a, name: "Daily", passwordChanged: false });
    expect(w.activeId).toBe(a);
    const st = await w.state();
    expect(st.unlocked).toBe(true);
    expect(st.wallets).toHaveLength(2);
    expect((await w.loadScan()).utxos.map((u) => u.value)).toEqual(["555"]);
    await w.lock();
    await expect(w.unlock("something-new")).rejects.toThrow(/wrong password/);
    await w.unlock("pw-a-1234");
  });

  it("forgot password: the same words open it and set the new password, nothing lost", async () => {
    const w = new PrivateBit(dumpKv());
    const words = createMnemonic(256);
    await w.importWallet({ mnemonic: words, password: "pw-old-1234", birthday: 100 });
    const scan = await w.loadScan();
    scan.utxos.push(coin("999"));
    await w.saveScan(scan);
    await w.lock();
    const r = await w.importWallet({ mnemonic: words, password: "pw-new-1234", birthday: 100, resetPassword: true });
    expect(r).toMatchObject({ result: "existing", passwordChanged: true });
    expect((await w.state()).wallets).toHaveLength(1);
    expect((await w.loadScan()).utxos.map((u) => u.value)).toEqual(["999"]);
    await w.lock();
    await expect(w.unlock("pw-old-1234")).rejects.toThrow(/wrong password/);
    await w.unlock("pw-new-1234");
  });

  it("finds an older wallet with no fingerprint and no grant (browser restarted) by its coin list", async () => {
    const kv = dumpKv();
    const w = new PrivateBit(kv);
    const words = createMnemonic(256);
    await w.importWallet({ mnemonic: words, password: "pw-a-1234", birthday: 100 });
    await w.importWallet({ mnemonic: createMnemonic(256), password: "pw-b-1234", birthday: 100 });
    await w.lock();
    // Simulate an install from before fingerprints, after a browser restart (session storage gone).
    const index = (await loadIndex(kv))!;
    await kv.set({ "privatebit.wallets": { ...index, wallets: index.wallets.map(({ fp: _fp, ...e }) => e) } });
    await kv.remove(Object.keys(kv.dump()).filter((k) => k.endsWith(".scan.grant") || k.endsWith(".session")));
    const w2 = new PrivateBit(kv);
    const r = await w2.importWallet({ mnemonic: words, password: "pw-x-1234", birthday: 100 });
    expect(r.result).toBe("existing");
    expect((await w2.state()).wallets).toHaveLength(2);
  });

  it("a different passphrase is a different wallet and is added", async () => {
    const w = new PrivateBit(dumpKv());
    const words = createMnemonic(256);
    await w.importWallet({ mnemonic: words, password: "pw-a-1234", birthday: 100 });
    const r = await w.importWallet({ mnemonic: words, passphrase: "extra", password: "pw-a-1234", birthday: 100 });
    expect(r.result).toBe("added");
  });

  it("the directory keeps a fingerprint, never the words", async () => {
    const kv = dumpKv();
    const w = new PrivateBit(kv);
    const words = createMnemonic(256);
    await w.importWallet({ mnemonic: words, password: "pw-a-1234", birthday: 100 });
    const index = (await loadIndex(kv))!;
    expect(index.wallets[0]!.fp).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(index)).not.toContain(words.split(" ")[0]! + " ");
  });
});
