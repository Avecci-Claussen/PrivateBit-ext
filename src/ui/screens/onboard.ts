import { S, screens, actions, loaders, go, back, render, run, refresh, fv, busy, err, toast } from "../app.ts";
import { call } from "../api.ts";
import { html, I, MARK, NETLOGO, codeHi, num, type Safe } from "../kit.ts";
import { hdr } from "../chrome.ts";
import { wordlist } from "@scure/bip39/wordlists/english";
import { validateMnemonic } from "@scure/bip39";
import { DEFAULT_BIRTHDAY } from "../../lib/network.ts";
import { copyText } from "../copy.ts";

const dots = (n: number, of = 4): Safe =>
  html`<p class="sr-only">Step ${n} of ${of}</p><div class="dots" aria-hidden="true">${Array.from({ length: of }, (_, i) => html`<i class="${i < n ? "on" : ""}"></i>`)}</div>`;

function pwField(id: string, label: string, auto: string, describe?: string, extra?: Safe): Safe {
  const peek = S.f[`peek_${id}`] === true;
  const e = err(id);
  return html`<div class="field"><label class="label" for="${id}">${label}</label><div class="input-wrap"><input class="input" id="${id}" data-f="${id}" data-live type="${peek ? "text" : "password"}" autocomplete="${auto}" value="${fv(id)}" ${describe || e ? html`aria-describedby="${e ? id + "-e" : describe}"` : ""} ${e ? html`aria-invalid="true"` : ""} ${busy("unlock") ? html`disabled` : ""}><button class="icon-btn" type="button" data-act="peek" data-for="${id}" aria-label="${peek ? "Hide password" : "Show password"}" aria-pressed="${String(peek)}">${I(peek ? "eye-off" : "eye")}</button></div>${extra ?? ""}${e ? html`<p class="err" id="${id}-e" role="alert">${I("circle-alert", "s16")}<span>${e}</span></p>` : ""}</div>`;
}

actions.peek = (el) => {
  const k = `peek_${el.dataset.for}`;
  S.f[k] = !(S.f[k] === true);
  render();
};

function strength(pw: string): { bars: number; text: string } {
  const n = [...pw].length;
  if (!n) return { bars: 0, text: "At least 8 characters. Longer is stronger than complex." };
  if (n < 8) return { bars: 1, text: `Too short. ${n} of at least 8 characters.` };
  if (n < 12) return { bars: 2, text: `OK. ${n} characters. Longer is stronger than complex.` };
  if (n < 16) return { bars: 3, text: `Good. ${n} characters. Longer is stronger than complex.` };
  return { bars: 4, text: `Strong. ${n} characters.` };
}

/* ---------- welcome ---------- */
screens.welcome = () => ({
  title: "Welcome",
  solo: true,
  mainCls: "ob",
  main: html`
  <div style="flex:1"></div>
  ${MARK(64)}
  <div class="stack-3">
    <h1 style="font:var(--t-display);letter-spacing:var(--track-tight)">PrivateBit</h1>
    <p style="font:var(--t-body);color:var(--c-fg2);max-width:290px">A Fractal Bitcoin wallet with one reusable receive code. Every payment lands at a new address only you can find.</p>
  </div>
  <ul class="stack" style="list-style:none;margin:0;padding:0">
    <li class="row small">${I("key-round", "s16")}<span>Keys stay on this computer, encrypted with your password.</span></li>
    <li class="row small">${I("route", "s16")}<span>Payment links hide which coins are yours (Payjoin).</span></li>
    <li class="row small">${I("scan-line", "s16")}<span>Your coins are found locally. No server learns which are yours.</span></li>
  </ul>`,
  foot: { cls: "plain", html: html`<button class="btn btn-primary btn-block" type="button" data-act="go" data-to="create-password">Create a new wallet</button><button class="btn btn-secondary btn-block" type="button" data-act="go" data-to="import">I already have recovery words</button>` },
});

/* ---------- set password (create and import) ---------- */
function passwordScreen(mode: "create" | "import") {
  const pw = fv("pw");
  const s = strength(pw);
  const create = mode === "create";
  return {
    title: create ? "Create wallet" : "Import wallet",
    solo: true,
    header: hdr({ title: create ? "Create wallet" : "Import wallet" }),
    main: html`
  ${create ? dots(1) : ""}
  <div class="stack" data-enter="${create ? "pw-continue" : "import-finish"}"><h2 style="font:var(--t-title)">Choose a password</h2><p class="muted">It unlocks PrivateBit on this computer. It cannot recover your coins; your recovery words do that.</p></div>
  <div class="stack" data-enter="${create ? "pw-continue" : "import-finish"}">
  ${pwFieldLive("pw", s)}
  ${pwField("pw2", "Repeat password", "new-password")}
  </div>
  ${create
    ? html`<details class="card flat pad-sm" ${S.f.adv ? html`open` : ""}><summary class="small strong" style="cursor:pointer" data-act="toggle" data-k="adv">Advanced: 24 words, extra passphrase</summary>
    <div class="stack" style="margin-top:8px"><label class="check"><input type="checkbox" data-f="w24" ${S.f.w24 ? html`checked` : ""}> <span>Use 24 recovery words instead of 12</span></label>
    <p class="small muted">Only use an extra passphrase if you know why you need one. Without it your coins cannot be recovered, and nobody can reset it.</p>
    <div class="field"><label class="label" for="pp">Extra passphrase <span class="optl">(optional)</span></label><input class="input" id="pp" data-f="pp" type="password" autocomplete="off" value="${fv("pp")}"></div></div></details>`
    : ""}
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}`,
    foot: create
      ? html`<button class="btn btn-primary btn-block" type="button" data-act="pw-continue" ${busy("pw") ? html`aria-disabled="true"` : ""}>${busy("pw") ? html`${I("loader-circle", "s16 spin")}Making your words…` : "Continue"}</button>`
      : html`<button class="btn btn-primary btn-block" type="button" data-act="import-finish" ${busy("restore") ? html`aria-disabled="true"` : ""}>${busy("restore") ? html`${I("loader-circle", "s16 spin")}Restoring…` : "Restore wallet"}</button>`,
  };
}
function pwFieldLive(id: string, s: { bars: number; text: string }): Safe {
  return pwField(id, "Password", "new-password", "pw-h", html`<div class="meter" aria-hidden="true">${[0, 1, 2, 3].map((i) => html`<i class="${i < s.bars ? "on" : ""}"></i>`)}</div><p class="help" id="pw-h" aria-live="polite">${s.text}</p>`);
}
screens["create-password"] = () => passwordScreen("create");
screens["import-password"] = () => passwordScreen("import");

actions.toggle = (el) => {
  const k = el.dataset.k!;
  S.f[k] = !S.f[k];
};

function checkPasswords(): boolean {
  S.err = {};
  const pw = fv("pw");
  if ([...pw].length < 8) S.err.pw = "Use at least 8 characters.";
  else if (pw !== fv("pw2")) S.err.pw2 = "The passwords do not match.";
  render();
  return !S.err.pw && !S.err.pw2;
}

actions["pw-continue"] = async () => {
  if (!checkPasswords()) return;
  const ob = await run("pw", () => call<{ mnemonic: string; words: number }>({ type: "NEW_MNEMONIC", words: S.f.w24 ? 24 : 12 }));
  if (!ob) return;
  S.d.verify = undefined;
  S.f.revealed = false;
  go("seed");
};

/* ---------- recovery words ---------- */
async function loadOnboard(): Promise<void> {
  const ob = await call<{ mnemonic: string } | null>({ type: "ONBOARD_GET" });
  if (!ob) {
    go("welcome", {}, { reset: true });
    return;
  }
  S.d.words = ob.mnemonic.split(" ");
}
loaders.seed = loadOnboard;
loaders.verify = loadOnboard;

const words = (): string[] => (S.d.words as string[] | undefined) ?? [];

function seedList(blur: boolean): Safe {
  const w = words();
  return html`<ol class="seed ${blur ? "blur" : ""}" aria-label="Recovery words" ${w.length > 12 ? html`style="grid-template-rows:repeat(12,auto)"` : ""}>${w.map((x, i) => html`<li><span class="ix">${i + 1}</span><span>${blur ? "\u2022\u2022\u2022\u2022\u2022" : x}</span></li>`)}</ol>`;
}

screens.seed = () => {
  const shown = S.f.revealed === true;
  const n = words().length || 12;
  return {
    title: "Recovery words",
    solo: true,
    header: hdr({ title: "Create wallet" }),
    main: html`
  ${dots(2)}
  <div class="stack"><h2 style="font:var(--t-title)">Write down your recovery words</h2><p class="muted">${n} words, in order, on paper. Anyone with these words can take your coins.</p></div>
  ${shown
    ? html`${seedList(false)}<div class="row between"><button class="btn btn-ghost btn-sm" type="button" data-act="hide-words">${I("eye-off", "s16")}Hide words</button><span class="cap">Copy is turned off on purpose</span></div>`
    : html`<div style="position:relative">${seedList(true)}<div class="seed-cover"><div class="inner">${I("eye-off", "s24")}<p class="small">Make sure nobody can see your screen.</p><button class="btn btn-secondary btn-sm" type="button" data-act="reveal">${I("eye", "s16")}Reveal words</button></div></div></div>
  <div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">No screenshots, no cloud notes</span>A photo or a synced note is a copy someone else can read.</div></div>`}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="to-verify" ${shown ? "" : html`aria-disabled="true" disabled`}>I wrote them down</button>`,
  };
};
actions.reveal = () => {
  S.f.revealed = true;
  render();
};
actions["hide-words"] = () => {
  S.f.revealed = false;
  render();
};
actions["to-verify"] = () => go("verify");

type Verify = { pos: number[]; opts: string[][]; pick: (string | null)[] };
function rnd(n: number): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]! % n;
}
function makeVerify(w: string[]): Verify {
  const pos: number[] = [];
  const third = Math.floor(w.length / 3);
  for (let k = 0; k < 3; k++) pos.push(k * third + rnd(third));
  const opts = pos.map((p) => {
    const set = new Set([w[p]!]);
    while (set.size < 4) {
      const c = wordlist[rnd(wordlist.length)]!;
      if (!w.includes(c)) set.add(c);
    }
    const arr = [...set];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = rnd(i + 1);
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  });
  return { pos, opts, pick: [null, null, null] };
}

screens.verify = () => {
  const w = words();
  if (w.length && !S.d.verify) S.d.verify = makeVerify(w);
  const v = S.d.verify as Verify | undefined;
  const allOk = !!v && v.pos.every((p, i) => v.pick[i] === w[p]);
  return {
    title: "Check your backup",
    solo: true,
    header: hdr({ title: "Create wallet" }),
    main: html`
  ${dots(3)}
  <div class="stack"><h2 style="font:var(--t-title)">Check your backup</h2><p class="muted">Pick the right word for each position, using your paper.</p></div>
  ${v
    ? v.pos.map((p, i) => {
        const picked = v.pick[i];
        const wrong = picked !== null && picked !== w[p];
        return html`<fieldset class="stack" style="border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:6px">Word ${p + 1}</legend>
    <div class="pick">${v.opts[i]!.map((o) => html`<button type="button" data-act="pick" data-i="${i}" data-w="${o}" aria-pressed="${String(picked === o)}" class="${picked === o && wrong ? "wrong" : ""}">${o}</button>`)}</div>
    ${wrong ? html`<p class="err" role="alert">${I("circle-alert", "s16")}Not word ${p + 1}. Check your paper.</p>` : ""}</fieldset>`;
      })
    : ""}
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="finish-create" ${allOk && !busy("create") ? "" : html`aria-disabled="true"`}>${busy("create") ? html`${I("loader-circle", "s16 spin")}Creating your wallet…` : "Finish"}</button><button class="btn btn-ghost btn-block" type="button" data-act="words-again">Show my words again</button>`,
  };
};
actions.pick = (el) => {
  const v = S.d.verify as Verify;
  v.pick[Number(el.dataset.i)] = el.dataset.w!;
  render();
};
actions["words-again"] = () => {
  S.f.revealed = true;
  back("seed");
};
actions["finish-create"] = async () => {
  const ok = await run("create", async () => {
    S.b = await call({ type: "CREATE_CHECKED", password: fv("pw"), passphrase: fv("pp") });
    return true;
  });
  if (!ok) return;
  S.f = {};
  S.d = {};
  go("ready", {}, { reset: true });
};

/* ---------- ready ---------- */
screens.ready = () => {
  const code = S.b?.state.receive ?? "";
  return {
    title: "Wallet ready",
    solo: true,
    main: html`
  <div class="state"><div class="big">${I("circle-check")}</div><h1>Your wallet is ready</h1><p>This is your receive code. Share it with anyone. Each payment arrives at a new, unlinkable address.</p></div>
  <div class="codebox"><div class="row between"><span class="ntag">${NETLOGO("fractal")}Fractal code</span><button class="btn btn-ghost btn-sm" type="button" data-act="copy-code">${I("copy", "s16")}Copy</button></div><p class="code">${codeHi(code, 8, 8)}</p></div>
  <button class="card pad-sm" type="button" data-act="go" data-to="migrate" style="flex-direction:row;align-items:center;text-align:left;color:inherit;font:inherit;width:100%;cursor:pointer"><span class="ico">${I("arrow-right-left")}</span><span class="grow"><span class="strong" style="display:block">Moving coins from another wallet?</span><span class="small muted">Send them to this code once, then stop using the old address.</span></span>${I("chevron-right")}</button>`,
    foot: { cls: "plain", html: html`<button class="btn btn-primary btn-block" type="button" data-act="open-wallet">Open wallet</button>` },
  };
};
actions["open-wallet"] = () => go("home", {}, { reset: true });
actions["copy-code"] = async () => {
  await copyText(S.b?.state.receive ?? "");
  toast("Code copied.");
};

/* ---------- import ---------- */
function closest(word: string): string | undefined {
  let best: string | undefined;
  let bd = 3;
  for (const c of wordlist) {
    if (Math.abs(c.length - word.length) > 2) continue;
    const d = lev(word, c);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}
function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n]!;
}

export function checkMnemonic(text: string): { ok: boolean; msg?: string; count: number } {
  const w = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!w.length) return { ok: false, count: 0 };
  for (let i = 0; i < w.length; i++) {
    if (!wordlist.includes(w[i]!)) {
      const c = closest(w[i]!);
      return { ok: false, count: w.length, msg: `Word ${i + 1} \u201c${w[i]}\u201d is not in the recovery word list.${c ? ` Did you mean \u201c${c}\u201d?` : ""}` };
    }
  }
  if (![12, 15, 18, 21, 24].includes(w.length)) return { ok: false, count: w.length, msg: `${w.length} words. Recovery words come in 12 or 24.` };
  if (!validateMnemonic(w.join(" "), wordlist)) return { ok: false, count: w.length, msg: "The words are all valid but the checksum does not match. Check the order and spelling." };
  return { ok: true, count: w.length };
}

screens.import = () => {
  const mn = fv("mn");
  const c = checkMnemonic(mn);
  const showErr = !!c.msg && (S.f.mnTried === true || c.count >= 12);
  const custom = S.f.bdMode === "custom";
  const hasVault = S.b?.state.hasVault;
  return {
    title: "Import wallet",
    solo: true,
    header: hdr({ title: "Import wallet" }),
    main: html`
  ${hasVault ? html`<div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">This replaces the wallet on this computer</span>Only continue if you have the recovery words for the current wallet too.</div></div>` : ""}
  <div class="field"><label class="label" for="mn">Recovery words</label><textarea class="textarea" id="mn" data-f="mn" data-live rows="4" spellcheck="false" autocomplete="off" autocapitalize="off" ${showErr ? html`aria-invalid="true" aria-describedby="mn-e"` : html`aria-describedby="mn-h"`}>${mn}</textarea>
  ${showErr ? html`<p class="err" id="mn-e" role="alert">${I("circle-alert", "s16")}<span>${c.msg}</span></p>` : c.ok ? html`<p class="help" id="mn-h">${I("circle-check", "s16")} ${c.count} words, checksum valid. Paste is allowed.</p>` : html`<p class="help" id="mn-h">12 or 24 words separated by spaces. Paste is allowed.</p>`}</div>
  <fieldset class="field" style="border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:6px">When did this wallet first receive coins?</legend>
    <div class="opt-list" role="radiogroup">
      <button class="opt" type="button" role="radio" data-act="set" data-k="bdMode" data-v="default" aria-checked="${String(!custom)}"><span class="body"><span class="t">Since Silent Payments started on Fractal</span><span class="d">Block ${num(DEFAULT_BIRTHDAY)}. Safest, slower first scan.</span></span></button>
      <button class="opt" type="button" role="radio" data-act="set" data-k="bdMode" data-v="custom" aria-checked="${String(custom)}"><span class="body"><span class="t">I know the block</span><span class="d">Faster. Too late and older coins will not show.</span></span></button>
    </div>
    ${custom ? html`<div class="field" style="margin-top:8px"><label class="label" for="bd">Block height</label><input class="input mono" id="bd" data-f="bd" inputmode="numeric" placeholder="${num(DEFAULT_BIRTHDAY)}" value="${fv("bd")}" ${err("bd") ? html`aria-invalid="true" aria-describedby="bd-e"` : ""}>${err("bd") ? html`<p class="err" id="bd-e" role="alert">${I("circle-alert", "s16")}<span>${err("bd")}</span></p>` : ""}</div>` : ""}</fieldset>
  <details class="card flat pad-sm" ${S.f.ppOpen ? html`open` : ""}><summary class="small strong" style="cursor:pointer" data-act="toggle" data-k="ppOpen">Extra passphrase (only if you set one)</summary><div class="field" style="margin-top:8px"><label class="label" for="pp">Passphrase</label><input class="input" id="pp" data-f="pp" type="password" autocomplete="off" value="${fv("pp")}"></div></details>
  <div class="banner">${I("info", "s16")}<div>Recovery words from any BIP39 wallet are accepted. PrivateBit derives its own Fractal Silent Payment keys from them, so your old addresses will not appear here.</div></div>`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="import-continue">Continue to password</button>`,
  };
};
actions.set = (el) => {
  S.f[el.dataset.k!] = el.dataset.v!;
  render();
};
function birthdayValue(): number | null {
  if (S.f.bdMode !== "custom") return DEFAULT_BIRTHDAY;
  const n = Number(fv("bd").replace(/[,\s]/g, ""));
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}
actions["import-continue"] = () => {
  S.f.mnTried = true;
  const c = checkMnemonic(fv("mn"));
  S.err = {};
  if (birthdayValue() === null) S.err.bd = "Enter a block number, for example the block of your first payment.";
  if (!c.ok || S.err.bd) {
    render();
    return;
  }
  go("import-password");
};
actions["import-finish"] = async () => {
  if (!checkPasswords()) return;
  const mnemonic = fv("mn").trim().toLowerCase().split(/\s+/).join(" ");
  const ok = await run("restore", async () => {
    S.b = await call({ type: "RESTORE", mnemonic, password: fv("pw"), passphrase: fv("pp"), birthday: birthdayValue() ?? DEFAULT_BIRTHDAY });
    return true;
  });
  if (!ok) return;
  S.f = {};
  S.d = {};
  go("home", {}, { reset: true });
};

/* ---------- unlock ---------- */
const LEDGER = [0, 0, 1, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 3, 0, 0, 1, 0, 0, 0, 3, 0, 0, 2];
screens.unlock = () => {
  const li = S.b?.lockinfo;
  const loading = busy("unlock");
  return {
    title: "Unlock",
    solo: true,
    main: html`
  <div class="row" style="gap:10px;padding-top:4px">${MARK(28, false)}<span class="wordmark">PrivateBit</span></div>
  <div class="ledger" aria-hidden="true">${LEDGER.map((v) => html`<i class="${["", "a", "o", "s"][v]}"></i>`)}</div>
  <div class="unlock-hero"><h1>Unlock your wallet</h1><p class="muted">Your balance, codes and payment links stay sealed until you do.</p></div>
  ${li?.by === "auto" ? html`<p class="small row" role="status" style="gap:6px">${I("timer", "s16")}Locked itself after ${li.minutes ?? 15} minutes without use.</p>` : ""}
  <div class="vault">${I("hard-drive", "s16")}<span class="grow"><span class="strong" style="display:block">Keys on this computer only</span><span class="k">Encrypted with your password. Nothing is sent anywhere.</span></span>${NETLOGO("fractal")}</div>
  <div data-enter="unlock">${pwField("pw", "Password", "current-password")}</div>
`,
    foot: {
      cls: "plain",
      html: loading
        ? html`<button class="btn btn-primary btn-block" type="button" aria-disabled="true">${I("loader-circle", "s16 spin")}Unlocking…</button><p class="cap" style="text-align:center">Decrypting takes about a second on purpose. It slows down password guessing.</p>`
        : html`<button class="btn btn-primary btn-block" type="button" data-act="unlock">Unlock</button><button class="btn btn-ghost btn-block" type="button" data-act="go" data-to="import">Forgot password? Restore from words</button>`,
    },
  };
};
actions.unlock = async () => {
  const pw = fv("pw");
  if (!pw) {
    S.err.pw = "Enter your password.";
    render();
    return;
  }
  S.busy = "unlock";
  S.err = {};
  render();
  try {
    S.b = await call({ type: "UNLOCK", password: pw });
    S.f = {};
    S.busy = null;
    go("home", {}, { reset: true });
  } catch (e) {
    S.busy = null;
    const caps = (window as unknown as { __caps?: boolean }).__caps;
    S.err.pw = /wrong password/i.test(String((e as Error).message)) ? `Wrong password.${caps ? " Caps Lock is on." : ""}` : String((e as Error).message);
    render();
  }
};
document.addEventListener("keydown", (ev) => {
  (window as unknown as { __caps?: boolean }).__caps = ev.getModifierState?.("CapsLock");
});

export async function boot(): Promise<void> {
  await refresh();
  const st = S.b?.state;
  if (!st?.hasVault) {
    const ob = await call<{ mnemonic: string } | null>({ type: "ONBOARD_GET" }).catch(() => null);
    go(ob ? "seed" : "welcome", {}, { reset: true });
  } else if (!st.unlocked) go("unlock", {}, { reset: true });
  else go("home", {}, { reset: true });
}

screens.boot = () => ({ title: "Loading", solo: true, main: html`<div class="state"><div class="big neutral">${I("loader-circle", "spin")}</div></div>` });
