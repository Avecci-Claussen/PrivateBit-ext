// Release build loads unpacked; the first screen renders; no test hook in the worker.
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath, DIST } from "./paths.mjs";
const EXT = DIST;
const profile = mkdtempSync(join(tmpdir(), "pb-p-"));
const ctx = await chromium.launchPersistentContext(profile, { headless: true, executablePath: chromePath(), args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--host-resolver-rules=MAP * ~NOTFOUND"] });
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const base = `chrome-extension://${new URL(sw.url()).host}`;
const errors = [];
for (const f of ["full.html", "popup.html"]) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${f}: ${e.message}`));
  await p.goto(`${base}/${f}`);
  await p.waitForTimeout(1500);
  console.log(f, "h1:", (await p.locator("h1").first().innerText().catch(() => "none")).replace(/\n/g, " "));
}
console.log("hook in worker:", await sw.evaluate(() => typeof self.__pbE2E));
console.log("page errors:", errors.length ? errors : "none");
await ctx.close();
rmSync(profile, { recursive: true, force: true });
