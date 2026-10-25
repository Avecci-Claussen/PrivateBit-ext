import { S, screens, actions, loaders, go, back, render, run, refresh, fv, busy, err, toast } from "../app.ts";
import { call, type SessionView, type CoinView } from "../api.ts";
import { html, I, MARK, NETLOGO, codeHi, fbShort, fb, parseFb, left, when, type Safe, UNIT, CHAIN, CHAIN_SHORT } from "../kit.ts";
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
  <div class="codebox"><div class="row between">${ntagF(`${CHAIN_SHORT()} receive code`)}<span class="cap">Reusable</span></div><p class="code" aria-label="Receive code">${codeHi(code)}</p></div>
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
/** Open = the background says it can still be cancelled. One rule for every screen. */
function isOpen(s: SessionView): boolean {
  return s.cancellable === true && (s.deadline ?? s.expiresAt) > Date.now();
}
function liveReceive(): SessionView | undefined {
  return sessions().find((s) => s.role === "receive" && isOpen(s));
}
function opened(): SessionView | undefined {
  const id = typeof S.params.id === "string" ? S.params.id : undefined;
  return id ? sessions().find((s) => s.id === id) : undefined;
}
function pastSessions(): SessionView[] {
  const live = liveReceive();
  return sessions().filter((s) => !(live && s.id === live.id) && !isOpen(s));
}
function outcome(s: SessionView): { label: string; cls: string } {
  const e = s.error ?? "";
  if (s.status === "done") return { label: s.role === "send" ? "Sent" : "Received", cls: "ok" };
  if (/cancel/i.test(e)) return { label: "Cancelled", cls: "" };
  if (/not broadcast/i.test(e)) return { label: "Not sent", cls: "" };
  if (/^refused/i.test(e)) return { label: "Refused", cls: "" };
  if (/expired/i.test(e)) return { label: "Expired", cls: "" };
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
type Why = "locked" | "expired" | "cancelled" | "notsent" | "switched" | "refused" | "other";
function failedReason(s: SessionView): Why {
  const e = s.error ?? "";
  if (/not broadcast/i.test(e)) return "notsent";
  if (/wallet switched/i.test(e)) return "switched";
  if (/^refused/i.test(e)) return "refused";
  if (/expired/i.test(e)) return "expired";
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
  <div class="stack"><h2 data-st="9d50d4">Get paid with Payjoin</h2><p class="muted">For payments from another PrivateBit user. You add one of your coins to their payment, so nobody watching the chain can tell which coins belong to whom.</p></div>
  <div class="field" data-enter="pj-create"><label class="label" for="amt">Amount <span class="optl">(optional)</span></label><div class="input-wrap"><input class="input mono" id="amt" data-f="pjAmt" data-live inputmode="decimal" autocomplete="off" value="${a}" placeholder="0.00" ${bad ? html`aria-invalid="true" aria-describedby="amt-e"` : html`aria-describedby="amt-h"`}><span class="unit">${UNIT()}</span></div>
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
  <div class="banner">${I("info", "s16")}<div><span class="bt">Keeps going after Lock</span>You don't confirm this payment. When they pay, this wallet adds your coin by itself, even while locked or still finding coins, with a key for that one coin only. Closing the window is fine. Quitting the browser ends the link.</div></div>
  <div class="card"><div class="linkcard"><div class="qr sm">${qrSvg(link, "QR code of your payment link")}</div>
    <div class="stack" data-st="8b59db">${ntagF("Payment link")}<p data-st="bae746">${amt ? fbShort(amt, { unit: false }) : "Any amount"}${amt ? html`<span class="muted" data-st="a86c96"> ${UNIT()}</span>` : ""}</p>${amt && usd(amt) ? html`<p class="fiat">${usd(amt)}</p>` : ""}
    <p class="small row" data-st="2488b1">${I("hourglass", "s16")}<span>Waiting<br><span class="muted">Expires in </span><span class="countdown" data-st="86abda">${left(s.expiresAt - Date.now())}</span></span></p></div></div></div>
  <div class="codebox"><p class="code code-link ${full ? "" : "clamp4 clamp3"}">${link}</p><div class="row between"><button class="link small" type="button" data-act="toggle-r" data-k="pjFull">${full ? "Show less" : "Show full link"}</button></div></div>
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
  <div class="hero-amt"><p class="cap">Incoming</p><p class="a">${amt ? fbShort(amt, { unit: false }) : "Payment"}${amt ? html`<span class="unit"> ${UNIT()}</span>` : ""}</p>${amt && usd(amt) ? html`<p class="fiat">${usd(amt)}</p>` : ""}</div>
  ${pathPreview({ title: "Them", sub: "They sent their part, encrypted" }, { title: "You", sub: "Your coin is added and signed" })}
  <ol class="steps" aria-label="Payment progress">
    <li class="step done"><span class="n">${I("check", "s16")}</span><div><p class="st">Link shared</p><p class="sd">${when(s.createdAt)}</p></div></li>
    <li class="step done"><span class="n">${I("check", "s16")}</span><div><p class="st">Payer sent their part</p><p class="sd">Encrypted. The mailbox could not read it.</p></div></li>
    <li class="step done"><span class="n">${I("check", "s16")}</span><div><p class="st">Your coin added and signed</p><p class="sd">Done in the background.</p></div></li>
    <li class="step now" aria-current="step"><span class="n">4</span><div><p class="st">Payer broadcasts</p><p class="sd">They have <span class="countdown">${left((s.deadline ?? s.expiresAt) - Date.now())}</span> left. Then the payment shows in Activity.</p></div></li>
  </ol>
  <p class="small muted">If they do not broadcast in time, this link ends and your coin is free again. Cancel link ends it right away. If they broadcast later anyway, the payment still shows up here.</p>`,
    foot: { cls: "row", html: html`<button class="btn btn-secondary" type="button" data-act="home">Back to wallet</button><button class="btn btn-ghost" type="button" data-act="cancel-link" data-id="${s.id}">Cancel link</button>` },
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
  if (why === "expired" || why === "notsent") {
    return {
      title: "Payment link",
      header: H,
      main: html`<div class="state"><div class="big neutral">${I("timer")}</div><h1>${why === "notsent" ? "Payment not sent" : "Link expired"}</h1><p>${why === "notsent" ? "The payer did not broadcast in time. Nothing was sent." : "Nobody paid within 24 hours."} ${coin} is available again.</p></div>
  ${why === "notsent" ? html`<p class="small muted">If they broadcast later, the payment still shows up in Activity and this link turns to Received.</p>` : ""}`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="pj-back">Back</button>`,
    };
  }
  const because: Record<Why, string> = {
    locked: "PrivateBit was locked while the link was waiting, which deleted its keys.",
    cancelled: "You cancelled it.",
    switched: "You switched to another wallet while it was open, which ended it.",
    refused: "Their payment did not pass PrivateBit's checks, so your coin was not added.",
    expired: "",
    notsent: "",
    other: `It failed: ${s.error ?? "unknown error"}.`,
  };
  const reason: Record<Why, string> = { locked: "Keys deleted by Lock", cancelled: "Cancelled", switched: "Wallet switched", refused: "Payment refused", expired: "", notsent: "", other: "Error" };
  return {
    title: "Payment link",
    header: H,
    main: html`
  <div class="state"><div class="big danger">${I("circle-x")}</div><h1>This payment link stopped working</h1><p>${because[why]} No coins moved.</p></div>
  <div class="card"><div class="kv">
    <div class="r"><span class="k">Created</span><span class="v">${when(s.createdAt)}</span></div>
    <div class="r"><span class="k">Reason</span><span class="v">${reason[why]}</span></div>
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
  if (s.role === "receive" && s.status === "proposed" && isOpen(s)) return progress(s, H);
  if (s.role === "receive" && s.status === "waiting" && isOpen(s)) return waiting(s, H);
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
  return html`<div class="topbar"><h1>Receive</h1><span class="cap row" data-st="f0abc1">${NETLOGO()}On ${CHAIN()}</span></div>
  <div class="grid2">
    <section class="panel" aria-labelledby="rc-h"><div class="row between"><h2 id="rc-h">Your receive code</h2><span class="cap">Reusable</span></div>
      <div class="qr" data-st="7754d2"><div data-st="80e561">${qrSvg(code.toUpperCase(), "QR code of your receive code")}</div>${qmark()}</div>
      <p class="code" aria-label="Receive code">${codeHi(code)}</p>
      <p class="small"><strong>Safe to share and reuse.</strong> Each payment lands at a new address only this wallet can find.</p>
      <div class="row"><button class="btn btn-primary" type="button" data-act="copy-receive">${I("copy", "s16")}Copy code</button><button class="btn btn-secondary" type="button" data-act="save-qr">${I("download", "s16")}Save QR</button></div></section>
    <section class="panel" aria-labelledby="pl-h"><div class="row between"><h2 id="pl-h">Payment link</h2>${s ? html`<span class="badge warn">${I(s.status === "proposed" ? "loader-circle" : "hourglass", s.status === "proposed" ? "spin" : "")}${s.status === "proposed" ? "Payer is finishing" : "Waiting"}</span>` : ""}</div>
      ${s
        ? html`<div class="linkcard"><div class="qr sm">${qrSvg(s.bip21 ?? "", "QR code of your payment link")}</div><div class="stack" data-st="f0abc1">${ntagF("Payment link")}<p data-st="352cd5">${amt ? fbShort(amt, { unit: false }) : "Any amount"}${amt ? html`<span class="muted" data-st="a86c96"> ${UNIT()}</span>` : ""}</p>${amt && usd(amt) ? html`<p class="fiat">${usd(amt)}</p>` : ""}<p class="small">${s.status === "proposed" ? "Payer has " : "Expires in "}<span class="countdown">${left((s.deadline ?? s.expiresAt) - Date.now())}</span>${s.status === "proposed" ? " to broadcast" : ""}</p></div></div>
      <div class="banner">${I("info", "s16")}<div><span class="bt">Keeps going after Lock</span>You don't confirm this payment. When they pay, this wallet adds your coin by itself, even while locked or still finding coins, with a key for that one coin only. Closing the window is fine. Quitting the browser ends the link.</div></div>
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
