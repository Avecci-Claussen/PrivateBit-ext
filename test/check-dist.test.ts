// Step 7, audit C3: the release gate refuses secrets and the test hook, and never prints values.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
function dist(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "pb-dist-"));
  dirs.push(d);
  mkdirSync(join(d, "assets"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}
function gate(d: string): { code: number; out: string } {
  try {
    const out = execFileSync("node", ["scripts/check-dist.mjs", d], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("release gate (check-dist)", () => {
  it("passes a clean build", () => {
    expect(gate(dist({ "assets/a.js": 'const c={unisatToken:""};' })).code).toBe(0);
  });

  it("allows the public Fractal indexer cold key and refuses an unknown hex constant", () => {
    const cold = "da8d7239fdb567d62b38f371a77d2d3fe40d0d1a84dc21d7ab0fb0188c506b83";
    expect(gate(dist({ "assets/payjoin.js": `const Xd="${cold}";` })).code).toBe(0);
    const unknown = "ab".repeat(32);
    const r = gate(dist({ "assets/payjoin.js": `const Xd="${unknown}";` }));
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain(unknown);
  });

  it("refuses a default token and does not print it", () => {
    const token = "ab12".repeat(16);
    const r = gate(dist({ "assets/prefs.js": `const c={unisatToken:"${token}"};` }));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("unisatToken");
    expect(r.out).not.toContain(token);
  });

  it("refuses the end-to-end test hook", () => {
    const r = gate(dist({ "background.js": "self.__pbE2E={};" }));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("test hook");
  });

  it("refuses an env file and source maps", () => {
    expect(gate(dist({ ".env.local": "X=1" })).code).not.toBe(0);
    expect(gate(dist({ "assets/a.js.map": "{}" })).code).not.toBe(0);
  });
});
