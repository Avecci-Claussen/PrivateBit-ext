import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { ChainSource } from "../src/lib/chain.ts";
import { MemoryDirectory } from "../src/lib/mailbox.ts";
import { checkOriginal, originalFeeRate, receiverContribution, RECEIVER_ADDED_VBYTES } from "../src/lib/payjoin-proposal.ts";
import { DEFAULT_PAYJOIN_DIRECTORY } from "../src/lib/payjoin.ts";
import { INTENT_PAYJOIN } from "../src/lib/policy.ts";
import { spendSecret, taprootScriptPubKey } from "../src/lib/bip352.ts";
import { fromHex, hex } from "../src/lib/bytes.ts";
import { accountFromVault } from "../src/lib/keys.ts";
import { upsertUtxo, type LabeledUtxo } from "../src/lib/scan.ts";
import { evenPriv, sessionTweak } from "../src/lib/schnorr-util.ts";
import { parseTxHex } from "../src/lib/tx.ts";
import { autoLockDecision } from "../src/lib/autolock.ts";
import { scopedName } from "../src/lib/layout.ts";
import { PROPOSAL_DEADLINE_MS, PrivateBit } from "../src/lib/wallet.ts";
import { createMnemonic, memoryKv, type Kv } from "../src/lib/vault.ts";

/** Captures what would be broadcast. Nothing leaves the test. */
function mockSource(sent: string[]): ChainSource {
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
    async broadcast(txHex) {
      sent.push(txHex);
      return parseTxHex(txHex).txid;
    },
    async estimateFeeSatPerVb() {
      return 1;
    },
  };
}

function coinFor(account: ReturnType<typeof accountFromVault>, txid: string, value: string): LabeledUtxo {
  const tweak = sessionTweak(txid, 0);
  const d = evenPriv(spendSecret({ spendSecret: account.spendSecret, tweak, label: null, scanSecret: account.scanSecret }));
  const xonly = secp256k1.getPublicKey(d, true).slice(1);
  return { txid, vout: 0, value, scriptPubKey: hex(taprootScriptPubKey(xonly)), tweak: hex(tweak), label: null, k: 0, height: 8, spent: false };
}

async function fundedWallet(dir: MemoryDirectory, coinTxid: string, value: string, kv: Kv = memoryKv()) {
  const sent: string[] = [];
  const w = new PrivateBit(kv, { kind: "unisat", url: "https://open-api-fractal.unisat.io", payjoinDirectory: DEFAULT_PAYJOIN_DIRECTORY });
  w.mailboxTransport = dir.ohttpTransport();
  w.ohttpConfig = dir.ohttp;
  w.sourceOverride = mockSource(sent);
  await w.create({ password: "pw", birthday: 8 });
  const { account, scan } = await w.requireAccount();
  const coin = coinFor(account, coinTxid, value);
  upsertUtxo(scan.utxos, coin);
  await w.saveScan(scan);
  return { w, account, coin, sent, kv };
}

function psbtTx(b64: string): btc.Transaction {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return btc.Transaction.fromPSBT(bytes, { allowUnknownOutputs: true, disableScriptCheck: true });
}

/** Alice offers a link, Bob pays it, Alice posts a proposal. */
async function proposed(seed: string) {
  const dir = new MemoryDirectory();
  const alice = await fundedWallet(dir, seed.repeat(32), "50000");
  const bob = await fundedWallet(dir, (seed === "a1" ? "b1" : "c1").repeat(32), "10300");
  const session = await alice.w.offerPayjoin(10_000n);
  const built = await bob.w.planSend(session.bip21, 10_000n);
  await bob.w.broadcast(INTENT_PAYJOIN, built);
  const svc = await alice.w.servicePayjoin();
  expect(svc.errors).toEqual([]);
  return { dir, alice, bob, session };
}

describe("Payjoin receive state machine", () => {
  it("a proposal that is never broadcast ends at its deadline and frees the coin and the auto-lock", async () => {
    const { alice, session } = await proposed("a1");
    let row = (await alice.w.loadPayjoinSessions())[0]!;
    expect(row.status).toBe("proposed");
    expect(row.proposalDeadline! - row.proposedAt!).toBe(PROPOSAL_DEADLINE_MS);
    expect(await alice.w.waitingPayjoin()).toBe(true);
    expect((await alice.w.blockedOutpoints()).reserved.has(`${alice.coin.txid}:0`)).toBe(true);

    const sessions = await alice.w.loadPayjoinSessions();
    sessions[0]!.proposalDeadline = Date.now() - 1;
    await alice.w.savePayjoinSessions(sessions);
    expect(await alice.w.waitingPayjoin()).toBe(false);
    row = (await alice.w.loadPayjoinSessions())[0]!;
    expect(row.status).toBe("failed");
    // Audit M4 (independent): the payer's original payment goes out instead.
    expect(row.error).toMatch(/original payment was sent instead/);
    expect(alice.sent).toHaveLength(1);
    expect(row.fallbackTxid).toBe(parseTxHex(alice.sent[0]!).txid);
    expect((await alice.w.blockedOutpoints()).reserved.size).toBe(0);
    const hpke = (await alice.kv.get([scopedName(alice.w.activeId!, "privatebit.pj.hpke")]))[scopedName(alice.w.activeId!, "privatebit.pj.hpke")] as Record<string, string> | undefined;
    expect(Object.keys(hpke ?? {}).filter((k) => k.includes(session.id))).toEqual([]);

    // Auto lock does not wait for a payment (security audit v1).
    const t0 = 1_000_000;
    expect(autoLockDecision({ last: t0 }, t0 + 20 * 60_000, 5).lock).toBe(true);
  });

  it("offers Cancel in every open state, including after a proposal", async () => {
    const { alice, session } = await proposed("a1");
    const view = (await alice.w.sessions()).find((s) => s.id === session.id)!;
    expect(view.status).toBe("proposed");
    expect(view.cancellable).toBe(true);
    expect(view.deadline).toBeGreaterThan(Date.now());
    await alice.w.cancelLink(session.id);
    const after = (await alice.w.sessions()).find((s) => s.id === session.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toBe("cancelled");
    expect(after.cancellable).toBe(false);
    await expect(alice.w.cancelLink(session.id)).rejects.toThrow(/ended/);
    expect(await alice.w.waitingPayjoin()).toBe(false);
  });

  it("detects completion by the proposal's txid, even after the link ended", async () => {
    const { alice, bob } = await proposed("a1");
    const svc = await bob.w.servicePayjoin();
    expect(svc.errors).toEqual([]);
    expect(bob.sent).toHaveLength(1);
    const finalTxid = parseTxHex(bob.sent[0]!).txid;
    const row = (await alice.w.loadPayjoinSessions())[0]!;
    expect(row.proposedTxid).toBe(finalTxid);

    // The payer was slow: the link ended as "not broadcast" first.
    const sessions = await alice.w.loadPayjoinSessions();
    sessions[0]!.proposalDeadline = Date.now() - 1;
    await alice.w.savePayjoinSessions(sessions);
    await alice.w.waitingPayjoin();
    expect((await alice.w.loadPayjoinSessions())[0]!.status).toBe("failed");

    // Then Alice's scan sees her reserved coin spent by that txid.
    const scan = await alice.w.loadScan();
    const next = { ...scan, utxos: scan.utxos.map((u) => (u.txid === alice.coin.txid ? { ...u, spent: true, spentBy: finalTxid } : u)) };
    await alice.w.saveScan(next);
    const done = (await alice.w.loadPayjoinSessions())[0]!;
    expect(done.status).toBe("done");
    expect(done.txid).toBe(finalTxid);
  });

  it("pays a fee share that follows the original fee rate", async () => {
    expect(receiverContribution(1)).toBe(BigInt(RECEIVER_ADDED_VBYTES));
    expect(receiverContribution(0.2)).toBe(BigInt(RECEIVER_ADDED_VBYTES));
    expect(receiverContribution(12.5)).toBe(BigInt(Math.ceil(RECEIVER_ADDED_VBYTES * 12.5)));

    const { alice, bob } = await proposed("a1");
    const original = (await bob.w.loadPayjoinSends())[0]!.originalPsbt;
    const orig = psbtTx(original);
    let origIn = 0n;
    for (let i = 0; i < orig.inputsLength; i++) origIn += orig.getInput(i).witnessUtxo!.amount;
    let origOut = 0n;
    for (let i = 0; i < orig.outputsLength; i++) origOut += orig.getOutput(i).amount!;
    await bob.w.servicePayjoin();
    const final = btc.Transaction.fromRaw(fromHex(bob.sent[0]!), { allowUnknownOutputs: true, disableScriptCheck: true });
    let finalOut = 0n;
    for (let i = 0; i < final.outputsLength; i++) finalOut += final.getOutput(i).amount!;
    const finalFee = origIn + BigInt(alice.coin.value) - finalOut;
    expect(finalFee - (origIn - origOut)).toBe(receiverContribution(originalFeeRate(original)));
  });

  it("refuses an original that does not pay the link, spends our coin, or is short", async () => {
    const dir = new MemoryDirectory();
    const alice = await fundedWallet(dir, "d1".repeat(32), "50000");
    const bob = await fundedWallet(dir, "e1".repeat(32), "10300");
    const session = await alice.w.offerPayjoin(10_000n);
    await bob.w.broadcast(INTENT_PAYJOIN, await bob.w.planSend(session.bip21, 10_000n));
    const original = (await bob.w.loadPayjoinSends())[0]!.originalPsbt;
    const base = { originalB64: original, payScript: session.scriptPubKey, ourOutpoints: new Set<string>(), ourScripts: new Set<string>() };
    expect(checkOriginal({ ...base, amount: 10_000n })).toEqual([]);
    expect(checkOriginal({ ...base, amount: 20_000n })).toContain("original pays less than requested");
    expect(checkOriginal({ ...base, payScript: "5120" + "11".repeat(32) })).toContain("original does not pay this payment link");
    expect(checkOriginal({ ...base, ourOutpoints: new Set([`${bob.coin.txid}:0`]) })).toContain("original spends one of our coins");
    expect(checkOriginal({ ...base, ourScripts: new Set([bob.coin.scriptPubKey]) })).toContain("original spends one of our coins");

    // A probing original (spending one of Alice's coins) makes the link end; Alice signs nothing.
    const scan = await alice.w.loadScan();
    upsertUtxo(scan.utxos, { ...bob.coin });
    await alice.w.saveScan(scan);
    const svc = await alice.w.servicePayjoin();
    expect(svc.processed).toBe(0);
    const row = (await alice.w.loadPayjoinSessions())[0]!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^refused: .*spends one of our coins/);
  });

  it("switching wallets ends open Payjoins and leaves no session secrets behind", async () => {
    const dir = new MemoryDirectory();
    const kv = memoryKv();
    const alice = await fundedWallet(dir, "f1".repeat(32), "50000", kv);
    const first = alice.w.activeId!;
    await alice.w.offerPayjoin(10_000n);
    expect(await alice.w.waitingPayjoin()).toBe(true);
    await alice.w.addWallet({ mnemonic: createMnemonic(256), password: "two", birthday: 8, name: "Two", kind: "create" });
    const hpkeKey = scopedName(first, "privatebit.pj.hpke");
    expect((await kv.get([hpkeKey]))[hpkeKey]).toBeUndefined();
    await alice.w.openWallet(first);
    await alice.w.unlock("pw");
    const row = (await alice.w.loadPayjoinSessions())[0]!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("wallet switched");
    expect(await alice.w.waitingPayjoin()).toBe(false);
  });
});
