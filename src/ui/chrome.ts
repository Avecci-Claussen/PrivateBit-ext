import { S, type View, type Foot } from "./app.ts";
import { html, I, MARK, NETLOGO, raw, fbShort, type Safe } from "./kit.ts";
import { status } from "./derive.ts";

export function netChip(): Safe {
  return html`<button class="net" type="button" data-act="sheet" data-sheet="network" aria-haspopup="dialog" aria-label="Network: Fractal Bitcoin. Change network">${NETLOGO("fractal")}Fractal${I("chevron-down", "s16")}</button>`;
}

const PSTAT: Record<string, [string, string, string]> = {
  private: ["shield-check", "Private", ""],
  payjoin: ["hourglass", "Payjoin waiting", "warn"],
  scan: ["refresh-cw", "Scanning", "busy"],
  offline: ["unplug", "Offline", "busy"],
  limited: ["unplug", "Limited", "busy"],
};
export function pstat(kind = status()): Safe {
  const m = PSTAT[kind] ?? PSTAT.private!;
  return html`<button class="pstat ${m[2]}" type="button" data-act="sheet" data-sheet="privacy" aria-haspopup="dialog" aria-label="Privacy status: ${m[1]}. Show details">${I(m[0], "s16")}${m[1]}</button>`;
}

export function hdr(o: { title?: string; back?: boolean; net?: boolean; right?: Safe; close?: boolean } = {}): Safe {
  if (o.title !== undefined) {
    return html`<header class="hdr">${o.back !== false ? html`<button class="icon-btn back" type="button" data-act="back" aria-label="Back">${I("arrow-left")}</button>` : ""}<h1 class="hdr-title">${o.title}</h1>${o.net ? netChip() : ""}${o.right ?? ""}${o.close ? html`<button class="icon-btn" type="button" data-act="home" aria-label="Close">${I("x")}</button>` : ""}</header>`;
  }
  return html`<header class="hdr">${MARK(24)}${netChip()}<span class="spacer"></span>${pstat()}<button class="icon-btn" type="button" data-act="lock" aria-label="Lock wallet">${I("lock")}</button></header>`;
}

export function tabs(active: string): Safe {
  const t: [string, string, string][] = [
    ["home", "wallet", "Wallet"],
    ["activity", "history", "Activity"],
    ["coins", "coins", "Coins"],
    ["settings", "settings", "Settings"],
  ];
  return html`<nav class="tabs" aria-label="Main">${t.map(([k, ic, l]) => html`<a class="tab" href="#" data-act="tab" data-to="${k}" ${k === active ? raw('aria-current="page"') : ""}>${I(ic)}${l}</a>`)}</nav>`;
}

function footHtml(f?: Foot): string {
  if (!f) return "";
  if ("cls" in f) return `<div class="foot ${f.cls}">${f.html.s}</div>`;
  return `<div class="foot">${f.s}</div>`;
}

function overlayFor(v: View): string {
  const parts: string[] = [];
  if (v.overlay) parts.push(v.overlay.s);
  const sh = S.sheet ? sheets[S.sheet]?.() : undefined;
  if (sh) parts.push(sh.s);
  return parts.join("");
}

function toastHtml(): string {
  return S.toast ? html`<div class="toast" role="status">${I("check", "s16")}${S.toast}</div>`.s : "";
}

export function popupHtml(v: View): string {
  const main = `<main class="main ${v.mainCls ?? ""}" id="main" tabindex="0" aria-label="Content">${v.main.s}</main>`;
  const bottom = v.foot ? footHtml(v.foot) : (v.nav?.s ?? "");
  const bg = `${v.header?.s ?? ""}${main}${bottom}`;
  const ov = overlayFor(v);
  return `<div class="popup ${v.header ? "" : "nohdr"}">${ov ? `<div class="bgwrap" inert>${bg}</div>${ov}` : bg}${toastHtml()}</div>`;
}

/* ---------- full page ---------- */

const NAV: [string, string, string][] = [
  ["home", "wallet", "Overview"],
  ["send", "arrow-up-right", "Send"],
  ["receive", "arrow-down-left", "Receive"],
  ["activity", "history", "Activity"],
  ["coins", "coins", "Coins"],
  ["paylink", "link-2", "Payment links"],
];
const SECTION: Record<string, string> = {
  home: "home", send: "send", "send-coins": "send", "send-fee": "send", review: "send", sending: "send", sent: "send",
  "pj-waiting": "send", "pj-failed": "send", "send-failed": "send", receive: "receive", paylink: "paylink",
  activity: "activity", "activity-detail": "activity", coins: "coins", "coin-detail": "coins", "coin-split": "coins", "coin-split-review": "coins", "coin-split-done": "coins", migrate: "home", wallets: "settings",
};

function sideNav(): Safe {
  const cur = SECTION[S.route] ?? (S.route.startsWith("set") || S.route === "remove" ? "settings" : "");
  return html`<nav aria-label="Main"><p class="grp">Wallet</p>${NAV.map(([k, i, l]) => html`<a href="#" data-act="tab" data-to="${k}" ${k === cur ? raw('aria-current="page"') : ""}>${I(i)}${l}</a>`)}
  <p class="grp" style="margin-top:16px">Wallet settings</p><a href="#" data-act="tab" data-to="settings" ${cur === "settings" ? raw('aria-current="page"') : ""}>${I("settings")}Settings</a></nav>`;
}

export function fullHtml(v: View): string {
  if (v.solo) {
    return `<div class="solo"><div class="pb-expand">${popupHtml({ ...v, nav: undefined })}</div></div>`;
  }
  const inner = v.page
    ? v.page.s
    : html`<div class="topbar"><h1>${v.title}</h1></div><section class="panel flowpanel">${v.main}${v.foot ? raw(footHtml(v.foot).replace('class="foot', 'class="foot inpanel')) : ""}</section>`.s;
  const side = html`<aside class="side"><div class="brandrow">${MARK(28, false)}<span class="wordmark">PrivateBit</span></div>
  <div>${netChip()}</div>${sideNav()}
  <div class="foot-s">${pstat()}<button class="btn btn-secondary btn-sm" type="button" data-act="lock">${I("lock", "s16")}Lock</button></div></aside>`;
  const mbar = html`<div class="mobilebar">${MARK(24, false)}${netChip()}<span class="spacer"></span>${pstat()}<button class="icon-btn" type="button" data-act="sheet" data-sheet="menu" aria-label="Open menu" aria-haspopup="dialog">${I("menu")}</button></div>`;
  const ov = overlayFor(v);
  const app = `<div class="app">${side.s}<div style="min-width:0">${mbar.s}<main class="content" id="main">${inner}</main></div></div>`;
  return `${ov ? `<div inert>${app}</div><div class="fp-overlay">${ov}</div>` : app}${toastHtml() ? `<div class="fp-toast">${toastHtml()}</div>` : ""}`;
}

/* ---------- sheets ---------- */

function sheet(id: string, title: string, body: Safe): Safe {
  return html`<div class="scrim" data-act="sheet-close" aria-hidden="true"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="${id}"><span class="grab" aria-hidden="true"></span>
  <div class="sheet-h"><h2 id="${id}">${title}</h2><button class="icon-btn" type="button" data-act="sheet-close" aria-label="Close">${I("x")}</button></div>${body}</div>`;
}

export const sheets: Record<string, () => Safe> = {
  network: () => {
    const st = S.b?.state;
    const bal = st?.unlocked ? `${fbShort(st.balance ?? "0")}. ` : "";
    return sheet(
      "ns-h",
      "Network",
      html`<div class="opt-list" role="radiogroup" aria-labelledby="ns-h">
    <button class="opt" role="radio" aria-checked="true" type="button" data-act="sheet-close">${NETLOGO("fractal", "lg")}<span class="body"><span class="t">Fractal Bitcoin</span><span class="d">${bal}Blocks every 30 seconds.</span></span>${I("check")}</button>
    <button class="opt" role="radio" aria-checked="false" aria-disabled="true" type="button">${NETLOGO("btc", "lg")}<span class="body"><span class="t">Bitcoin</span><span class="d">Not available in this version.</span></span><span class="plan">Unavailable</span></button>
  </div>`,
    );
  },
  privacy: () => {
    const h = S.b?.health;
    const own = S.b?.state.chain.kind === "core";
    const down = h && h.state !== "ok";
    const usdOn = S.b?.prefs.usd !== false;
    return sheet(
      "ps-h",
      "Who can see what",
      html`<div class="list">
    <div class="li" style="cursor:default"><span class="ico ${own ? "in" : "warn"}">${I("scan-line")}</span><span class="body"><span class="t">Finding your coins</span><span class="d" style="white-space:normal">${own ? "Your node sends the blocks. Matching them to your keys happens here." : "mempool.fractalbitcoin.io sends the blocks and sees your IP. Blocks saved on this computer are reused for every wallet. Matching them to your keys happens here. It is not given your receive code."}</span></span>${own ? I("circle-check", "s16") : html`<span class="badge warn">Shared</span>`}</div>
    <div class="li" style="cursor:default"><span class="ico ${down ? "danger" : own ? "in" : "warn"}">${I("server")}</span><span class="body"><span class="t" style="white-space:normal">${own ? "Blocks and fees: your own node" : "Blocks and fees: block data service"}</span><span class="d" style="white-space:normal">${own ? "Only your node sees which blocks you read and what you broadcast." : "Sees your IP, that you read every block and ask for fee rates, and the payments you send."}</span></span>${down ? html`<span class="badge danger">${h!.state === "rate-limited" ? "Limited" : "Offline"}</span>` : own ? I("circle-check", "s16") : html`<span class="badge warn">Shared</span>`}</div>
    <div class="li" style="cursor:default"><span class="ico in">${I("route")}</span><span class="body"><span class="t">Payment links: ${mailboxHost()}</span><span class="d" style="white-space:normal">Stores an encrypted blob it cannot read, reached through a relay that hides your IP.</span></span>${I("circle-check", "s16")}</div>
    <div class="li" style="cursor:default"><span class="ico ${usdOn ? "warn" : "in"}">${I("circle-dollar-sign")}</span><span class="body"><span class="t">USD price: ${usdOn ? "price service" : "off"}</span><span class="d" style="white-space:normal">${usdOn ? "Sees your IP and that someone asked for the FB price. Never your coins or codes." : "No price requests are made."}</span></span>${usdOn ? html`<span class="badge warn">Shared</span>` : I("circle-check", "s16")}</div>
    <div class="li" style="cursor:default"><span class="ico in">${I("history")}</span><span class="body"><span class="t">Activity history</span><span class="d" style="white-space:normal">Encrypted on this computer. Never synced to your Google account.</span></span>${I("circle-check", "s16")}</div>
  </div>
  ${own ? "" : html`<button class="btn btn-secondary btn-block" type="button" data-act="go" data-to="set-node">Use my own node</button>`}`,
    );
  },
  menu: () =>
    sheet(
      "mn-h",
      "Menu",
      html`<div class="list">${NAV.map(([k, i, l]) => html`<a class="li" href="#" data-act="tab" data-to="${k}"><span class="ico">${I(i)}</span><span class="body"><span class="t">${l}</span></span></a>`)}<a class="li" href="#" data-act="tab" data-to="settings"><span class="ico">${I("settings")}</span><span class="body"><span class="t">Settings</span></span></a><button class="li" type="button" data-act="lock"><span class="ico">${I("lock")}</span><span class="body"><span class="t">Lock</span></span></button></div>`,
    ),
  lockwarn: () => {
    const p = S.b?.state.payjoin;
    const amt = p?.amount && p.amount !== "0" ? `for ${fbShort(p.amount)} ` : "";
    const what = p?.role === "send" ? `A Payjoin payment ${amt}is still waiting.` : `A payment link ${amt}is still waiting.`;
    return html`<div class="scrim" aria-hidden="true"></div><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="lw-h" aria-describedby="lw-d">
  <span class="ico warn">${I("triangle-alert")}</span><h2 id="lw-h">Lock and cancel the payment?</h2>
  <p id="lw-d" class="small muted">${what} Locking deletes its keys, so it can never finish. Closing the window is safe.</p>
  <div class="stack"><button class="btn btn-primary btn-block" type="button" data-act="sheet-close">Keep unlocked</button><button class="btn btn-danger-outline btn-block" type="button" data-act="lock-force">Lock and cancel payment</button></div></div>`;
  },
};

export function mailboxHost(): string {
  try {
    return new URL(S.b?.state.chain.payjoinDirectory ?? "https://payjo.in").host;
  } catch {
    return "mailbox";
  }
}
