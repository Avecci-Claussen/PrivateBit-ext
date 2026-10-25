import { S, screens, actions, loaders, go, back, render, run, refresh, fv, busy, err, toast } from "../app.ts";
import { call, type ChainConfig, type Prefs } from "../api.ts";
import { html, I, NETLOGO, num, hm, type Safe, UNIT, CHAIN_SHORT, CHAIN } from "../kit.ts";
import { hdr, tabs, mailboxHost } from "../chrome.ts";
import { DEFAULT_BIRTHDAY, DEFAULT_PAYJOIN_DIRECTORY, DEFAULT_OHTTP_RELAY, FRACTAL } from "../../lib/network.ts";
const DEFAULT_UNISAT_BASE = FRACTAL.defaultUnisat;
import { LOCK_CHOICES } from "../../lib/prefs.ts";
import { THEME_CHOICES, type ThemeChoice } from "../../lib/theme.ts";
import { applyTheme, currentTheme } from "../theme.ts";
import { PRICE_HOST } from "../../lib/requests.ts";
import { price, syncLine } from "../derive.ts";

const chain = (): ChainConfig => S.b!.state.chain;
const prefs = (): Prefs => S.b!.prefs;
const errP = (k: string): Safe | string => (err(k) ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err(k)}</span></p>` : "");
const host = (u: string | undefined, d: string): string => {
  try {
    return new URL(u || d).host;
  } catch {
    return u || d;
  }
};

function row(ic: string, t: string, d: string, to: string): Safe {
  return html`<a class="li" href="#" data-act="go" data-to="${to}"><span class="ico">${I(ic)}</span><span class="body"><span class="t">${t}</span><span class="d">${d}</span></span>${I("chevron-right", "s16 chev")}</a>`;
}
function toggle(t: string, d: string, on: boolean, id: string, pref: keyof Prefs, extra?: Safe): Safe {
  return html`<div class="li" style="cursor:default;align-items:flex-start"><span class="body"><label class="t" for="${id}" style="white-space:normal">${t}</label><span class="d" style="white-space:normal">${d}</span>${extra ?? ""}</span><input class="switch" type="checkbox" role="switch" id="${id}" data-act="pref-toggle" data-pref="${pref}" ${on ? html`checked` : ""}></div>`;
}
actions["pref-toggle"] = async (el, ev) => {
  ev.preventDefault();
  const k = el.dataset.pref as keyof Prefs;
  const next = !prefs()[k];
  await run("pref", async () => {
    await call({ type: "PREFS_SET", prefs: { [k]: next } });
    await refresh();
  });
  if (k === "hideBalance") S.f.hideBal = next;
};
async function setLock(m: number): Promise<void> {
  await call({ type: "PREFS_SET", prefs: { lockMinutes: m } });
  await refresh();
  render();
}
actions["lock-min"] = (el) => setLock(Number(el.dataset.v));

function themeSummary(): string {
  const id = currentTheme();
  return THEME_CHOICES.find((c) => c.id === id)?.label ?? "Dark (default)";
}
function themeSeg(labelledBy: string): Safe {
  const cur = currentTheme();
  return html`<div class="seg wrap" role="radiogroup" aria-labelledby="${labelledBy}">${THEME_CHOICES.map((c) => html`<button type="button" role="radio" data-act="theme-set" data-v="${c.id}" aria-checked="${String(cur === c.id)}">${c.label}</button>`)}</div>`;
}
screens["set-appearance"] = () => ({
  title: "Appearance",
  header: hdr({ title: "Appearance" }),
  main: html`<div class="field"><p class="label" id="ap">Theme</p>${themeSeg("ap")}
    <p class="help">Dark is the default, including the first time you open PrivateBit. Your choice stays on this computer across lock and closing the window.</p></div>`,
});
actions["theme-set"] = (el) => {
  applyTheme(el.dataset.v as ThemeChoice);
  render();
};

const VERSION = chrome.runtime.getManifest?.().version ?? "1.0.0";

/* ---------- list (54) ---------- */
screens.settings = () => {
  const c = chain();
  const pr = prefs();
  return {
    title: "Settings",
    header: hdr(),
    nav: tabs("settings"),
    main: html`
  <h1 style="font:var(--t-title)">Settings</h1>
  <div class="list">
  ${row("wallet", "Wallets", (() => { const n = (S.b!.state.wallets ?? []).length || 1; return `${n} ${n === 1 ? "wallet" : "wallets"}, ${(S.b!.state.wallets ?? []).find((w) => w.active)?.name ?? "Wallet"} open`; })(), "wallets")}
  ${row("blocks", "Network and data source", c.kind === "core" ? `${CHAIN_SHORT()}, your own node` : `${CHAIN_SHORT()}, public block data service`, "set-network")}
  ${row("sun", "Appearance", themeSummary(), "set-appearance")}
  ${row("eye-off", "Privacy", pr.usd ? "USD price, hide balance, explorer" : "USD price off, hide balance, explorer", "set-privacy")}
  ${row("route", "Payment links", `${mailboxHost()} through a relay`, "set-payjoin")}
  ${row("lock", "Security and lock", `Password, lock after ${pr.lockMinutes} min`, "set-security")}
  ${row("file-key", "Backup", "Recovery words", "set-backup")}
  ${row("scan-line", "Finding coins", `Look back from block ${num(S.b!.state.birthday ?? DEFAULT_BIRTHDAY)}`, "set-scan")}
  ${row("arrow-right-left", "Move coins from another wallet", "One payment, then move it into your receive code", "migrate")}
</div>
  ${S.mode === "popup" ? html`<button class="btn btn-secondary btn-block" type="button" data-act="open-full">${I("external-link", "s16")}Open full page</button>` : ""}
  <p class="cap" style="text-align:center">PrivateBit ${VERSION}. GreyBound, The Lonely Bits LLC</p>`,
    page: fullSettings(),
  };
};
actions["open-full"] = () => {
  void chrome.runtime.openOptionsPage();
};

/* ---------- network and data source (55) ---------- */
loaders["set-network"] = () => {
  const c = chain();
  S.f.src = c.kind === "core" ? "core" : "service";
  S.f.tok = c.unisatToken ?? "";
};
function networkForm(): Safe {
  const own = fv("src", chain().kind === "core" ? "core" : "service") === "core";
  return html`<div class="card flat pad-sm"><div class="row">${NETLOGO("current", "lg")}<span class="body grow"><span class="strong" style="display:block">${CHAIN()}</span><span class="small muted">Mainnet. Switch chains with the chip at the top.</span></span></div></div>
  <fieldset class="field" style="border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:6px">Where block data comes from</legend><div class="opt-list" role="radiogroup">
    <button class="opt" role="radio" aria-checked="${String(!own)}" type="button" data-act="set" data-k="src" data-v="service"><span class="body"><span class="t">Public block data service</span><span class="d">Easiest. The service sees your IP, the blocks and fee rates you ask for, and the payments you broadcast. It is not given your receive code.</span></span>${!own ? I("check") : ""}</button>
    <button class="opt" role="radio" aria-checked="${String(own)}" type="button" data-act="set" data-k="src" data-v="core"><span class="body"><span class="t">My own ${CHAIN_SHORT()} node</span><span class="d">Most private. Needs a node URL and RPC login.</span></span>${own ? I("check") : ""}</button></div></fieldset>
  ${own
    ? html`<button class="rowlink" type="button" data-act="go" data-to="set-node"><span class="body"><span class="t">Node settings</span><span class="d">${chain().kind === "core" ? chain().url : "Not set up yet"}</span></span><span class="v">${I("chevron-right", "s16")}</span></button>`
    : html`<div class="field" data-enter="net-save"><label class="label" for="tok">Data service API key <span class="optl">(optional)</span></label><input class="input" id="tok" data-f="tok" type="password" autocomplete="off" value="${fv("tok")}" aria-describedby="tok-h"><p class="help" id="tok-h">Stored encrypted on this computer only. Without a key the service often limits requests. Leave empty to use it without one.</p></div>`}
  ${errP("net")}`;
}
screens["set-network"] = () => ({
  title: "Network and data source",
  header: hdr({ title: "Network and data source" }),
  main: networkForm(),
  foot: html`<button class="btn btn-primary btn-block" type="button" data-act="net-save" ${busy("net") ? html`aria-disabled="true"` : ""}>Save</button>`,
});
actions["net-save"] = async () => {
  if (fv("src") === "core" && chain().kind !== "core") {
    go("set-node");
    return;
  }
  const c = chain();
  const next: ChainConfig =
    fv("src") === "core"
      ? c
      : { ...c, kind: "unisat", url: c.kind === "core" ? DEFAULT_UNISAT_BASE : c.url, unisatToken: fv("tok").trim() };
  const ok = await run(
    "net",
    async () => {
      await call({ type: "SAVE_CHAIN", chain: next });
      await refresh();
      return true;
    },
    "net",
  );
  if (ok) toast("Saved.");
};

/* ---------- own node (56) ---------- */
loaders["set-node"] = () => {
  const c = chain();
  S.f.nu = c.kind === "core" ? c.url : "http://127.0.0.1:8332";
  S.f.nru = c.rpcUser ?? "";
  S.f.nrp = c.rpcPassword ?? "";
  S.d.nodeTest = undefined;
};
async function hostPermission(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return true;
    return await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch {
    return false;
  }
}
function nodeCfg(): ChainConfig {
  return { ...chain(), kind: "core", url: fv("nu").trim(), rpcUser: fv("nru").trim(), rpcPassword: fv("nrp") };
}
screens["set-node"] = () => {
  const t = S.d.nodeTest as { ok: boolean; height?: number; msg?: string } | undefined;
  let lh = "";
  try {
    lh = new URL(fv("nu")).hostname;
  } catch {
    /* typing */
  }
  return {
    title: `My own ${CHAIN_SHORT()} node`,
    header: hdr({ title: `My own ${CHAIN_SHORT()} node` }),
    main: html`
  <div class="field"><label class="label" for="u">Node RPC URL</label><input class="input mono" id="u" data-f="nu" data-live autocomplete="off" placeholder="http://127.0.0.1:8332" value="${fv("nu")}"></div>
  <div class="field"><label class="label" for="ru">RPC user</label><input class="input" id="ru" data-f="nru" autocomplete="off" value="${fv("nru")}"></div>
  <div class="field"><label class="label" for="rp">RPC password</label><input class="input" id="rp" data-f="nrp" type="password" autocomplete="off" value="${fv("nrp")}" aria-describedby="rp-h"><p class="help" id="rp-h">Stored encrypted on this computer only.</p></div>
  ${t?.ok ? html`<div class="banner ok" role="status">${I("circle-check", "s16")}<div><span class="bt">Connected</span>Block ${num(t.height ?? 0)}.${lh && lh !== "127.0.0.1" && lh !== "localhost" ? ` Chrome asks once to allow access to ${lh}.` : ""}</div></div>` : t ? html`<div class="banner danger" role="alert">${I("circle-x", "s16")}<div><span class="bt">Could not connect</span>${t.msg}</div></div>` : ""}
  ${errP("node")}`,
    foot: { cls: "row", html: html`<button class="btn btn-secondary" type="button" data-act="node-test" ${busy("node") ? html`aria-disabled="true"` : ""}>${busy("node") ? "Testing…" : "Test"}</button><button class="btn btn-primary" type="button" data-act="node-save">Save</button>` },
  };
};
actions["node-test"] = async () => {
  const cfg = nodeCfg();
  if (!(await hostPermission(cfg.url))) {
    S.d.nodeTest = { ok: false, msg: "Chrome did not allow access to that address." };
    render();
    return;
  }
  S.busy = "node";
  render();
  try {
    const tip = await call<{ height: number }>({ type: "TEST_CHAIN", chain: cfg });
    S.d.nodeTest = { ok: true, height: tip.height };
  } catch (e) {
    S.d.nodeTest = { ok: false, msg: String((e as Error).message) };
  }
  S.busy = null;
  render();
};
actions["node-save"] = async () => {
  const cfg = nodeCfg();
  if (!/^https?:\/\//.test(cfg.url)) {
    S.err.node = "Enter a URL that starts with http:// or https://.";
    render();
    return;
  }
  if (!(await hostPermission(cfg.url))) {
    S.err.node = "Chrome did not allow access to that address.";
    render();
    return;
  }
  const ok = await run(
    "node",
    async () => {
      await call({ type: "SAVE_CHAIN", chain: cfg });
      await refresh();
      return true;
    },
    "node",
  );
  if (ok) {
    toast("Saved. PrivateBit now uses your node.");
    back("settings");
  }
};

/* ---------- privacy (57) and price (57b) ---------- */
function privacyList(): Safe {
  const pr = prefs();
  return html`<div class="list">
  ${toggle("Hide balance when PrivateBit opens", "Amounts show as dots until you use the eye button.", pr.hideBalance, "t1", "hideBalance")}
  ${toggle("Show value in USD", "From a price service every 10 minutes. It sees your IP and that someone asked for the FB price, never your coins or codes.", pr.usd, "t3", "usd", S.mode === "popup" ? html`<button class="link small" type="button" data-act="go" data-to="set-price" style="align-self:flex-start">Price source details</button>` : undefined)}
  ${toggle("Ask before opening an explorer", "Explorers see your IP and which transaction you looked up.", pr.askExplorer, "t4", "askExplorer")}</div>`;
}
screens["set-privacy"] = () => ({ title: "Privacy", header: hdr({ title: "Privacy" }), main: privacyList() });

screens["set-price"] = () => {
  const p = price();
  const pc = S.b!.price;
  return {
    title: "USD price",
    header: hdr({ title: "USD price" }),
    main: html`
  <div class="card"><div class="kv">
    <div class="r"><span class="k">Source</span><span class="v"><span class="mono">${PRICE_HOST}</span></span></div>
    <div class="r"><span class="k">Asks for</span><span class="v">${UNIT()} price in USD, nothing else</span></div>
    <div class="r"><span class="k">How often</span><span class="v">Every 10 minutes while unlocked</span></div>
    <div class="r"><span class="k">Route</span><span class="v">Direct</span></div>
    <div class="r"><span class="k">Last price</span><span class="v">${pc?.usd && pc.fetchedAt ? html`<span class="mono">$${pc.usd.toFixed(4)}</span><span class="cap">${p.kind === "stale" ? "Not updated since " : "Today, "}${hm(pc.fetchedAt)}</span>` : html`<span class="muted">${prefs().usd ? "None yet" : "Off"}</span>`}</span></div></div></div>
  <div class="list">
    <div class="li" style="cursor:default"><span class="ico warn">${I("globe")}</span><span class="body"><span class="t">The price service learns</span><span class="d" style="white-space:normal">Your IP address and the time you asked.</span></span></div>
    <div class="li" style="cursor:default"><span class="ico in">${I("shield-check")}</span><span class="body"><span class="t">The price service never learns</span><span class="d" style="white-space:normal">Your addresses, codes, coins or balance. The price is applied on this computer.</span></span></div></div>
  <p class="small muted">If the price is older than 30 minutes it shows in amber with its time. If there is no price, PrivateBit shows FB only.</p>
  <div class="li" style="padding:0;min-height:auto;cursor:default"><span class="body"><label class="t" for="usd">Show value in USD</label><span class="d">On by default. Off means no request is ever made.</span></span><input class="switch" type="checkbox" role="switch" id="usd" data-act="pref-toggle" data-pref="usd" ${prefs().usd ? html`checked` : ""}></div>`,
  };
};

/* ---------- payment links (58) ---------- */
loaders["set-payjoin"] = () => {
  S.f.mb = chain().payjoinDirectory ?? DEFAULT_PAYJOIN_DIRECTORY;
  S.f.rl = chain().ohttpRelay ?? DEFAULT_OHTTP_RELAY;
};
function payjoinForm(): Safe {
  const same = host(fv("mb"), "") === host(fv("rl"), "") && fv("mb") !== "";
  return html`<p class="small muted">Payment links pass encrypted messages through a mailbox. A relay sits in between so the mailbox never sees your IP, and the relay never sees the message.</p>
  <div class="field"><label class="label" for="mb">Mailbox</label><input class="input mono" id="mb" data-f="mb" data-live autocomplete="off" value="${fv("mb")}" aria-describedby="mb-h"><p class="help" id="mb-h">Sees: an encrypted 7 KB blob and when it was posted.</p></div>
  <div class="field"><label class="label" for="rl">Relay</label><input class="input mono" id="rl" data-f="rl" data-live autocomplete="off" value="${fv("rl")}" aria-describedby="rl-h"><p class="help" id="rl-h">Sees: your IP, not the content.</p></div>
  <div class="banner ${same ? "warn" : ""}">${I(same ? "triangle-alert" : "info", "s16")}<div>Running both mailbox and relay yourself defeats the purpose of the relay. Use different operators.</div></div>
  ${errP("pj")}`;
}
screens["set-payjoin"] = () => ({
  title: "Payment links",
  header: hdr({ title: "Payment links" }),
  main: payjoinForm(),
  foot: html`<button class="btn btn-primary btn-block" type="button" data-act="pj-save">Save</button>`,
});
actions["pj-save"] = async () => {
  const mb = fv("mb").trim();
  const rl = fv("rl").trim();
  if (!/^https:\/\//.test(mb) || !/^https:\/\//.test(rl)) {
    S.err.pj = "Both addresses must start with https://.";
    render();
    return;
  }
  if (!(await hostPermission(mb)) || !(await hostPermission(rl))) {
    S.err.pj = "Chrome did not allow access to those addresses.";
    render();
    return;
  }
  const ok = await run(
    "pj",
    async () => {
      await call({ type: "SAVE_CHAIN", chain: { ...chain(), payjoinDirectory: mb, ohttpRelay: rl } });
      await refresh();
      return true;
    },
    "pj",
  );
  if (ok) toast("Saved.");
};

/* ---------- security (59, 59b) ---------- */
function lockSeg(id: string): Safe {
  const cur = prefs().lockMinutes;
  return html`<div class="seg" role="radiogroup" aria-labelledby="${id}">${LOCK_CHOICES.map((m) => html`<button type="button" role="radio" data-act="lock-min" data-v="${m}" aria-checked="${String(cur === m)}">${m} min</button>`)}</div>`;
}
screens["set-security"] = () => {
  const b = S.b!;
  const waiting = b.waiting && b.state.payjoin;
  const last = b.activity?.last;
  const pj = b.state.payjoin;
  return {
    title: "Security and lock",
    header: hdr({ title: "Security and lock" }),
    main: waiting
      ? html`
  <div class="banner warn" role="status">${I("hourglass", "s16")}<div><span class="bt">Auto lock is waiting</span>${pj?.role === "send" ? "A Payjoin payment" : "A payment link"}${pj?.amount && pj.amount !== "0" ? ` of ${Number(pj.amount) / 1e8} FB` : ""} is in progress. Locking now would delete its keys. PrivateBit locks ${prefs().lockMinutes} minutes after it ends.</div></div>
  <div class="field"><p class="label" id="al2">Lock after no use for</p>${lockSeg("al2")}</div>
  <div class="card flat pad-sm"><div class="kv">
    ${last ? html`<div class="r"><span class="k">Last used</span><span class="v">${hm(last)}</span></div><div class="r"><span class="k">Would have locked</span><span class="v">${hm(last + prefs().lockMinutes * 60_000)}</span></div>` : ""}
    <div class="r"><span class="k">Now locks</span><span class="v">${prefs().lockMinutes} min after the payment ends</span></div></div></div>`
      : html`
  <div class="field"><p class="label" id="al">Lock after no use for</p>${lockSeg("al")}
    <p class="help">Counts from your last click or key press in PrivateBit. Waits while a payment link or Payjoin payment is in progress, then locks when it ends. Finding coins continues while locked, until you quit the browser or switch wallets.</p></div>
  <div class="list">${row("key-round", "Change password", "Re-encrypts your keys here", "set-password")}</div>
  <div class="card" style="border-color:var(--c-danger)"><div class="stack"><p class="strong">Remove wallet from this computer</p><p class="small muted">Deletes the encrypted vault, activity, coin labels and settings from this computer. Only your recovery words can bring the coins back.</p></div><button class="btn btn-danger-outline btn-block" type="button" data-act="go" data-to="remove">Remove wallet</button></div>`,
  };
};

/* ---------- change password ---------- */
screens["set-password"] = () => ({
  title: "Change password",
  header: hdr({ title: "Change password" }),
  main: html`<div class="stack" data-enter="pw-change">
  <div class="field"><label class="label" for="cpw">Current password</label><input class="input" id="cpw" data-f="cpw" type="password" autocomplete="current-password" value="${fv("cpw")}"></div>
  <div class="field"><label class="label" for="npw">New password</label><input class="input" id="npw" data-f="npw" type="password" autocomplete="new-password" value="${fv("npw")}" aria-describedby="npw-h"><p class="help" id="npw-h">At least 8 characters. Longer is stronger than complex.</p></div>
  <div class="field"><label class="label" for="npw2">Repeat new password</label><input class="input" id="npw2" data-f="npw2" type="password" autocomplete="new-password" value="${fv("npw2")}"></div></div>
  ${errP("cpw")}`,
  foot: html`<button class="btn btn-primary btn-block" type="button" data-act="pw-change" ${busy("cpw") ? html`aria-disabled="true"` : ""}>${busy("cpw") ? html`${I("loader-circle", "s16 spin")}Re-encrypting…` : "Change password"}</button>`,
});
actions["pw-change"] = async () => {
  if ([...fv("npw")].length < 8) S.err.cpw = "Use at least 8 characters.";
  else if (fv("npw") !== fv("npw2")) S.err.cpw = "The new passwords do not match.";
  if (S.err.cpw) return render();
  const ok = await run(
    "cpw",
    async () => {
      await call({ type: "CHANGE_PASSWORD", current: fv("cpw"), next: fv("npw") });
      return true;
    },
    "cpw",
  );
  if (S.err.cpw && /wrong password/i.test(S.err.cpw)) S.err.cpw = "The current password is wrong.";
  if (ok) {
    for (const k of ["cpw", "npw", "npw2"]) delete S.f[k];
    toast("Password changed.");
    back("set-security");
  }
};

/* ---------- backup (60) ---------- */
loaders["set-backup"] = () => {
  S.d.backupWords = undefined;
  S.f.bpw = "";
};
screens["set-backup"] = () => {
  const st = S.b!.state;
  const w = S.d.backupWords as string[] | undefined;
  const kv = html`<div class="card flat pad-sm"><div class="kv"><div class="r"><span class="k">Words</span><span class="v">${st.mnemonicWords ?? "Unknown"}</span></div><div class="r"><span class="k">Extra passphrase</span><span class="v">${st.hasPassphrase ? "Set" : "Not set"}</span></div><div class="r"><span class="k">Keys path</span><span class="v mono">m/352'/8228'/0'</span></div><div class="r"><span class="k">One-time addresses</span><span class="v mono">m/86'/8228'/0'/0/i</span></div></div></div>`;
  if (w) {
    return {
      title: "Backup",
      header: hdr({ title: "Backup" }),
      main: html`<div class="stack"><h2 style="font:var(--t-title)">Your recovery words</h2><p class="muted">${w.length} words, in order. Anyone with these words can take your coins.</p></div>
  <ol class="seed" aria-label="Recovery words" ${w.length > 12 ? html`style="grid-template-rows:repeat(12,auto)"` : ""}>${w.map((x, i) => html`<li><span class="ix">${i + 1}</span><span>${x}</span></li>`)}</ol>
  ${st.hasPassphrase ? html`<p class="small muted">Your extra passphrase is not shown. You need it too.</p>` : ""}${kv}`,
      foot: html`<button class="btn btn-primary btn-block" type="button" data-act="backup-hide">${I("eye-off", "s16")}Hide words</button>`,
    };
  }
  return {
    title: "Backup",
    header: hdr({ title: "Backup" }),
    main: html`
  <div class="stack"><h2 style="font:var(--t-title)">Show recovery words</h2><p class="muted">Enter your password. Make sure nobody can see your screen.</p></div>
  <div class="field" data-enter="backup-show"><label class="label" for="bpw">Password</label><input class="input" id="bpw" data-f="bpw" type="password" autocomplete="current-password" value="${fv("bpw")}" ${err("bpw") ? html`aria-invalid="true" aria-describedby="bpw-e"` : ""}>${err("bpw") ? html`<p class="err" id="bpw-e" role="alert">${I("circle-alert", "s16")}<span>${err("bpw")}</span></p>` : ""}</div>
  ${kv}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="backup-show">Show words</button>`,
  };
};
actions["backup-show"] = async () => {
  const r = await run("bpw", () => call<{ mnemonic: string }>({ type: "SHOW_WORDS", password: fv("bpw") }), "bpw");
  if (S.err.bpw && /wrong password/i.test(S.err.bpw)) S.err.bpw = "Wrong password.";
  if (!r) return render();
  S.f.bpw = "";
  S.d.backupWords = r.mnemonic.split(" ");
  render();
};
actions["backup-hide"] = () => {
  S.d.backupWords = undefined;
  render();
};

/* ---------- finding coins (61) ---------- */
loaders["set-scan"] = () => {
  S.f.bk = num(S.b!.state.birthday ?? DEFAULT_BIRTHDAY);
};
screens["set-scan"] = () => {
  const st = S.b!.state;
  const done = st.watching;
  return {
    title: "Finding coins",
    header: hdr({ title: "Finding coins" }),
    main: html`
  <div class="card flat pad-sm"><div class="kv"><div class="r"><span class="k">Looking from block</span><span class="v mono">${num(st.birthday ?? DEFAULT_BIRTHDAY)}</span></div><div class="r"><span class="k">Checked up to</span><span class="v mono">${num(st.lastHeight ?? 0)}</span></div><div class="r"><span class="k">Status</span><span class="v">${done ? html`<span class="badge ok">${I("circle-check")}Up to date</span>` : !st.tip ? html`<span class="badge">${I("clock")}${syncLine()}</span>` : html`<span class="badge">${I("refresh-cw")}Finding coins, ${num(st.tip - (st.lastHeight ?? 0))} blocks to go</span>`}</span></div></div></div>
  <div class="field" data-enter="rescan"><label class="label" for="bk">Look again from block</label><input class="input mono" id="bk" data-f="bk" inputmode="numeric" autocomplete="off" value="${fv("bk")}" aria-describedby="bk-h" ${err("bk") ? html`aria-invalid="true"` : ""}><p class="help" id="bk-h">Use this if a payment is missing. Earlier blocks take longer. The default start is block ${num(DEFAULT_BIRTHDAY)}.</p>${errP("bk")}</div>
  <button class="btn btn-ghost btn-sm" type="button" data-act="bk-default" style="align-self:flex-start">Use block ${num(DEFAULT_BIRTHDAY)}</button>`,
    foot: html`<button class="btn btn-secondary btn-block" type="button" data-act="rescan" ${busy("bk") ? html`aria-disabled="true"` : ""}>${I("refresh-cw", "s16")}Look again from this block</button>`,
  };
};
actions["bk-default"] = () => {
  S.f.bk = num(DEFAULT_BIRTHDAY);
  render();
};
actions.rescan = async () => {
  const n = Number(fv("bk").replace(/[,\s]/g, ""));
  if (!Number.isInteger(n) || n < 1) {
    S.err.bk = "Enter a block number.";
    return render();
  }
  const ok = await run(
    "bk",
    async () => {
      S.b = await call({ type: "SET_BIRTHDAY", birthday: n });
      return true;
    },
    "bk",
  );
  if (ok) toast(`Looking again from block ${num(n)}.`);
};

/* ---------- remove wallet (two steps) ---------- */
loaders.remove = () => {
  S.f.rmStep = "1";
  S.f.rmpw = "";
  S.f.rmAck = false;
};
/** The wallet being removed: the one picked on the Wallets screen, else the open one. */
function rmTarget() {
  const list = S.b!.state.wallets ?? [];
  const id = typeof S.params.id === "string" ? S.params.id : undefined;
  return list.find((w) => w.id === id) ?? list.find((w) => w.active);
}
screens.remove = () => {
  const two = fv("rmStep") === "2";
  const list = S.b!.state.wallets ?? [];
  const many = list.length > 1;
  const t = rmTarget();
  const isOpen = !t || t.active;
  const name = t?.name ?? "this wallet";
  if (!two) {
    return {
      title: "Remove wallet",
      header: hdr({ title: "Remove wallet" }),
      main: html`
  <div class="state" style="padding-top:var(--s-2)"><div class="big danger">${I("trash-2")}</div><h1>${many ? `Remove ${name}?` : "Remove PrivateBit from this computer?"}</h1><p>${many ? `This deletes ${name} from this computer: its vault, activity, coin labels and payment links. The other wallets stay. Coins stay on the chain.` : "This deletes the encrypted vault, activity history, coin labels, payment links and settings stored here. Your coins stay on the chain."}</p></div>
  <div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">Only the recovery words of ${name} can bring its coins back</span>Check you have them on paper before you continue. Labels you typed cannot be recovered.</div></div>
  ${isOpen && S.b!.state.payjoin ? html`<div class="banner danger">${I("hourglass", "s16")}<div>A payment link or Payjoin payment is still waiting. Removing the wallet ends it.</div></div>` : ""}
  <div class="field" data-enter="rm-next"><label class="label" for="rmpw">${isOpen ? "Password" : `Password of ${name}`}</label><input class="input" id="rmpw" data-f="rmpw" type="password" autocomplete="current-password" value="${fv("rmpw")}" ${err("rm") ? html`aria-invalid="true" aria-describedby="rm-e"` : ""}>${err("rm") ? html`<p class="err" id="rm-e" role="alert">${I("circle-alert", "s16")}<span>${err("rm")}</span></p>` : ""}</div>`,
      foot: html`<button class="btn btn-danger-outline btn-block" type="button" data-act="rm-next">Continue</button><button class="btn btn-ghost btn-block" type="button" data-act="back">Keep my wallet</button>`,
    };
  }
  const ack = S.f.rmAck === true;
  return {
    title: "Remove wallet",
    header: hdr({ title: "Remove wallet" }),
    main: html`
  <div class="state" style="padding-top:var(--s-2)"><div class="big danger">${I("triangle-alert")}</div><h1>Last check</h1><p>${!many ? "After this, PrivateBit on this computer starts empty. There is no undo." : isOpen ? `After this, ${name} is gone from this computer. The others stay, locked, until you unlock one.` : `After this, ${name} is gone from this computer. ${list.find((w) => w.active)?.name ?? "The open wallet"} stays open.`}</p></div>
  <div class="card pad-sm"><label class="check"><input type="checkbox" data-f="rmAck" ${ack ? html`checked` : ""}> <span>I have the ${t?.words ? `${t.words} recovery words` : "recovery words"}${t?.hasPassphrase ? " and the extra passphrase" : ""} of ${name} written down</span></label></div>
  ${errP("rm")}`,
    foot: html`<button class="btn btn-danger btn-block" type="button" data-act="rm-final" ${ack && !busy("rm") ? "" : html`aria-disabled="true" disabled`}>${busy("rm") ? html`${I("loader-circle", "s16 spin")}Removing…` : "Remove wallet from this computer"}</button><button class="btn btn-ghost btn-block" type="button" data-act="back">Keep my wallet</button>`,
  };
};
actions["rm-next"] = async () => {
  const pw = fv("rmpw");
  if (!pw) {
    S.err.rm = "Enter your password.";
    return render();
  }
  const ok = await run(
    "rm",
    async () => {
      const t = rmTarget();
      if (t && !t.active) await call({ type: "CHECK_WALLET_PASSWORD", id: t.id, password: pw });
      else await call({ type: "SHOW_WORDS", password: pw });
      return true;
    },
    "rm",
  );
  if (S.err.rm && /wrong password/i.test(S.err.rm)) S.err.rm = "Wrong password.";
  if (!ok) return render();
  S.f.rmStep = "2";
  render();
};
actions["rm-final"] = async () => {
  const t = rmTarget();
  const r = await run("rm", () => call<{ left: number; removedOpen?: boolean }>({ type: "REMOVE_WALLET", password: fv("rmpw"), id: t?.id }), "rm");
  if (!r) return;
  if (r.removedOpen === false) {
    S.f = {};
    await refresh();
    toast(`${t?.name ?? "Wallet"} removed from this computer.`);
    go("wallets", {}, { reset: true });
    return;
  }
  S.f = {};
  S.d = {};
  await refresh();
  go(S.b?.state.hasVault ? "unlock" : "welcome", {}, { reset: true });
};

/* ---------- full page settings (F2) ---------- */
function fullSettings(): Safe {
  if (S.f.src === undefined) {
    S.f.src = chain().kind === "core" ? "core" : "service";
    S.f.tok = chain().unisatToken ?? "";
    S.f.mb = chain().payjoinDirectory ?? DEFAULT_PAYJOIN_DIRECTORY;
    S.f.rl = chain().ohttpRelay ?? DEFAULT_OHTTP_RELAY;
  }
  const pr = prefs();
  return html`<div class="topbar"><h1>Settings</h1><span class="cap">Changes save when you select Save in each section</span></div>
  <div class="settings-grid"><nav class="subnav" data-clip aria-label="Settings sections"><a href="#wallets">Wallets</a><a href="#net">Network and data</a><a href="#ap">Appearance</a><a href="#priv">Privacy</a><a href="#pj">Payment links</a><a href="#sec">Security</a><a href="#bk">Backup and coins</a></nav>
  <div class="stack" style="gap:var(--s-8)">
    <section class="sect" id="wallets"><header><h2>Wallets</h2><p>Open now: <strong>${(S.b!.state.wallets ?? []).find((w) => w.active)?.name ?? "Wallet"}</strong>. Several wallets can sit on this computer, one open at a time, each with its own password. Rename, add, import or remove them in one place.</p></header>
      <div class="row" style="flex-wrap:wrap"><button class="btn btn-secondary" type="button" data-act="go" data-to="wallets">${I("wallet", "s16")}Manage wallets</button></div></section>
    <section class="sect" id="net"><header><h2>Network and data source</h2><p>Blocks are downloaded from the source below. PrivateBit matches them to your keys on this computer.</p></header>
      ${networkForm()}
      <div class="row"><button class="btn btn-primary" type="button" data-act="net-save">Save</button></div></section>
    <section class="sect" id="ap"><header><h2>Appearance</h2><p>Dark is the default. Your choice stays on this computer.</p></header>
      <div class="field" style="max-width:420px"><p class="label" id="apf">Theme</p>${themeSeg("apf")}</div>
</section>
    <section class="sect" id="priv"><header><h2>Privacy</h2><p>Each switch says who would learn something.</p></header>${privacyList()}
      ${pr.usd ? html`<p class="small muted">USD price from <span class="mono">${PRICE_HOST}</span>, asked directly every 10 minutes while unlocked. If the price is older than 30 minutes it shows in amber with its time.</p>` : ""}</section>
    <section class="sect" id="pj"><header><h2>Payment links</h2><p>Two servers carry payment link messages. Each one sees only what is listed under it.</p></header>
      ${payjoinForm()}
      <div class="row"><button class="btn btn-primary" type="button" data-act="pj-save">Save</button></div></section>
    <section class="sect" id="sec"><header><h2>Security</h2><p>Lock deletes payment link keys. Auto lock waits while a payment is in progress.</p></header>
      <div class="field"><span class="label" id="alf">Lock after no use for</span><div style="max-width:420px">${lockSeg("alf")}</div><p class="help">Waits while a payment link or Payjoin payment is in progress.</p></div>
      <div class="row" style="flex-wrap:wrap"><button class="btn btn-secondary" type="button" data-act="go" data-to="set-password">Change password</button><button class="btn btn-danger-outline" type="button" data-act="go" data-to="remove">Remove ${(S.b!.state.wallets ?? []).find((w) => w.active)?.name ?? "wallet"}</button></div></section>
    <section class="sect" id="bk"><header><h2>Backup and finding coins</h2><p>Your recovery words restore everything except the labels you typed.</p></header>
      <div class="row" style="flex-wrap:wrap"><button class="btn btn-secondary" type="button" data-act="go" data-to="set-backup">${I("file-key", "s16")}Show recovery words</button><button class="btn btn-secondary" type="button" data-act="go" data-to="set-scan">${I("scan-line", "s16")}Look again from a block</button><button class="btn btn-secondary" type="button" data-act="go" data-to="migrate">${I("arrow-right-left", "s16")}Move coins from another wallet</button></div>
      <p class="cap">PrivateBit ${VERSION}. GreyBound, The Lonely Bits LLC</p></section>
  </div></div>`;
}
