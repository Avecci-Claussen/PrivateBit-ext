import { S, screens, actions, loaders, go, render, run, refresh, busy, err, toast } from "../app.ts";
import { call, type CoinView, type OneTimeRecord, type Fees } from "../api.ts";
import { html, I, UNIT, codeHi, fb, fbShort, sats, mid, num, ntag, type Safe, CHAIN_SHORT, CHAIN } from "../kit.ts";
import { hdr } from "../chrome.ts";
import { copyText } from "../copy.ts";
import { qrSvg } from "../qr.ts";
import { explorerBlock, pathPreview, txidLine } from "../path.ts";

type MStatus = { active: boolean; arrived: CoinView[]; lastHeight: number };
type OTCoin = { index: number; value: string; outpoint: string; address: string; height: number };
type OTView = { open?: OneTimeRecord; waiting?: OTCoin[] };
const step = (): string => (S.params.step as string | undefined) ?? "intro";
const ms = (): MStatus | undefined => S.d.mstatus as MStatus | undefined;
const ot = (): OTView => (S.d.onetime as OTView | undefined) ?? {};
const waiting = (): OTCoin[] => ot().waiting ?? [];

loaders.migrate = async () => {
  const [st, o] = await Promise.all([call<MStatus>({ type: "MIGRATE_STATUS" }), call<OTView>({ type: "ONETIME_VIEW" })]);
  S.d.mstatus = st;
  S.d.onetime = o;
  if (!S.params.step) {
    if (o.waiting?.length) S.params = { step: "sweep" };
    else if (st.active && st.arrived.length) S.params = { step: "done" };
    else if (st.active) S.params = { step: o.open ? "onetime" : "waiting" };
  }
  const coins = o.waiting ?? [];
  if (S.params.step === "sweep" && coins.length) await planSweep(coins[0]!.index);
};

async function planSweep(index: number): Promise<void> {
  let rate = 1;
  try {
    const f = await call<Fees>({ type: "FEE_RATES" });
    rate = f.normal;
  } catch {
    /* fall back to the relay minimum */
  }
  try {
    S.d.sweep = { ...(await call<{ fee: string; amount: string; vbytes: number; count: number }>({ type: "SWEEP_PLAN", index, feeRate: rate })), rate };
  } catch (e) {
    S.err.sweep = String((e as Error).message);
  }
}

const H = (): Safe => hdr({ title: "Move coins here" });

screens.migrate = () => {
  const code = S.b!.state.receive ?? "";
  const s = step();
  if (s === "waiting") {
    return {
      title: "Move coins here",
      header: H(),
      main: html`
  ${pathPreview({ title: "Your old wallet", sub: "Reused address" }, { title: "Your receive code", sub: `${code.slice(0, 8)} \u2026 ${code.slice(-8)}` })}
  <ol class="steps">
    <li class="step done"><span class="n">${I("check", "s16")}</span><div><p class="st">Code copied</p><p class="sd mono">${code.slice(0, 8)} \u2026 ${code.slice(-8)}</p></div></li>
    <li class="step done"><span class="n">${I("check", "s16")}</span><div><p class="st">Switch your old wallet to ${CHAIN()}</p></div></li>
    <li class="step now"><span class="n">3</span><div><p class="st">Waiting for your coins…</p><p class="sd">Checked up to block ${num(S.b!.state.lastHeight ?? 0)}. Fractal blocks come every 30 seconds.</p></div></li>
    <li class="step todo"><span class="n">4</span><div><p class="st">Stop using the old address</p></div></li></ol>
  <div class="card flat pad-sm" role="status"><div class="row">${I("refresh-cw", "s16 spin")}<span class="small">Looking at new blocks as they arrive…</span></div></div>
  <button class="link small" type="button" data-act="go" data-to="migrate" data-step="refused" data-st="c9adc4">My old wallet did not accept the code</button>`,
      foot: html`<button class="btn btn-secondary btn-block" type="button" data-act="home">Back to wallet</button>`,
    };
  }
  if (s === "refused") {
    const whole = S.f.mWhole === true;
    return {
      title: "Move coins here",
      header: H(),
      main: html`
  <div class="state" data-st="aa619b"><div class="big warn">${I("ban")}</div><h1>Your old wallet did not accept the code</h1><p>Some wallets cannot send to <span class="mono">sp1</span> receive codes yet. Nothing was sent and your coins are still at the old address.</p></div>
  <div class="opt-list">
    <button class="rowlink" type="button" data-act="onetime-issue"><span class="body"><span class="t row" data-st="f0abc1">Use a one-time address <span class="badge acc">Recommended</span></span><span class="d">A fresh address made from your recovery words, for this move only. Less private for this one transfer.</span></span><span class="v">${busy("ot") ? I("loader-circle", "s16 spin") : I("chevron-right", "s16")}</span></button>
    <button class="rowlink" type="button" data-act="toggle-m" data-k="mWhole"><span class="body"><span class="t">Check the code was pasted whole</span><span class="d">${code.length} characters, starts with ${code.slice(0, 5)}, ends with ${code.slice(-8)}.</span></span><span class="v">${I("chevron-right", "s16")}</span></button>
  </div>
  ${whole ? html`<div class="codebox"><p class="code">${codeHi(code)}</p></div>` : ""}
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}
  <p class="small muted">Do not send to an address you used before. That would link the coins again.</p>`,
      foot: html`<button class="btn btn-secondary btn-block" type="button" data-act="back">Back to steps</button>`,
    };
  }
  if (s === "onetime") {
    const o = ot().open;
    return {
      title: "One-time address",
      header: hdr({ title: "One-time address", net: true }),
      main: html`
  ${pathPreview({ title: "Your old wallet", sub: "Reused address" }, { title: "One-time address", sub: o ? mid(o.address, 8, 6) : "Taproot, this move only" })}
  <div class="banner warn" role="note">${I("triangle-alert", "s16")}<div><span class="bt">One payment, then move it</span>Your old wallet and anyone reading the chain can see this address. It is not your receive code. When the coins arrive, move them into the receive code. That does not hide where they came from, so they stay labeled Linked.</div></div>
  ${o ? html`<div class="qr">${qrSvg(o.address, "QR code of your one-time address")}</div>` : ""}
  <div class="codebox"><div class="row between">${ntag(`${CHAIN_SHORT()} one-time address`)}<span class="cap">This move only</span></div><p class="code" aria-label="One-time address">${o ? codeHi(o.address) : ""}</p></div>
  <ul class="small" data-st="2019ed">
    <li>Send the whole amount in one payment. A second payment to this same address ties the two together. Both can still be moved.</li>
    <li>Made from your recovery words, so your backup already covers it.</li>
    <li>After it is empty, make a new address if the old wallet still has coins. Do not send to an address you already emptied.</li></ul>
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}
  <p class="small muted">Make a new address only if you have not given this one to the other wallet yet. If a payment shows up at the old one later, PrivateBit asks you to move it into your receive code.</p>`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="copy-ot">${I("copy", "s16")}Copy one-time address</button><button class="btn btn-secondary btn-block" type="button" data-act="onetime-replace" ${busy("ot") ? html`aria-disabled="true"` : ""}>${busy("ot") ? html`${I("loader-circle", "s16 spin")}Making a new address…` : "Make a new address"}</button>`,
    };
  }
  if (s === "sweep") {
    const all = waiting();
    const here = all.filter((c) => c.index === all[0]?.index);
    const f = here[0];
    const sw = S.d.sweep as { fee: string; amount: string; vbytes: number; rate: number; count?: number } | undefined;
    if (!f) return { title: "Move coins here", header: H(), main: html`<p class="muted">Nothing is waiting at your one-time address.</p>`, foot: html`<button class="btn btn-secondary btn-block" type="button" data-act="home">Back to wallet</button>` };
    const n = here.length;
    const total = here.reduce((a, c) => a + BigInt(c.value), 0n);
    const other = all.length - n;
    return {
      title: "Move coins here",
      header: H(),
      main: html`
  <div class="state" data-st="aa619b"><div class="big">${I("circle-check")}</div><h1>${n > 1 ? `${n} payments arrived` : `${fbShort(f.value)} arrived`}</h1><p>${n > 1 ? "These payments are at the same one-time address, so they are tied together on chain. " : "This payment is at your one-time address. "}Move ${n > 1 ? "all of them" : "it"} into your receive code. ${n > 1 ? "They stay" : "It stays"} labeled Linked.</p></div>
  ${n > 1 ? html`<div class="banner warn" role="note">${I("triangle-alert", "s16")}<div><span class="bt">This address was used more than once</span>Send the next amount to a new one-time address, after these coins have moved.</div></div>` : ""}
  ${pathPreview({ title: "One-time address", sub: mid(f.address, 8, 6) }, { title: "Your receive code", sub: `${code.slice(0, 8)} \u2026 ${code.slice(-8)}` })}
  <div class="card"><div class="kv">
    ${here.map((c) => html`<div class="r"><span class="k">${c.height > 0 ? "Payment" : "Payment, not in a block yet"}</span><span class="v">${fbShort(c.value)}</span></div>`)}
    <div class="r"><span class="k">Network fee</span><span class="v">${sw ? html`<span class="mono">${sats(sw.fee)}</span><span class="cap">${sw.rate} sat/vB, ${sw.vbytes} vB${(sw.count ?? n) > 1 ? `, ${sw.count ?? n} payments in one move` : ""}</span>` : html`<span class="muted">${err("sweep") ? "Unavailable" : "Checking…"}</span>`}</span></div>
    ${sw ? html`<div class="r total"><span class="k">You keep</span><span class="v">${fb(sw.amount)}</span></div>` : html`<div class="r total"><span class="k">Arrived</span><span class="v">${fb(total)}</span></div>`}</div></div>
  <div class="codebox"><div class="row between">${ntag("This one-time address")}<span class="cap">Do not send here again</span></div><p class="code" aria-label="One-time address">${codeHi(f.address)}</p></div>
  ${err("sweep") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("sweep")}</span></p>` : ""}
  <p class="small muted">Moving empties this address. The coins land under your receive code and stay labeled Linked. ${other > 0 ? "Another one-time address still has a payment. It is next." : "If the old wallet still has coins, make a new address after this. Do not reuse this one."}</p>`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="sweep" ${sw && !busy("sweep") ? "" : html`aria-disabled="true"`}>${busy("sweep") ? html`${I("loader-circle", "s16 spin")}Moving…` : n > 1 ? "Move all into my receive code" : "Move into my receive code"}</button><button class="btn btn-ghost btn-block" type="button" data-act="home">Later</button>`,
    };
  }
  if (s === "done") {
    const arrived = ms()?.arrived ?? [];
    const total = arrived.reduce((a, c) => a + BigInt(c.value), 0n);
    const stop = S.f.mStop !== false;
    const sweepTxid = typeof S.d.sweepTxid === "string" ? S.d.sweepTxid : undefined;
    const ask = S.b!.prefs.askExplorer !== false;
    return {
      title: "Move coins here",
      header: H(),
      main: html`
  <div class="state"><div class="big">${I("circle-check")}</div><h1>Your coins are here</h1><p>${total > 0n ? `${fb(total)} is under your receive code. ` : ""}They came from a reused address, so they are labeled Linked. Spending a Linked coin together with a private coin links the two.</p></div>
  ${pathPreview({ title: "One-time address", sub: "Emptied" }, { title: "Your receive code", sub: `${code.slice(0, 8)} \u2026 ${code.slice(-8)}` })}
  ${sweepTxid ? html`<div class="card"><div class="kv">${txidLine(sweepTxid)}</div></div>${explorerBlock(S.f.explorerAsk === true, ask)}` : ""}
  <div class="card pad-sm"><label class="check"><input type="checkbox" data-f="mStop" ${stop ? html`checked` : ""}> <span>I will stop using the old wallet address</span></label></div>
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}
  <p class="small muted">More still in the old wallet? Make a new one-time address. The one you just emptied stays empty.</p>`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="migrate-finish">Done</button><button class="btn btn-secondary btn-block" type="button" data-act="onetime-replace" ${busy("ot") ? html`aria-disabled="true"` : ""}>${busy("ot") ? html`${I("loader-circle", "s16 spin")}Making a new address…` : "Make a new one-time address"}</button><button class="btn btn-ghost btn-block" type="button" data-act="migrate-see">See the coin</button>`,
    };
  }
  return {
    title: "Move coins here",
    header: H(),
    main: html`
  <div class="stack"><h2 data-st="9d50d4">Move coins from another wallet or a reused address</h2><p class="muted">Old addresses are public: anyone who has paid you there can see their balance and history. Moving the coins once and never using the old address again stops new links.</p></div>
  <div class="card pad-sm"><p class="strong">Where the coins should finish</p><p class="small">Under your receive code, the one that starts with <span class="mono">sp1</span>. If your old wallet can pay that code, send there once. If it cannot, PrivateBit gives you a one-time address. You send to that address once, then PrivateBit moves those coins into the receive code. That empties the one-time address. It is not used again.</p></div>
  ${pathPreview({ title: "Your old wallet", sub: "Reused address" }, { title: "Your receive code", sub: `${code.slice(0, 8)} \u2026 ${code.slice(-8)}` })}
  <ol class="steps">
    <li class="step now"><span class="n">1</span><div><p class="st">Copy your PrivateBit receive code</p><p class="sd">It starts with sp1 and is for ${CHAIN()}.</p></div></li>
    <li class="step todo"><span class="n">2</span><div><p class="st">In your old wallet, switch to ${CHAIN()} mainnet</p><p class="sd">Usually in its network menu.</p></div></li>
    <li class="step todo"><span class="n">3</span><div><p class="st">Send once</p><p class="sd">Paste the code in your old wallet. If it refuses the code, use a one-time address and send the whole amount in one payment.</p></div></li>
    <li class="step todo"><span class="n">4</span><div><p class="st">Stop using the old address</p><p class="sd">Coins that came from it stay labeled Linked. A new move needs a new one-time address, after the previous one is empty.</p></div></li></ol>
  <div class="banner warn">${I("triangle-alert", "s16")}<div>Holding inscriptions or tokens on that address? Do not send everything. Move only plain ${UNIT()}, or ask about inscriptions first.</div></div>`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="migrate-copy">${I("copy", "s16")}Copy my receive code</button>`,
  };
};

actions["toggle-m"] = (el) => {
  S.f[el.dataset.k!] = !S.f[el.dataset.k!];
  render();
};
actions["migrate-copy"] = async () => {
  await copyText(S.b!.state.receive ?? "");
  await call({ type: "MIGRATE_START" });
  toast("Code copied.");
  go("migrate", { step: "waiting" }, { replace: true });
};
actions["onetime-issue"] = async () => {
  const r = await run("ot", async () => {
    await call({ type: "MIGRATE_START" });
    return call<OneTimeRecord>({ type: "ONETIME_ISSUE" });
  });
  if (!r) return;
  go("migrate", { step: "onetime" });
};
actions["copy-ot"] = async () => {
  const o = ot().open ?? waiting()[0];
  if (!o) return;
  await copyText(o.address);
  toast("One-time address copied.");
};
actions["onetime-replace"] = async () => {
  const r = await run("ot", () => call<OneTimeRecord>({ type: "ONETIME_REPLACE" }));
  if (!r) return;
  toast("New one-time address ready.");
  go("migrate", { step: "onetime" }, { replace: true });
};
actions.sweep = async () => {
  const f = waiting()[0];
  const sw = S.d.sweep as { rate: number } | undefined;
  if (!f || !sw) return;
  const r = await run("sweep", () => call<{ kind?: string; txid?: string }>({ type: "SWEEP_ONETIME", index: f.index, feeRate: sw.rate }), "sweep");
  if (!r) return;
  if (r.txid) {
    S.d.sweepTxid = r.txid;
    S.d.exploreTxid = r.txid;
  }
  const view = await call<OTView>({ type: "ONETIME_VIEW" });
  S.d.onetime = view;
  await refresh();
  if ((view.waiting ?? []).length) {
    S.d.sweep = undefined;
    toast("Moved. Another payment is still at a one-time address.");
    go("migrate", { step: "sweep" }, { replace: true });
    return;
  }
  go("migrate", { step: "done" }, { replace: true });
};
actions["migrate-finish"] = async () => {
  await call({ type: "MIGRATE_FINISH", label: "Old wallet address" });
  await refresh();
  go("home", {}, { reset: true });
};
actions["migrate-see"] = async () => {
  await call({ type: "MIGRATE_FINISH", label: "Old wallet address" });
  const c = ms()?.arrived[0];
  if (c) go("coin-detail", { op: c.outpoint }, { reset: true });
  else go("coins", {}, { reset: true });
};

/** While the guide waits, move to the next step as soon as coins show up. */
export async function pollMigration(): Promise<void> {
  if (S.route !== "migrate") return;
  const s = step();
  if (s !== "waiting" && s !== "onetime" && s !== "sweep" && s !== "done") return;
  const prev = waiting().length;
  const [st, o] = await Promise.all([call<MStatus>({ type: "MIGRATE_STATUS" }), call<OTView>({ type: "ONETIME_VIEW" })]);
  S.d.mstatus = st;
  S.d.onetime = o;
  const n = o.waiting?.length ?? 0;
  if (n > 0 && (s !== "sweep" || n !== prev)) {
    go("migrate", { step: "sweep" }, { replace: true });
  } else if (s === "waiting" && st.arrived.length) {
    go("migrate", { step: "done" }, { replace: true });
  }
}
