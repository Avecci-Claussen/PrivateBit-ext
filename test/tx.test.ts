import { describe, expect, it } from "vitest";
import { extractEligibleVins } from "../src/lib/extract-inputs.ts";
import { hex } from "../src/lib/bytes.ts";
import type { ChainSource } from "../src/lib/chain.ts";
import { accountFromVault } from "../src/lib/keys.ts";
import { scanTransaction } from "../src/lib/scan.ts";
import { parseTxHex, scureIdHex, taprootOutputs, voutFromParentHex } from "../src/lib/tx.ts";
import { createMnemonic, vaultFromMnemonic } from "../src/lib/vault.ts";

/** Fractal 2228749 / 0a601319…: P2WPKH → unique SP P2TR + change. */
const SP_SEND_HEX =
  "020000000001016adc76da1ae0abb6050662c118f37341ffdddb7a32cc85ba3ef61418542fc26d0000000000ffffffff0240420f00000000002251203c8284b9fa541f6187f688982ac1a0e91c3de19a0f69d1bd069ac27c3847a6cdb453890000000000160014ee4fbefa4054af754130fbc8d71999e132ce5c8402473044022044d57365294352ca4ab4c0d7fa3a4f13142cde3fb9bad8e9a2ce24f2ae7476a502207002cf6e791bc6992901be2bcad942a192f34f69f1c300f67eba6549d8f305b401210328633a52a04265a2fe17b75b34211fcbf8f05f8b8fa7c10ce4bbe2f2d20e616800000000";
const PARENT_HEX =
  "02000000000101194fe2b88b379a8b8e27e5ea0200e4696552ca489d259d417f395a6b32f820d70100000000ffffffff028096980000000000160014ee4fbefa4054af754130fbc8d71999e132ce5c84ca18260900000000160014c751cca110542623f1972a8094a51fe46e201b6e02473044022027cba52939be6e3d0412e61cd8401e093ef34f6e806f72ed0dffc2e08a9bf90a02201fe83f1db9f6bd753378a42a4a796d1f1237d218ce3bd07c2f1058e7b821c6950121021f26499e0221c905602c5b0c02e097f5210444717582d41caca3061df50f740600000000";

describe("parseTxHex", () => {
  it("accepts scure tx.id as a hex string (btc-signer 1.8)", () => {
    expect(scureIdHex("0a6013191e7965a1f41d901e926cdbc2c2f80b5d58a5f8916e438eebc19168b0")).toBe(
      "0a6013191e7965a1f41d901e926cdbc2c2f80b5d58a5f8916e438eebc19168b0",
    );
    expect(() => scureIdHex("dead")).not.toThrow();
  });

  it("parses the first Fractal Silent Payment send instead of throwing on string tx.id", () => {
    const tx = parseTxHex(SP_SEND_HEX);
    expect(tx.txid).toBe("0a6013191e7965a1f41d901e926cdbc2c2f80b5d58a5f8916e438eebc19168b0");
    expect(tx.vin).toHaveLength(1);
    expect(tx.vin[0].txid).toBe("6dc22f541814f63eba85cc327adbddff4173f318c1620605b6abe01ada76dc6a");
    expect(tx.vin[0].vout).toBe(0);
    expect(tx.vin[0].witness.at(-1)).toMatch(/^03[0-9a-f]{64}$/);
    const taps = taprootOutputs(tx);
    expect(taps).toHaveLength(1);
    expect(hex(taps[0].xonly)).toBe("3c8284b9fa541f6187f688982ac1a0e91c3de19a0f69d1bd069ac27c3847a6cd");
    expect(taps[0].value).toBe(1_000_000n);
  });

  it("extracts the P2WPKH input pubkey from parent prevout + witness", () => {
    const tx = parseTxHex(SP_SEND_HEX);
    const prev = voutFromParentHex(PARENT_HEX, 0);
    expect(hex(prev.scriptPubKey)).toBe("0014ee4fbefa4054af754130fbc8d71999e132ce5c84");
    const eligible = extractEligibleVins([
      {
        txid: tx.vin[0].txid,
        vout: tx.vin[0].vout,
        scriptSig: tx.vin[0].scriptSig,
        txinwitness: tx.vin[0].witness,
        prevout: { scriptPubKey: { hex: hex(prev.scriptPubKey) } },
      },
    ]);
    expect(eligible).not.toBeNull();
    expect(eligible).toHaveLength(1);
    expect(eligible![0].taproot).toBe(false);
    expect(hex(eligible![0].pubkey)).toBe("0328633a52a04265a2fe17b75b34211fcbf8f05f8b8fa7c10ce4bbe2f2d20e6168");
  });

  it("scanTransaction no longer throws on string tx.id, so the send is not skipped", async () => {
    const account = accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 2_228_749 }));
    const source: ChainSource = {
      kind: "unisat",
      async getTip() {
        return { height: 2_228_749, hash: "00" };
      },
      async getBlockHash() {
        return "00";
      },
      async getBlockTxids() {
        return ["0a6013191e7965a1f41d901e926cdbc2c2f80b5d58a5f8916e438eebc19168b0"];
      },
      async getTxHex(txid) {
        if (txid === "6dc22f541814f63eba85cc327adbddff4173f318c1620605b6abe01ada76dc6a") return PARENT_HEX;
        if (txid === "0a6013191e7965a1f41d901e926cdbc2c2f80b5d58a5f8916e438eebc19168b0") return SP_SEND_HEX;
        throw new Error(`unexpected ${txid}`);
      },
      async broadcast() {
        return "";
      },
      async estimateFeeSatPerVb() {
        return 1;
      },
    };
    const hits = await scanTransaction(account, source, SP_SEND_HEX, 2_228_749);
    expect(Array.isArray(hits)).toBe(true);
  });
});
