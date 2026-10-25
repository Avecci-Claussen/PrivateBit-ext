import { describe, expect, it } from "vitest";
import { watchEndpoint } from "../src/lib/chain.ts";

describe("watchEndpoint (Android confirmation check source)", () => {
  it("uses the user's own node with its login", () => {
    const w = watchEndpoint({ kind: "core", url: "http://192.168.1.20:8332", rpcUser: "u", rpcPassword: "p" } as never, "fractal");
    expect(w.kind).toBe("core");
    expect(w.url).toBe("http://192.168.1.20:8332");
    expect(w.headers.authorization).toBe(`Basic ${btoa("u:p")}`);
  });
  it("uses the UniSat root with the user's token on Fractal", () => {
    const w = watchEndpoint({ kind: "unisat", url: "https://open-api-fractal.unisat.io/", unisatToken: "tok" } as never, "fractal");
    expect(w.kind).toBe("unisat");
    expect(w.url.endsWith("/")).toBe(false);
    expect(w.headers.authorization).toBe("Bearer tok");
  });
  it("uses the public explorer on Bitcoin in public mode, without any token", () => {
    const w = watchEndpoint({ kind: "unisat", url: "", unisatToken: "tok" } as never, "bitcoin");
    expect(w.kind).toBe("esplora");
    expect(w.url).toMatch(/^https:\/\//);
    expect(JSON.stringify(w.headers)).not.toContain("tok");
  });
});
