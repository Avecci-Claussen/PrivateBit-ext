import { describe, expect, it } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import { hex } from "../src/lib/bytes.ts";
import { oneTimeKey, ONE_TIME_ACCOUNT_PATH } from "../src/lib/keys.ts";
import { FRACTAL } from "../src/lib/network.ts";
import { emptyOneTime, issueRecord, nextOneTimeIndex, setOneTimeStatus, syncOneTimeWithScan, visibleRecord } from "../src/lib/onetime.ts";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const NET = { bech32: FRACTAL.bech32, pubKeyHash: FRACTAL.pubKeyHash, scriptHash: FRACTAL.scriptHash, wif: FRACTAL.wif };

describe("one-time migration address (BIP86)", () => {
  const seed = mnemonicToSeedSync(MNEMONIC);

  it("uses m/86'/8228'/0'/0/i", () => {
    expect(ONE_TIME_ACCOUNT_PATH).toBe("m/86'/8228'/0'/0");
    expect(oneTimeKey(seed, 3).path).toBe("m/86'/8228'/0'/0/3");
  });

  it("matches an independent @scure/bip32 + btc.p2tr derivation", () => {
    for (let i = 0; i < 5; i++) {
      const node = HDKey.fromMasterSeed(seed).derive(`m/86'/8228'/0'/0/${i}`);
      const xonly = node.publicKey!.slice(1);
      const ref = btc.p2tr(xonly, undefined, NET);
      const ours = oneTimeKey(seed, i);
      expect(hex(ours.internal)).toBe(hex(xonly));
      expect(ours.address).toBe(ref.address);
      expect(ours.scriptPubKey).toBe(hex(ref.script));
      expect(ours.address.startsWith("bc1p")).toBe(true);
      // The spend secret signs for the tweaked output key.
      expect(hex(schnorr.getPublicKey(ours.secret))).toBe(hex(ours.output));
      expect(hex(ref.tweakedPubkey)).toBe(hex(ours.output));
    }
  });

  it("is not the Bitcoin coin type path", () => {
    const btcPath = HDKey.fromMasterSeed(seed).derive("m/86'/0'/0'/0/0");
    expect(hex(oneTimeKey(seed, 0).internal)).not.toBe(hex(btcPath.publicKey!.slice(1)));
  });

  it("never reuses an index", () => {
    let s = emptyOneTime();
    s = issueRecord(s, "a0", 1);
    expect(nextOneTimeIndex(s)).toBe(1);
    expect(() => issueRecord(s, "again", 2, 0)).toThrow();
    s = setOneTimeStatus(s, 0, "swept");
    expect(visibleRecord(s)).toBeUndefined();
    s = issueRecord(s, "a1", 3);
    expect(s.records.map((r) => r.index)).toEqual([0, 1]);
    expect(visibleRecord(s)?.index).toBe(1);
  });

  it("reopens a swept address when another payment is still there", () => {
    const swept = setOneTimeStatus(issueRecord(emptyOneTime(), "bc1p", 1, 0), 0, "swept");
    const again = syncOneTimeWithScan(
      {
        utxos: [
          { kind: "bip86" as const, index: 0, spent: true },
          { kind: "bip86" as const, index: 0, spent: false },
        ],
      },
      swept,
    );
    expect(again.changedOt).toBe(true);
    expect(again.records[0]?.status).toBe("funded");
    expect(again.utxosSpent).toEqual([true, false]);

    const funded = setOneTimeStatus(issueRecord(emptyOneTime(), "bc1p", 1, 0), 0, "funded");
    const partial = syncOneTimeWithScan(
      {
        utxos: [
          { kind: "bip86" as const, index: 0, spent: true },
          { kind: "bip86" as const, index: 0, spent: false },
        ],
      },
      funded,
    );
    expect(partial.records[0]?.status).toBe("funded");
    const done = syncOneTimeWithScan(
      {
        utxos: [
          { kind: "bip86" as const, index: 0, spent: true },
          { kind: "bip86" as const, index: 0, spent: true },
        ],
      },
      funded,
    );
    expect(done.changedOt).toBe(true);
    expect(done.records[0]?.status).toBe("swept");
    expect(done.utxosSpent).toEqual([true, true]);
  });
});
