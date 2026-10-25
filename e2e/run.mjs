// Browser end-to-end run of the unpacked extension (offline mock chain, throwaway wallets).
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupChecks, chromePath, DIST_E2E, screens } from "./paths.mjs";

const EXT = DIST_E2E;
const OUT = screens();
const CHROME = chromePath();
const PW_A = "throwaway-daily-1";
const PW_B = "throwaway-savings-2";
const results = [];
const consoleErrors = [];
const shots = [];
const axeFindings = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const profile = mkdtempSync(join(tmpdir(), "pb-e2e-"));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: CHROME,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--host-resolver-rules=MAP * ~NOTFOUND"],
  viewport: { width: 1280, height: 900 },
  reducedMotion: "reduce",
});
let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const id = new URL(sw.url()).host;
const base = `chrome-extension://${id}`;

const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && consoleErrors.push(`full: ${m.text()}`));
page.on("pageerror", (e) => consoleErrors.push(`full pageerror: ${e.message}`));
await page.goto(`${base}/full.html`);
await page.waitForTimeout(800);

const send = (msg) =>
  page.evaluate(
    (m) => new Promise((res, rej) => chrome.runtime.sendMessage(m, (r) => (r?.ok ? res(r.data) : rej(new Error(r?.error ?? "no reply"))))),
    msg,
  );
const hook = (fn, arg) => sw.evaluate(fn, arg);
const settle = async (p = page, ms = 500) => {
  await p.waitForTimeout(ms);
  await p.evaluate(() => document.fonts.ready);
};
const click = async (sel, p = page) => {
  try {
    await p.locator(sel).first().click({ timeout: 10000 });
  } catch (e) {
    await p.screenshot({ path: join(OUT, "fail.png") });
    writeFileSync(join(OUT, "fail.html"), await p.content());
    throw e;
  }
  await settle(p, 400);
};
const go = async (route, p = page) => {
  await p.evaluate((r) => {
    const b = document.createElement("button");
    b.dataset.act = "tab";
    b.dataset.to = r;
    b.style.display = "none";
    document.body.appendChild(b);
    b.click();
    b.remove();
  }, route);
  await settle(p, 600);
};
const setTheme = async (t, p = page) => {
  await p.evaluate(async (t) => {
    localStorage.setItem("privatebit.theme", t);
    await chrome.storage.local.set({ "privatebit.theme": t });
  }, t);
  await p.waitForTimeout(300);
};
async function shot(name, p = page, full = true) {
  const path = join(OUT, `${name}.png`);
  await settle(p, 300);
  await p.screenshot({ path, fullPage: full });
  shots.push(name);
}
async function axe(name, p = page) {
  const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  axeFindings.push({ name, serious: bad.map((v) => `${v.id} (${v.nodes.length})`), moderate: r.violations.filter((v) => !bad.includes(v)).map((v) => v.id) });
}
async function overflow(name, p = page) {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (o > 0) ok(`no horizontal overflow: ${name}`, false, `${o}px`);
}

// ---------- 1. two throwaway wallets ----------
const obA = await send({ type: "NEW_MNEMONIC" });
await send({ type: "CREATE_CHECKED", password: PW_A, name: "Daily", checks: backupChecks(obA.mnemonic) });
await send({ type: "PREFS_SET", prefs: { usd: false } });
const obB = await send({ type: "NEW_MNEMONIC", add: true });
await send({ type: "CREATE_CHECKED", password: PW_B, name: "Savings", add: true, checks: backupChecks(obB.mnemonic) });
let st = await send({ type: "STATE" });
ok("two wallets created", st.wallets?.length === 2, st.wallets?.map((w) => w.name).join(", "));
ok("second wallet is open", st.wallets?.find((w) => w.active)?.name === "Savings");
const idA = st.wallets.find((w) => w.name === "Daily").id;
const idB = st.wallets.find((w) => w.name === "Savings").id;

await page.goto(`${base}/full.html`);
await settle(page, 1500);
ok("sidebar shows the open wallet", (await page.locator(".side .wswitch .t").innerText()) === "Savings");

// ---------- 2. switch through the sidebar switcher ----------
await click(".side .wswitch");
await click(`.sheet [data-act=wallet-switch][data-id="${idA}"]`);
ok("switch leads to unlock of the other wallet", (await page.locator("h1").first().innerText()).includes("Daily"));
await page.fill("#pw", PW_A);
await click('[data-act="unlock"]');
await settle(page, 1500);
ok("Daily is open after unlock", (await page.locator(".side .wswitch .t").innerText()) === "Daily");

// ---------- 3. lock: no mnemonic in session storage ----------
await click('.side [data-act="lock"]');
await settle(page, 800);
const sess = await hook(() => chrome.storage.session.get(null));
const text = JSON.stringify(sess);
ok("after lock: no session vault key", !Object.keys(sess).some((k) => k.endsWith(".session") || k === "privatebit.session"), Object.keys(sess).join(","));
ok("after lock: neither mnemonic in session storage", !text.includes(obA.mnemonic) && !text.includes(obB.mnemonic));
ok("after lock: no single recovery word run in session storage", !text.includes(obA.mnemonic.split(" ").slice(0, 3).join(" ")));
const local = JSON.stringify(await hook(() => chrome.storage.local.get(null)));
ok("local storage holds no plain mnemonic", !local.includes(obA.mnemonic) && !local.includes(obB.mnemonic));
await page.fill("#pw", PW_A);
await click('[data-act="unlock"]');
await settle(page, 1500);
ok("unlock again works", (await send({ type: "STATE" })).unlocked === true);

// ---------- 4. rename through the Wallets screen ----------
await page.goto(`${base}/full.html#/wallets`);
await settle(page, 1200);
await click(`[data-act=wallet-rename][data-id="${idA}"]`);
await page.fill("#rn", "Daily spending");
await click(`[data-act=wallet-rename-save]`);
st = await send({ type: "STATE" });
ok("rename saved", st.wallets.find((w) => w.id === idA).name === "Daily spending");

// ---------- 5. screenshots: wallets, home switcher, settings (full page) ----------
const WIDTHS = process.env.FAST ? [1280] : [375, 768, 1280, 1440];
for (const theme of ["dark", "light"]) {
  await setTheme(theme);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`${base}/full.html#/wallets`);
    await settle(page, 900);
    await overflow(`wallets ${w} ${theme}`);
    await shot(`full-wallets-${theme}-${w}`);
    await page.goto(`${base}/full.html#/home`);
    await settle(page, 900);
    await overflow(`home ${w} ${theme}`);
    await shot(`full-home-switcher-${theme}-${w}`, page, false);
    await click(w >= 1024 ? ".side .wswitch" : ".mobilebar .wchip");
    await shot(`full-switcher-open-${theme}-${w}`, page, false);
    await page.keyboard.press("Escape");
    await page.goto(`${base}/full.html#/settings`);
    await settle(page, 900);
    await overflow(`settings ${w} ${theme}`);
    await shot(`full-settings-${theme}-${w}`);
  }
}
await page.setViewportSize({ width: 1280, height: 900 });
await setTheme("dark");
await page.goto(`${base}/full.html#/wallets`);
await settle(page, 800);
await axe("full wallets dark");
await page.goto(`${base}/full.html#/settings`);
await settle(page, 800);
await axe("full settings dark");

// ---------- 6. popup 360x600 ----------
const pop = await ctx.newPage();
pop.on("console", (m) => m.type() === "error" && consoleErrors.push(`popup: ${m.text()}`));
pop.on("pageerror", (e) => consoleErrors.push(`popup pageerror: ${e.message}`));
await pop.setViewportSize({ width: 360, height: 600 });
for (const theme of ["dark", "light"]) {
  await setTheme(theme, pop.url() === "about:blank" ? page : pop);
  await pop.goto(`${base}/popup.html`);
  await settle(pop, 1200);
  await shot(`popup-home-${theme}`, pop, false);
  await click(".hdr .wchip", pop);
  await shot(`popup-switcher-open-${theme}`, pop, false);
  await pop.keyboard.press("Escape");
  await settle(pop, 200);
  await go("wallets", pop);
  await shot(`popup-wallets-${theme}`, pop, false);
  await go("settings", pop);
  await shot(`popup-settings-${theme}`, pop, false);
  await go("set-network", pop);
  await shot(`popup-settings-network-${theme}`, pop, false);
  if (theme === "dark") {
    await go("home", pop);
    await axe("popup home dark", pop);
    await go("wallets", pop);
    await axe("popup wallets dark", pop);
  }
}

// ---------- 7. Payjoin: create then cancel, then the proposal states ----------
await hook(() => self.__pbE2E.fundOpenWallet("50000"));
await setTheme("dark");
const pjStates = async (label) => {
  for (const theme of ["dark", "light"]) {
    await setTheme(theme);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`${base}/full.html#/paylink`);
      await settle(page, 900);
      await overflow(`paylink ${label} ${w} ${theme}`);
      await shot(`full-payjoin-${label}-${theme}-${w}`);
    }
    await setTheme(theme, pop);
    await pop.goto(`${base}/popup.html`);
    await settle(pop, 900);
    await go("paylink", pop);
    await shot(`popup-payjoin-${label}-${theme}`, pop, false);
  }
  await setTheme("dark");
  await page.setViewportSize({ width: 1280, height: 900 });
};

await page.goto(`${base}/full.html#/paylink`);
await settle(page, 1000);
await pjStates("create");
await page.goto(`${base}/full.html#/paylink`);
await settle(page, 800);
await click('[data-act="pj-create"]');
await settle(page, 1200);
let sessions = await send({ type: "SESSIONS" });
const link1 = sessions.find((s) => s.role === "receive" && s.status === "waiting");
ok("payment link created", !!link1);
await pjStates("waiting");
await axe("full paylink waiting dark");

// switch confirm while a link is open
await page.goto(`${base}/full.html#/home`);
await settle(page, 800);
await click(".side .wswitch");
await click(`.sheet [data-act=wallet-switch][data-id="${idB}"]`);
ok("switch asks first while a payment link is open", await page.locator("#sw-h").isVisible());
await shot("full-switch-confirm-dark-1280", page, false);
await click('.dialog [data-act="sheet-close"]');
ok("staying keeps the link open", (await send({ type: "STATE" })).payjoin?.status === "waiting");

// cancel through the UI
await page.goto(`${base}/full.html#/paylink`);
await settle(page, 800);
await click('[data-act="cancel-link"]');
await settle(page, 800);
sessions = await send({ type: "SESSIONS" });
const c1 = sessions.find((s) => s.id === link1.id);
ok("payment link cancelled", c1?.status === "failed" && c1?.error === "cancelled");
ok("auto lock no longer held after cancel", (await send({ type: "STATE" })).payjoin === undefined);
await page.goto(`${base}/full.html#/paylink`);
await settle(page, 600);
await page.evaluate((id) => {
  const b = document.createElement("button");
  b.dataset.act = "pj-open";
  b.dataset.id = id;
  document.body.appendChild(b);
  b.click();
  b.remove();
}, link1.id);
await settle(page, 600);
await shot("full-payjoin-cancelled-dark-1280");

// second link: payer pays, receiver proposes, then the deadline passes
await page.reload();
await settle(page, 1200);
await go("paylink");
await click('[data-act="pj-create"]');
await settle(page, 1000);
sessions = await send({ type: "SESSIONS" });
const link2 = sessions.find((s) => s.role === "receive" && s.status === "waiting");
await hook((bip21) => self.__pbE2E.payLink(bip21, 10000), link2.bip21);
const svc = await hook(() => self.__pbE2E.service());
ok("receiver checked the original and proposed", svc.processed === 1, JSON.stringify(svc.errors));
await pjStates("proposed");
const still = await hook(() => self.__pbE2E.expireProposal());
ok("proposal deadline ends the session", still === false);
await page.goto(`${base}/full.html#/paylink`);
await settle(page, 800);
await page.evaluate((id) => {
  const b = document.createElement("button");
  b.dataset.act = "pj-open";
  b.dataset.id = id;
  document.body.appendChild(b);
  b.click();
  b.remove();
}, link2.id);
await settle(page, 600);
for (const theme of ["dark", "light"]) {
  await setTheme(theme);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.reload();
    await settle(page, 900);
    await page.evaluate((id) => {
      const b = document.createElement("button");
      b.dataset.act = "tab";
      b.dataset.to = "paylink";
      document.body.appendChild(b);
      b.click();
      b.remove();
      setTimeout(() => {
        const c = document.createElement("button");
        c.dataset.act = "pj-open";
        c.dataset.id = id;
        document.body.appendChild(c);
        c.click();
        c.remove();
      }, 300);
    }, link2.id);
    await settle(page, 1200);
    await shot(`full-payjoin-notsent-${theme}-${w}`);
  }
}
await setTheme("dark");
await page.setViewportSize({ width: 1280, height: 900 });

// ---------- 8. remove the other wallet; the open one survives ----------
await page.goto(`${base}/full.html#/wallets`);
await settle(page, 900);
await click(`[data-act=go][data-to=remove][data-id="${idB}"]`);
ok("remove names the wallet", (await page.locator("h1").last().innerText()).includes("Savings"));
await shot("full-remove-step1-dark-1280");
await page.fill("#rmpw", PW_A);
await click('[data-act="rm-next"]');
// scrypt 2^17 (audit M1) takes a moment before the refusal shows.
await page.locator("#rm-e").waitFor({ timeout: 10000 }).catch(() => undefined);
ok("wrong password (the open wallet's) is refused for Savings", await page.locator("#rm-e").isVisible());
await page.fill("#rmpw", PW_B);
await click('[data-act="rm-next"]');
await shot("full-remove-step2-dark-1280");
await page.locator('input[data-f="rmAck"]').check();
await settle(page, 300);
await click('[data-act="rm-final"]');
await settle(page, 1200);
st = await send({ type: "STATE" });
ok("one wallet left", st.wallets?.length === 1, st.wallets?.map((w) => w.name).join(", "));
ok("the survivor is Daily spending, still open and unlocked", st.wallets?.[0]?.name === "Daily spending" && st.unlocked === true);
const allKeys = Object.keys({ ...(await hook(() => chrome.storage.local.get(null))), ...(await hook(() => chrome.storage.session.get(null))) });
ok("no keys of the removed wallet remain", !allKeys.some((k) => k.includes(`.w.${idB}.`)), allKeys.filter((k) => k.includes(idB)).join(","));
ok("the survivor's keys remain", allKeys.some((k) => k.includes(`.w.${idA}.`)));

writeFileSync(join(OUT, "e2e-results.json"), JSON.stringify({ results, consoleErrors, axeFindings, shots }, null, 2));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed; ${shots.length} screenshots; console errors: ${consoleErrors.length}`);
for (const a of axeFindings) console.log(`axe ${a.name}: serious ${a.serious.join(", ") || "none"}; moderate ${a.moderate.join(", ") || "none"}`);
for (const e of consoleErrors.slice(0, 20)) console.log("console:", e);
await ctx.close();
rmSync(profile, { recursive: true, force: true });
