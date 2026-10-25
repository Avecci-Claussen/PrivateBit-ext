import { S, screens, actions, loaders, go, back, render, run, refresh, fv, busy, err, toast, code } from "../app.ts";
import { call, type CoinView, type Fees, type PlanPayload, type SessionView } from "../api.ts";
import { html, I, raw, NETLOGO, fb, fbShort, sats, parseFb, mid, hm, left, when, ntag, type Safe, UNIT, CHAIN, CHAIN_SHORT, blockTimeText } from "../kit.ts";
import { hdr } from "../chrome.ts";
import { usd, health } from "../derive.ts";
import { classify, type Dest } from "../dest.ts";
import { checkCustomFee } from "../../lib/requests.ts";
import { estimateVbytes } from "../../lib/coinselect.ts";
import { mixesLinkedAndPrivate, type CoinStatus } from "../../lib/coinmeta.ts";
import { loadCoins, coins } from "./coins.ts";
import { copyText } from "../copy.ts";
import { planChanges } from "../plan-changes.ts";
import { explorerBlock, pathPreview, txidLine, type PathLeg } from "../path.ts";

const DUST = 330n;
const H = (): Safe => hdr({ title: "Send", net: true });

/* ---------- data ---------- */
async function loadFees(force = false): Promise<void> {
  try {
    S.d.fees = await call<Fees>({ type: "FEE_RATES", force });
    S.d.feesErr = undefined;
  } catch (e) {
    S.d.feesErr = code(e) ?? "error";
  }
}
const fees = (): Fees | undefined => S.d.fees as Fees | undefined;
type FeeMode = "slow" | "normal" | "fast" | "custom";
const feeMode = (): FeeMode => (fv("feeMode") as FeeMode) || (fees() ? "normal" : "custom");
const minRate = (): number => fees()?.minimum ?? 1;

export function feeRate(): number | null {
  const m = feeMode();
  const f = fees();
  if (m !== "custom" && f) {
    const r = f[m];
    return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : null;
  }
  const v = Number(fv("feeCustom").replace(",", "."));
  if (!fv("feeCustom")) return null;
  const c = checkCustomFee(v, minRate(), f?.fast ?? 1);
  return c.ok ? v : null;
}
function feeName(): string {
  const m = feeMode();
  return m === "custom" ? "Custom" : m[0]!.toUpperCase() + m.slice(1);
}
const TARGET: Record<string, string> = { slow: "Can wait", normal: "Next few blocks", fast: "Next block" };

const coinMode = (): "auto" | "choose" => (fv("coinMode") as "auto" | "choose") || "auto";
const chosen = (): string[] => (Array.isArray(S.f.coinsSel) ? (S.f.coinsSel as string[]) : []);
const spendable = (): CoinView[] => coins().filter((c) => c.status !== "frozen" && c.status !== "reserved" && c.status !== "protected");
function available(): bigint {
  const list = coinMode() === "choose" ? coins().filter((c) => chosen().includes(c.outpoint)) : spendable().filter((c) => c.kind !== "bip86");
  return list.reduce((a, c) => a + BigInt(c.value), 0n);
}

loaders.send = async () => {
  await Promise.all([loadCoins(), fees() ? Promise.resolve() : loadFees()]);
  if (S.f.max) await updateMax();
};
loaders["send-fee"] = () => loadFees(true);
loaders["send-coins"] = loadCoins;

/* ---------- send form ---------- */
function dest(): Dest {
  return classify(fv("to"));
}

function destField(d: Dest, errMsg?: string): Safe {
  const v = fv("to");
  const tag =
    d.kind === "sp"
      ? html`<div class="row" data-st="62da06">${ntag(`${CHAIN_SHORT()} receive code`)}<span class="badge ok">${I("shield-check")}Private</span></div>`
      : d.kind === "paylink"
        ? html`<div class="row" data-st="62da06">${ntag("PrivateBit payment link")}<span class="badge ok">${I("route")}Payjoin</span></div>`
        : d.kind === "notpb"
          ? html`<div class="row" data-st="62da06"><span class="badge">Payment request</span><span class="badge warn">${I("triangle-alert")}No Payjoin</span></div>`
          : d.kind === "address"
            ? html`<div class="row" data-st="62da06"><span class="badge">Regular address (${d.type})</span><span class="badge warn">${I("triangle-alert")}Less private</span></div>`
            : "";
  const e = errMsg ?? (d.kind === "error" ? d.msg : undefined);
  return html`<div class="field"><label class="label" for="to">To</label><div class="input-wrap" data-st="0486f7"><textarea class="textarea" id="to" data-f="to" data-live rows="4" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="sp1q\u2026, payment link or bc1\u2026" ${e ? html`aria-invalid="true" aria-describedby="to-e"` : ""} data-st="569753">${v}</textarea><button class="icon-btn" type="button" data-act="paste" aria-label="Paste" data-st="288ddb">${I("clipboard-paste")}</button></div>${e ? html`<p class="err" id="to-e" role="alert">${I("circle-alert", "s16")}<span>${e}</span></p>` : ""}${tag}</div>`;
}
actions.paste = async () => {
  try {
    const t = await navigator.clipboard.readText();
    S.f.to = t.trim();
    S.d.plan = undefined;
    render();
  } catch {
    toast("Paste with Ctrl+V or Cmd+V.");
  }
};

function amountCheck(d: Dest): { sats: bigint | null; err?: string } {
  if ((d.kind === "paylink" || d.kind === "notpb" || d.kind === "address") && d.amount !== undefined) return { sats: d.amount };
  if (S.f.max) return { sats: S.d.max ? BigInt((S.d.max as { amount: string }).amount) : null };
  const a = fv("amt");
  if (!a) return { sats: null };
  const n = parseFb(a);
  if (n === null) return { sats: null, err: "Enter an amount like 0.1, with up to 8 decimals." };
  if (n < DUST) return { sats: n, err: "Minimum amount is 330 sats. Smaller outputs cannot be spent later." };
  const avail = available();
  if (n > avail) return { sats: n, err: `More than you have. Available: ${fbShort(avail)}, minus the network fee.` };
  return { sats: n };
}

function amountField(chk: { sats: bigint | null; err?: string }): Safe {
  const avail = available();
  const max = S.f.max === true;
  const v = max && chk.sats !== null ? fb(chk.sats, { unit: false, trim: true }) : fv("amt");
  return html`<div class="field"><div class="row between"><label class="label" for="amt">Amount</label><span class="cap">Available ${fbShort(avail)}</span></div>
  <div class="input-wrap"><input class="input mono" id="amt" data-f="amt" data-live inputmode="decimal" autocomplete="off" placeholder="0.00" value="${v}" ${max ? html`readonly` : ""} ${chk.err ? html`aria-invalid="true" aria-describedby="amt-e"` : html`aria-describedby="amt-h"`} data-st="c90d7d"><span class="unit" data-st="01125a">${UNIT()}</span><button class="btn btn-ghost btn-sm" type="button" data-act="max" aria-pressed="${String(max)}" data-st="06a095">Max</button></div>
  ${chk.err ? html`<p class="err" id="amt-e" role="alert">${I("circle-alert", "s16")}<span>${chk.err}</span></p>` : chk.sats !== null && chk.sats > 0n ? html`<p class="help" id="amt-h">${usd(chk.sats) ? `${usd(chk.sats)}, ` : ""}${sats(chk.sats)}${max ? ". Everything spendable, minus the fee" : ""}</p>` : html`<p class="help" id="amt-h">In ${UNIT()}. Use Max to send everything spendable.</p>`}</div>`;
}
actions.max = async () => {
  S.f.max = !S.f.max;
  if (S.f.max) await updateMax();
  else S.d.max = undefined;
  render();
};
async function updateMax(): Promise<void> {
  const r = feeRate() ?? minRate();
  try {
    S.d.max = await call({ type: "MAX_AMOUNT", feeRate: r, coins: coinMode() === "choose" ? chosen() : undefined });
  } catch (e) {
    S.err.amt = String((e as Error).message);
  }
}

export function payFrom(): Safe {
  const c = coinMode();
  const sel = coins().filter((x) => chosen().includes(x.outpoint));
  const d = c === "auto" ? "Largest coin first" : sel.length ? `${sel.length} ${sel.length === 1 ? "coin" : "coins"}, ${fbShort(sel.reduce((a, x) => a + BigInt(x.value), 0n))}` : "No coins chosen yet";
  return html`<button class="rowlink" type="button" data-act="go" data-to="send-coins"><span class="body"><span class="t">Pay from</span><span class="d">${d}</span></span><span class="v">${c === "auto" ? "Automatic" : "Chosen"}${I("chevron-right", "s16")}</span></button>`;
}
export function feeRow(): Safe {
  const r = feeRate();
  const m = feeMode();
  const f = fees();
  const d = r !== null ? `${r} sat/vB${m !== "custom" ? `, ${TARGET[m]!.toLowerCase()}` : ""}` : S.d.feesErr ? "Rates unavailable. Set a custom rate" : f ? "Enter a custom rate" : "Loading rates…";
  return html`<button class="rowlink" type="button" data-act="go" data-to="send-fee"><span class="body"><span class="t">Network fee</span><span class="d">${d}</span></span><span class="v">${feeName()}${I("chevron-right", "s16")}</span></button>`;
}

function destNote(d: Dest): Safe | string {
  if (d.kind === "paylink")
    return html`<div class="card flat pad-sm"><div class="kv">${d.amount !== undefined ? html`<div class="r"><span class="k">Amount set by the link</span><span class="v mono">${fb(d.amount)}</span></div>` : ""}${d.expiresAt ? html`<div class="r"><span class="k">Link expires</span><span class="v">${when(d.expiresAt)}</span></div>` : ""}</div></div>
  <div class="banner ok">${I("route", "s16")}<div><span class="bt">Payjoin will run</span>The other person adds one of their coins. Nobody watching can tell which coins are yours.</div></div>`;
  if (d.kind === "notpb")
    return html`<div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">Payjoin will not run</span>This link is not a PrivateBit payment link. PrivateBit only does Payjoin with another PrivateBit user. You can still pay the address, which is less private.</div></div>
  ${d.amount !== undefined ? html`<div class="card flat pad-sm"><div class="kv"><div class="r"><span class="k">Amount from link</span><span class="v mono">${fb(d.amount)}</span></div></div></div>` : ""}`;
  if (d.kind === "address")
    return html`<div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">This address can be watched</span>Anyone who knows it can see this payment and every other payment to it. Your change still goes back to a fresh private output.</div></div>`;
  return "";
}

function formReady(): { ok: boolean; d: Dest; amt: { sats: bigint | null; err?: string } } {
  const d = dest();
  const amt = amountCheck(d);
  const ok = (d.kind === "sp" || d.kind === "paylink" || d.kind === "notpb" || d.kind === "address") && amt.sats !== null && !amt.err && amt.sats > 0n && feeRate() !== null && health() !== "offline";
  return { ok, d, amt };
}

screens.send = () => {
  const { ok, d, amt } = formReady();
  const fixedAmt = (d.kind === "paylink" || d.kind === "notpb" || d.kind === "address") && d.amount !== undefined;
  let main: Safe;
  if (d.kind === "none") {
    main = html`${sendPath(d)}${destField(d)}
  <div class="card flat pad-sm"><p class="small strong">What you can paste</p><ul class="small muted" data-st="1e59ca">
    <li><span class="mono">sp1\u2026</span> receive code: private for both of you</li>
    <li>PrivateBit payment link: private, uses Payjoin</li>
    <li><span class="mono">bc1\u2026</span> address: works, but less private</li></ul></div>`;
  } else {
    main = html`${sendPath(d)}${destField(d)}${destNote(d)}
  ${d.kind === "error" ? "" : fixedAmt ? "" : amountField(amt)}
  ${d.kind === "sp" || d.kind === "address" ? html`<div class="field"><label class="label" for="lbl">Who will know about this payment? <span class="optl">(optional)</span></label><input class="input" id="lbl" data-f="lbl" maxlength="64" autocomplete="off" value="${fv("lbl")}" aria-describedby="lbl-h"><p class="help" id="lbl-h">Stays on this computer. Helps you keep coins apart later.</p></div>` : ""}
  ${d.kind === "error" ? "" : html`${d.kind === "paylink" ? "" : payFrom()}${feeRow()}`}
  ${d.kind === "address" ? html`<p class="small muted">Does the person use PrivateBit? Ask for their receive code instead.</p>` : ""}
  ${health() === "offline" ? html`<div class="banner danger">${I("unplug", "s16")}<div>Sending is paused until the block data service answers again.</div></div>` : ""}
  ${err("plan") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("plan")}</span></p>` : ""}`;
  }
  const label = d.kind === "notpb" ? "Review payment without Payjoin" : "Review";
  return {
    title: "Send",
    header: H(),
    main,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="review" ${ok && !busy("plan") ? "" : html`aria-disabled="true" disabled`}>${busy("plan") ? html`${I("loader-circle", "s16 spin")}Checking…` : label}</button>`,
    page: fullSend(),
  };
};

function planError(e: string): string {
  if (/no coins|insufficient/i.test(e)) return `Not enough spendable coins for this amount plus the fee. Available: ${fbShort(available())}.`;
  if (/own payment link/i.test(e)) return e;
  if (/chosen coin/i.test(e)) return `${e[0]!.toUpperCase()}${e.slice(1)}. Change Pay from.`;
  if (/rate limit|request limit/i.test(e)) return "The block data service is limiting requests. Try again in a minute, or add your own key in Settings.";
  return e;
}

actions.review = async () => {
  const { ok, d, amt } = formReady();
  if (!ok) return;
  const rate = feeRate()!;
  const coinsArg = d.kind === "paylink" ? undefined : coinMode() === "choose" ? chosen() : undefined;
  S.busy = "plan";
  delete S.err.plan;
  render();
  try {
    const p = await call<PlanPayload>({ type: "PLAN", destination: fv("to").trim(), amount: (amt.sats ?? 0n).toString(), feeRate: rate, coins: coinsArg, max: S.f.max === true && d.kind !== "paylink" ? true : undefined });
    S.d.plan = p;
    S.d.planChanged = undefined;
    S.d.planArgs = { destination: fv("to").trim(), amount: (amt.sats ?? 0n).toString(), feeRate: rate, coins: coinsArg, max: S.f.max === true ? true : undefined, kind: d.kind };
    S.f.ack = false;
    S.f.ackMerge = false;
    S.busy = null;
    go("review");
  } catch (e) {
    S.busy = null;
    S.err.plan = planError(String((e as Error).message));
    render();
  }
};

/* ---------- pay from (31b) ---------- */
function statusOf(c: CoinView): CoinStatus {
  return c.status;
}
function badge(c: CoinView): Safe {
  switch (c.status) {
    case "reserved":
      return html`<span class="badge">${I("lock-keyhole")}Reserved</span>`;
    case "frozen":
      return html`<span class="badge frozen">${I("snowflake")}Frozen</span>`;
    case "protected":
      return html`<span class="badge warn">${I("lock")}Protected</span>`;
    case "linked":
      return html`<span class="badge warn">Linked</span>`;
    default:
      return html`<span class="badge ok">Private</span>`;
  }
}
export { badge as coinBadge };
const coinName = (c: CoinView): string => c.label || (c.kind === "bip86" ? "One-time address" : c.status === "linked" ? "Linked coin" : "Not labeled");

function fromLeg(): PathLeg {
  const c = coinMode();
  const sel = coins().filter((x) => chosen().includes(x.outpoint));
  if (c === "choose") {
    if (!sel.length) return { title: "Your coins", sub: "None chosen yet" };
    if (sel.length === 1) return { title: coinName(sel[0]!), sub: fbShort(sel[0]!.value) };
    return { title: `${sel.length} coins you chose`, sub: fbShort(sel.reduce((a, x) => a + BigInt(x.value), 0n)) };
  }
  return { title: "Your coins", sub: "Largest first, never frozen" };
}

function toLeg(d: Dest, lbl?: string): PathLeg {
  const who = (lbl ?? fv("lbl")).trim();
  if (d.kind === "none") return { title: "Not set yet", sub: "Paste a receive code, payment link, or address" };
  if (d.kind === "error") return { title: "Cannot pay this", sub: d.msg };
  if (d.kind === "sp") return { title: who || "Their receive code", sub: mid(d.address, 10, 8) };
  if (d.kind === "paylink") return { title: who || "Their payment link", sub: "Payjoin: they add a coin" };
  if (d.kind === "notpb") return { title: who || "Payment request", sub: mid(d.address, 10, 8) };
  return { title: who || "This address", sub: mid(d.address, 10, 8) };
}

function sendPath(d?: Dest): Safe {
  return pathPreview(fromLeg(), toLeg(d ?? dest()));
}

screens["send-coins"] = () => {
  const mode = coinMode();
  const sel = chosen();
  const list = coins();
  const selCoins = list.filter((c) => sel.includes(c.outpoint));
  const mix = mixesLinkedAndPrivate(selCoins.map(statusOf));
  const linked = selCoins.filter((c) => c.status === "linked");
  const priv = selCoins.filter((c) => c.status === "private");
  const total = selCoins.reduce((a, c) => a + BigInt(c.value), 0n);
  return {
    title: "Pay from",
    header: hdr({ title: "Pay from", net: true }),
    main: html`
  ${sendPath()}
  <div class="seg" role="radiogroup" aria-label="Coin choice"><button type="button" role="radio" data-act="coin-mode" data-v="auto" aria-checked="${String(mode === "auto")}">Automatic</button><button type="button" role="radio" data-act="coin-mode" data-v="choose" aria-checked="${String(mode === "choose")}">Choose coins</button></div>
  ${mode === "auto"
    ? html`<p class="small muted">PrivateBit uses your largest coins first and never touches frozen or protected coins, coins set aside for a payment link, or a one-time address.</p>`
    : list.length === 0
      ? html`<div class="state"><div class="big neutral">${I("coins")}</div><h1>No coins yet</h1><p>Coins show here after PrivateBit finds a payment to your receive code in a block.</p></div>`
      : html`<fieldset data-st="e8f267"><legend class="sr-only">Coins to spend</legend>
  <div class="list cpick">${list.map((c) => {
    const off = c.status === "reserved" || c.status === "frozen" || c.status === "protected";
    return html`<label class="${off ? "off" : ""}"><input type="checkbox" data-act="coin-pick" data-op="${c.outpoint}" ${sel.includes(c.outpoint) ? html`checked` : ""} ${off ? html`disabled` : ""}><span class="body"><span class="t">${coinName(c)}</span><span class="d">${off ? (c.status === "frozen" ? "Frozen. Unfreeze it in Coins to spend it." : c.status === "protected" ? "Protected, may hold an asset. Check or unlock it in Coins." : c.held ? "In a payment waiting to be sent." : "For your payment link.") : c.reason || (c.pending ? "Not in a block yet" : `Block ${c.height.toLocaleString("en-US")}`)}</span></span><span class="end"><span class="amt">${BigInt(c.value) < 100_000n ? sats(c.value) : fbShort(c.value)}</span>${badge(c)}</span></label>`;
  })}</div></fieldset>
  ${mix ? html`<div class="banner warn" role="alert">${I("triangle-alert", "s16")}<div><span class="bt">This links ${priv.length === 1 ? `${coinName(priv[0]!) === "Not labeled" ? "a private coin" : coinName(priv[0]!)}` : "your private coins"} to ${linked.length === 1 && linked[0]!.label ? linked[0]!.label.toLowerCase().startsWith("old wallet") ? "your old wallet address" : linked[0]!.label : "a linked coin"}</span>Anyone watching the linked coin's old address will see both coins are yours.</div></div>` : ""}
  <div class="sumbar"><span class="muted">${sel.length} ${sel.length === 1 ? "coin" : "coins"} selected</span><b>${fbShort(total)}</b></div>`}`,
    foot:
      mode === "choose" && list.length
        ? mix
          ? { cls: "row", html: html`<button class="btn btn-secondary" type="button" data-act="only-linked">Use only the linked ${linked.length === 1 ? "coin" : "coins"}</button><button class="btn btn-primary" type="button" data-act="coins-done">Use ${sel.length} coins</button>` }
          : html`<button class="btn btn-primary btn-block" type="button" data-act="coins-done" ${sel.length ? "" : html`aria-disabled="true" disabled`}>${sel.length ? `Use ${sel.length} ${sel.length === 1 ? "coin" : "coins"}` : "Choose at least one coin"}</button>`
        : html`<button class="btn btn-primary btn-block" type="button" data-act="coins-done">Use automatic</button>`,
  };
};
actions["coin-mode"] = (el) => {
  S.f.coinMode = el.dataset.v!;
  if (S.f.coinMode === "choose" && !chosen().length) S.f.coinsSel = [];
  render();
};
actions["coin-pick"] = (el, ev) => {
  ev.preventDefault();
  const op = el.dataset.op!;
  const cur = new Set(chosen());
  if (cur.has(op)) cur.delete(op);
  else cur.add(op);
  S.f.coinsSel = [...cur];
  S.d.plan = undefined;
  render();
};
actions["only-linked"] = () => {
  const ids = new Set(coins().filter((c) => c.status === "linked").map((c) => c.outpoint));
  S.f.coinsSel = chosen().filter((o) => ids.has(o));
  render();
};
actions["coins-done"] = async () => {
  if (S.f.max) await updateMax();
  if (S.mode === "full" && S.route === "send") return render();
  back("send");
};

/* ---------- fee picker (31c, 31d) ---------- */
screens["send-fee"] = () => {
  const f = fees();
  const m = feeMode();
  const cv = fv("feeCustom");
  const cn = Number(cv.replace(",", "."));
  const chk = cv ? checkCustomFee(cn, minRate(), f?.fast ?? 1) : null;
  const plan = S.d.plan as PlanPayload | undefined;
  const vb = plan?.vbytes ?? estimateVbytes(1, 2);
  const rate = feeRate();
  const same = f && f.slow === f.normal && f.normal === f.fast;
  const lim = S.d.feesErr === "rate-limited";
  const feeAt = (r: number): bigint => BigInt(Math.ceil(vb * r));
  const opt = (k: "slow" | "normal" | "fast") =>
    html`<button class="fee" type="button" role="radio" data-act="fee-mode" data-v="${k}" aria-checked="${String(m === k)}" ${f ? "" : html`aria-disabled="true" disabled`}><span class="fn">${k[0]!.toUpperCase() + k.slice(1)}</span><span class="fr">${f ? `${f[k]} sat/vB` : "No rate"}</span><span class="ft">${TARGET[k]}</span></button>`;
  const tooLow = chk && !chk.ok && chk.reason === "too-low";
  return {
    title: "Network fee",
    header: hdr({ title: "Network fee", net: true }),
    main: html`
  ${sendPath()}
  ${!f ? html`<div class="banner warn" role="status">${I("unplug", "s16")}<div><span class="bt">${lim ? "Fee rates are limited right now" : "Fee rates unavailable"}</span>${lim ? "The block data service is limiting requests without an API key." : "The block data service did not answer."} Enter a custom rate, or try again in a minute. <button class="link" type="button" data-act="fees-retry">Try again</button></div></div>` : ""}
  <div class="fees" role="radiogroup" aria-label="Fee speed">${opt("slow")}${opt("normal")}${opt("fast")}</div>
  <div class="field"><label class="label" for="cf">Custom <span class="optl">(sat/vB)</span></label><div class="input-wrap"><input class="input mono" id="cf" data-f="feeCustom" data-live inputmode="decimal" autocomplete="off" placeholder="${String(minRate())}" value="${cv}" ${chk && !chk.ok ? html`aria-invalid="true" aria-describedby="cf-e"` : ""} data-act-focus="custom"><span class="unit">sat/vB</span></div>
  ${chk && !chk.ok ? html`<p class="err" id="cf-e" role="alert">${I("circle-alert", "s16")}<span>${chk.reason === "too-low" ? `Too low. Below ${minRate()} sat/vB most nodes will not relay it, so it may never confirm and your coins stay stuck until it drops out.` : chk.reason === "too-high" ? "That is far above every current rate. Check the number." : "Enter a number, such as the Normal rate."}</span></p>` : ""}</div>
  ${same && !cv ? html`<div class="banner" role="status">${I("info", "s16")}<div><span class="bt">Every speed is ${f!.normal} sat/vB right now</span>Blocks on ${CHAIN()} are not full right now, so Normal gets in as fast as Fast.</div></div>` : ""}
  <div class="card"><div class="kv">
    ${tooLow
      ? html`<div class="r"><span class="k">Fee at ${cn} sat/vB</span><span class="v mono">${sats(feeAt(cn))}</span></div><div class="r"><span class="k">Lowest that relays</span><span class="v"><span class="mono">${minRate()} sat/vB, ${sats(feeAt(minRate()))}</span><span class="cap">Minimum rate from the service</span></span></div>`
      : html`<div class="r"><span class="k">This payment</span><span class="v mono">${plan ? "" : "About "}${vb} vB</span></div>
    ${rate !== null ? html`<div class="r"><span class="k">Fee at ${rate} sat/vB</span><span class="v"><span class="mono">${sats(feeAt(rate))}</span>${usd(feeAt(rate), { approx: false }) ? html`<span class="fiat">${usd(feeAt(rate), { approx: false })}</span>` : ""}</span></div>` : ""}
    ${f ? html`<div class="r"><span class="k">Rates from</span><span class="v">${f.source === "node" ? "Your node" : "Block data service"}, ${hm(f.updatedAt ?? f.fetchedAt)}</span></div>` : ""}`}</div></div>
  <p class="small muted">${f?.source === "node" ? "Your node gives a rate for each speed, not a time." : "The block data service gives a rate for each speed, not a time."} ${blockTimeText()} The fee does not change your privacy.</p>`,
    foot: tooLow
      ? html`<button class="btn btn-primary btn-block" type="button" disabled aria-disabled="true">Use ${cn} sat/vB</button>${f ? html`<button class="btn btn-ghost btn-block" type="button" data-act="fee-use" data-v="slow">Use Slow, ${f.slow} sat/vB</button>` : ""}`
      : html`<button class="btn btn-primary btn-block" type="button" data-act="fee-use" ${rate === null ? html`aria-disabled="true" disabled` : ""}>${rate === null ? "Choose a rate" : `Use ${feeName()}, ${sats(feeAt(rate))}`}</button>`,
  };
};
document.addEventListener("focusin", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.dataset?.actFocus === "custom" && S.f.feeMode !== "custom") {
    S.f.feeMode = "custom";
  }
});
actions["fee-mode"] = (el) => {
  S.f.feeMode = el.dataset.v!;
  S.f.feeCustom = "";
  render();
};
actions["fees-retry"] = async () => {
  await loadFees(true);
  render();
};
actions["fee-use"] = async (el) => {
  if (el.dataset.v) {
    S.f.feeMode = el.dataset.v;
    S.f.feeCustom = "";
  } else if (fv("feeCustom")) S.f.feeMode = "custom";
  if (S.f.max) await updateMax();
  if (S.d.plan) {
    S.d.plan = undefined;
    back("send");
    return;
  }
  back("send");
};

/* ---------- review (36-39) and confirm (40) ---------- */
type PlanArgs = { destination: string; amount: string; feeRate: number; coins?: string[]; max?: boolean; kind: Dest["kind"] };
const planArgs = (): PlanArgs => S.d.planArgs as PlanArgs;

function ior(tag: string, cls: string, codeS: string, amt: string): Safe {
  return html`<div class="io-row"><span class="badge ${cls}">${tag}</span><span class="code">${codeS}</span><span class="amt">${amt}</span></div>`;
}

screens.review = () => {
  const p = S.d.plan as PlanPayload | undefined;
  const a = planArgs();
  if (!p || !a) return screens.send!();
  const amt = BigInt(p.amount);
  const fee = BigInt(p.fee);
  const change = BigInt(p.change);
  const lbl = fv("lbl");
  const to = classify(a.destination);
  const who = lbl || (to.kind === "sp" ? "them" : "");
  const inputsTotal = p.preview.inputs.reduce((s, x) => s + BigInt(x.value), 0n);
  const rate = p.feeRate ?? a.feeRate;
  const nudged = p.feeRate !== undefined && p.feeRate !== a.feeRate;
  const modeTxt = `${feeName()}, ${rate} sat/vB${nudged ? " (moved slightly)" : ""}${feeMode() !== "custom" ? `, ${TARGET[feeMode()]!.toLowerCase()}` : ""}`;
  const legacy = to.kind === "address" || to.kind === "notpb";
  const pj = to.kind === "paylink";
  const nIn = p.inputs.length;
  const details = html`<p class="io-h">From your wallet</p><div class="io">${p.inputs.map((op, i) => ior("Yours", "", mid(op, 10, 4), fb(p.preview.inputs[i]?.value ?? "0")))}</div>
    <p class="io-h">Goes to</p><div class="io">${ior(lbl || (pj ? "Payment link" : "Them"), "ok", mid(to.kind === "none" || to.kind === "error" ? "" : to.address, 8, 5), fb(amt))}${change > 0n ? ior("Change", "", "Back to you, private", fb(change)) : ""}</div>
    <p class="io-h">Fee</p><div class="io-row"><span class="badge">Miners</span><span class="code">${rate} sat/vB, ${p.vbytes} vB</span><span class="amt">${sats(fee)}</span></div>
    ${to.kind === "sp" ? html`<p class="cap">Both outputs look like ordinary Taproot outputs. Nobody can tell which one is change.</p>` : ""}`;
  const toRow = html`<div class="r"><span class="k">To</span><span class="v"><span class="mono">${to.kind === "none" || to.kind === "error" ? "" : mid(to.address, 12, 8)}</span>${to.kind === "sp" ? ntag(`${CHAIN_SHORT()} receive code`) : pj ? ntag("Payment link") : html`<span class="badge">Regular address</span>`}</span></div>`;
  const privRow = pj
    ? html`<div class="r"><span class="k">Privacy</span><span class="v"><span class="badge ok">${I("route")}Payjoin</span><span class="cap">They add a coin. Ownership is hidden.</span></span></div>`
    : legacy
      ? html`<div class="r"><span class="k">Privacy</span><span class="v"><span class="badge warn">${I("triangle-alert")}Less private</span><span class="cap">Visible to anyone who knows this address</span></span></div>`
      : html`<div class="r"><span class="k">Privacy</span><span class="v"><span class="badge ok">${I("shield-check")}Private</span><span class="cap">New address only ${who === "them" ? "they" : who} can find</span></span></div>`;
  const changed = S.d.planChanged as string[] | undefined;
  const groups = p.inputLabels ?? [];
  const merges = !pj && groups.length > 1;
  const named = groups.map((g) => (g.label ? `"${g.label}"` : "no label"));
  const mergeBox = merges
    ? html`<div class="banner warn" role="alert" id="merge-warn">${I("triangle-alert", "s16")}<div><span class="bt">This payment spends coins with different labels together</span>Anyone looking at the transaction can see these coins have one owner: ${named.join(", ")}. If the labels mean different people know about them, they may learn about each other.
      <div class="row" data-st="47cabb"><button class="btn btn-secondary btn-sm" type="button" data-act="merge-back">${I("coins", "s16")}Change coins</button></div>
      <label class="check" data-st="8a77e5"><input type="checkbox" data-f="ackMerge" ${S.f.ackMerge ? html`checked` : ""}> <span>Continue and spend them together</span></label></div></div>`
    : "";
  const delay = S.b?.prefs.sendDelay ?? "off";
  const delayTxt: Record<string, string> = { "1m": "1 minute", "10m": "10 minutes", "1h": "1 hour" };
  const delayBox = !pj && delay !== "off"
    ? html`<div class="banner" role="status">${I("timer", "s16")}<div><span class="bt">Sent at a random time within ${delayTxt[delay]}</span>After you confirm, the signed payment waits on this computer, encrypted. Until it goes out you can send it now or cancel it, and nothing reaches the network.</div></div>`
    : "";
  // Audit L3 (independent): a large fee is called out on the review, in sats and as a share.
  const feeHigh = (fee * 10n > amt && fee > 5_000n) || fee > 100_000n || Number(rate) > 200;
  const feeBox = feeHigh
    ? html`<div class="banner warn" role="alert" id="fee-warn">${I("triangle-alert", "s16")}<div><span class="bt">The fee is unusually high</span>${sats(fee)} goes to miners${amt > 0n ? `, ${(Number((fee * 1000n) / amt) / 10).toFixed(1)}% of the amount` : ""}. Check the fee before you confirm.</div></div>`
    : "";
  const main = html`${feeBox}
  ${changed?.length ? html`<div class="banner warn" role="alert">${I("triangle-alert", "s16")}<div><span class="bt">Nothing was sent. The payment changed since you reviewed it</span>${changed.join(" ")} Check it again below before you confirm.</div></div>` : ""}
  <div class="hero-amt"><p class="cap">${pj ? "You pay" : "You send"}</p><p class="a">${fb(amt, { unit: false, trim: true })}<span class="unit"> ${UNIT()}</span></p>${usd(amt) || (lbl && !legacy) ? html`<p class="fiat">${usd(amt)}${lbl && !legacy ? ` to ${lbl}` : ""}${pj ? " with a PrivateBit payment link" : ""}</p>` : ""}</div>
  ${pathPreview(fromLeg(), toLeg(to, lbl))}
  <div class="card"><div class="kv">
    ${toRow}${privRow}
    <div class="r"><span class="k">Network fee</span><span class="v"><span class="mono">${sats(fee)}</span><span class="cap">${pj ? "You pay the fee for your part" : modeTxt}</span>${pj ? "" : html`<button class="link small" type="button" data-act="go" data-to="send-fee">Change</button>`}</span></div>
    ${pj ? "" : html`<div class="r"><span class="k">Pay from</span><span class="v"><span>${nIn} ${nIn === 1 ? "coin" : "coins"}, ${fbShort(inputsTotal)}</span><span class="cap">${coinMode() === "choose" ? "Chosen by you" : "Automatic, largest first"}</span></span></div>`}
    ${change > 0n ? html`<div class="r"><span class="k">Back to you</span><span class="v"><span class="mono">${fb(change)}</span><span class="cap">${p.changeTypeDiffers ? "Kept as a Taproot coin, the only kind this wallet holds" : legacy ? "Private change, at a random position" : "Looks like a payment, at a random position"}</span></span></div>` : ""}
    ${p.changeless ? html`<div class="r" id="nochange"><span class="k">No change</span><span class="v"><span>${sats(p.changeless.extra)} extra go to the network fee</span><span class="cap">Too small to keep as a coin. It would cost about as much to spend later.</span></span></div>` : ""}
    <div class="r total"><span class="k">Total leaving</span><span class="v">${fb(amt + fee)}</span></div></div></div>
  ${pj
    ? html`<div class="banner">${I("info", "s16")}<div><span class="bt">What happens next</span>Your signed payment goes to the other person, encrypted. When they add their coin, PrivateBit checks it and broadcasts. If they never answer, nothing is broadcast.</div></div>`
    : html`<details class="card pad-sm" ${S.f.det ? html`open` : ""}><summary class="small strong" data-st="3b6a3a" data-act="toggle-k" data-k="det">Transaction details</summary><div class="stack" data-st="56f435">${details}<button class="btn btn-ghost btn-sm" type="button" data-act="copy-psbt" data-st="c9adc4">${I("copy", "s16")}Copy PSBT</button></div></details>`}
  ${mergeBox}${delayBox}
  ${typeof S.f.siteFund === "string" && to.kind === "address" ? html`<div class="banner warn" role="note" id="site-fund-note">${I("globe", "s16")}<div><span class="bt">Moving coins to the site account for ${S.f.siteFund}</span>This is a normal payment. On chain it links the coins you spend here to that site's account, so the site can see they came from one wallet. Your receive code and other coins stay out of it.</div></div>` : ""}
  ${legacy ? html`<label class="check"><input type="checkbox" data-f="ack" ${S.f.ack ? html`checked` : ""}> <span>I understand this payment can be linked to this address.</span></label>` : ""}
  ${changed?.length ? html`<label class="check"><input type="checkbox" data-f="ackChange" ${S.f.ackChange ? html`checked` : ""}> <span>I checked the new amounts and coins.</span></label>` : ""}
  ${p.preview.warnings.length ? html`<div class="banner warn">${I("triangle-alert", "s16")}<div>${p.preview.warnings.join(" ")}</div></div>` : ""}`;
  const can = (!legacy || S.f.ack === true) && (!changed?.length || S.f.ackChange === true) && (!merges || S.f.ackMerge === true);
  return {
    title: "Review",
    header: hdr({ title: "Review", net: true }),
    main,
    foot: { cls: "row", html: html`<button class="btn btn-secondary" type="button" data-act="back">Edit</button><button class="btn btn-primary" type="button" data-act="sheet" data-sheet="confirm" ${can ? "" : html`disabled aria-disabled="true"`}>Confirm</button>` },
  };
};
actions["merge-back"] = () => {
  S.f.coinMode = "choose";
  S.f.ackMerge = false;
  go("send-coins");
};
actions["toggle-k"] = (el) => {
  S.f[el.dataset.k!] = !S.f[el.dataset.k!];
};
actions["copy-psbt"] = async () => {
  const p = S.d.plan as PlanPayload | undefined;
  if (!p) return;
  await copyText(p.psbtBase64);
  toast("PSBT copied. It has no keys.");
};

import { sheets } from "../chrome.ts";
sheets.confirm = () => {
  const p = S.d.plan as PlanPayload;
  const a = planArgs();
  const amt = BigInt(p.amount);
  const fee = BigInt(p.fee);
  const to = classify(a.destination);
  const lbl = fv("lbl");
  const address = to.kind === "none" || to.kind === "error" ? "" : to.address;
  const kindName = to.kind === "sp" ? "Receive code" : to.kind === "paylink" ? "Payment link" : "Address";
  return html`<div class="scrim" data-act="sheet-close" aria-hidden="true"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="cf-h"><span class="grab" aria-hidden="true"></span>
  <div class="sheet-h"><h2 id="cf-h">Send ${fb(amt, { trim: true })}${lbl ? ` to ${lbl}` : ""}?</h2></div>
  ${pathPreview(fromLeg(), toLeg(to, lbl))}
  <div class="kv"><div class="r"><span class="k">Network</span><span class="v">${ntag(CHAIN())}</span></div><div class="r"><span class="k">${kindName}</span><span class="v mono">${address.slice(0, 8)} \u2026 ${address.slice(-8)}</span></div><div class="r total"><span class="k">Total</span><span class="v">${fb(amt + fee)}${usd(amt + fee) ? html`<span class="fiat">${usd(amt + fee)}</span>` : ""}</span></div></div>
  <p class="small muted">Payments on ${CHAIN()} cannot be reversed. Check the first and last characters${lbl ? ` with ${lbl}` : ""}.</p>
  <div class="stack"><button class="btn btn-primary btn-block" type="button" data-act="broadcast">Send ${fb(amt, { trim: true })}</button><button class="btn btn-ghost btn-block" type="button" data-act="sheet-close">Cancel</button></div></div>`;
};

actions.broadcast = async () => {
  const a = planArgs();
  const p = S.d.plan as PlanPayload;
  S.sheet = null;
  go("sending", {}, { replace: true });
  try {
    const r = await call<{ txid?: string; pending?: boolean; fee: string; changed?: boolean; plan?: PlanPayload; delayed?: { id: string; sendAt: number } }>({
      type: "BROADCAST",
      planId: p.planId,
      intent: a.kind === "paylink" ? "payjoin" : "simple-send",
      destination: a.destination,
      amount: a.amount,
      feeRate: a.feeRate,
      coins: a.coins,
      max: a.max,
      seed: p.seed,
      label: fv("lbl") || undefined,
    });
    if (r.changed && r.plan) {
      // Audit M10: the reviewed plan is no longer what would be sent. Nothing was sent.
      S.d.planChanged = planChanges(p, r.plan);
      S.d.plan = r.plan;
      S.f.ack = false;
      S.f.ackChange = false;
      S.f.ackMerge = false;
      await refresh();
      go("review", {}, { replace: true });
      return;
    }
    if (r.delayed) {
      S.d.held = { id: r.delayed.id, sendAt: r.delayed.sendAt, amount: p.amount, label: fv("lbl") };
      clearForm();
      await refresh();
      go("held", {}, { replace: true });
      return;
    }
    S.d.planChanged = undefined;
    await refresh();
    if (r.pending) {
      go("pj-waiting", {}, { replace: true });
    } else {
      const from = fromLeg();
      const to = toLeg(classify(a.destination), fv("lbl"));
      S.d.sent = { txid: r.txid, fee: r.fee, amount: p.amount, label: fv("lbl"), kind: a.kind, destination: a.destination, from, to };
      S.d.exploreTxid = r.txid;
      clearForm();
      go("sent", {}, { replace: true });
    }
  } catch (e) {
    S.d.sendErr = String((e as Error).message);
    go("send-failed", {}, { replace: true });
  }
};
function clearForm(): void {
  for (const k of ["to", "amt", "lbl", "siteFund", "max", "coinMode", "coinsSel", "feeCustom", "feeMode", "ack", "ackChange", "ackMerge", "det"]) delete S.f[k];
  S.d.plan = undefined;
  S.d.planChanged = undefined;
  S.d.max = undefined;
}

screens.sending = () => {
  const p = S.d.plan as PlanPayload | undefined;
  const a = planArgs();
  const to = a ? classify(a.destination) : dest();
  return {
    title: "Sending",
    header: hdr({ title: "Sending", back: false, net: true }),
    main: html`<div class="state"><div class="big neutral">${I("loader-circle", "spin")}</div><h1>Sending ${p ? fbShort(p.amount) : ""}…</h1><p>${a?.kind === "paylink" ? "Signing on this computer and sending your part to the other person, encrypted." : S.b?.state.chain.kind === "core" || S.b?.state.chain.sendVia === "node" ? "Signing on this computer and broadcasting through your node." : "Signing on this computer and broadcasting through the public service. It sees your IP address with the payment."}</p></div>
  ${pathPreview(fromLeg(), toLeg(to))}
  ${p ? html`<div class="card"><div class="kv"><div class="r"><span class="k">Amount</span><span class="v mono">${fb(p.amount)}</span></div></div></div>` : ""}`,
  };
};

screens.sent = () => {
  const s = S.d.sent as { txid?: string; fee: string; amount: string; label?: string; kind: string; destination?: string; from?: PathLeg; to?: PathLeg } | undefined;
  const from = s?.from ?? fromLeg();
  const to = s?.to ?? (s?.destination ? toLeg(classify(s.destination), s.label) : { title: s?.label || "Them" });
  const ask = S.b!.prefs.askExplorer !== false;
  return {
    title: "Sent",
    header: hdr({ title: "Sent", back: false, net: true, close: true }),
    main: html`
  <div class="state"><div class="big">${I("circle-check")}</div><h1>${s ? fbShort(s.amount) : ""} sent${s?.label ? ` to ${s.label}` : ""}</h1><p>${blockTimeText()}</p></div>
  ${pathPreview(from, to)}
  <div class="card"><div class="kv">
    ${s?.txid ? txidLine(s.txid) : ""}
    <div class="r"><span class="k">Fee</span><span class="v mono">${s ? sats(s.fee) : ""}</span></div>
    <div class="r"><span class="k">Visible on chain</span><span class="v">${s?.kind === "sp" ? `Two Taproot outputs, no link to your code${s.label ? ` or ${s.label}\u2019s` : ""}` : "A payment to this address and your private change"}</span></div></div></div>
  ${s?.txid ? explorerBlock(S.f.explorerAsk === true, ask) : ""}`,
    foot: { cls: "row", html: html`<button class="btn btn-secondary" type="button" data-act="copy-txid">${I("copy", "s16")}Copy ID</button><button class="btn btn-primary" type="button" data-act="home">Done</button>` },
  };
};
actions["copy-txid"] = async () => {
  const s = S.d.sent as { txid?: string } | undefined;
  if (s?.txid) {
    await copyText(s.txid);
    toast("Transaction ID copied.");
  }
};

screens["send-failed"] = () => {
  const e = String(S.d.sendErr ?? "");
  const feeIssue = /min relay fee|fee not met|insufficient fee/i.test(e);
  const lim = /rate limit|request limit/i.test(e);
  return {
    title: "Not sent",
    header: H(),
    main: html`
  <div class="state"><div class="big danger">${I("circle-x")}</div><h1>Not sent</h1><p>${S.b?.state.chain.kind === "core" ? "Your node" : "The block data service"} rejected the transaction: \u201c${e}\u201d. Your coins did not move.</p></div>
  ${feeIssue ? html`<div class="card flat pad-sm"><p class="small">Fees rose since you reviewed. Review again to get the current rate.</p></div>` : lim ? html`<div class="card flat pad-sm"><p class="small">The service is limiting requests without an API key. Wait a minute, or add your own key in Settings.</p></div>` : ""}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="review-again">Review again</button><button class="btn btn-ghost btn-block" type="button" data-act="copy-err">${I("copy", "s16")}Copy error details</button>`,
  };
};
actions["review-again"] = async () => {
  S.d.fees = undefined;
  await loadFees(true);
  go("send", {}, { replace: true });
};
actions["copy-err"] = async () => {
  await copyText(String(S.d.sendErr ?? ""));
  toast("Error copied.");
};

/* ---------- Payjoin sender (42, 44) ---------- */
async function loadSends(): Promise<void> {
  S.d.sessions = await call<SessionView[]>({ type: "SESSIONS" });
}
loaders["pj-waiting"] = async () => {
  await loadSends();
  const s = lastSend();
  if (s?.txid) S.d.exploreTxid = s.txid;
};
const lastSend = (): SessionView | undefined => ((S.d.sessions as SessionView[] | undefined) ?? []).find((s) => s.role === "send");

screens["pj-waiting"] = () => {
  const s = lastSend();
  if (s && s.status === "failed") return screens["pj-failed"]!();
  if (s && s.status === "done") {
    const dest = s.destination ? classify(s.destination) : undefined;
    const ask = S.b!.prefs.askExplorer !== false;
    return {
      title: "Payjoin",
      header: hdr({ title: "Payjoin", back: false, net: true, close: true }),
      main: html`<div class="state"><div class="big">${I("circle-check")}</div><h1>${s.amount ? fbShort(s.amount) : ""} sent with Payjoin</h1><p>The other person added their coin and PrivateBit broadcast the payment. Observers cannot tell which coins were yours.</p></div>
  ${pathPreview({ title: "Your coins", sub: "Plus their coin in the same payment" }, dest ? toLeg(dest) : { title: "Their payment link" })}
  ${s.txid ? html`<div class="card"><div class="kv">${txidLine(s.txid)}</div></div>${explorerBlock(S.f.explorerAsk === true, ask)}` : ""}`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="home">Done</button>`,
    };
  }
  return {
    title: "Payjoin",
    header: hdr({ title: "Payjoin", back: false, net: true, close: true }),
    main: html`
  <div class="hero-amt"><p class="cap">Paying with Payjoin</p><p class="a">${s?.amount ? fbShort(s.amount, { unit: false }) : ""}<span class="unit"> ${UNIT()}</span></p></div>
  ${pathPreview({ title: "Your coins" }, s?.destination ? toLeg(classify(s.destination)) : { title: "Their payment link" })}
  <ol class="steps">
    <li class="step done"><span class="n">${I("check", "s16")}</span><div><p class="st">Your part sent, encrypted</p><p class="sd">${s ? when(s.createdAt) : ""}</p></div></li>
    <li class="step now" aria-current="step"><span class="n">2</span><div><p class="st">Waiting for them to add their coin…</p><p class="sd">They don't press a button. Their wallet adds the coin while it stays unlocked. Nothing has come back yet${s?.checkedAt ? html` (last check ${when(s.checkedAt)})` : ""}.</p></div></li>
    <li class="step todo"><span class="n">3</span><div><p class="st">PrivateBit checks and broadcasts</p><p class="sd">Your inputs and the amount cannot be changed by them.</p></div></li></ol>
  ${s?.error ? html`<div class="banner danger">${I("circle-alert", "s16")}<div><span class="bt">The mailbox check failed</span>${s.error} Trying again. You can cancel.</div></div>` : ""}
  <div class="banner">${I("info", "s16")}<div><span class="bt">You can close this window or lock</span>This payment keeps going with keys for its own coins only. Quitting the browser stops it. Cancel if you do not want to wait.</div></div>`,
    foot: html`<button class="btn btn-secondary btn-block" type="button" data-act="cancel-send" data-id="${s?.id ?? ""}" ${busy("cancel-send") ? html`aria-disabled="true"` : ""}>Cancel payment</button><button class="btn btn-ghost btn-block" type="button" data-act="pj-check" ${busy("pj-check") ? html`aria-disabled="true"` : ""}>Check now</button>`,
  };
};

screens["pj-failed"] = () => {
  const s = lastSend();
  return {
    title: "Payjoin",
    header: hdr({ title: "Payjoin", back: false, net: true, close: true }),
    main: html`
  <div class="state"><div class="big danger">${I("circle-x")}</div><h1>Payjoin did not finish</h1><p>${/cancel/i.test(s?.error ?? "") ? "You cancelled this payment. Nothing was broadcast." : /expired/i.test(s?.error ?? "") ? "The other person did not add their coin before the link expired." : /wallet switched/i.test(s?.error ?? "") ? "You switched to another wallet while it was waiting, which ended it." : /lock|gone/i.test(s?.error ?? "") ? "PrivateBit was locked while waiting, which deleted this payment's keys." : "The other person's answer did not pass PrivateBit's checks."} ${/cancel/i.test(s?.error ?? "") ? "" : "PrivateBit did not broadcast anything."}</p></div>
  <div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">Your signed part is still in their mailbox</span>Until that coin is spent, they could still broadcast your original ${s?.amount ? fbShort(s.amount) : ""} payment. Sending without Payjoin spends the same coin, so you can never pay twice. This payment stays in Payment link history, not on the wallet.</div></div>`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="tab" data-to="send">Ask for a new link</button><button class="btn btn-secondary btn-block" type="button" data-act="send-plain" ${s?.inputs?.length && s.destination ? "" : html`aria-disabled="true" disabled`}>Send without Payjoin</button>`,
  };
};
actions["send-plain"] = () => {
  const s = lastSend();
  if (!s?.destination || !s.inputs?.length) return;
  clearForm();
  const to = classify(s.destination);
  S.f.to = to.kind === "none" || to.kind === "error" ? s.destination : to.address;
  if (s.amount) S.f.amt = fb(s.amount, { unit: false, trim: true });
  S.f.coinMode = "choose";
  S.f.coinsSel = s.inputs;
  go("send", {}, { reset: true });
};
actions["cancel-send"] = async (el) => {
  const id = el.dataset.id;
  if (!id) return;
  const r = await run("cancel-send", async () => {
    S.d.sessions = await call({ type: "CANCEL_SEND", id });
    await refresh();
    return true;
  });
  if (r) {
    toast("Payment cancelled. Nothing was broadcast.");
    render();
  }
};
actions["pj-check"] = async () => {
  const r = await run("pj-check", async () => {
    await call({ type: "SERVICE_PAYJOIN" });
    S.d.sessions = await call({ type: "SESSIONS" });
    await refresh();
    return true;
  });
  if (r) render();
};

/* ---------- full page send (F3) ---------- */
import { coinTable } from "./coins.ts";
function fullSend(): Safe {
  const { ok, d, amt } = formReady();
  const fixedAmt = (d.kind === "paylink" || d.kind === "notpb" || d.kind === "address") && d.amount !== undefined;
  const f = fees();
  const m = feeMode();
  const rate = feeRate();
  const sel = coins().filter((c) => chosen().includes(c.outpoint));
  const mix = coinMode() === "choose" && mixesLinkedAndPrivate(sel.map(statusOf));
  const vb = estimateVbytes(Math.max(1, coinMode() === "choose" ? sel.length : 1), 2);
  const feeEst = rate !== null ? BigInt(Math.ceil(vb * rate)) : null;
  const opts: [FeeMode, string, string, string][] = [
    ["slow", "Slow", f ? `${f.slow} sat/vB` : "No rate", "Can wait"],
    ["normal", "Normal", f ? `${f.normal} sat/vB` : "No rate", "Next few blocks"],
    ["fast", "Fast", f ? `${f.fast} sat/vB` : "No rate", "Next block"],
    ["custom", "Custom", "sat/vB", "You choose"],
  ];
  const cv = fv("feeCustom");
  const chk = cv ? checkCustomFee(Number(cv), minRate(), f?.fast ?? 1) : null;
  const lbl = fv("lbl");
  return html`<div class="topbar"><h1>Send</h1><span class="cap row" data-st="f0abc1">${NETLOGO()}On ${CHAIN()}</span></div>
  ${health() === "offline" ? html`<div class="banner danger">${I("unplug", "s16")}<div>Sending is paused until the block data service answers again.</div></div>` : ""}
  <div class="grid2 g-main">
    <div class="stack" data-st="2b9851">
      <section class="panel" aria-labelledby="to-h"><h2 id="to-h">Recipient</h2>${destField(d)}${destNote(d)}
        ${d.kind === "none" || d.kind === "error" || fixedAmt ? "" : html`<div class="grid2" data-st="eedf85">${amountField(amt)}${d.kind === "sp" || d.kind === "address" ? html`<div class="field"><label class="label" for="lbl">Who will know <span class="optl">(optional)</span></label><input class="input" id="lbl" data-f="lbl" maxlength="64" autocomplete="off" value="${lbl}" aria-describedby="lbl-h"><p class="help" id="lbl-h">Stays on this computer.</p></div>` : ""}</div>`}</section>
      ${d.kind === "paylink" ? "" : html`<section class="panel" aria-labelledby="pf-h"><div class="row between"><h2 id="pf-h">Pay from</h2><div class="seg" role="radiogroup" aria-label="Coin choice" data-st="a20ea0"><button type="button" role="radio" data-act="coin-mode" data-v="auto" aria-checked="${String(coinMode() === "auto")}">Automatic</button><button type="button" role="radio" data-act="coin-mode" data-v="choose" aria-checked="${String(coinMode() === "choose")}">Choose coins</button></div></div>
        ${coinMode() === "choose" ? (coins().length ? coinTable(true) : html`<p class="small muted">No coins yet. Coins show here after PrivateBit finds a payment to your receive code in a block.</p>`) : html`<p class="small muted">PrivateBit uses your largest coins first. Frozen and reserved coins are never picked.</p>`}
        ${mix ? html`<div class="banner warn" role="alert">${I("triangle-alert", "s16")}<div><span class="bt">This links your private coins to a linked coin</span>Spending a Linked coin together with a Private one shows anyone watching the old address that both are yours. <button class="link" type="button" data-act="only-private">Use only private coins</button></div></div>` : coinMode() === "choose" && sel.length ? html`<p class="small muted">Frozen and reserved coins are never picked. ${sel.length} ${sel.length === 1 ? "coin" : "coins"} selected, ${fbShort(sel.reduce((a, c) => a + BigInt(c.value), 0n))}.</p>` : ""}</section>`}
      <section class="panel" aria-labelledby="fee-h"><h2 id="fee-h">Network fee</h2>
        ${!f ? html`<div class="banner warn" role="status">${I("unplug", "s16")}<div>${S.d.feesErr === "rate-limited" ? "The block data service is limiting requests without an API key." : "Fee rates unavailable right now."} Choose Custom, or <button class="link" type="button" data-act="fees-retry">try again</button>.</div></div>` : ""}
        <div class="fees fees4" role="radiogroup" aria-label="Fee speed">${opts.map(([k, n, r, t]) => html`<button class="fee" type="button" role="radio" data-act="fee-mode" data-v="${k}" aria-checked="${String(k === m)}" ${k !== "custom" && !f ? html`aria-disabled="true" disabled` : ""}><span class="fn">${n}</span><span class="fr">${r}</span><span class="ft">${t}</span></button>`)}</div>
        ${m === "custom" ? html`<div class="field" data-st="3521b3"><label class="label" for="cf">Custom <span class="optl">(sat/vB)</span></label><div class="input-wrap"><input class="input mono" id="cf" data-f="feeCustom" data-live inputmode="decimal" placeholder="${String(minRate())}" value="${cv}" ${chk && !chk.ok ? html`aria-invalid="true" aria-describedby="cf-e"` : ""}><span class="unit">sat/vB</span></div>${chk && !chk.ok ? html`<p class="err" id="cf-e" role="alert">${I("circle-alert", "s16")}<span>${chk.reason === "too-low" ? `Too low. Below ${minRate()} sat/vB most nodes will not relay it, so it may never confirm.` : chk.reason === "too-high" ? "That is far above every current rate. Check the number." : "Enter a number."}</span></p>` : ""}</div>` : ""}
        <p class="small muted">${f ? `Rates from the ${f.source === "node" ? "your node" : "block data service"} at ${hm(f.updatedAt ?? f.fetchedAt)}. ` : ""}The fee does not change your privacy.</p></section>
    </div>
    <aside class="panel" aria-labelledby="sum-h" data-st="175507"><h2 id="sum-h">Summary</h2>
      ${sendPath(d)}
      <div class="hero-amt" data-st="3ce9d3"><p class="a">${amt.sats !== null && !amt.err ? fbShort(amt.sats, { unit: false }) : "0"}<span class="unit"> ${UNIT()}</span></p>${amt.sats && usd(amt.sats) ? html`<p class="fiat">${usd(amt.sats)}${lbl ? ` to ${lbl}` : ""}</p>` : ""}</div>
      <div class="kv">
        <div class="r"><span class="k">Privacy</span><span class="v">${d.kind === "sp" ? html`<span class="badge ok">${I("shield-check")}Private</span><span class="cap">New address only ${lbl || "they"} can find</span>` : d.kind === "paylink" ? html`<span class="badge ok">${I("route")}Payjoin</span>` : d.kind === "address" || d.kind === "notpb" ? html`<span class="badge warn">${I("triangle-alert")}Less private</span>` : html`<span class="muted">Paste a destination</span>`}</span></div>
        <div class="r"><span class="k">Pay from</span><span class="v">${coinMode() === "auto" ? "Automatic, largest first" : `${sel.length} ${sel.length === 1 ? "coin" : "coins"}`}</span></div>
        <div class="r"><span class="k">Network fee</span><span class="v">${feeEst !== null ? html`<span class="mono">About ${sats(feeEst)}</span><span class="cap">${feeName()}, ${rate} sat/vB</span>` : html`<span class="muted">Choose a rate</span>`}</span></div>
        ${amt.sats !== null && !amt.err && feeEst !== null ? html`<div class="r total"><span class="k">Total leaving</span><span class="v">About ${fb(amt.sats + feeEst)}</span></div>` : ""}</div>
      ${err("plan") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("plan")}</span></p>` : ""}
      <button class="btn btn-primary btn-block" type="button" data-act="review" ${ok && !busy("plan") ? "" : html`aria-disabled="true" disabled`}>${busy("plan") ? "Checking…" : d.kind === "notpb" ? "Review payment without Payjoin" : "Review"}</button></aside>
  </div>`;
}
actions["only-private"] = () => {
  const ids = new Set(coins().filter((c) => c.status === "private").map((c) => c.outpoint));
  S.f.coinsSel = chosen().filter((o) => ids.has(o));
  render();
};

void run;
void err;

/* ---------- held payment ("Delay sending by a random time") ---------- */

export function waitText(ms: number): string {
  if (ms <= 0) return "any moment now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `in ${s} ${s === 1 ? "second" : "seconds"}`;
  const m = Math.ceil(s / 60);
  return `in about ${m} ${m === 1 ? "minute" : "minutes"}`;
}

/** Card for a payment waiting to go out. Used on the held screen and on the wallet overview. */
export function heldCard(d: NonNullable<NonNullable<typeof S.b>["delayed"]>[number]): Safe {
  if (d.status === "failed") {
    return html`<div class="card pad-sm" role="status" data-held="${d.id}"><div class="row between" data-st="6ba842"><div class="stack" data-st="4e8132"><span class="badge danger">${I("circle-x")}Not sent</span><span class="strong">${fbShort(d.amount)}${d.label ? ` to ${d.label}` : ""}</span><span class="small muted" data-st="115422">The network refused it: ${d.error ?? "unknown reason"}. Your coins were not spent.</span></div>
    <button class="btn btn-secondary btn-sm" type="button" data-act="held-dismiss" data-id="${d.id}">Dismiss</button></div></div>`;
  }
  const left = d.sendAt - Date.now();
  return html`<div class="card pad-sm" role="status" data-held="${d.id}"><div class="stack" data-st="33fcd4"><div class="row" data-st="4725bb"><span class="badge warn">${I("timer")}Waiting to send</span><span class="small muted">Goes out ${waitText(left)}</span></div>
    <span class="strong">${fbShort(d.amount)}${d.label ? ` to ${d.label}` : ""}</span>
    <span class="small muted">Signed and kept on this computer, encrypted. Nothing has reached the network, so cancelling is safe.</span>
    <div class="row" data-st="4725bb"><button class="btn btn-primary btn-sm" type="button" data-act="held-now" data-id="${d.id}" ${busy("held") ? raw('aria-disabled="true"') : ""}>Send now</button><button class="btn btn-secondary btn-sm" type="button" data-act="held-cancel" data-id="${d.id}" ${busy("held") ? raw('aria-disabled="true"') : ""}>Cancel</button></div></div></div>`;
}

screens.held = () => {
  const h = S.d.held as { id: string; sendAt: number; amount: string; label?: string } | undefined;
  const d = (S.b?.delayed ?? []).find((x) => x.id === h?.id);
  const gone = !d;
  return {
    title: "Waiting to send",
    header: hdr({ title: "Waiting to send", back: false, net: true, close: true }),
    main: gone
      ? html`<div class="state"><div class="big">${I("circle-check")}</div><h1>${h ? fbShort(h.amount) : ""} sent</h1><p>It went out. You find it in Activity. ${blockTimeText()}</p></div>`
      : html`<div class="state"><div class="big neutral">${I("timer")}</div><h1>${fbShort(d.amount)} waits to be sent</h1><p>It goes out ${waitText(d.sendAt - Date.now())}, even if you close this window or lock.</p></div>${heldCard(d)}`,
  };
};

actions["held-now"] = (el) => {
  const id = el.dataset.id!;
  void run("held", async () => {
    const r = await call<{ sent: string[]; failed: string[]; bundle: NonNullable<typeof S.b> }>({ type: "DELAYED_SEND_NOW", id });
    S.b = r.bundle;
    toast(r.sent.length ? "Sent" : r.failed.length ? "The network refused it" : "Could not reach the network. It stays waiting.");
  });
};
actions["held-cancel"] = (el) => {
  const id = el.dataset.id!;
  void run("held", async () => {
    S.b = await call({ type: "DELAYED_CANCEL", id });
    toast("Cancelled. Nothing was sent.");
    if (S.route === "held") go("home", {}, { replace: true });
  });
};
actions["held-dismiss"] = (el) => {
  const id = el.dataset.id!;
  void run("held", async () => {
    S.b = await call({ type: "DELAYED_DISMISS", id });
  });
};
