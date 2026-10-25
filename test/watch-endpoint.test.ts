import { describe, expect, it } from "vitest";
import { watchEndpoint } from "../src/lib/chain.ts";

describe("watchEndpoint (Android confirmation check source)", () => {
  it("uses the user's own node with its login", () => {
    const w = watchEndpoint({ kind: "core", url: "http://192.168.1.20:8332", rpcUser: "u", rpcPassword: "p" } as never, "fractal");
    expect(w.kind).toBe("core");
    expect(w.url).toBe("http://192.168.1.20:8332");
    expect(w.headers.authorization).toBe(`Basic ${btoa("u:p")}`);
  });
  for (const net of ["fractal", "bitcoin"] as const) {
    it(`public mode on ${net}: block lists from the explorer, never the data service token`, () => {
      const w = watchEndpoint({ kind: "unisat", url: "https://open-api-fractal.unisat.io", unisatToken: "secret-token-value" } as never, net);
      expect(w.kind).toBe("esplora");
      expect(w.url).toMatch(/^https:\/\/mempool\./);
      expect(JSON.stringify(w)).not.toContain("secret-token-value");
      expect(JSON.stringify(w)).not.toMatch(/unisat/i);
    });
  }
});
