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
