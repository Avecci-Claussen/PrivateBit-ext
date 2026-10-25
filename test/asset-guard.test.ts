// 1.0.0 asset guard: small Taproot coins may hold an inscription or rune, so the wallet never
// spends them by itself. No detection is faked: only the user's ord server can clear one.
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { ChainSource } from "../src/lib/chain.ts";
import { spendSecret, taprootScriptPubKey } from "../src/lib/bip352.ts";
import { hex } from "../src/lib/bytes.ts";
import { ASSET_PROTECT_MAX_SATS, coinStatus, mayHoldAsset, ordOutputVerdict, protectedOutpoints } from "../src/lib/coinmeta.ts";
import type { accountFromVault } from "../src/lib/keys.ts";
import { upsertUtxo, type LabeledUtxo } from "../src/lib/scan.ts";
import { evenPriv, sessionTweak } from "../src/lib/schnorr-util.ts";
import { memoryKv } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";

const TR = "5120" + "ab".repeat(32);
const u = (value: number, spk = TR): LabeledUtxo => ({ txid: "aa".repeat(32), vout: 0, value: String(value), scriptPubKey: spk, tweak: "00".repeat(32), label: null, k: 0, height: 8, spent: false });

describe("which coins are protected", () => {
  it("330, 546 and 10,000 sat Taproot coins are; larger or non Taproot coins are not", () => {
    for (const v of [330, 546, 1000, 10_000]) expect(mayHoldAsset(u(v))).toBe(true);
    expect(ASSET_PROTECT_MAX_SATS).toBe(10_000n);
    expect(mayHoldAsset(u(10_001))).toBe(false);
    expect(mayHoldAsset(u(546, "0014" + "ab".repeat(20)))).toBe(false);
  });
  it("a hand unlock or a clear ord answer lifts it; an ord 'held' answer protects even a big coin", () => {
    expect(mayHoldAsset(u(546), { assetOk: true })).toBe(false);
    expect(mayHoldAsset(u(546), { asset: "none" })).toBe(false);
    expect(mayHoldAsset(u(90_000), { asset: "held" })).toBe(true);
    expect(mayHoldAsset(u(90_000), { asset: "held", assetOk: true })).toBe(false);
    expect(coinStatus(u(546), {}, new Set())).toBe("protected");
    expect(coinStatus(u(546), { [`${"aa".repeat(32)}:0`]: { frozen: true } }, new Set())).toBe("frozen");
    expect(protectedOutpoints([u(546), { ...u(546), spent: true }], {}).size).toBe(1);
  });
  it("reads ord /output answers conservatively", () => {
    expect(ordOutputVerdict({ indexed: true, inscriptions: [], runes: {} })).toBe("none");
    expect(ordOutputVerdict({ indexed: true, inscriptions: [], runes: [] })).toBe("none");
    expect(ordOutputVerdict({ indexed: false, inscriptions: [], runes: {} })).toBeUndefined();
    expect(ordOutputVerdict({ inscriptions: ["x".repeat(64) + "i0"], runes: {} })).toBe("held");
    expect(ordOutputVerdict({ indexed: true, inscriptions: [], runes: { "UNCOMMON•GOODS": { amount: 1 } } })).toBe("held");
    expect(ordOutputVerdict({ indexed: true, inscriptions: [], runes: [["A", { amount: 1 }]] })).toBe("held");
    expect(ordOutputVerdict("<html>")).toBeUndefined();
    expect(ordOutputVerdict({ indexed: true })).toBeUndefined();
  });
});

function coinFor(account: ReturnType<typeof accountFromVault>, txid: string, value: string): LabeledUtxo {
  const tweak = sessionTweak(txid, 0);
  const d = evenPriv(spendSecret({ spendSecret: account.spendSecret, tweak, label: null, scanSecret: account.scanSecret }));
  return { txid, vout: 0, value, scriptPubKey: hex(taprootScriptPubKey(secp256k1.getPublicKey(d, true).slice(1))), tweak: hex(tweak), label: null, k: 0, height: 8, spent: false };
}
const source: ChainSource = {
  kind: "unisat",
  getTip: async () => ({ height: 10, hash: "00" }),
  getBlockHash: async () => "00",
  getBlockTxids: async () => [],
  getTxHex: async () => {
    throw new Error("no parent");
  },
  broadcast: async () => {
    throw new Error("never broadcast in this test");
  },
  estimateFeeSatPerVb: async () => 1,
};

async function setup() {
  const w = new PrivateBit(memoryKv());
  w.sourceOverride = source;
  await w.create({ password: "password1", birthday: 8 });
  const { account, scan } = await w.requireAccount();
  const big = coinFor(account, "b1".repeat(32), "80000");
  const ins = coinFor(account, "c1".repeat(32), "546");
  const ten = coinFor(account, "d1".repeat(32), "10000");
  for (const c of [big, ins, ten]) upsertUtxo(scan.utxos, c);
  await w.saveScan(scan);
  const to = new PrivateBit(memoryKv());
  await to.create({ password: "password1", birthday: 8 });
  const dest = (await to.requireAccount()).account.receive;
  const op = (c: LabeledUtxo) => `${c.txid}:${c.vout}`;
  return { w, dest, big: op(big), ins: op(ins), ten: op(ten) };
}

describe("the wallet never spends a protected coin by itself", () => {
  it("automatic selection, Max and the balance leave them out; Coins shows them as protected", async () => {
    const { w, dest, big, ins, ten } = await setup();
    for (let i = 0; i < 6; i++) {
      const p = await w.planSend(dest, 79_000n, { feeRate: 1 });
      const used = p.signableInputs.map((x) => `${x.txid}:${x.vout}`);
      expect(used).toEqual([big]);
    }
    await expect(w.planSend(dest, 85_000n, { feeRate: 1 })).rejects.toThrow();
    const max = await w.maxAmount(1);
    expect(BigInt(max.amount) + BigInt(max.fee)).toBe(80_000n);
    const coins = await w.coins();
    expect(coins.find((c) => c.outpoint === ins)?.status).toBe("protected");
    expect(coins.find((c) => c.outpoint === ten)?.status).toBe("protected");
    expect(coins.find((c) => c.outpoint === big)?.status).toBe("private");
  });
  it("choosing a protected coin by hand is refused until it is unlocked", async () => {
    const { w, dest, ins } = await setup();
    await expect(w.planSend(dest, 1_000n, { feeRate: 1, coins: [ins] })).rejects.toThrow(/protected/);
    await w.setCoinMeta(ins, { assetOk: true });
    const p = await w.planSend(dest, 300n, { feeRate: 1, coins: [ins] }).catch((e: Error) => e);
    // Unlocked: the refusal is gone (a 546 sat coin may still be too small for the amount and fee).
    expect(p instanceof Error ? p.message : "").not.toMatch(/protected/);
  });
  it("a payment link never reserves a protected coin", async () => {
    const { w, ins, ten } = await setup();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("network disabled");
    }) as typeof fetch;
    try {
      await w.offerPayjoin(1000n).catch(() => undefined);
      const s = (await w.loadPayjoinSessions())[0];
      if (s?.reserved) expect([ins, ten]).not.toContain(`${s.reserved.txid}:${s.reserved.vout}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("only the user's ord server clears a coin, and only when asked", async () => {
    const { w, ins } = await setup();
    await expect(w.checkCoinAsset(ins)).rejects.toThrow(/ord server/);
    await w.saveChain({ ...(await w.loadChain()), ordUrl: "http://127.0.0.1:8080/" });
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ indexed: true, inscriptions: [], runes: {} }), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await w.checkCoinAsset(ins)).toBe("none");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(asked).toEqual([`http://127.0.0.1:8080/output/${ins}`]);
    expect((await w.coins()).find((c) => c.outpoint === ins)?.status).toBe("private");
  });
});
