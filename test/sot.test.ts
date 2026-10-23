import { describe, expect, it } from "vitest";
import { assertScanSource, type ChainSource } from "../src/lib/chain.ts";
import { PolicyError, assertParentTxHex, rejectAddressUtxoAsSot } from "../src/lib/policy.ts";
import { voutFromParentHex } from "../src/lib/tx.ts";

describe("HTTP prevout is not the only source of truth", () => {
  it("rejects address-UTXO methods on a scan source", () => {
    const fake = {
      kind: "unisat" as const,
      getAddressUtxos: async (_a: string) => [{ txid: "00", vout: 0 }],
      async getTip() {
        return { height: 1, hash: "00" };
      },
      async getBlockHash() {
        return "00";
      },
      async getBlockTxids(_height: number) {
        return [];
      },
      async getTxHex() {
        return "";
      },
      async broadcast() {
        return "";
      },
      async estimateFeeSatPerVb() {
        return 1;
      },
    };
    expect(() => assertScanSource(fake)).toThrow(PolicyError);
  });

  it("refuse to invent prevouts from an empty parent hex", () => {
    expect(() => assertParentTxHex("", "dead")).toThrow(/parent tx hex/);
    expect(() => assertParentTxHex(undefined, "dead")).toThrow(PolicyError);
  });

  it("prevouts come from parent transaction outputs, not an address index", () => {
    expect(() => rejectAddressUtxoAsSot("unisat")).toThrow(/must not be the only source of truth/);
    expect(() => voutFromParentHex("", 0)).toThrow();
  });

  it("ChainSource type has tx hex, not address coins", () => {
    const keys: (keyof ChainSource)[] = [
      "getTip",
      "getBlockHash",
      "getBlockTxids",
      "getTxHex",
      "broadcast",
      "estimateFeeSatPerVb",
    ];
    expect(keys).not.toContain("getAddressUtxos");
  });
});
