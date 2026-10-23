import "../styles/tokens.css";
import "../styles/components.css";
import "../styles/fullpage.css";
import "../styles/app.css";
import { S, actions, screens, mount, go, back, render, refresh, setRenderer, type Mode } from "./app.ts";
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
import { loadHistory } from "./screens/home.ts";
import { loadSessions } from "./screens/receive.ts";
import { scanning, health } from "./derive.ts";

const LOCKED_ROUTES = new Set(["welcome", "create-password", "seed", "verify", "import", "import-password", "unlock", "boot"]);

/* ---------- navigation ---------- */
function params(el: HTMLElement): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el.dataset)) if (k !== "act" && k !== "to") p[k] = v;
  return p;
}
actions.go = (el) => go(el.dataset.to!, params(el));
actions.tab = (el) => go(el.dataset.to!, params(el), { reset: true });
actions.back = () => back(S.b?.state.unlocked ? "home" : S.b?.state.hasVault ? "unlock" : "welcome");
actions.home = () => go("home", {}, { reset: true });
actions.sheet = (el) => {
  S.sheet = el.dataset.sheet!;
  render();
  queueMicrotask(() => document.querySelector<HTMLElement>(".sheet button, .dialog button")?.focus());
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
let lastFollow = 0;
let backoffUntil = 0;
async function tick(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const before = S.b?.state.unlocked;
    await refresh();
    const st = S.b?.state;
    if (before && !st?.unlocked && !LOCKED_ROUTES.has(S.route)) {
      S.f = {};
      S.d = {};
      go("unlock", {}, { reset: true });
      return;
    }
    if (!st?.unlocked) return;
    if (S.f.hideBal === undefined) S.f.hideBal = S.b!.prefs.hideBalance;
    const now = Date.now();
    if (now >= backoffUntil) {
      const behind = scanning().on || !st.tip;
      if (behind || now - lastFollow > 30_000) {
        lastFollow = now;
        try {
          await call({ type: behind ? "SCAN" : "FOLLOW_TIP" });
          await refresh();
        } catch {
          await refresh();
          if (health() !== "ok") backoffUntil = Date.now() + 60_000;
        }
      }
    }
    if (S.route === "home" || S.route === "activity" || S.route === "activity-detail") await loadHistory();
    if (S.route === "paylink" || S.route === "pj-waiting") await loadSessions();
    await pollMigration();
    if (!S.busy && !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)) render();
  } finally {
    syncing = false;
  }
}

export async function start(mode: Mode): Promise<void> {
  document.documentElement.dataset.mode = mode;
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
  setInterval(() => void tick(), 4000);
  void tick();
}
