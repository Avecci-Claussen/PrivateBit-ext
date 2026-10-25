// dApp PSBTs: BIP342 script path signing for leaves that name this site's key, after checking the
// leaf is committed in the coin. Signatures are verified against the real sighash.
import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment";
import { schnorr } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import { fromHex, hex } from "../src/lib/bytes.ts";
import { siteKeyFromHd } from "../src/lib/keys.ts";
import { parsePsbt, reviewPsbt, signReviewedPsbt } from "../src/lib/sites.ts";

const k = siteKeyFromHd(HDKey.fromMasterSeed(new Uint8Array(64).fill(5)), 0x40000002, "bitcoin");
const key = { scriptPubKey: k.scriptPubKey, address: k.address, publicKey: hex(k.internalPub!), output: hex(k.output), secret: k.secret, internalSecret: k.internalSecret! };
const internalX = k.internalPub!.slice(1);
const xk = (b: number) => schnorr.getPublicKey(new Uint8Array(32).fill(b));
const dest = btc.p2tr(xk(4)).script;

/** A coin locked to `<key> OP_CHECKSIG` as one leaf, with an unspendable internal key (an inscription commit shape). */
function scriptCoin(leafKey: Uint8Array = internalX, extraLeaf = false) {
  const leaf = { script: btc.Script.encode([leafKey, "CHECKSIG"]) };
  const other = { script: btc.Script.encode([xk(8), "CHECKSIG"]) };
  const pay = btc.p2tr(btc.TAPROOT_UNSPENDABLE_KEY, extraLeaf ? [leaf, other] : leaf, undefined, true);
  return { pay, leafScript: leaf.script };
}
function psbtFor(pay: ReturnType<typeof btc.p2tr>, amount = 50_000n) {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: "44".repeat(32), index: 0, witnessUtxo: { script: pay.script, amount }, tapLeafScript: pay.tapLeafScript, tapInternalKey: pay.tapInternalKey });
  tx.addOutput({ script: dest, amount: amount - 500n });
  return hex(tx.toPSBT());
}

describe("script path signing for sites", () => {
  for (const extraLeaf of [false, true]) {
    it(`signs a leaf naming the site's key and the result verifies (${extraLeaf ? "two leaves" : "one leaf"})`, () => {
      const { pay, leafScript } = scriptCoin(internalX, extraLeaf);
      const psbt = psbtFor(pay);
      const review = reviewPsbt(parsePsbt(psbt), key, () => "unknown", { toSignInputs: [{ index: 0, publicKey: key.publicKey, disableTweakSigner: true }] });
      expect(review.refuse).toBeUndefined();
      expect(review.inputs[0]!.script?.key).toBe("internal");
      expect(review.warnings.join(" ")).toMatch(/script spend/);
      const done = parsePsbt(signReviewedPsbt(parsePsbt(psbt), review, key, true));
      const w = done.getInput(0).finalScriptWitness!;
      expect(w.length).toBe(3);
      expect(hex(w[1]!)).toBe(hex(leafScript));
      const pre = done.preimageWitnessV1(0, [pay.script], 0, [50_000n], -1, leafScript, 0xc0);
      expect(schnorr.verify(w[0]!, pre, internalX)).toBe(true);
      // The finished transaction spends the coin by its script.
      expect(done.extract().length).toBeGreaterThan(0);
    });
  }
  it("a leaf naming the output key signs with the tweaked key", () => {
    const { pay, leafScript } = scriptCoin(new Uint8Array(k.output));
    const psbt = psbtFor(pay);
    const review = reviewPsbt(parsePsbt(psbt), key, () => "unknown", { toSignInputs: [{ index: 0, address: k.address }] });
    expect(review.refuse).toBeUndefined();
    const done = parsePsbt(signReviewedPsbt(parsePsbt(psbt), review, key, false));
    const [[meta, sig]] = done.getInput(0).tapScriptSig!;
    expect(hex(meta.leafHash)).toBe(hex(tapLeafHash(leafScript, 0xc0)));
    const pre = done.preimageWitnessV1(0, [pay.script], 0, [50_000n], -1, leafScript, 0xc0);
    expect(schnorr.verify(sig, pre, k.output)).toBe(true);
  });
  it("refuses a leaf that is not committed in the coin it claims to spend", () => {
    const { pay } = scriptCoin();
    const other = scriptCoin(new Uint8Array(xk(3))).pay;
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    // Real coin is `other`; the PSBT claims our leaf with its control block.
    tx.addInput({ txid: "44".repeat(32), index: 0, witnessUtxo: { script: other.script, amount: 50_000n }, tapLeafScript: pay.tapLeafScript });
    tx.addOutput({ script: dest, amount: 49_500n });
    const review = reviewPsbt(parsePsbt(hex(tx.toPSBT())), key, () => "unknown", { toSignInputs: [{ index: 0, disableTweakSigner: true }] });
    expect(review.refuse).toMatch(/not part of the coin/);
  });
  it("never signs a script input the site did not name, nor a private coin's script", () => {
    const { pay } = scriptCoin();
    const psbt = psbtFor(pay);
    const auto = reviewPsbt(parsePsbt(psbt), key, () => "unknown");
    expect(auto.toSign).toEqual([]);
    expect(auto.refuse).toMatch(/Nothing in this request/);
    const priv = reviewPsbt(parsePsbt(psbt), key, () => "private", { toSignInputs: [{ index: 0, disableTweakSigner: true }] });
    expect(priv.refuse).toMatch(/private balance/);
  });
  it("an untweaked key path signature for the site's own coin is refused", () => {
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    tx.addInput({ txid: "55".repeat(32), index: 0, witnessUtxo: { script: fromHex(k.scriptPubKey), amount: 10_000n } });
    tx.addOutput({ script: dest, amount: 9_500n });
    const review = reviewPsbt(parsePsbt(hex(tx.toPSBT())), key, () => "unknown", { toSignInputs: [{ index: 0, address: k.address, disableTweakSigner: true }] });
    expect(review.refuse).toMatch(/untweaked key/);
  });
  it("a script that needs more than this signature is not finished silently", () => {
    const leaf = { script: btc.Script.encode([internalX, "CHECKSIGVERIFY", xk(6), "CHECKSIG"]) };
    const pay = btc.p2tr(btc.TAPROOT_UNSPENDABLE_KEY, leaf, undefined, true);
    const psbt = psbtFor(pay);
    const review = reviewPsbt(parsePsbt(psbt), key, () => "unknown", { toSignInputs: [{ index: 0, disableTweakSigner: true }] });
    expect(review.refuse).toBeUndefined();
    expect(() => signReviewedPsbt(parsePsbt(psbt), review, key, true)).toThrow(/autoFinalized/);
    const partial = parsePsbt(signReviewedPsbt(parsePsbt(psbt), review, key, false));
    expect(partial.getInput(0).tapScriptSig?.length).toBe(1);
  });
});
