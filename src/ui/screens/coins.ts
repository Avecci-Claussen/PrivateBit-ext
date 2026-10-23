import { S, screens, actions, loaders, back, render, run, fv, busy, err, toast } from "../app.ts";
import { call, type CoinView } from "../api.ts";
import { html, I, fb, fbShort, sats, mid, num, type Safe } from "../kit.ts";
import { hdr, tabs } from "../chrome.ts";
import { usd, hidden } from "../derive.ts";
import { cleanLabel } from "../../lib/coinmeta.ts";

export async function loadCoins(): Promise<void> {
  S.d.coins = await call<CoinView[]>({ type: "COINS" });
}
export const coins = (): CoinView[] => (S.d.coins as CoinView[] | undefined) ?? [];

function badge(c: CoinView): Safe {
  switch (c.status) {
    case "reserved":
      return html`<span class="badge">${I("lock-keyhole")}Reserved</span>`;
    case "frozen":
      return html`<span class="badge frozen">${I("snowflake")}Frozen</span>`;
    case "linked":
      return html`<span class="badge warn">Linked</span>`;
    default:
      return html`<span class="badge ok">Private</span>`;
  }
}
const name = (c: CoinView): string => c.label || (c.kind === "bip86" ? "One-time address" : "Not labeled");
function sub(c: CoinView): string {
  if (c.status === "reserved") return "For your payment link";
  if (c.reason) return c.reason;
  if (c.kind === "bip86") return "From your old wallet";
  if (c.status === "linked") return "From a reused address";
  return c.pending ? "Not in a block yet" : "Received with your code";
}
function icon(c: CoinView): [string, string] {
  if (c.status === "frozen") return ["snowflake", ""];
  if (c.status === "linked") return ["arrow-right-left", "warn"];
  return ["arrow-down-left", "in"];
}
const amt = (c: CoinView): string => (hidden() ? "\u2022\u2022\u2022\u2022" : BigInt(c.value) < 100_000n ? sats(c.value) : fbShort(c.value));

screens.coins = () => {
  const list = coins();
  const st = S.b!.state;
  const frozen = list.filter((c) => c.status === "frozen").length;
  const pend = BigInt(st.pending ?? "0");
  return {
    title: "Coins",
    header: hdr(),
    nav: tabs("coins"),
    main: list.length
      ? html`<div class="sec-h"><h1 style="font:var(--t-title)">Coins</h1><span class="cap num">${list.length} ${list.length === 1 ? "coin" : "coins"}</span></div>
  <p class="small muted">Each coin remembers who knows about it. Spending two coins together tells both sides they belong to you.</p>
  <div class="list">${list.map((c) => {
    const [ic, cls] = icon(c);
    return html`<a class="li" href="#" data-act="go" data-to="coin-detail" data-op="${c.outpoint}"><span class="ico ${cls}">${I(ic)}</span><span class="body"><span class="t">${name(c)}</span><span class="d">${sub(c)}</span></span><span class="end"><span class="amt">${amt(c)}</span><span class="row" style="gap:4px">${badge(c)}</span></span></a>`;
  })}</div>
  <div class="sumbar"><span class="muted">Spendable${frozen ? ", frozen coin not counted" : ""}</span><b>${hidden() ? "\u2022\u2022\u2022\u2022" : fbShort(st.balance ?? "0")}</b></div>
  ${pend > 0n ? html`<div class="card flat pad-sm" style="flex-direction:row;align-items:center"><span class="grow small">${fbShort(pend)} incoming, not in a block yet</span>${I("clock", "s16")}</div>` : ""}`
      : html`<h1 style="font:var(--t-title)">Coins</h1><div class="state"><div class="big neutral">${I("coins")}</div><h1>No coins yet</h1><p>Each payment you receive becomes a coin here. You can label it with who knows about it, or freeze it so it is never spent.</p></div>`,
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
  const big = v < 100_000n ? html`${num(Number(v))}<span class="unit"> sats</span>` : html`${fbShort(v, { unit: false })}<span class="unit"> FB</span>`;
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
  const linked = c.status === "linked";
  const reserved = c.status === "reserved";
  return {
    title: "Coin",
    header: hdr({ title: "Coin", net: true }),
    main: html`
  <div class="hero-amt"><p class="cap">Coin</p><p class="a">${big}</p>${usd(v) ? html`<p class="fiat">${usd(v)}</p>` : ""}${linked ? html`<span class="badge warn">${I("triangle-alert")}Linked to a reused address</span>` : reserved ? html`<span class="badge">${I("lock-keyhole")}Reserved for a payment link</span>` : html`<span class="badge ok">${I("shield-check")}Private</span>`}</div>
  <div class="field"><label class="label" for="who">Who knows about this coin</label><input class="input" id="who" data-f="who" maxlength="64" autocomplete="off" value="${fv("who")}" aria-describedby="who-h"><p class="help" id="who-h">Name people or services, not the reason. For example a friend's name or "old wallet".</p></div>
  <div class="li" style="padding:0;min-height:auto;cursor:default"><span class="body"><label class="t" for="fz">Freeze this coin</label><span class="d" style="white-space:normal">Frozen coins are never picked for a payment, not even by Max.</span></span><input class="switch" type="checkbox" role="switch" id="fz" data-act="coin-freeze" data-v="1" ${reserved ? html`disabled` : ""}></div>
  ${c.kind === "bip86" ? "" : html`<div class="li" style="padding:0;min-height:auto;cursor:default"><span class="body"><label class="t" for="lk">Mark as linked</label><span class="d" style="white-space:normal">Turn on if this coin came from an address other people know. Spending it with private coins then shows a warning.</span></span><input class="switch" type="checkbox" role="switch" id="lk" data-act="coin-linked" ${c.linked ? html`checked` : ""}></div>`}
  ${kv}
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="coin-save" ${busy("coin") ? html`aria-disabled="true"` : ""}>Save label</button>`,
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
    const off = c.status === "frozen" || c.status === "reserved";
    return html`<tr>${select ? html`<td><input type="checkbox" data-act="coin-pick" data-op="${c.outpoint}" aria-label="Select ${name(c)}" ${sel.includes(c.outpoint) ? html`checked` : ""} ${off ? html`disabled` : ""} style="width:24px;height:24px;accent-color:var(--c-accent)"></td>` : ""}<td><a class="link" href="#" data-act="go" data-to="coin-detail" data-op="${c.outpoint}">${name(c)}</a><div class="cap">${sub(c)}</div><div class="m-only">${badge(c)}</div></td><td class="col-hide mono nw">${mid(c.txid, 8, 6)}:${c.vout}</td>${select ? "" : html`<td class="col-hide num">${c.pending ? "Not yet" : num(c.height)}</td>`}<td class="amt">${hidden() ? "\u2022\u2022\u2022\u2022" : fb(c.value, { unit: false })}</td><td class="col-hide">${badge(c)}</td>${select ? html`<td><input class="switch" type="checkbox" role="switch" data-act="coin-freeze" data-op="${c.outpoint}" aria-label="Freeze ${name(c)}" ${c.frozen ? html`checked` : ""} ${c.status === "reserved" ? html`disabled` : ""}></td>` : ""}</tr>`;
  })}
  </tbody></table></div>`;
}

function fullCoins(): Safe {
  const list = coins();
  const st = S.b!.state;
  const sel = Array.isArray(S.f.coinsSel) ? (S.f.coinsSel as string[]) : [];
  const selTotal = list.filter((c) => sel.includes(c.outpoint)).reduce((a, c) => a + BigInt(c.value), 0n);
  const frozen = list.some((c) => c.status === "frozen");
  return html`<div class="topbar"><h1>Coins</h1><span class="cap tb-note">Spendable ${fbShort(st.balance ?? "0")}${frozen ? ", frozen coins not counted" : ""}</span><button class="btn btn-primary" type="button" data-act="send-selected" ${sel.length ? "" : html`aria-disabled="true" disabled`}>${I("arrow-up-right", "s16")}Send selected</button></div>
  <p class="muted" style="max-width:72ch">Each coin remembers who knows about it. Spending two coins together tells both sides they belong to you. Freeze coins you never want spent, such as ones holding an inscription.</p>
  <section class="panel" aria-labelledby="c-h"><div class="row between"><h2 id="c-h">${list.length} ${list.length === 1 ? "coin" : "coins"}</h2><span class="cap">${sel.length} selected${sel.length ? `, ${fbShort(selTotal)}` : ""}</span></div>${list.length ? coinTable(true) : html`<p class="small muted">No coins yet. Each payment you receive becomes a coin here.</p>`}</section>
  <section class="panel" aria-labelledby="l-h"><h2 id="l-h">What the labels mean</h2><div class="kv">
    <div class="r"><span class="k"><span class="badge ok">Private</span></span><span class="v">Arrived at a Silent Payment output. Only the sender knows.</span></div>
    <div class="r"><span class="k"><span class="badge warn">Linked</span></span><span class="v">Came from a reused address. Anyone watching it knows.</span></div>
    <div class="r"><span class="k"><span class="badge">${I("lock-keyhole")}Reserved</span></span><span class="v">Set aside for an open payment link.</span></div>
    <div class="r"><span class="k"><span class="badge frozen">${I("snowflake")}Frozen</span></span><span class="v">Never spent by PrivateBit until you unfreeze it.</span></div></div></section>`;
}
import { go } from "../app.ts";
actions["send-selected"] = () => {
  S.f.coinMode = "choose";
  go("send");
};
void render;
