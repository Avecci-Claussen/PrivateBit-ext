import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = "https://open-api-fractal.unisat.io";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("built in data service key (private test builds only)", () => {
  it("is empty in normal builds and tests", async () => {
    const m = await import("../src/lib/builtin-key.ts");
    expect(m.BUILT_IN_UNISAT_TOKEN).toBe("");
    expect(m.effectiveUnisatToken(undefined, ROOT, ROOT)).toBeUndefined();
    expect(m.effectiveUnisatToken("mine", ROOT, ROOT)).toBe("mine");
  });

  it("a key typed in Settings overrides the built in one, and the built in one only goes to the default host", async () => {
    vi.stubGlobal("__PB_PRIVATE_UNISAT__", "built-in-test-value");
    vi.resetModules();
    const m = await import("../src/lib/builtin-key.ts");
    expect(m.BUILT_IN_UNISAT_TOKEN).toBe("built-in-test-value");
    expect(m.effectiveUnisatToken(undefined, ROOT, ROOT)).toBe("built-in-test-value");
    expect(m.effectiveUnisatToken("", ROOT + "/", ROOT)).toBe("built-in-test-value");
    expect(m.effectiveUnisatToken("users-own-key", ROOT, ROOT)).toBe("users-own-key");
    expect(m.effectiveUnisatToken(undefined, "https://my-own-indexer.example", ROOT)).toBeUndefined();
  });

  it("the data service request carries the user's key when one is saved", async () => {
    vi.stubGlobal("__PB_PRIVATE_UNISAT__", "built-in-test-value");
    vi.resetModules();
    const { unisatSource } = await import("../src/lib/chain.ts");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)?.authorization ?? ""));
      return Response.json({ code: 0, msg: "ok", data: { blocks: 5, bestBlockHash: "ab".repeat(32) } });
    });
    await unisatSource({ kind: "unisat", url: ROOT, unisatToken: "users-own-key" }).getTip().catch(() => undefined);
    await unisatSource({ kind: "unisat", url: ROOT }).getTip().catch(() => undefined);
    expect(seen[0]).toBe("Bearer users-own-key");
    expect(seen.at(-1)).toBe("Bearer built-in-test-value");
  });
});
