// Shared Playwright harness: real built extension (dist-e2e), offline, throwaway wallets.
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath, DIST_E2E } from "./paths.mjs";

export const CHROME = chromePath();
export async function launch({ out, ext = DIST_E2E, hostRules = "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" } = {}) {
  const results = [], errors = [], shots = [], axeFindings = [];
  const ok = (name, pass, detail = "") => {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`);
  };
  const profile = mkdtempSync(join(tmpdir(), "pb-h-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: CHROME,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--host-resolver-rules=${hostRules}`],
    viewport: { width: 1280, height: 900 }, reducedMotion: "reduce",
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const base = `chrome-extension://${new URL(sw.url()).host}`;
  const watch = (p, n) => {
    p.on("console", (m) => m.type() === "error" && !/ERR_NAME_NOT_RESOLVED|Failed to load resource|ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(`${n} console: ${m.text()}`));
    p.on("pageerror", (e) => errors.push(`${n} pageerror: ${e.message} at ${p.url()}`));
  };
  const page = await ctx.newPage(); watch(page, "full");
  const pop = await ctx.newPage(); watch(pop, "popup");
  await pop.setViewportSize({ width: 360, height: 600 });
  await page.goto(`${base}/full.html`); await pop.goto(`${base}/popup.html`);
  await page.waitForTimeout(800);
  const kindOf = (p) => (p === pop ? "popup" : "full");
  const send = (msg) => page.evaluate((m) => new Promise((res, rej) => chrome.runtime.sendMessage(m, (r) => (r?.ok ? res(r.data) : rej(new Error(r?.error ?? "no reply"))))), msg);
  const hook = (fn, arg) => sw.evaluate(fn, arg);
  const settle = async (p = page, ms = 500) => { await p.waitForTimeout(ms); await p.evaluate(() => document.fonts.ready).catch(() => {}); };
  const fail = async (p, e) => { await p.screenshot({ path: join(out, "fail.png") }).catch(() => {}); writeFileSync(join(out, "fail.html"), await p.content().catch(() => "")); throw e; };
  const click = async (sel, p = page) => { try { await p.locator(sel).first().click({ timeout: 10000 }); } catch (e) { await fail(p, e); } await settle(p, 400); };
  const fill = async (sel, v, p = page) => { try { await p.fill(sel, v, { timeout: 10000 }); } catch (e) { await fail(p, e); } await settle(p, 250); };
  const act = async (p, data) => { await p.evaluate((d) => { const b = document.createElement("button"); for (const [k, v] of Object.entries(d)) b.dataset[k] = v; document.body.appendChild(b); b.click(); b.remove(); }, data); await settle(p, 700); };
  const open = async (p, route, extra = {}) => { await p.goto(`${base}/${kindOf(p)}.html`); await settle(p, 900); if (route !== "home") await act(p, { act: "go", to: route, ...extra }); };
  const setTheme = async (t, p = page) => { await p.evaluate(async (t) => { localStorage.setItem("privatebit.theme", t); await chrome.storage.local.set({ "privatebit.theme": t }); }, t).catch(() => {}); await p.waitForTimeout(300); };
  const text = (p = page) => p.locator("body").innerText();
  async function overflow(name, p) {
    const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (o > 0) ok(`no horizontal overflow: ${name}`, false, `${o}px`); else results.push({ name: `overflow ${name}`, pass: true });
  }
  async function targets(name, p) {
    const n = await p.evaluate(() => [...document.querySelectorAll("button, a, input[type=checkbox], [role=button]")].filter((el) => {
      const r = el.getBoundingClientRect(); const box = el.matches("input[type=checkbox]") && el.closest("label") ? el.closest("label").getBoundingClientRect() : r;
      return getComputedStyle(el).visibility !== "hidden" && r.width > 0 && r.height > 0 && (box.width < 24 || box.height < 24) && !el.classList.contains("link");
    }).map((el) => `${el.tagName}[${el.dataset.act ?? ""}] ${el.textContent.trim().slice(0, 20)}`));
    if (n.length) ok(`targets 24 px: ${name}`, false, n.join(" | ")); else results.push({ name: `targets ${name}`, pass: true });
  }
  async function axe(name, p) {
    const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    axeFindings.push({ name, serious: bad.map((v) => v.id) });
    if (bad.length) ok(`axe: ${name}`, false, bad.map((v) => `${v.id} ${v.nodes[0]?.target}`).join(" | ")); else results.push({ name: `axe ${name}`, pass: true });
  }
  async function dashes(name, p) {
    const d = await p.evaluate(() => (document.body.innerText.match(/.{0,30}[\u2013\u2014].{0,30}/) ?? [""])[0]);
    if (d) ok(`no dashes: ${name}`, false, d);
  }
  async function capture(label, prep, { widths = [375, 768, 1280, 1440], popup = true } = {}) {
    for (const theme of ["dark", "light"]) {
      await setTheme(theme); await page.setViewportSize({ width: 1280, height: 900 }); await prep(page);
      for (const w of widths) {
        await page.setViewportSize({ width: w, height: 900 }); await settle(page, 350);
        await overflow(`${label} ${w} ${theme}`, page); if (theme === "dark") await targets(`${label} ${w}`, page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(out, `${label}-${theme}-${w}.png`), fullPage: true }); shots.push(`${label}-${theme}-${w}.png`);
      }
      if (theme === "dark") { await axe(`${label}`, page); await dashes(label, page); }
      if (popup) {
        await setTheme(theme, pop); await prep(pop); await overflow(`${label} popup ${theme}`, pop);
        await pop.screenshot({ path: join(out, `${label}-${theme}-popup.png`), fullPage: true }); shots.push(`${label}-${theme}-popup.png`);
      }
    }
    await setTheme("dark"); await page.setViewportSize({ width: 1280, height: 900 });
  }
  async function finish() {
    writeFileSync(join(out, "results.json"), JSON.stringify({ results, errors, axeFindings, shots }, null, 2));
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${shots.length} screenshots; page errors: ${errors.length}`);
    for (const f of failed) console.log("FAILED:", f.name, f.detail ?? "");
    for (const e of errors.slice(0, 15)) console.log("error:", e);
    await ctx.close(); rmSync(profile, { recursive: true, force: true });
  }
  return { ctx, sw, base, page, pop, ok, send, hook, settle, click, fill, act, open, setTheme, text, overflow, targets, axe, dashes, capture, finish, results, errors };
}
