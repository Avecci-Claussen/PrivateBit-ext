// Small-target check (< 24 px) on the main screens, popup and full page, offline build.
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupChecks, chromePath, DIST_E2E } from "./paths.mjs";
const EXT = DIST_E2E;
const profile = mkdtempSync(join(tmpdir(), "pb-t-"));
const ctx = await chromium.launchPersistentContext(profile, { headless: true, executablePath: chromePath(), args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--host-resolver-rules=MAP * ~NOTFOUND"] });
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const base = `chrome-extension://${new URL(sw.url()).host}`;
const page = await ctx.newPage();
await page.goto(`${base}/full.html`);
await page.waitForTimeout(800);
const send = (m) => page.evaluate((m) => new Promise((r, j) => chrome.runtime.sendMessage(m, (x) => (x?.ok ? r(x.data) : j(new Error(x?.error))))), m);
const ob1 = await send({ type: "NEW_MNEMONIC" });
await send({ type: "CREATE_CHECKED", password: "throwaway-t1", name: "Daily", checks: backupChecks(ob1.mnemonic) });
const ob2 = await send({ type: "NEW_MNEMONIC", add: true });
await send({ type: "CREATE_CHECKED", password: "throwaway-t2", name: "Savings", add: true, checks: backupChecks(ob2.mnemonic) });
await send({ type: "PREFS_SET", prefs: { usd: false } });
const small = async (label, p) => {
  const r = await p.evaluate(() => [...document.querySelectorAll("button,a,input,[role=button],[role=radio],[role=switch]")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && (b.width < 24 || b.height < 24) && getComputedStyle(e).visibility !== "hidden"; }).map((e) => `${e.tagName.toLowerCase()}.${e.className}[${e.textContent.trim().slice(0, 20)}] ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
  console.log(label, r.length ? r : "ok");
};
for (const [mode, vp] of [["full", { width: 1280, height: 900 }], ["full", { width: 375, height: 800 }], ["popup", { width: 360, height: 600 }]]) {
  await page.setViewportSize(vp);
  for (const r of ["home", "wallets", "settings", "paylink"]) {
    await page.goto(`${base}/${mode}.html${mode === "full" ? `#/${r}` : ""}`);
    await page.waitForTimeout(900);
    if (mode === "popup" && r !== "home") {
      await page.evaluate((r) => { const b = document.createElement("button"); b.dataset.act = "tab"; b.dataset.to = r; document.body.appendChild(b); b.click(); b.remove(); }, r);
      await page.waitForTimeout(600);
    }
    await small(`${mode} ${vp.width} ${r}:`, page);
  }
}
await ctx.close();
rmSync(profile, { recursive: true, force: true });
