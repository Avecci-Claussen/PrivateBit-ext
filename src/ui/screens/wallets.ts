import { S, screens, actions, go, refresh, render, run, fv, busy, err, toast } from "../app.ts";
import { call } from "../api.ts";
import { html, I, num, raw, type Safe } from "../kit.ts";
import { hdr } from "../chrome.ts";

type Row = NonNullable<NonNullable<typeof S.b>["state"]["wallets"]>[number];

function meta(w: Row): string {
  const parts = [w.words ? `${w.words} words` : "Recovery words"];
  if (w.hasPassphrase) parts.push("extra passphrase");
  parts.push(`from block ${num(w.birthday)}`);
  if (w.checked !== undefined) parts.push(`checked to ${num(w.checked)}`);
  return parts.join(", ");
}

function row(w: Row, only: boolean): Safe {
  const editing = S.f.renaming === w.id;
  const e = err(`rn-${w.id}`);
  return html`<li class="wrow" data-open="${String(w.active)}">
    <div class="top"><span class="body"><span class="name" id="wn-${w.id}">${w.name}</span><span class="meta">${meta(w)}</span></span>${w.active ? html`<span class="badge acc">${I("check")}Open</span>` : ""}</div>
    ${editing
      ? html`<div class="rename" data-enter="wallet-rename-save"><div class="field"><label class="label" for="rn">New name</label><input class="input" id="rn" data-f="rnName" maxlength="40" autocomplete="off" value="${fv("rnName")}" ${e ? raw(`aria-invalid="true" aria-describedby="rn-e"`) : ""}>${e ? html`<p class="err" id="rn-e" role="alert">${I("circle-alert", "s16")}<span>${e}</span></p>` : ""}</div>
        <button class="btn btn-primary btn-sm" type="button" data-act="wallet-rename-save" data-id="${w.id}" ${busy("rn") ? raw('aria-disabled="true"') : ""}>Save name</button><button class="btn btn-ghost btn-sm" type="button" data-act="wallet-rename-cancel">Cancel</button></div>`
      : html`<div class="acts">${w.active ? "" : html`<button class="btn btn-secondary btn-sm" type="button" data-act="wallet-switch" data-id="${w.id}" aria-describedby="wn-${w.id}">${I("arrow-right-left", "s16")}Switch</button>`}
        <button class="btn btn-ghost btn-sm" type="button" data-act="wallet-rename" data-id="${w.id}" aria-describedby="wn-${w.id}">${I("pencil", "s16")}Rename</button>
        <button class="btn btn-ghost btn-sm danger" type="button" data-act="go" data-to="remove" data-id="${w.id}" aria-describedby="wn-${w.id}">${I("trash-2", "s16")}${only ? "Remove from this computer" : "Remove"}</button></div>`}
  </li>`;
}

screens.wallets = () => {
  const list = S.b?.state.wallets ?? [];
  const open = list.find((w) => w.active);
  const main = html`
  <div class="stack"><h2 data-st="9d50d4">Wallets on this computer</h2><p class="muted">One wallet is open at a time. Each has its own words, password and history. Switching locks the open one. A wallet keeps finding its coins after you lock, until you switch or quit the browser.</p></div>
  ${list.length ? html`<ul class="wrows" aria-label="Wallets">${list.map((w) => row(w, list.length === 1))}</ul>` : html`<p class="small muted">No wallet on this computer yet.</p>`}
  ${S.b?.state.payjoin && list.length > 1 ? html`<div class="banner warn">${I("hourglass", "s16")}<div><span class="bt">A payment is open in ${open?.name ?? "this wallet"}</span>Switching or removing it ends that payment. You are asked first.</div></div>` : ""}`;
  return {
    title: "Wallets",
    header: hdr({ title: "Wallets" }),
    main,
    foot: { cls: "row", html: html`<button class="btn btn-primary" type="button" data-act="wallet-add">${I("plus", "s16")}Create wallet</button><button class="btn btn-secondary" type="button" data-act="wallet-import">${I("file-key", "s16")}Import words</button>` },
  };
};

actions["wallet-add"] = () => {
  S.f.adding = true;
  S.f.pp = "";
  S.f.wname = "";
  go("create-password");
};
actions["wallet-import"] = () => {
  S.f.adding = true;
  S.f.pp = "";
  S.f.mn = "";
  S.f.wname = "";
  S.f.bdMode = "custom";
  go("import");
};
actions["wallet-rename"] = (el) => {
  const id = el.dataset.id!;
  S.f.renaming = id;
  S.f.rnName = (S.b?.state.wallets ?? []).find((w) => w.id === id)?.name ?? "";
  render();
  queueMicrotask(() => document.getElementById("rn")?.focus());
};
actions["wallet-rename-cancel"] = () => {
  S.f.renaming = undefined;
  render();
};
actions["wallet-rename-save"] = async (el) => {
  const id = (el.dataset.id ?? S.f.renaming) as string;
  const name = fv("rnName").trim();
  if (!name) {
    S.err[`rn-${id}`] = "Give the wallet a name.";
    return render();
  }
  const r = await run("rn", () => call<NonNullable<typeof S.b>>({ type: "RENAME_WALLET", id, name }), `rn-${id}`);
  if (!r) return;
  S.b = r;
  S.f.renaming = undefined;
  toast(`Renamed to ${name.slice(0, 40)}.`);
};

async function switchTo(id: string): Promise<void> {
  try {
    S.b = await call({ type: "SWITCH_WALLET", id });
  } catch (e) {
    toast(e instanceof Error ? e.message : "Could not switch wallets.");
    return;
  }
  S.f = {};
  S.d = {};
  S.sheet = null;
  await refresh();
  toast("Switched. Enter that wallet's password.");
  go("unlock", {}, { reset: true });
}

/** Switch, but ask first while a payment is open: switching ends it (audit M4). */
actions["wallet-switch"] = async (el) => {
  const id = el.dataset.id;
  if (!id) return;
  if ((S.b?.state.wallets ?? []).find((w) => w.id === id)?.active) {
    S.sheet = null;
    return render();
  }
  if (S.b?.state.payjoin) {
    S.f.switchTo = id;
    S.sheet = "switchwarn";
    return render();
  }
  await switchTo(id);
};
actions["wallet-switch-force"] = async () => {
  const id = S.f.switchTo as string | undefined;
  S.sheet = null;
  if (id) await switchTo(id);
};
