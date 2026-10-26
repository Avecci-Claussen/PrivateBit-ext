import { S, screens, actions, loaders, go, back, render, run, refresh, fv, busy, err, toast } from "../app.ts";
import { call, type ChainConfig, type Prefs } from "../api.ts";
import { html, raw, I, curNet, NETLOGO, num, hm, type Safe, UNIT, CHAIN_SHORT, CHAIN } from "../kit.ts";
import { findSiteForm, sitesIntro, sitesList } from "./dapp.ts";
import { hdr, tabs, mailboxHost } from "../chrome.ts";
import { netInfo, DEFAULT_PAYJOIN_DIRECTORY, DEFAULT_OHTTP_RELAY, publicServiceUrl } from "../../lib/network.ts";
import { LOCK_CHOICES } from "../../lib/prefs.ts";
import { THEME_CHOICES, type ThemeChoice } from "../../lib/theme.ts";
import { applyTheme, currentTheme } from "../theme.ts";
import { PRICE_HOSTS, type PricePref } from "../../lib/requests.ts";
import { parseCookie } from "../../lib/chain.ts";
import { checkPayjoinUrls, type PayjoinRouteCheck } from "../../lib/payjoin.ts";
import { DELAY_CHOICES, type DelayChoice } from "../../lib/plan-random.ts";
import { LEFTOVER_CHOICES, type LeftoverPref } from "../../lib/coinselect.ts";
import { price, syncLine } from "../derive.ts";
const defBirthday = (): number => netInfo(curNet()).defaultBirthday;

const chain = (): ChainConfig => S.b!.state.chain;
const prefs = (): Prefs => S.b!.prefs;
const errP = (k: string): Safe | string => (err(k) ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err(k)}</span></p>` : "");
const host = (u: string | undefined, d: string): string => {
  try {
    return new URL(u || d).host;
  } catch {
    return u || d;
  }
};

function row(ic: string, t: string, d: string, to: string): Safe {
  return html`<a class="li" href="#" data-act="go" data-to="${to}"><span class="ico">${I(ic)}</span><span class="body"><span class="t">${t}</span><span class="d">${d}</span></span>${I("chevron-right", "s16 chev")}</a>`;
}
function toggle(t: string, d: string, on: boolean, id: string, pref: keyof Prefs, extra?: Safe): Safe {
  // The whole row is the switch's label, so the touch target is the row, not the 52 x 32 switch.
  return html`<label class="li swrow" for="${id}"><span class="body"><span class="t">${t}</span><span class="d">${d}</span>${extra ?? ""}</span><input class="switch" type="checkbox" role="switch" id="${id}" data-act="pref-toggle" data-pref="${pref}" ${on ? html`checked` : ""}></label>`;
}
actions["pref-toggle"] = async (el, ev) => {
  ev.preventDefault();
  const k = el.dataset.pref as keyof Prefs;
  const next = !prefs()[k];
  await run("pref", async () => {
    await call({ type: "PREFS_SET", prefs: { [k]: next } });
    await refresh();
  });
  if (k === "hideBalance") S.f.hideBal = next;
};
async function setLock(m: number): Promise<void> {
  await call({ type: "PREFS_SET", prefs: { lockMinutes: m } });
  await refresh();
  render();
}
actions["lock-min"] = (el) => setLock(Number(el.dataset.v));

function themeSummary(): string {
  const id = currentTheme();
  return THEME_CHOICES.find((c) => c.id === id)?.label ?? "Dark (default)";
}
function themeSeg(labelledBy: string): Safe {
  const cur = currentTheme();
  return html`<div class="seg wrap" role="radiogroup" aria-labelledby="${labelledBy}">${THEME_CHOICES.map((c) => html`<button type="button" role="radio" data-act="theme-set" data-v="${c.id}" aria-checked="${String(cur === c.id)}">${c.label}</button>`)}</div>`;
}
screens["set-appearance"] = () => ({
  title: "Appearance",
  header: hdr({ title: "Appearance" }),
  main: html`<div class="field"><p class="label" id="ap">Theme</p>${themeSeg("ap")}
    <p class="help">Dark is the default, including the first time you open PrivateBit. Your choice stays on this computer across lock and closing the window.</p></div>`,
});
actions["theme-set"] = (el) => {
  applyTheme(el.dataset.v as ThemeChoice);
  render();
};

const DELAY_NAME: Record<DelayChoice, string> = { off: "Off", "1m": "Up to 1 minute", "10m": "Up to 10 minutes", "1h": "Up to 1 hour" };
const SOURCE_NAME: Record<PricePref, string> = { coingecko: "CoinGecko", mexc: "MEXC", off: "Off" };
function leftoverName(v: LeftoverPref): string {
  return v === "auto" ? "Automatic" : v === 0 ? "Keep change" : `${num(v)} sats`;
}
function sendingSummary(): string {
  const pr = prefs();
  const c = chain();
  const via = c.kind === "core" || c.sendVia === "node" ? "Through your node" : "Through the public service";
  return `${via}${pr.sendDelay !== "off" ? `, delay ${DELAY_NAME[pr.sendDelay].toLowerCase()}` : ""}`;
}
function priceSummary(): string {
  const pr = prefs();
  if (pr.priceSource === "off") return "Off, no price requests";
  return `${SOURCE_NAME[pr.priceSource]}, the other one if it fails`;
}

const VERSION = chrome.runtime.getManifest?.().version ?? "1.0.0";

/* ---------- list (54) ---------- */
screens.settings = () => {
  const c = chain();
  const pr = prefs();
  return {
    title: "Settings",
    header: hdr(),
    nav: tabs("settings"),
    main: html`
  <h1 data-st="9d50d4">Settings</h1>
  <div class="list">
  ${row("wallet", "Wallets", (() => { const n = (S.b!.state.wallets ?? []).length || 1; return `${n} ${n === 1 ? "wallet" : "wallets"}, ${(S.b!.state.wallets ?? []).find((w) => w.active)?.name ?? "Wallet"} open`; })(), "wallets")}
  ${row("blocks", "Network and data source", c.kind === "core" ? `${CHAIN_SHORT()}, your own node` : `${CHAIN_SHORT()}, public block data service`, "set-network")}
  ${row("sun", "Appearance", themeSummary(), "set-appearance")}
  ${row("arrow-up-right", "Sending", sendingSummary(), "set-sending")}
  ${row("circle-dollar-sign", "USD price", priceSummary(), "set-price")}
  ${row("eye-off", "Privacy", "Hide balance, explorer", "set-privacy")}
  ${row("route", "Payment links", `${CHAIN_SHORT()}: ${mailboxHost()} through a relay`, "set-payjoin")}
  ${row("lock", "Security and lock", `Password, lock after ${pr.lockMinutes} min`, "set-security")}
  ${row("file-key", "Backup", "Recovery words", "set-backup")}
  ${row("scan-line", "Finding coins", `Look back from block ${num(S.b!.state.birthday ?? defBirthday())}`, "set-scan")}
  ${row("arrow-right-left", "Move coins from another wallet", "One payment, then move it into your receive code", "migrate")}
  ${row("globe", "Connected sites", "Websites you approved, each with its own account", "set-sites")}
</div>
  ${S.mode === "popup" ? html`<button class="btn btn-secondary btn-block" type="button" data-act="open-full">${I("external-link", "s16")}Open full page</button>` : ""}
  ${aboutBlock()}`,
    page: fullSettings(),
  };
};
actions["open-full"] = () => {
  void chrome.runtime.openOptionsPage();
};

const X_URL = "https://x.com/The_LonelyBit";
const TELEGRAM_URL = "https://t.me/FractalBits";
const GITHUB_EXT = "https://github.com/Avecci-Claussen/PrivateBit-ext";
const GITHUB_ANDROID = "https://github.com/Avecci-Claussen/PrivateBit-Mobile-Android";
const PUBLIC_LINKS = new Set([X_URL, TELEGRAM_URL, GITHUB_EXT, GITHUB_ANDROID]);
const onPhone = (): boolean => typeof (globalThis as { Capacitor?: unknown }).Capacitor !== "undefined";

const X_MARK = raw(`<svg class="brand" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>`);
const TELEGRAM_MARK = raw(`<svg class="brand" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`);
const GITHUB_MARK = raw(`<svg class="brand" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`);

function socialButton(url: string, label: string, mark: Safe): Safe {
  return html`<button class="btn btn-ghost btn-sm social-btn" type="button" data-act="open-social" data-url="${url}" aria-label="${label}" title="${label}">${mark}</button>`;
}

function aboutBlock(): Safe {
  const github = onPhone() ? GITHUB_ANDROID : GITHUB_EXT;
  return html`<div class="about"><p class="cap" data-st="91a870">PrivateBit ${VERSION}</p><div class="social">${socialButton(X_URL, "X", X_MARK)}${socialButton(TELEGRAM_URL, "Telegram", TELEGRAM_MARK)}${socialButton(github, "GitHub", GITHUB_MARK)}</div></div>`;
}

actions["open-social"] = (el) => {
  const url = el.dataset.url ?? "";
  if (!PUBLIC_LINKS.has(url)) return;
  const tabs = (chrome as { tabs?: { create?: (o: { url: string }) => void } }).tabs;
  if (tabs?.create) {
    tabs.create({ url });
    return;
  }
  window.location.assign(url);
};

/* ---------- network and data source (55) ---------- */
loaders["set-network"] = () => {
  const c = chain();
  S.f.src = c.kind === "core" ? "core" : "service";
  S.f.tok = c.unisatToken ?? "";
};
function networkForm(): Safe {
  const own = fv("src", chain().kind === "core" ? "core" : "service") === "core";
  return html`<div class="card flat pad-sm"><div class="row">${NETLOGO("current", "lg")}<span class="body grow"><span class="strong" data-st="2a1b75">${CHAIN()}</span><span class="small muted">Mainnet. Switch chains with the chip at the top.</span></span></div></div>
  <fieldset class="field" data-st="e8f267"><legend class="label" data-st="4e420a">Where block data comes from</legend><div class="opt-list" role="radiogroup">
    <button class="opt" role="radio" aria-checked="${String(!own)}" type="button" data-act="set" data-k="src" data-v="service"><span class="body"><span class="t">Public block data service</span><span class="d">Easiest. The service sees your IP, the blocks and fee rates you ask for, and the payments you broadcast. It is not given your receive code.</span></span>${!own ? I("check") : ""}</button>
    <button class="opt" role="radio" aria-checked="${String(own)}" type="button" data-act="set" data-k="src" data-v="core"><span class="body"><span class="t">My own ${CHAIN_SHORT()} node</span><span class="d">Most private. Needs a node URL and RPC login.</span></span>${own ? I("check") : ""}</button></div></fieldset>
  ${own
    ? html`<button class="rowlink" type="button" data-act="go" data-to="set-node"><span class="body"><span class="t">Node settings</span><span class="d">${chain().kind === "core" ? chain().url : "Not set up yet"}</span></span><span class="v">${I("chevron-right", "s16")}</span></button>`
    : html`<div class="field" data-enter="net-save"><label class="label" for="tok">Data service API key <span class="optl">(optional)</span></label><input class="input" id="tok" data-f="tok" type="password" autocomplete="off" value="${fv("tok")}" aria-describedby="tok-h"><p class="help" id="tok-h">Stored encrypted on this computer only. On ${CHAIN_SHORT()} a key is sent to ${host(publicServiceUrl(undefined, curNet()), "")}. A key from the other chain is refused there. Without a key, blocks come from ${host(netInfo(curNet()).explorer, "")}.</p></div>`}
  ${errP("net")}`;
}
screens["set-network"] = () => ({
  title: "Network and data source",
  header: hdr({ title: "Network and data source" }),
  main: networkForm(),
  foot: html`<button class="btn btn-primary btn-block" type="button" data-act="net-save" ${busy("net") ? html`aria-disabled="true"` : ""}>Save</button>`,
});
actions["net-save"] = async () => {
  if (fv("src") === "core" && chain().kind !== "core") {
    go("set-node");
    return;
  }
  const c = chain();
  const next: ChainConfig =
    fv("src") === "core"
      ? c
      : { ...c, kind: "unisat", url: publicServiceUrl(c.kind === "core" ? undefined : c, curNet()), unisatToken: fv("tok").trim() };
  const ok = await run(
    "net",
    async () => {
      await call({ type: "SAVE_CHAIN", chain: next });
      await refresh();
      if (next.kind === "unisat" && next.unisatToken) await call({ type: "TEST_CHAIN", chain: next });
      return true;
    },
    "net",
  );
  if (ok) toast("Saved.");
};

/* ---------- own node (56) ---------- */
type NodeResult = { ok: boolean; height?: number; chain?: string; txindex?: boolean | "unknown"; onChain?: "yes" | "other" | "behind"; blocks?: number; headers?: number; msg?: string };
async function testNode(cfg: ChainConfig, sendNode = false): Promise<NodeResult> {
  try {
    const r = await call<Omit<NodeResult, "ok">>({ type: "TEST_CHAIN", chain: cfg, sendNode });
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, msg: String((e as Error).message) };
  }
}
function nodeResult(t: NodeResult | undefined, forScan = false): Safe | string {
  if (!t) return "";
  if (!t.ok) return html`<div class="banner danger" role="alert">${I("circle-x", "s16")}<div><span class="bt">Could not connect</span><span data-st="115422">${t.msg}</span></div></div>`;
  const wrong = t.onChain === "other";
  const behind = t.onChain === "behind";
  const syncing = t.headers !== undefined && t.blocks !== undefined && t.headers - t.blocks > 2;
  const lines: (Safe | string)[] = [];
  lines.push(html`<li>${wrong ? `It follows a different chain, not ${CHAIN()}.` : behind ? `It has not reached the block that tells ${CHAIN()} apart yet. Let it sync, then test again.` : `It follows ${CHAIN()}.`}</li>`);
  lines.push(html`<li>At block ${num(t.height ?? t.blocks ?? 0)}${syncing ? `, still catching up to ${num(t.headers ?? 0)}` : ""}.</li>`);
  if (forScan) lines.push(html`<li>${t.txindex === true ? "Transaction index is on." : t.txindex === false ? "Transaction index is off. Finding coins still works, but checking older payments is slower. Add txindex=1 to its settings for the best results." : "Could not tell whether the transaction index is on."}</li>`);
  const cls = wrong ? "danger" : behind || syncing || (forScan && t.txindex === false) ? "warn" : "ok";
  return html`<div class="banner ${cls}" role="status">${I(wrong ? "circle-x" : cls === "warn" ? "triangle-alert" : "circle-check", "s16")}<div><span class="bt">${wrong ? "Wrong chain" : "Connected"}</span><ul class="small" data-st="5715f8">${lines}</ul></div></div>`;
}
/** Paste the node's .cookie file instead of typing a user and password. */
function cookieField(id: string, userKey: string, passKey: string): Safe {
  return html`<details class="card flat pad-sm" ${S.f[`${id}Open`] || err(id) ? html`open` : ""}><summary class="small strong" data-st="3b6a3a" data-act="toggle-k" data-k="${id}Open">Use the cookie file instead</summary><div class="field" data-st="8a77e5"><label class="label" for="${id}">Paste the contents of .cookie</label><input class="input mono" id="${id}" data-f="${id}" autocomplete="off" spellcheck="false" placeholder="__cookie__:…" aria-describedby="${id}-h"><p class="help" id="${id}-h">Found in the node's data folder. It changes each time the node restarts, so paste it again after a restart.</p>${err(id) ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err(id)}</span></p>` : ""}
  <button class="btn btn-secondary btn-sm" type="button" data-act="cookie-use" data-id="${id}" data-u="${userKey}" data-p="${passKey}" data-st="c9adc4">${I("clipboard-paste", "s16")}Use cookie</button></div></details>`;
}
actions["cookie-use"] = (el) => {
  const id = el.dataset.id!;
  const c = parseCookie(fv(id));
  if (!c) {
    S.err[id] = "That is not a cookie file. It looks like __cookie__: followed by a long code.";
    render();
    return;
  }
  delete S.err[id];
  S.f[el.dataset.u!] = c.user;
  S.f[el.dataset.p!] = c.password;
  S.f[id] = "";
  toast("Cookie filled in. Test the node to check it.");
  render();
};

loaders["set-node"] = () => {
  const c = chain();
  S.f.nu = c.kind === "core" ? c.url : "http://127.0.0.1:8332";
  S.f.nru = c.rpcUser ?? "";
  S.f.nrp = c.rpcPassword ?? "";
  S.d.nodeTest = undefined;
};
export async function hostPermission(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return true;
    return await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch {
    return false;
  }
}
function nodeCfg(): ChainConfig {
  return { ...chain(), kind: "core", url: fv("nu").trim(), rpcUser: fv("nru").trim(), rpcPassword: fv("nrp") };
}
screens["set-node"] = () => {
  const t = S.d.nodeTest as NodeResult | undefined;
  let lh = "";
  try {
    lh = new URL(fv("nu")).hostname;
  } catch {
    /* typing */
  }
  return {
    title: `My own ${CHAIN_SHORT()} node`,
    header: hdr({ title: `My own ${CHAIN_SHORT()} node` }),
    main: html`
  <div class="field"><label class="label" for="u">Node RPC URL</label><input class="input mono" id="u" data-f="nu" data-live autocomplete="off" placeholder="http://127.0.0.1:8332" value="${fv("nu")}"></div>
  ${cookieField("ck", "nru", "nrp")}
  <div class="field"><label class="label" for="ru">RPC user</label><input class="input" id="ru" data-f="nru" autocomplete="off" value="${fv("nru")}"></div>
  <div class="field"><label class="label" for="rp">RPC password</label><input class="input" id="rp" data-f="nrp" type="password" autocomplete="off" value="${fv("nrp")}" aria-describedby="rp-h"><p class="help" id="rp-h">Stored encrypted on this computer only.</p></div>
  ${nodeResult(t, true)}${t?.ok && lh && lh !== "127.0.0.1" && lh !== "localhost" ? html`<p class="small muted">Chrome asks once to allow access to ${lh}.</p>` : ""}
  ${errP("node")}`,
    foot: { cls: "row", html: html`<button class="btn btn-secondary" type="button" data-act="node-test" ${busy("node") ? html`aria-disabled="true"` : ""}>${busy("node") ? "Testing…" : "Test"}</button><button class="btn btn-primary" type="button" data-act="node-save">Save</button>` },
  };
};
actions["node-test"] = async () => {
  const cfg = nodeCfg();
  if (!(await hostPermission(cfg.url))) {
    S.d.nodeTest = { ok: false, msg: "Chrome did not allow access to that address." };
    render();
    return;
  }
  S.busy = "node";
  render();
  S.d.nodeTest = await testNode(cfg);
  S.busy = null;
  render();
};
actions["node-save"] = async () => {
  const cfg = nodeCfg();
  if (!/^https?:\/\//.test(cfg.url)) {
    S.err.node = "Enter a URL that starts with http:// or https://.";
    render();
    return;
  }
  if (!(await hostPermission(cfg.url))) {
    S.err.node = "Chrome did not allow access to that address.";
    render();
    return;
  }
  const t = await testNode(cfg);
  S.d.nodeTest = t;
  if (!t.ok || t.onChain === "other") {
    S.err.node = t.ok ? `That node follows a different chain. PrivateBit on ${CHAIN()} cannot use it.` : "Fix the connection first. Nothing was saved.";
    render();
    return;
  }
  const ok = await run(
    "node",
    async () => {
      await call({ type: "SAVE_CHAIN", chain: cfg });
      await refresh();
      return true;
    },
    "node",
  );
  if (ok) {
    toast("Saved. PrivateBit now uses your node.");
    back("settings");
  }
};

/* ---------- privacy (57) and price (57b) ---------- */
function privacyList(): Safe {
  const pr = prefs();
  return html`<div class="list">
  ${toggle("Hide balance when PrivateBit opens", "Amounts show as dots until you use the eye button.", pr.hideBalance, "t1", "hideBalance")}
  ${row("circle-dollar-sign", "USD price", priceSummary(), "set-price")}
  ${toggle("Ask before opening an explorer", "Explorers see your IP and which transaction you looked up.", pr.askExplorer, "t4", "askExplorer")}
  ${visibilityToggle()}</div>`;
}

/* Audit M7 (independent): which websites can tell PrivateBit is installed. */
function visibilityToggle(): Safe {
  const v = S.d.visibility as { all: boolean; origins: string[] } | undefined;
  if (!v || !(globalThis as { chrome?: { tabs?: unknown } }).chrome?.tabs) return html``;
  return html`<label class="li swrow" for="t5"><span class="body"><span class="t">Every website can see PrivateBit</span><span class="d">${v.all ? "Any site, tracker or ad can tell PrivateBit is installed." : `Off: only sites you allow can see it (${v.origins.length}). Allow a site from the wallet while it is open in the tab.`}</span></span><input class="switch" type="checkbox" role="switch" id="t5" data-act="vis-all" ${v.all ? html`checked` : ""}></label>`;
}
actions["vis-all"] = async (_el, ev) => {
  ev.preventDefault();
  const v = S.d.visibility as { all: boolean } | undefined;
  const got = await run("pref", () => call<{ all: boolean; origins: string[] }>({ type: "DAPP_SET_VISIBILITY", all: !v?.all }));
  if (got) S.d.visibility = got;
  render();
};
async function loadVisibilityView(): Promise<void> {
  try {
    S.d.visibility = await call({ type: "DAPP_VISIBILITY" });
    render();
  } catch {
    /* not available */
  }
}
loaders["set-privacy"] = loadVisibilityView;
loaders.settings = loadVisibilityView;
screens["set-privacy"] = () => ({ title: "Privacy", header: hdr({ title: "Privacy" }), main: privacyList() });

screens["set-price"] = () => ({ title: "USD price", header: hdr({ title: "USD price" }), main: priceForm() });
function priceForm(): Safe {
  const p = price();
  const pc = S.b!.price;
  const pr = prefs();
  const src = pr.priceSource;
  const other = src === "mexc" ? "coingecko" : "mexc";
  const opt = (v: PricePref, t: string, d: string): Safe =>
    html`<button class="opt" role="radio" aria-checked="${String(src === v)}" type="button" data-act="price-src" data-v="${v}"><span class="body"><span class="t">${t}</span><span class="d">${d}</span></span>${src === v ? I("check") : ""}</button>`;
  const used = pc?.source ? SOURCE_NAME[pc.source] : "";
  const last = pc?.usd && pc.fetchedAt && p.kind !== "na" && p.kind !== "off"
    ? html`<span class="mono">$${pc.usd >= 100 ? pc.usd.toLocaleString("en-US", { maximumFractionDigits: 0 }) : pc.usd.toFixed(4)}</span><span class="cap ${p.kind === "stale" ? "warn" : ""}">${p.kind === "stale" ? "Not updated since " : "Updated "}${hm(pc.fetchedAt)}${used ? `, from ${used}` : ""}</span>`
    : html`<span class="muted">${src === "off" ? "Off" : "None yet"}</span>`;
  return html`
  <fieldset class="field" data-st="e8f267"><legend class="label" data-st="4e420a">Price source</legend><div class="opt-list" role="radiogroup">
    ${opt("coingecko", "CoinGecko", `${PRICE_HOSTS.coingecko}. If it does not answer, MEXC is asked.`)}
    ${opt("mexc", "MEXC", `${PRICE_HOSTS.mexc}, the ${UNIT() === "BTC" ? "BTCUSDT" : "FBUSDT"} market. If it does not answer, CoinGecko is asked.`)}
    ${opt("off", "Off", "No price request is ever made. Amounts show in " + UNIT() + " only.")}</div></fieldset>
  <div class="card"><div class="kv">
    <div class="r"><span class="k">Asks for</span><span class="v">${UNIT()} price in USD, nothing else</span></div>
    <div class="r"><span class="k">How often</span><span class="v">Every 10 minutes while unlocked</span></div>
    <div class="r"><span class="k">Last price</span><span class="v">${last}</span></div></div></div>
  ${src !== "off" && pc?.error && pc.failedAt && (!pc.fetchedAt || pc.failedAt > pc.fetchedAt) ? html`<div class="banner warn" role="status">${I("triangle-alert", "s16")}<div><span class="bt">Neither price service answered at ${hm(pc.failedAt)}</span><span data-st="115422">${pc.error}</span> Your amounts in ${UNIT()} are exact and not affected.</div></div>` : ""}
  ${src !== "off" ? html`<button class="btn btn-secondary" type="button" data-act="price-now" ${busy("price") ? html`aria-disabled="true"` : ""}>${I("refresh-cw", busy("price") ? "s16 spin" : "s16")}${busy("price") ? "Asking…" : "Update now"}</button>` : ""}
  <div class="list">
    <div class="li" data-st="2a9295"><span class="ico warn">${I("globe")}</span><span class="body"><span class="t">The price service learns</span><span class="d" data-st="f8f979">Your IP address and the time you asked.</span></span></div>
    <div class="li" data-st="2a9295"><span class="ico in">${I("shield-check")}</span><span class="body"><span class="t">The price service never learns</span><span class="d" data-st="f8f979">Your addresses, codes, coins or balance. The price is applied on this computer.</span></span></div></div>
  <p class="small muted">A price older than 30 minutes shows in amber with its time. ${src !== "off" ? `${SOURCE_NAME[other]} is only asked when ${SOURCE_NAME[src]} fails.` : ""}</p>`;
}
actions["price-src"] = (el) => {
  const v = el.dataset.v as PricePref;
  void run("price", async () => {
    await call({ type: "PREFS_SET", prefs: { priceSource: v } });
    await refresh();
    if (v !== "off") {
      await call({ type: "PRICE", force: true }).catch(() => undefined);
      await refresh();
    }
  });
};
actions["price-now"] = () => {
  void run("price", async () => {
    await call({ type: "PRICE", force: true });
    await refresh();
  });
};

/* ---------- sending ---------- */
loaders["set-sending"] = () => {
  const c = chain();
  S.f.sv = c.sendVia === "node" ? "node" : "public";
  S.f.su = c.sendNodeUrl ?? "http://127.0.0.1:8332";
  S.f.sru = c.sendNodeUser ?? "";
  S.f.srp = c.sendNodePassword ?? "";
  S.d.sendTest = undefined;
};
function seg<T extends string | number>(id: string, act: string, cur: T, list: T[], name: (v: T) => string, cls = ""): Safe {
  return html`<div class="seg wrap ${cls}" role="radiogroup" aria-labelledby="${id}">${list.map((v) => html`<button type="button" role="radio" data-act="${act}" data-v="${String(v)}" aria-checked="${String(cur === v)}">${name(v)}</button>`)}</div>`;
}
function sendNodeCfg(): ChainConfig {
  return { ...chain(), sendVia: fv("sv") === "node" ? "node" : "public", sendNodeUrl: fv("su").trim() || undefined, sendNodeUser: fv("sru").trim() || undefined, sendNodePassword: fv("srp") || undefined };
}
screens["set-sending"] = () => {
  const pr = prefs();
  const c = chain();
  const core = c.kind === "core";
  const viaNode = fv("sv", c.sendVia === "node" ? "node" : "public") === "node";
  const t = S.d.sendTest as NodeResult | undefined;
  const routeOpt = (v: "public" | "node", tt: string, d: string): Safe =>
    html`<button class="opt" role="radio" aria-checked="${String((v === "node") === viaNode)}" type="button" data-act="set" data-k="sv" data-v="${v}"><span class="body"><span class="t">${tt}</span><span class="d">${d}</span></span>${(v === "node") === viaNode ? I("check") : ""}</button>`;
  return {
    title: "Sending",
    header: hdr({ title: "Sending" }),
    main: html`
  <fieldset class="field" data-st="e8f267"><legend class="label" data-st="4e420a">Send payments through</legend>
  ${core
    ? html`<div class="card flat pad-sm"><div class="row">${I("server")}<span class="body grow"><span class="strong" data-st="2a1b75">Your own node</span><span class="small muted">PrivateBit reads blocks from your node, so payments go out through it too.</span></span></div></div>`
    : html`<div class="opt-list" role="radiogroup">
      ${routeOpt("public", "The public service", "Easiest. The service sees your IP address together with each payment.")}
      ${routeOpt("node", `My own ${CHAIN_SHORT()} node`, "Blocks still come from the public service, but it never sees your payments.")}</div>`}</fieldset>
  ${!core && viaNode
    ? html`<div class="stack" data-enter="send-save">
      <div class="field"><label class="label" for="su">Node RPC URL</label><input class="input mono" id="su" data-f="su" autocomplete="off" placeholder="http://127.0.0.1:8332" value="${fv("su")}"></div>
      ${cookieField("sck", "sru", "srp")}
      <div class="field"><label class="label" for="sru">RPC user</label><input class="input" id="sru" data-f="sru" autocomplete="off" value="${fv("sru")}"></div>
      <div class="field"><label class="label" for="srp">RPC password</label><input class="input" id="srp" data-f="srp" type="password" autocomplete="off" value="${fv("srp")}"><p class="help">Stored encrypted on this computer only.</p></div>
      ${nodeResult(t)}
      <button class="btn btn-secondary" type="button" data-act="send-test" ${busy("stest") ? html`aria-disabled="true"` : ""}>${busy("stest") ? "Testing…" : "Test node"}</button></div>`
    : ""}
  ${errP("send")}
  ${core ? "" : html`<button class="btn btn-primary" type="button" data-act="send-save" data-st="c9adc4" ${busy("send") ? html`aria-disabled="true"` : ""}>Save route</button>`}
  <div class="field"><p class="label" id="dl">Delay sending by a random time</p>${seg("dl", "delay-set", pr.sendDelay, DELAY_CHOICES, (v) => DELAY_NAME[v])}
    <p class="help">The time a payment reaches the network says less about when you were at your computer. It waits signed and encrypted here, even if you lock or close the window, and you can send it now or cancel it until then. Payment links always go right away.</p></div>
  <div class="list">${toggle("Randomize fee slightly", "Moves the fee rate a little up or down, never below the network minimum, so your payments do not all share one fee rate.", pr.randomizeFee, "rf", "randomizeFee")}</div>
  <div class="field"><p class="label" id="lo">Small leftover</p>${seg("lo", "leftover-set", pr.leftover, LEFTOVER_CHOICES, leftoverName, "grid3")}
    <p class="help">When the change would be this small or smaller, it is added to the network fee and no change coin is made. A tiny coin costs about as much to spend later as it is worth, and it links your payments. Automatic uses the cost of spending it at the current fee rate, at least 1,000 sats. The review always shows the amount.</p></div>`,
  };
};
actions["delay-set"] = (el) => {
  void run("pref", async () => {
    await call({ type: "PREFS_SET", prefs: { sendDelay: el.dataset.v as DelayChoice } });
    await refresh();
  });
};
actions["leftover-set"] = (el) => {
  const v = el.dataset.v === "auto" ? "auto" : Number(el.dataset.v);
  void run("pref", async () => {
    await call({ type: "PREFS_SET", prefs: { leftover: v as LeftoverPref } });
    await refresh();
  });
};
actions["send-test"] = async () => {
  const cfg = sendNodeCfg();
  if (!cfg.sendNodeUrl || !(await hostPermission(cfg.sendNodeUrl))) {
    S.d.sendTest = { ok: false, msg: cfg.sendNodeUrl ? "Chrome did not allow access to that address." : "Enter the node URL first." };
    render();
    return;
  }
  S.busy = "stest";
  render();
  S.d.sendTest = await testNode(cfg, true);
  S.busy = null;
  render();
};
actions["send-save"] = async () => {
  const cfg = sendNodeCfg();
  if (cfg.sendVia === "node") {
    if (!cfg.sendNodeUrl || !/^https?:\/\//.test(cfg.sendNodeUrl)) {
      S.err.send = "Enter a node URL that starts with http:// or https://.";
      render();
      return;
    }
    if (!(await hostPermission(cfg.sendNodeUrl))) {
      S.err.send = "Chrome did not allow access to that address.";
      render();
      return;
    }
    const t = await testNode(cfg, true);
    S.d.sendTest = t;
    if (!t.ok || t.onChain === "other") {
      S.err.send = t.ok ? `That node follows a different chain. Payments on ${CHAIN()} would fail there.` : "Fix the node connection first. Nothing was saved.";
      render();
      return;
    }
  }
  const ok = await run(
    "send",
    async () => {
      await call({ type: "SAVE_CHAIN", chain: cfg });
      await refresh();
      return true;
    },
    "send",
  );
  if (ok) toast(cfg.sendVia === "node" ? "Saved. Payments now go out through your node." : "Saved. Payments go out through the public service.");
};

/* ---------- payment links (58) ---------- */
loaders["set-payjoin"] = () => {
  S.f.mb = chain().payjoinDirectory ?? DEFAULT_PAYJOIN_DIRECTORY;
  S.f.rl = chain().ohttpRelay ?? DEFAULT_OHTTP_RELAY;
  S.f.mbDirect = chain().directMailboxKeys === true;
  S.d.pjTest = undefined;
};
function payjoinForm(): Safe {
  const same = host(fv("mb"), "") === host(fv("rl"), "") && fv("mb") !== "";
  const t = S.d.pjTest as PayjoinRouteCheck | undefined;
  return html`<div class="card flat pad-sm"><div class="row">${NETLOGO("current")}<span class="body grow"><span class="strong" data-st="2a1b75">For ${CHAIN()}</span><span class="small muted">Each chain keeps its own mailbox and relay.</span></span></div></div>
  <p class="small muted">Payment links pass encrypted messages through a mailbox. A relay sits in between so the mailbox never sees your IP, and the relay never sees the message.</p>
  <div class="field"><label class="label" for="mb">Mailbox</label><input class="input mono" id="mb" data-f="mb" data-live autocomplete="off" value="${fv("mb")}" aria-describedby="mb-h"><p class="help" id="mb-h">Sees: an encrypted 7 KB blob and when it was posted.</p></div>
  <div class="field"><label class="label" for="rl">Relay</label><input class="input mono" id="rl" data-f="rl" data-live autocomplete="off" value="${fv("rl")}" aria-describedby="rl-h"><p class="help" id="rl-h">Sees: your IP, not the content.</p></div>
  <div class="banner ${same ? "warn" : ""}">${I(same ? "triangle-alert" : "info", "s16")}<div>Running both mailbox and relay yourself defeats the purpose of the relay. Use different operators.</div></div>
  <label class="check"><input type="checkbox" data-f="mbDirect" ${S.f.mbDirect ? html`checked` : ""}> <span>Fetch mailbox keys directly<span class="help">Needed only for a mailbox other than payjo.in in the browser. The mailbox then sees your IP once a week. The Android app fetches them through the relay instead.</span></span></label>
  ${t ? (t.ok ? html`<div class="banner ok" role="status">${I("circle-check", "s16")}<div><span class="bt">Route works</span>The mailbox gave its keys and answered through the relay in ${Math.round(t.ms / 1000)} seconds. Nothing was posted.</div></div>` : html`<div class="banner danger" role="alert">${I("circle-x", "s16")}<div><span class="bt">${t.step === "keys" ? "Mailbox not usable" : t.step === "relay" ? "Relay not usable" : "Check the addresses"}</span>${t.message}</div></div>`) : ""}
  ${errP("pj")}`;
}
screens["set-payjoin"] = () => ({
  title: "Payment links",
  header: hdr({ title: "Payment links" }),
  main: payjoinForm(),
  foot: { cls: "row", html: html`<button class="btn btn-secondary" type="button" data-act="pj-test" ${busy("pjt") ? html`aria-disabled="true"` : ""}>${busy("pjt") ? "Testing, up to 40 s…" : "Test"}</button><button class="btn btn-primary" type="button" data-act="pj-save">Save</button>` },
});
actions["pj-test"] = async () => {
  const mb = fv("mb").trim();
  const rl = fv("rl").trim();
  const bad = checkPayjoinUrls(mb, rl);
  if (bad) {
    S.d.pjTest = bad;
    render();
    return;
  }
  if (!(await hostPermission(mb)) || !(await hostPermission(rl))) {
    S.err.pj = "Chrome did not allow access to those addresses.";
    render();
    return;
  }
  S.busy = "pjt";
  delete S.err.pj;
  render();
  try {
    S.d.pjTest = await call<PayjoinRouteCheck>({ type: "PJ_TEST", directory: mb, relay: rl, allowDirect: S.f.mbDirect === true });
  } catch (e) {
    S.d.pjTest = { ok: false, step: "relay", message: String((e as Error).message) };
  }
  S.busy = null;
  render();
};
actions["pj-save"] = async () => {
  const mb = fv("mb").trim();
  const rl = fv("rl").trim();
  const bad = checkPayjoinUrls(mb, rl);
  if (bad) {
    S.err.pj = bad.ok ? "" : bad.message;
    render();
    return;
  }
  if (!(await hostPermission(mb)) || !(await hostPermission(rl))) {
    S.err.pj = "Chrome did not allow access to those addresses.";
    render();
    return;
  }
  const ok = await run(
    "pj",
    async () => {
      await call({ type: "SAVE_CHAIN", chain: { ...chain(), payjoinDirectory: mb, ohttpRelay: rl, directMailboxKeys: S.f.mbDirect === true } });
      await refresh();
      return true;
    },
    "pj",
  );
  if (ok) toast("Saved.");
};

/* ---------- security (59, 59b) ---------- */
function lockSeg(id: string): Safe {
  const cur = prefs().lockMinutes;
  return html`<div class="seg" role="radiogroup" aria-labelledby="${id}">${LOCK_CHOICES.map((m) => html`<button type="button" role="radio" data-act="lock-min" data-v="${m}" aria-checked="${String(cur === m)}">${m} min</button>`)}</div>`;
}
screens["set-security"] = () => {
  const b = S.b!;
  const waiting = b.waiting && b.state.payjoin;
  const last = b.activity?.last;
  const pj = b.state.payjoin;
  return {
    title: "Security and lock",
    header: hdr({ title: "Security and lock" }),
    main: waiting
      ? html`
  <div class="banner" role="status">${I("hourglass", "s16")}<div><span class="bt">A payment keeps going after Lock</span>${pj?.role === "send" ? "A Payjoin payment" : "A payment link"}${pj?.amount && pj.amount !== "0" ? ` of ${Number(pj.amount) / 1e8} ${UNIT()}` : ""} is in progress. The wallet still locks on time. The payment finishes with the key of only the coins it uses, kept in memory until it ends.</div></div>
  <div class="field"><p class="label" id="al2">Lock after no use for</p>${lockSeg("al2")}</div>
  <div class="card flat pad-sm"><div class="kv">
    ${last ? html`<div class="r"><span class="k">Last used</span><span class="v">${hm(last)}</span></div><div class="r"><span class="k">Would have locked</span><span class="v">${hm(last + prefs().lockMinutes * 60_000)}</span></div>` : ""}
    <div class="r"><span class="k">Now locks</span><span class="v">${prefs().lockMinutes} min after the payment ends</span></div></div></div>`
      : html`
  <div class="field"><p class="label" id="al">Lock after no use for</p>${lockSeg("al")}
    <p class="help">Counts from your last click or key press in PrivateBit. Waits while a payment link or Payjoin payment is in progress, then locks when it ends. Finding coins continues while locked, until you quit the browser or switch wallets.</p></div>
  <div class="list">${row("key-round", "Change password", "Re-encrypts your keys here", "set-password")}</div>
  <div class="card" data-st="65a660"><div class="stack"><p class="strong">Remove wallet from this computer</p><p class="small muted">Deletes the encrypted vault, activity, coin labels and settings from this computer. Only your recovery words can bring the coins back.</p></div><button class="btn btn-danger-outline btn-block" type="button" data-act="go" data-to="remove">Remove wallet</button></div>`,
  };
};

/* ---------- change password ---------- */
screens["set-password"] = () => ({
  title: "Change password",
  header: hdr({ title: "Change password" }),
  main: html`<div class="stack" data-enter="pw-change">
  <div class="field"><label class="label" for="cpw">Current password</label><input class="input" id="cpw" data-f="cpw" type="password" autocomplete="current-password" value="${fv("cpw")}"></div>
  <div class="field"><label class="label" for="npw">New password</label><input class="input" id="npw" data-f="npw" type="password" autocomplete="new-password" value="${fv("npw")}" aria-describedby="npw-h"><p class="help" id="npw-h">At least 12 characters. Longer is stronger than complex.</p></div>
  <div class="field"><label class="label" for="npw2">Repeat new password</label><input class="input" id="npw2" data-f="npw2" type="password" autocomplete="new-password" value="${fv("npw2")}"></div></div>
  ${errP("cpw")}`,
  foot: html`<button class="btn btn-primary btn-block" type="button" data-act="pw-change" ${busy("cpw") ? html`aria-disabled="true"` : ""}>${busy("cpw") ? html`${I("loader-circle", "s16 spin")}Re-encrypting…` : "Change password"}</button>`,
});
actions["pw-change"] = async () => {
  if ([...fv("npw")].length < 12) S.err.cpw = "Use at least 12 characters.";
  else if (fv("npw") !== fv("npw2")) S.err.cpw = "The new passwords do not match.";
  if (S.err.cpw) return render();
  const ok = await run(
    "cpw",
    async () => {
      await call({ type: "CHANGE_PASSWORD", current: fv("cpw"), next: fv("npw") });
      return true;
    },
    "cpw",
  );
  if (S.err.cpw && /wrong password/i.test(S.err.cpw)) S.err.cpw = "The current password is wrong.";
  if (ok) {
    for (const k of ["cpw", "npw", "npw2"]) delete S.f[k];
    toast("Password changed.");
    back("set-security");
  }
};

/* ---------- backup (60) ---------- */
loaders["set-backup"] = () => {
  S.d.backupWords = undefined;
  S.f.bpw = "";
};
screens["set-backup"] = () => {
  const st = S.b!.state;
  const w = S.d.backupWords as string[] | undefined;
  const kv = html`<div class="card flat pad-sm"><div class="kv"><div class="r"><span class="k">Words</span><span class="v">${st.mnemonicWords ?? "Unknown"}</span></div><div class="r"><span class="k">Extra passphrase</span><span class="v">${st.hasPassphrase ? "Set" : "Not set"}</span></div><div class="r"><span class="k">Keys path</span><span class="v mono">m/352'/8228'/0'</span></div><div class="r"><span class="k">One-time addresses</span><span class="v mono">m/86'/8228'/0'/0/i</span></div></div></div>`;
  if (w) {
    return {
      title: "Backup",
      header: hdr({ title: "Backup" }),
      main: html`<div class="stack"><h2 data-st="9d50d4">Your recovery words</h2><p class="muted">${w.length} words, in order. Anyone with these words can take your coins.</p></div>
  <ol class="seed" aria-label="Recovery words" ${w.length > 12 ? html`data-st="4ae8bf"` : ""}>${w.map((x, i) => html`<li><span class="ix">${i + 1}</span><span>${x}</span></li>`)}</ol>
  ${st.hasPassphrase ? html`<p class="small muted">Your extra passphrase is not shown. You need it too.</p>` : ""}${kv}`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="backup-hide">${I("eye-off", "s16")}Hide words</button>`,
    };
  }
  return {
    title: "Backup",
    header: hdr({ title: "Backup" }),
    main: html`
  <div class="stack"><h2 data-st="9d50d4">Show recovery words</h2><p class="muted">Enter your password. Make sure nobody can see your screen.</p></div>
  <div class="field" data-enter="backup-show"><label class="label" for="bpw">Password</label><input class="input" id="bpw" data-f="bpw" type="password" autocomplete="current-password" value="${fv("bpw")}" ${err("bpw") ? html`aria-invalid="true" aria-describedby="bpw-e"` : ""}>${err("bpw") ? html`<p class="err" id="bpw-e" role="alert">${I("circle-alert", "s16")}<span>${err("bpw")}</span></p>` : ""}</div>
  ${kv}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="backup-show">Show words</button>`,
  };
};
actions["backup-show"] = async () => {
  const r = await run("bpw", () => call<{ mnemonic: string }>({ type: "SHOW_WORDS", password: fv("bpw") }), "bpw");
  if (S.err.bpw && /wrong password/i.test(S.err.bpw)) S.err.bpw = "Wrong password.";
  if (!r) return render();
  S.f.bpw = "";
  S.d.backupWords = r.mnemonic.split(" ");
  render();
};
actions["backup-hide"] = () => {
  S.d.backupWords = undefined;
  render();
};

/* ---------- finding coins (61) ---------- */
loaders["set-scan"] = () => {
  S.f.bk = num(S.b!.state.birthday ?? defBirthday());
};
screens["set-scan"] = () => {
  const st = S.b!.state;
  const done = st.watching;
  return {
    title: "Finding coins",
    header: hdr({ title: "Finding coins" }),
    main: html`
  <div class="card flat pad-sm"><div class="kv"><div class="r"><span class="k">Looking from block</span><span class="v mono">${num(st.birthday ?? defBirthday())}</span></div><div class="r"><span class="k">Checked up to</span><span class="v mono">${num(st.lastHeight ?? 0)}</span></div><div class="r"><span class="k">Status</span><span class="v">${done ? html`<span class="badge ok">${I("circle-check")}Up to date</span>` : !st.tip ? html`<span class="badge">${I("clock")}${syncLine()}</span>` : html`<span class="badge">${I("refresh-cw")}Finding coins, ${num(st.tip - (st.lastHeight ?? 0))} blocks to go</span>`}</span></div></div></div>
  <div class="field" data-enter="rescan"><label class="label" for="bk">Look again from block</label><input class="input mono" id="bk" data-f="bk" inputmode="numeric" autocomplete="off" value="${fv("bk")}" aria-describedby="bk-h" ${err("bk") ? html`aria-invalid="true"` : ""}><p class="help" id="bk-h">Use this if a payment is missing. Earlier blocks take longer. The default start is block ${num(defBirthday())}.</p>${errP("bk")}</div>
  <button class="btn btn-ghost btn-sm" type="button" data-act="bk-default" data-st="c9adc4">Use block ${num(defBirthday())}</button>`,
    foot: html`<button class="btn btn-secondary btn-block" type="button" data-act="rescan" ${busy("bk") ? html`aria-disabled="true"` : ""}>${I("refresh-cw", "s16")}Look again from this block</button>`,
  };
};
actions["bk-default"] = () => {
  S.f.bk = num(defBirthday());
  render();
};
actions.rescan = async () => {
  const n = Number(fv("bk").replace(/[,\s]/g, ""));
  if (!Number.isInteger(n) || n < 1) {
    S.err.bk = "Enter a block number.";
    return render();
  }
  const ok = await run(
    "bk",
    async () => {
      S.b = await call({ type: "SET_BIRTHDAY", birthday: n });
      return true;
    },
    "bk",
  );
  if (ok) toast(`Looking again from block ${num(n)}.`);
};

/* ---------- remove wallet (two steps) ---------- */
loaders.remove = () => {
  S.f.rmStep = "1";
  S.f.rmpw = "";
  S.f.rmAck = false;
};
/** The wallet being removed: the one picked on the Wallets screen, else the open one. */
function rmTarget() {
  const list = S.b!.state.wallets ?? [];
  const id = typeof S.params.id === "string" ? S.params.id : undefined;
  return list.find((w) => w.id === id) ?? list.find((w) => w.active);
}
screens.remove = () => {
  const two = fv("rmStep") === "2";
  const list = S.b!.state.wallets ?? [];
  const many = list.length > 1;
  const t = rmTarget();
  const isOpen = !t || t.active;
  const name = t?.name ?? "this wallet";
  if (!two) {
    return {
      title: "Remove wallet",
      header: hdr({ title: "Remove wallet" }),
      main: html`
  <div class="state" data-st="aa619b"><div class="big danger">${I("trash-2")}</div><h1>${many ? `Remove ${name}?` : "Remove PrivateBit from this computer?"}</h1><p>${many ? `This deletes ${name} from this computer: its vault, activity, coin labels and payment links. The other wallets stay. Coins stay on the chain.` : "This deletes the encrypted vault, activity history, coin labels, payment links and settings stored here. Your coins stay on the chain."}</p></div>
  <div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">Only the recovery words of ${name} can bring its coins back</span>Check you have them on paper before you continue. Labels you typed cannot be recovered.</div></div>
  ${isOpen && S.b!.state.payjoin ? html`<div class="banner danger">${I("hourglass", "s16")}<div>A payment link or Payjoin payment is still waiting. Removing the wallet ends it.</div></div>` : ""}
  <div class="field" data-enter="rm-next"><label class="label" for="rmpw">${isOpen ? "Password" : `Password of ${name}`}</label><input class="input" id="rmpw" data-f="rmpw" type="password" autocomplete="current-password" value="${fv("rmpw")}" ${err("rm") ? html`aria-invalid="true" aria-describedby="rm-e"` : ""}>${err("rm") ? html`<p class="err" id="rm-e" role="alert">${I("circle-alert", "s16")}<span>${err("rm")}</span></p>` : ""}</div>`,
      foot: html`<button class="btn btn-danger-outline btn-block" type="button" data-act="rm-next">Continue</button><button class="btn btn-ghost btn-block" type="button" data-act="back">Keep my wallet</button>`,
    };
  }
  const ack = S.f.rmAck === true;
  return {
    title: "Remove wallet",
    header: hdr({ title: "Remove wallet" }),
    main: html`
  <div class="state" data-st="aa619b"><div class="big danger">${I("triangle-alert")}</div><h1>Last check</h1><p>${!many ? "After this, PrivateBit on this computer starts empty. There is no undo." : isOpen ? `After this, ${name} is gone from this computer. The others stay, locked, until you unlock one.` : `After this, ${name} is gone from this computer. ${list.find((w) => w.active)?.name ?? "The open wallet"} stays open.`}</p></div>
  <div class="card pad-sm"><label class="check"><input type="checkbox" data-f="rmAck" ${ack ? html`checked` : ""}> <span>I have the ${t?.words ? `${t.words} recovery words` : "recovery words"}${t?.hasPassphrase ? " and the extra passphrase" : ""} of ${name} written down</span></label></div>
  ${errP("rm")}`,
    foot: html`<button class="btn btn-danger btn-block" type="button" data-act="rm-final" ${ack && !busy("rm") ? "" : html`aria-disabled="true" disabled`}>${busy("rm") ? html`${I("loader-circle", "s16 spin")}Removing…` : "Remove wallet from this computer"}</button><button class="btn btn-ghost btn-block" type="button" data-act="back">Keep my wallet</button>`,
  };
};
actions["rm-next"] = async () => {
  const pw = fv("rmpw");
  if (!pw) {
    S.err.rm = "Enter your password.";
    return render();
  }
  const ok = await run(
    "rm",
    async () => {
      const t = rmTarget();
      if (t && !t.active) await call({ type: "CHECK_WALLET_PASSWORD", id: t.id, password: pw });
      else await call({ type: "SHOW_WORDS", password: pw });
      return true;
    },
    "rm",
  );
  if (S.err.rm && /wrong password/i.test(S.err.rm)) S.err.rm = "Wrong password.";
  if (!ok) return render();
  S.f.rmStep = "2";
  render();
};
actions["rm-final"] = async () => {
  const t = rmTarget();
  const r = await run("rm", () => call<{ left: number; removedOpen?: boolean }>({ type: "REMOVE_WALLET", password: fv("rmpw"), id: t?.id }), "rm");
  if (!r) return;
  if (r.removedOpen === false) {
    S.f = {};
    await refresh();
    toast(`${t?.name ?? "Wallet"} removed from this computer.`);
    go("wallets", {}, { reset: true });
    return;
  }
  S.f = {};
  S.d = {};
  await refresh();
  go(S.b?.state.hasVault ? "unlock" : "welcome", {}, { reset: true });
};

/* ---------- full page settings (F2) ---------- */
function fullSettings(): Safe {
  if (S.f.src === undefined || S.f.fsNet !== S.b!.state.net) {
    S.f.fsNet = S.b!.state.net;
    loaders["set-sending"]!();
    S.f.src = chain().kind === "core" ? "core" : "service";
    S.f.tok = chain().unisatToken ?? "";
    S.f.mb = chain().payjoinDirectory ?? DEFAULT_PAYJOIN_DIRECTORY;
    S.f.rl = chain().ohttpRelay ?? DEFAULT_OHTTP_RELAY;
  }
  const pr = prefs();
  return html`<div class="topbar"><h1>Settings</h1><span class="cap">Changes save when you select Save in each section</span></div>
  <div class="settings-grid"><nav class="subnav" data-clip aria-label="Settings sections"><a href="#wallets">Wallets</a><a href="#net">Network and data</a><a href="#ap">Appearance</a><a href="#send">Sending</a><a href="#price">USD price</a><a href="#priv">Privacy</a><a href="#pj">Payment links</a><a href="#sec">Security</a><a href="#bk">Backup and coins</a><a href="#sites">Connected sites</a></nav>
  <div class="stack" data-st="ea6e03">
    <section class="sect" id="wallets"><header><h2>Wallets</h2><p>Open now: <strong>${(S.b!.state.wallets ?? []).find((w) => w.active)?.name ?? "Wallet"}</strong>. Several wallets can sit on this computer, one open at a time, each with its own password. Rename, add, import or remove them in one place.</p></header>
      <div class="row" data-st="62da06"><button class="btn btn-secondary" type="button" data-act="go" data-to="wallets">${I("wallet", "s16")}Manage wallets</button></div></section>
    <section class="sect" id="net"><header><h2>Network and data source</h2><p>Blocks are downloaded from the source below. PrivateBit matches them to your keys on this computer.</p></header>
      ${networkForm()}
      <div class="row"><button class="btn btn-primary" type="button" data-act="net-save">Save</button></div></section>
    <section class="sect" id="ap"><header><h2>Appearance</h2><p>Dark is the default. Your choice stays on this computer.</p></header>
      <div class="field" data-st="0fd874"><p class="label" id="apf">Theme</p>${themeSeg("apf")}</div>
</section>
    <section class="sect" id="send"><header><h2>Sending</h2><p>How and when your payments reach the ${CHAIN()} network.</p></header><div class="stack" data-st="765d57">${(screens["set-sending"]!() as { main: Safe }).main}</div></section>
    <section class="sect" id="price"><header><h2>USD price</h2><p>Only the price of ${UNIT()} is asked for. Your coins never leave this computer.</p></header><div class="stack" data-st="765d57">${priceForm()}</div></section>
    <section class="sect" id="priv"><header><h2>Privacy</h2><p>Each switch says who would learn something.</p></header>${privacyList()}</section>
    <section class="sect" id="pj"><header><h2>Payment links</h2><p>Two servers carry payment link messages. Each one sees only what is listed under it.</p></header>
      ${payjoinForm()}
      <div class="row"><button class="btn btn-secondary" type="button" data-act="pj-test" ${busy("pjt") ? html`aria-disabled="true"` : ""}>${busy("pjt") ? "Testing, up to 40 s…" : "Test"}</button><button class="btn btn-primary" type="button" data-act="pj-save">Save</button></div></section>
    <section class="sect" id="sec"><header><h2>Security</h2><p>Lock closes the wallet on time. An open Payjoin finishes with only the keys of its own coins.</p></header>
      <div class="field"><span class="label" id="alf">Lock after no use for</span><div data-st="0fd874">${lockSeg("alf")}</div><p class="help">Payment links and Payjoin payments keep going after Lock.</p></div>
      <div class="row" data-st="62da06"><button class="btn btn-secondary" type="button" data-act="go" data-to="set-password">Change password</button><button class="btn btn-danger-outline" type="button" data-act="go" data-to="remove">Remove ${(S.b!.state.wallets ?? []).find((w) => w.active)?.name ?? "wallet"}</button></div></section>
    <section class="sect" id="bk"><header><h2>Backup and finding coins</h2><p>Your recovery words restore everything except the labels you typed.</p></header>
      <div class="row" data-st="62da06"><button class="btn btn-secondary" type="button" data-act="go" data-to="set-backup">${I("file-key", "s16")}Show recovery words</button><button class="btn btn-secondary" type="button" data-act="go" data-to="set-scan">${I("scan-line", "s16")}Look again from a block</button><button class="btn btn-secondary" type="button" data-act="go" data-to="migrate">${I("arrow-right-left", "s16")}Move coins from another wallet</button></div>
      ${aboutBlock()}</section>
    <section class="sect" id="sites"><header><h2>Connected sites</h2><p>Websites you approved. Each has its own account on each chain.</p></header>
      <div class="stack" data-st="765d57">${sitesIntro()}${sitesList()}${findSiteForm()}</div></section>
  </div></div>`;
}
