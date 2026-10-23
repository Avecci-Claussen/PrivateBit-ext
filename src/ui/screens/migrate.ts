import { S, screens, actions, loaders, go, render, run, refresh, busy, err, toast } from "../app.ts";
import { call, type CoinView, type OneTimeRecord, type Fees } from "../api.ts";
import { html, I, codeHi, fb, fbShort, sats, mid, num, ntag, type Safe } from "../kit.ts";
import { hdr } from "../chrome.ts";
import { copyText } from "../copy.ts";

type MStatus = { active: boolean; arrived: CoinView[]; lastHeight: number };
type OTView = { open?: OneTimeRecord; funded?: { index: number; value: string; outpoint: string; address: string } };
const step = (): string => (S.params.step as string | undefined) ?? "intro";
const ms = (): MStatus | undefined => S.d.mstatus as MStatus | undefined;
const ot = (): OTView => (S.d.onetime as OTView | undefined) ?? {};

loaders.migrate = async () => {
  const [st, o] = await Promise.all([call<MStatus>({ type: "MIGRATE_STATUS" }), call<OTView>({ type: "ONETIME_VIEW" })]);
  S.d.mstatus = st;
  S.d.onetime = o;
  if (!S.params.step) {
    if (o.funded) S.params = { step: "sweep" };
    else if (st.active && st.arrived.length) S.params = { step: "done" };
    else if (st.active) S.params = { step: o.open ? "onetime" : "waiting" };
  }
  if (S.params.step === "sweep" && o.funded) await planSweep(o.funded.index);
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
    S.d.sweep = { ...(await call<{ fee: string; amount: string; vbytes: number }>({ type: "SWEEP_PLAN", index, feeRate: rate })), rate };
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
  <ol class="steps">
    <li class="step done"><span class="n">${I("check", "s16")}</span><div><p class="st">Code copied</p><p class="sd mono">${code.slice(0, 8)} \u2026 ${code.slice(-8)}</p></div></li>
    <li class="step done"><span class="n">${I("check", "s16")}</span><div><p class="st">Switch your old wallet to Fractal</p></div></li>
    <li class="step now"><span class="n">3</span><div><p class="st">Waiting for your coins…</p><p class="sd">Checked up to block ${num(S.b!.state.lastHeight ?? 0)}. Fractal blocks come every 30 seconds.</p></div></li>
    <li class="step todo"><span class="n">4</span><div><p class="st">Stop using the old address</p></div></li></ol>
  <div class="card flat pad-sm" role="status"><div class="row">${I("refresh-cw", "s16 spin")}<span class="small">Looking at new blocks as they arrive…</span></div></div>
  <button class="link small" type="button" data-act="go" data-to="migrate" data-step="refused" style="align-self:flex-start">My old wallet did not accept the code</button>`,
      foot: html`<button class="btn btn-secondary btn-block" type="button" data-act="home">Back to wallet</button>`,
    };
  }
  if (s === "refused") {
    const whole = S.f.mWhole === true;
    return {
      title: "Move coins here",
      header: H(),
      main: html`
  <div class="state" style="padding-top:var(--s-2)"><div class="big warn">${I("ban")}</div><h1>Your old wallet did not accept the code</h1><p>Some wallets cannot send to <span class="mono">sp1</span> receive codes yet. Nothing was sent and your coins are still at the old address.</p></div>
  <div class="opt-list">
    <button class="rowlink" type="button" data-act="onetime-issue"><span class="body"><span class="t row" style="gap:6px">Use a one-time address <span class="badge acc">Recommended</span></span><span class="d">A fresh address made from your recovery words, for this move only. Less private for this one transfer.</span></span><span class="v">${busy("ot") ? I("loader-circle", "s16 spin") : I("chevron-right", "s16")}</span></button>
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
  <div class="banner warn" role="note">${I("triangle-alert", "s16")}<div><span class="bt">Less private for this one transfer</span>Your old wallet and anyone reading the chain see this address receive coins from your old one. It is not linked to your receive code.</div></div>
  <div class="codebox"><div class="row between">${ntag("Fractal one-time address")}<span class="cap">Taproot</span></div><p class="code" aria-label="One-time address">${o ? codeHi(o.address) : ""}</p></div>
  <ul class="small" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">
    <li>Use it for this move only. PrivateBit stops showing it once the coins arrive.</li>
    <li>Made from your recovery words, so your backup already covers it.</li>
    <li>PrivateBit watches it on this computer, the same way it finds your other coins.</li></ul>`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="copy-ot">${I("copy", "s16")}Copy one-time address</button>`,
    };
  }
  if (s === "sweep") {
    const f = ot().funded;
    const sw = S.d.sweep as { fee: string; amount: string; vbytes: number; rate: number } | undefined;
    if (!f) return { title: "Move coins here", header: H(), main: html`<p class="muted">Nothing is waiting at your one-time address.</p>`, foot: html`<button class="btn btn-secondary btn-block" type="button" data-act="home">Back to wallet</button>` };
    return {
      title: "Move coins here",
      header: H(),
      main: html`
  <div class="state" style="padding-top:var(--s-2)"><div class="big">${I("circle-check")}</div><h1>${fbShort(f.value)} arrived</h1><p>The coins are at your one-time address. Move them under your receive code to finish.</p></div>
  <div class="card"><div class="kv">
    <div class="r"><span class="k">From</span><span class="v"><span class="mono">${mid(f.address, 8, 6)}</span><span class="cap">One-time address</span></span></div>
    <div class="r"><span class="k">To</span><span class="v"><span class="mono">${code.slice(0, 8)} \u2026 ${code.slice(-8)}</span><span class="cap">Your receive code</span></span></div>
    <div class="r"><span class="k">Network fee</span><span class="v">${sw ? html`<span class="mono">${sats(sw.fee)}</span><span class="cap">${sw.rate} sat/vB, ${sw.vbytes} vB</span>` : html`<span class="muted">${err("sweep") ? "Unavailable" : "Checking…"}</span>`}</span></div>
    ${sw ? html`<div class="r total"><span class="k">You keep</span><span class="v">${fb(sw.amount)}</span></div>` : ""}</div></div>
  ${err("sweep") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("sweep")}</span></p>` : ""}
  <p class="small muted">Moving does not hide where the coins came from, so they stay labeled Linked. It empties the one-time address so it is never used again.</p>`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="sweep" ${sw && !busy("sweep") ? "" : html`aria-disabled="true"`}>${busy("sweep") ? html`${I("loader-circle", "s16 spin")}Moving…` : "Move into my receive code"}</button><button class="btn btn-ghost btn-block" type="button" data-act="home">Later</button>`,
    };
  }
  if (s === "done") {
    const arrived = ms()?.arrived ?? [];
    const total = arrived.reduce((a, c) => a + BigInt(c.value), 0n);
    const stop = S.f.mStop !== false;
    return {
      title: "Move coins here",
      header: H(),
      main: html`
  <div class="state"><div class="big">${I("circle-check")}</div><h1>Your coins are here</h1><p>${total > 0n ? `${fb(total)} is under your receive code. ` : ""}It came from a reused address, so it is labeled \u201cOld wallet address\u201d. Spending it together with your other coins links the two.</p></div>
  <div class="card pad-sm"><label class="check"><input type="checkbox" data-f="mStop" ${stop ? html`checked` : ""}> <span>I will stop using the old wallet address</span></label></div>`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="migrate-finish">Done</button><button class="btn btn-ghost btn-block" type="button" data-act="migrate-see">See the coin</button>`,
    };
  }
  return {
    title: "Move coins here",
    header: H(),
    main: html`
  <div class="stack"><h2 style="font:var(--t-title)">Move coins from another wallet or a reused address</h2><p class="muted">Old addresses are public: anyone who has paid you there can see their balance and history. Moving the coins once and never using the old address again stops new links.</p></div>
  <ol class="steps">
    <li class="step now"><span class="n">1</span><div><p class="st">Copy your PrivateBit receive code</p><p class="sd">It starts with sp1 and is for Fractal.</p></div></li>
    <li class="step todo"><span class="n">2</span><div><p class="st">In your old wallet, switch to Fractal Bitcoin mainnet</p><p class="sd">Usually in its network menu.</p></div></li>
    <li class="step todo"><span class="n">3</span><div><p class="st">Send to the code</p><p class="sd">Paste the code in your old wallet. If it refuses the code, PrivateBit gives you a one-time address instead.</p></div></li>
    <li class="step todo"><span class="n">4</span><div><p class="st">Stop using the old address</p><p class="sd">PrivateBit will label these coins \u201cLinked\u201d.</p></div></li></ol>
  <div class="banner warn">${I("triangle-alert", "s16")}<div>Holding inscriptions or tokens on that address? Do not send everything. Move only plain FB, or ask about inscriptions first.</div></div>`,
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
  const o = ot().open;
  if (!o) return;
  await copyText(o.address);
  toast("One-time address copied.");
};
actions.sweep = async () => {
  const f = ot().funded;
  const sw = S.d.sweep as { rate: number } | undefined;
  if (!f || !sw) return;
  const r = await run("sweep", () => call({ type: "SWEEP_ONETIME", index: f.index, feeRate: sw.rate }), "sweep");
  if (!r) return;
  await refresh();
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
  if (s !== "waiting" && s !== "onetime") return;
  const [st, o] = await Promise.all([call<MStatus>({ type: "MIGRATE_STATUS" }), call<OTView>({ type: "ONETIME_VIEW" })]);
  S.d.mstatus = st;
  S.d.onetime = o;
  if (o.funded) {
    go("migrate", { step: "sweep" }, { replace: true });
  } else if (s === "waiting" && st.arrived.length) {
    go("migrate", { step: "done" }, { replace: true });
  }
}
