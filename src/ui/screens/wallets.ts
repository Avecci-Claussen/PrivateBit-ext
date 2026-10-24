import { S, screens, actions, go, refresh, toast } from "../app.ts";
import { call } from "../api.ts";
import { html, I, num } from "../kit.ts";
import { hdr } from "../chrome.ts";

screens.wallets = () => {
  const list = S.b?.state.wallets ?? [];
  const active = list.find((w) => w.active);
  return {
    title: "Wallets",
    header: hdr({ title: "Wallets" }),
    main: html`
  <div class="stack"><h2 style="font:var(--t-title)">Wallets on this computer</h2><p class="muted">One wallet is open at a time. Finding coins continues with the window closed, and after you lock, until you quit the browser or switch wallets. Each wallet starts at its own block, so the numbers will differ. Blocks already saved on this computer are reused. A payment link belongs to the wallet that created it.</p></div>
  <div class="opt-list">${list.map((w) => html`<div class="opt" style="cursor:default"><span class="body"><span class="t">${w.name}${w.active ? " · open" : ""}</span><span class="d">${w.words ? `${w.words} words` : "Recovery words"}${w.hasPassphrase ? " · extra passphrase" : ""} · from block ${num(w.birthday)}${w.checked !== undefined ? ` · checked ${num(w.checked)}` : ""}</span></span>
    ${w.active ? I("check") : html`<button class="btn btn-secondary btn-sm" type="button" data-act="wallet-switch" data-id="${w.id}">Switch</button>`}</div>`)}
  ${list.length === 0 ? html`<p class="small muted">The open wallet will show here after the next unlock.</p>` : ""}
  <div class="banner">${I("info", "s16")}<div><span class="bt">A new wallet does not see the other's coins</span>Create or import when you want a separate set of words. ${active ? `${active.name} stays here when you switch away.` : ""}</div></div>`,
    foot: html`<button class="btn btn-primary btn-block" type="button" data-act="wallet-add">Create a new wallet</button><button class="btn btn-secondary btn-block" type="button" data-act="wallet-import">Import recovery words</button>`,
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
actions["wallet-switch"] = async (el) => {
  const id = el.dataset.id;
  if (!id) return;
  try {
    S.b = await call({ type: "SWITCH_WALLET", id });
  } catch (e) {
    toast(e instanceof Error ? e.message : "Could not switch wallets.");
    return;
  }
  S.f = {};
  S.d = {};
  await refresh();
  toast("Locked. Enter that wallet's password.");
  go("unlock", {}, { reset: true });
};
