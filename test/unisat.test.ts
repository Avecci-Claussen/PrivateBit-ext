import { describe, expect, it } from "vitest";
import { extractUnisatTxids, unwrapUnisat } from "../src/lib/chain.ts";
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

  it("migrates ntfy.sh off the default — it cannot carry 7168-byte HPKE bodies", () => {
    const migrated = migrateChainConfig({
      kind: "unisat",
      url: "https://open-api-fractal.unisat.io",
      payjoinDirectory: "https://ntfy.sh",
    });
    expect(migrated.payjoinDirectory).toBe("https://payjo.in");
  });
});
