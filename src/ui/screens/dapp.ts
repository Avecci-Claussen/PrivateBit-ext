/**
 * Connected websites: the approval popup a site opens (connect, sign, send, switch chain),
 * and the Connected sites list and detail in Settings.
 */
import { S, screens, actions, loaders, go, render, run, refresh, busy, err, toast, fv } from "../app.ts";
import { call, type Fees } from "../api.ts";
import { html, I, MARK, UNIT, codeHi, fb, fbShort, sats, mid, ntag, when, type Safe, CHAIN_SHORT, CHAIN } from "../kit.ts";
import { hdr } from "../chrome.ts";
import { copyText } from "../copy.ts";
import { messageRisks, visibleMessage } from "../../lib/message-check.ts";

type Owner = "site" | "private" | "other-site" | "unknown";
type Review = {
  inputs: { index: number; txid: string; vout: number; value: string | null; address?: string; owner: Owner; sign: boolean; sighash: number; script?: { leaf: string; version: number; key: string } }[];
  outputs: { index: number; value: string; address?: string; memo?: string; owner: Owner }[];
  toSign: number[];
  spent: string;
  returned: string;
  leaves: string;
  fee: string | null;
  warnings: string[];
  refuse?: string;
};
type PendingView = {
  id: string;
  origin: string;
  host: string;
  method: string;
  chain: { id: string; name: string };
  unlocked: boolean;
  address?: string;
  connected?: boolean;
  balance?: number;
  message?: { text: string; type: string };
  psbts?: Review[];
  send?: { to: string; amount: string; fee: string; change: string; memos: string[]; feeRate: number; error?: string };
  switchTo?: { id: string; name: string };
};
export type SiteView = { origin: string; connected: boolean; connectedAt: number; lastUsed?: number; address: string; path: string; balance: number; coins: number };

export const ARM_MS = 800;
const pv = (): PendingView | undefined => S.d.dappView as PendingView | undefined;
const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

loaders.dapp = async () => {
  S.err.dapp = "";
  try {
    S.d.dappView = await call<PendingView>({ type: "DAPP_VIEW", id: S.dappId });
    // Audit F-05: the approve button arms a moment after the review appears, so a click or tap
    // meant for the site cannot land on it when the window opens under the pointer.
    S.d.dappArmed = false;
    setTimeout(() => {
      S.d.dappArmed = true;
      render();
    }, ARM_MS);
  } catch (e) {
    S.d.dappView = undefined;
    S.err.dapp = String((e as Error).message);
  }
  render();
};

function siteHeader(v: PendingView, title: string): Safe {
  return html`<header class="hdr">${MARK(24, false)}<h1 class="hdr-title">${title}</h1>${ntag(v.chain.name)}</header>`;
}

function originCard(v: PendingView): Safe {
  return html`<div class="card flat pad-sm site-origin"><div class="row">${I("globe", "s16")}<span class="body grow"><span class="strong mono" data-st="0ca0d0">${v.host}</span><span class="small muted">${v.origin.startsWith("https:") ? "Secure connection" : "Not a secure connection (http)"}</span></span></div></div>`;
}

function accountRow(v: PendingView): Safe {
  return v.address
    ? html`<div class="r"><span class="k">Site account</span><span class="v"><span class="mono">${mid(v.address, 10, 6)}</span><span class="cap">${v.balance !== undefined ? `${fbShort(v.balance)} in this site's account` : ""}</span></span></div>`
    : html``;
}

const done = (title: string, body: string): Safe => html`<div class="state"><div class="big">${I("circle-check")}</div><h1>${title}</h1><p>${body}</p></div>`;

function reviewBlock(r: Review, n: number, of: number): Safe {
  const spent = BigInt(r.spent);
  const back = BigInt(r.returned);
  const fee = r.fee === null ? null : BigInt(r.fee);
  const mine = r.inputs.filter((x) => x.sign);
  const notMine = r.inputs.filter((x) => !x.sign);
  const out = r.outputs.filter((o) => o.owner !== "site");
  const net = spent - back;
  return html`<section class="stack" aria-label="Transaction ${n} of ${of}">
  ${of > 1 ? html`<p class="io-h">Transaction ${n} of ${of}</p>` : ""}
  ${r.refuse ? html`<div class="banner danger" role="alert">${I("ban", "s16")}<div><span class="bt">PrivateBit will not sign this</span>${r.refuse}</div></div>` : ""}
  <div class="hero-amt"><p class="cap">Leaves this site's account</p><p class="a">${fb(net > 0n ? net : 0n, { unit: false })}<span class="unit"> ${UNIT()}</span></p><p class="fiat">${sats(net > 0n ? net : 0n)}${fee !== null ? ", network fee included" : ""}</p></div>
  <div class="card"><div class="kv">
    <div class="r"><span class="k">You sign</span><span class="v"><span>${mine.length} ${mine.length === 1 ? "input" : "inputs"}, ${fb(spent)}</span><span class="cap">${mine.some((x) => x.script) ? "From this site's account and scripts that name its key" : "From this site's account only"}</span></span></div>
    ${notMine.length ? html`<div class="r"><span class="k">Not yours</span><span class="v"><span>${notMine.length} ${notMine.length === 1 ? "input" : "inputs"}</span><span class="cap">Added by the site or someone else. You do not sign ${notMine.length === 1 ? "it" : "them"}.</span></span></div>` : ""}
    ${back > 0n ? html`<div class="r"><span class="k">Back to the site account</span><span class="v mono">${fb(back)}</span></div>` : ""}
    <div class="r"><span class="k">Network fee</span><span class="v">${fee === null ? html`<span class="muted">Unknown. Some inputs have no amount.</span>` : html`<span class="mono">${sats(fee)}</span>`}</span></div>
  </div></div>
  <p class="io-h">Goes to</p>
  <div class="io">${out.length ? out.map((o) => html`<div class="io-row"><span class="badge ${o.memo !== undefined ? "" : "warn"}">${o.memo !== undefined ? "Note" : "Leaves"}</span><span class="code">${o.memo !== undefined ? o.memo : mid(o.address ?? "Unknown script", 10, 6)}</span><span class="amt">${fb(o.value)}</span></div>`) : html`<div class="io-row"><span class="code">Nothing leaves</span></div>`}</div>
  ${r.warnings.length ? html`<div class="banner warn" role="note">${I("triangle-alert", "s16")}<div><span class="bt">Check before signing</span>${r.warnings.join(" ")}</div></div>` : ""}
  <details class="card pad-sm"><summary class="small strong" data-st="3b6a3a">All inputs and outputs</summary><div class="stack" data-st="56f435">
    <p class="io-h">Inputs</p><div class="io">${r.inputs.map((x) => html`<div class="io-row"><span class="badge ${x.sign ? (x.script ? "warn" : "ok") : ""}">${x.sign ? (x.script ? "You sign a script" : "You sign") : "Not yours"}</span><span class="code">${mid(`${x.txid}:${x.vout}`, 10, 4)}</span><span class="amt">${x.value === null ? "?" : fb(x.value)}</span></div>`)}</div>
    <p class="io-h">Outputs</p><div class="io">${r.outputs.map((o) => html`<div class="io-row"><span class="badge ${o.owner === "site" ? "ok" : ""}">${o.owner === "site" ? "Site account" : o.memo !== undefined ? "Note" : "Leaves"}</span><span class="code">${o.memo ?? mid(o.address ?? "Unknown script", 10, 6)}</span><span class="amt">${fb(o.value)}</span></div>`)}</div>
  </div></details>
</section>`;
}

screens.dapp = () => {
  const v = pv();
  const closeFoot = html`<button class="btn btn-secondary btn-block" type="button" data-act="dapp-close">Close</button>`;
  if (S.d.dappDone) {
    const d = S.d.dappDone as { title: string; body: string };
    return { title: d.title, solo: true, main: done(d.title, d.body), foot: closeFoot };
  }
  if (!v) {
    return {
      title: "Website request",
      solo: true,
      main: err("dapp")
        ? html`<div class="state"><div class="big neutral">${I("unplug")}</div><h1>Nothing to approve</h1><p>${err("dapp")}</p></div>`
        : html`<div class="state"><div class="big neutral">${I("loader-circle", "spin")}</div></div>`,
      foot: err("dapp") ? closeFoot : undefined,
    };
  }
  const pending = busy("dapp");
  const buttons = (label: string, ok = true): Safe =>
    html`<button class="btn btn-secondary" type="button" data-act="dapp-reject" ${pending ? html`aria-disabled="true"` : ""}>Reject</button><button class="btn btn-primary" type="button" data-act="dapp-approve" ${ok && !pending && S.d.dappArmed === true ? "" : html`disabled aria-disabled="true"`}>${pending ? html`${I("loader-circle", "s16 spin")}Working…` : label}</button>`;
  const errBox = err("dappAct") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("dappAct")}</span></p>` : "";

  if (v.method === "requestAccounts") {
    return {
      title: "Connect",
      header: siteHeader(v, "Connect to this site?"),
      main: html`${originCard(v)}
  <div class="card"><p class="small strong" data-st="df6718">The site will see</p>
    <ul class="checks"><li>${I("check", "s16")}<span>Its own ${CHAIN_SHORT()} account address and balance. PrivateBit makes a separate account for each site.</span></li>
    <li>${I("check", "s16")}<span>Which chain you are on.</span></li></ul>
    <p class="small strong" data-st="dcdaf5">The site will not see</p>
    <ul class="checks no"><li>${I("eye-off", "s16")}<span>Your receive code, your private coins or your balance.</span></li>
    <li>${I("eye-off", "s16")}<span>Other sites' accounts or this wallet's name.</span></li></ul></div>
  <p class="small muted">Every payment or signature still opens a review here. You can disconnect in Settings, Connected sites.</p>${errBox}`,
      foot: { cls: "row", html: buttons("Connect") },
    };
  }
  if (v.method === "signMessage" && v.message) {
    return {
      title: "Sign message",
      header: siteHeader(v, "Sign a message"),
      main: html`${originCard(v)}
  <div class="field"><p class="label">Message, exactly as signed</p><pre class="msgbox" tabindex="0" aria-label="Message to sign">${visibleMessage(v.message.text)}</pre></div>
  ${messageRisks(v.message.text).length ? html`<div class="banner warn" role="alert">${I("triangle-alert", "s16")}<div><span class="bt">Check before signing</span>${messageRisks(v.message.text).join(" ")}</div></div>` : ""}
  <div class="card"><div class="kv">${accountRow(v)}<div class="r"><span class="k">Signature type</span><span class="v">${v.message.type === "bip322-simple" ? "BIP322" : "Standard message signature"}</span></div></div></div>
  <p class="small muted">Signing proves you control this site's account. It moves no coins. Only sign text you understand.</p>${errBox}`,
      foot: { cls: "row", html: buttons("Sign") },
    };
  }
  if ((v.method === "signPsbt" || v.method === "signPsbts") && v.psbts) {
    const refused = v.psbts.some((r) => r.refuse);
    return {
      title: "Sign transaction",
      header: siteHeader(v, v.psbts.length > 1 ? `Sign ${v.psbts.length} transactions` : "Sign a transaction"),
      main: html`${originCard(v)}
  <div class="card"><div class="kv">${accountRow(v)}<div class="r"><span class="k">Chain</span><span class="v">${ntag(v.chain.name)}</span></div></div></div>
  ${v.psbts.map((r, i) => reviewBlock(r, i + 1, v.psbts!.length))}
  <p class="small muted">Only this site's account signs. Your private coins are never part of a site's transaction.</p>${errBox}`,
      foot: { cls: "row", html: buttons(v.psbts.length > 1 ? "Sign all" : "Sign", !refused) },
    };
  }
  if (v.method === "sendBitcoin" && v.send) {
    const s = v.send;
    const ok = !s.error;
    return {
      title: "Send",
      header: siteHeader(v, "Send from the site account"),
      main: html`${originCard(v)}
  ${s.error ? html`<div class="banner danger" role="alert">${I("ban", "s16")}<div><span class="bt">This payment cannot be made</span>${s.error}</div></div>` : ""}
  ${!s.error && highFee(BigInt(s.amount), BigInt(s.fee), s.feeRate) ? html`<div class="banner warn" role="alert">${I("triangle-alert", "s16")}<div><span class="bt">The fee is unusually high</span>The site asked for ${s.feeRate} sat/vB. That is ${sats(s.fee)}, a large share of this payment. Reject if you did not expect it.</div></div>` : ""}
  <div class="hero-amt"><p class="cap">You send</p><p class="a">${fb(s.amount, { unit: false })}<span class="unit"> ${UNIT()}</span></p><p class="fiat">${sats(s.amount)}</p></div>
  <div class="card"><div class="kv">
    <div class="r"><span class="k">To</span><span class="v"><span class="mono" data-st="752397">${codeHi(s.to, 8, 8)}</span></span></div>
    ${accountRow(v)}
    <div class="r"><span class="k">Network fee</span><span class="v"><span class="mono">${sats(s.fee)}</span><span class="cap">${s.feeRate} sat/vB</span></span></div>
    ${BigInt(s.change) > 0n ? html`<div class="r"><span class="k">Back to the site account</span><span class="v mono">${fb(s.change)}</span></div>` : ""}
    ${s.memos.length ? html`<div class="r"><span class="k">Note on chain</span><span class="v">${s.memos.join(", ")}</span></div>` : ""}
    <div class="r total"><span class="k">Total leaving</span><span class="v">${fb(BigInt(s.amount) + BigInt(s.fee))}</span></div></div></div>
  <p class="small muted">Paid from this site's account only. Payments on ${CHAIN()} cannot be reversed.</p>${errBox}`,
      foot: { cls: "row", html: buttons(`Send ${fb(s.amount, { trim: true })}`, ok) },
    };
  }
  if (v.method === "switchChain" && v.switchTo) {
    return {
      title: "Switch chain",
      header: siteHeader(v, `Switch to ${v.switchTo.name}?`),
      main: html`${originCard(v)}
  <div class="card"><div class="kv"><div class="r"><span class="k">Now</span><span class="v">${ntag(v.chain.name)}</span></div><div class="r"><span class="k">After</span><span class="v">${ntag(v.switchTo.name)}</span></div></div></div>
  <p class="small muted">The whole wallet switches, for every site. The site gets its own account on ${v.switchTo.name}, separate from the one on ${v.chain.name}.</p>${errBox}`,
      foot: { cls: "row", html: buttons("Switch") },
    };
  }
  return { title: "Website request", solo: true, main: html`<div class="state"><div class="big neutral">${I("loader-circle", "spin")}</div></div>` };
};

async function decide(approve: boolean): Promise<void> {
  const v = pv();
  if (!v) return;
  S.err.dappAct = "";
  const ok = await run(
    "dapp",
    async () => {
      await call({ type: "DAPP_DECIDE", id: v.id, approve });
      return true;
    },
    "dappAct",
  );
  if (!ok) return;
  if (!approve) {
    window.close();
    return;
  }
  const titles: Record<string, [string, string]> = {
    requestAccounts: ["Connected", `${v.host} has its own account now. You can go back to the site.`],
    signMessage: ["Signed", "The signature went back to the site."],
    signPsbt: ["Signed", "The signed transaction went back to the site."],
    signPsbts: ["Signed", "The signed transactions went back to the site."],
    sendBitcoin: ["Sent", "The payment was broadcast from the site account."],
    switchChain: ["Switched", `The wallet is on ${v.switchTo?.name ?? "the other chain"} now.`],
  };
  const t = titles[v.method] ?? ["Done", ""];
  S.d.dappDone = { title: t[0], body: t[1] };
  render();
  setTimeout(() => window.close(), 1200);
}
actions["dapp-approve"] = () => decide(true);
actions["dapp-reject"] = () => decide(false);
actions["dapp-close"] = () => window.close();

/* ---------- Settings: connected sites ---------- */

const sites = (): SiteView[] => (S.d.sites as SiteView[] | undefined) ?? [];
loaders["set-sites"] = async () => {
  try {
    S.d.sites = await call<SiteView[]>({ type: "DAPP_SITES" });
  } catch (e) {
    S.err.sites = String((e as Error).message);
  }
  render();
};
loaders["site-detail"] = async () => {
  await loaders["set-sites"]!();
  S.d.siteMove = undefined;
};

export function sitesList(): Safe {
  const list = sites();
  if (!list.length) {
    return html`<div class="card flat pad-sm"><div class="row">${I("globe", "s16")}<span class="small muted">No sites yet. When a site asks to connect, PrivateBit opens a window to approve it.</span></div></div>`;
  }
  return html`<div class="list" aria-label="Connected sites">${list.map(
    (s) => html`<a class="li" href="#" data-act="go" data-to="site-detail" data-origin="${s.origin}"><span class="ico">${I(s.connected ? "globe" : "unplug")}</span><span class="body"><span class="t">${hostOf(s.origin)}</span><span class="d">${s.connected ? "Connected" : "Disconnected"}, ${s.balance > 0 ? fbShort(s.balance) : "empty"}</span></span>${I("chevron-right", "s16 chev")}</a>`,
  )}</div>`;
}

export function sitesIntro(): Safe {
  return html`<p class="small muted">Each site gets its own account, made from your recovery words. Sites never see your receive code, your private coins or each other. Moving coins between a site account and your private coins is a normal payment you approve, and it links the two on chain.</p>`;
}

screens["set-sites"] = () => ({
  title: "Connected sites",
  header: hdr({ title: "Connected sites" }),
  main: html`${sitesIntro()}${sitesList()}${err("sites") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("sites")}</span></p>` : ""}${findSiteForm()}`,
});

/** Audit M3 (independent): find a site's account again from its web address. */
export function findSiteForm(): Safe {
  return html`<div class="field"><label class="label" for="findsite">Find a site's account</label><div class="row"><input class="input mono" id="findsite" data-f="findsite" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://app.example.com" value="${fv("findsite")}" aria-describedby="findsite-h"><button class="btn btn-secondary btn-sm" type="button" data-act="site-find">${busy("sfind") ? I("loader-circle", "s16 spin") : "Find"}</button></div>${err("sfind") ? html`<p class="err" id="findsite-h" role="alert">${I("circle-alert", "s16")}<span>${err("sfind")}</span></p>` : html`<p class="help" id="findsite-h">After a restore, a site's account comes back when you connect to it again, or here with its exact address. The site gets no access. Coins it received before today show after a scan from an earlier start block.</p>`}</div>`;
}

actions["site-find"] = async () => {
  const raw = fv("findsite").trim();
  let origin = "";
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    origin = u.origin;
  } catch {
    S.err.sfind = "Enter a web address, such as https://app.example.com.";
    render();
    return;
  }
  const got = await run("sfind", () => call<SiteView[]>({ type: "DAPP_FIND_SITE", origin }), "sfind");
  if (!got) return;
  S.d.sites = got;
  S.f.findsite = "";
  toast(`Watching the account for ${hostOf(origin)}.`);
  render();
};

const curSite = (): SiteView | undefined => sites().find((s) => s.origin === S.params.origin);

screens["site-detail"] = () => {
  const s = curSite();
  if (!s) return { title: "Site", header: hdr({ title: "Site" }), main: html`<div class="state"><div class="big neutral">${I("loader-circle", "spin")}</div></div>` };
  const mv = S.d.siteMove as { fee: string; amount: string; vbytes: number; rate: number } | undefined;
  const host = hostOf(s.origin);
  return {
    title: host,
    header: hdr({ title: host, net: true }),
    main: html`
  <div class="card"><div class="kv">
    <div class="r"><span class="k">Status</span><span class="v">${s.connected ? html`<span class="badge ok">${I("globe")}Connected</span>` : html`<span class="badge">${I("unplug")}Disconnected</span>`}<span class="cap">Since ${when(s.connectedAt)}</span></span></div>
    <div class="r"><span class="k">Balance</span><span class="v"><span class="mono">${fb(s.balance)}</span><span class="cap">${s.coins} ${s.coins === 1 ? "coin" : "coins"}, not part of your private balance</span></span></div>
    <div class="r"><span class="k">Path</span><span class="v mono small">${s.path}</span></div>
  </div></div>
  <div class="codebox"><div class="row between">${ntag(`${CHAIN_SHORT()} site account`)}<button class="link small" type="button" data-act="site-copy">Copy</button></div><p class="code" aria-label="Site account address">${codeHi(s.address)}</p></div>
  ${mv ? html`<div class="banner warn" role="note">${I("triangle-alert", "s16")}<div><span class="bt">Move ${fbShort(mv.amount)} back to private</span>Network fee ${sats(mv.fee)} at ${mv.rate} sat/vB. The coins land under your receive code, labeled Linked, because the chain shows they came from this site's account.
    <div class="row" data-st="47cabb"><button class="btn btn-primary btn-sm" type="button" data-act="site-move-go" ${busy("smove") ? html`aria-disabled="true"` : ""}>${busy("smove") ? html`${I("loader-circle", "s16 spin")}Moving…` : "Move now"}</button><button class="btn btn-ghost btn-sm" type="button" data-act="site-move-cancel">Cancel</button></div></div></div>` : ""}
  ${err("smove") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("smove")}</span></p>` : ""}
  <div class="opt-list">
    <button class="rowlink" type="button" data-act="site-fund"><span class="body"><span class="t">Add funds</span><span class="d">Pay this site's account from your private coins. Shows on chain as a payment from you to this address.</span></span><span class="v">${I("chevron-right", "s16")}</span></button>
    ${s.balance > 0 ? html`<button class="rowlink" type="button" data-act="site-move"><span class="body"><span class="t">Move back to private</span><span class="d">Send everything in this site's account to your receive code.</span></span><span class="v">${busy("smplan") ? I("loader-circle", "s16 spin") : I("chevron-right", "s16")}</span></button>` : ""}
  </div>
  <p class="small muted">Coins sent to this address before you restored this wallet show up after Finding coins looks back far enough.</p>`,
    foot: s.connected
      ? html`<button class="btn btn-danger-outline btn-block" type="button" data-act="site-disconnect">Disconnect ${host}</button>`
      : s.balance === 0
        ? html`<button class="btn btn-secondary btn-block" type="button" data-act="site-forget">${I("trash-2", "s16")}Remove from this list</button>`
        : undefined,
  };
};

actions["site-copy"] = async () => {
  const s = curSite();
  if (!s) return;
  await copyText(s.address);
  toast("Site account address copied");
};
actions["site-disconnect"] = async () => {
  const s = curSite();
  if (!s) return;
  const r = await run("sdis", () => call<SiteView[]>({ type: "DAPP_DISCONNECT", origin: s.origin }), "smove");
  if (!r) return;
  S.d.sites = r;
  toast(`${hostOf(s.origin)} disconnected`);
  render();
};
actions["site-forget"] = async () => {
  const s = curSite();
  if (!s) return;
  const r = await run("sdis", () => call<SiteView[]>({ type: "DAPP_FORGET", origin: s.origin }), "smove");
  if (!r) return;
  S.d.sites = r;
  go("set-sites", {}, { replace: true });
};
actions["site-fund"] = () => {
  const s = curSite();
  if (!s) return;
  const host = hostOf(s.origin);
  S.f.to = s.address;
  S.f.lbl = `Moved to site account ${host}`;
  S.f.siteFund = host;
  go("send");
};
actions["site-move"] = async () => {
  const s = curSite();
  if (!s) return;
  let rate = 2;
  try {
    rate = (await call<Fees>({ type: "FEE_RATES" })).normal || 2;
  } catch {
    /* relay minimum */
  }
  const r = await run("smplan", () => call<{ fee: string; amount: string; vbytes: number }>({ type: "SITE_MOVE_PLAN", origin: s.origin, feeRate: rate }), "smove");
  if (!r) return;
  S.d.siteMove = { ...r, rate };
  render();
};
actions["site-move-cancel"] = () => {
  S.d.siteMove = undefined;
  render();
};
actions["site-move-go"] = async () => {
  const s = curSite();
  const mv = S.d.siteMove as { rate: number } | undefined;
  if (!s || !mv) return;
  const r = await run("smove", () => call({ type: "SITE_MOVE", origin: s.origin, feeRate: mv.rate }), "smove");
  if (!r) return;
  S.d.siteMove = undefined;
  await refresh();
  await loaders["set-sites"]!();
  toast(`Moved to your receive code`);
};

// The full page shows the site list inside Settings.
loaders.settings = async () => {
  if (S.mode === "full") await loaders["set-sites"]!();
};

/** Audit L2 (independent): a fee above 10% of the amount, or above 200 sat/vB, is called out. */
export function highFee(amount: bigint, fee: bigint, feeRate: number): boolean {
  return fee * 10n > amount || feeRate > 200;
}
