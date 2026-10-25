import { describe, expect, it } from "vitest";
import type { ChainSource } from "../src/lib/chain.ts";
import { MemoryDirectory, MAILBOX_EMPTY, MAILBOX_OK, getOriginal, postOriginal } from "../src/lib/mailbox.ts";
import { encodeBip21, parseBip21 } from "../src/lib/bip21.ts";
import {
  PAYJOIN_PARTIES,
  looksLikePsbt,
  originalInputKeys,
  validatePayjoinProposal,
} from "../src/lib/payjoin-proposal.ts";
import { DEFAULT_PAYJOIN_DIRECTORY, sendPayjoinV2 } from "../src/lib/payjoin.ts";
import { parseOhttpKeys } from "../src/lib/ohttp.ts";
import { destinationNeedsPayjoin, inputSecret } from "../src/lib/send.ts";
import { INTENT_PAYJOIN } from "../src/lib/policy.ts";
import { spendSecret, taprootScriptPubKey } from "../src/lib/bip352.ts";
import { hex } from "../src/lib/bytes.ts";
import { accountFromVault } from "../src/lib/keys.ts";
import { spendableBalance, upsertUtxo, type LabeledUtxo } from "../src/lib/scan.ts";
import { evenPriv, sessionTweak } from "../src/lib/schnorr-util.ts";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as btc from "@scure/btc-signer";
import { PrivateBit } from "../src/lib/wallet.ts";
import { createMnemonic, memoryKv } from "../src/lib/vault.ts";

function mutateFirstOutputScript(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const tx = btc.Transaction.fromPSBT(bytes, { allowUnknownOutputs: true, disableScriptCheck: true });
  const next = new btc.Transaction({ allowUnknownOutputs: true, disableScriptCheck: true });
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    next.addInput({
      txid: inp.txid!,
      index: inp.index ?? 0,
      witnessUtxo: inp.witnessUtxo,
    });
  }
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    const script = i === 0 ? new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(1)]) : o.script!;
    next.addOutput({ script, amount: o.amount! });
  }
  const psbt = next.toPSBT();
  let s = "";
  for (let i = 0; i < psbt.length; i++) s += String.fromCharCode(psbt[i]!);
  return btoa(s);
}

function mockSource(): ChainSource {
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
    async broadcast() {
      return "deadbeef";
    },
    async estimateFeeSatPerVb() {
      return 1;
    },
  };
}

function coinFor(account: ReturnType<typeof accountFromVault>, txid: string, value: string): LabeledUtxo {
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

async function fundedWallet(dir: MemoryDirectory, coinTxid: string, value: string) {
  const kv = memoryKv();
  const raw = new Map<string, unknown>();
  const spy = {
    get: kv.get,
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) raw.set(k, v);
      await kv.set(items);
    },
    async remove(keys: string[]) {
      for (const k of keys) raw.delete(k);
      await kv.remove(keys);
    },
  };
  const w = new PrivateBit(spy, {
    kind: "unisat",
    url: "https://open-api-fractal.unisat.io",
    payjoinDirectory: DEFAULT_PAYJOIN_DIRECTORY,
  });
  w.mailboxTransport = dir.ohttpTransport();
  w.ohttpConfig = dir.ohttp;
  w.sourceOverride = mockSource();
  await w.create({ password: "pw", birthday: 8 });
  const { account, scan } = await w.requireAccount();
  const coin = coinFor(account, coinTxid, value);
  upsertUtxo(scan.utxos, coin);
  await w.saveScan(scan);
  return { w, account, coin, kvDump: async () => Object.fromEntries(raw) };
}

describe("BIP77 two-party Payjoin", () => {
  it("is exactly two interactive parties: not a waiting-room mix", () => {
    expect(PAYJOIN_PARTIES).toBe(2);
    const uri = encodeBip21({
      address: "bc1ptest",
      amount: 10_000n,
      pj: "http://127.0.0.1:17777/ABCDEFGH",
      pjos: false,
    });
    expect(uri).toMatch(/pjos=0/);
    expect(uri.toUpperCase()).toContain("PJ=HTTP://");
    const parsed = parseBip21(uri.replace("bc1ptest", "bc1p" + "q".repeat(59)));
    expect(parsed.pjos).toBe(false);
  });

  it("directory well-known is RFC 9540 OHTTP keys", () => {
    const dir = new MemoryDirectory();
    const keys = dir.handle("GET", "/.well-known/ohttp-gateway");
    expect(keys.status).toBe(200);
    const cfg = parseOhttpKeys(keys.bytes);
    expect(cfg.keyId).toBe(dir.ohttp.keyId);
    expect(cfg.compressedPub.length).toBe(33);
  });

  it("mailbox GET is 202 until the original exists, then 200", async () => {
    const dir = new MemoryDirectory();
    const t = dir.transport();
    const pj = `${DEFAULT_PAYJOIN_DIRECTORY}/QPZRY9X8`;
    expect((await getOriginal(t, pj)).status).toBe(MAILBOX_EMPTY);
    expect(looksLikePsbt("not-a-psbt")).toBe(false);
    await postOriginal(t, pj, "cHNidP8AAAAA");
    const got = await getOriginal(t, pj);
    expect(got.status).toBe(MAILBOX_OK);
    expect(got.body).toBe("cHNidP8AAAAA");
  });

  it("receiver cannot complete Payjoin without adding an input", () => {
    const original = "cHNidP8BAHwCAAAA";
    expect(validatePayjoinProposal(original, original).length).toBeGreaterThan(0);
  });

  it("two wallets: offer BIP21, sender posts original, receiver adds input, sender gets proposal", async () => {
    const dir = new MemoryDirectory();
    const alice = await fundedWallet(dir, "aa".repeat(32), "50000");
    const bob = await fundedWallet(dir, "bb".repeat(32), "10300");

    const session = await alice.w.offerPayjoin(10_000n);
    expect(session.bip21).toMatch(/^bitcoin:bc1p/i);
    expect(session.bip21).toMatch(/pj=/i);
    expect(session.bip21).toMatch(/pjos=0/);
    expect(session.bip21).toMatch(/%23/i);
    expect(session.bip21).toMatch(/RK1/i);
    expect(session.bip21).toMatch(/EX1/i);
    expect(session.bip21).toMatch(/OH1/i);
    const parsed = parseBip21(session.bip21);
    expect(parsed.pj).toBeTruthy();
    expect(parsed.receiverKey?.length).toBe(33);

    const built = await bob.w.planSend(session.bip21, 10_000n);
    expect(built.request.pj).toBeTruthy();
    expect(built.request.receiverKey?.length).toBe(33);
    expect(originalInputKeys(built.psbtBase64).size).toBeGreaterThanOrEqual(1);

    const outcome = await sendPayjoinV2({
      originalPsbt: built.psbtBase64,
      request: built.request,
      cfg: bob.w.payjoinCfg(),
      poll: {
        attempts: 5,
        delayMs: 0,
        sleep: async () => {
          const serviced = await alice.w.servicePayjoin();
          expect(serviced.errors).toEqual([]);
        },
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(validatePayjoinProposal(outcome.psbtBase64, built.psbtBase64)).toEqual([]);
    expect(validatePayjoinProposal(mutateFirstOutputScript(outcome.psbtBase64), built.psbtBase64).join(" ")).toMatch(
      /pjos=0/,
    );
    expect(originalInputKeys(outcome.psbtBase64).size).toBe(originalInputKeys(built.psbtBase64).size + 1);

    const signed = (await import("../src/lib/send.ts")).signPayjoinProposal({
      proposalB64: outcome.psbtBase64,
      account: bob.account,
      inputs: built.signableInputs,
    });
    expect(signed.txHex.length).toBeGreaterThan(20);
    expect(spendableBalance(await alice.w.loadScan()) > 0n).toBe(true);
  });

  it("Confirm send returns pending; alarm-style service finishes without broadcasting the original", async () => {
    const dir = new MemoryDirectory();
    const alice = await fundedWallet(dir, "22".repeat(32), "50000");
    const bob = await fundedWallet(dir, "33".repeat(32), "10300");
    const session = await alice.w.offerPayjoin(10_000n);
    const built = await bob.w.planSend(session.bip21, 10_000n);
    expect(destinationNeedsPayjoin(built.request)).toBe(true);
    const pending = await bob.w.broadcast(INTENT_PAYJOIN, built);
    expect(pending.kind).toBe("payjoin-pending");
    expect((await bob.w.loadPayjoinSends())[0]?.status).toBe("waiting");
    expect((await bob.w.state()).payjoinStatus).toMatch(/don't lock/i);

    const aliceSvc = await alice.w.servicePayjoin();
    expect(aliceSvc.errors).toEqual([]);
    expect(aliceSvc.processed).toBe(1);

    const bobSvc = await bob.w.servicePayjoin();
    expect(bobSvc.errors).toEqual([]);
    expect(bobSvc.processed).toBe(1);
    const done = (await bob.w.loadPayjoinSends())[0];
    expect(done?.status).toBe("done");
    expect(done?.txid).toBe("deadbeef");
  });

  it("lets the sender cancel a waiting Payjoin without broadcasting", async () => {
    const dir = new MemoryDirectory();
    const alice = await fundedWallet(dir, "44".repeat(32), "50000");
    const bob = await fundedWallet(dir, "55".repeat(32), "10300");
    const session = await alice.w.offerPayjoin(10_000n);
    const built = await bob.w.planSend(session.bip21, 10_000n);
    const pending = await bob.w.broadcast(INTENT_PAYJOIN, built);
    expect(pending.kind).toBe("payjoin-pending");
    const id = (await bob.w.loadPayjoinSends())[0]!.id;
    await bob.w.cancelSend(id);
    expect((await bob.w.loadPayjoinSends())[0]?.status).toBe("failed");
    expect((await bob.w.loadPayjoinSends())[0]?.error).toBe("cancelled");
    const bobSvc = await bob.w.servicePayjoin();
    expect(bobSvc.processed).toBe(0);
    expect((await bob.w.loadPayjoinSends())[0]?.status).toBe("failed");
    expect((await bob.w.state()).payjoin).toBeUndefined();
    expect((await bob.w.sessions()).some((s) => s.role === "send" && s.status === "failed" && s.error === "cancelled")).toBe(true);
  });

  it("keeps a cancelled or expired payment link off the wallet and in history", async () => {
    const dir = new MemoryDirectory();
    const alice = await fundedWallet(dir, "66".repeat(32), "50000");
    const session = await alice.w.offerPayjoin(10_000n);
    expect((await alice.w.state()).payjoin?.status).toBe("waiting");
    await alice.w.cancelLink(session.id);
    const afterCancel = await alice.w.state();
    expect(afterCancel.payjoin).toBeUndefined();
    expect(afterCancel.payjoinStatus).toBeUndefined();
    const listed = await alice.w.sessions();
    expect(listed.some((s) => s.id === session.id && s.role === "receive" && s.status === "failed" && s.error === "cancelled")).toBe(true);

    const again = await alice.w.offerPayjoin(10_000n);
    const stored = await alice.w.loadPayjoinSessions();
    const row = stored.find((s) => s.id === again.id)!;
    row.expiresAt = Date.now() - 1_000;
    await alice.w.savePayjoinSessions(stored);
    const expired = await alice.w.state();
    expect(expired.payjoin).toBeUndefined();
    const history = await alice.w.sessions();
    expect(history.find((s) => s.id === again.id)?.status).toBe("failed");
    expect(history.find((s) => s.id === again.id)?.error).toBe("expired");
  });

  it("lets another wallet pay a link that this wallet created", async () => {
    const dir = new MemoryDirectory();
    const alice = await fundedWallet(dir, "77".repeat(32), "50000");
    const link = await alice.w.offerPayjoin(10_000n);
    const created = await alice.w.loadPayjoinSessions();
    await alice.w.addWallet({
      mnemonic: createMnemonic(256),
      password: "other",
      birthday: 8,
      name: "Other",
      kind: "create",
    });
    // Each wallet has its own namespace: the new wallet never sees the first one's links.
    expect(created.some((s) => s.id === link.id)).toBe(true);
    expect(await alice.w.loadPayjoinSessions()).toEqual([]);
    await expect(alice.w.assertNotOwnLink(link.bip21)).resolves.toBeUndefined();
    expect((await alice.w.sessions()).some((s) => s.id === link.id)).toBe(false);

    const first = (await alice.w.state()).wallets!.find((w) => !w.active)!.id;
    await alice.w.openWallet(first);
    await alice.w.unlock("pw");
    await expect(alice.w.assertNotOwnLink(link.bip21)).rejects.toThrow(/own payment link/i);
    expect((await alice.w.sessions()).some((s) => s.id === link.id && s.role === "receive")).toBe(true);
  });

  it("a payment link keeps going after Lock with only its reserved coin's key (security audit v1)", async () => {
    const dir = new MemoryDirectory();
    const alice = await fundedWallet(dir, "dd".repeat(32), "50000");
    const bob = await fundedWallet(dir, "ee".repeat(32), "10300");

    const session = await alice.w.offerPayjoin(10_000n);
    expect(session.inputSecret).toBeUndefined();
    const stored = (await alice.w.loadPayjoinSessions())[0];
    expect(stored?.inputSecret).toBeUndefined();
    expect(stored?.hpkePub).toMatch(/^[0-9a-f]{66}$/);
    expect(JSON.stringify(stored)).not.toMatch(/"sk"/);
    expect(stored?.reserved?.txid).toBe(alice.coin.txid);

    const built = await bob.w.planSend(session.bip21, 10_000n);
    await sendPayjoinV2({
      originalPsbt: built.psbtBase64,
      request: built.request,
      cfg: bob.w.payjoinCfg(),
      poll: { attempts: 1, delayMs: 0 },
    });

    await alice.w.lock();
    await expect(alice.w.requireAccount()).rejects.toThrow(/locked/);
    // Nothing in storage reveals the spend key or the reserved coin's key.
    const dump = JSON.stringify(await alice.kvDump());
    expect(dump).not.toContain(hex(alice.account.spendSecret));
    expect(dump).not.toContain(hex(evenPriv(inputSecret(alice.account, alice.coin))));
    const whileLocked = await alice.w.servicePayjoin();
    expect(whileLocked.errors).toEqual([]);
    expect(whileLocked.processed).toBe(1);
    expect(await alice.w.waitingPayjoin()).toBe(true);

    await alice.w.unlock("pw");
    expect((await alice.w.loadPayjoinSessions())[0]?.status).toBe("proposed");
  });

  it("does not spend a coin reserved for a payment link", async () => {
    const dir = new MemoryDirectory();
    const alice = await fundedWallet(dir, "ff".repeat(32), "50000");
    const session = await alice.w.offerPayjoin(10_000n);
    await expect(alice.w.planSend(session.bip21, 10_000n)).rejects.toThrow(/no coins/);
  });

  it("a Payjoin send finishes after Lock with only its own coins' keys, and is recorded at unlock", async () => {
    const dir = new MemoryDirectory();
    const alice = await fundedWallet(dir, "44".repeat(32), "50000");
    const bob = await fundedWallet(dir, "55".repeat(32), "10300");
    const session = await alice.w.offerPayjoin(10_000n);
    const built = await bob.w.planSend(session.bip21, 10_000n);
    await bob.w.broadcast(INTENT_PAYJOIN, built);
    expect((await bob.w.loadPayjoinSends()).length).toBe(1);
    await bob.w.lock();
    expect((await bob.w.loadPayjoinSends())[0]?.status).toBe("waiting");
    const dump = JSON.stringify(await bob.kvDump());
    expect(dump).not.toContain(hex(bob.account.spendSecret));
    expect(dump).not.toContain(hex(inputSecret(bob.account, bob.coin)));
    expect((await alice.w.servicePayjoin()).processed).toBe(1);
    const locked = await bob.w.servicePayjoin();
    expect(locked.errors).toEqual([]);
    expect(locked.processed).toBe(1);
    expect((await bob.w.loadPayjoinSends())[0]?.status).toBe("done");
    await bob.w.unlock("pw");
    const hist = await bob.w.history();
    expect(hist.entries.some((e) => e.kind === "payjoin-sent")).toBe(true);
  });

  it("a BIP78 https pj= without RK is not Payjoin", () => {
    const r = parseBip21("bitcoin:bc1p" + "q".repeat(59) + "?pj=https://example/pj");
    expect(destinationNeedsPayjoin(r)).toBe(false);
  });

  it("a plain sp1 destination cannot Payjoin: RK lives on the payment link", async () => {
    const dir = new MemoryDirectory();
    const bob = await fundedWallet(dir, "11".repeat(32), "10300");
    const outcome = await sendPayjoinV2({
      originalPsbt: "cHNidP8BAgMEBQY=",
      request: parseBip21(bob.account.receive),
      cfg: bob.w.payjoinCfg(),
      poll: { attempts: 1, delayMs: 0 },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("should fail");
    expect(outcome.reason).toMatch(/no pj=/i);
    expect(outcome.originalPsbtBase64).toBe("cHNidP8BAgMEBQY=");
  });

  it("Payjoin intent does not return the original when the mailbox stays empty", async () => {
    const dir = new MemoryDirectory();
    const bob = await fundedWallet(dir, "cc".repeat(32), "10300");
    const session = (await bob.w.offerPayjoin(10_000n)).bip21;
    const req = parseBip21(session);
    const outcome = await sendPayjoinV2({
      originalPsbt: "cHNidP8BAgMEBQY=",
      request: req,
      cfg: bob.w.payjoinCfg(),
      poll: { attempts: 2, delayMs: 0 },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("should fail");
    expect(outcome.originalPsbtBase64).toBe("cHNidP8BAgMEBQY=");
  });
});
