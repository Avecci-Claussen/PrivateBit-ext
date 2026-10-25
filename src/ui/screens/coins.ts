import { S, screens, actions, loaders, back, go, render, run, fv, busy, err, toast } from "../app.ts";
import { call, type CoinView, type Fees } from "../api.ts";
import { html, I, fb, fbShort, sats, parseFb, mid, num, type Safe, UNIT, curNet } from "../kit.ts";
import { hostPermission } from "./settings.ts";
import type { ChainConfig } from "../../lib/network.ts";
import { hdr, tabs } from "../chrome.ts";
import { usd, hidden } from "../derive.ts";
import { explorerBlock, pathPreview, txidLine } from "../path.ts";
import { cleanLabel } from "../../lib/coinmeta.ts";
import { randomBytes } from "../../lib/bytes.ts";
import { DUST } from "../../lib/coinselect.ts";
import { SPLIT_MAX, SPLIT_MIN, checkSplit, shufflePieces, splitBudget } from "../../lib/split.ts";
import { randomSplitAmounts } from "../../lib/plan-random.ts";

export async function loadCoins(): Promise<void> {
  S.d.coins = await call<CoinView[]>({ type: "COINS" });
}
export const coins = (): CoinView[] => (S.d.coins as CoinView[] | undefined) ?? [];

function badge(c: CoinView): Safe {
  switch (c.status) {
    case "reserved":
      return c.held ? html`<span class="badge warn">${I("timer")}Waiting to send</span>` : html`<span class="badge">${I("lock-keyhole")}Reserved</span>`;
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
const name = (c: CoinView): string => c.label || (c.kind === "bip86" ? "One-time address" : "Not labeled");
function sub(c: CoinView): string {
  if (c.held) return "In a payment waiting to be sent";
  if (c.status === "reserved") return "For your payment link";
  if (c.status === "protected") return c.asset === "held" ? "Holds an inscription or rune" : "Protected, may hold an asset";
  if (c.reason) return c.reason;
  if (c.kind === "bip86") return "From your old wallet";
  if (c.status === "linked") return "From a reused address";
  return c.pending ? "Not in a block yet" : "Received with your code";
}
function icon(c: CoinView): [string, string] {
  if (c.status === "frozen") return ["snowflake", ""];
  if (c.status === "protected") return ["lock", "warn"];
  if (c.status === "linked") return ["arrow-right-left", "warn"];
  return ["arrow-down-left", "in"];
}
const amt = (c: CoinView): string => (hidden() ? "\u2022\u2022\u2022\u2022" : BigInt(c.value) < 100_000n ? sats(c.value) : fbShort(c.value));

screens.coins = () => {
  const list = coins();
  const st = S.b!.state;
  const frozen = list.filter((c) => c.status === "frozen" || c.status === "protected").length;
  const pend = BigInt(st.pending ?? "0");
  return {
    title: "Coins",
    header: hdr(),
    nav: tabs("coins"),
    main: list.length
      ? html`<div class="sec-h"><h1 data-st="9d50d4">Coins</h1><span class="cap num">${list.length} ${list.length === 1 ? "coin" : "coins"}</span></div>
  <p class="small muted">Each coin remembers who knows about it. Spending two coins together tells both sides they belong to you.</p>
  <div class="list">${list.map((c) => {
    const [ic, cls] = icon(c);
    return html`<a class="li" href="#" data-act="go" data-to="coin-detail" data-op="${c.outpoint}"><span class="ico ${cls}">${I(ic)}</span><span class="body"><span class="t">${name(c)}</span><span class="d">${sub(c)}</span></span><span class="end"><span class="amt">${amt(c)}</span><span class="row" data-st="d76768">${badge(c)}</span></span></a>`;
  })}</div>
  <div class="sumbar"><span class="muted">Spendable${frozen ? ", frozen and protected coins not counted" : ""}</span><b>${hidden() ? "\u2022\u2022\u2022\u2022" : fbShort(st.balance ?? "0")}</b></div>
  ${pend > 0n ? html`<div class="card flat pad-sm" data-st="5d98e3"><span class="grow small">${fbShort(pend)} incoming, not in a block yet</span>${I("clock", "s16")}</div>` : ""}`
      : html`<h1 data-st="9d50d4">Coins</h1><div class="state"><div class="big neutral">${I("coins")}</div><h1>No coins yet</h1><p>Each payment you receive becomes a coin here. You can label it with who knows about it, or freeze it so it is never spent.</p></div>`,
    page: fullCoins(),
  };
};
loaders.coins = loadCoins;

/* ---------- coin detail (50, 50b) ---------- */
const cur = (): CoinView | undefined => coins().find((c) => c.outpoint === S.params.op);
loaders["coin-detail"] = async () => {
  await loadCoins();
  const c = cur();
  S.f.who = c?.label ?? "";
  S.f.why = c?.reason ?? "";
};

screens["coin-detail"] = () => {
  const c = cur();
  if (!c) return { title: "Coin", header: hdr({ title: "Coin", net: true }), main: html`<p class="muted">This coin was spent or is no longer in this wallet.</p>` };
  const v = BigInt(c.value);
  const big = v < 100_000n ? html`${num(Number(v))}<span class="unit"> sats</span>` : html`${fbShort(v, { unit: false })}<span class="unit"> ${UNIT()}</span>`;
  const kv = html`<div class="card"><div class="kv">
    ${c.status === "frozen" ? html`<div class="r"><span class="k">Who knows</span><span class="v">${c.label || "Not labeled"}</span></div>${c.reason ? html`<div class="r"><span class="k">Why frozen</span><span class="v">${c.reason}</span></div>` : ""}` : ""}
    <div class="r"><span class="k">Type</span><span class="v">${c.kind === "bip86" ? "One-time address (Taproot)" : "Silent Payment output"}</span></div>
    <div class="r"><span class="k">Block</span><span class="v mono">${c.pending ? "Not yet" : num(c.height)}</span></div>
    <div class="r"><span class="k">Outpoint</span><span class="v mono">${mid(c.txid, 8, 6)}:${c.vout}</span></div></div></div>`;
  if (c.status === "frozen") {
    return {
      title: "Coin",
      header: hdr({ title: "Coin", net: true }),
      main: html`
  <div class="hero-amt"><p class="cap">Coin</p><p class="a">${big}</p><span class="badge frozen">${I("snowflake")}Frozen</span></div>
  <div class="banner">${I("snowflake", "s16")}<div><span class="bt">PrivateBit will never spend this coin</span>Not for payments, not for fees, not for Max. It is not counted in Available.</div></div>
  ${kv}
  <div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">Unfreezing can lose an inscription</span>PrivateBit does not track inscriptions. If this coin holds one and is spent in a payment, the inscription goes with it.</div></div>`,
      foot: html`<button class="btn btn-secondary btn-block" type="button" data-act="coin-freeze" data-v="0">${I("sun", "s16")}Unfreeze this coin</button>`,
    };
  }
  if (c.status === "protected") return protectedDetail(c, big, kv);
  const linked = c.status === "linked";
  const reserved = c.status === "reserved";
  return {
    title: "Coin",
    header: hdr({ title: "Coin", net: true }),
    main: html`
  <div class="hero-amt"><p class="cap">Coin</p><p class="a">${big}</p>${usd(v) ? html`<p class="fiat">${usd(v)}</p>` : ""}${linked ? html`<span class="badge warn">${I("triangle-alert")}Linked to a reused address</span>` : reserved ? (c.held ? html`<span class="badge warn">${I("timer")}In a payment waiting to be sent</span>` : html`<span class="badge">${I("lock-keyhole")}Reserved for a payment link</span>`) : html`<span class="badge ok">${I("shield-check")}Private</span>`}</div>
  <div class="field"><label class="label" for="who">Who knows about this coin</label><input class="input" id="who" data-f="who" maxlength="64" autocomplete="off" value="${fv("who")}" aria-describedby="who-h"><p class="help" id="who-h">Name people or services, not the reason. Such as a friend's name or "old wallet".</p></div>
  <label class="li swrow flat" for="fz"><span class="body"><span class="t">Freeze this coin</span><span class="d">Frozen coins are never picked for a payment, not even by Max.</span></span><input class="switch" type="checkbox" role="switch" id="fz" data-act="coin-freeze" data-v="1" ${reserved ? html`disabled` : ""}></label>
  ${c.kind === "bip86" ? "" : html`<label class="li swrow flat" for="lk"><span class="body"><span class="t">Mark as linked</span><span class="d">Turn on if this coin came from an address other people know. Spending it with private coins then shows a warning.</span></span><input class="switch" type="checkbox" role="switch" id="lk" data-act="coin-linked" ${c.linked ? html`checked` : ""}></label>`}
  ${kv}
  ${c.assetOk ? html`<div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">Unlocked by you</span>This small Taproot coin may hold an inscription or rune, and PrivateBit can now spend it. <button class="link" type="button" data-act="coin-asset-protect">Protect it again</button></div></div>` : ""}
  ${canSplit(c) ? html`<button class="btn btn-secondary btn-block" type="button" data-act="go" data-to="coin-split" data-op="${c.outpoint}">${I("coins", "s16")}Break into pieces</button>` : ""}
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="coin-save" ${busy("coin") ? html`aria-disabled="true"` : ""}>Save label</button>`,
  };
};

function canSplit(c: CoinView): boolean {
  return c.kind !== "bip86" && c.status !== "frozen" && c.status !== "reserved" && c.status !== "protected" && !c.pending && BigInt(c.value) >= 100_000n;
}

/* ---------- 1.0.0 asset guard: protected small Taproot coins ---------- */
const chainCfg = (): ChainConfig => S.b!.state.chain;
function protectedDetail(c: CoinView, big: Safe, kv: Safe) {
  const ord = chainCfg().ordUrl;
  const held = c.asset === "held";
  const check = S.d.assetCheck as { op: string; verdict: string } | undefined;
  const unknown = check?.op === c.outpoint && check.verdict === "unknown";
  return {
    title: "Coin",
    header: hdr({ title: "Coin", net: true }),
    main: html`
  <div class="hero-amt"><p class="cap">Coin</p><p class="a">${big}</p><span class="badge warn">${I("lock")}Protected, may hold an asset</span></div>
  ${held
    ? html`<div class="banner danger" role="alert">${I("triangle-alert", "s16")}<div><span class="bt">Your ord server says this coin holds an inscription or rune</span>Spending it in a payment would send that asset too, or lose it to fees.</div></div>`
    : html`<div class="banner">${I("lock", "s16")}<div><span class="bt">PrivateBit will not spend this coin by itself</span>PrivateBit does not read inscriptions or runes yet. Small Taproot coins like this one often carry one, so it is left out of payments, fees, Max, payment links and waiting payments.</div></div>`}
  ${kv}
  <section class="card" aria-labelledby="ord-h"><h2 id="ord-h" class="strong">Check with an ord server</h2>
  ${ord
    ? html`<p class="small muted">Asks ${hostOf(ord)} about this one coin. That server learns this coin is yours.</p>${unknown ? html`<p class="small" role="status">The server could not say for sure. The coin stays protected.</p>` : ""}<div class="row"><button class="btn btn-secondary" type="button" data-act="coin-asset-check" ${busy("asset") ? html`aria-disabled="true"` : ""}>${busy("asset") ? "Checking…" : "Check this coin"}</button><button class="link small" type="button" data-act="coin-ord-clear">Remove server</button></div>`
    : html`<p class="small muted">Point PrivateBit at your own ord server${curNet() === "bitcoin" ? ", or ordinals.com," : ""} to check this coin. Nothing is asked until you tap Check.</p>
  <div class="field"><label class="label" for="ordu">ord server address</label><input class="input mono" id="ordu" data-f="ordu" autocomplete="off" placeholder="http://127.0.0.1:80" value="${fv("ordu")}"></div>
  <div class="row">${curNet() === "bitcoin" ? html`<button class="btn btn-secondary" type="button" data-act="coin-ord-save" data-v="https://ordinals.com">Use ordinals.com</button>` : ""}<button class="btn btn-secondary" type="button" data-act="coin-ord-save">Save address</button></div>`}
  </section>
  <section class="card" aria-labelledby="unl-h"><h2 id="unl-h" class="strong">Unlock by hand</h2>
  <p class="small muted">Only if you know this coin holds no inscription or rune. After unlocking, PrivateBit may use it in any payment.</p>
  <label class="check"><input type="checkbox" data-f="assetAck" ${S.f.assetAck ? html`checked` : ""}> <span>I understand an inscription or rune in this coin would be spent with it${held ? ", and my ord server says it holds one" : ""}.</span></label>
  <button class="btn btn-secondary btn-block" type="button" data-act="coin-asset-unlock" ${S.f.assetAck ? "" : html`aria-disabled="true" disabled`}>${I("lock-keyhole", "s16")}Unlock this coin</button></section>
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}`,
  };
}
function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}
actions["coin-asset-unlock"] = async () => {
  const c = cur();
  if (!c || !S.f.assetAck) return;
  const ok = await run("form", async () => {
    S.d.coins = await call({ type: "SET_COIN_META", outpoint: c.outpoint, patch: { assetOk: true } });
    S.b && (S.b = await call({ type: "BUNDLE" }));
    return true;
  });
  S.f.assetAck = false;
  if (ok) toast("Coin unlocked. PrivateBit may spend it now.");
};
actions["coin-asset-protect"] = async () => {
  const c = cur();
  if (!c) return;
  await run("form", async () => {
    S.d.coins = await call({ type: "SET_COIN_META", outpoint: c.outpoint, patch: { assetOk: false } });
    S.b && (S.b = await call({ type: "BUNDLE" }));
  });
  toast("Coin protected again.");
};
actions["coin-ord-save"] = async (el) => {
  const url = ((el.dataset.v as string | undefined) ?? fv("ordu")).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(url)) {
    S.err.form = "Enter the server address, starting with http:// or https://.";
    render();
    return;
  }
  if (!(await hostPermission(url))) {
    S.err.form = "Access to that address was not allowed.";
    render();
    return;
  }
  await run("form", async () => {
    await call({ type: "SAVE_CHAIN", chain: { ...chainCfg(), ordUrl: url } });
    S.b && (S.b = await call({ type: "BUNDLE" }));
  });
};
actions["coin-ord-clear"] = async () => {
  await run("form", async () => {
    await call({ type: "SAVE_CHAIN", chain: { ...chainCfg(), ordUrl: undefined } });
    S.b && (S.b = await call({ type: "BUNDLE" }));
  });
};
actions["coin-asset-check"] = async () => {
  const c = cur();
  if (!c) return;
  S.busy = "asset";
  delete S.err.form;
  render();
  try {
    const r = await call<{ verdict: string; coins: CoinView[] }>({ type: "ASSET_CHECK", outpoint: c.outpoint });
    S.d.coins = r.coins;
    S.d.assetCheck = { op: c.outpoint, verdict: r.verdict };
    S.b = await call({ type: "BUNDLE" });
    toast(r.verdict === "none" ? "No inscription or rune found. The coin is unlocked." : r.verdict === "held" ? "This coin holds an inscription or rune. It stays protected." : "Not sure. The coin stays protected.");
  } catch (e) {
    S.err.form = String((e as Error).message);
  }
  S.busy = null;
  render();
};

/* ---------- break into pieces (user-set amounts, optional shuffle) ---------- */
type SplitPlan = { pieces: string[]; userAmounts: string[]; fee: string; amount: string; vbytes: number; note: string; rate: number };

function splitN(): number {
  const n = Number(fv("splitN") || "2");
  return n >= SPLIT_MIN && n <= SPLIT_MAX ? n : SPLIT_MIN;
}
function splitRate(): number {
  const f = S.d.fees as Fees | undefined;
  return f?.normal ?? 1;
}
function pieceFb(i: number): string {
  return fv(`sp${i}`);
}
function pieceSats(i: number): bigint | null {
  const t = pieceFb(i).trim();
  if (!t) return null;
  return parseFb(t);
}
function readPieces(n: number): { raw: string[]; sats: (bigint | null)[] } {
  const raw: string[] = [];
  const satsV: (bigint | null)[] = [];
  for (let i = 0; i < n; i++) {
    raw.push(pieceFb(i));
    satsV.push(pieceSats(i));
  }
  return { raw, sats: satsV };
}
function splitState(c: CoinView): {
  n: number;
  fee: bigint;
  spendable: bigint | null;
  filled: bigint[];
  assigned: bigint;
  left: bigint | null;
  check: ReturnType<typeof checkSplit> | null;
  incomplete: boolean;
  parseErr: string | undefined;
} {
  const n = splitN();
  let fee = 0n;
  let spendable: bigint | null = null;
  try {
    const b = splitBudget(BigInt(c.value), n, splitRate());
    fee = b.fee;
    spendable = b.spendable;
  } catch (e) {
    return {
      n,
      fee: 0n,
      spendable: null,
      filled: [],
      assigned: 0n,
      left: null,
      check: null,
      incomplete: true,
      parseErr: (e as Error).message,
    };
  }
  const { sats: parsed } = readPieces(n);
  const parseErr = parsed.some((v, i) => pieceFb(i).trim() !== "" && v === null)
    ? "Enter amounts like 0.1, with up to 8 decimals."
    : parsed.some((v) => v !== null && v < DUST)
      ? "Each piece must be at least 330 sats so it can be spent later."
      : undefined;
  const filled = parsed.flatMap((v) => (v === null ? [] : [v]));
  const assigned = filled.reduce((a, b) => a + b, 0n);
  const incomplete = parsed.some((v) => v === null);
  const check = !incomplete && !parseErr && spendable !== null ? checkSplit(filled, spendable) : null;
  return { n, fee, spendable, filled, assigned, left: spendable === null ? null : spendable - assigned, check, incomplete, parseErr };
}

async function loadSplitFees(): Promise<void> {
  try {
    S.d.fees = await call<Fees>({ type: "FEE_RATES" });
  } catch {
    /* relay minimum */
  }
}

loaders["coin-split"] = async () => {
  await Promise.all([loadCoins(), S.d.fees ? Promise.resolve() : loadSplitFees()]);
  if (!fv("splitN")) S.f.splitN = "2";
};
loaders["coin-split-review"] = loadCoins;

screens["coin-split"] = () => {
  const c = cur();
  if (!c || !canSplit(c)) {
    return { title: "Break into pieces", header: hdr({ title: "Break into pieces", net: true }), main: html`<p class="muted">This coin cannot be broken up.</p>` };
  }
  const st = splitState(c);
  const ready = st.check?.ok === true;
  const errMsg = st.parseErr || (st.check && !st.check.ok ? st.check.reason : undefined);
  const seg = (n: number, l: string) =>
    html`<button type="button" role="radio" data-act="split-n" data-v="${String(n)}" aria-checked="${String(st.n === n)}">${l}<small>${n} coins</small></button>`;
  const rows = Array.from({ length: st.n }, (_, i) => {
    const v = pieceFb(i);
    const parsed = pieceSats(i);
    const bad = v.trim() !== "" && (parsed === null || parsed < DUST);
    return html`<div class="field"><div class="row between"><label class="label" for="sp${i}">Piece ${i + 1}</label><button class="link small" type="button" data-act="split-rest" data-i="${String(i)}" ${st.spendable === null ? html`disabled` : ""}>Put rest here</button></div>
  <div class="input-wrap"><input class="input mono" id="sp${i}" data-f="sp${i}" data-live inputmode="decimal" autocomplete="off" placeholder="0.00" value="${v}" ${bad ? html`aria-invalid="true"` : ""}><span class="unit">${UNIT()}</span></div>
  ${parsed !== null && parsed > 0n ? html`<p class="help">${sats(parsed)}</p>` : ""}</div>`;
  });
  const left = st.left;
  const meter =
    st.spendable === null
      ? ""
      : left === 0n && ready
        ? html`<div class="card flat pad-sm"><p class="small strong">All ${fbShort(st.spendable)} assigned. Shuffle the order if you want, then review.</p></div>`
        : left !== null && left > 0n
          ? html`<div class="card flat pad-sm"><p class="small">${fbShort(left)} still unassigned of ${fbShort(st.spendable)} after the fee.</p></div>`
          : left !== null && left < 0n
            ? html`<div class="banner warn">${I("triangle-alert", "s16")}<div>${fbShort(-left)} over what this coin can hold after the fee.</div></div>`
            : "";
  return {
    title: "Break into pieces",
    header: hdr({ title: "Break into pieces", net: true }),
    main: html`
  <div class="hero-amt"><p class="cap">This coin</p><p class="a">${fbShort(c.value, { unit: false })}<span class="unit"> ${UNIT()}</span></p><p class="fiat">${sats(c.value)} before the network fee</p></div>
  ${pathPreview({ title: name(c), sub: fbShort(c.value) }, { title: "Your receive code", sub: `${st.n} pieces you still own` })}
  <div class="banner">${I("info", "s16")}<div><span class="bt">You choose the sizes</span>Type each amount, or use Randomize amounts for uneven sizes. Equal amounts are blocked because they look like a mix. Anyone who sees this transaction can tell the pieces were created together. Later you can spend one without spending the others.</div></div>
  <div class="field"><p class="label" id="sn">How many pieces</p><div class="seg tall" role="radiogroup" aria-labelledby="sn">${seg(2, "Two")}${seg(3, "Three")}${seg(4, "Four")}${seg(5, "Five")}${seg(6, "Six")}</div></div>
  <div class="card"><div class="kv">
    <div class="r"><span class="k">Network fee</span><span class="v mono">${sats(st.fee)}</span></div>
    <div class="r"><span class="k">To assign</span><span class="v mono">${st.spendable !== null ? fb(st.spendable) : "Waiting for the fee"}</span></div>
    <div class="r"><span class="k">Assigned</span><span class="v mono">${fb(st.assigned)}</span></div></div></div>
  ${rows}${meter}
  ${errMsg ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${errMsg}</span></p>` : ""}
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}
  <p class="small muted">Shuffle only changes the order of the amounts already there. Randomize amounts fills every piece with a new uneven size that adds up to the whole coin. The pieces keep this coin's label.</p>`,
    foot: html`<div class="stack"><div class="row"><button class="btn btn-secondary grow" type="button" data-act="split-random" ${st.spendable === null ? html`disabled aria-disabled="true"` : ""}>${I("coins", "s16")}Randomize amounts</button><button class="btn btn-secondary grow" type="button" data-act="split-shuffle" ${st.filled.length < 2 ? html`disabled aria-disabled="true"` : ""}>${I("refresh-cw", "s16")}Shuffle order</button></div><button class="btn btn-primary btn-block" type="button" data-act="split-review" ${ready && !busy("split") ? "" : html`disabled aria-disabled="true"`}>${busy("split") ? html`${I("loader-circle", "s16 spin")}Checking…` : "Review split"}</button></div>`,
  };
};

screens["coin-split-review"] = () => {
  const c = cur();
  const p = S.d.splitPlan as SplitPlan | undefined;
  if (!c || !p) {
    return { title: "Review split", header: hdr({ title: "Review split", net: true }), main: html`<p class="muted">Go back and set the amounts first.</p>` };
  }
  const pieces = p.pieces.map((v, i) => html`<div class="r"><span class="k">On-chain ${i + 1}</span><span class="v mono">${fb(v)}</span></div>`);
  return {
    title: "Review split",
    header: hdr({ title: "Review split", net: true }),
    main: html`
  <div class="hero-amt"><p class="cap">Break into ${p.pieces.length} coins</p><p class="a">${fbShort(p.amount, { unit: false })}<span class="unit"> ${UNIT()}</span></p><p class="fiat">${sats(p.amount)} after a ${sats(p.fee)} fee</p></div>
  ${pathPreview({ title: name(c), sub: fbShort(c.value) }, { title: "Your receive code", sub: `${p.pieces.length} pieces you still own` })}
  <div class="card"><div class="kv">${pieces}
    <div class="r"><span class="k">Network fee</span><span class="v"><span class="mono">${sats(p.fee)}</span><span class="cap">${p.rate} sat/vB, ${num(p.vbytes)} vB</span></span></div>
    <div class="r total"><span class="k">This coin</span><span class="v">${fb(c.value)}</span></div></div></div>
  <p class="small muted">Sizes you chose. On-chain order follows the Silent Payment output keys, not the list you typed.</p>
  <div class="banner">${I("info", "s16")}<div><span class="bt">Not a mix</span>${p.note}</div></div>
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}`,
    foot: { cls: "row", html: html`<button class="btn btn-secondary" type="button" data-act="back">Edit</button><button class="btn btn-primary" type="button" data-act="split-go" ${busy("split") ? html`aria-disabled="true"` : ""}>${busy("split") ? html`${I("loader-circle", "s16 spin")}Breaking…` : "Break this coin"}</button>` },
  };
};

actions["split-n"] = (el) => {
  S.f.splitN = el.dataset.v!;
  render();
};
actions["split-rest"] = (el) => {
  const c = cur();
  if (!c) return;
  const i = Number(el.dataset.i);
  const st = splitState(c);
  if (st.spendable === null || Number.isNaN(i)) return;
  const others = st.n === 0 ? 0n : Array.from({ length: st.n }, (_, j) => (j === i ? 0n : pieceSats(j) ?? 0n)).reduce((a, b) => a + b, 0n);
  const rest = st.spendable - others;
  if (rest < DUST) {
    S.err.form = "Not enough left for this piece after the others.";
    render();
    return;
  }
  delete S.err.form;
  S.f[`sp${i}`] = fb(rest, { unit: false, trim: true });
  render();
};
actions["split-shuffle"] = () => {
  const n = splitN();
  const { raw } = readPieces(n);
  if (raw.filter((x) => x.trim()).length < 2) return;
  const next = shufflePieces(raw, randomBytes(32));
  next.forEach((v, i) => {
    S.f[`sp${i}`] = v;
  });
  toast("Order shuffled. Check each piece, then review.");
  render();
};
actions["split-random"] = () => {
  const c = cur();
  if (!c) return;
  const st = splitState(c);
  if (st.spendable === null) return;
  try {
    const amounts = randomSplitAmounts(st.spendable, st.n, randomBytes(st.n * 6 + 8));
    amounts.forEach((v, i) => {
      S.f[`sp${i}`] = fb(v, { unit: false, trim: true });
    });
    delete S.err.form;
    toast("New random sizes. Change any of them if you like.");
  } catch (e) {
    S.err.form = (e as Error).message;
  }
  render();
};
actions["split-review"] = async () => {
  const c = cur();
  if (!c) return;
  const st = splitState(c);
  if (!st.check || !st.check.ok) return;
  const userAmounts = st.check.amounts.map((a) => a.toString());
  const ok = await run("split", async () => {
    const plan = await call<Omit<SplitPlan, "rate" | "userAmounts">>({
      type: "SPLIT_PLAN",
      outpoint: c.outpoint,
      amounts: userAmounts,
      feeRate: splitRate(),
    });
    S.d.splitPlan = { ...plan, userAmounts, rate: splitRate() };
    return true;
  });
  if (ok) go("coin-split-review", { op: c.outpoint });
};
actions["split-go"] = async () => {
  const c = cur();
  const p = S.d.splitPlan as SplitPlan | undefined;
  if (!c || !p) return;
  const r = await run("split", async () =>
    call<{ kind?: string; txid?: string }>({
      type: "SPLIT_COIN",
      outpoint: c.outpoint,
      amounts: p.userAmounts,
      feeRate: p.rate,
    }),
  );
  if (!r) return;
  const txid = r.txid;
  S.d.splitDone = {
    txid,
    pieces: p.pieces,
    fee: p.fee,
    amount: p.amount,
    from: { title: name(c), sub: fbShort(c.value) },
    to: { title: "Your receive code", sub: `${p.pieces.length} pieces you still own` },
  };
  if (txid) S.d.exploreTxid = txid;
  S.d.splitPlan = undefined;
  await loadCoins();
  go("coin-split-done", {}, { replace: true });
};

screens["coin-split-done"] = () => {
  const d = S.d.splitDone as
    | { txid?: string; pieces: string[]; fee: string; amount: string; from: { title: string; sub?: string }; to: { title: string; sub?: string } }
    | undefined;
  if (!d) {
    return { title: "Broke into pieces", header: hdr({ title: "Broke into pieces", net: true }), main: html`<p class="muted">This split is no longer on this screen. Check Activity.</p>` };
  }
  const ask = S.b!.prefs.askExplorer !== false;
  return {
    title: "Broke into pieces",
    header: hdr({ title: "Broke into pieces", back: false, net: true, close: true }),
    main: html`
  <div class="state"><div class="big">${I("circle-check")}</div><h1>Broke into ${d.pieces.length} coins</h1><p>${fbShort(d.amount)} under your receive code. Anyone who sees this transaction can tell the pieces were created together.</p></div>
  ${pathPreview(d.from, d.to)}
  <div class="card"><div class="kv">
    ${d.txid ? txidLine(d.txid) : ""}
    <div class="r"><span class="k">Network fee</span><span class="v mono">${sats(d.fee)}</span></div>
    ${d.pieces.map((v, i) => html`<div class="r"><span class="k">Piece ${i + 1}</span><span class="v mono">${fb(v)}</span></div>`)}</div></div>
  ${d.txid ? explorerBlock(S.f.explorerAsk === true, ask) : ""}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="home">Done</button><button class="btn btn-ghost btn-block" type="button" data-act="tab" data-to="coins">See coins</button>`,
  };
};
actions["coin-save"] = async () => {
  const c = cur();
  if (!c) return;
  const ok = await run("coin", async () => {
    S.d.coins = await call({ type: "SET_COIN_META", outpoint: c.outpoint, patch: { label: cleanLabel(fv("who")) ?? "" } });
    return true;
  });
  if (ok) {
    toast("Label saved.");
    back("coins");
  }
};
actions["coin-freeze"] = async (el, ev) => {
  ev.preventDefault();
  const op = (el.dataset.op as string | undefined) ?? (cur()?.outpoint as string);
  const on = el.dataset.v === "1" || (el.dataset.v === undefined && !coins().find((c) => c.outpoint === op)?.frozen);
  await run("coin", async () => {
    S.d.coins = await call({ type: "SET_COIN_META", outpoint: op, patch: { frozen: on } });
    S.b && (S.b = await call({ type: "BUNDLE" }));
  });
  toast(on ? "Coin frozen. It will never be spent." : "Coin unfrozen.");
};
actions["coin-linked"] = async (el, ev) => {
  ev.preventDefault();
  const c = cur();
  if (!c) return;
  await run("coin", async () => {
    S.d.coins = await call({ type: "SET_COIN_META", outpoint: c.outpoint, patch: { linked: !c.linked } });
  });
};

/* ---------- tables for the full page (F1, F3, F6) ---------- */
export function coinTable(select: boolean): Safe {
  const list = coins();
  const sel = Array.isArray(S.f.coinsSel) ? (S.f.coinsSel as string[]) : [];
  return html`<div class="tscroll" tabindex="0" role="region" aria-label="Coins table"><table class="t"><caption class="sr-only">Coins</caption><thead><tr>${select ? html`<th scope="col"><span class="sr-only">Select</span></th>` : ""}<th scope="col">Who knows</th><th scope="col" class="col-hide">Outpoint</th>${select ? "" : html`<th scope="col" class="col-hide">Block</th>`}<th scope="col" class="r">Amount (FB)</th><th scope="col" class="col-hide">Status</th>${select ? html`<th scope="col">Freeze</th>` : ""}</tr></thead><tbody>
  ${list.map((c) => {
    const off = c.status === "frozen" || c.status === "reserved" || c.status === "protected";
    return html`<tr>${select ? html`<td><label class="cell-hit"><input type="checkbox" data-act="coin-pick" data-op="${c.outpoint}" aria-label="Select ${name(c)}" ${sel.includes(c.outpoint) ? html`checked` : ""} ${off ? html`disabled` : ""} data-st="d696c2"></label></td>` : ""}<td><a class="link" href="#" data-act="go" data-to="coin-detail" data-op="${c.outpoint}">${name(c)}</a><div class="cap">${sub(c)}</div><div class="m-only">${badge(c)}</div></td><td class="col-hide mono nw">${mid(c.txid, 8, 6)}:${c.vout}</td>${select ? "" : html`<td class="col-hide num">${c.pending ? "Not yet" : num(c.height)}</td>`}<td class="amt">${hidden() ? "\u2022\u2022\u2022\u2022" : fb(c.value, { unit: false })}</td><td class="col-hide">${badge(c)}</td>${select ? html`<td><label class="cell-hit"><input class="switch" type="checkbox" role="switch" data-act="coin-freeze" data-op="${c.outpoint}" aria-label="Freeze ${name(c)}" ${c.frozen ? html`checked` : ""} ${c.status === "reserved" ? html`disabled` : ""}></label></td>` : ""}</tr>`;
  })}
  </tbody></table></div>`;
}

function fullCoins(): Safe {
  const list = coins();
  const st = S.b!.state;
  const sel = Array.isArray(S.f.coinsSel) ? (S.f.coinsSel as string[]) : [];
  const selTotal = list.filter((c) => sel.includes(c.outpoint)).reduce((a, c) => a + BigInt(c.value), 0n);
  const frozen = list.some((c) => c.status === "frozen" || c.status === "protected");
  return html`<div class="topbar"><h1>Coins</h1><span class="cap tb-note">Spendable ${fbShort(st.balance ?? "0")}${frozen ? ", frozen and protected coins not counted" : ""}</span><button class="btn btn-primary" type="button" data-act="send-selected" ${sel.length ? "" : html`aria-disabled="true" disabled`}>${I("arrow-up-right", "s16")}Send selected</button></div>
  <p class="muted" data-st="49f077">Each coin remembers who knows about it. Spending two coins together tells both sides they belong to you. Freeze coins you never want spent. Small Taproot coins that may hold an inscription or rune are protected for you.</p>
  <section class="panel" aria-labelledby="c-h"><div class="row between"><h2 id="c-h">${list.length} ${list.length === 1 ? "coin" : "coins"}</h2><span class="cap">${sel.length} selected${sel.length ? `, ${fbShort(selTotal)}` : ""}</span></div>${list.length ? coinTable(true) : html`<p class="small muted">No coins yet. Each payment you receive becomes a coin here.</p>`}</section>
  <section class="panel" aria-labelledby="l-h"><h2 id="l-h">What the labels mean</h2><div class="kv">
    <div class="r"><span class="k"><span class="badge ok">Private</span></span><span class="v">Arrived at a Silent Payment output. Only the sender knows.</span></div>
    <div class="r"><span class="k"><span class="badge warn">Linked</span></span><span class="v">Came from a reused address. Anyone watching it knows.</span></div>
    <div class="r"><span class="k"><span class="badge">${I("lock-keyhole")}Reserved</span></span><span class="v">Set aside for an open payment link.</span></div>
    <div class="r"><span class="k"><span class="badge frozen">${I("snowflake")}Frozen</span></span><span class="v">Never spent by PrivateBit until you unfreeze it.</span></div>
    <div class="r"><span class="k"><span class="badge warn">${I("lock")}Protected</span></span><span class="v">A small Taproot coin that may hold an inscription or rune. Not spent until you check or unlock it.</span></div></div></section>`;
}
actions["send-selected"] = () => {
  S.f.coinMode = "choose";
  go("send");
};
void render;
