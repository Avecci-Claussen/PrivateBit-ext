import { describe, expect, it } from "vitest";
import {
  addWatch,
  applyBuiltSend,
  claimBuiltSend,
  releaseBuiltSend,
  confirmedBalance,
  emptyScanStore,
  isCoinbaseTxid,
  markAbsentWatchSpent,
  markSpent,
  noteWatchedOutput,
  pendingBalance,
  recoverWatchedFromHints,
  SCAN_HEX_TRIES,
  scanStep,
  scanTransaction,
  spendableBalance,
  upsertUtxo,
  type LabeledUtxo,
} from "../src/lib/scan.ts";
import type { ChainSource } from "../src/lib/chain.ts";
import { RateLimitedError } from "../src/lib/requests.ts";
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

  it("starts every tx hex fetch in a batch before applying any of them", async () => {
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2 }));
    let inflight = 0;
    let peak = 0;
    const source: ChainSource = {
      kind: "unisat",
      async getTip() {
        return { height: 2, hash: "aa".repeat(32) };
      },
      async getBlockHash() {
        return "h";
      },
      async getBlockTxids() {
        return ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)];
      },
      async getTxHex() {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await Promise.resolve();
        inflight -= 1;
        throw new Error("no hex");
      },
      async broadcast() {
        return "";
      },
      async estimateFeeSatPerVb() {
        return 1;
      },
    };
    const step = await scanStep(account, source, emptyScanStore(2), 2, 3);
    expect(peak).toBe(3);
    expect(step.progress.skipped).toBe(3);
    expect(step.progress.done).toBe(false);
    expect(step.store.lastHeight).toBe(1);
    expect(step.store.inflight?.nextTx).toBe(0);
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
    const again = claimBuiltSend(next, send, []);
    expect(again.utxos.find((u) => u.txid === parent)?.spent).toBe(true);
    const stolen = structuredClone(next);
    const coin = stolen.utxos.find((u) => u.txid === parent);
    if (coin) coin.spentBy = "ab".repeat(32);
    expect(() => claimBuiltSend(stolen, send, [])).toThrow(/already spent/);
    const released = releaseBuiltSend(next, send, [
      {
        vout: 1,
        value: "8999860",
        scriptPubKey: "0014ee4fbefa4054af754130fbc8d71999e132ce5c84",
        tweak: "bb".repeat(32),
        label: 0,
        k: 0,
      },
    ]);
    expect(released.utxos.find((u) => u.txid === parent)?.spent).toBe(false);
    expect(spendableBalance(released)).toBe(10_000_000n);
  });

  it("confirms a local sweep even when Silent Payment detect cannot run", async () => {
    const send =
      "020000000001016adc76da1ae0abb6050662c118f37341ffdddb7a32cc85ba3ef61418542fc26d0000000000ffffffff0240420f00000000002251203c8284b9fa541f6187f688982ac1a0e91c3de19a0f69d1bd069ac27c3847a6cdb453890000000000160014ee4fbefa4054af754130fbc8d71999e132ce5c8402473044022044d57365294352ca4ab4c0d7fa3a4f13142cde3fb9bad8e9a2ce24f2ae7476a502207002cf6e791bc6992901be2bcad942a192f34f69f1c300f67eba6549d8f305b401210328633a52a04265a2fe17b75b34211fcbf8f05f8b8fa7c10ce4bbe2f2d20e616800000000";
    const parsed = parseTxHex(send);
    const parent = parsed.vin[0]!.txid;
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2 }));
    const store = {
      lastHeight: 1,
      utxos: [
        {
          txid: parent,
          vout: 0,
          value: "10000000",
          scriptPubKey: "0014ee4fbefa4054af754130fbc8d71999e132ce5c84",
          tweak: "aa".repeat(32),
          label: null,
          k: 0,
          height: 1,
          spent: true,
          spentBy: parsed.txid,
          spentHeight: 0,
        } satisfies LabeledUtxo,
        {
          txid: parsed.txid,
          vout: 1,
          value: "8999860",
          scriptPubKey: "0014ee4fbefa4054af754130fbc8d71999e132ce5c84",
          tweak: "bb".repeat(32),
          label: 0,
          k: 0,
          height: 0,
          spent: false,
        } satisfies LabeledUtxo,
      ],
    };
    const source: ChainSource = {
      kind: "unisat",
      async getTip() {
        return { height: 2, hash: "aa".repeat(32) };
      },
      async getBlockHash() {
        return "h";
      },
      async getBlockTxids() {
        return [parsed.txid];
      },
      async getTxHex(txid) {
        if (txid === parsed.txid) return send;
        throw new Error("no parent");
      },
      async broadcast() {
        return "";
      },
      async estimateFeeSatPerVb() {
        return 1;
      },
    };
    const step = await scanStep(account, source, store, 2, 8);
    const spent = step.store.utxos.find((u) => u.txid === parent);
    const change = step.store.utxos.find((u) => u.txid === parsed.txid);
    expect(spent?.spentHeight).toBe(2);
    expect(change?.height).toBe(2);
  });

  it("does not mark a block done when a tx hex fetch fails", async () => {
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2 }));
    const source: ChainSource = {
      ...fakeSource({ 2: ["aa".repeat(32), "bb".repeat(32)] }),
      async getTxHex(txid) {
        if (txid === "aa".repeat(32)) return Promise.reject(new Error("429"));
        throw new Error(`unexpected ${txid}`);
      },
    };
    const step = await scanStep(account, source, emptyScanStore(2), 2, 8);
    expect(step.progress.done).toBe(false);
    expect(step.store.lastHeight).toBe(1);
    expect(step.store.inflight?.height).toBe(2);
    expect(step.store.inflight?.nextTx).toBe(0);
  });

  it("credits a watched one-time output from a hint without waiting for sequential catch-up", async () => {
    const send =
      "020000000001016adc76da1ae0abb6050662c118f37341ffdddb7a32cc85ba3ef61418542fc26d0000000000ffffffff0240420f00000000002251203c8284b9fa541f6187f688982ac1a0e91c3de19a0f69d1bd069ac27c3847a6cdb453890000000000160014ee4fbefa4054af754130fbc8d71999e132ce5c8402473044022044d57365294352ca4ab4c0d7fa3a4f13142cde3fb9bad8e9a2ce24f2ae7476a502207002cf6e791bc6992901be2bcad942a192f34f69f1c300f67eba6549d8f305b401210328633a52a04265a2fe17b75b34211fcbf8f05f8b8fa7c10ce4bbe2f2d20e616800000000";
    const parsed = parseTxHex(send);
    const spk = "51203c8284b9fa541f6187f688982ac1a0e91c3de19a0f69d1bd069ac27c3847a6cd";
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2 }));
    const store = addWatch(emptyScanStore(10), { scriptPubKey: spk, tweak: "", label: null, k: 0, kind: "bip86", index: 0 });
    store.lastHeight = 10;
    store.tip = 10;
    const source: ChainSource = {
      ...fakeSource({}),
      async getTxHex(txid) {
        expect(txid).toBe(parsed.txid);
        return send;
      },
    };
    const next = await recoverWatchedFromHints(account, source, store, [{ txid: parsed.txid, height: 2231920 }]);
    const coin = next.utxos.find((u) => u.txid === parsed.txid && u.vout === 0);
    expect(coin?.kind).toBe("bip86");
    expect(coin?.index).toBe(0);
    expect(coin?.value).toBe("1000000");
    expect(coin?.height).toBe(2231920);
  });

  it("retries a failed tx hex, then steps past it without forgetting it", async () => {
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2 }));
    const source: ChainSource = {
      ...fakeSource({ 2: ["aa".repeat(32)] }),
      async getTxHex() {
        throw new Error("429");
      },
    };
    let store = emptyScanStore(2);
    for (let i = 1; i < SCAN_HEX_TRIES; i++) {
      const step = await scanStep(account, source, store, 2, 8);
      expect(step.progress.done).toBe(false);
      expect(step.store.lastHeight).toBe(1);
      expect(step.store.deferred?.[0]?.tries).toBe(i);
      store = step.store;
    }
    const done = await scanStep(account, source, store, 2, 8);
    expect(done.progress.done).toBe(true);
    expect(done.store.lastHeight).toBe(2);
    expect(done.store.inflight).toBeUndefined();
    expect(done.store.deferred?.[0]?.tries).toBe(SCAN_HEX_TRIES);
  });

  it("marks a confirmed watched coin spent when the indexer no longer lists it", () => {
    const script = "5120" + "ab".repeat(32);
    const store = {
      lastHeight: 10,
      utxos: [
        {
          txid: "cd".repeat(32),
          vout: 0,
          value: "30000000",
          scriptPubKey: script,
          tweak: "",
          label: null,
          k: 0,
          height: 2231920,
          spent: false,
          kind: "bip86" as const,
          index: 0,
        },
      ],
    };
    const next = markAbsentWatchSpent(store, script, new Set());
    expect(next.utxos[0]?.spent).toBe(true);
    const still = markAbsentWatchSpent(store, script, new Set(["cd".repeat(32)]));
    expect(still.utxos[0]?.spent).toBe(false);
  });

  it("lets a rate limit out of the scan instead of sitting on the same block", async () => {
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2 }));
    const source: ChainSource = {
      ...fakeSource({ 2: ["aa".repeat(32)] }),
      async getBlockTxids() {
        throw new RateLimitedError("request limit");
      },
    };
    await expect(scanStep(account, source, emptyScanStore(2), 2, 8)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("steps past a transaction that cannot be read", async () => {
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2 }));
    const source: ChainSource = {
      ...fakeSource({ 2: ["aa".repeat(32)] }),
      async getTxHex() {
        return "00";
      },
    };
    let store = emptyScanStore(2);
    for (let i = 1; i < SCAN_HEX_TRIES; i++) {
      const step = await scanStep(account, source, store, 2, 8);
      expect(step.store.lastHeight).toBe(1);
      store = step.store;
    }
    const done = await scanStep(account, source, store, 2, 8);
    expect(done.store.lastHeight).toBe(2);
    expect(done.progress.done).toBe(true);
  });

  it("uses the indexed input list and does not download each parent", async () => {
    const send =
      "020000000001016adc76da1ae0abb6050662c118f37341ffdddb7a32cc85ba3ef61418542fc26d0000000000ffffffff0240420f00000000002251203c8284b9fa541f6187f688982ac1a0e91c3de19a0f69d1bd069ac27c3847a6cdb453890000000000160014ee4fbefa4054af754130fbc8d71999e132ce5c8402473044022044d57365294352ca4ab4c0d7fa3a4f13142cde3fb9bad8e9a2ce24f2ae7476a502207002cf6e791bc6992901be2bcad942a192f34f69f1c300f67eba6549d8f305b401210328633a52a04265a2fe17b75b34211fcbf8f05f8b8fa7c10ce4bbe2f2d20e616800000000";
    const parsed = parseTxHex(send);
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2 }));
    let parentFetches = 0;
    const source: ChainSource = {
      ...fakeSource({}),
      async getTxHex() {
        parentFetches += 1;
        throw new Error("parent raw tx");
      },
      async listInputScripts(txid) {
        expect(txid).toBe(parsed.txid);
        return parsed.vin.map((vin) => ({
          txid: vin.txid,
          vout: vin.vout,
          scriptPubKey: "0014" + "11".repeat(20),
        }));
      },
    };
    const hits = await scanTransaction(account, source, send, 9);
    expect(hits).toEqual([]);
    expect(parentFetches).toBe(0);
  });

  it("reads a block transaction and its inputs in one pass", async () => {
    const send =
      "020000000001016adc76da1ae0abb6050662c118f37341ffdddb7a32cc85ba3ef61418542fc26d0000000000ffffffff0240420f00000000002251203c8284b9fa541f6187f688982ac1a0e91c3de19a0f69d1bd069ac27c3847a6cdb453890000000000160014ee4fbefa4054af754130fbc8d71999e132ce5c8402473044022044d57365294352ca4ab4c0d7fa3a4f13142cde3fb9bad8e9a2ce24f2ae7476a502207002cf6e791bc6992901be2bcad942a192f34f69f1c300f67eba6549d8f305b401210328633a52a04265a2fe17b75b34211fcbf8f05f8b8fa7c10ce4bbe2f2d20e616800000000";
    const parsed = parseTxHex(send);
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2 }));
    let hexCalls = 0;
    let inputCalls = 0;
    let open = 0;
    let overlapped = false;
    const source: ChainSource = {
      ...fakeSource({ 2: [parsed.txid] }),
      async getTxHex(txid) {
        open += 1;
        if (open > 1) overlapped = true;
        hexCalls += 1;
        await Promise.resolve();
        open -= 1;
        if (txid !== parsed.txid) throw new Error("parent raw tx");
        return send;
      },
      async listInputScripts(txid) {
        expect(txid).toBe(parsed.txid);
        open += 1;
        if (open > 1) overlapped = true;
        inputCalls += 1;
        await Promise.resolve();
        open -= 1;
        return parsed.vin.map((vin) => ({
          txid: vin.txid,
          vout: vin.vout,
          scriptPubKey: "0014" + "11".repeat(20),
        }));
      },
    };
    const step = await scanStep(account, source, emptyScanStore(2), 2, 8);
    expect(hexCalls).toBe(1);
    expect(inputCalls).toBe(1);
    expect(overlapped).toBe(true);
    expect(step.store.lastHeight).toBe(2);
    expect(step.progress.done).toBe(true);
  });

  it("credits a one-time output from the address index before the raw tx is fetched", () => {
    const script = "5120" + "11".repeat(32);
    const store = addWatch(emptyScanStore(10), { scriptPubKey: script, tweak: "", label: null, k: 0, kind: "bip86", index: 0 });
    const next = noteWatchedOutput(store, {
      txid: "ab".repeat(32),
      vout: 1,
      value: "50000000",
      scriptPubKey: script.toUpperCase(),
      height: 2232200,
    });
    const coin = next.utxos.find((u) => u.txid === "ab".repeat(32));
    expect(coin?.kind).toBe("bip86");
    expect(coin?.index).toBe(0);
    expect(coin?.value).toBe("50000000");
    expect(coin?.vout).toBe(1);
    expect(coin?.spent).toBe(false);
    expect(noteWatchedOutput(store, { txid: "cd".repeat(32), vout: 0, value: "1", scriptPubKey: "5120" + "22".repeat(32), height: 1 })).toBe(store);
  });

  it("takes back a one-time coin the indexer still lists when no spend transaction is named", () => {
    const script = "5120" + "11".repeat(32);
    const txid = "ab".repeat(32);
    let store = addWatch(emptyScanStore(10), { scriptPubKey: script, tweak: "", label: null, k: 0, kind: "bip86", index: 0 });
    store = noteWatchedOutput(store, { txid, vout: 1, value: "50000000", scriptPubKey: script, height: 12 });
    store = { ...store, utxos: store.utxos.map((u) => ({ ...u, spent: true })) };
    const revived = noteWatchedOutput(store, { txid, vout: 1, value: "50000000", scriptPubKey: script, height: 12 });
    expect(revived.utxos.find((u) => u.txid === txid)?.spent).toBe(false);
    const spent = { ...store, utxos: store.utxos.map((u) => ({ ...u, spent: true, spentBy: "ff".repeat(32) })) };
    expect(noteWatchedOutput(spent, { txid, vout: 1, value: "50000000", scriptPubKey: script, height: 12 }).utxos[0]?.spent).toBe(true);
  });
});
