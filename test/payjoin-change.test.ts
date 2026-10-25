import { describe, expect, it } from "vitest";
import type { ChainSource } from "../src/lib/chain.ts";
import { MemoryDirectory } from "../src/lib/mailbox.ts";
import { DEFAULT_PAYJOIN_DIRECTORY } from "../src/lib/payjoin.ts";
import { INTENT_PAYJOIN } from "../src/lib/policy.ts";
import { spendSecret, taprootScriptPubKey } from "../src/lib/bip352.ts";
import { hex } from "../src/lib/bytes.ts";
import type { accountFromVault } from "../src/lib/keys.ts";
import {
  applySharedSlice,
  applyTxHex,
  emptyScanStore,
  spendableBalance,
  upsertUtxo,
  type LabeledUtxo,
} from "../src/lib/scan.ts";
import { parseTxHex, taprootOutputs } from "../src/lib/tx.ts";
import { evenPriv, sessionTweak } from "../src/lib/schnorr-util.ts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { PrivateBit } from "../src/lib/wallet.ts";
import { memoryKv } from "../src/lib/vault.ts";

/** A chain that knows the funding coins and every broadcast, and lists input scripts like UniSat. */
function chain() {
  const scripts = new Map<string, string>();
  const txs = new Map<string, string>();
  const broadcasts: string[] = [];
  const source: ChainSource = {
    kind: "unisat",
    async getTip() {
      return { height: 10, hash: "00" };
    },
    async getBlockHash() {
      return "00";
    },
    async getBlockTxids() {
      return [];
    },
    async getTxHex(id: string) {
      const t = txs.get(id);
      if (!t) throw new Error("no parent");
      return t;
    },
    async listInputScripts(id: string) {
      const t = parseTxHex(txs.get(id)!);
      return t.vin.map((v) => ({
        txid: v.txid,
        vout: v.vout,
        scriptPubKey: scripts.get(`${v.txid}:${v.vout}`)!,
      }));
    },
    async broadcast(txHex: string) {
      const t = parseTxHex(txHex);
      txs.set(t.txid, txHex);
      broadcasts.push(txHex);
      return t.txid;
    },
    async estimateFeeSatPerVb() {
      return 1;
    },
  };
  return { source, scripts, broadcasts };
}

function coinFor(
  account: ReturnType<typeof accountFromVault>,
  txid: string,
  value: string,
): LabeledUtxo {
  const tweak = sessionTweak(txid, 0);
  const d = evenPriv(
    spendSecret({
      spendSecret: account.spendSecret,
      tweak,
      label: null,
      scanSecret: account.scanSecret,
    }),
  );
  const xonly = secp256k1.getPublicKey(d, true).slice(1);
  return {
    txid,
    vout: 0,
    value,
    scriptPubKey: hex(taprootScriptPubKey(xonly)),
    tweak: hex(tweak),
    label: null,
    k: 0,
    height: 8,
    spent: false,
  };
}

async function wallet(
  dir: MemoryDirectory,
  c: ReturnType<typeof chain>,
  coinTxid: string,
  value: string,
) {
  const w = new PrivateBit(memoryKv(), {
    kind: "unisat",
    url: "https://open-api-fractal.unisat.io",
    payjoinDirectory: DEFAULT_PAYJOIN_DIRECTORY,
  });
  w.mailboxTransport = dir.ohttpTransport();
  w.ohttpConfig = dir.ohttp;
  w.sourceOverride = c.source;
  await w.create({ password: "pw", birthday: 8 });
  const { account, scan } = await w.requireAccount();
  const coin = coinFor(account, coinTxid, value);
  c.scripts.set(`${coin.txid}:0`, coin.scriptPubKey);
  upsertUtxo(scan.utxos, coin);
  await w.saveScan(scan);
  return { w, account, coin };
}

async function payjoin() {
  const dir = new MemoryDirectory();
  const c = chain();
  const receiver = await wallet(dir, c, "a1".repeat(32), "50000");
  const sender = await wallet(dir, c, "b1".repeat(32), "10000000");
  const link = await receiver.w.offerPayjoin(10_000n);
  const built = await sender.w.planSend(link.bip21, 10_000n);
  expect(built.change > 0n).toBe(true);
  const pending = await sender.w.broadcast(INTENT_PAYJOIN, built);
  expect(pending.kind).toBe("payjoin-pending");
  expect((await receiver.w.servicePayjoin()).errors).toEqual([]);
  const svc = await sender.w.servicePayjoin();
  expect(svc.errors).toEqual([]);
  const done = (await sender.w.loadPayjoinSends())[0]!;
  expect(done.status).toBe("done");
  expect(c.broadcasts.length).toBe(1);
  return {
    c,
    receiver,
    sender,
    built,
    txid: done.txid!,
    txHex: c.broadcasts[0]!,
  };
}

describe("Payjoin sender change", () => {
  it("the receiver's added input really changes the tx (sender change is not found from all inputs)", async () => {
    const { txHex, sender } = await payjoin();
    expect(parseTxHex(txHex).vin.length).toBe(2);
    expect(sender.coin.txid).toBeTruthy();
  });

  it("keeps the sender's change in coins and balance right after the Payjoin", async () => {
    const { sender, built, txid } = await payjoin();
    const scan = await sender.w.loadScan();
    const change = scan.utxos.filter((u) => u.txid === txid && !u.spent);
    expect(change.length).toBe(1);
    expect(BigInt(change[0]!.value)).toBe(built.change);
    expect(spendableBalance(scan)).toBe(built.change);
  });

  it("records the change in history so details show Back to you", async () => {
    const { sender, built, txid } = await payjoin();
    const e = (await sender.w.loadHistory()).entries[txid]!;
    expect(e.kind).toBe("payjoin-sent");
    expect(e.change).toBe(built.change.toString());
    expect(e.outpoints?.some((op) => op.startsWith(txid + ":"))).toBe(true);
  });

  it("a rescan finds the change from the spent coin alone (restore or Finding coins)", async () => {
    const { sender, built, txHex, c } = await payjoin();
    const store = emptyScanStore(8);
    upsertUtxo(store.utxos, { ...sender.coin });
    const next = await applyTxHex(sender.account, c.source, store, txHex, 11);
    const txid = parseTxHex(txHex).txid;
    const change = next.utxos.filter((u) => u.txid === txid && !u.spent);
    expect(change.map((u) => BigInt(u.value))).toEqual([built.change]);
    expect(change[0]!.height).toBe(11);
  });

  it("the receiver is unaffected and does not pick up the sender's change", async () => {
    const { receiver, txid, built, txHex, c } = await payjoin();
    const scan = await applyTxHex(
      receiver.account,
      c.source,
      await receiver.w.loadScan(),
      txHex,
      11,
    );
    const values = scan.utxos
      .filter((u) => u.txid === txid && !u.spent)
      .map((u) => BigInt(u.value));
    expect(values).not.toContain(built.change);
    expect(values.length).toBeGreaterThan(0);
  });

  it("recovers change that an older version never added, on the next sync", async () => {
    const { sender, built, txid, c } = await payjoin();
    // State left by 1.0.0: input spent, no change coin, history row without change.
    const scan = await sender.w.loadScan();
    scan.utxos = scan.utxos.filter((u) => u.txid !== txid);
    await sender.w.saveScan(scan);
    const hist = await sender.w.loadHistory();
    delete hist.entries[txid]!.change;
    hist.entries[txid]!.outpoints = hist.entries[txid]!.outpoints.filter(
      (op) => !op.startsWith(txid),
    );
    await sender.w.saveHistory(hist);
    expect(spendableBalance(await sender.w.loadScan())).toBe(0n);

    // Audit M8 (independent): public mode asks the block explorer once, without any token.
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization|bearer/i);
      if (url.endsWith(`/api/tx/${txid}/hex`)) return new Response(c.broadcasts[0]!, { status: 200 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (sender.w as any).current.recoverPayjoinChange(sender.account, c.source);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sender.w as any).current.changeChecked.clear();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (sender.w as any).current.recoverPayjoinChange(sender.account, c.source);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(asked).toEqual([`https://mempool.fractalbitcoin.io/api/tx/${txid}/hex`]);
    expect(spendableBalance(await sender.w.loadScan())).toBe(built.change);
    expect((await sender.w.loadHistory()).entries[txid]!.change).toBe(
      built.change.toString(),
    );
    expect(c.broadcasts.length).toBe(1);
  });

  it("the block scanner (shared blocks) finds the change on a rescan too", async () => {
    const { sender, built, txHex } = await payjoin();
    const tx = parseTxHex(txHex);
    const store = emptyScanStore(8);
    store.lastHeight = 10;
    upsertUtxo(store.utxos, { ...sender.coin });
    // Slice from tx 1 (a filler tx 0) so the synthetic block skips the reorg check.
    const again = applySharedSlice(
      sender.account,
      store,
      {
        height: 11,
        hash: "11".repeat(32),
        prev: "",
        txs: [
          { txid: "00".repeat(32), inputs: [], taps: [], eligible: [] },
          ...[
            {
              txid: tx.txid,
              inputs: tx.vin.map((v) => ({ txid: v.txid, vout: v.vout })),
              taps: taprootOutputs(tx).map((t) => ({
                vout: t.vout,
                value: t.value.toString(),
                xonly: hex(t.xonly),
              })),
              eligible: [],
            },
          ],
        ],
      },
      1,
      11,
    ).store;
    const change = again.utxos.filter((u) => u.txid === tx.txid && !u.spent);
    expect(change.map((u) => BigInt(u.value))).toEqual([built.change]);
    expect(again.utxos.find((u) => u.txid === sender.coin.txid)?.spent).toBe(
      true,
    );
  });
});
