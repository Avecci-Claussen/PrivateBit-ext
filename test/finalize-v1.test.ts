import { describe, expect, it } from "vitest";
import { getPriceWithFallback, parseCoingecko, parseMexc } from "../src/lib/requests.ts";
import { normalizePrefs } from "../src/lib/prefs.ts";
import { checkPayjoinUrls } from "../src/lib/payjoin.ts";
import { taprootAddress, deriveHistory } from "../src/lib/history.ts";
import { netInfo, derivationPath } from "../src/lib/network.ts";
import { memoryKv } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";
import { emptyScanStore } from "../src/lib/scan.ts";

const asset = netInfo("fractal").price;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("USD price sources", () => {
  it("reads CoinGecko and MEXC answers", () => {
    expect(parseCoingecko({ "fractal-bitcoin": { usd: 0.38, last_updated_at: 1_700_000_000 } }, "fractal-bitcoin", 5).usd).toBe(0.38);
    expect(() => parseCoingecko({}, "fractal-bitcoin")).toThrow(/no USD price/);
    expect(parseMexc({ symbol: "FBUSDT", price: "0.3812" }, "FBUSDT").usd).toBeCloseTo(0.3812);
    expect(() => parseMexc({ code: -1121, msg: "Invalid symbol." }, "FBUSDT")).toThrow(/Invalid symbol/);
    expect(() => parseMexc({ symbol: "BTCUSDT", price: "80000" }, "FBUSDT")).toThrow();
  });
  it("falls back to the other source and says which one answered", async () => {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      asked.push(new URL(url).host);
      return url.includes("coingecko") ? json({ status: { error_code: 429 } }, 429) : json({ symbol: "FBUSDT", price: "0.4" });
    };
    const p = await getPriceWithFallback("coingecko", asset, fetcher);
    expect(p.source).toBe("mexc");
    expect(p.asset).toBe("FBUSDT");
    expect(asked).toEqual(["api.coingecko.com", "api.mexc.com"]);
  });
  it("asks MEXC first when chosen, and throws the first error when both fail", async () => {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      asked.push(new URL(url).host);
      return json({}, 503);
    };
    await expect(getPriceWithFallback("mexc", asset, fetcher)).rejects.toThrow("MEXC answered 503");
    expect(asked).toEqual(["api.mexc.com", "api.coingecko.com"]);
  });
  it("uses the Bitcoin ids on Bitcoin", () => {
    expect(netInfo("bitcoin").price).toEqual({ coingecko: "bitcoin", mexc: "BTCUSDT" });
  });
});

describe("prefs", () => {
  it("defaults: CoinGecko, no delay, automatic leftover, Fractal", () => {
    const p = normalizePrefs(undefined);
    expect(p).toMatchObject({ priceSource: "coingecko", usd: true, sendDelay: "off", randomizeFee: false, leftover: "auto", network: "fractal" });
  });
  it("an old USD off setting means price off", () => {
    expect(normalizePrefs({ usd: false }).priceSource).toBe("off");
    expect(normalizePrefs({ priceSource: "mexc" }).usd).toBe(true);
  });
  it("drops unknown values", () => {
    const p = normalizePrefs({ priceSource: "x", sendDelay: "5h", leftover: 7, network: "testnet" });
    expect(p).toMatchObject({ priceSource: "coingecko", sendDelay: "off", leftover: "auto", network: "fractal" });
  });
});

describe("Payjoin route check", () => {
  it("needs two https services that are not the same", () => {
    expect(checkPayjoinUrls("https://payjo.in", "https://pj.bobspacebkk.com")).toBeNull();
    expect(checkPayjoinUrls("http://payjo.in", "https://pj.bobspacebkk.com")).toMatchObject({ ok: false, step: "url" });
    expect(checkPayjoinUrls("payjo.in", "https://x")).toMatchObject({ ok: false, step: "url" });
    expect(checkPayjoinUrls("https://payjo.in", "https://payjo.in/")).toMatchObject({ ok: false, step: "same" });
  });
});

describe("history addresses", () => {
  it("turns a Taproot script into its bc1p address", () => {
    // BIP350 test vector: OP_1 <79be667e...> is bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0
    expect(taprootAddress("512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")).toBe("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0");
    expect(taprootAddress("0014" + "00".repeat(20))).toBeUndefined();
  });
  it("records where a received payment landed", () => {
    const scan = emptyScanStore(1);
    scan.utxos.push({ txid: "ab".repeat(32), vout: 0, value: "1000", scriptPubKey: "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", tweak: "00".repeat(32), label: null, k: 0, height: 5, spent: false });
    scan.lastHeight = 10;
    const h = deriveHistory(scan, null, { now: 1_700_000_000_000 });
    const e = h.entries["ab".repeat(32)]!;
    expect(e.kind).toBe("received");
    expect(e.onchain).toBe("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0");
  });
});

describe("Bitcoin next to Fractal", () => {
  it("Fractal paths are unchanged; Bitcoin uses coin type 0", () => {
    expect(netInfo("fractal").coinType).toBe(8228);
    expect(netInfo("bitcoin").coinType).toBe(0);
    expect(JSON.stringify(derivationPath(0, "fractal"))).toContain("8228'");
    expect(JSON.stringify(derivationPath(0, "bitcoin"))).not.toContain("8228");
  });
  it("one wallet has a different receive code per chain, with its own coins and start block", async () => {
    const w = new PrivateBit(memoryKv());
    await w.create({ password: "pw", birthday: 2_231_692 });
    const fb = await w.state();
    await w.setNetwork("bitcoin");
    const btc = await w.state();
    expect(btc.unlocked).toBe(true);
    expect(btc.receive).toMatch(/^sp1/);
    expect(btc.receive).not.toBe(fb.receive);
    expect(btc.birthday).toBe(netInfo("bitcoin").defaultBirthday);
    await w.setBirthday(950_000);
    expect((await w.state()).birthday).toBe(950_000);
    await w.setNetwork("fractal");
    const back = await w.state();
    expect(back.receive).toBe(fb.receive);
    expect(back.birthday).toBe(2_231_692);
  });
  it("plans are tied to their chain", () => {
    expect(netInfo("fractal").planChain).not.toBe(netInfo("bitcoin").planChain);
  });
});
