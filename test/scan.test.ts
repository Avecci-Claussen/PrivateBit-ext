import { describe, expect, it } from "vitest";
import {
  applyBuiltSend,
  confirmedBalance,
  emptyScanStore,
  isCoinbaseTxid,
  markSpent,
  pendingBalance,
  scanStep,
  spendableBalance,
  upsertUtxo,
  type LabeledUtxo,
} from "../src/lib/scan.ts";
import type { ChainSource } from "../src/lib/chain.ts";
import { accountFromVault } from "../src/lib/keys.ts";
import { parseTxHex } from "../src/lib/tx.ts";
import { createMnemonic, vaultFromMnemonic } from "../src/lib/vault.ts";

function fakeSource(txidsByHeight: Record<number, string[]>): ChainSource {
  return {
    kind: "unisat",
    async getTip() {
      return { height: 3, hash: "aa".repeat(32) };
    },
    async getBlockHash(h) {
      return `h${h}`;
    },
    async getBlockTxids(h) {
      return txidsByHeight[h] ?? [];
    },
    async getTxHex(txid) {
      if (isCoinbaseTxid(txid) || txid === "missing") throw new Error("no parent");
      throw new Error(`unexpected ${txid}`);
    },
    async broadcast() {
      return "";
    },
    async estimateFeeSatPerVb() {
      return 1;
    },
  };
}

describe("scan", () => {
  it("treats all-zero txids as coinbase", () => {
    expect(isCoinbaseTxid("00".repeat(32))).toBe(true);
    expect(isCoinbaseTxid("ab".repeat(32))).toBe(false);
  });

  it("persists inflight and does not call getTxHex for an empty block", async () => {
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2 }));
    const source = fakeSource({ 2: [] });
    const first = await scanStep(account, source, emptyScanStore(2), 2, 8);
    expect(first.progress.done).toBe(true);
    expect(first.store.lastHeight).toBe(2);
    expect(first.store.inflight).toBeUndefined();
  });

  it("keeps scanning when tip moves after catch-up", async () => {
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2 }));
    const source = fakeSource({ 2: [], 3: [] });
    const caught = await scanStep(account, source, emptyScanStore(2), 2, 8);
    expect(caught.progress.done).toBe(true);
    expect(caught.store.lastHeight).toBe(2);
    const next = await scanStep(account, source, caught.store, 3, 8);
    expect(next.store.lastHeight).toBe(3);
    expect(next.store.tip).toBe(3);
    expect(next.progress.done).toBe(true);
  });

  it("marks spent inputs immediately and does not double-count the same outpoint", () => {
    const parent = "6dc22f541814f63eba85cc327adbddff4173f318c1620605b6abe01ada76dc6a";
    const coin: LabeledUtxo = {
      txid: parent,
      vout: 0,
      value: "10000000",
      scriptPubKey: "0014ee4fbefa4054af754130fbc8d71999e132ce5c84",
      tweak: "aa".repeat(32),
      label: null,
      k: 0,
      height: 2_228_748,
      spent: false,
    };
    const utxos = [coin];
    const send =
      "020000000001016adc76da1ae0abb6050662c118f37341ffdddb7a32cc85ba3ef61418542fc26d0000000000ffffffff0240420f00000000002251203c8284b9fa541f6187f688982ac1a0e91c3de19a0f69d1bd069ac27c3847a6cdb453890000000000160014ee4fbefa4054af754130fbc8d71999e132ce5c8402473044022044d57365294352ca4ab4c0d7fa3a4f13142cde3fb9bad8e9a2ce24f2ae7476a502207002cf6e791bc6992901be2bcad942a192f34f69f1c300f67eba6549d8f305b401210328633a52a04265a2fe17b75b34211fcbf8f05f8b8fa7c10ce4bbe2f2d20e616800000000";
    markSpent(utxos, parseTxHex(send));
    expect(utxos[0].spent).toBe(true);
    expect(confirmedBalance({ utxos, lastHeight: 2_228_749 })).toBe(0n);

    const change: LabeledUtxo = {
      txid: "0a6013191e7965a1f41d901e926cdbc2c2f80b5d58a5f8916e438eebc19168b0",
      vout: 1,
      value: "8999860",
      scriptPubKey: "0014ee4fbefa4054af754130fbc8d71999e132ce5c84",
      tweak: "bb".repeat(32),
      label: 0,
      k: 1,
      height: 0,
      spent: false,
    };
    upsertUtxo(utxos, change);
    upsertUtxo(utxos, { ...change, height: 2_228_749 });
    expect(utxos.filter((u) => u.txid === change.txid && u.vout === 1)).toHaveLength(1);
    expect(utxos.find((u) => u.txid === change.txid)?.height).toBe(2_228_749);
    expect(pendingBalance({ utxos: [change], lastHeight: 2_228_748 })).toBe(8_999_860n);
    expect(confirmedBalance({ utxos: [{ ...change, height: 2_228_749 }], lastHeight: 2_228_749 })).toBe(8_999_860n);
  });

  it("a spend with change updates spendable to the change, not zero", () => {
    const parent = "6dc22f541814f63eba85cc327adbddff4173f318c1620605b6abe01ada76dc6a";
    const store = {
      lastHeight: 2_228_748,
      utxos: [
        {
          txid: parent,
          vout: 0,
          value: "10000000",
          scriptPubKey: "0014ee4fbefa4054af754130fbc8d71999e132ce5c84",
          tweak: "aa".repeat(32),
          label: null,
          k: 0,
          height: 2_228_748,
          spent: false,
        } satisfies LabeledUtxo,
      ],
    };
    expect(spendableBalance(store)).toBe(10_000_000n);
    const send =
      "020000000001016adc76da1ae0abb6050662c118f37341ffdddb7a32cc85ba3ef61418542fc26d0000000000ffffffff0240420f00000000002251203c8284b9fa541f6187f688982ac1a0e91c3de19a0f69d1bd069ac27c3847a6cdb453890000000000160014ee4fbefa4054af754130fbc8d71999e132ce5c8402473044022044d57365294352ca4ab4c0d7fa3a4f13142cde3fb9bad8e9a2ce24f2ae7476a502207002cf6e791bc6992901be2bcad942a192f34f69f1c300f67eba6549d8f305b401210328633a52a04265a2fe17b75b34211fcbf8f05f8b8fa7c10ce4bbe2f2d20e616800000000";
    const next = applyBuiltSend(store, send, [
      {
        vout: 1,
        value: "8999860",
        scriptPubKey: "0014ee4fbefa4054af754130fbc8d71999e132ce5c84",
        tweak: "bb".repeat(32),
        label: 0,
        k: 0,
      },
    ]);
    expect(spendableBalance(next)).toBe(8_999_860n);
    expect(pendingBalance(next)).toBe(8_999_860n);
    expect(confirmedBalance(next)).toBe(0n);
    expect(next.utxos.find((u) => u.txid === parent)?.spent).toBe(true);
  });
});
