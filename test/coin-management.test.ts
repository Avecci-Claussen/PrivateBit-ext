// Coin management: one coin first, no-change sending, random output order, change that blends in,
// held (delayed) payments, and the split helpers.
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { ChainSource } from "../src/lib/chain.ts";
import { spendSecret, taprootScriptPubKey } from "../src/lib/bip352.ts";
import { hex } from "../src/lib/bytes.ts";
import { coinSelect, DUST, feeFor, leftoverLimit } from "../src/lib/coinselect.ts";
import type { accountFromVault } from "../src/lib/keys.ts";
import {
  deRoundChange,
  jitterFeeRate,
  looksRound,
  newPlanSeed,
  randomDelayMs,
  randomSplitAmounts,
  seedBytes,
  shuffleOutputs,
} from "../src/lib/plan-random.ts";
import { normalizePrefs } from "../src/lib/prefs.ts";
import { upsertUtxo, type LabeledUtxo } from "../src/lib/scan.ts";
import { evenPriv, sessionTweak } from "../src/lib/schnorr-util.ts";
import { groupInputLabels, mergesLabels } from "../src/lib/send.ts";
import { checkSplit } from "../src/lib/split.ts";
import { memoryKv } from "../src/lib/vault.ts";
import { PrivateBit, INTENT_PAYJOIN, INTENT_SIMPLE_SEND } from "../src/lib/wallet.ts";

const utxo = (txid: string, value: number, height = 8): LabeledUtxo => ({
  txid: txid.padEnd(64, "0"),
  vout: 0,
  value: String(value),
  scriptPubKey: "51".padEnd(68, "0"),
  tweak: "00".repeat(32),
  label: null,
  k: 0,
  height,
  spent: false,
});

describe("coin selection", () => {
  it("spends one coin that covers the payment with no change before anything else", () => {
    const coins = [utxo("a", 100_000), utxo("b", 10_400), utxo("c", 6_000), utxo("d", 5_000)];
    const s = coinSelect(coins, 10_000n, 1);
    expect(s.inputs.map((u) => u.txid[0])).toEqual(["b"]);
    expect(s.change).toBe(0n);
    expect(s.changeless?.extra).toBe(10_400n - 10_000n - feeFor(1, 1, 1));
  });

  it("with change needed, picks the single coin that leaves the least change", () => {
    const coins = [utxo("a", 100_000), utxo("b", 30_000), utxo("c", 6_000)];
    const s = coinSelect(coins, 20_000n, 1);
    expect(s.inputs.map((u) => u.txid[0])).toEqual(["b"]);
    expect(s.change).toBe(30_000n - 20_000n - feeFor(1, 2, 1));
  });

  it("only merges coins when no single coin is enough", () => {
    const coins = [utxo("a", 9_000), utxo("b", 8_000), utxo("c", 2_000)];
    const s = coinSelect(coins, 15_000n, 1);
    expect(s.inputs.length).toBe(2);
    expect(s.inputs.map((u) => u.txid[0]).sort()).toEqual(["a", "b"]);
  });

  it("keeps exactly the coins the user picked", () => {
    const coins = [utxo("a", 9_000), utxo("b", 80_000)];
    const s = coinSelect(coins, 5_000n, 1, 1, { include: [`${"a".padEnd(64, "0")}:0`] });
    expect(s.inputs.map((u) => u.txid[0])).toEqual(["a"]);
  });
});

describe("no-change sending", () => {
  it("auto limit is about what spending the change later would cost, at least 1000 sats", () => {
    expect(leftoverLimit(1)).toBe(1000n);
    expect(leftoverLimit(20)).toBe(2010n);
    expect(leftoverLimit(5, 0)).toBe(DUST);
    expect(leftoverLimit(5, 2500)).toBe(2500n);
  });

  it("a leftover under the limit goes to the fee; at or over it, a change output is made", () => {
    const small = coinSelect([utxo("a", 10_900)], 10_000n, 1, 1, { leftover: 1000n });
    expect(small.change).toBe(0n);
    expect(small.fee).toBe(900n);
    const big = coinSelect([utxo("a", 12_000)], 10_000n, 1, 1, { leftover: 1000n });
    expect(big.change).toBeGreaterThan(1000n);
    expect(big.changeless).toBeUndefined();
  });

  it("a limit of 0 still never makes a dust change output", () => {
    const s = coinSelect([utxo("a", 10_300)], 10_000n, 1, 1, { leftover: DUST });
    expect(s.change).toBe(0n);
  });

  it("prefs keep only known choices", () => {
    expect(normalizePrefs({}).leftover).toBe("auto");
    expect(normalizePrefs({ leftover: 2500 }).leftover).toBe(2500);
    expect(normalizePrefs({ leftover: 7 }).leftover).toBe("auto");
    expect(normalizePrefs({ sendDelay: "10m" }).sendDelay).toBe("10m");
    expect(normalizePrefs({ sendDelay: "2d" }).sendDelay).toBe("off");
    expect(normalizePrefs({}).randomizeFee).toBe(false);
  });
});

describe("plan randomness", () => {
  it("output order is a seeded shuffle: same seed same order, both orders happen", () => {
    const seed = newPlanSeed();
    expect(shuffleOutputs(["pay", "change"], seed)).toEqual(shuffleOutputs(["pay", "change"], seed));
    const firsts = new Set<string>();
    for (let i = 0; i < 64; i++) firsts.add(shuffleOutputs(["pay", "change"], newPlanSeed())[0]!);
    expect(firsts).toEqual(new Set(["pay", "change"]));
  });

  it("the shuffle is a permutation and spreads over positions", () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 400; i++) {
      const out = shuffleOutputs([0, 1, 2, 3], newPlanSeed());
      expect([...out].sort()).toEqual([0, 1, 2, 3]);
      counts[out.indexOf(0)]!++;
    }
    for (const c of counts) expect(c).toBeGreaterThan(50);
  });

  it("seed streams are separate per purpose", () => {
    const seed = newPlanSeed();
    expect(hex(seedBytes(seed, "a"))).not.toBe(hex(seedBytes(seed, "b")));
    expect(seedBytes(seed, "a", 70).length).toBe(70);
  });

  it("fee nudge stays within 5% and never under the minimum", () => {
    for (let i = 0; i < 100; i++) {
      const r = jitterFeeRate(10, newPlanSeed(), 1);
      expect(r).toBeGreaterThanOrEqual(9.5);
      expect(r).toBeLessThanOrEqual(10.5);
    }
    for (let i = 0; i < 50; i++) expect(jitterFeeRate(2, newPlanSeed(), 2)).toBeGreaterThanOrEqual(2);
    const seed = newPlanSeed();
    expect(jitterFeeRate(7, seed, 1)).toBe(jitterFeeRate(7, seed, 1));
  });

  it("round change gets a few sats moved to the fee, never more than allowed", () => {
    expect(looksRound(5_000n)).toBe(true);
    expect(looksRound(5_123n)).toBe(false);
    for (let i = 0; i < 50; i++) {
      const extra = deRoundChange(50_000n, 40n, newPlanSeed());
      expect(extra).toBeGreaterThan(0n);
      expect(extra).toBeLessThanOrEqual(40n);
      expect(looksRound(50_000n - extra)).toBe(false);
    }
    expect(deRoundChange(50_000n, 0n, newPlanSeed())).toBe(0n);
    expect(deRoundChange(5_123n, 40n, newPlanSeed())).toBe(0n);
  });

  it("random delays land between 10% and 100% of the chosen wait", () => {
    expect(randomDelayMs("off")).toBe(0);
    for (let i = 0; i < 50; i++) {
      const d = randomDelayMs("10m");
      expect(d).toBeGreaterThanOrEqual(60_000);
      expect(d).toBeLessThanOrEqual(600_000);
    }
  });
});

describe("merge warning trigger", () => {
  const ops = ["a:0", "b:0", "c:0"];
  it("one label, or none at all, is no warning", () => {
    expect(mergesLabels(groupInputLabels(ops, () => undefined))).toBe(false);
    expect(mergesLabels(groupInputLabels(ops, () => "Alice"))).toBe(false);
    expect(mergesLabels(groupInputLabels(["a:0"], () => "Alice"))).toBe(false);
  });
  it("different labels, or labelled with unlabelled, warns and lists each group", () => {
    const g = groupInputLabels(ops, (op) => ({ "a:0": "Alice", "b:0": "alice " })[op]);
    expect(mergesLabels(g)).toBe(true);
    expect(g.map((x) => x.label)).toEqual(["Alice", null]);
    expect(g[0]!.outpoints).toEqual(["a:0", "b:0"]);
    const h = groupInputLabels(ops, (op) => ({ "a:0": "Alice", "b:0": "Shop" })[op]);
    expect(h.map((x) => x.label)).toEqual(["Alice", "Shop", null]);
  });
});

describe("split amounts", () => {
  it("random amounts are distinct, above dust and add up exactly", () => {
    for (let n = 2; n <= 6; n++) {
      for (let i = 0; i < 20; i++) {
        const total = 200_000n + BigInt(i * 977);
        const parts = randomSplitAmounts(total, n, crypto.getRandomValues(new Uint8Array(8 * n)));
        expect(parts.length).toBe(n);
        expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
        expect(new Set(parts.map(String)).size).toBe(n);
        for (const p of parts) expect(p).toBeGreaterThanOrEqual(DUST);
        expect(checkSplit(parts, total).ok).toBe(true);
      }
    }
  });
});

/* ---------- real wallet: planned sends and held payments ---------- */

function coinFor(account: ReturnType<typeof accountFromVault>, txid: string, value: string): LabeledUtxo {
  const tweak = sessionTweak(txid, 0);
  const d = evenPriv(spendSecret({ spendSecret: account.spendSecret, tweak, label: null, scanSecret: account.scanSecret }));
  return { txid, vout: 0, value, scriptPubKey: hex(taprootScriptPubKey(secp256k1.getPublicKey(d, true).slice(1))), tweak: hex(tweak), label: null, k: 0, height: 8, spent: false };
}

function fakeSource(sent: string[], fail?: () => Error | undefined): ChainSource {
  return {
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
    async getTxHex() {
      throw new Error("no parent");
    },
    async broadcast(txHex: string) {
      const e = fail?.();
      if (e) throw e;
      // Recorded in memory only. Nothing leaves this test.
      sent.push(txHex);
      return "f0".repeat(32);
    },
    async estimateFeeSatPerVb() {
      return 1;
    },
  };
}

/** Memory storage that also lists its live key names, to check what is (not) written. */
function trackedKv() {
  const inner = memoryKv();
  const live = new Set<string>();
  const kv: typeof inner & { live: Set<string> } = {
    live,
    get: (keys) => inner.get(keys),
    async set(items) {
      for (const k of Object.keys(items)) live.add(k);
      await inner.set(items);
    },
    async remove(keys) {
      for (const k of keys) live.delete(k);
      await inner.remove(keys);
    },
  };
  return kv;
}
const grants = (kv: { live: Set<string> }, net: "fractal" | "bitcoin") =>
  [...kv.live].filter((k) => k.endsWith("scan.grant") && k.includes(".btc.") === (net === "bitcoin"));

async function wallet(coins: [string, string][], sent: string[] = [], fail?: () => Error | undefined) {
  const kv = trackedKv();
  const w = new PrivateBit(kv);
  w.sourceOverride = fakeSource(sent, fail);
  await w.create({ password: "password1", birthday: 8 });
  const { account, scan } = await w.requireAccount();
  for (const [txid, value] of coins) upsertUtxo(scan.utxos, coinFor(account, txid, value));
  await w.saveScan(scan);
  const to = new PrivateBit(memoryKv());
  await to.create({ password: "password1", birthday: 8 });
  const dest = (await to.requireAccount()).account.receive;
  return { w, kv, dest, sent };
}

describe("planned sends", () => {
  it("change sits at a random position and the reviewed order is kept on Confirm", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "80000"]]);
    const positions = new Set<number>();
    for (let i = 0; i < 24; i++) {
      const p = await w.plan(dest, 20_000n, { feeRate: 2 });
      const c = await w.confirmPlan(p.planId!, dest, 20_000n, { feeRate: 2, seed: p.seed });
      expect(c.ok).toBe(true);
      if (c.ok) {
        expect(c.built.ourOutputs.length).toBe(1);
        positions.add(c.built.ourOutputs[0]!.vout);
      }
    }
    expect(positions).toEqual(new Set([0, 1]));
  });

  it("a small leftover becomes fee and the review says how much", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "20500"]]);
    const p = await w.plan(dest, 20_000n, { feeRate: 1 });
    expect(p.changeless?.extra).toBeDefined();
    expect(BigInt(p.change)).toBe(0n);
    expect(BigInt(p.fee)).toBe(500n);
    expect(BigInt(p.changeless!.extra)).toBe(500n - feeFor(1, 1, 1));
  });

  it("round change is nudged by a few sats of extra fee; the payment amount never moves", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "100000"]]);
    // 100000 - 50000 - fee(1 in, 2 out at 2 sat/vB) would be a near round change only by chance;
    // pick an amount that makes it exactly round.
    const fee = feeFor(1, 2, 2);
    const amount = 100_000n - 40_000n - fee;
    const p = await w.plan(dest, amount, { feeRate: 2 });
    expect(BigInt(p.amount)).toBe(amount);
    expect(looksRound(BigInt(p.change))).toBe(false);
    expect(40_000n - BigInt(p.change)).toBeLessThanOrEqual(20n);
  });
});

describe("delayed sending", () => {
  async function held() {
    const ctx = await wallet([["a1".repeat(32), "80000"], ["b2".repeat(32), "70000"]]);
    const p = await ctx.w.plan(ctx.dest, 10_000n, { feeRate: 2 });
    const c = await ctx.w.confirmPlan(p.planId!, ctx.dest, 10_000n, { feeRate: 2, seed: p.seed });
    if (!c.ok) throw new Error("plan changed");
    const r = await ctx.w.broadcast(INTENT_SIMPLE_SEND, c.built, { label: "Rent", feeRate: 2, holdMs: 600_000 });
    if (r.kind !== "delayed") throw new Error("not held");
    return { ...ctx, p, r, built: c.built };
  }

  it("nothing is broadcast while held, and the coins are reserved", async () => {
    const { w, sent, p, r } = await held();
    expect(sent.length).toBe(0);
    expect(r.sendAt).toBeGreaterThan(Date.now() + 500_000);
    const { reserved } = await w.blockedOutpoints();
    for (const op of p.inputs) expect(reserved.has(op)).toBe(true);
    const view = await w.delayedView();
    expect(view.length).toBe(1);
    expect(view[0]).not.toHaveProperty("txHex");
  });

  it("survives a restart: a new wallet object on the same storage still has it, sealed", async () => {
    const { kv, sent, r } = await held();
    const raw = JSON.stringify(await kv.get(["privatebit.delayed"]));
    expect(raw).not.toMatch(/Rent/);
    const again = new PrivateBit(kv);
    again.sourceOverride = fakeSource(sent);
    const list = await again.loadDelayed();
    expect(list.map((d) => d.id)).toEqual([r.id]);
  });

  it("cancel is safe: nothing was sent and the coins are free again", async () => {
    const { w, sent, p, r } = await held();
    expect(await w.cancelDelayed(r.id)).toBe(true);
    expect(sent.length).toBe(0);
    expect((await w.delayedView()).length).toBe(0);
    const { reserved } = await w.blockedOutpoints();
    for (const op of p.inputs) expect(reserved.has(op)).toBe(false);
    expect(await w.cancelDelayed(r.id)).toBe(false);
  });

  it("is sent when due, once, and recorded in history", async () => {
    const { w, sent, r } = await held();
    expect((await w.runDelayed({ now: r.sendAt - 1 })).sent).toEqual([]);
    const out = await w.runDelayed({ now: r.sendAt + 1 });
    expect(out.sent).toEqual([r.id]);
    expect(sent.length).toBe(1);
    expect((await w.runDelayed({ now: r.sendAt + 10 })).sent).toEqual([]);
    expect(sent.length).toBe(1);
    const hist = await w.history();
    expect(JSON.stringify(hist)).toMatch(/f0f0/);
    expect((await w.delayedView()).length).toBe(0);
  });

  it("Send now goes right away; cancel after that does nothing", async () => {
    const { w, sent, r } = await held();
    expect((await w.runDelayed({ only: r.id })).sent).toEqual([r.id]);
    expect(sent.length).toBe(1);
    expect(await w.cancelDelayed(r.id)).toBe(false);
  });

  it("after Lock the worker still sends it; history is written at the next unlock", async () => {
    const { w, sent, r } = await held();
    await w.lock();
    const out = await w.runDelayed({ now: r.sendAt + 1 });
    expect(out.sent).toEqual([r.id]);
    expect(sent.length).toBe(1);
    await w.unlock("password1");
    await w.finishDelayedRecords();
    expect(JSON.stringify(await w.history())).toMatch(/f0f0/);
    expect((await w.delayedView()).length).toBe(0);
  });

  it("keeps its own time on its chain: switching chains does not send it, it goes out when due", async () => {
    const { w, kv, sent, r } = await held();
    await w.setNetwork("bitcoin");
    expect(sent.length).toBe(0);
    expect(await w.delayedView()).toEqual([]);
    const other = await w.delayedElsewhere();
    expect(other).toEqual([{ net: "fractal", count: 1, next: r.sendAt }]);
    expect((await w.runDelayed({ now: r.sendAt - 1 })).sent).toEqual([]);
    expect(sent.length).toBe(0);
    // After a browser restart and an unlock on the other chain it still goes out on time.
    expect(grants(kv, "fractal").length).toBe(1);
    await kv.remove(grants(kv, "fractal"));
    const again = new PrivateBit(kv);
    again.sourceOverride = w.sourceOverride;
    await again.setNetwork("bitcoin");
    await again.unlock("password1");
    const out = await again.runDelayed({ now: r.sendAt + 1 });
    expect(out.sent).toEqual([r.id]);
    expect(sent.length).toBe(1);
    await again.setNetwork("fractal");
    await again.finishDelayedRecords();
    expect((await again.delayedView()).length).toBe(0);
    expect([...kv.live].some((k) => k.endsWith("delayed") && !k.includes(".btc."))).toBe(false);
  });

  it("a chain without held payments gets no scan grant at unlock", async () => {
    const { w, kv } = await wallet([["a1".repeat(32), "80000"]]);
    await w.setNetwork("bitcoin");
    await w.unlock("password1");
    // Fractal had a grant from create; drop it as a browser restart would, then unlock on Bitcoin.
    expect(grants(kv, "fractal").length).toBe(1);
    await kv.remove(grants(kv, "fractal"));
    await w.lock();
    await w.unlock("password1");
    expect(grants(kv, "fractal")).toEqual([]);
    expect(grants(kv, "bitcoin").length).toBe(1);
    expect(await w.delayedElsewhere()).toEqual([]);
  });

  it("a network hiccup keeps it held and tries again; a rejection is shown as not sent", async () => {
    let mode: "net" | "reject" | "ok" = "net";
    const ctx = await wallet([["a1".repeat(32), "80000"]], [], () =>
      mode === "net" ? new Error("Failed to fetch") : mode === "reject" ? new Error("bad-txns-inputs-missingorspent") : undefined,
    );
    const p = await ctx.w.plan(ctx.dest, 10_000n, { feeRate: 2 });
    const c = await ctx.w.confirmPlan(p.planId!, ctx.dest, 10_000n, { feeRate: 2, seed: p.seed });
    if (!c.ok) throw new Error("plan changed");
    const r = await ctx.w.broadcast(INTENT_SIMPLE_SEND, c.built, { feeRate: 2, holdMs: 1000 });
    if (r.kind !== "delayed") throw new Error("not held");
    const a = await ctx.w.runDelayed({ now: r.sendAt + 1 });
    expect(a.sent).toEqual([]);
    expect(a.next).toBeGreaterThan(r.sendAt);
    mode = "reject";
    await ctx.w.runDelayed({ only: r.id });
    const v = await ctx.w.delayedView();
    expect(v[0]!.status).toBe("failed");
    expect(v[0]!.error).toMatch(/missingorspent/);
    await ctx.w.dismissDelayed(r.id);
    expect((await ctx.w.delayedView()).length).toBe(0);
  });

  it("a Payjoin send is never held", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "80000"]]);
    const p = await w.plan(dest, 10_000n, { feeRate: 2 });
    const c = await w.confirmPlan(p.planId!, dest, 10_000n, { feeRate: 2, seed: p.seed });
    if (!c.ok) throw new Error("plan changed");
    await expect(w.broadcast(INTENT_PAYJOIN, c.built, { feeRate: 2, holdMs: 60_000 })).rejects.toThrow();
    expect((await w.delayedView()).length).toBe(0);
  });
});
