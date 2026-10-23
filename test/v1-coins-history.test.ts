import { describe, expect, it } from "vitest";
import { coinSelect, CoinChoiceError, maxSendable, feeFor } from "../src/lib/coinselect.ts";
import { coinStatus, frozenOutpoints, mixesLinkedAndPrivate, setCoinMeta, carryCoinMeta, cleanLabel } from "../src/lib/coinmeta.ts";
import { deriveHistory, emptyHistory, historyList, recordBroadcast, setHistoryLabel } from "../src/lib/history.ts";
import type { LabeledUtxo, ScanStore } from "../src/lib/scan.ts";

function coin(txid: string, value: number, extra: Partial<LabeledUtxo> = {}): LabeledUtxo {
  return { txid: txid.repeat(64 / txid.length), vout: 0, value: String(value), scriptPubKey: "5120" + "ab".repeat(32), tweak: "cc".repeat(32), label: null, k: 0, height: 100, spent: false, ...extra };
}
const op = (u: LabeledUtxo) => `${u.txid}:${u.vout}`;

describe("coin freeze and selection", () => {
  const a = coin("a", 50_000), b = coin("b", 30_000), c = coin("c", 10_000);
  it("never auto-selects a frozen coin", () => {
    let meta = setCoinMeta({}, op(a), { frozen: true, reason: "keep" });
    const skip = frozenOutpoints(meta);
    const sel = coinSelect([a, b, c], 35_000n, 1, 1, skip);
    expect(sel.inputs.map(op)).not.toContain(op(a));
    expect(() => coinSelect([a], 1000n, 1, 1, skip)).toThrow(/no coins/);
    meta = setCoinMeta(meta, op(a), { frozen: false });
    expect(frozenOutpoints(meta).size).toBe(0);
  });
  it("manual choice uses exactly the chosen coins", () => {
    const sel = coinSelect([a, b, c], 5_000n, 1, 1, new Set(), [op(c)]);
    expect(sel.inputs.map(op)).toEqual([op(c)]);
    expect(() => coinSelect([a, b, c], 20_000n, 1, 1, new Set(), [op(c)])).toThrow(CoinChoiceError);
    expect(() => coinSelect([a, b, c], 1_000n, 1, 1, new Set([op(c)]), [op(c)])).toThrow(/frozen or reserved/);
    expect(() => coinSelect([a, b, c], 1_000n, 1, 1, new Set(), [])).toThrow(CoinChoiceError);
  });
  it("max spends everything unfrozen in one output", () => {
    const m = maxSendable([a, b, c], 2, new Set([op(a)]));
    expect(m.inputs).toBe(2);
    expect(m.amount + m.fee).toBe(40_000n);
    expect(m.fee).toBe(feeFor(2, 1, 2));
  });
  it("labels coins and warns when mixing linked and private", () => {
    const meta = setCoinMeta({}, op(b), { linked: true, label: "Old wallet address" });
    expect(coinStatus(a, meta, new Set())).toBe("private");
    expect(coinStatus(b, meta, new Set())).toBe("linked");
    expect(coinStatus(coin("d", 1, { kind: "bip86", index: 0 }), {}, new Set())).toBe("linked");
    expect(coinStatus(a, meta, new Set([op(a)]))).toBe("reserved");
    expect(coinStatus(a, setCoinMeta({}, op(a), { frozen: true }), new Set([op(a)]))).toBe("frozen");
    expect(mixesLinkedAndPrivate(["private", "linked"])).toBe(true);
    expect(mixesLinkedAndPrivate(["private", "private"])).toBe(false);
    expect(carryCoinMeta(meta, [op(b)], ["e".repeat(64) + ":1"])["e".repeat(64) + ":1"]?.linked).toBe(true);
    expect(cleanLabel("x".repeat(100))?.length).toBe(64);
  });
});

describe("activity history", () => {
  const recv = coin("a", 50_000, { height: 1000 });
  const spent = { ...recv, spent: true, spentBy: "f".repeat(64), spentHeight: 1010 };
  const change = coin("f", 20_000, { height: 1010 });
  const scan: ScanStore = { utxos: [spent, change], lastHeight: 1010, tip: 1010 };

  it("derives received and sent entries from the scan", () => {
    const h = deriveHistory(scan, null, { now: 1_000_000_000 });
    const list = historyList(h);
    expect(list).toHaveLength(2);
    const r = h.entries["a".repeat(64)]!;
    expect(r.kind).toBe("received");
    expect(r.amount).toBe("50000");
    expect(r.status).toBe("confirmed");
    const s = h.entries["f".repeat(64)]!;
    expect(s.kind).toBe("sent");
    expect(s.amount).toBe("-30000");
  });
  it("keeps wallet-recorded details and labels across rescans", () => {
    let h = recordBroadcast(emptyHistory(), { txid: "f".repeat(64), kind: "sent", amount: 29_000n, fee: 1_000n, feeRate: 2, to: "sp1q...", outpoints: [op(recv)], now: 5_000, label: "Rent" });
    expect(h.entries["f".repeat(64)]!.status).toBe("pending");
    h = deriveHistory(scan, h, { now: 9_000_000 });
    const s = h.entries["f".repeat(64)]!;
    expect(s.label).toBe("Rent");
    expect(s.amount).toBe("-29000");
    expect(s.fee).toBe("1000");
    expect(s.status).toBe("confirmed");
    h = setHistoryLabel(h, "f".repeat(64), undefined);
    expect(h.entries["f".repeat(64)]!.label).toBeUndefined();
  });
  it("estimates time for old blocks and clears rebuilding at the tip", () => {
    const old: ScanStore = { utxos: [coin("b", 1000, { height: 100 })], lastHeight: 900, tip: 1000 };
    const h = deriveHistory(old, emptyHistory(true), { now: 10_000_000 });
    expect(h.rebuilding).toBe(true);
    const e = h.entries["b".repeat(64)]!;
    expect(e.approxTime).toBe(true);
    expect(e.time).toBe(10_000 - 900 * 30);
    const done = deriveHistory({ ...old, lastHeight: 1000 }, h, { now: 10_000_000 });
    expect(done.rebuilding).toBeUndefined();
  });
  it("shows unconfirmed incoming coins", () => {
    const h = deriveHistory({ utxos: [coin("c", 5, { height: 0 })], lastHeight: 5, tip: 5 }, null, { now: 0 });
    expect(h.entries["c".repeat(64)]!.status).toBe("incoming");
  });
});
