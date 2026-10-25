/**
 * Regression tests for the independent audit (audit-independent/REPORT.md): H1, H2, H3.
 * The H1 and H3 cases follow the auditor's proofs of concept.
 */
import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import { pjSessionId, sessionTweak, tweakSpend } from "../src/lib/schnorr-util.ts";
import { taprootScriptPubKey } from "../src/lib/bip352.ts";
import { fromHex, hex } from "../src/lib/bytes.ts";
import { accountFromVault, siteKeyFromHd, type Account } from "../src/lib/keys.ts";
import { createMnemonic, memoryKv, vaultFromMnemonic } from "../src/lib/vault.ts";
import { buildSend, inputSecret } from "../src/lib/send.ts";
import { PJ_GAP, pjNextIndex, pjOutputs, PrivateBit } from "../src/lib/wallet.ts";
import { parsePsbt, reviewPsbt, signReviewedPsbt } from "../src/lib/sites.ts";
import { emptyScanStore, type LabeledUtxo } from "../src/lib/scan.ts";

function walletWithParity(prefix: 2 | 3): { account: Account; mnemonic: string } {
  for (;;) {
    const mnemonic = createMnemonic(256);
    const account = accountFromVault(vaultFromMnemonic({ mnemonic, birthday: 1 }));
    if (account.spendPub[0] === prefix) return { account, mnemonic };
  }
}

describe("H1: Payjoin link coins are spendable for odd and even spend keys", () => {
  for (const prefix of [2, 3] as const) {
    it(`spend key 0${prefix}: payment and extra outputs, old random links and new derived links`, async () => {
      const { account } = walletWithParity(prefix);
      for (const t of [sessionTweak("11".repeat(32), 0), sessionTweak("11".repeat(32), 1), ...pjOutputs(account, 3).map((w) => fromHex(w.tweak))]) {
        const q = tweakSpend(account.spendSecret, t);
        const spk = hex(taprootScriptPubKey(q.xonly));
        const utxo: LabeledUtxo = { txid: "22".repeat(32), vout: 0, value: "100000", scriptPubKey: spk, tweak: hex(t), label: null, k: 0, height: 5, spent: false };
        // The key chosen for signing is the coin's own output key.
        expect(hex(schnorr.getPublicKey(inputSecret(account, utxo)))).toBe(hex(q.xonly));
        const built = await buildSend({ account, utxos: [utxo], destination: account.receive, amount: 50_000n, feeRate: 2, source: {} as never });
        const tx = btc.Transaction.fromRaw(fromHex(built.txHex), { allowUnknownOutputs: true });
        const pre = tx.preimageWitnessV1(0, [fromHex(spk)], btc.SigHash.DEFAULT, [100_000n]);
        const sig = tx.getInput(0).finalScriptWitness![0]!;
        expect(schnorr.verify(sig, pre, q.xonly)).toBe(true);
      }
    });
  }

  it("ordinary silent payment coins still use the BIP352 key B + t*G", () => {
    const { account } = walletWithParity(3);
    const t = fromHex("05".repeat(32));
    const P = secp256k1.ProjectivePoint.fromHex(account.spendPub).add(secp256k1.ProjectivePoint.BASE.multiply(5n * 0x0101010101010101010101010101010101010101010101010101010101010101n % secp256k1.CURVE.n));
    const spk = "5120" + hex(P.toRawBytes(true).slice(1));
    const d = inputSecret(account, { tweak: hex(t), label: null, scriptPubKey: spk });
    expect(hex(schnorr.getPublicKey(d))).toBe(spk.slice(4));
    expect(hex(secp256k1.getPublicKey(d, true))).toBe(hex(P.toRawBytes(true)));
  });
});

describe("H2: Payjoin links come from the recovery words", () => {
  it("session ids are deterministic per scan key and index", () => {
    const { account } = walletWithParity(2);
    expect(pjSessionId(account.scanSecret, 0)).toBe(pjSessionId(account.scanSecret, 0));
    expect(pjSessionId(account.scanSecret, 0)).not.toBe(pjSessionId(account.scanSecret, 1));
    expect(() => pjSessionId(account.scanSecret, -1)).toThrow();
  });

  it("the next index skips any index with a coin, and the stored counter", () => {
    const { account } = walletWithParity(3);
    const store = emptyScanStore(1);
    expect(pjNextIndex(account, store, {})).toBe(0);
    expect(pjNextIndex(account, store, { pjNext: 4 })).toBe(4);
    const extra7 = pjOutputs(account, 7)[1]!;
    store.utxos.push({ txid: "aa".repeat(32), vout: 1, value: "1000", scriptPubKey: extra7.scriptPubKey, tweak: extra7.tweak, label: null, k: 0, height: 9, spent: true });
    expect(pjNextIndex(account, store, {})).toBe(8);
  });

  it("a restore from the words watches the first link outputs", async () => {
    const { account, mnemonic } = walletWithParity(3);
    const w = new PrivateBit(memoryKv());
    await w.restore({ mnemonic, password: "password1", birthday: 10 });
    const watched = new Set(((await w.loadScan()).watch ?? []).map((x) => x.scriptPubKey));
    for (let i = 0; i < PJ_GAP; i++) for (const o of pjOutputs(account, i)) expect(watched.has(o.scriptPubKey)).toBe(true);
  }, 30000);
});

describe("H3: a site signature always covers every output", () => {
  it("auditor PoC: SINGLE|ANYONECANPAY with an uncommitted return output is refused", () => {
    const hd = HDKey.fromMasterSeed(new Uint8Array(64).fill(7));
    const k = siteKeyFromHd(hd, 0x40000001, "fractal");
    const key = { scriptPubKey: k.scriptPubKey, address: k.address, publicKey: hex(k.internalPub!), output: hex(k.output), secret: k.secret };
    const siteSpk = fromHex(k.scriptPubKey);
    const attacker = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(9)]);
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    tx.addInput({ txid: "33".repeat(32), index: 0, witnessUtxo: { script: siteSpk, amount: 100_000n } });
    tx.addOutput({ script: attacker, amount: 1_000n });
    tx.addOutput({ script: siteSpk, amount: 98_500n });
    const psbtHex = hex(tx.toPSBT());
    for (const t of [0x02, 0x03, 0x82, 0x83]) {
      const review = reviewPsbt(parsePsbt(psbtHex), key, () => "unknown", { toSignInputs: [{ index: 0, address: k.address, sighashTypes: [t] }] });
      expect(review.refuse).toMatch(/does not sign it/);
      expect(() => signReviewedPsbt(parsePsbt(psbtHex), review, key, false)).toThrow();
    }
    // With ALL the change output is committed: rewriting it breaks the signature.
    const review = reviewPsbt(parsePsbt(psbtHex), key, () => "unknown", { toSignInputs: [{ index: 0, address: k.address, sighashTypes: [0x01] }] });
    expect(review.refuse).toBeUndefined();
    expect(BigInt(review.spent) - BigInt(review.returned)).toBe(1_500n);
    const sig = parsePsbt(signReviewedPsbt(parsePsbt(psbtHex), review, key, false)).getInput(0).tapKeySig!;
    const evil = new btc.Transaction({ allowUnknownOutputs: true });
    evil.addInput({ txid: "33".repeat(32), index: 0, witnessUtxo: { script: siteSpk, amount: 100_000n } });
    evil.addOutput({ script: attacker, amount: 1_000n });
    evil.addOutput({ script: attacker, amount: 98_800n });
    const pre = evil.preimageWitnessV1(0, [siteSpk], 0x01, [100_000n]);
    expect(schnorr.verify(sig.slice(0, 64), pre, k.output)).toBe(false);
  });
});

describe("M3: a site's account can be found again from its address", () => {
  it("same origin, same account, added disconnected and watched", async () => {
    const mnemonic = createMnemonic(256);
    const a = new PrivateBit(memoryKv());
    await a.restore({ mnemonic, password: "password1", birthday: 10 });
    const first = await a.connectSite("https://app.example.com");
    const b = new PrivateBit(memoryKv());
    await b.restore({ mnemonic, password: "password1", birthday: 10 });
    const found = await b.findSite("https://app.example.com/");
    expect(found.index).toBe(first.index);
    expect(found.connected).toBe(false);
    const view = (await b.sitesView())[0]!;
    expect(view.address).toBe((await a.sitesView())[0]!.address);
    const watched = ((await b.loadScan()).watch ?? []).some((w) => w.kind === "site" && w.index === found.index);
    expect(watched).toBe(true);
  }, 30000);
});

describe("M5: the mailbox keys are fetched once and kept", () => {
  it("a second link, even from a new background, does not ask the mailbox again", async () => {
    const { encodeOhttpKeyConfig, genOhttpKeyPair } = await import("../src/lib/ohttp.ts");
    const { upsertUtxo } = await import("../src/lib/scan.ts");
    const body = encodeOhttpKeyConfig(genOhttpKeyPair());
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("/.well-known/ohttp-gateway")) throw new TypeError("network disabled");
      calls++;
      return new Response(body.slice().buffer as ArrayBuffer, { status: 200 });
    }) as typeof fetch;
    try {
      const kv = memoryKv();
      const w = new PrivateBit(kv);
      await w.create({ password: "password1", birthday: 8 });
      await w.saveChain({ ...(await w.loadChain()), payjoinDirectory: "https://mailbox.example", directMailboxKeys: true });
      const { account, scan } = await w.requireAccount();
      const t = sessionTweak("ab".repeat(32), 0);
      upsertUtxo(scan.utxos, { txid: "ab".repeat(32), vout: 0, value: "50000", scriptPubKey: hex(taprootScriptPubKey(tweakSpend(account.spendSecret, t).xonly)), tweak: hex(t), label: null, k: 0, height: 8, spent: false });
      const t2 = sessionTweak("cd".repeat(32), 0);
      upsertUtxo(scan.utxos, { txid: "cd".repeat(32), vout: 0, value: "60000", scriptPubKey: hex(taprootScriptPubKey(tweakSpend(account.spendSecret, t2).xonly)), tweak: hex(t2), label: null, k: 0, height: 8, spent: false });
      await w.saveScan(scan);
      await w.offerPayjoin(1000n);
      const again = new PrivateBit(kv);
      await again.unlock("password1");
      await again.offerPayjoin(2000n);
      expect((await again.loadPayjoinSessions()).length).toBe(2);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 30000);
});

describe("Audit v1 item 5: mailbox keys never come straight from the mailbox by default", () => {
  it("default mailbox uses the shipped keys; another needs the relay hook or the opt-in", async () => {
    const pj = await import("../src/lib/payjoin.ts");
    const { encodeOhttpKeyConfig, genOhttpKeyPair } = await import("../src/lib/ohttp.ts");
    const realFetch = globalThis.fetch;
    const direct: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      direct.push(String(input instanceof Request ? input.url : input));
      throw new TypeError("network disabled");
    }) as typeof fetch;
    const g = globalThis as { __pbFetchViaRelay?: (relay: string, url: string) => Promise<Uint8Array> };
    try {
      const shipped = await pj.fetchDirectoryOhttpBytes("https://payjo.in", { relay: "https://pj.bobspacebkk.com" });
      expect(hex(shipped)).toBe(pj.BUNDLED_OHTTP_KEYS["https://payjo.in"]);
      (await import("../src/lib/ohttp.ts")).parseOhttpKeys(shipped);
      await expect(pj.fetchDirectoryOhttpBytes("https://mailbox.example", { relay: "https://relay.example" })).rejects.toThrow(/IP address/);
      await expect(pj.fetchDirectoryOhttpBytes("https://mailbox.example", { relay: "https://relay.example", allowDirect: true })).rejects.toThrow(/network disabled/);
      expect(direct).toEqual(["https://mailbox.example/.well-known/ohttp-gateway"]);
      const body = encodeOhttpKeyConfig(genOhttpKeyPair());
      const seen: string[] = [];
      g.__pbFetchViaRelay = async (relay, url) => {
        seen.push(`${relay} ${url}`);
        return body;
      };
      expect(hex(await pj.fetchDirectoryOhttpBytes("https://mailbox.example", { relay: "https://relay.example" }))).toBe(hex(body));
      expect(seen).toEqual(["https://relay.example https://mailbox.example/.well-known/ohttp-gateway"]);
      expect(direct.length).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      delete g.__pbFetchViaRelay;
    }
  });
});

describe("L6: labels match only P_k + L", () => {
  it("an output at P_k - L is not taken as a labeled coin; P_k + L is, and its key signs", async () => {
    const b352 = await import("../src/lib/bip352.ts");
    const scanSecret = fromHex("11".repeat(32));
    const spendSecretB = fromHex("22".repeat(32));
    const spendPub = secp256k1.getPublicKey(spendSecretB, true);
    const a = fromHex("33".repeat(32));
    const vin = { txid: "44".repeat(32), vout: 0, pubkey: secp256k1.getPublicKey(a, true), taproot: false };
    const shared = b352.senderSharedSecret([{ ...vin, secret: a }], secp256k1.getPublicKey(scanSecret, true));
    const t = b352.outputTweak(shared, 0);
    const Pk = secp256k1.ProjectivePoint.fromHex(spendPub).add(secp256k1.ProjectivePoint.BASE.multiply(BigInt("0x" + hex(t))));
    const lt = b352.labelTweak(scanSecret, 3);
    const L = secp256k1.ProjectivePoint.BASE.multiply(BigInt("0x" + hex(lt)));
    const labels = b352.precomputeLabels(scanSecret, [3]);
    const detect = (P: typeof Pk) => b352.detectOurUtxos({ vins: [vin], taprootOutputs: [{ xonly: P.toRawBytes(true).slice(1), vout: 0 }], scanSecret, spendPub, labels });
    expect(detect(Pk.subtract(L))).toEqual([]);
    const hit = detect(Pk.add(L));
    expect(hit).toHaveLength(1);
    expect(hit[0]!.label).toBe(3);
    const d = b352.spendSecret({ spendSecret: spendSecretB, tweak: hit[0]!.tweak, label: 3, scanSecret });
    expect(hex(schnorr.getPublicKey(d))).toBe(hex(Pk.add(L).toRawBytes(true).slice(1)));
  });
});

describe("L7: payment links", () => {
  it("refuse test network codes and amounts with more than 8 decimals", async () => {
    const { parseBip21 } = await import("../src/lib/bip21.ts");
    expect(() => parseBip21("bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh?amount=0.123456789")).toThrow(/8 decimals/);
    expect(() => parseBip21("bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh?amount=1e3")).toThrow(/valid amount/);
    expect(parseBip21("bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh?amount=0.12345678").amount).toBe(12_345_678n);
    expect(() => parseBip21("tsp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv")).toThrow(/test network/);
    expect(() => parseBip21("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toThrow(/test network/);
  });
});

describe("L1, L2, L11: site limits", () => {
  it("a site cannot relay a transaction that does not spend its account", async () => {
    const w = new PrivateBit(memoryKv());
    await w.create({ password: "password1", birthday: 10 });
    await w.connectSite("https://app.example.com");
    const raw = "02000000" + "01" + "11".repeat(32) + "00000000" + "00" + "ffffffff" + "01" + "e803000000000000" + "16" + "0014" + "22".repeat(20) + "00000000";
    await expect(w.siteBroadcast("https://app.example.com", raw)).rejects.toThrow(/does not spend this site's account/);
  }, 30000);

  it("plain http only for this computer or the local network", async () => {
    const { cleartextAllowed } = await import("../src/lib/sites.ts");
    for (const h of ["localhost", "127.0.0.1", "[::1]", "192.168.1.20", "10.0.0.2", "172.20.1.1", "fd12:3456::1"]) expect(cleartextAllowed(h)).toBe(true);
    for (const h of ["example.com", "app.localhost.example", "8.8.8.8", "172.32.0.1", "2001:db8::1"]) expect(cleartextAllowed(h)).toBe(false);
  });

  it("a high site fee is called out", async () => {
    const { highFee } = await import("../src/ui/screens/dapp.ts");
    expect(highFee(100_000n, 20_000n, 50)).toBe(true);
    expect(highFee(100_000n, 2_000n, 250)).toBe(true);
    expect(highFee(100_000n, 2_000n, 10)).toBe(false);
  });
});

describe("M6: auto lock never waits for a Payjoin", () => {
  it("locks on time even with a payment link open", async () => {
    const { autoLockDecision } = await import("../src/lib/autolock.ts");
    expect(autoLockDecision({ last: 0 }, 15 * 60_000, 15).lock).toBe(true);
    expect(autoLockDecision({ last: 0 }, 15 * 60_000 - 1, 15).lock).toBe(false);
  });
});

describe("I2: unlock waits after wrong passwords, across restarts", () => {
  it("backs off exponentially and keeps the count on disk", async () => {
    const { unlockWaitMs } = await import("../src/lib/wallet.ts");
    expect([1, 2, 3, 4, 5, 20].map(unlockWaitMs)).toEqual([0, 0, 30_000, 60_000, 120_000, 3_600_000]);
    const kv = memoryKv();
    const w = new PrivateBit(kv);
    await w.create({ password: "right-password-1", birthday: 10 });
    await w.lock();
    for (let i = 0; i < 3; i++) await expect(w.unlock("nope")).rejects.toThrow(/wrong password/);
    await expect(w.unlock("right-password-1")).rejects.toThrow(/Too many wrong passwords/);
    // A fresh instance on the same storage (a restart) still waits.
    const again = new PrivateBit(kv);
    await expect(again.unlock("right-password-1")).rejects.toThrow(/Too many wrong passwords/);
  }, 60000);
});
