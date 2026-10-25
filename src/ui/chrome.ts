import { S, type View, type Foot } from "./app.ts";
import { html, I, UNIT, explorerHost, MARK, NETLOGO, raw, fbShort, CHAIN, CHAIN_SHORT, curNet, type Safe } from "./kit.ts";
import { status } from "./derive.ts";

/** The chain on screen. Opens the chain picker. */
export function netChip(compact = false): Safe {
  return html`<button class="net ${compact ? "compact" : ""}" type="button" data-act="sheet" data-sheet="network" aria-haspopup="dialog" aria-label="Network: ${CHAIN()}. Change network">${NETLOGO()}${compact ? "" : html`<span class="lbl">${CHAIN_SHORT()}</span>`}${I("chevron-down", "s16")}</button>`;
}

type WalletRow = NonNullable<NonNullable<typeof S.b>["state"]["wallets"]>[number];
export function openWallet(): WalletRow | undefined {
  return S.b?.state.wallets?.find((w) => w.active);
}
/** Name of the open wallet, shown wherever you could act on the wrong one. */
export function walletName(): string {
  return openWallet()?.name ?? "Wallet";
}
/** Header switcher: the open wallet's name; opens the wallet list. */
export function walletChip(): Safe {
  const n = walletName();
  return html`<button class="wchip" type="button" data-act="sheet" data-sheet="wallets" aria-haspopup="dialog" aria-label="Open wallet: ${n}. Switch wallet">${I("wallet", "s16")}<span class="wname">${n}</span>${I("chevron-down", "s16")}</button>`;
}
/** Full page sidebar switcher: name and how many wallets sit on this computer. */
function walletSwitch(): Safe {
  const n = walletName();
  const count = S.b?.state.wallets?.length ?? 1;
  return html`<button class="wswitch" type="button" data-act="sheet" data-sheet="wallets" aria-haspopup="dialog" aria-label="Open wallet: ${n}. Switch wallet"><span class="ico">${I("wallet", "s16")}</span><span class="body"><span class="t">${n}</span><span class="d">${count === 1 ? "1 wallet on this computer" : `${count} wallets on this computer`}</span></span>${I("chevrons-up-down", "s16")}</button>`;
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
  return html`<button class="pstat ${m[2]}" type="button" data-act="sheet" data-sheet="privacy" aria-haspopup="dialog" aria-label="Privacy status: ${m[1]}. Show details">${I(m[0], "s16")}<span class="lbl">${m[1]}</span></button>`;
}

export function hdr(o: { title?: string; back?: boolean; net?: boolean; right?: Safe; close?: boolean } = {}): Safe {
  if (o.title !== undefined) {
    return html`<header class="hdr">${o.back !== false ? html`<button class="icon-btn back" type="button" data-act="back" aria-label="Back">${I("arrow-left")}</button>` : ""}<h1 class="hdr-title">${o.title}</h1>${o.net ? netChip() : ""}${o.right ?? ""}${o.close ? html`<button class="icon-btn" type="button" data-act="home" aria-label="Close">${I("x")}</button>` : ""}</header>`;
  }
  return html`<header class="hdr">${MARK(24)}${walletChip()}${netChip(true)}<span class="spacer"></span>${pstat()}<button class="icon-btn" type="button" data-act="lock" aria-label="Lock wallet">${I("lock")}</button></header>`;
}

export function tabs(active: string): Safe {
  const t: [string, string, string][] = [
    ["home", "wallet", "Wallet"],
    ["activity", "history", "Activity"],
    ["coins", "coins", "Coins"],
    ["settings", "settings", "Settings"],
  ];
  return html`<nav class="tabs" aria-label="Main">${t.map(([k, ic, l]) => html`<a class="tab" href="#" data-act="tab" data-to="${k}" ${k === active ? raw('aria-current="page"') : ""}>${I(ic)}<span class="tl">${l}</span></a>`)}</nav>`;
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
  <p class="grp" data-st="1b0f49">Wallet settings</p><a href="#" data-act="tab" data-to="settings" ${cur === "settings" ? raw('aria-current="page"') : ""}>${I("settings")}Settings</a></nav>`;
}

export function fullHtml(v: View): string {
  if (v.solo) {
    return `<div class="solo"><div class="pb-expand">${popupHtml({ ...v, nav: undefined })}</div></div>`;
  }
  const inner = v.page
    ? v.page.s
    : html`<div class="topbar"><h1>${v.title}</h1></div><section class="panel flowpanel">${v.main}${v.foot ? raw(footHtml(v.foot).replace('class="foot', 'class="foot inpanel')) : ""}</section>`.s;
  const side = html`<aside class="side"><div class="brandrow">${MARK(28, false)}<span class="wordmark">PrivateBit</span></div>
  ${walletSwitch()}<div>${netChip()}</div>${sideNav()}
  <div class="foot-s">${pstat()}<button class="btn btn-secondary btn-sm" type="button" data-act="lock">${I("lock", "s16")}Lock</button></div></aside>`;
  const mbar = html`<div class="mobilebar">${MARK(24, false)}${walletChip()}${netChip(true)}<span class="spacer"></span>${pstat()}<button class="icon-btn" type="button" data-act="sheet" data-sheet="menu" aria-label="Open menu" aria-haspopup="dialog">${I("menu")}</button></div>`;
  const ov = overlayFor(v);
  const app = `<div class="app">${side.s}<div data-st="3922d3">${mbar.s}<main class="content${v.page ? "" : " flow"}" id="main">${inner}</main></div></div>`;
  return `${ov ? `<div inert>${app}</div><div class="fp-overlay">${ov}</div>` : app}${toastHtml() ? `<div class="fp-toast">${toastHtml()}</div>` : ""}`;
}

/* ---------- sheets ---------- */

function sheet(id: string, title: string, body: Safe): Safe {
  return html`<div class="scrim" data-act="sheet-close" aria-hidden="true"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="${id}"><span class="grab" aria-hidden="true"></span>
  <div class="sheet-h"><h2 id="${id}">${title}</h2><button class="icon-btn" type="button" data-act="sheet-close" aria-label="Close">${I("x")}</button></div>${body}</div>`;
}

function netOption(id: "fractal" | "bitcoin", name: string, d: string): Safe {
  const on = curNet() === id;
  return html`<button class="li" type="button" role="radio" aria-checked="${String(on)}" data-act="net-set" data-v="${id}"><span class="ico">${NETLOGO(id === "bitcoin" ? "btc" : "fractal")}</span><span class="body"><span class="t">${name}</span><span class="d" data-st="f8f979">${d}</span></span>${on ? I("check") : ""}</button>`;
}

export const sheets: Record<string, () => Safe> = {
  network: () =>
    sheet(
      "nw-h",
      "Network",
      html`<div class="list" role="radiogroup" aria-labelledby="nw-h">${netOption("fractal", "Fractal Bitcoin", "Unit FB. A block about every 30 seconds.")}${netOption("bitcoin", "Bitcoin", "Unit BTC. A block about every 10 minutes.")}</div>
  <p class="small muted">The same words give a different receive code on each network. Coins, activity and settings are kept apart, and the wallet stays unlocked when you switch. A payment waiting to be sent goes out first.</p>`,
    ),
  wallets: () => {
    const list = S.b?.state.wallets ?? [];
    return sheet(
      "ws-h",
      "Wallets",
      html`<ul class="list wlist" aria-labelledby="ws-h">${list.map((w) => html`<li><button class="li" type="button" data-act="wallet-switch" data-id="${w.id}" ${w.active ? raw('aria-current="true"') : ""}><span class="ico">${I("wallet")}</span><span class="body"><span class="t">${w.name}</span><span class="d">${w.active ? "Open now" : "Switch and unlock"}</span></span>${w.active ? I("check", "s16") : I("chevron-right", "s16 chev")}</button></li>`)}</ul>
  <button class="btn btn-secondary btn-block" type="button" data-act="go" data-to="wallets">${I("settings", "s16")}Manage wallets</button>`,
    );
  },
  switchwarn: () => {
    const p = S.b?.state.payjoin;
    const to = (S.b?.state.wallets ?? []).find((w) => w.id === S.f.switchTo)?.name ?? "the other wallet";
    const what = p?.role === "send" ? "A Payjoin payment is still waiting." : "A payment link is still open.";
    return html`<div class="scrim" aria-hidden="true"></div><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="sw-h" aria-describedby="sw-d">
  <span class="ico warn">${I("triangle-alert")}</span><h2 id="sw-h">Switch to ${to} and end the payment?</h2>
  <p id="sw-d" class="small muted">${what} Switching ends it and deletes its keys, so it cannot finish. ${walletName()} locks. Nothing is broadcast.</p>
  <div class="stack"><button class="btn btn-primary btn-block" type="button" data-act="sheet-close">Stay in ${walletName()}</button><button class="btn btn-danger-outline btn-block" type="button" data-act="wallet-switch-force">Switch and end payment</button></div></div>`;
  },
  privacy: () => {
    const h = S.b?.health;
    const own = S.b?.state.chain.kind === "core";
    const down = h && (h.state === "offline" || h.state === "rate-limited");
    const usdOn = S.b?.prefs.usd !== false;
    return sheet(
      "ps-h",
      "Who can see what",
      html`<div class="list">
    <div class="li" data-st="2a9295"><span class="ico ${own ? "in" : "warn"}">${I("scan-line")}</span><span class="body"><span class="t">Finding your coins</span><span class="d" data-st="f8f979">${own ? "Your node sends the blocks. Matching them to your keys happens here." : `${explorerHost()} sends the blocks and sees your IP. Blocks saved on this computer are reused for every wallet. Matching them to your keys happens here. It is not given your receive code.`}</span></span>${own ? I("circle-check", "s16") : html`<span class="badge warn">Shared</span>`}</div>
    <div class="li" data-st="2a9295"><span class="ico ${down ? "danger" : own ? "in" : "warn"}">${I("server")}</span><span class="body"><span class="t" data-st="f8f979">${own ? "Blocks and fees: your own node" : "Blocks and fees: block data service"}</span><span class="d" data-st="f8f979">${own ? "Only your node sees which blocks you read and what you broadcast." : "Sees your IP, that you read every block and ask for fee rates, and the payments you send."}</span></span>${down ? html`<span class="badge danger">${h!.state === "rate-limited" ? "Limited" : "Offline"}</span>` : own ? I("circle-check", "s16") : html`<span class="badge warn">Shared</span>`}</div>
    <div class="li" data-st="2a9295"><span class="ico in">${I("route")}</span><span class="body"><span class="t">Payment links: ${mailboxHost()}</span><span class="d" data-st="f8f979">Stores an encrypted blob it cannot read, reached through a relay that hides your IP.</span></span>${I("circle-check", "s16")}</div>
    <div class="li" data-st="2a9295"><span class="ico ${usdOn ? "warn" : "in"}">${I("circle-dollar-sign")}</span><span class="body"><span class="t">USD price: ${usdOn ? "price service" : "off"}</span><span class="d" data-st="f8f979">${usdOn ? `Sees your IP and that someone asked for the ${UNIT()} price. Never your coins or codes.` : "No price requests are made."}</span></span>${usdOn ? html`<span class="badge warn">Shared</span>` : I("circle-check", "s16")}</div>
    <div class="li" data-st="2a9295"><span class="ico in">${I("history")}</span><span class="body"><span class="t">Activity history</span><span class="d" data-st="f8f979">Encrypted on this computer. Never synced to your Google account.</span></span>${I("circle-check", "s16")}</div>
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
