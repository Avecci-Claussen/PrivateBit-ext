import { S, screens, actions, loaders, go, back, render, run, refresh, refreshUntilReady, fv, busy, err, toast, landing } from "../app.ts";
import { call, type Bundle } from "../api.ts";
import { html, I, curNet, MARK, NETLOGO, codeHi, num, type Safe } from "../kit.ts";
import { hdr } from "../chrome.ts";
import { wordlist } from "@scure/bip39/wordlists/english";
import { validateMnemonic } from "@scure/bip39";
import { netInfo } from "../../lib/network.ts";
import { copyText } from "../copy.ts";
const defBirthday = (): number => netInfo(curNet()).defaultBirthday;

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
  if (!n) return { bars: 0, text: "At least 12 characters. A few random words are easy to remember and hard to guess." };
  if (n < 12) return { bars: 1, text: `Too short. ${n} of at least 12 characters.` };
  if (n < 16) return { bars: 2, text: `OK. ${n} characters. Longer is stronger than complex.` };
  if (n < 20) return { bars: 3, text: `Good. ${n} characters. Longer is stronger than complex.` };
  return { bars: 4, text: `Strong. ${n} characters.` };
}

/* ---------- welcome ---------- */
screens.welcome = () => ({
  title: "Welcome",
  solo: true,
  mainCls: "ob",
  main: html`
  <div data-st="97445a"></div>
  ${MARK(64)}
  <div class="stack-3">
    <h1 data-st="326b98">PrivateBit</h1>
    <p data-st="ee6e1d">A Bitcoin and Fractal Bitcoin wallet with one reusable receive code. Every payment lands at a new address only you can find.</p>
  </div>
  ${S.b?.state.hasBackup ? html`<div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">A previous wallet is still on this computer</span>Reloading the extension does not delete it. Recover it instead of creating a new one.</div></div>` : ""}
  <ul class="stack" data-st="99409a">
    <li class="row small">${I("key-round", "s16")}<span>Keys stay on this computer, encrypted with your password.</span></li>
    <li class="row small">${I("route", "s16")}<span>Payment links hide which coins are yours (Payjoin).</span></li>
    <li class="row small">${I("scan-line", "s16")}<span>Your coins are found locally. No server learns which are yours.</span></li>
  </ul>`,
  foot: { cls: "plain", html: html`${S.b?.state.hasBackup ? html`<button class="btn btn-primary btn-block" type="button" data-act="go" data-to="restore-backup">Recover the previous wallet</button>` : ""}<button class="btn ${S.b?.state.hasBackup ? "btn-secondary" : "btn-primary"} btn-block" type="button" data-act="go" data-to="create-password">Create a new wallet</button><button class="btn btn-secondary btn-block" type="button" data-act="go" data-to="import">I already have recovery words</button>` },
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
  <div class="stack" data-enter="${create ? "pw-continue" : "import-finish"}"><h2 data-st="9d50d4">Choose a password</h2><p class="muted">It unlocks PrivateBit on this computer. It cannot recover your coins; your recovery words do that.</p></div>
  <div class="stack" data-enter="${create ? "pw-continue" : "import-finish"}">
  ${pwFieldLive("pw", s)}
  ${pwField("pw2", "Repeat password", "new-password")}
  </div>
  ${create
    ? html`<div class="card flat pad-sm"><p class="strong">24 recovery words</p><p class="small muted">A new wallet is 256 bits, drawn from this computer's secure random generator. That is the strongest BIP39 backup. Write the words on paper.</p>
    <div class="field" data-st="8a77e5"><label class="label" for="pp">Extra passphrase <span class="optl">(optional)</span></label><input class="input" id="pp" data-f="pp" type="password" autocomplete="off" value="${fv("pp")}" aria-describedby="pp-h"><p class="help" id="pp-h">Leave this empty unless you want a second secret. It is not the password above. Without it, the words alone cannot recover the coins, and nobody can reset it.</p></div>
    <div class="field"><label class="label" for="wname">Name <span class="optl">(optional)</span></label><input class="input" id="wname" data-f="wname" maxlength="40" autocomplete="off" value="${fv("wname")}" placeholder="Wallet" aria-describedby="wname-h"><p class="help" id="wname-h">Up to 40 characters. Shown at the top and in the wallet list. You can rename it later.</p></div></div>`
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
  if ([...pw].length < 12) S.err.pw = "Use at least 12 characters.";
  else if (pw !== fv("pw2")) S.err.pw2 = "The passwords do not match.";
  render();
  return !S.err.pw && !S.err.pw2;
}

actions["pw-continue"] = async () => {
  if (!checkPasswords()) return;
  if (S.b?.state.hasVault && S.f.adding !== true) {
    toast("A wallet is already on this computer. Unlock it, or add another from Settings.");
    go("unlock", {}, { reset: true });
    return;
  }
  const ob = await run("pw", () => call<{ mnemonic: string; words: number }>({ type: "NEW_MNEMONIC", add: S.f.adding === true }));
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
// Audit L4: leaving setup forgets the new words shown on this page and in the background.
loaders.welcome = async () => {
  S.d.words = undefined;
  await call({ type: "ONBOARD_CLEAR" }).catch(() => undefined);
};
loaders.verify = loadOnboard;

const words = (): string[] => (S.d.words as string[] | undefined) ?? [];

function seedList(blur: boolean): Safe {
  const w = words();
  return html`<ol class="seed ${blur ? "blur" : ""}" aria-label="Recovery words" ${w.length > 12 ? html`data-st="4ae8bf"` : ""}>${w.map((x, i) => html`<li><span class="ix">${i + 1}</span><span>${blur ? "\u2022\u2022\u2022\u2022\u2022" : x}</span></li>`)}</ol>`;
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
  <div class="stack"><h2 data-st="9d50d4">Write down your recovery words</h2><p class="muted">${n} words, in order, on paper. Anyone with these words can take your coins.</p></div>
  ${shown
    ? html`${seedList(false)}<div class="row between"><button class="btn btn-ghost btn-sm" type="button" data-act="hide-words">${I("eye-off", "s16")}Hide words</button><span class="cap">Copy is turned off on purpose</span></div>`
    : html`<div data-st="d461c9">${seedList(true)}<div class="seed-cover"><div class="inner">${I("eye-off", "s24")}<p class="small">Make sure nobody can see your screen.</p><button class="btn btn-secondary btn-sm" type="button" data-act="reveal">${I("eye", "s16")}Reveal words</button></div></div></div>
  <div class="banner warn">${I("triangle-alert", "s16")}<div><span class="bt">No screenshots, no cloud notes</span>A photo or a synced note is a copy someone else can read.</div></div>`}
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}`,
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
actions["to-verify"] = () => {
  const w = words();
  if (S.f.revealed !== true || w.length !== 24) return;
  S.d.verify = makeVerify(w);
  S.f.revealed = false;
  go("verify");
};

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
  const v = S.d.verify as Verify | undefined;
  const allOk = !!v && v.pos.every((p, i) => v.pick[i] === w[p]);
  return {
    title: "Check your backup",
    solo: true,
    header: hdr({ title: "Create wallet" }),
    main: html`
  ${dots(3)}
  <div class="stack"><h2 data-st="9d50d4">Check your backup</h2><p class="muted">Pick each word from the paper you just wrote. The words stay hidden. One wrong answer starts this check over.</p></div>
  ${v
    ? v.pos.map((p, i) => {
        const picked = v.pick[i];
        return html`<fieldset class="stack" data-st="e8f267"><legend class="label" data-st="4e420a">Word ${p + 1}</legend>
    <div class="pick">${v.opts[i]!.map((o) => html`<button type="button" data-act="pick" data-i="${i}" data-w="${o}" aria-pressed="${String(picked === o)}" ${picked ? html`disabled` : ""}>${o}</button>`)}</div></fieldset>`;
      })
    : html`<p class="muted">Write the words down first.</p>`}
  ${err("form") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("form")}</span></p>` : ""}`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="finish-create" ${allOk && !busy("create") ? "" : html`aria-disabled="true"`}>${busy("create") ? html`${I("loader-circle", "s16 spin")}Creating your wallet…` : "Finish"}</button><button class="btn btn-ghost btn-block" type="button" data-act="words-again">Back to my paper</button>`,
  };
};
actions.pick = (el) => {
  const v = S.d.verify as Verify | undefined;
  if (!v || v.pick[Number(el.dataset.i)]) return;
  const i = Number(el.dataset.i);
  const chosen = el.dataset.w ?? "";
  const w = words();
  if (w[v.pos[i]!] !== chosen) {
    S.d.verify = undefined;
    S.f.revealed = false;
    back("seed");
    S.err.form = "That is not the word from your backup. The check was reset and the words are hidden again. Read them from your paper, then start again.";
    render();
    return;
  }
  v.pick[i] = chosen;
  render();
};
actions["words-again"] = () => {
  S.d.verify = undefined;
  S.f.revealed = false;
  back("seed");
};
actions["finish-create"] = async () => {
  const v = S.d.verify as Verify | undefined;
  const w = words();
  if (!v || !v.pos.every((p, i) => v.pick[i] === w[p])) return;
  const checks = v.pos.map((index, i) => ({ index, word: v.pick[i] ?? "" }));
  const ok = await run("create", async () => {
    S.b = await call({ type: "CREATE_CHECKED", password: fv("pw"), passphrase: fv("pp"), add: S.f.adding === true, name: fv("wname"), checks });
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
  <div class="codebox"><div class="row between"><span class="ntag">${NETLOGO()}Receive code</span><button class="btn btn-ghost btn-sm" type="button" data-act="copy-code">${I("copy", "s16")}Copy</button></div><p class="code">${codeHi(code, 8, 8)}</p></div>
  <button class="card pad-sm" type="button" data-act="go" data-to="migrate" data-st="05e885"><span class="ico">${I("arrow-right-left")}</span><span class="grow"><span class="strong" data-st="2a1b75">Moving coins from another wallet?</span><span class="small muted">Send them to this code once, then stop using the old address.</span></span>${I("chevron-right")}</button>`,
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
  if (![12, 15, 18, 21, 24].includes(w.length)) return { ok: false, count: w.length, msg: `${w.length} words. A new wallet is 24 words. An older backup can be 12.` };
  if (!validateMnemonic(w.join(" "), wordlist)) return { ok: false, count: w.length, msg: "The words are all valid but the checksum does not match. Check the order and spelling." };
  return { ok: true, count: w.length };
}

screens.import = () => {
  const mn = fv("mn");
  const c = checkMnemonic(mn);
  const showErr = !!c.msg && (S.f.mnTried === true || c.count >= 12);
  const custom = S.f.bdMode === "custom";
  const hasVault = S.b?.state.hasVault;
  const forgot = S.f.forgot === true;
  const openName = (S.b?.state.wallets ?? []).find((w) => w.active)?.name ?? "this wallet";
  const tip = typeof S.d.tipHeight === "number" ? S.d.tipHeight : defBirthday();
  return {
    title: "Import wallet",
    solo: true,
    header: hdr({ title: "Import wallet" }),
    main: html`
  ${forgot ? html`<div class="banner">${I("info", "s16")}<div><span class="bt">Open ${openName} with its words</span>Type its recovery words. It opens with them and gets the password you choose next. Its coins, labels and history stay.</div></div>` : hasVault ? html`<div class="banner">${I("info", "s16")}<div>This adds a wallet. The wallets on this computer stay. If these words are already here, that wallet opens instead and nothing is replaced.</div></div>` : ""}
  <div class="field"><label class="label" for="mn">Recovery words</label><textarea class="textarea" id="mn" data-f="mn" data-live rows="4" spellcheck="false" autocomplete="off" autocapitalize="off" ${showErr ? html`aria-invalid="true" aria-describedby="mn-e"` : html`aria-describedby="mn-h"`}>${mn}</textarea>
  ${showErr ? html`<p class="err" id="mn-e" role="alert">${I("circle-alert", "s16")}<span>${c.msg}</span></p>` : c.ok ? html`<p class="help" id="mn-h">${I("circle-check", "s16")} ${c.count} words, checksum valid.${c.count === 24 ? "" : " New wallets are 24 words. This older backup still restores."}</p>` : html`<p class="help" id="mn-h">24 words, separated by spaces. An older 12-word backup still restores.</p>`}</div>
  <fieldset class="field" data-st="e8f267"><legend class="label" data-st="4e420a">Start reading the chain at</legend>
    <div class="opt-list" role="radiogroup">
      <button class="opt" type="button" role="radio" data-act="set" data-k="bdMode" data-v="default" aria-checked="${String(!custom)}"><span class="body"><span class="t">The latest block, ${num(tip)}</span><span class="d">Fast. Coins received before this block will not show.</span></span></button>
      <button class="opt" type="button" role="radio" data-act="set" data-k="bdMode" data-v="custom" aria-checked="${String(custom)}"><span class="body"><span class="t">A block I choose</span><span class="d">Use the block of the first payment, or any earlier block. PrivateBit reads forward from there.</span></span></button>
    </div>
    ${custom ? html`<div class="field" data-st="8a77e5"><label class="label" for="bd">Block height</label><input class="input mono" id="bd" data-f="bd" data-live inputmode="numeric" placeholder="${num(tip)}" value="${fv("bd")}" ${err("bd") ? html`aria-invalid="true" aria-describedby="bd-e"` : ""}>${err("bd") ? html`<p class="err" id="bd-e" role="alert">${I("circle-alert", "s16")}<span>${err("bd")}</span></p>` : html`<p class="help">A lower number finds older coins and takes longer. The scan starts as soon as this wallet is open.</p>`}</div>` : ""}</fieldset>
  <div class="field"><label class="label" for="pp">Extra passphrase <span class="optl">(only if this wallet has one)</span></label><input class="input" id="pp" data-f="pp" type="password" autocomplete="off" value="${fv("pp")}" aria-describedby="pp-h"><p class="help" id="pp-h">This is not the password you are about to choose. Leave it empty if you never set one. A wrong passphrase opens a different, empty wallet.</p></div>
  <div class="field"><label class="label" for="wname">Name <span class="optl">(optional)</span></label><input class="input" id="wname" data-f="wname" maxlength="40" autocomplete="off" value="${fv("wname")}" placeholder="Wallet" aria-describedby="wname-h"><p class="help" id="wname-h">Up to 40 characters. Shown at the top and in the wallet list. You can rename it later.</p></div>
  <div class="banner">${I("info", "s16")}<div>These words can come from any BIP39 wallet. PrivateBit derives its own Silent Payment keys from them, so addresses from the old wallet do not appear here.</div></div>`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="import-continue">Continue to password</button>`,
  };
};
loaders.import = async () => {
  try {
    const tip = await call<{ height: number }>({ type: "TIP" });
    S.d.tipHeight = tip.height;
  } catch {
    S.d.tipHeight = undefined;
  }
};
actions.set = (el) => {
  S.f[el.dataset.k!] = el.dataset.v!;
  render();
};
function birthdayValue(): number | null {
  if (S.f.bdMode !== "custom") {
    const tip = S.d.tipHeight;
    return typeof tip === "number" && tip > 0 ? tip : defBirthday();
  }
  const n = Number(fv("bd").replace(/[,\s]/g, ""));
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}
actions["import-continue"] = () => {
  S.f.mnTried = true;
  const c = checkMnemonic(fv("mn"));
  S.err = {};
  if (birthdayValue() === null) S.err.bd = "Enter a block number, such as the block of your first payment.";
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
    const r = await call<Bundle & { imported?: ImportResult }>({ type: "RESTORE", mnemonic, password: fv("pw"), passphrase: fv("pp"), birthday: birthdayValue() ?? defBirthday(), add: S.f.adding === true, name: fv("wname"), forgot: S.f.forgot === true });
    S.b = r;
    return r.imported ?? true;
  });
  if (!ok) return;
  S.f = {};
  S.d = {};
  go("home", {}, { reset: true });
  if (ok !== true) toast(importMessage(ok));
};

type ImportResult = { result: "created" | "added" | "existing"; name: string; passwordChanged: boolean };
export function importMessage(r: ImportResult): string {
  if (r.result === "existing") {
    return r.passwordChanged
      ? `${r.name} was already on this computer. It is open now with your new password. Nothing was replaced.`
      : `${r.name} is already on this computer, so it is open now. Nothing was replaced. Its password did not change.`;
  }
  return r.result === "added" ? `${r.name} added and open. The other wallets stay on this computer.` : `${r.name} is ready.`;
}
actions["import-forgot"] = () => {
  S.f.forgot = true;
  go("import");
};

/* ---------- unlock ---------- */
const LEDGER = [0, 0, 1, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 3, 0, 0, 1, 0, 0, 0, 3, 0, 0, 2];
screens.unlock = () => {
  const li = S.b?.lockinfo;
  const loading = busy("unlock");
  const wallets = S.b?.state.wallets ?? [];
  const active = wallets.find((w) => w.active);
  return {
    title: "Unlock",
    solo: true,
    main: html`
  <div class="row" data-st="6755cd">${MARK(28, false)}<span class="wordmark">PrivateBit</span></div>
  <div class="ledger" aria-hidden="true">${LEDGER.map((v) => html`<i class="${["", "a", "o", "s"][v]}"></i>`)}</div>
  <div class="unlock-hero"><h1>${active && wallets.length > 1 ? `Unlock ${active.name}` : "Unlock your wallet"}</h1><p class="muted">Your balance, codes and payment links stay sealed until you do. The password is the one for this computer, not the extra passphrase.</p></div>
  ${wallets.length > 1 ? html`<div class="stack" data-st="d794dd"><p class="label" id="wl-h">Wallet to unlock</p><ul class="opt-list ulist" aria-labelledby="wl-h">${wallets.map((w) => html`<li><button class="opt" type="button" data-act="wallet-pick" data-id="${w.id}" ${w.active ? html`aria-current="true"` : ""} aria-label="${w.name}${w.active ? ", selected" : ", select"}"><span class="body"><span class="t">${w.name}</span><span class="d">${w.words ? `${w.words} words` : "Recovery words"}</span></span>${w.active ? I("check") : I("chevron-right", "s16")}</button></li>`)}</ul></div>` : ""}
  ${li?.by === "auto" ? html`<p class="small row" role="status" data-st="f0abc1">${I("timer", "s16")}Locked itself after ${li.minutes ?? 15} minutes without use.</p>` : ""}
  <div data-enter="unlock">${pwField("pw", "Password", "current-password")}</div>
  <div class="vault">${I("hard-drive", "s16")}<span class="grow"><span class="strong" data-st="2a1b75">Keys on this computer only</span><span class="k">Encrypted with your password. Nothing is sent anywhere.</span></span>${NETLOGO()}</div>
`,
    foot: {
      cls: "plain",
      html: loading
        ? html`<button class="btn btn-primary btn-block" type="button" aria-disabled="true">${I("loader-circle", "s16 spin")}Unlocking…</button><p class="cap" data-st="91a870">Decrypting takes about a second on purpose. It slows down password guessing.</p>`
        : html`<button class="btn btn-primary btn-block" type="button" data-act="unlock">Unlock</button><button class="btn btn-ghost btn-block" type="button" data-act="import-forgot">Forgot password? Open with recovery words</button>`,
    },
  };
};
actions["wallet-pick"] = async (el) => {
  const id = el.dataset.id;
  if (!id) return;
  const current = S.b?.state.wallets?.find((w) => w.active);
  if (current?.id === id) return;
  try {
    S.b = await call({ type: "SWITCH_WALLET", id });
  } catch (e) {
    toast(e instanceof Error ? e.message : "Could not switch wallets.");
    return;
  }
  S.f.pw = "";
  render();
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
    go(landing(), {}, { reset: true });
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
  const ready = await refreshUntilReady();
  if (!ready) {
    go("starting", {}, { reset: true });
    return;
  }
  const st = S.b?.state;
  if (!st?.hasVault) {
    const ob = await call<{ mnemonic: string } | null>({ type: "ONBOARD_GET" }).catch(() => null);
    go(ob ? "seed" : "welcome", {}, { reset: true });
  } else if (!st.unlocked) go("unlock", {}, { reset: true });
  else go(landing(), {}, { reset: true });
}

screens.boot = () => ({ title: "Loading", solo: true, main: html`<div class="state"><div class="big neutral">${I("loader-circle", "spin")}</div></div>` });

screens.starting = () => ({
  title: "Starting",
  solo: true,
  main: html`<div class="state"><div class="big neutral">${I("loader-circle", "spin")}</div><h1>PrivateBit is starting…</h1><p>The extension just reloaded. This is not a new wallet.</p></div>
  ${err("bundle") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("bundle")}</span></p>` : ""}`,
  foot: html`<button class="btn btn-primary btn-block" type="button" data-act="boot-retry">${busy("boot") ? html`${I("loader-circle", "s16 spin")}Trying…` : "Try again"}</button>`,
});
actions["boot-retry"] = async () => {
  const ok = await run("boot", async () => refreshUntilReady(12));
  if (ok) await boot();
};
screens["restore-backup"] = () => ({
  title: "Recover previous wallet",
  main: html`<div class="state" data-st="aa619b"><div class="big neutral">${I("key-round")}</div><h1>Recover the previous wallet</h1><p>Enter the password that wallet used. The wallet that is here now is kept as the previous one, so you can switch back the same way.</p></div>
  <div data-enter="restore-backup-go">${pwField("bkpw", "Previous wallet's password", "current-password")}</div>
  ${err("bk") ? html`<p class="err" role="alert">${I("circle-alert", "s16")}<span>${err("bk")}</span></p>` : ""}`,
  foot: html`<button class="btn btn-primary btn-block" type="button" data-act="restore-backup-go">${busy("bk") ? html`${I("loader-circle", "s16 spin")}Checking…` : "Recover"}</button><button class="btn btn-ghost btn-block" type="button" data-act="back">Cancel</button>`,
});
actions["restore-backup-go"] = async () => {
  const password = fv("bkpw");
  if (!password) {
    S.err.bk = "Enter that wallet's password.";
    return render();
  }
  const ok = await run(
    "bk",
    async () => {
      S.b = await call({ type: "RESTORE_BACKUP", password });
      return true;
    },
    "bk",
  );
  if (S.err.bk && /wrong password/i.test(S.err.bk)) S.err.bk = "Wrong password for the previous wallet.";
  if (!ok) return render();
  S.f = {};
  toast("Previous wallet restored. Unlock it.");
  go("unlock", {}, { reset: true });
};
