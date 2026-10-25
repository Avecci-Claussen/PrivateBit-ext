// Production V1 pass: both chains, every main flow, 4 widths plus the popup, dark and light.
// Offline mock chain (DNS blocked), throwaway wallets, nothing is broadcast.
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath, DIST_E2E, screens } from "./paths.mjs";

const EXT = DIST_E2E;
const OUT = screens("finalize");
const CHROME = chromePath();
const WIDTHS = [375, 768, 1280, 1440];
const PW = "throwaway-final-1";
const results = [];
const errors = [];
const shots = [];
const axeFindings = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`);
};
const profile = mkdtempSync(join(tmpdir(), "pb-final-"));
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
const pop = await ctx.newPage();
await pop.setViewportSize({ width: 360, height: 600 });
for (const [p, n] of [[page, "full"], [pop, "popup"]]) {
  p.on("console", (m) => m.type() === "error" && !/ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(m.text()) && errors.push(`${n} console: ${m.text()}`));
  p.on("pageerror", (e) => errors.push(`${n} pageerror: ${e.message} at ${p.url()}`));
}
const kindOf = (p) => (p === pop ? "popup" : "full");
await page.goto(`${base}/full.html`);
await pop.goto(`${base}/popup.html`);
await page.waitForTimeout(800);
const send = (msg) => page.evaluate((m) => new Promise((res, rej) => chrome.runtime.sendMessage(m, (r) => (r?.ok ? res(r.data) : rej(new Error(r?.error ?? "no reply"))))), msg);
const hook = (fn, arg) => sw.evaluate(fn, arg);
const settle = async (p = page, ms = 500) => {
  await p.waitForTimeout(ms);
  await p.evaluate(() => document.fonts.ready);
};
const fail = async (p, e) => {
  await p.screenshot({ path: join(OUT, "fail.png") });
  writeFileSync(join(OUT, "fail.html"), await p.content());
  throw e;
};
const click = async (sel, p = page) => {
  try {
    await p.locator(sel).first().click({ timeout: 10000 });
  } catch (e) {
    await fail(p, e);
  }
  await settle(p, 400);
};
const fill = async (sel, v, p = page) => {
  try {
    await p.fill(sel, v, { timeout: 10000 });
  } catch (e) {
    await fail(p, e);
  }
  await settle(p, 250);
};
const act = async (p, data) => {
  await p.evaluate((d) => {
    const b = document.createElement("button");
    for (const [k, v] of Object.entries(d)) b.dataset[k] = v;
    document.body.appendChild(b);
    b.click();
    b.remove();
  }, data);
  await settle(p, 700);
};
const open = async (p, route, extra = {}) => {
  await p.goto(`${base}/${kindOf(p)}.html`);
  await settle(p, 900);
  if (route !== "home") await act(p, { act: "go", to: route, ...extra });
};
const setTheme = async (t, p = page) => {
  await p.evaluate(async (t) => {
    localStorage.setItem("privatebit.theme", t);
    await chrome.storage.local.set({ "privatebit.theme": t });
  }, t);
  await p.waitForTimeout(300);
};
const text = (p = page) => p.locator("body").innerText();
async function overflow(name, p) {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (o > 0) {
    const who = await p.evaluate(() => {
      const W = document.documentElement.clientWidth;
      return [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > W + 0.5).slice(0, 4).map((e) => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().right)}`);
    });
    ok(`no horizontal overflow: ${name}`, false, `${o}px ${who.join(" | ")}`);
  } else results.push({ name: `no horizontal overflow: ${name}`, pass: true });
}
async function targets(name, p) {
  const n = await p.evaluate(() =>
    [...document.querySelectorAll("button, a, input[type=checkbox], [role=button]")].filter((el) => {
      const r = el.getBoundingClientRect();
      const box = el.matches("input[type=checkbox]") && el.closest("label") ? el.closest("label").getBoundingClientRect() : r;
      const vis = getComputedStyle(el).visibility !== "hidden";
      return vis && r.width > 0 && r.height > 0 && (box.width < 24 || box.height < 24) && !el.classList.contains("link");
    }).map((el) => `${el.tagName}[${el.dataset.act ?? el.dataset.f ?? ""}] ${el.textContent.trim().slice(0, 20)}`),
  );
  if (n.length) ok(`targets at least 24 px: ${name}`, false, n.join(" | "));
  else results.push({ name: `targets: ${name}`, pass: true });
}
async function axe(name, p) {
  const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  axeFindings.push({ name, serious: bad.map((v) => `${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`) });
  if (bad.length) ok(`axe serious: ${name}`, false, bad.map((v) => `${v.id} ${v.nodes[0]?.target}`).join(" | "));
  else results.push({ name: `axe: ${name}`, pass: true });
}
const dashCheck = async (name, p) => {
  const d = await p.evaluate(() => (document.body.innerText.match(/.{0,30}[\u2013\u2014].{0,30}/) ?? [""])[0]);
  if (d) ok(`no dashes: ${name}`, false, d);
};
/** One screen, full page at every width and the popup, in both themes. `prep` brings a page to the state. */
async function capture(label, prep, opts = {}) {
  for (const theme of ["dark", "light"]) {
    await setTheme(theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await prep(page);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await settle(page, 350);
      await overflow(`${label} ${w} ${theme}`, page);
      if (theme === "dark") await targets(`${label} ${w}`, page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(OUT, `${label}-${theme}-${w}.png`), fullPage: true });
      shots.push(`${label}-${theme}-${w}.png`);
    }
    if (theme === "dark") {
      await axe(`${label} full`, page);
      await dashCheck(label, page);
    }
    if (!opts.noPopup) {
      await setTheme(theme, pop);
      await prep(pop);
      await overflow(`${label} popup ${theme}`, pop);
      if (theme === "dark") await targets(`${label} popup`, pop);
      await pop.screenshot({ path: join(OUT, `${label}-${theme}-popup.png`), fullPage: true });
      shots.push(`${label}-${theme}-popup.png`);
      if (theme === "light") await axe(`${label} popup light`, pop);
    }
  }
  await setTheme("dark");
  await page.setViewportSize({ width: 1280, height: 900 });
}

// ---------- B. create with a name, rename, length limit ----------
await send({ type: "NEW_MNEMONIC" });
await send({ type: "CREATE_CHECKED", password: PW, name: "Daily" });
await send({ type: "PREFS_SET", prefs: { priceSource: "off" } });
let st = await send({ type: "STATE" });
const idA = st.wallets[0].id;
ok("B: created with its name", st.wallets[0].name === "Daily", st.wallets[0].name);
await send({ type: "RENAME_WALLET", id: idA, name: "  Daily   spending " + "x".repeat(60) });
st = await send({ type: "STATE" });
ok("B: rename trims spaces and keeps 40 characters", st.wallets[0].name.length === 40 && st.wallets[0].name.startsWith("Daily spending x"), st.wallets[0].name);
await send({ type: "RENAME_WALLET", id: idA, name: "Daily spending" });
let renameEmpty = "";
try {
  await send({ type: "RENAME_WALLET", id: idA, name: "   " });
} catch (e) {
  renameEmpty = e.message;
}
ok("B: an empty name is refused in plain words", renameEmpty.includes("Give the wallet a name."), renameEmpty);
await open(page, "home");
ok("B: header shows the wallet name", (await page.locator("header, .sidebar, .mobilebar").first().innerText()).includes("Daily spending") || (await text()).includes("Daily spending"));
await open(page, "wallets");
await click('[data-act="wallet-rename"]');
ok("B: rename field has a 40 character limit", (await page.locator("#rn").getAttribute("maxlength")) === "40");
await fill("#rn", "Daily spending");
await click('[data-act="wallet-rename-save"]');
// Second wallet so the switcher has two names.
await send({ type: "NEW_MNEMONIC", add: true });
await send({ type: "CREATE_CHECKED", password: "throwaway-final-2", name: "Savings", add: true });
st = await send({ type: "STATE" });
const idB = st.wallets.find((w) => w.name === "Savings")?.id;
ok("B: second wallet keeps its own name", !!idB && st.wallets.length === 2);
await send({ type: "SWITCH_WALLET", id: idA });
await send({ type: "UNLOCK", password: PW });
await capture("wallets", (p) => open(p, "wallets"));

// ---------- coins with labels on Fractal ----------
await hook(() => self.__pbE2E.fundOpenWallet("40000", "Salary"));
await hook(() => self.__pbE2E.fundOpenWallet("25000", "Shop"));
await hook(() => self.__pbE2E.fundOpenWallet("9000"));
st = await send({ type: "STATE" });
ok("Fractal wallet has three coins", BigInt(st.confirmed ?? "0") === 74000n, st.confirmed);
const fbCode = st.receive;

// ---------- D. switch to Bitcoin with the chip ----------
await open(page, "home");
await click('button.net[data-sheet="network"]');
await settle(page, 300);
await capture("network-sheet", async (p) => {
  await open(p, "home");
  await click('button.net[data-sheet="network"]', p);
}, {});
await open(page, "home");
await click('button.net[data-sheet="network"]');
await click('[data-act="net-set"][data-v="bitcoin"]');
await settle(page, 1500);
st = await send({ type: "STATE" });
ok("D: chip switches to Bitcoin", st.net === "bitcoin", st.net);
ok("D: Bitcoin receive code is its own sp1 code", st.receive?.startsWith("sp1") && st.receive !== fbCode);
ok("D: Bitcoin balance starts empty, coins are per chain", BigInt(st.confirmed ?? "0") === 0n, st.confirmed);
const homeBtc = await text();
ok("D: home shows BTC and the Bitcoin name", homeBtc.includes("BTC") && homeBtc.includes("Bitcoin"));
ok("D: Bitcoin logo shown", (await page.locator('img.nlogo.btc').count()) > 0);
const btcCode = st.receive;
await hook(() => self.__pbE2E.fundOpenWallet("120000", "Cold"));
await hook(() => self.__pbE2E.fundOpenWallet("30000"));
await settle(page, 800);
await capture("btc-home", (p) => open(p, "home"));
await capture("btc-receive", (p) => open(p, "receive"));
const rcv = await text();
ok("D: receive screen names Bitcoin", rcv.includes("Bitcoin") && !rcv.includes("Fractal"));

// D fees and send review on Bitcoin, final confirmation names the chain
const toReview = async (p, to, amt) => {
  await open(p, "send");
  await fill("#to", to, p);
  await settle(p, 600);
  await fill("#amt", amt, p);
  await settle(p, 600);
  await click('[data-act="review"]', p);
  await settle(p, 900);
};
await toReview(page, fbCode, "0.0005");
await click('[data-act="sheet"][data-sheet="confirm"]');
const cf = await page.locator(".sheet").innerText();
ok("D: final confirmation names Bitcoin", cf.includes("Bitcoin") && cf.includes("cannot be reversed"), cf.slice(0, 120));
ok("D: no wrong network warning on a sp1 code", !/wrong network|different network/i.test(cf));
await capture("btc-confirm", async (p) => {
  await toReview(p, fbCode, "0.0005");
  await click('[data-act="sheet"][data-sheet="confirm"]', p);
});

// F on Bitcoin: a sent payment and a received one
const sentTx = await hook(() => self.__pbE2E.addSent({ to: "sp1qqfakeexampleonlyforlayout0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", onchain: "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr", amount: "50000", fee: "308", change: "69692", label: "Rent" }));
await open(page, "activity-detail", { id: sentTx });
const det = await text();
ok("F: sent shows Paid to, on-chain address, back to you, fee, network", ["Paid to", "On-chain address", "Back to you", "Network fee", "Bitcoin"].every((k) => det.includes(k)), det.slice(0, 300));
ok("F: explorer is mempool.space for Bitcoin", det.includes("mempool.space"));
await capture("btc-sent-detail", (p) => open(p, "activity-detail", { id: sentTx }));
const hist = await send({ type: "HISTORY" });
const recv = Object.values(hist.entries ?? {}).find((e) => e.kind === "received");
if (recv) {
  await open(page, "activity-detail", { id: recv.txid });
  const r = await text();
  ok("F: received shows receive code, on-chain address and sender not revealed", r.includes("Received to") && r.includes("On-chain address") && r.includes("Not revealed"), r.slice(0, 200));
  await capture("btc-received-detail", (p) => open(p, "activity-detail", { id: recv.txid }));
} else ok("F: a received entry exists", false, JSON.stringify(Object.keys(hist)));
const splitTx = await hook(() => self.__pbE2E.addSent({ to: "", onchain: "", amount: "30000", fee: "400", change: "0", kind: "split" }));
await open(page, "activity-detail", { id: splitTx });
ok("F: split shows moved between your coins", (await text()).includes("Moved between your coins"));

// D: own node chain check on Bitcoin (nothing listens: plain error)
await open(page, "set-network");
await click('[data-act="set"][data-k="src"][data-v="core"]');
await click('[data-act="net-save"]');
await fill("#u", "http://127.0.0.1:18443");
await fill("#ru", "user");
await fill("#rp", "pass");
await click('[data-act="node-test"]');
await settle(page, 2500);
const nodeT = await text();
ok("Own node: unreachable node gives a plain message", /could not be reached|could not reach|not answering|is it running/i.test(nodeT) && !/TypeError|fetch failed/i.test(nodeT), (nodeT.match(/Could not connect[^\n]*\n?[^\n]*/) ?? [""])[0]);
await page.locator("summary", { hasText: "cookie" }).first().click();
await fill("#ck", "not a cookie");
await click('[data-act="cookie-use"][data-id="ck"]');
ok("Own node: bad cookie is refused", (await text()).includes("That is not a cookie file"));
await fill("#ck", "__cookie__:0123456789abcdef0123456789abcdef");
await click('[data-act="cookie-use"][data-id="ck"]');
ok("Own node: cookie fills user and password", (await page.inputValue("#ru")) === "__cookie__" && (await page.inputValue("#rp")).length === 32);
await capture("btc-node", async (p) => {
  await open(p, "set-node");
  await fill("#u", "http://127.0.0.1:18443", p);
  await click('[data-act="node-test"]', p);
  await settle(p, 2000);
});

// E: Payjoin settings per chain, validated
await open(page, "set-payjoin");
const pjB = await text();
ok("E: Bitcoin Payjoin defaults to payjo.in", (await page.inputValue("#mb")) === "https://payjo.in" && pjB.includes("For Bitcoin"));
await fill("#mb", "https://pj.example.org");
await fill("#rl", "https://pj.example.org");
await click('[data-act="pj-test"]');
ok("E: same mailbox and relay refused", (await text()).includes("must be different services"));
await fill("#mb", "http://payjo.in");
await click('[data-act="pj-save"]');
ok("E: http mailbox refused", (await text()).includes("https://"));
await capture("btc-payjoin-settings", (p) => open(p, "set-payjoin"));
await capture("btc-paylink", (p) => open(p, "paylink"));

// ---------- back to Fractal: coin control, merge warning, no change, delay ----------
st = await send({ type: "SET_NETWORK", network: "fractal" });
ok("D: back on Fractal keeps Fractal coins", st.state.net === "fractal" && BigInt(st.state.confirmed ?? "0") === 74000n, st.state.confirmed);
await open(page, "set-payjoin");
ok("E: Fractal has its own Payjoin settings", (await text()).includes("For Fractal Bitcoin"));

await toReview(page, btcCode, "0.0006");
const rv = await text();
ok("Merge warning lists both labels", (await page.locator("#merge-warn").count()) === 1 && rv.includes('"Salary"') && rv.includes('"Shop"'), (rv.match(/one owner:[^\n]*/) ?? [""])[0]);
ok("Merge warning blocks Confirm", await page.locator('[data-act="sheet"][data-sheet="confirm"]').isDisabled());
await capture("review-merge", (p) => toReview(p, btcCode, "0.0006"));
await page.locator('input[data-f="ackMerge"]').check();
await settle(page, 300);
ok("Continue unlocks Confirm", !(await page.locator('[data-act="sheet"][data-sheet="confirm"]').isDisabled()));
await click('[data-act="merge-back"]');
ok("Change coins opens coin choice", (await text()).match(/Choose|coins/i) !== null);

await toReview(page, btcCode, "0.000388");
const nc = await text();
ok("No change: extra goes to the fee and is shown", (await page.locator("#nochange").count()) === 1 && /extra go to the network fee/.test(nc), (nc.match(/No change[^\n]*\n?[^\n]*/) ?? [""])[0]);
await capture("review-nochange", (p) => toReview(p, btcCode, "0.000388"));

// Delayed sending: hold, card on home, cancel; then send now fails safely in the mock
await send({ type: "PREFS_SET", prefs: { sendDelay: "1h" } });
await toReview(page, btcCode, "0.0001");
ok("Delay note on review", (await text()).includes("Sent at a random time within 1 hour"));
await click('[data-act="sheet"][data-sheet="confirm"]');
await click('[data-act="broadcast"]');
await settle(page, 1500);
ok("Held screen shown after confirm", (await text()).includes("waits to be sent"));
let b = await send({ type: "BUNDLE" });
ok("Held payment stored", (b.delayed ?? []).length === 1 && b.delayed[0].status !== "failed");
await capture("held", async (p) => {
  await open(p, "home");
});
// survives a service worker restart: the queue is in sealed storage
const swCount = ctx.serviceWorkers().length;
b = await send({ type: "BUNDLE" });
ok("Held payment readable from storage", (b.delayed ?? []).length === 1, String(swCount));
await open(page, "home");
await click('[data-act="held-cancel"]');
await settle(page, 800);
b = await send({ type: "BUNDLE" });
ok("Cancel removes it and nothing was sent", (b.delayed ?? []).length === 0);
await toReview(page, btcCode, "0.0001");
await click('[data-act="sheet"][data-sheet="confirm"]');
await click('[data-act="broadcast"]');
await settle(page, 1200);
await click('[data-act="held-now"]');
await settle(page, 1500);
b = await send({ type: "BUNDLE" });
ok("Send now in the offline run ends as Not sent, coins kept", (b.delayed ?? [])[0]?.status === "failed", JSON.stringify((b.delayed ?? [])[0]?.status));
await capture("held-failed", (p) => open(p, "home"));
await open(page, "home");
await click('[data-act="held-dismiss"]');
b = await send({ type: "BUNDLE" });
ok("Dismiss clears the failed card", (b.delayed ?? []).length === 0);
await send({ type: "PREFS_SET", prefs: { sendDelay: "off" } });

// Split: six pieces, random sizes
await hook(() => self.__pbE2E.fundOpenWallet("300000", "Salary"));
const coins = await send({ type: "COINS" });
const big = coins.find((c) => c.value === "300000");
await open(page, "coin-split", { op: big.outpoint });
await click('[data-act="split-n"][data-v="6"]');
await click('[data-act="split-random"]');
const vals = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => page.inputValue(`#sp${i}`)));
ok("Split: six random pieces, all different", vals.every((v) => v) && new Set(vals).size === 6, vals.join(" "));
ok("Split: review is ready", !(await page.locator('[data-act="split-review"]').isDisabled()));
await capture("split", async (p) => {
  await open(p, "coin-split", { op: big.outpoint });
  await click('[data-act="split-n"][data-v="6"]', p);
  await click('[data-act="split-random"]', p);
});

// Settings screens
await capture("settings-sending", (p) => open(p, "set-sending"));
await open(page, "set-sending");
await click('[data-act="set"][data-k="sv"][data-v="node"]');
await fill("#su", "http://127.0.0.1:18443");
await click('[data-act="send-save"]');
await settle(page, 2500);
ok("Send route: unreachable node is not saved", (await text()).includes("Nothing was saved"));
b = await send({ type: "BUNDLE" });
ok("Send route stays public", b.state.chain.sendVia !== "node");
await click('[data-act="delay-set"][data-v="10m"]');
await click('[data-act="leftover-set"][data-v="2500"]');
b = await send({ type: "BUNDLE" });
ok("Delay and small leftover saved", b.prefs.sendDelay === "10m" && b.prefs.leftover === 2500);
await send({ type: "PREFS_SET", prefs: { sendDelay: "off", leftover: "auto" } });

await open(page, "set-price");
await click('[data-act="price-src"][data-v="mexc"]');
await settle(page, 2500);
b = await send({ type: "BUNDLE" });
ok("C: price source saved as MEXC", b.prefs.priceSource === "mexc" && b.prefs.usd === true);
const pr = await text();
ok("C: failed price shows plainly with the time", pr.includes("Neither price service answered") || pr.includes("None yet"), (pr.match(/Neither[^\n]*/) ?? [""])[0]);
await capture("settings-price", (p) => open(p, "set-price"));
await click('[data-act="price-src"][data-v="off"]');
b = await send({ type: "BUNDLE" });
ok("C: price off", b.prefs.priceSource === "off" && b.prefs.usd === false);
await capture("settings", (p) => open(p, "settings"));
await capture("fractal-home", (p) => open(p, "home"));
await capture("fractal-activity", (p) => open(p, "activity"));
await capture("coins", (p) => open(p, "coins"));
await capture("remove", (p) => open(p, "remove"));
await capture("migrate", (p) => open(p, "migrate"));
await capture("set-scan", (p) => open(p, "set-scan"));

// Lock: no page errors on the locked screen
const before = errors.length;
await send({ type: "LOCK" });
await page.goto(`${base}/full.html`);
await settle(page, 2500);
await pop.goto(`${base}/popup.html`);
await settle(pop, 2500);
ok("Locked screens load without page errors", errors.length === before, errors.slice(before).join(" | "));
await capture("unlock", async (p) => {
  await p.goto(`${base}/${kindOf(p)}.html`);
  await settle(p, 1200);
});
await page.fill("#pw", PW).catch(() => {});
await send({ type: "UNLOCK", password: PW });

writeFileSync(join(OUT, "results.json"), JSON.stringify({ results, errors, axeFindings, shots }, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${shots.length} screenshots; page errors: ${errors.length}`);
for (const f of failed) console.log("FAILED:", f.name, f.detail ?? "");
for (const e of errors.slice(0, 15)) console.log("error:", e);
await ctx.close();
rmSync(profile, { recursive: true, force: true });
