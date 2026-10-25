import { secp256k1 } from "@noble/curves/secp256k1";
import { describe, expect, it } from "vitest";
import { spendSecret, taprootScriptPubKey } from "../src/lib/bip352.ts";
import { hex } from "../src/lib/bytes.ts";
import type { Account } from "../src/lib/keys.ts";
import type { LabeledUtxo } from "../src/lib/scan.ts";
import { createMnemonic, memoryKv } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";
import { UnsupportedBlock } from "../src/lib/blockshare.ts";
import type { ChainSource } from "../src/lib/chain.ts";

function coinFor(account: Account, txid: string, value: string): LabeledUtxo {
  const tweak = new Uint8Array(32);
  tweak[31] = txid.charCodeAt(0) || 1;
  const sec = spendSecret({ spendSecret: account.spendSecret, tweak, label: null, scanSecret: account.scanSecret });
  return {
    txid,
    vout: 0,
    value,
    scriptPubKey: hex(taprootScriptPubKey(secp256k1.getPublicKey(sec, true).slice(1))),
    tweak: hex(tweak),
    label: null,
    k: 0,
    height: 9,
    spent: false,
  };
}

describe("several wallets", () => {
  it("keeps each wallet's coins, birthday and passphrase when you switch", async () => {
    const w = new PrivateBit(memoryKv());
    const firstWords = await w.create({ password: "one", birthday: 100 });
    expect(firstWords.split(" ")).toHaveLength(24);
    const scan = await w.loadScan();
    scan.utxos.push(coinFor((await w.requireAccount()).account, "aa".repeat(32), "42000"));
    await w.saveScan(scan);

    const older = createMnemonic(128);
    await w.addWallet({
      mnemonic: older,
      password: "two",
      passphrase: "secret",
      birthday: 500_000,
      name: "Imported",
      kind: "import",
    });

    const opened = await w.state();
    expect(opened.unlocked).toBe(true);
    expect(opened.mnemonicWords).toBe(12);
    expect(opened.hasPassphrase).toBe(true);
    expect(opened.birthday).toBe(500_000);
    expect(opened.balance).toBe("0");
    expect((await w.loadScan()).lastHeight).toBe(499_999);
    expect(opened.wallets).toHaveLength(2);
    expect(opened.wallets?.find((x) => x.active)?.name).toBe("Imported");

    const firstId = opened.wallets!.find((x) => !x.active)!.id;
    await w.openWallet(firstId);
    await expect(w.unlock("two")).rejects.toThrow(/wrong password/);
    await w.unlock("one");
    const back = await w.state();
    expect(back.balance).toBe("42000");
    expect(back.mnemonicWords).toBe(24);
    expect(back.hasPassphrase).toBe(false);
    expect(back.birthday).toBe(100);

    const secondId = back.wallets!.find((x) => !x.active)!.id;
    await w.openWallet(secondId);
    await w.unlock("two");
    expect((await w.state()).balance).toBe("0");
    expect((await w.loadScan()).lastHeight).toBe(499_999);

    await w.removeWallet("two");
    expect((await w.state()).unlocked).toBe(false);
    await expect(w.unlock("two")).rejects.toThrow(/wrong password/);
    await w.unlock("one");
    const left = await w.state();
    expect(left.balance).toBe("42000");
    expect(left.wallets).toHaveLength(1);
    expect(left.wallets?.[0]?.name).toBe("Wallet");
  });

  it("does not keep another wallet's coins or activity on the one just opened", async () => {
    const w = new PrivateBit(memoryKv());
    await w.create({ password: "one", birthday: 100 });
    const first = (await w.requireAccount()).account;
    const theirs = coinFor(first, "aa".repeat(32), "42000");
    const scan = await w.loadScan();
    scan.utxos.push(theirs);
    await w.saveScan(scan);

    await w.addWallet({
      mnemonic: createMnemonic(),
      password: "two",
      birthday: 500_000,
      name: "Second",
      kind: "create",
    });
    const mine = coinFor((await w.requireAccount()).account, "bb".repeat(32), "70000");
    const mixed = await w.loadScan();
    // Separate namespaces: nothing of the first wallet is visible here.
    expect(mixed.utxos).toEqual([]);
    mixed.lastHeight = 500_100;
    mixed.utxos.push(mine);
    await w.saveScan(mixed);
    expect((await w.state()).balance).toBe("70000");

    await w.lock();
    await w.unlock("two");
    expect((await w.state()).balance).toBe("70000");
    expect((await w.loadScan()).lastHeight).toBe(500_100);
    expect((await w.history()).entries.map((e) => e.txid)).toEqual([mine.txid]);

    const older = (await w.state()).wallets!.find((x) => !x.active)!;
    await w.openWallet(older.id);
    await w.unlock("one");
    const back = await w.state();
    expect(back.balance).toBe("42000");
    expect((await w.history()).entries.map((e) => e.txid)).toEqual([theirs.txid]);
  });

  it("matches blocks after lock, and stops when you switch wallets", async () => {
    const w = new PrivateBit(memoryKv());
    const source: ChainSource = {
      kind: "unisat",
      async getTip() {
        return { height: 102, hash: "00" };
      },
      async getBlockHash() {
        return "00";
      },
      async getBlockTxids() {
        return [];
      },
      async getBlockRaw() {
        throw new UnsupportedBlock();
      },
      async getTxHex() {
        throw new Error("no parent");
      },
      async broadcast() {
        return "aa";
      },
      async estimateFeeSatPerVb() {
        return 1;
      },
    };
    w.sourceOverride = source;
    await w.create({ password: "one", birthday: 100 });
    await w.lock();
    expect((await w.state()).unlocked).toBe(false);
    await expect(w.requireAccount()).rejects.toThrow(/locked/);
    expect(await w.canIndex()).toBe(true);
    const progress = await w.scanOnce();
    expect(progress.lastHeight).toBeGreaterThan(99);
    expect((await w.state()).unlocked).toBe(false);

    await w.addWallet({
      mnemonic: createMnemonic(256),
      password: "two",
      birthday: 100,
      name: "Other",
      kind: "create",
    });
    const first = (await w.state()).wallets!.find((x) => !x.active)!.id;
    await w.openWallet(first);
    expect(await w.canIndex()).toBe(false);
    expect((await w.scanOnce()).lastHeight).toBe(0);
  });
});
