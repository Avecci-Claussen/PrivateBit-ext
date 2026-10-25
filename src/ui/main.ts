import "../styles/tokens.css";
import "../styles/components.css";
import "../styles/fullpage.css";
import "../styles/app.css";
import "../styles/inline.css";
import { S, actions, screens, mount, go, back, render, refresh, setRenderer, run, toast, type Mode } from "./app.ts";
import { call } from "./api.ts";
import { popupHtml, fullHtml } from "./chrome.ts";
import { boot } from "./screens/onboard.ts";
import "./screens/home.ts";
import "./screens/receive.ts";
import "./screens/send.ts";
import "./screens/coins.ts";
import "./screens/activity.ts";
import { pollMigration } from "./screens/migrate.ts";
import "./screens/settings.ts";
import "./screens/wallets.ts";
import "./screens/dapp.ts";
import { loadHistory } from "./screens/home.ts";
import { loadSessions } from "./screens/receive.ts";
import { scanning } from "./derive.ts";
import { hydrateTheme } from "./theme.ts";

const LOCKED_ROUTES = new Set(["welcome", "create-password", "seed", "verify", "import", "import-password", "unlock", "boot", "starting"]);

/* ---------- navigation ---------- */
function params(el: HTMLElement): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el.dataset)) if (k !== "act" && k !== "to") p[k] = v;
  return p;
}
actions.go = (el) => {
  if (el.dataset.to === "paylink") S.f.pjHist = false;
  go(el.dataset.to!, params(el));
};
actions.tab = (el) => go(el.dataset.to!, params(el), { reset: true });
actions.back = () => back(S.b?.state.unlocked ? "home" : S.b?.state.hasVault ? "unlock" : "welcome");
actions.home = () => go("home", {}, { reset: true });
actions.sheet = (el) => {
  S.sheet = el.dataset.sheet!;
  render();
  queueMicrotask(() => document.querySelector<HTMLElement>(".sheet button, .dialog button")?.focus());
};
actions["net-set"] = (el) => {
  const network = el.dataset.v;
  if (network !== "fractal" && network !== "bitcoin") return;
  void run("net", async () => {
    S.b = await call({ type: "SET_NETWORK", network });
    S.sheet = null;
    delete S.f.plan;
    toast(network === "bitcoin" ? "Now on Bitcoin" : "Now on Fractal Bitcoin");
    render();
  });
};
actions["sheet-close"] = () => {
  S.sheet = null;
  render();
};
async function doLock(): Promise<void> {
  await call({ type: "LOCK" });
  S.f = {};
  S.d = {};
  await refresh();
  go("unlock", {}, { reset: true });
}
actions.lock = async () => {
  await refresh();
  if (S.b?.waiting && S.b.state.payjoin) {
    S.sheet = "lockwarn";
    render();
    return;
  }
  await doLock();
};
actions["lock-force"] = () => doLock();

/* ---------- background sync while open ---------- */
let syncing = false;
let scanKicked = false;
let openWalletId = "";
async function tick(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const before = S.b?.state.unlocked;
    await refresh();
    const openId = S.b?.state.wallets?.find((w) => w.active)?.id ?? "";
    if (openId !== openWalletId) {
      openWalletId = openId;
      S.d.history = undefined;
      S.d.coins = undefined;
      S.d.sessions = undefined;
      S.d.onetime = undefined;
    }
    if (S.route === "starting" && S.b) {
      await boot();
      return;
    }
    const st = S.b?.state;
    if (before && !st?.unlocked && !LOCKED_ROUTES.has(S.route)) {
      S.f = {};
      S.d = {};
      go("unlock", {}, { reset: true });
      return;
    }
    if (!st?.unlocked) return;
    if (S.f.hideBal === undefined) S.f.hideBal = S.b!.prefs.hideBalance;
    const behind = scanning().on || !st.tip;
    if (behind) {
      if (!scanKicked) {
        scanKicked = true;
        void call({ type: "SCAN_KICK" }).catch(() => undefined);
      }
    } else {
      scanKicked = false;
    }
    if (S.route === "home" || S.route === "activity" || S.route === "activity-detail") await loadHistory();
    // One Payjoin view for every screen that shows it, refreshed together (audit M8).
    if (S.route === "paylink" || S.route === "pj-waiting" || S.route === "receive" || S.b?.state.payjoin) await loadSessions();
    await pollMigration();
    if (!S.busy && !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)) render();
  } finally {
    syncing = false;
  }
}

export async function start(mode: Mode): Promise<void> {
  document.documentElement.dataset.mode = mode;
  const dm = /^#dapp=([0-9a-f]{24})$/.exec(location.hash);
  if (mode === "popup" && dm) {
    S.dappId = dm[1]!;
    document.documentElement.dataset.dapp = "1";
  }
  await hydrateTheme();
  setRenderer(mode === "full" ? fullHtml : popupHtml);
  mount(document.getElementById("app")!, mode);
  await boot();
  if (S.b?.state.unlocked) {
    S.f.hideBal = S.b.prefs.hideBalance;
    const h = location.hash.replace(/^#\/?/, "");
    if (mode === "full" && h && screens[h] && !LOCKED_ROUTES.has(h)) go(h, {}, { reset: true });
  }
  if (mode === "full") {
    window.addEventListener("hashchange", () => {
      const h = location.hash.replace(/^#\/?/, "");
      if (S.b?.state.unlocked && h && h !== S.route && screens[h] && !LOCKED_ROUTES.has(h)) go(h, {}, { reset: true });
    });
  }
  setInterval(() => void tick(), 2000);
  void tick();
}
