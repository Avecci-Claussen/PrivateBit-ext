import { describe, expect, it } from "vitest";
import {
  BIP77_CHECKS,
  BIP78_CHECKS,
  INTENT_PAYJOIN,
  INTENT_SIMPLE_SEND,
  PolicyError,
  noAutoFallback,
  psbtForBroadcast,
  type PayjoinOutcome,
} from "../src/lib/policy.ts";
import { parseBip21 } from "../src/lib/bip21.ts";
import { bip78ValidateStub } from "../src/lib/payjoin.ts";

const ORIGINAL = "cHNidP8BAHwCAAAA"; // not a real PSBT; tests policy, not bitcoin decode
const PROPOSAL = "cHNidP8BAgMEBQY=";

describe("no auto-fallback", () => {
  it("Payjoin failure cannot be broadcast as the original", () => {
    const fail: PayjoinOutcome = { ok: false, reason: "pj http 500", originalPsbtBase64: ORIGINAL };
    expect(() => noAutoFallback(fail)).toThrow(/no auto-fallback/);
    expect(() => psbtForBroadcast(INTENT_PAYJOIN, fail, ORIGINAL)).toThrow(PolicyError);
    expect(() => psbtForBroadcast(INTENT_PAYJOIN, fail, ORIGINAL)).toThrow(/original PSBT is not broadcast/);
    expect(() => psbtForBroadcast(INTENT_PAYJOIN, fail, ORIGINAL)).toThrow(/pj http 500/);
  });

  it("simple send is a distinct intent after the user confirms", () => {
    const fail: PayjoinOutcome = { ok: false, reason: "no directory", originalPsbtBase64: ORIGINAL };
    const hex = psbtForBroadcast(INTENT_SIMPLE_SEND, fail, ORIGINAL);
    expect(hex).toBe(ORIGINAL);
  });

  it("successful Payjoin broadcasts the proposal, not the original", () => {
    const ok: PayjoinOutcome = { ok: true, psbtBase64: PROPOSAL, intent: INTENT_PAYJOIN };
    expect(psbtForBroadcast(INTENT_PAYJOIN, ok, ORIGINAL)).toBe(PROPOSAL);
  });

  it("BIP21 pj= is detected and pjos is not an auto-fallback switch", () => {
    const r = parseBip21("bitcoin:sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv?pj=https://payjoin.example/pj");
    expect(r.pj).toContain("payjoin.example");
    expect(r.silent).toBe(true);
    expect(r.pjos).toBeUndefined();
  });

  it("BIP78 checklist rejects a proposal that is the original", () => {
    expect(bip78ValidateStub(ORIGINAL, ORIGINAL).length).toBeGreaterThan(0);
    expect(BIP78_CHECKS.length).toBeGreaterThan(4);
    expect(BIP77_CHECKS.join(" ")).toMatch(/OHTTP/);
    expect(BIP77_CHECKS.join(" ")).toMatch(/two parties/);
    expect(BIP77_CHECKS.join(" ")).toMatch(/alarm/);
  });
});
