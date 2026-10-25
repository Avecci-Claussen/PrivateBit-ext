import { S, screens, actions, loaders, render, run, fv, toast } from "../app.ts";
import { call, type HistoryEntry } from "../api.ts";
import { html, I, txLink, curNet, explorerHost, fb, fbShort, sats, mid, num, dayLabel, longDate, ntag, type Safe, UNIT, CHAIN_SHORT, blockTimeText } from "../kit.ts";
import { hdr, tabs } from "../chrome.ts";
import { usd, scanning, price } from "../derive.ts";
import { hist, loadHistory, actRow, entryMeta, actTable } from "./home.ts";
import { copyText } from "../copy.ts";
import { explorerBlock, pathPreview, txidLine, type PathLeg } from "../path.ts";
import { cleanLabel } from "../../lib/coinmeta.ts";

loaders.activity = loadHistory;
loaders["activity-detail"] = async () => {
  await loadHistory();
  S.f.actLbl = cur()?.label ?? "";
  S.f.editLbl = false;
  if (typeof S.params.id === "string") S.d.exploreTxid = S.params.id;
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
  const list = h.entries.filter((e) => filter === "all" || (filter === "received" && (e.kind === "received" || e.kind === "moved-in")) || (filter === "sent" && (e.kind === "sent" || e.kind === "self" || e.kind === "split")) || (filter === "payjoin" && e.kind.startsWith("payjoin")));
  let main: Safe;
  if (h.rebuilding) {
    main = html`<h1 data-st="9d50d4">Activity</h1>
  <div class="card" role="status"><div class="row between"><span class="row strong" data-st="f0abc1">${I("refresh-cw", "s16 spin")}Rebuilding your activity</span><span class="small num">${sc.pct}%</span></div>
    <div class="progress" role="progressbar" aria-label="Rebuilding activity" aria-valuenow="${sc.pct}" aria-valuemin="0" aria-valuemax="100"><i data-pct="${sc.pct}"></i></div>
    <p class="small muted">History was not on this computer, such as after restoring from recovery words. Blocks are being downloaded again. Checked through block ${num(sc.at)}.</p></div>
  ${h.entries.length ? html`<p class="day">Found so far</p><div class="list">${h.entries.map((e) => actRow(e))}</div>` : ""}
  <p class="small muted">Labels you typed and notes are not on the chain, so they cannot be rebuilt. Amounts, dates and fees can.</p>`;
  } else if (!h.entries.length) {
    main = html`<h1 data-st="9d50d4">Activity</h1>
  <div class="state"><div class="big neutral">${I("history")}</div><h1>No activity yet</h1><p>Payments to your receive code show here after PrivateBit finds them in a block. History is kept encrypted on this computer and is never synced.</p></div>
  <button class="btn btn-primary btn-block" type="button" data-act="go" data-to="receive">Show my receive code</button>`;
  } else {
    main = html`<div class="sec-h"><h1 data-st="9d50d4">Activity</h1><span class="cap row" data-st="d76768">${I("lock", "s16")}Only on this computer</span></div>${grouped(h.entries)}`;
  }
  return { title: "Activity", header: hdr(), main, nav: tabs("activity"), page: fullActivity(list, filter) };
};

const cur = (): HistoryEntry | undefined => hist().entries.find((e) => e.txid === S.params.id);

function actPath(e: HistoryEntry): { from: PathLeg; to: PathLeg } {
  const them = e.label || "Them";
  switch (e.kind) {
    case "moved-in":
      return { from: { title: "Old wallet", sub: "Reused address" }, to: { title: "Your one-time address", sub: "Linked" } };
    case "self":
      return { from: { title: e.linked ? "One-time address" : "Your coins" }, to: { title: "Your receive code" } };
    case "split":
      return {
        from: { title: "This coin" },
        to: { title: "Your receive code", sub: e.pieces && e.pieces >= 2 ? `${e.pieces} pieces you still own` : "Pieces you still own" },
      };
    case "sent":
    case "payjoin-sent":
      return {
        from: { title: "Your coins" },
        to: { title: them, sub: e.to ? (e.to.startsWith("sp1") ? `${CHAIN_SHORT()} receive code` : "Address") : e.kind === "payjoin-sent" ? "Payment link" : undefined },
      };
    default:
      return { from: { title: them === "Them" ? "Someone with your code" : them }, to: { title: "Your receive code" } };
  }
}

function liveTxid(): string | undefined {
  if (typeof S.d.exploreTxid === "string" && S.d.exploreTxid) return S.d.exploreTxid;
  const sent = S.d.sent as { txid?: string } | undefined;
  if (sent?.txid) return sent.txid;
  const split = S.d.splitDone as { txid?: string } | undefined;
  if (split?.txid) return split.txid;
  if (typeof S.d.sweepTxid === "string" && S.d.sweepTxid) return S.d.sweepTxid;
  return cur()?.txid;
}

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
  const moved = e.kind === "self" || e.kind === "split";
  const incoming = e.kind === "received" || e.kind === "payjoin-received" || e.kind === "moved-in";
  const sent = e.kind === "sent" || e.kind === "payjoin-sent";
  const cap = moved ? "Moved between your coins" : e.kind === "moved-in" ? "Moved in" : a > 0n ? "Received" : "Sent";
  // History is kept per chain, so an entry without a chain belongs to the open one.
  const en = e.net ?? curNet();
  const netName = en === "bitcoin" ? "Bitcoin" : "Fractal Bitcoin";
  const shown = sent ? -a : a;
  const { from, to } = actPath(e);
  const onchainRow = (k: string) =>
    e.onchain ? html`<div class="r sub"><span class="k">${k}</span><span class="v"><span class="mono small" title="${e.onchain}">${mid(e.onchain, 10, 8)}</span><button class="link small" type="button" data-act="copy-onchain">Copy</button></span></div>` : "";
  const toKind = e.to ? (e.to.startsWith("sp1") ? ntag(`${en === "bitcoin" ? "Bitcoin" : "Fractal"} receive code`) : e.to.includes("pj=") || e.to.includes("pj%3D") ? ntag("Payment link") : html`<span class="badge">Regular address</span>`) : "";
  return html`<div class="hero-amt" ${panel ? html`data-st="3ce9d3"` : ""}>${panel ? html`<p class="cap">${cap}</p>` : html`<p class="cap">${cap}</p>`}<p class="a">${fbShort(a, { unit: false, sign: true })}<span class="unit"> ${en === "bitcoin" ? "BTC" : "FB"}</span></p>${usd(a) && en === curNet() ? html`<p class="fiat">${usd(a)} at today's price</p>` : ""}${panel ? "" : statusB}</div>
  ${pathPreview(from, to)}
  <div class="card"><div class="kv">
    ${sent ? html`<div class="r"><span class="k">Paid to</span><span class="v">${e.to ? html`<span class="mono" title="${e.to}">${mid(e.to, 12, 8)}</span>${toKind}` : html`<span class="muted">Not saved on this computer</span>`}</span></div>${onchainRow("On-chain address")}` : ""}
    ${incoming ? html`<div class="r"><span class="k">Received to</span><span class="v">${e.kind === "moved-in" ? "Your one-time address" : "Your receive code"}</span></div>${onchainRow("On-chain address")}
      <div class="r"><span class="k">From</span><span class="v"><span>Not revealed</span><span class="cap">${e.kind === "moved-in" ? "Your old wallet" : "The payment does not show who sent it"}</span></span></div>` : ""}
    ${moved ? html`<div class="r"><span class="k">What happened</span><span class="v">${e.kind === "split" ? `Broke one coin into ${e.pieces ?? "several"} pieces you still own` : "Moved between your coins"}</span></div>` : ""}
    <div class="r"><span class="k">Amount</span><span class="v mono">${fb(shown < 0n ? -shown : shown)}</span></div>
    ${e.change && BigInt(e.change) > 0n ? html`<div class="r"><span class="k">Back to you</span><span class="v mono">${fb(e.change)}</span></div>` : ""}
    ${e.fee ? html`<div class="r"><span class="k">Network fee</span><span class="v"><span class="mono">${sats(e.fee)}</span>${e.feeRate ? html`<span class="cap">${e.feeRate} sat/vB</span>` : ""}</span></div>` : ""}
    <div class="r"><span class="k">Network</span><span class="v">${ntag(netName)}</span></div>
    <div class="r"><span class="k">Date</span><span class="v">${e.approxTime ? "About " : ""}${longDate(e.time * 1000)}</span></div>
    <div class="r"><span class="k">Block</span><span class="v mono">${e.height ? num(e.height) : "Not yet"}</span></div>
    <div class="r"><span class="k">Label</span><span class="v">${editing ? html`<span class="row" data-st="f0abc1" data-enter="act-label-save"><input class="input" id="al" data-f="actLbl" maxlength="64" value="${fv("actLbl")}" aria-label="Label" data-st="903dd6"><button class="btn btn-secondary btn-sm" type="button" data-act="act-label-save">Save</button></span>` : html`${e.label || html`<span class="muted">Not labeled</span>`} <button class="link small" type="button" data-act="act-label-edit">Edit</button>`}</span></div>
    ${txidLine(e.txid)}</div></div>
  ${explorerBlock(S.f.explorerAsk === true, ask, en)}
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
actions["copy-onchain"] = async () => {
  const a = cur()?.onchain;
  if (!a) return;
  await copyText(a);
  toast("On-chain address copied.");
};
actions["copy-act-txid"] = async () => {
  const id = liveTxid();
  if (!id) return;
  await copyText(id);
  toast("Transaction ID copied.");
};
function openExplorer(): void {
  const id = liveTxid();
  if (!id) return;
  const e = hist().entries.find((x) => x.txid === id);
  window.open(txLink(encodeURIComponent(id), e?.net ?? curNet()), "_blank", "noopener,noreferrer");
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
  <section class="panel"><div class="state"><div class="big neutral">${I("history")}</div><h1>No activity yet</h1><p>Payments to your receive code show here after PrivateBit finds them in a block. ${blockTimeText()}</p><button class="btn btn-primary" type="button" data-act="go" data-to="receive">${I("arrow-down-left", "s16")}Show my receive code</button></div></section>`;
  }
  const e = cur() ?? list[0];
  const sc = scanning();
  const seg = (k: string, l: string) => html`<button type="button" role="radio" data-act="act-filter" data-v="${k}" aria-checked="${String(filter === k)}">${l}</button>`;
  return html`<div class="topbar"><h1>Activity</h1><span class="cap row" data-st="d76768">${I("lock", "s16")}Encrypted, only on this computer</span><div class="seg" role="radiogroup" aria-label="Filter" data-st="83d1d8">${seg("all", "All")}${seg("received", "Received")}${seg("sent", "Sent")}${seg("payjoin", "Payjoin")}</div></div>
  ${h.rebuilding ? html`<div class="card" role="status"><div class="row between"><span class="row strong" data-st="f0abc1">${I("refresh-cw", "s16 spin")}Rebuilding your activity</span><span class="small num">${sc.pct}%</span></div><div class="progress" role="progressbar" aria-label="Rebuilding activity" aria-valuenow="${sc.pct}" aria-valuemin="0" aria-valuemax="100"><i data-pct="${sc.pct}"></i></div><p class="small muted">Blocks are being downloaded again. Checked through block ${num(sc.at)}. Labels you typed cannot be rebuilt.</p></div>` : ""}
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
  S.d.exploreTxid = el.dataset.id;
  S.f.actLbl = cur()?.label ?? "";
  S.f.editLbl = false;
  S.f.explorerAsk = false;
  render();
};
