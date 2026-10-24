import { S, screens, actions, loaders, go, back, render, run, refresh, fv, busy, err, toast } from "../app.ts";
import { call, type SessionView, type CoinView } from "../api.ts";
import { html, I, MARK, NETLOGO, codeHi, fbShort, fb, parseFb, left, when, type Safe } from "../kit.ts";
import { hdr } from "../chrome.ts";
import { ntag as ntagF } from "../kit.ts";
import { usd } from "../derive.ts";
import { qrSvg } from "../qr.ts";
import { copyText } from "../copy.ts";
import { explorerBlock, pathPreview, txidLine } from "../path.ts";
import { loadCoins } from "./coins.ts";

const qmark = (): Safe => html`<span class="qmark" aria-hidden="true">${MARK(28, false, "qm")}</span>`;

screens.receive = () => {
  const code = S.b!.state.receive ?? "";
  const copied = S.f.copied === true;
  const main = html`
  <div class="qr">${qrSvg(code.toUpperCase(), "QR code of your receive code")}${qmark()}</div>
  <div class="codebox"><div class="row between">${ntagF("Fractal receive code")}<span class="cap">Reusable</span></div><p class="code" aria-label="Receive code">${codeHi(code)}</p></div>
  <div class="stack">${copied
    ? html`<p class="small"><strong>Check the first and last 8 characters</strong> after pasting: <span class="mono">${code.slice(0, 8)}</span> and <span class="mono">${code.slice(-8)}</span>.</p>`
    : html`<p class="small"><strong>Safe to share and reuse.</strong> Each payment to this code lands at a new address that only this wallet can find.</p>`}</div>`;
  return {
    title: "Receive",
    header: hdr({ title: "Receive", net: true }),
    mainCls: "tight",
    main,
    foot: { cls: "row", html: html`<button class="btn btn-primary" type="button" data-act="copy-receive">${I(copied ? "check" : "copy", "s16")}${copied ? "Copied" : "Copy code"}</button><button class="btn btn-secondary" type="button" data-act="go" data-to="paylink">${I("link-2", "s16")}Payment link</button>` },
    page: fullReceive(),
  };
};
loaders.receive = async () => {
  S.f.copied = false;
  if (S.mode === "full") await loadSessions();
};
actions["copy-receive"] = async () => {
  await copyText(S.b!.state.receive ?? "");
  S.f.copied = true;
  toast("Code copied.");
};

/* ---------- payment link ---------- */
export async function loadSessions(): Promise<void> {
  S.d.sessions = await call<SessionView[]>({ type: "SESSIONS" });
}
const sessions = (): SessionView[] => (S.d.sessions as SessionView[] | undefined) ?? [];
function liveReceive(): SessionView | undefined {
  return sessions().find(
    (s) => s.role === "receive" && (s.status === "proposed" || (s.status === "waiting" && s.expiresAt > Date.now())),
  );
}
function opened(): SessionView | undefined {
  const id = typeof S.params.id === "string" ? S.params.id : undefined;
  return id ? sessions().find((s) => s.id === id) : undefined;
}
function pastSessions(): SessionView[] {
  const live = liveReceive();
  return sessions().filter((s) => {
    if (live && s.id === live.id) return false;
    if (s.role === "send" && s.status === "waiting" && s.expiresAt > Date.now()) return false;
    if (s.role === "receive" && (s.status === "waiting" || s.status === "proposed") && s.expiresAt > Date.now()) return false;
    return s.status !== "waiting" && s.status !== "proposed";
  });
}
function outcome(s: SessionView): { label: string; cls: string } {
  const e = s.error ?? "";
  if (s.status === "done") return { label: s.role === "send" ? "Sent" : "Received", cls: "ok" };
  if (/cancel/i.test(e)) return { label: "Cancelled", cls: "" };
  if (/expired/i.test(e) || Date.now() > s.expiresAt) return { label: "Expired", cls: "" };
  if (/locked|key is gone/i.test(e)) return { label: "Stopped", cls: "" };
  return { label: "Stopped", cls: "" };
}
function historyList(): Safe {
  const rows = pastSessions();
  if (!rows.length) return html`<p class="small muted">No past Payjoins yet.</p>`;
  return html`<div class="opt-list">${rows.map((s) => {
    const o = outcome(s);
    const amt = s.amount && s.amount !== "0" ? fbShort(s.amount) : "Any amount";
    const who = s.role === "send" ? "You paid" : "Payment link";
    return html`<button class="opt" type="button" data-act="pj-open" data-id="${s.id}"><span class="body"><span class="t">${who} · ${amt}</span><span class="d">${when(s.createdAt)}</span></span><span class="badge ${o.cls}">${o.label}</span></button>`;
  })}</div>`;
}
function failedReason(s: SessionView): "locked" | "expired" | "cancelled" | "other" {
  const e = s.error ?? "";
  if (/expired/i.test(e) || (s.status !== "done" && Date.now() > s.expiresAt)) return "expired";
  if (/cancel/i.test(e)) return "cancelled";
  if (/locked|key is gone/i.test(e)) return "locked";
  return "other";
}

function linkCoin(): CoinView | undefined {
  const coins = ((S.d.coins as CoinView[] | undefined) ?? []).filter((c) => c.status !== "frozen" && c.status !== "reserved" && c.kind !== "bip86");
  return coins.sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)))[0];
}

loaders.paylink = async () => {
  await Promise.all([loadSessions(), loadCoins()]);
  const open = opened();
  if (open?.txid) S.d.exploreTxid = open.txid;
};

screens.paylink = () => {
  const H = hdr({ title: "Payment link", net: true });
  const open = opened();
  if (open) return sessionDetail(open, H);
  if (S.f.pjHist) return historyScreen();
  const s = liveReceive();
  if (s && (s.status === "waiting" || s.status === "proposed")) return s.status === "proposed" ? progress(s, H) : waiting(s, H);
  const coin = linkCoin();
  if (!coin && S.d.coins) {
    return {
      title: "Payment link",
      header: H,
      main: html`<div class="state"><div class="big neutral">${I("coins")}</div><h1>You need one coin first</h1><p>A payment link adds one of your coins to the payment. This wallet has none yet.</p></div>
  <div class="banner">${I("info", "s16")}<div>Receive with your code first. Plain code payments work without any coins in the wallet.</div></div>
  ${pastSessions().length ? html`<div class="sec-h"><h2>History</h2></div>${historyList()}` : ""}`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="go" data-to="receive">Show my receive code</button>`,
    };
  }
  const a = fv("pjAmt");
  const sats = a ? parseFb(a) : 0n;
  const bad = a !== "" && (sats === null || sats < 330n);
  return {
    title: "Payment link",
    header: H,
    main: html`
  <div class="stack"><h2 style="font:var(--t-title)">Get paid with Payjoin</h2><p class="muted">For payments from another PrivateBit user. You add one of your coins to their payment, so nobody watching the chain can tell which coins belong to whom.</p></div>
  <div class="field" data-enter="pj-create"><label class="label" for="amt">Amount <span class="optl">(optional)</span></label><div class="input-wrap"><input class="input mono" id="amt" data-f="pjAmt" data-live inputmode="decimal" autocomplete="off" value="${a}" placeholder="0.00" ${bad ? html`aria-invalid="true" aria-describedby="amt-e"` : html`aria-describedby="amt-h"`}><span class="unit">FB</span></div>
  ${bad ? html`<p class="err" id="amt-e" role="alert">${I("circle-alert", "s16")}<span>${sats === null ? "Enter an amount like 0.04, with up to 8 decimals." : "Minimum amount is 330 sats."}</span></p>` : html`<p class="help" id="amt-h">${sats && sats > 0n && usd(sats) ? `${usd(sats)}. ` : ""}Leave empty and they choose the amount.</p>`}</div>
  ${pathPreview({ title: "Them", sub: "Another PrivateBit user" }, { title: "You", sub: coin ? `Payjoin, you add ${fb(coin.value)}` : "Payjoin, you add one of your coins" })}
  ${coin ? html`<div class="card flat pad-sm"><div class="row">${I("lock-keyhole", "s16")}<span class="strong grow">Coin you will add</span><span class="amt">${fb(coin.value)}</span></div><p class="small muted">${coin.label ? `${coin.label}. ` : ""}It stays yours, set aside until the payment finishes or the link expires in 24 hours.</p></div>` : ""}
  <p class="small muted">Plain <span class="mono">sp1</span> sends never Payjoin. Both people need PrivateBit and this link.</p>
  ${pastSessions().length ? html`<div class="sec-h"><h2>History</h2></div><p class="small muted">Cancelled, expired, and finished Payjoins stay here. They are not shown on the wallet.</p>${historyList()}` : ""}
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="pj-create" ${bad || busy("pj") ? html`aria-disabled="true"` : ""}>${busy("pj") ? html`${I("loader-circle", "s16 spin")}Creating link…` : "Create payment link"}</button>`,
  };
};

actions["pj-create"] = async () => {
  const a = fv("pjAmt");
  const sats = a ? parseFb(a) : 0n;
  if (sats === null) return;
  const r = await run("pj", () => call<{ id: string; bip21: string }>({ type: "OFFER_PAYJOIN", amount: sats.toString() }));
  if (!r) return;
  S.f.pjSeen = r.id;
  S.f.pjAmt = "";
  await refresh();
  await loadSessions();
  render();
};

function waiting(s: SessionView, H: Safe) {
  const link = s.bip21 ?? "";
  const full = S.f.pjFull === true;
  const amt = s.amount && s.amount !== "0" ? s.amount : undefined;
  return {
    title: "Payment link",
    header: H,
    mainCls: "tight",
    main: html`
  ${pathPreview({ title: "Them", sub: "The PrivateBit user you share this with" }, { title: "You", sub: amt ? `${fbShort(amt)} with Payjoin` : "Any amount, with Payjoin" })}
  <div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">Stay unlocked until they finish</span>You don't confirm this payment. When they pay, this wallet adds your coin by itself, even while it is still finding coins. Locking deletes the link's keys. Closing the window is fine.</div></div>
  <div class="card"><div class="linkcard"><div class="qr sm">${qrSvg(link, "QR code of your payment link")}</div>
    <div class="stack" style="gap:6px;min-width:0">${ntagF("Payment link")}<p style="font:600 22px/28px var(--font-sans);letter-spacing:var(--track-tight)">${amt ? fbShort(amt, { unit: false }) : "Any amount"}${amt ? html`<span class="muted" style="font:var(--t-body-strong)"> FB</span>` : ""}</p>${amt && usd(amt) ? html`<p class="fiat">${usd(amt)}</p>` : ""}
    <p class="small row" style="gap:6px;align-items:flex-start">${I("hourglass", "s16")}<span>Waiting<br><span class="muted">Expires in </span><span class="countdown" style="white-space:nowrap">${left(s.expiresAt - Date.now())}</span></span></p></div></div></div>
  <div class="codebox"><p class="code ${full ? "" : "clamp4"}" style="font-size:12px;line-height:16px;${full ? "" : "-webkit-line-clamp:3"}">${link}</p><div class="row between"><button class="link small" type="button" data-act="toggle-r" data-k="pjFull">${full ? "Show less" : "Show full link"}</button></div></div>
  <p class="small muted">One use. Share it with the PrivateBit user who is paying you. You don't press anything after that. This wallet adds your coin when their payment shows up in the mailbox.</p>
  ${s.error ? html`<div class="banner danger">${I("circle-alert", "s16")}<div><span class="bt">The mailbox check failed</span>${s.error}</div></div>` : html`<p class="small muted">No payment has arrived at this link yet${s.checkedAt ? html`. Last check ${when(s.checkedAt)}` : ""}. If they are already waiting on their side, they paid a different link, or the mailbox did not keep it. Cancel this one, create a new link, and ask them to cancel the payment that is waiting.</p>`}
  ${pastSessions().length ? html`<button class="link small" type="button" data-act="pj-hist">Payment link history</button>` : ""}
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}`,
    foot: { cls: "row", html: html`<button class="btn btn-primary" type="button" data-act="copy-link">${I("copy", "s16")}Copy link</button><button class="btn btn-secondary" type="button" data-act="pj-check" ${busy("pj-check") ? html`aria-disabled="true"` : ""}>Check now</button><button class="btn btn-ghost" type="button" data-act="cancel-link" data-id="${s.id}">Cancel link</button>` },
  };
}
actions["toggle-r"] = (el) => {
  S.f[el.dataset.k!] = !S.f[el.dataset.k!];
  render();
};
actions["copy-link"] = async () => {
  const s = opened() ?? liveReceive();
  if (!s?.bip21) return;
  await copyText(s.bip21);
  toast("Link copied.");
};
actions["cancel-link"] = async (el) => {
  const id = el.dataset.id!;
  S.params = {};
  S.f.pjHist = false;
  const r = await run("cancel", async () => {
    S.d.sessions = await call({ type: "CANCEL_LINK", id });
    await refresh();
    return true;
  });
  if (r) toast("Link cancelled. It is in Payment link history. Your coin is free again.");
};

function progress(s: SessionView, H: Safe) {
  const amt = s.amount && s.amount !== "0" ? s.amount : undefined;
  return {
    title: "Payment link",
    header: hdr({ title: "Payment link", net: true, right: html`<span class="badge">${I("loader-circle", "spin")}Working</span>` }),
    main: html`
  <div class="hero-amt"><p class="cap">Incoming</p><p class="a">${amt ? fbShort(amt, { unit: false }) : "Payment"}${amt ? html`<span class="unit"> FB</span>` : ""}</p>${amt && usd(amt) ? html`<p class="fiat">${usd(amt)}</p>` : ""}</div>
  ${pathPreview({ title: "Them", sub: "They sent their part, encrypted" }, { title: "You", sub: "Your coin is being added" })}
  <ol class="steps" aria-label="Payment progress">
    <li class="step done"><span class="n">${I("check", "s16")}</span><div><p class="st">Link shared</p><p class="sd">${when(s.createdAt)}</p></div></li>
    <li class="step done"><span class="n">${I("check", "s16")}</span><div><p class="st">Payer sent their part</p><p class="sd">Encrypted. The mailbox could not read it.</p></div></li>
    <li class="step now" aria-current="step"><span class="n">3</span><div><p class="st">Your coin added and signed</p><p class="sd">Happens in the background, even with the window closed.</p></div></li>
    <li class="step todo"><span class="n">4</span><div><p class="st">Payer broadcasts</p><p class="sd">Then the payment shows in Activity.</p></div></li>
  </ol>
  <div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">Keep PrivateBit unlocked</span>Locking now cancels this payment.</div></div>`,
    foot: html`<button class="btn btn-secondary btn-block" type="button" data-act="home">Back to wallet</button>`,
  };
  void H;
}

function done(s: SessionView, H: Safe) {
  const amt = s.amount && s.amount !== "0" ? s.amount : undefined;
  const ask = S.b!.prefs.askExplorer !== false;
  return {
    title: "Payment link",
    header: H,
    main: html`
  <div class="state"><div class="big">${I("circle-check")}</div><h1>${amt ? `${fbShort(amt)} received with Payjoin` : "Received with Payjoin"}</h1><p>On chain this looks like one payment with inputs from two people. Observers cannot tell which coins were yours. You both already know this transaction.</p></div>
  ${pathPreview({ title: "Them", sub: "The person who paid you" }, { title: "You", sub: "Payjoin, both of you own inputs" })}
  <div class="card"><div class="kv">
    ${s.txid ? txidLine(s.txid) : ""}
    ${amt ? html`<div class="r"><span class="k">You received</span><span class="v mono">${fb(amt)}</span></div>` : ""}
    ${s.reservedValue ? html`<div class="r"><span class="k">Your coin added</span><span class="v mono">${fb(s.reservedValue)}</span></div>` : ""}
    ${amt && s.reservedValue ? html`<div class="r"><span class="k">Back to you</span><span class="v mono">${fb(BigInt(amt) + BigInt(s.reservedValue))}</span></div>` : ""}
    <div class="r"><span class="k">Status</span><span class="v"><span class="badge">${I("clock")}Shows in Activity once in a block</span></span></div></div></div>
  ${s.txid ? explorerBlock(S.f.explorerAsk === true, ask) : ""}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="pj-back">Back</button>`,
  };
}

function failed(s: SessionView, H: Safe) {
  const why = failedReason(s);
  const coin = s.reservedValue ? `Your ${fbShort(s.reservedValue)} coin` : "Your coin";
  if (why === "expired") {
    return {
      title: "Payment link",
      header: H,
      main: html`<div class="state"><div class="big neutral">${I("timer")}</div><h1>Link expired</h1><p>Nobody paid within 24 hours. ${coin} is available again.</p></div>`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="pj-back">Back</button>`,
    };
  }
  return {
    title: "Payment link",
    header: H,
    main: html`
  <div class="state"><div class="big danger">${I("circle-x")}</div><h1>This payment link stopped working</h1><p>${why === "locked" ? "PrivateBit was locked while the link was waiting, which deleted its keys." : why === "cancelled" ? "You cancelled it." : `It failed: ${s.error ?? "unknown error"}.`} No coins moved.</p></div>
  <div class="card"><div class="kv">
    <div class="r"><span class="k">Created</span><span class="v">${when(s.createdAt)}</span></div>
    <div class="r"><span class="k">Reason</span><span class="v">${why === "locked" ? "Keys deleted by Lock" : why === "cancelled" ? "Cancelled" : "Error"}</span></div>
    <div class="r"><span class="k">${coin}</span><span class="v">Available again</span></div></div></div>
  <p class="small muted">If the payer already pressed Confirm, ask them to wait for your new link. Their wallet did not send anything. Closing the window is fine.</p>`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="pj-back">Back</button>`,
  };
}

function historyScreen() {
  return {
    title: "Payment link history",
    header: hdr({ title: "Payment link history", net: true }),
    main: html`<p class="small muted">Cancelled, expired, and finished Payjoins stay here. They are not shown on the wallet.</p>${historyList()}`,
    foot: html`<button class="btn btn-secondary btn-block" type="button" data-act="pj-hist-close">Back</button>`,
  };
}

function sessionDetail(s: SessionView, H: Safe) {
  if (s.role === "receive" && s.status === "proposed") return progress(s, H);
  if (s.role === "receive" && s.status === "waiting" && s.expiresAt > Date.now()) return waiting(s, H);
  if (s.role === "receive" && s.status === "done") return done(s, H);
  if (s.role === "receive") return failed(s, H);
  return sendRecord(s, H);
}

function sendRecord(s: SessionView, H: Safe) {
  const o = outcome(s);
  const amt = s.amount && s.amount !== "0" ? fbShort(s.amount) : "Payment";
  const dest = s.destination && s.destination.length > 48 ? `${s.destination.slice(0, 22)}…${s.destination.slice(-8)}` : s.destination;
  return {
    title: "Payment link",
    header: H,
    main: html`
  <div class="state"><div class="big ${s.status === "done" ? "" : "neutral"}">${I(s.status === "done" ? "circle-check" : "circle-x")}</div><h1>${amt} · ${o.label}</h1><p>${s.status === "done" ? "This Payjoin was broadcast." : /cancel/i.test(s.error ?? "") ? "You cancelled this payment. Nothing was broadcast." : "This payment stopped before it finished."}</p></div>
  <div class="card"><div class="kv">
    <div class="r"><span class="k">Started</span><span class="v">${when(s.createdAt)}</span></div>
    ${dest ? html`<div class="r"><span class="k">To</span><span class="v mono">${dest}</span></div>` : ""}
    ${s.txid ? txidLine(s.txid) : ""}
  </div></div>
  ${s.status !== "done" ? html`<div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">Your signed part may still be in their mailbox</span>Until that coin is spent, they could still broadcast the original payment. Sending without Payjoin spends the same coin, so you cannot pay twice.</div></div>` : ""}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="pj-back">Back</button>`,
  };
}

actions["pj-open"] = (el) => {
  const id = el.dataset.id;
  if (!id) return;
  if (S.route !== "paylink") {
    S.f.pjHist = false;
    go("paylink", { id });
    return;
  }
  S.params = { id };
  render();
};
actions["pj-back"] = () => {
  S.params = {};
  render();
};
actions["pj-hist"] = () => {
  S.f.pjHist = true;
  S.params = {};
  render();
};
actions["pj-hist-close"] = () => {
  S.f.pjHist = false;
  render();
};

/* ---------- full page receive (F4) ---------- */
function fullReceive(): Safe {
  const code = S.b!.state.receive ?? "";
  const s = liveReceive();
  const amt = s?.amount && s.amount !== "0" ? s.amount : undefined;
  return html`<div class="topbar"><h1>Receive</h1><span class="cap row" style="gap:6px">${NETLOGO("fractal")}On Fractal Bitcoin</span></div>
  <div class="grid2">
    <section class="panel" aria-labelledby="rc-h"><div class="row between"><h2 id="rc-h">Your receive code</h2><span class="cap">Reusable</span></div>
      <div class="qr" style="width:216px;height:216px"><div style="width:192px;height:192px">${qrSvg(code.toUpperCase(), "QR code of your receive code")}</div>${qmark()}</div>
      <p class="code" aria-label="Receive code">${codeHi(code)}</p>
      <p class="small"><strong>Safe to share and reuse.</strong> Each payment lands at a new address only this wallet can find.</p>
      <div class="row"><button class="btn btn-primary" type="button" data-act="copy-receive">${I("copy", "s16")}Copy code</button><button class="btn btn-secondary" type="button" data-act="save-qr">${I("download", "s16")}Save QR</button></div></section>
    <section class="panel" aria-labelledby="pl-h"><div class="row between"><h2 id="pl-h">Payment link</h2>${s ? html`<span class="badge warn">${I("hourglass")}Waiting</span>` : ""}</div>
      ${s
        ? html`<div class="linkcard"><div class="qr sm">${qrSvg(s.bip21 ?? "", "QR code of your payment link")}</div><div class="stack" style="gap:6px">${ntagF("Payment link")}<p style="font:600 22px/28px var(--font-sans)">${amt ? fbShort(amt, { unit: false }) : "Any amount"}${amt ? html`<span class="muted" style="font:var(--t-body-strong)"> FB</span>` : ""}</p>${amt && usd(amt) ? html`<p class="fiat">${usd(amt)}</p>` : ""}<p class="small">Expires in <span class="countdown">${left(s.expiresAt - Date.now())}</span></p></div></div>
      <div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">Stay unlocked until they finish</span>You don't confirm this payment. When they pay, this wallet adds your coin by itself, even while it is still finding coins. Locking deletes the link's keys. Closing the window is fine.</div></div>
      ${s.reservedValue ? html`<div class="kv"><div class="r"><span class="k">Coin you add</span><span class="v"><span class="mono">${fb(s.reservedValue)}</span><span class="cap">Reserved</span></span></div></div>` : ""}
      <div class="row"><button class="btn btn-secondary" type="button" data-act="copy-link">${I("copy", "s16")}Copy link</button><button class="btn btn-ghost" type="button" data-act="cancel-link" data-id="${s.id}">Cancel link</button></div>`
        : html`<p class="small muted">For payments from another PrivateBit user. You add one of your coins to their payment, so nobody watching the chain can tell which coins belong to whom.</p><div class="row"><button class="btn btn-secondary" type="button" data-act="go" data-to="paylink">${I("link-2", "s16")}Create payment link</button></div>`}
      ${pastSessions().length ? html`<div class="sec-h"><h2>History</h2></div>${historyList()}` : ""}</section>
  </div>`;
}
actions["save-qr"] = () => {
  const svg = document.querySelector(".qr svg");
  if (!svg) return;
  const blob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "privatebit-receive-code.svg";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

void go;
void back;
