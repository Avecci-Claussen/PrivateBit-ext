import { call, ApiError, type Bundle } from "./api.ts";
import { html, raw, setUiNet, type Safe } from "./kit.ts";

export type Foot = Safe | { cls: string; html: Safe };
export type View = {
  title: string;
  header?: Safe;
  main: Safe;
  foot?: Foot;
  nav?: Safe;
  overlay?: Safe;
  mainCls?: string;
  /** Full page only: replaces the popup layout inside the content area. */
  page?: Safe;
  /** Full page only: render without the sidebar (onboarding, unlock). */
  solo?: boolean;
};

export type Mode = "popup" | "full";

/** Everything the screens read. Forms keep their values in `f` so a re-render never loses typing. */
export const S = {
  mode: "popup" as Mode,
  b: null as Bundle | null,
  route: "boot",
  params: {} as Record<string, unknown>,
  stack: [] as { route: string; params: Record<string, unknown> }[],
  sheet: null as string | null,
  toast: null as string | null,
  busy: null as string | null,
  err: {} as Record<string, string>,
  f: {} as Record<string, string | boolean | string[] | undefined>,
  d: {} as Record<string, unknown>,
  loaded: {} as Record<string, number>,
  /** Set when this window was opened by a website request (popup.html#dapp=<id>). */
  dappId: "",
};

/** Where to land after unlock: the website request this window is for, or the wallet. */
export const landing = (): string => (S.dappId ? "dapp" : "home");

export type ScreenFn = () => View;
export const screens: Record<string, ScreenFn> = {};
export const actions: Record<string, (el: HTMLElement, ev: Event) => void | Promise<void>> = {};
/** Called when a route is entered, to load its data. */
export const loaders: Record<string, () => Promise<void> | void> = {};

let root: HTMLElement;
let renderer: (v: View) => string = () => "";

export function setRenderer(fn: (v: View) => string): void {
  renderer = fn;
}

export function go(route: string, params: Record<string, unknown> = {}, opts: { replace?: boolean; reset?: boolean } = {}): void {
  if (opts.reset) S.stack = [];
  else if (!opts.replace && S.route !== "boot") S.stack.push({ route: S.route, params: S.params });
  S.route = route;
  S.params = params;
  S.sheet = null;
  S.err = {};
  if (S.mode === "full" && history.replaceState) history.replaceState(null, "", `#/${route}`);
  render();
  void enter();
  queueMicrotask(() => {
    const m = document.getElementById("main");
    if (m) m.scrollTop = 0;
    const h = document.querySelector<HTMLElement>("h1, h2");
    if (opts.reset !== true) h?.setAttribute("tabindex", "-1");
  });
}

export function back(fallback = "home"): void {
  const prev = S.stack.pop();
  if (prev) {
    S.route = prev.route;
    S.params = prev.params;
  } else {
    S.route = fallback;
    S.params = {};
  }
  S.sheet = null;
  S.err = {};
  render();
  void enter();
}

async function enter(): Promise<void> {
  const l = loaders[S.route];
  if (!l) return;
  try {
    await l();
  } catch (e) {
    S.err.load = message(e);
  }
  render();
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
export function code(e: unknown): string | undefined {
  return e instanceof ApiError ? e.code : undefined;
}

export function toast(t: string): void {
  S.toast = t;
  render();
  setTimeout(() => {
    if (S.toast === t) {
      S.toast = null;
      render();
    }
  }, 2400);
}

/** Run an async action with a busy flag and error capture under `errKey`. */
export async function run<T>(busy: string, fn: () => Promise<T>, errKey = "form"): Promise<T | undefined> {
  S.busy = busy;
  delete S.err[errKey];
  render();
  try {
    return await fn();
  } catch (e) {
    S.err[errKey] = message(e);
    return undefined;
  } finally {
    S.busy = null;
    render();
  }
}

export async function refresh(): Promise<void> {
  try {
    S.b = await call<Bundle>({ type: "BUNDLE" });
    setUiNet(S.b.state.net);
    delete S.err.bundle;
  } catch (e) {
    S.err.bundle = message(e);
  }
}

/** After a reload the service worker may not be listening yet. Never treat that as "no wallet". */
export async function refreshUntilReady(tries = 20): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    await refresh();
    if (S.b) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return !!S.b;
}

let lastMarkup = "";
export function render(): void {
  setUiNet(S.b?.state.net);
  if (!root) return;
  const fn = screens[S.route] ?? screens.boot!;
  const view = fn();
  document.title = `PrivateBit: ${view.title}`;
  const markup = renderer(view);
  // The 2 s background refresh re-renders every screen. When nothing changed, keep the DOM:
  // replacing it would move keyboard and screen reader focus and drop a click in flight.
  if (markup === lastMarkup && root.firstChild) return;
  lastMarkup = markup;
  const active = document.activeElement as HTMLElement | null;
  const id = active?.id;
  const sel =
    active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
      ? [active.selectionStart, active.selectionEnd]
      : null;
  const scroller = document.getElementById("main");
  const st = scroller?.scrollTop ?? 0;
  const winY = window.scrollY;
  root.innerHTML = markup;
  const m2 = document.getElementById("main");
  if (m2) m2.scrollTop = st;
  if (S.mode === "full") window.scrollTo(0, winY);
  if (id) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      el.focus({ preventScroll: true });
      if (sel && "setSelectionRange" in el && sel[0] !== null) {
        try {
          el.setSelectionRange(sel[0], sel[1]);
        } catch {
          /* type=number etc */
        }
      }
    }
  }
}

let lastTouch = 0;
function touch(): void {
  const now = Date.now();
  if (now - lastTouch < 15_000 || !S.b?.state.unlocked) return;
  lastTouch = now;
  void call({ type: "ACTIVITY" }).catch(() => undefined);
}

/* Live fields re-render after the key event finishes. Replacing a focused input while
   the browser is still handling the keystroke makes it drop focus. */
let liveQueued = false;
function scheduleLive(): void {
  if (liveQueued) return;
  liveQueued = true;
  setTimeout(() => {
    liveQueued = false;
    render();
  }, 0);
}

export function mount(el: HTMLElement, mode: Mode): void {
  root = el;
  S.mode = mode;
  document.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!t) return;
    if (t.getAttribute("aria-disabled") === "true" || (t as HTMLButtonElement).disabled) {
      ev.preventDefault();
      return;
    }
    const name = t.dataset.act!;
    const fn = actions[name];
    if (!fn) return;
    ev.preventDefault();
    void fn(t, ev);
  });
  const onField = (ev: Event): void => {
    const t = ev.target as HTMLInputElement;
    const k = t.dataset?.f;
    if (!k) return;
    S.f[k] = t.type === "checkbox" ? t.checked : t.value;
    if (t.type === "checkbox") render();
    else if (t.dataset.live !== undefined) scheduleLive();
  };
  document.addEventListener("input", onField);
  document.addEventListener("change", (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.type === "checkbox" && t.dataset.act) return;
    onField(ev);
  });
  document.addEventListener("keydown", (ev) => {
    touch();
    if (ev.key === "Escape" && S.sheet) {
      S.sheet = null;
      render();
    }
    if (ev.key === "Enter" && (ev.target as HTMLElement).tagName === "INPUT") {
      const form = (ev.target as HTMLElement).closest("[data-enter]") as HTMLElement | null;
      const btn = form ? document.querySelector<HTMLElement>(`[data-act="${form.dataset.enter}"]`) : null;
      if (btn) {
        ev.preventDefault();
        btn.click();
      }
    }
  });
  document.addEventListener("pointerdown", touch);
}

export const busy = (k: string): boolean => S.busy === k;
export const err = (k: string): string | undefined => S.err[k];
export const fv = (k: string, d = ""): string => {
  const v = S.f[k];
  return typeof v === "string" ? v : d;
};
export const fb_ = (k: string): boolean => S.f[k] === true;
export { html, raw };
