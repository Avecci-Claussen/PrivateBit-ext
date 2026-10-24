import { DEFAULT_THEME, THEME_KEY, normalizeTheme, resolvedTheme, type ThemeChoice } from "../lib/theme.ts";

let current: ThemeChoice = DEFAULT_THEME;

export function currentTheme(): ThemeChoice {
  return current;
}

function readLocal(): ThemeChoice {
  try {
    return normalizeTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

function writeLocal(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* private mode or quota */
  }
}

function paint(choice: ThemeChoice): void {
  current = choice;
  const root = document.documentElement;
  root.setAttribute("data-theme", choice);
  const dark = resolvedTheme(choice, window.matchMedia("(prefers-color-scheme: dark)").matches) === "dark";
  root.style.background = dark ? "#110c26" : "#f4f1ea";
  root.style.color = dark ? "#f4f1ea" : "#2a1848";
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", choice === "light" ? "light" : choice === "system" ? "dark light" : "dark");
}

export function applyTheme(choice: ThemeChoice): void {
  const next = normalizeTheme(choice);
  paint(next);
  writeLocal(next);
  try {
    void chrome.storage.local.set({ [THEME_KEY]: next });
  } catch {
    /* tests or missing chrome */
  }
}

/** Apply localStorage immediately, then chrome.storage.local (source of truth). */
export async function hydrateTheme(): Promise<ThemeChoice> {
  paint(readLocal());
  try {
    const got = await chrome.storage.local.get(THEME_KEY);
    const stored = got[THEME_KEY];
    if (stored === undefined) {
      applyTheme(current);
    } else {
      const next = normalizeTheme(stored);
      paint(next);
      writeLocal(next);
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[THEME_KEY]) return;
      const next = normalizeTheme(changes[THEME_KEY].newValue);
      paint(next);
      writeLocal(next);
    });
  } catch {
    applyTheme(current);
  }
  return current;
}
