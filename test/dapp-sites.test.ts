import { describe, expect, it } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import * as btc from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { fromHex, hex } from "../src/lib/bytes.ts";
import { oneTimeKeyFromHd, siteKeyFromHd, sitePath, taprootKeyAt } from "../src/lib/keys.ts";
import {
  bip322MessageHash,
  bip322Sighash,
  bip322ToSpendTxid,
  buildSiteSend,
  chainInfo,
  ecdsaMessageHash,
  normalizeOrigin,
  parsePsbt,
  pickSiteIndex,
  reviewPsbt,
  signMessageBip322,
  signMessageEcdsa,
  signReviewedPsbt,
  siteIndex,
  upsertSite,
  emptySites,
  type SiteKey,
} from "../src/lib/sites.ts";
import { DappError, ERR, parseEnvelope, parseRequest, RateLimit } from "../src/lib/dapp-proto.ts";
import { privateUtxos, type LabeledUtxo } from "../src/lib/scan.ts";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const hd = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));

function key(origin: string, net: "fractal" | "bitcoin" = "fractal"): SiteKey {
  const k = siteKeyFromHd(hd, siteIndex(origin), net);
  return { index: k.index, path: k.path, scriptPubKey: k.scriptPubKey, address: k.address, publicKey: hex(k.internalPub!), output: hex(k.output), secret: k.secret, internalSecret: k.internalSecret! };
}

describe("site account derivation", () => {
  it("BIP86 math matches the BIP86 test vector at m/86'/0'/0'/0/0", () => {
    const k = taprootKeyAt(hd, "m/86'/0'/0'/0/0", 0);
    expect(k.address).toBe("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr");
    expect(hex(k.internal)).toBe("cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115");
  });
  it("one-time keys are unchanged by the refactor", () => {
    const k = oneTimeKeyFromHd(hd, 3, "fractal");
    expect(k.path).toBe("m/86'/8228'/0'/0/3");
    expect(k.address).toBe(taprootKeyAt(hd, "m/86'/8228'/0'/0/3", 3).address);
  });
  it("index is deterministic, hardened range 2^30..2^31-1, per origin", () => {
    const a = siteIndex("https://app.example.com");
    expect(a).toBe(siteIndex("https://APP.example.com/path?x=1"));
    expect(a).toBeGreaterThanOrEqual(0x40000000);
    expect(a).toBeLessThan(0x80000000);
    expect(siteIndex("https://other.example.com")).not.toBe(a);
    expect(siteIndex("http://app.example.com")).not.toBe(a);
    expect(siteIndex("https://app.example.com", 1)).not.toBe(a);
  });
  it("path is m/86'/coin'/index'/0/0 and differs per chain", () => {
    const i = siteIndex("https://app.example.com");
    expect(sitePath(i, "fractal")).toBe(`m/86'/8228'/${i}'/0/0`);
    expect(sitePath(i, "bitcoin")).toBe(`m/86'/0'/${i}'/0/0`);
    expect(key("https://app.example.com", "fractal").address).not.toBe(key("https://app.example.com", "bitcoin").address);
    expect(() => sitePath(352, "bitcoin")).toThrow();
  });
  it("different sites get unrelated accounts", () => {
    expect(key("https://a.example").address).not.toBe(key("https://b.example").address);
  });
  it("collision with another origin moves to the next attempt", () => {
    const o = "https://app.example.com";
    const taken = [{ origin: "https://x.test", index: siteIndex(o), connected: true, connectedAt: 0 }];
    expect(pickSiteIndex(o, taken)).toBe(siteIndex(o, 1));
    expect(pickSiteIndex(o, [{ ...taken[0]!, origin: o }])).toBe(siteIndex(o));
  });
  it("origins: only http(s)", () => {
    expect(normalizeOrigin("https://a.b:8443/x")).toBe("https://a.b:8443");
    expect(() => normalizeOrigin("file:///etc/passwd")).toThrow();
    expect(() => normalizeOrigin("chrome-extension://abc")).toThrow();
    expect(() => normalizeOrigin("null")).toThrow();
  });
  it("upsert keeps the index across reconnects", () => {
    const a = upsertSite(emptySites(), "https://a.example", 1);
    const b = upsertSite({ ...a.store, sites: [{ ...a.site, connected: false }] }, "https://a.example/", 2);
    expect(b.site.index).toBe(a.site.index);
    expect(b.site.connected).toBe(true);
    expect(b.store.sites.length).toBe(1);
  });
  it("chain names", () => {
    expect(chainInfo("fractal").enum).toBe("FRACTAL_BITCOIN_MAINNET");
    expect(chainInfo("bitcoin")).toEqual({ enum: "BITCOIN_MAINNET", name: "Bitcoin Mainnet", network: "livenet" });
  });
  it("private views drop site coins", () => {
    const u = [{ kind: "site" }, { kind: "bip86" }, {}] as LabeledUtxo[];
    expect(privateUtxos(u).length).toBe(2);
  });
});

describe("message signing", () => {
  it("BIP322 message hash vectors", () => {
    expect(hex(bip322MessageHash(""))).toBe("c90c269c4f8fcbe6880f72a721ddfbf1914268a794cbb21cfafee13770ae19f1");
    expect(hex(bip322MessageHash("Hello World"))).toBe("f0eb03b1a75ac6d9847f55c624a99169b5dccba2a31f5b23bea77ba270de0a7a");
  });
  it("BIP322 to_spend txid vectors", () => {
    const spk = "00142b05d564e6a7a33c087f16e0f730d1440123799d"; // bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l
    expect(bip322ToSpendTxid("", spk)).toBe("c5680aa69bb8d860bf82d4e9cd3504b55dde018de765a91bb566283c545a99a7");
    expect(bip322ToSpendTxid("Hello World", spk)).toBe("b79d196740ad5217771c1098fc4a4b51e0535c32236c71f1ea4d61a2d603352b");
  });
  it("BIP322 simple P2TR signature verifies against the output key", () => {
    const k = key("https://app.example.com");
    const sig = signMessageBip322("Hello World", k);
    const w = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    expect(w[0]).toBe(1);
    expect(w[1]).toBe(64);
    expect(schnorr.verify(w.slice(2), bip322Sighash("Hello World", k.scriptPubKey), fromHex(k.output))).toBe(true);
  });
  it("ECDSA message signature recovers the public key getPublicKey returns", () => {
    const k = key("https://app.example.com");
    const b = Uint8Array.from(atob(signMessageEcdsa("hello", k.internalSecret)), (c) => c.charCodeAt(0));
    expect(b.length).toBe(65);
    const recid = b[0]! - 31;
    const sig = secp256k1.Signature.fromCompact(b.slice(1)).addRecoveryBit(recid);
    expect(sig.recoverPublicKey(ecdsaMessageHash("hello")).toHex(true)).toBe(k.publicKey);
  });
});

const NET = { bech32: "bc", pubKeyHash: 0, scriptHash: 5, wif: 0x80 };
function psbtFor(inputs: { script: string; amount: bigint; txid?: string; sighashType?: number }[], outputs: { script: string; amount: bigint }[]): string {
  const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  inputs.forEach((x, i) => tx.addInput({ txid: x.txid ?? (i + 1).toString(16).padStart(64, "0"), index: 0, witnessUtxo: { script: fromHex(x.script), amount: x.amount }, ...(x.sighashType !== undefined ? { sighashType: x.sighashType } : {}) }));
  outputs.forEach((o) => tx.addOutput({ script: fromHex(o.script), amount: o.amount }));
  return hex(tx.toPSBT());
}

describe("PSBT review and signing", () => {
  const k = key("https://app.example.com");
  const other = "5120" + hex(schnorr.getPublicKey(fromHex("11".repeat(32))));
  const priv = "5120" + hex(schnorr.getPublicKey(fromHex("22".repeat(32))));
  const owner = (s: string): "private" | "unknown" => (s === priv ? "private" : "unknown");

  it("shows what leaves, what returns and the fee; signs and finalizes", () => {
    const p = psbtFor([{ script: k.scriptPubKey, amount: 10_000n }], [{ script: other, amount: 6_000n }, { script: k.scriptPubKey, amount: 3_500n }]);
    const tx = parsePsbt(p);
    const r = reviewPsbt(tx, k, owner);
    expect(r.refuse).toBeUndefined();
    expect(r.toSign).toEqual([0]);
    expect(r.spent).toBe("10000");
    expect(r.leaves).toBe("6000");
    expect(r.returned).toBe("3500");
    expect(r.fee).toBe("500");
    const out = parsePsbt(signReviewedPsbt(tx, r, k, true));
    const w = out.getInput(0).finalScriptWitness!;
    expect(w.length).toBe(1);
    const pre = out.preimageWitnessV1(0, [fromHex(k.scriptPubKey)], 0, [10_000n]);
    expect(schnorr.verify(w[0]!, pre, fromHex(k.output))).toBe(true);
  });
  it("base64 input works and autoFinalized false leaves tapKeySig", () => {
    const p = psbtFor([{ script: k.scriptPubKey, amount: 10_000n }], [{ script: other, amount: 9_000n }]);
    const b64 = btoa(String.fromCharCode(...fromHex(p)));
    const tx = parsePsbt(b64);
    const r = reviewPsbt(tx, k, owner);
    const out = parsePsbt(signReviewedPsbt(tx, r, k, false));
    expect(out.getInput(0).tapKeySig?.length).toBe(64);
    expect(out.getInput(0).finalScriptWitness).toBeUndefined();
  });
  it("refuses private coin inputs", () => {
    const tx = parsePsbt(psbtFor([{ script: k.scriptPubKey, amount: 10_000n }, { script: priv, amount: 5_000n }], [{ script: other, amount: 14_000n }]));
    const r = reviewPsbt(tx, k, owner);
    expect(r.refuse).toMatch(/private balance/);
    expect(() => signReviewedPsbt(tx, r, k)).toThrow(/private/);
  });
  it("refuses other sites' coins", () => {
    const tx = parsePsbt(psbtFor([{ script: k.scriptPubKey, amount: 10_000n }, { script: other, amount: 5_000n }], [{ script: other, amount: 14_000n }]));
    expect(reviewPsbt(tx, k, (s) => (s === other ? "other-site" : "unknown")).refuse).toMatch(/another website/);
  });
  it("warns about inputs that are not yours, and signs only its own", () => {
    const tx = parsePsbt(psbtFor([{ script: other, amount: 5_000n }, { script: k.scriptPubKey, amount: 10_000n }], [{ script: other, amount: 14_000n }]));
    const r = reviewPsbt(tx, k, owner);
    expect(r.toSign).toEqual([1]);
    expect(r.warnings.join(" ")).toMatch(/Input 0 is not yours/);
  });
  it("refuses when toSignInputs names a non-site key or a foreign input", () => {
    const tx = parsePsbt(psbtFor([{ script: other, amount: 5_000n }, { script: k.scriptPubKey, amount: 10_000n }], [{ script: other, amount: 14_000n }]));
    expect(reviewPsbt(tx, k, owner, { toSignInputs: [{ index: 1, address: "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr" }] }).refuse).toMatch(/not this site/);
    expect(reviewPsbt(tx, k, owner, { toSignInputs: [{ index: 0, publicKey: k.publicKey }] }).refuse).toMatch(/not paid to this site/);
    expect(reviewPsbt(tx, k, owner, { toSignInputs: [{ index: 9 }] }).refuse).toMatch(/does not exist/);
    expect(reviewPsbt(tx, k, owner, { toSignInputs: [{ index: 1, publicKey: k.publicKey }] }).refuse).toBeUndefined();
  });
  it("sighash (audit H3): SINGLE and NONE refused in every form; ALL|ANYONECANPAY warns and signs with the type byte", () => {
    const mk = () => parsePsbt(psbtFor([{ script: k.scriptPubKey, amount: 10_000n }], [{ script: other, amount: 9_000n }]));
    for (const t of [0x02, 0x03, 0x82, 0x83]) expect(reviewPsbt(mk(), k, owner, { toSignInputs: [{ index: 0, address: k.address, sighashTypes: [t] }] }).refuse).toMatch(/does not sign it/);
    const tx = mk();
    const r = reviewPsbt(tx, k, owner, { toSignInputs: [{ index: 0, address: k.address, sighashTypes: [0x81] }] });
    expect(r.refuse).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/ALL\|ANYONECANPAY/);
    const out = parsePsbt(signReviewedPsbt(tx, r, k, false));
    expect(out.getInput(0).tapKeySig?.length).toBe(65);
    expect(() => signReviewedPsbt(mk(), reviewPsbt(mk(), k, owner, { toSignInputs: [{ index: 0, sighashTypes: [0x83] }] }), k)).toThrow();
  });
  it("nothing to sign is refused", () => {
    const tx = parsePsbt(psbtFor([{ script: other, amount: 5_000n }], [{ script: other, amount: 4_000n }]));
    expect(reviewPsbt(tx, k, owner).refuse).toMatch(/Nothing/);
  });
  it("rejects junk PSBTs", () => {
    expect(() => parsePsbt("00ff")).toThrow(/not a valid PSBT/);
  });
});

describe("site sends", () => {
  const k = key("https://app.example.com");
  const coin = (v: number, n = 1): LabeledUtxo => ({ txid: n.toString(16).padStart(64, "0"), vout: 0, value: String(v), scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, height: 10, spent: false, kind: "site", index: k.index });
  const to = btc.Address(NET).encode(btc.OutScript.decode(fromHex("5120" + hex(schnorr.getPublicKey(fromHex("33".repeat(32)))))));
  it("change returns to the same site account, memo included", () => {
    const p = buildSiteSend({ coins: [coin(50_000)], key: k, to, amount: 10_000n, feeRate: 2, memos: ["hi"] });
    const tx = btc.Transaction.fromRaw(fromHex(p.txHex), { allowUnknownOutputs: true });
    expect(tx.outputsLength).toBe(3);
    expect(hex(tx.getOutput(2).script!)).toBe(k.scriptPubKey);
    expect(BigInt(p.change) + BigInt(p.fee) + 10_000n).toBe(50_000n);
    expect(hex(tx.getOutput(1).script!)).toBe("6a026869");
  });
  it("not enough is an error", () => {
    expect(() => buildSiteSend({ coins: [coin(5_000)], key: k, to, amount: 10_000n, feeRate: 2 })).toThrow(/not enough/);
  });
  it("bad address is an error", () => {
    expect(() => buildSiteSend({ coins: [coin(50_000)], key: k, to: "sp1qq", amount: 10_000n, feeRate: 2 })).toThrow(/address/);
  });
});

describe("provider request validation", () => {
  const code = (f: () => unknown): number | undefined => {
    try {
      f();
    } catch (e) {
      return e instanceof DappError ? e.code : -1;
    }
    return undefined;
  };
  it("plain methods", () => {
    expect(parseRequest("getAccounts", [])).toEqual({ method: "getAccounts" });
    expect(parseRequest("getBalance", undefined)).toEqual({ method: "getBalance" });
  });
  it("unknown and wrong-shaped requests", () => {
    expect(code(() => parseRequest("eth_sendTransaction", []))).toBe(ERR.unsupported);
    expect(code(() => parseRequest(42, []))).toBe(ERR.invalid);
    expect(code(() => parseRequest("getAccounts", "x"))).toBe(ERR.invalid);
    expect(code(() => parseRequest("signMessage", [{}]))).toBe(ERR.invalid);
    expect(code(() => parseRequest("signMessage", ["x", "schnorr"]))).toBe(ERR.invalid);
    expect(code(() => parseRequest("signPsbt", ["not a psbt!"]))).toBe(ERR.invalid);
    expect(code(() => parseRequest("pushTx", [{ rawtx: "zz" }]))).toBe(ERR.invalid);
    expect(code(() => parseRequest("sendBitcoin", ["bc1x", 10]))).toBe(ERR.invalid);
    expect(code(() => parseRequest("sendBitcoin", ["bc1x", 1000, { feeRate: -1 }]))).toBe(ERR.invalid);
    expect(code(() => parseRequest("switchChain", ["ETHEREUM"]))).toBe(ERR.unsupported);
    expect(code(() => parseRequest("switchNetwork", ["testnet"]))).toBe(ERR.unsupported);
    expect(code(() => parseRequest("signPsbt", ["00", { toSignInputs: [{ index: -1 }] }]))).toBe(ERR.invalid);
    expect(code(() => parseRequest("signMessage", ["x".repeat(10_001)]))).toBe(ERR.invalid);
  });
  it("null optional params (JSON over the port) mean omitted", () => {
    expect(parseRequest("signMessage", ["hi", null])).toMatchObject({ type: "ecdsa" });
    expect(parseRequest("signPsbt", ["70736274ff", null])).toMatchObject({ options: { autoFinalized: true } });
  });
  it("signMessage defaults to ecdsa", () => {
    expect(parseRequest("signMessage", ["hi"])).toEqual({ method: "signMessage", text: "hi", type: "ecdsa" });
    expect(parseRequest("signMessage", ["hi", "bip322-simple"])).toMatchObject({ type: "bip322-simple" });
  });
  it("signPsbt options", () => {
    expect(parseRequest("signPsbt", ["70736274ff"])).toEqual({ method: "signPsbt", psbt: "70736274ff", options: { autoFinalized: true } });
    const r = parseRequest("signPsbt", ["70736274ff", { autoFinalized: false, toSignInputs: [{ index: 0, publicKey: "02AA", sighashTypes: [1] }] }]);
    expect(r).toMatchObject({ options: { autoFinalized: false, toSignInputs: [{ index: 0, publicKey: "02aa", sighashTypes: [1] }] } });
    expect(parseRequest("signPsbts", [["70736274ff", "cHNidP8="]])).toMatchObject({ psbts: ["70736274ff", "cHNidP8="] });
  });
  it("sendBitcoin and switchChain", () => {
    expect(parseRequest("sendBitcoin", ["bc1q", 1000, { feeRate: 3, memo: "a", memos: ["b"] }])).toEqual({ method: "sendBitcoin", to: "bc1q", sats: 1000, feeRate: 3, memos: ["a", "b"] });
    expect(parseRequest("switchChain", ["BITCOIN_MAINNET"])).toEqual({ method: "switchChain", chain: "bitcoin" });
    expect(parseRequest("pushTx", [{ rawtx: "AB" }])).toEqual({ method: "pushTx", rawtx: "ab" });
  });
  it("envelopes", () => {
    expect(parseEnvelope({ id: 1, method: "x" })).toMatchObject({ id: 1 });
    expect(parseEnvelope({ id: "1" })).toBeNull();
    expect(parseEnvelope(null)).toBeNull();
  });
  it("rate limit", () => {
    const r = new RateLimit(2, 1000);
    expect(r.take("a", 0)).toBe(true);
    expect(r.take("a", 1)).toBe(true);
    expect(r.take("a", 2)).toBe(false);
    expect(r.take("b", 2)).toBe(true);
    expect(r.take("a", 1500)).toBe(true);
  });
});
