import { describe, expect, it } from "vitest";
import { extractUnisatTxids, nextUnisatOffset, parseUnisatInputs, parseUnisatUtxoData, unwrapUnisat } from "../src/lib/chain.ts";
import { migrateChainConfig } from "../src/lib/network.ts";

describe("UniSat envelope and block-tx pages", () => {
  it("unwraps code===0 data and rejects other codes", () => {
    expect(unwrapUnisat({ code: 0, msg: "ok", data: { blocks: 9 } }, "info")).toEqual({ blocks: 9 });
    expect(() => unwrapUnisat({ code: 1, msg: "no" }, "info")).toThrow(/no/);
  });

  it("reads txids from a list of tx objects (live block/{height}/txs shape)", () => {
    expect(
      extractUnisatTxids([
        { txid: "aa".repeat(32) },
        { txid: "bb".repeat(32) },
      ]),
    ).toEqual(["aa".repeat(32), "bb".repeat(32)]);
  });

  it("reads txids from docs-style {detail,total,start}", () => {
    expect(
      extractUnisatTxids({
        total: 2,
        start: 0,
        detail: [{ txid: "cc".repeat(32) }, "dd".repeat(32)],
      }),
    ).toEqual(["cc".repeat(32), "dd".repeat(32)]);
  });

  it("parses address utxo-data as watch hints, ignoring spent rows", () => {
    expect(
      parseUnisatUtxoData({
        cursor: 0,
        total: 2,
        utxo: [
          { txid: "82dba66683ee124bfe16ca58bbb85980013cfd9dabf36054975ab157bc50b2c9", vout: 0, height: 2231920, isSpent: false },
          { txid: "aa".repeat(32), vout: 1, height: 9, isSpent: true },
        ],
      }),
    ).toEqual([{ txid: "82dba66683ee124bfe16ca58bbb85980013cfd9dabf36054975ab157bc50b2c9", height: 2231920, vout: 0 }]);
  });

  it("keeps value, output index and script from an unspent row", () => {
    const script = "5120" + "ab".repeat(32);
    expect(
      parseUnisatUtxoData({
        utxo: [{ txid: "cd".repeat(32), vout: 1, height: 12, satoshi: 30000000, scriptPk: script.toUpperCase(), isSpent: false }],
      }),
    ).toEqual([{ txid: "cd".repeat(32), height: 12, vout: 1, value: "30000000", scriptPubKey: script }]);
  });

  it("reads prevout scripts from an ins page and ignores the spending txid", () => {
    const parent = "ab".repeat(32);
    expect(
      parseUnisatInputs([
        { txid: "cc".repeat(32), utxid: parent, vout: 2, scriptPk: "5120" + "11".repeat(32) },
        { txid: "cc".repeat(32), utxid: "nope", vout: 0, scriptPk: "5120" },
      ]),
    ).toEqual([{ txid: parent, vout: 2, scriptPubKey: "5120" + "11".repeat(32) }]);
  });

  it("advances UniSat cursor by the row count, not the echoed offset", () => {
    expect(nextUnisatOffset(0, 500, 500)).toBe(500);
    expect(nextUnisatOffset(0, 25, 200)).toBeNull();
    expect(nextUnisatOffset(300, 98, 100, 398)).toBeNull();
    expect(nextUnisatOffset(200, 100, 100, 398)).toBe(300);
    expect(nextUnisatOffset(0, 0, 100, 398)).toBeNull();
  });

  it("rewrites mempool Esplora configs to UniSat", () => {
    const migrated = migrateChainConfig({
      kind: "esplora",
      url: "https://mempool.fractalbitcoin.io/api",
    });
    expect(migrated.kind).toBe("unisat");
    expect(migrated.url).toBe("https://open-api-fractal.unisat.io");
    expect(migrated.url).not.toMatch(/mempool/);
    expect(migrated.payjoinDirectory).toBe("https://payjo.in");
  });

  it("fills a public Payjoin mailbox when none was saved", () => {
    const migrated = migrateChainConfig({ kind: "unisat", url: "https://open-api-fractal.unisat.io" });
    expect(migrated.payjoinDirectory).toBe("https://payjo.in");
  });

  it("migrates ntfy.sh off the default: it cannot carry 7168-byte HPKE bodies", () => {
    const migrated = migrateChainConfig({
      kind: "unisat",
      url: "https://open-api-fractal.unisat.io",
      payjoinDirectory: "https://ntfy.sh",
    });
    expect(migrated.payjoinDirectory).toBe("https://payjo.in");
  });
});
