// Paths for browser runs. Defaults stay inside this checkout. Override with PB_OUT or PB_CHROME.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
export const SHARED = resolve(here, "..");
export const DIST = resolve(SHARED, "dist");
export const DIST_E2E = resolve(SHARED, "dist-e2e");

export function screens(name = "") {
  const base = process.env.PB_OUT ?? resolve(SHARED, "e2e-out");
  return name ? resolve(base, name) : base;
}

/** Three positions from a generated backup, for CREATE_CHECKED in browser runs. */
export function backupChecks(mnemonic) {
  const words = String(mnemonic ?? "").trim().split(/\s+/);
  return [0, 8, 16].map((index) => ({ index, word: words[index] }));
}

export function chromePath() {
  return process.env.PB_CHROME || chromium.executablePath();
}
