// End-to-end checks for the import (M5), confirm (M10) and scan status fixes. Offline mock chain, throwaway wallets.
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath, DIST_E2E, screens } from "./paths.mjs";

const EXT = DIST_E2E;
const OUT = screens("fixes");
const CHROME = chromePath();
const PW = "throwaway-fixes-1";
const PW2 = "throwaway-fixes-new";
const results = [];
const consoleErrors = [];
const shots = [];
const axeFindings = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const profile = mkdtempSync(join(tmpdir(), "pb-fix-"));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: CHROME,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--host-resolver-rules=MAP * ~NOTFOUND"],
  viewport: { width: 1280, height: 900 },
  reducedMotion: "reduce",
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const base = `chrome-extension://${new URL(sw.url()).host}`;
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && consoleErrors.push(`full: ${m.text()}`));
page.on("pageerror", (e) => consoleErrors.push(`full pageerror: ${e.message} ${(e.stack ?? "").split("\n").slice(1, 4).join(" ")} at ${page.url()}`));
await page.goto(`${base}/full.html`);
await page.waitForTimeout(800);
const send = (msg) =>
  page.evaluate((m) => new Promise((res, rej) => chrome.runtime.sendMessage(m, (r) => (r?.ok ? res(r.data) : rej(new Error(r?.error ?? "no reply"))))), msg);
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
const setTheme = async (t, p = page) => {
  await p.evaluate(async (t) => {
    localStorage.setItem("privatebit.theme", t);
    await chrome.storage.local.set({ "privatebit.theme": t });
  }, t);
  await p.waitForTimeout(300);
};
async function shot(name, p = page, full = true) {
  await p.evaluate(() => window.scrollTo(0, 0));
  await settle(p, 300);
  await p.screenshot({ path: join(OUT, `${name}.png`), fullPage: full });
  shots.push(name);
}
async function axe(name, p = page) {
  const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  axeFindings.push({ name, serious: bad.map((v) => `${v.id} (${v.nodes.length})`), moderate: r.violations.filter((v) => !bad.includes(v)).map((v) => v.id) });
}
async function overflow(name, p = page) {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (o > 0) {
    const who = await p.evaluate(() => {
      const W = document.documentElement.clientWidth;
      return [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > W + 0.5).slice(0, 4).map((e) => `${e.tagName}.${e.className}#${e.id} ${Math.round(e.getBoundingClientRect().right)}`);
    });
    console.log("overflow by", who.join(" | "));
  }
  ok(`no horizontal overflow: ${name}`, o <= 0, o > 0 ? `${o}px` : "");
}
async function smallTargets(name, p = page) {
  const n = await p.evaluate(() =>
    [...document.querySelectorAll("button, a, input[type=checkbox], [role=button]")].filter((el) => {
      const r = el.getBoundingClientRect();
      const box = el.matches("input[type=checkbox]") && el.closest("label") ? el.closest("label").getBoundingClientRect() : r;
      return r.width > 0 && r.height > 0 && (box.width < 24 || box.height < 24) && !el.classList.contains("link");
    }).map((el) => `${el.tagName}[${el.dataset.act ?? el.dataset.f ?? ""}] ${el.textContent.trim().slice(0, 20)}`),
  );
  ok(`targets at least 24 px: ${name}`, n.length === 0, n.join(" | "));
}
const pop = await ctx.newPage();
pop.on("pageerror", (e) => consoleErrors.push(`popup pageerror: ${e.message}`));
await pop.setViewportSize({ width: 360, height: 600 });

/** Screens for both themes: full page at 1280 and 375, and the popup. `open` brings each page to the state. */
async function capture(label, open) {
  for (const theme of ["dark", "light"]) {
    await setTheme(theme);
    for (const w of [1280, 375]) {
      await page.setViewportSize({ width: w, height: 900 });
      await open(page, "full");
      await overflow(`${label} ${w} ${theme}`);
      await shot(`full-${label}-${theme}-${w}`);
    }
    await open(pop, "popup");
    await shot(`popup-${label}-${theme}`, pop, false);
  }
  await setTheme("dark");
  await page.setViewportSize({ width: 1280, height: 900 });
}

// ---------- 1. one wallet with a coin ----------
const ob = await send({ type: "NEW_MNEMONIC" });
await send({ type: "CREATE_CHECKED", password: PW, name: "Daily" });
await send({ type: "PREFS_SET", prefs: { usd: false } });
const coin = await hook(() => self.__pbE2E.fundOpenWallet("40000"));
let st = await send({ type: "STATE" });
const idA = st.wallets[0].id;
const birthday = st.wallets[0].birthday;
ok("one wallet with a coin", st.wallets.length === 1 && BigInt(st.confirmed ?? "0") === 40000n, st.confirmed);

// ---------- 2. lock, then open with the same words from the unlock screen ----------
await send({ type: "LOCK" });
const toImport = async (p) => {
  await p.goto(`${base}/${p === pop ? "popup" : "full"}.html`);
  await settle(p, 1000);
  await click('[data-act="import-forgot"]', p);
};
await capture("import-forgot", toImport);
await toImport(page);
ok("forgot banner says nothing is replaced", (await page.locator(".banner").first().innerText()).includes("coins, labels and history stay"));
await axe("import forgot dark", page);
await smallTargets("import forgot", page);
await page.fill("#mn", ob.mnemonic);
await settle(page, 200);
await click('[data-act="import-continue"]');
await page.fill("#pw", PW2);
await page.fill("#pw2", PW2);
await click('[data-act="import-finish"]');
await settle(page, 1500);
const toastText = await page.locator(".toast").first().innerText().catch(() => "");
ok("same words open the same wallet, nothing replaced", toastText.includes("already on this computer") || toastText.includes("open now"), toastText);
st = await send({ type: "STATE" });
ok("still one wallet, same id", st.wallets.length === 1 && st.wallets[0].id === idA);
ok("its coin is still there", BigInt(st.confirmed ?? "0") === 40000n, st.confirmed);
await send({ type: "LOCK" });
let unlockedNew = true;
try {
  await send({ type: "UNLOCK", password: PW2 });
} catch {
  unlockedNew = false;
}
ok("the new password opens it", unlockedNew);

// ---------- 3. welcome style import of other words adds a wallet ----------
const other = await send({ type: "NEW_MNEMONIC", add: true });
await send({ type: "ONBOARD_CLEAR" });
const r1 = await send({ type: "RESTORE", mnemonic: other.mnemonic, password: "throwaway-fixes-2", birthday, name: "Imported" });
ok("import of new words adds a wallet", r1.imported?.result === "added" && r1.state.wallets.length === 2, JSON.stringify(r1.imported));
ok("the first wallet is kept", r1.state.wallets.some((w) => w.id === idA));
const r2 = await send({ type: "RESTORE", mnemonic: ob.mnemonic, password: PW2, birthday });
ok("importing the first words again switches to it", r2.imported?.result === "existing" && r2.imported?.id === idA && r2.state.wallets.length === 2, JSON.stringify(r2.imported));
ok("and its coin is still there", BigInt(r2.state.confirmed ?? "0") === 40000n, r2.state.confirmed);
const addScreen = async (p) => {
  await p.goto(`${base}/${p === pop ? "popup" : "full"}.html`);
  await settle(p, 900);
  await p.evaluate(() => {
    const b = document.createElement("button");
    b.dataset.act = "tab";
    b.dataset.to = "wallets";
    document.body.appendChild(b);
    b.click();
    b.remove();
  });
  await settle(p, 700);
  await click('[data-act="wallet-import"]', p);
  await settle(p, 500);
};
await capture("import-add", addScreen);
await addScreen(page);
ok("add banner says the other wallets stay", (await page.locator("main, body").first().innerText()).includes("The wallets on this computer stay"));

// ---------- 4. confirm sends only the reviewed plan ----------
const receive = r1.state.wallets.length ? (await send({ type: "STATE" })).receive : "";
await send({ type: "SWITCH_WALLET", id: r1.imported.id });
await send({ type: "UNLOCK", password: "throwaway-fixes-2" });
const dest = (await send({ type: "STATE" })).receive;
await send({ type: "SWITCH_WALLET", id: idA });
await send({ type: "UNLOCK", password: PW2 });
void receive;
const toSend = async (p) => {
  await p.goto(`${base}/${p === pop ? "popup" : "full"}.html`);
  await settle(p, 1000);
  await p.evaluate(() => {
    const b = document.createElement("button");
    b.dataset.act = "tab";
    b.dataset.to = "send";
    document.body.appendChild(b);
    b.click();
    b.remove();
  });
  await settle(p, 800);
};
const fillSend = async (p) => {
  try {
    await p.fill("#to", dest, { timeout: 8000 });
    await settle(p, 800);
    await p.fill("#amt", "0.0001", { timeout: 8000 });
  } catch (e) {
    await p.screenshot({ path: join(OUT, "fail.png") });
    writeFileSync(join(OUT, "fail.html"), await p.content());
    throw e;
  }
};
await toSend(page);
await fillSend(page);
await settle(page, 1200);
await click('[data-act="review"]');
await settle(page, 900);
ok("review screen shown", (await page.locator("h1, .hdr").first().innerText()).includes("Review"));
// The coins change after the review: a new coin arrives and every coin the review could have
// used is frozen in another window, so the payment can only go out from the new coin.
const changeCoins = async (value) => {
  const newTxid = await hook((v) => self.__pbE2E.fundOpenWallet(v), value);
  const froze = [];
  for (const c of await send({ type: "COINS" })) {
    if (c.txid === newTxid || c.frozen) continue;
    await send({ type: "SET_COIN_META", outpoint: c.outpoint, patch: { frozen: true } });
    froze.push(c.outpoint);
  }
  return froze;
};
const unfreeze = async (list) => {
  for (const outpoint of list) await send({ type: "SET_COIN_META", outpoint, patch: { frozen: false } });
};
const frozeForTest = await changeCoins("900000");
await click('[data-act="sheet"][data-sheet="confirm"]');
await click('[data-act="broadcast"]');
await settle(page, 1500);
await page.screenshot({ path: join(OUT, "after-broadcast.png") });
const bannerText = await page.locator(".banner.warn").first().innerText({ timeout: 3000 }).catch(() => "");
ok("changed plan is blocked and shown again", bannerText.includes("Nothing was sent"), bannerText.slice(0, 160));
ok("Confirm waits for the new check", await page.locator('[data-act="sheet"][data-sheet="confirm"]').isDisabled());
await page.locator('input[data-f="ackChange"]').check();
await settle(page, 300);
ok("Confirm comes back after the check", !(await page.locator('[data-act="sheet"][data-sheet="confirm"]').isDisabled()));
await page.locator('input[data-f="ackChange"]').uncheck();
await axe("review changed dark", page);
await smallTargets("review changed", page);
const fullUrl = page.url();
const reviewChanged = async (p, kind) => {
  if (kind === "full") {
    await settle(p, 400);
    return; // same page, already on the changed review; theme and width applied by capture
  }
  await p.goto(`${base}/popup.html`);
  await settle(p, 900);
  await p.evaluate(() => {
    const b = document.createElement("button");
    b.dataset.act = "tab";
    b.dataset.to = "send";
    document.body.appendChild(b);
    b.click();
    b.remove();
  });
  await settle(p, 700);
};
void fullUrl;
await capture("review-changed", reviewChanged);
await unfreeze(frozeForTest);
// popup: run the same flow so the popup shows the changed banner too
for (const theme of ["dark", "light"]) {
  await setTheme(theme, pop);
  await toSend(pop);
  await fillSend(pop);
  await settle(pop, 1000);
  await click('[data-act="review"]', pop);
  await settle(pop, 800);
  const froze = await changeCoins(theme === "dark" ? "950000" : "2000000");
  await click('[data-act="sheet"][data-sheet="confirm"]', pop);
  await click('[data-act="broadcast"]', pop);
  await settle(pop, 1500);
  ok(`popup ${theme}: changed plan blocked`, (await pop.locator(".banner.warn").first().innerText().catch(() => "")).includes("Nothing was sent"));
  await shot(`popup-review-changed-${theme}`, pop, true);
  await unfreeze(froze);
}

// ---------- 5. honest scan status while waiting ----------
const setWait = (state) =>
  hook((state) => chrome.storage.session.set({ "privatebit.health": { state, at: Date.now(), since: Date.now() - 120000, retryAt: Date.now() + 40000 } }), state);
const home = async (p) => {
  await setWait("rate-limited");
  await p.goto(`${base}/${p === pop ? "popup" : "full"}.html#/home`);
  await settle(p, 1200);
};
await capture("status-waiting", home);
await home(page);
const homeText = await page.locator("body").innerText();
ok("home says it is waiting and when it retries", /Waiting for the data service, retrying in \d+ s/.test(homeText), (homeText.match(/Waiting[^\n]*/) ?? [""])[0]);
ok("banner shows the retry time", /Retrying in \d+ s\./.test(homeText));
await setWait("error");
await page.reload();
await settle(page, 1200);
const homeText2 = await page.locator("body").innerText();
ok("a non network failure also shows the wait", /Waiting for the data service, retrying in \d+ s/.test(homeText2));
await shot("full-status-error-dark-1280");
await axe("home waiting dark", page);
await smallTargets("home waiting", page);

const dash = await page.evaluate(() => /[\u2013\u2014]/.test(document.body.innerText));
ok("no dashes in the visible text", !dash);
writeFileSync(join(OUT, "fixes-results.json"), JSON.stringify({ results, consoleErrors, axeFindings, shots }, null, 2));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed; ${shots.length} screenshots; console errors: ${consoleErrors.length}`);
for (const a of axeFindings) console.log(`axe ${a.name}: serious ${a.serious.join(", ") || "none"}; moderate ${a.moderate.join(", ") || "none"}`);
for (const e of consoleErrors.slice(0, 20)) console.log("console:", e);
await ctx.close();
rmSync(profile, { recursive: true, force: true });
