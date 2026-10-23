import { S, screens, actions, loaders, go, render, refresh, run, toast } from "../app.ts";
import { call, type HistoryEntry, type SessionView } from "../api.ts";
import { html, I, NETLOGO, fbShort, num, hm, when, dayLabel, left, type Safe } from "../kit.ts";
import { hdr, tabs } from "../chrome.ts";
import { scanning, health, price, usd, hidden } from "../derive.ts";

export async function loadHistory(): Promise<void> {
  S.d.history = await call({ type: "HISTORY" });
}
export const hist = (): { entries: HistoryEntry[]; rebuilding: boolean } =>
  (S.d.history as { entries: HistoryEntry[]; rebuilding: boolean } | undefined) ?? { entries: [], rebuilding: false };

export function entryMeta(e: HistoryEntry): { ic: string; cls: string; t: string; badge: Safe | string } {
  const lbl = e.label;
  let r: { ic: string; cls: string; t: string; badge: Safe | string };
  switch (e.kind) {
    case "payjoin-received":
      r = { ic: "route", cls: "in", t: "Payjoin received", badge: html`<span class="badge ok">Payjoin</span>` };
      break;
    case "payjoin-sent":
      r = { ic: "route", cls: "", t: lbl ? `Payjoin to ${lbl}` : "Payjoin sent", badge: html`<span class="badge ok">Payjoin</span>` };
      break;
    case "sent":
      r = { ic: "arrow-up-right", cls: "", t: lbl ? `Sent to ${lbl}` : "Sent", badge: "" };
      break;
    case "moved-in":
      r = { ic: "arrow-right-left", cls: "fr", t: "Moved from old wallet", badge: html`<span class="badge warn">Linked</span>` };
      break;
    case "self":
      r = { ic: "arrow-right-left", cls: "", t: "Moved into your receive code", badge: e.linked ? html`<span class="badge warn">Linked</span>` : "" };
      break;
    default:
      r = { ic: "arrow-down-left", cls: "in", t: lbl ? `Received from ${lbl}` : "Received", badge: e.linked ? html`<span class="badge warn">Linked</span>` : "" };
  }
  if (e.status === "incoming") r.badge = html`<span class="badge">${I("clock")}Incoming</span>`;
  else if (e.status === "pending") r.badge = html`<span class="badge">${I("clock")}Pending</span>`;
  else if (e.status === "failed") r.badge = html`<span class="badge danger">${I("circle-x")}Failed</span>`;
  return r;
}

export function entryTime(e: HistoryEntry, withDay = true): string {
  const ms = e.time * 1000;
  const t = withDay ? when(ms) : hm(ms);
  return e.approxTime ? `About ${t}` : t;
}

export function actRow(e: HistoryEntry, withDay = true): Safe {
  const m = entryMeta(e);
  const amt = BigInt(e.amount);
  const inn = amt > 0n;
  const hide = hidden();
  return html`<a class="li" href="#" data-act="go" data-to="activity-detail" data-id="${e.txid}"><span class="ico ${m.cls}">${I(m.ic)}</span><span class="body"><span class="t">${m.t}</span><span class="d">${entryTime(e, withDay)}</span></span><span class="end">${hide ? html`<span class="amt" aria-label="Amount hidden">\u2022\u2022\u2022\u2022 FB</span>` : html`<span class="amt ${inn ? "in" : ""}">${fbShort(amt, { sign: true })}</span>${m.badge}`}</span></a>`;
}

export function balanceSec(): Safe {
  const st = S.b!.state;
  const hide = hidden();
  const conf = BigInt(st.confirmed ?? "0");
  const pend = BigInt(st.pending ?? "0");
  const p = price();
  const sc = scanning();
  const fiat = hide
    ? ""
    : p.kind === "off"
      ? ""
      : p.kind === "na"
        ? html`<p class="fiat">USD price unavailable</p>`
        : p.kind === "stale"
          ? html`<p class="fiat stale">${usd(conf)} <span class="muted">price from ${hm(p.at!)}, not updated</span></p>`
          : html`<p class="fiat">${usd(conf)}</p>`;
  const h = health();
  const blockLine = sc.on
    ? html`<span>Finding coins, block ${num(st.lastHeight ?? 0)}</span>`
    : h !== "ok"
      ? html`<span>Last checked block ${num(st.lastHeight ?? 0)}</span>`
      : html`<span>Up to date, block ${num(st.lastHeight ?? 0)}</span>`;
  return html`<section class="bal" aria-label="Balance">
  <div class="bal-top"><h2 class="cap row" style="gap:6px">${NETLOGO("fractal")}${sc.on ? "Balance so far" : "Fractal Bitcoin"}</h2><button class="icon-btn" type="button" data-act="hide-bal" aria-pressed="${String(hide)}" aria-label="${hide ? "Show balance" : "Hide balance"}">${I(hide ? "eye-off" : "eye")}</button></div>
  <p class="bal-amt ${hide ? "hidden" : ""}">${hide ? "\u2022\u2022\u2022\u2022\u2022\u2022" : fbShort(conf, { unit: false })}<span class="unit">FB</span></p>
  ${fiat}
  <p class="bal-sub">${hide ? html`<span>Hidden. Use the eye button to show it.</span>` : html`${pend > 0n ? html`<span>${I("clock", "s16")} ${fbShort(pend)} incoming</span>` : ""}${blockLine}`}</p></section>`;
}
actions["hide-bal"] = () => {
  S.f.hideBal = !hidden();
  render();
};

export function actionsRow(): Safe {
  const off = health() === "offline";
  return html`<div class="actions weighted"><button class="action primary" type="button" data-act="go" data-to="send" ${off ? html`aria-disabled="true" style="opacity:.5"` : ""}>${I("arrow-up-right")}Send</button><button class="action" type="button" data-act="go" data-to="receive">${I("arrow-down-left")}Receive</button><button class="action" type="button" data-act="go" data-to="paylink">${I("link-2")}Payment link</button></div>`;
}

export function healthBanner(): Safe | string {
  const h = health();
  const b = S.b!;
  const since = b.health?.since ? hm(b.health.since) : "";
  if (h === "offline")
    return html`<div class="banner danger" role="alert">${I("unplug", "s16")}<div><span class="bt">Cannot reach the block data service</span><p>Balance may be out of date${since ? ` since ${since}` : ""}. Sending is paused. Retrying every minute.</p><p><button class="link" type="button" data-act="retry">Retry now</button> or <button class="link" type="button" data-act="go" data-to="set-node">use my own node</button></p></div></div>`;
  if (h === "rate-limited")
    return html`<div class="banner warn" role="alert">${I("unplug", "s16")}<div><span class="bt">The block data service is limiting requests</span><p>Without an API key it often refuses to answer${since ? `, since ${since}` : ""}. Finding coins is slower until it answers again. Retrying every minute.</p><p><button class="link" type="button" data-act="retry">Retry now</button>, <button class="link" type="button" data-act="go" data-to="set-network">add your own key</button> or <button class="link" type="button" data-act="go" data-to="set-node">use my own node</button></p></div></div>`;
  return "";
}
actions.retry = async () => {
  await run("retry", async () => {
    await call({ type: "SCAN" }).catch(() => undefined);
    await refresh();
  });
  toast(health() === "ok" ? "Connected." : "Still not answering.");
};

function payjoinCard(): Safe | string {
  const p = S.b!.state.payjoin;
  if (!p) return "";
  const amt = p.amount && p.amount !== "0" ? fbShort(p.amount) : "";
  const what = p.role === "send" ? `Waiting for them to add their coin${amt ? ` to your ${amt} payment` : ""}.` : `Waiting for the payer${amt ? ` to pay ${amt}` : ""}.`;
  return html`<button class="card pad-sm" type="button" data-act="go" data-to="${p.role === "send" ? "pj-waiting" : "paylink"}" style="text-align:left;font:inherit;color:inherit;cursor:pointer;border-color:var(--c-warn-border);background:var(--c-warn-subtle)"><div class="row">${I("hourglass", "s16")}<span class="strong grow">${p.role === "send" ? "Payjoin payment waiting" : "Payment link waiting"}</span><span class="countdown small">${left(p.expiresAt - Date.now())}</span></div>
    <p class="small">${what} You can close this window. Auto lock waits until this finishes.</p></button>`;
}

function oneTimeCard(): Safe | string {
  const f = S.b!.state.oneTimeFunded;
  if (!f) return "";
  return html`<button class="card pad-sm" type="button" data-act="go" data-to="migrate" data-step="sweep" style="text-align:left;font:inherit;color:inherit;cursor:pointer"><div class="row">${I("circle-check", "s16")}<span class="strong grow">${fbShort(f.value)} arrived at your one-time address</span>${I("chevron-right", "s16")}</div><p class="small muted">Move it into your receive code to finish.</p></button>`;
}

function recent(): Safe {
  const e = hist().entries.slice(0, 3);
  return html`<div class="list">${e.map((x) => actRow(x))}</div>`;
}

screens.home = () => {
  const st = S.b!.state;
  const sc = scanning();
  const h = hist();
  const empty = !sc.on && BigInt(st.balance ?? "0") === 0n && (st.coinCount ?? 0) === 0 && h.entries.length === 0;
  const p = price();
  let body: Safe;
  if (sc.on) {
    body = html`${healthBanner()}${balanceSec()}
  <div class="card" role="status" aria-live="polite"><div class="row between"><span class="strong row">${I("refresh-cw", "s16 spin")}Finding your coins…</span><span class="cap num">${sc.pct}%</span></div>
    <div class="progress" role="progressbar" aria-label="Finding your coins" aria-valuenow="${sc.pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${sc.pct}%"></i></div>
    <p class="small muted">Checked block ${num(sc.at)} of ${num(sc.tip)}. PrivateBit reads every block on this computer, so nobody else learns which coins are yours. You can close this window.</p></div>
  ${payjoinCard()}${actionsRow()}
  ${h.entries.length ? html`<div class="sec-h"><h2>Recent</h2><button class="link small" type="button" data-act="tab" data-to="activity">See all</button></div>${recent()}` : ""}`;
  } else if (empty) {
    body = html`${healthBanner()}${balanceSec()}${actionsRow()}
  <div class="card"><div class="stack"><h2 class="strong">Get your first coins</h2><p class="small muted">Share your receive code, or move coins from another wallet.</p></div>
    <div class="stack"><button class="btn btn-primary btn-block" type="button" data-act="go" data-to="receive">${I("arrow-down-left", "s16")}Show my receive code</button><button class="btn btn-secondary btn-block" type="button" data-act="go" data-to="migrate">${I("arrow-right-left", "s16")}Move coins from another wallet</button></div></div>
  ${p.kind !== "off" ? html`<div class="banner">${I("circle-dollar-sign", "s16")}<div><span class="bt">USD prices come from a price service</span><p>It sees your IP and that someone asked for the FB price, never your coins. <button class="link" type="button" data-act="go" data-to="set-privacy">Turn off in Privacy</button></p></div></div>` : ""}`;
  } else {
    body = html`${healthBanner()}${balanceSec()}${oneTimeCard()}${payjoinCard()}${actionsRow()}
  ${p.kind === "na" ? html`<div class="banner">${I("circle-dollar-sign", "s16")}<div><span class="bt">USD price unavailable</span><p>The price service did not answer. Amounts in FB are exact and not affected. Trying again in 10 minutes.</p></div></div>` : ""}
  <div class="sec-h"><h2>Recent</h2>${h.entries.length ? html`<button class="link small" type="button" data-act="tab" data-to="activity">See all</button>` : ""}</div>${h.entries.length ? recent() : html`<p class="small muted">No payments yet.</p>`}`;
  }
  return { title: "Wallet", header: hdr(), main: body, nav: tabs("home"), page: fullOverview() };
};
loaders.home = loadHistory;

/* ---------- full page overview (F1) ---------- */
import { codeHi, mid, usd as usdK, fb } from "../kit.ts";
import { coinTable, loadCoins } from "./coins.ts";

export function whoSees(): Safe {
  const h = health();
  const own = S.b!.state.chain.kind === "core";
  const since = S.b!.health?.since ? hm(S.b!.health.since) : "";
  const usdOn = S.b!.prefs.usd !== false;
  return html`<section class="panel" aria-labelledby="p-h"><h2 id="p-h">Who can see what</h2><div class="list">
  <div class="li" style="cursor:default"><span class="ico in">${I("scan-line")}</span><span class="body"><span class="t">Finding coins</span><span class="d" style="white-space:normal">On this computer only.</span></span><span class="badge ok">Private</span></div>
  <div class="li" style="cursor:default"><span class="ico ${h !== "ok" ? "danger" : own ? "in" : "warn"}">${I("server")}</span><span class="body"><span class="t">${own ? "Your own node" : "Block data service"}</span><span class="d" style="white-space:normal">${h === "offline" ? `Not reachable${since ? ` since ${since}` : ""}.` : h === "rate-limited" ? "Limiting requests without an API key." : own ? "Only your node sees what you read and broadcast." : "Sees your IP, fee rate requests and payments you broadcast."}</span></span><span class="badge ${h !== "ok" ? "danger" : own ? "ok" : "warn"}">${h === "offline" ? "Offline" : h === "rate-limited" ? "Limited" : own ? "Private" : "Shared"}</span></div>
  <div class="li" style="cursor:default"><span class="ico in">${I("route")}</span><span class="body"><span class="t">Payment links via relay</span><span class="d" style="white-space:normal">Encrypted blobs only. IP hidden by relay.</span></span><span class="badge ok">Private</span></div>
  <div class="li" style="cursor:default"><span class="ico ${usdOn ? "warn" : "in"}">${I("circle-dollar-sign")}</span><span class="body"><span class="t">USD price: ${usdOn ? "price service" : "off"}</span><span class="d" style="white-space:normal">${usdOn ? "Sees your IP, never your coins." : "No price requests are made."}</span></span><span class="badge ${usdOn ? "warn" : "ok"}">${usdOn ? "Shared" : "Off"}</span></div></div>
  ${own ? "" : html`<button class="btn btn-secondary" type="button" data-act="go" data-to="set-node">Use my own node</button>`}</section>`;
}

function balPanel(): Safe {
  const st = S.b!.state;
  const hide = hidden();
  const conf = BigInt(st.confirmed ?? "0");
  const pend = BigInt(st.pending ?? "0");
  const p = price();
  const h = health();
  const sc = scanning();
  return html`<section class="panel" aria-labelledby="b-h"><div class="row between"><h2 id="b-h" class="cap row" style="font:var(--t-caption);gap:6px">${NETLOGO("fractal")}${sc.on ? "Balance so far" : "Fractal Bitcoin"}</h2><button class="icon-btn" type="button" data-act="hide-bal" aria-pressed="${String(hide)}" aria-label="${hide ? "Show balance" : "Hide balance"}">${I(hide ? "eye-off" : "eye")}</button></div>
  <p class="bigbal">${hide ? "\u2022\u2022\u2022\u2022\u2022\u2022" : fbShort(conf, { unit: false })}<span class="unit">FB</span></p>
  ${hide || p.kind === "off" ? "" : p.kind === "na" ? html`<p class="fiat">USD price unavailable</p>` : p.kind === "stale" ? html`<p class="fiat stale">${usd(conf)} <span class="muted">price from ${hm(p.at!)}, not updated</span></p>` : html`<p class="fiat">${usd(conf)} <span class="muted">at $${p.usd!.toFixed(4)}, ${hm(p.at!)}</span></p>`}
  <div class="bal-sub">${!hide && pend > 0n ? html`<span>${I("clock", "s16")} ${fbShort(pend)} incoming</span>` : ""}<span>${sc.on ? `Finding coins, block ${num(sc.at)} of ${num(sc.tip)}` : h !== "ok" ? `Last checked block ${num(st.lastHeight ?? 0)}` : `Up to date, block ${num(st.lastHeight ?? 0)}`}</span></div>
  <hr class="divider"><div class="row between"><span class="small strong">Your receive code</span><span class="ntag">${NETLOGO("fractal")}Fractal</span></div><p class="code" style="font-size:12px;line-height:18px">${codeHi(st.receive ?? "")}</p>
  <div class="row"><button class="btn btn-secondary btn-sm" type="button" data-act="copy-code">${I("copy", "s16")}Copy code</button><button class="btn btn-ghost btn-sm" type="button" data-act="go" data-to="receive">${I("qr-code", "s16")}Show QR</button></div></section>`;
}

export function actTable(rows: HistoryEntry[], label = "Recent activity", selectable = false): Safe {
  const p = price();
  const showUsd = p.kind === "ok" || p.kind === "stale";
  const hide = hidden();
  return html`<div class="tscroll" tabindex="0" role="region" aria-label="${label} table"><table class="t"><caption class="sr-only">${label}</caption><thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col" class="col-hide">Who knows</th><th scope="col" class="r">Amount (FB)</th>${showUsd ? html`<th scope="col" class="r col-hide">USD today</th>` : ""}<th scope="col" class="col-hide">Status</th></tr></thead><tbody>
  ${rows.map((e) => {
    const m = entryMeta(e);
    const a = BigInt(e.amount);
    const sel = selectable && S.params.id === e.txid;
    return html`<tr ${sel ? html`aria-selected="true" class="sel"` : ""}><td class="num" style="white-space:nowrap"><a class="link" href="#" data-act="${selectable ? "pick-act" : "go"}" data-to="activity-detail" data-id="${e.txid}">${(e.approxTime ? "About " : "") + dayLabel(e.time * 1000) + " " + hm(e.time * 1000)}</a></td><td>${m.t.replace(/ (to|from) .*$/, "")}</td><td class="col-hide muted">${e.label || "Not labeled"}</td><td class="amt" style="${a > 0n && !hide ? "color:var(--c-ok)" : ""}">${hide ? "\u2022\u2022\u2022\u2022" : fb(a, { unit: false, sign: true })}</td>${showUsd ? html`<td class="r col-hide muted num">${hide ? "" : usdK(a, p.usd, { approx: false })}</td>` : ""}<td class="col-hide">${m.badge || (e.status === "confirmed" ? html`<span class="badge ok">${I("circle-check")}Confirmed</span>` : "")}</td></tr>`;
  })}
  </tbody></table></div>`;
}

function fullOverview(): Safe {
  const h = hist();
  const coins = (S.d.coins as unknown[] | undefined) ?? [];
  const off = health() === "offline";
  return html`${healthBanner()}
  <div class="topbar"><h1>Overview</h1><button class="btn btn-secondary" type="button" data-act="go" data-to="paylink">${I("link-2", "s16")}Payment link</button><button class="btn btn-secondary" type="button" data-act="go" data-to="receive">${I("arrow-down-left", "s16")}Receive</button><button class="btn btn-primary" type="button" data-act="go" data-to="send" ${off ? html`aria-disabled="true" style="opacity:.5"` : ""}>${I("arrow-up-right", "s16")}Send</button></div>
  ${oneTimeCard()}${payjoinCard()}
  <div class="grid2">${balPanel()}${whoSees()}</div>
  <section class="panel" aria-labelledby="a-h"><div class="row between"><h2 id="a-h">Activity</h2>${h.entries.length ? html`<button class="link small" type="button" data-act="tab" data-to="activity">See all</button>` : ""}</div>${h.entries.length ? actTable(h.entries.slice(0, 5)) : html`<p class="small muted">No payments yet. Payments to your receive code show here after PrivateBit finds them in a block.</p>`}</section>
  ${coins.length ? html`<section class="panel" aria-labelledby="c-h"><div class="row between"><h2 id="c-h">Coins</h2><span class="cap">${coinSummary()}</span></div>${coinTable(false)}</section>` : ""}`;
}
function coinSummary(): string {
  const c = (S.d.coins as { status: string }[] | undefined) ?? [];
  const fz = c.filter((x) => x.status === "frozen").length;
  return `${c.length} ${c.length === 1 ? "coin" : "coins"}${fz ? `, ${fz} frozen` : ""}`;
}
loaders.home = async () => {
  await loadHistory();
  if (S.mode === "full") await loadCoins();
};

void mid;
void ({} as SessionView);
