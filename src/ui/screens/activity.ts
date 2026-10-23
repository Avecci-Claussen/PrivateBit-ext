import { S, screens, actions, loaders, render, run, fv, toast } from "../app.ts";
import { call, type HistoryEntry } from "../api.ts";
import { html, I, fb, fbShort, sats, mid, num, dayLabel, longDate, ntag, type Safe } from "../kit.ts";
import { hdr, tabs } from "../chrome.ts";
import { usd, scanning, price } from "../derive.ts";
import { hist, loadHistory, actRow, entryMeta, actTable } from "./home.ts";
import { copyText } from "../copy.ts";
import { cleanLabel } from "../../lib/coinmeta.ts";

loaders.activity = loadHistory;
loaders["activity-detail"] = async () => {
  await loadHistory();
  S.f.actLbl = cur()?.label ?? "";
  S.f.editLbl = false;
};

function grouped(list: HistoryEntry[]): Safe {
  const out: Safe[] = [];
  let day = "";
  let bucket: HistoryEntry[] = [];
  const flush = (): void => {
    if (bucket.length) out.push(html`<p class="day">${day}</p><div class="list">${bucket.map((e) => actRow(e, false))}</div>`);
    bucket = [];
  };
  for (const e of list) {
    const d = (e.approxTime ? "About " : "") + dayLabel(e.time * 1000);
    if (d !== day) {
      flush();
      day = d;
    }
    bucket.push(e);
  }
  flush();
  return html`${out}`;
}

screens.activity = () => {
  const h = hist();
  const sc = scanning();
  const filter = fv("actFilter") || "all";
  const list = h.entries.filter((e) => filter === "all" || (filter === "received" && (e.kind === "received" || e.kind === "moved-in")) || (filter === "sent" && (e.kind === "sent" || e.kind === "self")) || (filter === "payjoin" && e.kind.startsWith("payjoin")));
  let main: Safe;
  if (h.rebuilding) {
    main = html`<h1 style="font:var(--t-title)">Activity</h1>
  <div class="card" role="status"><div class="row between"><span class="row strong" style="gap:6px">${I("refresh-cw", "s16 spin")}Rebuilding your activity</span><span class="small num">${sc.pct}%</span></div>
    <div class="progress" role="progressbar" aria-label="Rebuilding activity" aria-valuenow="${sc.pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${sc.pct}%"></i></div>
    <p class="small muted">History was not on this computer, for example after restoring from recovery words. PrivateBit is reading blocks from ${num(sc.from)} again. Checked up to block ${num(sc.at)}.</p></div>
  ${h.entries.length ? html`<p class="day">Found so far</p><div class="list">${h.entries.map((e) => actRow(e))}</div>` : ""}
  <p class="small muted">Labels you typed and notes are not on the chain, so they cannot be rebuilt. Amounts, dates and fees can.</p>`;
  } else if (!h.entries.length) {
    main = html`<h1 style="font:var(--t-title)">Activity</h1>
  <div class="state"><div class="big neutral">${I("history")}</div><h1>No activity yet</h1><p>Payments to your receive code show here after PrivateBit finds them in a block. History is kept encrypted on this computer and is never synced.</p></div>
  <button class="btn btn-primary btn-block" type="button" data-act="go" data-to="receive">Show my receive code</button>`;
  } else {
    main = html`<div class="sec-h"><h1 style="font:var(--t-title)">Activity</h1><span class="cap row" style="gap:4px">${I("lock", "s16")}Only on this computer</span></div>${grouped(h.entries)}`;
  }
  return { title: "Activity", header: hdr(), main, nav: tabs("activity"), page: fullActivity(list, filter) };
};

const cur = (): HistoryEntry | undefined => hist().entries.find((e) => e.txid === S.params.id);

function detailBody(e: HistoryEntry, panel = false): Safe {
  const m = entryMeta(e);
  const a = BigInt(e.amount);
  const st = S.b!.state;
  const conf = e.height && st.lastHeight ? st.lastHeight - e.height + 1 : 0;
  const statusB =
    e.status === "confirmed"
      ? html`<span class="badge ok">${I("circle-check")}Confirmed${conf > 0 ? `, ${num(conf)} ${conf === 1 ? "block" : "blocks"}` : ""}</span>`
      : e.status === "incoming" || e.status === "pending"
        ? html`<span class="badge">${I("clock")}Waiting for a block</span>`
        : html`<span class="badge danger">${I("circle-x")}${e.status === "cancelled" ? "Cancelled" : "Failed"}</span>`;
  const editing = S.f.editLbl === true;
  const ask = S.b!.prefs.askExplorer !== false;
  return html`<div class="hero-amt" ${panel ? html`style="align-items:flex-start;text-align:left"` : ""}>${panel ? "" : html`<p class="cap">${a > 0n ? "Received" : "Sent"}</p>`}<p class="a">${fbShort(a, { unit: false, sign: true })}<span class="unit"> FB</span></p>${usd(a) ? html`<p class="fiat">${usd(a)} at today's price</p>` : ""}${panel ? "" : statusB}</div>
  <div class="card"><div class="kv">
    <div class="r"><span class="k">Date</span><span class="v">${e.approxTime ? "About " : ""}${longDate(e.time * 1000)}</span></div>
    ${e.to ? html`<div class="r"><span class="k">To</span><span class="v"><span class="mono">${mid(e.to, 12, 8)}</span>${e.to.startsWith("sp1") ? ntag("Fractal receive code") : html`<span class="badge">Regular address</span>`}</span></div>` : ""}
    <div class="r"><span class="k">Label</span><span class="v">${editing ? html`<span class="row" style="gap:6px" data-enter="act-label-save"><input class="input" id="al" data-f="actLbl" maxlength="64" value="${fv("actLbl")}" aria-label="Label" style="height:36px"><button class="btn btn-secondary btn-sm" type="button" data-act="act-label-save">Save</button></span>` : html`${e.label || html`<span class="muted">Not labeled</span>`} <button class="link small" type="button" data-act="act-label-edit">Edit</button>`}</span></div>
    ${e.fee ? html`<div class="r"><span class="k">Fee</span><span class="v mono">${sats(e.fee)}</span></div>` : ""}
    ${e.change ? html`<div class="r"><span class="k">Change</span><span class="v mono">${fb(e.change)}</span></div>` : ""}
    <div class="r"><span class="k">Block</span><span class="v mono">${e.height ? num(e.height) : "Not yet"}</span></div>
    <div class="r"><span class="k">Transaction</span><span class="v"><span class="mono">${mid(e.txid, 10, 8)}</span><button class="link small" type="button" data-act="copy-act-txid">Copy</button></span></div></div></div>
  ${S.f.explorerAsk ? html`<div class="banner warn" role="alert">${I("globe", "s16")}<div><span class="bt">Open mempool.fractalbitcoin.io?</span>It learns your IP and which transaction you looked at. <span class="row" style="gap:8px;margin-top:8px"><button class="btn btn-primary btn-sm" type="button" data-act="explorer-open">Open</button><button class="btn btn-ghost btn-sm" type="button" data-act="explorer-cancel">Cancel</button></span></div></div>` : ""}
  <button class="btn btn-secondary btn-block" type="button" data-act="explorer">${I("external-link", "s16")}View on mempool.fractalbitcoin.io</button>
  <p class="cap">Opening an explorer tells it your IP and which transaction you looked at.${ask ? " PrivateBit asks first." : ""}</p>
  ${m ? "" : ""}`;
}

screens["activity-detail"] = () => {
  const e = cur();
  if (!e) return { title: "Activity", header: hdr({ title: "Activity", net: true }), main: html`<p class="muted">This activity is not on this computer any more.</p>` };
  const m = entryMeta(e);
  return { title: m.t, header: hdr({ title: m.t, net: true }), main: detailBody(e), page: fullActivity(hist().entries, fv("actFilter") || "all") };
};
actions["act-label-edit"] = () => {
  S.f.editLbl = true;
  render();
  document.getElementById("al")?.focus();
};
actions["act-label-save"] = async () => {
  const e = cur();
  if (!e) return;
  await run("lbl", async () => {
    S.d.history = await call({ type: "SET_LABEL", txid: e.txid, label: cleanLabel(fv("actLbl")) });
  });
  S.f.editLbl = false;
  toast("Label saved.");
};
actions["copy-act-txid"] = async () => {
  const e = cur();
  if (!e) return;
  await copyText(e.txid);
  toast("Transaction ID copied.");
};
function openExplorer(): void {
  const e = cur();
  if (!e) return;
  window.open(`https://mempool.fractalbitcoin.io/tx/${encodeURIComponent(e.txid)}`, "_blank", "noopener,noreferrer");
}
actions.explorer = () => {
  if (S.b!.prefs.askExplorer === false) return openExplorer();
  S.f.explorerAsk = true;
  render();
};
actions["explorer-open"] = () => {
  S.f.explorerAsk = false;
  render();
  openExplorer();
};
actions["explorer-cancel"] = () => {
  S.f.explorerAsk = false;
  render();
};

/* ---------- full page activity (F5, F5b) ---------- */
function fullActivity(list: HistoryEntry[], filter: string): Safe {
  const h = hist();
  const p = price();
  if (!h.entries.length && !h.rebuilding) {
    return html`<div class="topbar"><h1>Activity</h1></div>
  <section class="panel"><div class="state"><div class="big neutral">${I("history")}</div><h1>No activity yet</h1><p>Payments to your receive code show here after PrivateBit finds them in a block. Fractal makes a block about every 30 seconds.</p><button class="btn btn-primary" type="button" data-act="go" data-to="receive">${I("arrow-down-left", "s16")}Show my receive code</button></div></section>`;
  }
  const e = cur() ?? list[0];
  const sc = scanning();
  const seg = (k: string, l: string) => html`<button type="button" role="radio" data-act="act-filter" data-v="${k}" aria-checked="${String(filter === k)}">${l}</button>`;
  return html`<div class="topbar"><h1>Activity</h1><span class="cap row" style="gap:4px">${I("lock", "s16")}Encrypted, only on this computer</span><div class="seg" role="radiogroup" aria-label="Filter" style="width:360px">${seg("all", "All")}${seg("received", "Received")}${seg("sent", "Sent")}${seg("payjoin", "Payjoin")}</div></div>
  ${h.rebuilding ? html`<div class="card" role="status"><div class="row between"><span class="row strong" style="gap:6px">${I("refresh-cw", "s16 spin")}Rebuilding your activity</span><span class="small num">${sc.pct}%</span></div><div class="progress" role="progressbar" aria-label="Rebuilding activity" aria-valuenow="${sc.pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${sc.pct}%"></i></div><p class="small muted">Reading blocks from ${num(sc.from)} again. Checked up to block ${num(sc.at)}. Labels you typed cannot be rebuilt.</p></div>` : ""}
  <div class="grid2 g-main">
    <section class="panel" aria-labelledby="a-h"><h2 id="a-h" class="sr-only">All activity</h2>${list.length ? actTable(list, "All activity", true) : html`<p class="small muted">Nothing in this filter.</p>`}${p.kind === "ok" || p.kind === "stale" ? html`<p class="cap">USD uses today's price from the price service, not the price on the day.</p>` : ""}</section>
    ${e ? html`<aside class="panel" aria-labelledby="d-h"><div class="row between"><h2 id="d-h">${entryMeta(e).t}</h2>${e.status === "confirmed" ? html`<span class="badge ok">${I("circle-check")}Confirmed</span>` : html`<span class="badge">${I("clock")}Waiting</span>`}</div>${detailBody(e, true)}</aside>` : ""}
  </div>`;
}
actions["act-filter"] = (el) => {
  S.f.actFilter = el.dataset.v!;
  render();
};
actions["pick-act"] = (el) => {
  S.params = { id: el.dataset.id };
  S.f.actLbl = cur()?.label ?? "";
  S.f.editLbl = false;
  S.f.explorerAsk = false;
  render();
};
