// Audit M10: Confirm sends exactly the reviewed plan, or nothing.
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { ChainSource } from "../src/lib/chain.ts";
import { spendSecret, taprootScriptPubKey } from "../src/lib/bip352.ts";
import { hex } from "../src/lib/bytes.ts";
import type { accountFromVault } from "../src/lib/keys.ts";
import { upsertUtxo, type LabeledUtxo } from "../src/lib/scan.ts";
import { evenPriv, sessionTweak } from "../src/lib/schnorr-util.ts";
import { planDigest } from "../src/lib/send.ts";
import { memoryKv } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";
import { planChanges } from "../src/ui/plan-changes.ts";

const source = (): ChainSource => ({
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
  async broadcast() {
    throw new Error("tests never broadcast");
  },
  async estimateFeeSatPerVb() {
    return 1;
  },
});

function coinFor(account: ReturnType<typeof accountFromVault>, txid: string, value: string): LabeledUtxo {
  const tweak = sessionTweak(txid, 0);
  const d = evenPriv(spendSecret({ spendSecret: account.spendSecret, tweak, label: null, scanSecret: account.scanSecret }));
  return { txid, vout: 0, value, scriptPubKey: hex(taprootScriptPubKey(secp256k1.getPublicKey(d, true).slice(1))), tweak: hex(tweak), label: null, k: 0, height: 8, spent: false };
}

async function wallet(coins: [string, string][]) {
  const w = new PrivateBit(memoryKv());
  w.sourceOverride = source();
  await w.create({ password: "password1", birthday: 8 });
  const { account, scan } = await w.requireAccount();
  for (const [txid, value] of coins) upsertUtxo(scan.utxos, coinFor(account, txid, value));
  await w.saveScan(scan);
  const to = new PrivateBit(memoryKv());
  await to.create({ password: "password1", birthday: 8 });
  const dest = (await to.requireAccount()).account.receive;
  return { w, account, dest };
}

describe("Confirm sends the reviewed plan", () => {
  it("the plan id covers inputs and outputs, not signatures: planning twice with the review's seed gives the same id", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "50000"]]);
    const p1 = await w.plan(dest, 10_000n, { feeRate: 2 });
    expect(p1.seed).toMatch(/^[0-9a-f]{64}$/);
    const p2 = await w.plan(dest, 10_000n, { feeRate: 2, seed: p1.seed });
    expect(p1.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(p2.planId).toBe(p1.planId);
    expect(planDigest(p1.psbtBase64, { chain: "fractal:8228", wallet: "x" })).not.toBe(planDigest(p1.psbtBase64, { chain: "fractal:8228", wallet: "y" }));
    expect(planDigest(p1.psbtBase64, { chain: "fractal:8228", wallet: "x" })).not.toBe(planDigest(p1.psbtBase64, { chain: "bitcoin", wallet: "x" }));
  });

  it("unchanged: confirm gets the same transaction that was reviewed", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "50000"]]);
    const p = await w.plan(dest, 10_000n, { feeRate: 2 });
    const c = await w.confirmPlan(p.planId!, dest, 10_000n, { feeRate: 2, seed: p.seed });
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.built.fee.toString()).toBe(p.fee);
      expect(c.built.signableInputs.map((u) => `${u.txid}:${u.vout}`)).toEqual(p.inputs);
    }
  });

  it("a coin spent after review: nothing is sent and the new plan comes back", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "50000"], ["b2".repeat(32), "40000"]]);
    const p = await w.plan(dest, 10_000n, { feeRate: 2 });
    const scan = await w.loadScan();
    for (const u of scan.utxos) if (`${u.txid}:${u.vout}` === p.inputs[0]) u.spent = true;
    await w.saveScan(scan);
    const c = await w.confirmPlan(p.planId!, dest, 10_000n, { feeRate: 2 });
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.plan.planId).not.toBe(p.planId);
      expect(c.plan.inputs).not.toEqual(p.inputs);
      expect(planChanges(p, c.plan).join(" ")).toMatch(/Different coins/);
    }
  });

  it("a new coin arriving changes a send max: the amount change is shown", async () => {
    const { w, account, dest } = await wallet([["a1".repeat(32), "50000"]]);
    const p = await w.plan(dest, 0n, { feeRate: 2, max: true });
    const scan = await w.loadScan();
    upsertUtxo(scan.utxos, coinFor(account, "c3".repeat(32), "30000"));
    await w.saveScan(scan);
    const c = await w.confirmPlan(p.planId!, dest, 0n, { feeRate: 2, max: true });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(planChanges(p, c.plan).join(" ")).toMatch(/amount is now/);
  });

  it("a different fee rate than reviewed is a different plan", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "50000"]]);
    const p = await w.plan(dest, 10_000n, { feeRate: 2 });
    const c = await w.confirmPlan(p.planId!, dest, 10_000n, { feeRate: 5 });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(planChanges(p, c.plan).join(" ")).toMatch(/network fee is now/);
  });

  it("the random output order and fee nudge come from the review's seed, so Confirm rebuilds them exactly", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "50000"]]);
    for (let i = 0; i < 6; i++) {
      const p = await w.plan(dest, 10_000n, { feeRate: 2, randomizeFee: true, minFeeRate: 1 });
      expect(p.feeRate).toBeGreaterThanOrEqual(1.9);
      expect(p.feeRate).toBeLessThanOrEqual(2.1);
      const c = await w.confirmPlan(p.planId!, dest, 10_000n, { feeRate: 2, randomizeFee: true, minFeeRate: 1, seed: p.seed });
      expect(c.ok).toBe(true);
    }
  });

  it("the merge warning trigger: inputs are grouped by label", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "30000"], ["b2".repeat(32), "30000"]]);
    await w.setCoinMeta(`${"a1".repeat(32)}:0`, { label: "Alice" });
    const p = await w.plan(dest, 50_000n, { feeRate: 2 });
    expect(p.inputs.length).toBe(2);
    expect(p.inputLabels?.map((g) => g.label).sort()).toEqual(["Alice", null].sort());
    const one = await w.plan(dest, 10_000n, { feeRate: 2 });
    expect(one.inputLabels?.length).toBe(1);
  });

  it("a forged or missing plan id is refused before anything is built", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "50000"]]);
    await expect(w.confirmPlan("nope", dest, 10_000n, { feeRate: 2 })).rejects.toThrow(/Review the payment first/);
    const c = await w.confirmPlan("0".repeat(64), dest, 10_000n, { feeRate: 2 });
    expect(c.ok).toBe(false);
  });

  it("change wording has no dashes", async () => {
    const { w, dest } = await wallet([["a1".repeat(32), "50000"], ["b2".repeat(32), "40000"]]);
    const p = await w.plan(dest, 10_000n, { feeRate: 2 });
    const q = await w.plan(dest, 20_000n, { feeRate: 3 });
    expect(planChanges(p, q).join(" ")).not.toMatch(/[\u2013\u2014]/);
  });
});
