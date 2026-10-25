import { LEFTOVER_CHOICES, type LeftoverPref } from "./coinselect.ts";
import { DELAY_CHOICES, type DelayChoice } from "./plan-random.ts";

/** Plain preferences. No wallet data lives here (DATA.md section 2). */
export type LockMinutes = 5 | 15 | 30 | 60;
export const LOCK_CHOICES: LockMinutes[] = [5, 15, 30, 60];

export type Prefs = {
  lockMinutes: LockMinutes;
  /** Show the value in USD. On by default; off means no price request is ever made. */
  usd: boolean;
  /** Request route for price and fee calls. Only "direct" ships in v1. */
  route: "direct";
  hideBalance: boolean;
  askExplorer: boolean;
  /** Hold a signed payment and send it after a random wait. Payjoin sends are never delayed. */
  sendDelay: DelayChoice;
  /** Move the chosen fee rate by up to 5% either way, never below the network minimum. */
  randomizeFee: boolean;
  /** Leftover under this goes to the fee instead of a change output. */
  leftover: LeftoverPref;
};

export const DEFAULT_PREFS: Prefs = {
  lockMinutes: 15,
  usd: true,
  route: "direct",
  hideBalance: false,
  askExplorer: true,
  sendDelay: "off",
  randomizeFee: false,
  leftover: "auto",
};

export const PREFS_KEY = "privatebit.prefs";

export function normalizePrefs(raw: unknown): Prefs {
  const p = (raw && typeof raw === "object" ? raw : {}) as Partial<Prefs>;
  const lock = LOCK_CHOICES.includes(p.lockMinutes as LockMinutes) ? (p.lockMinutes as LockMinutes) : 15;
  return {
    lockMinutes: lock,
    usd: typeof p.usd === "boolean" ? p.usd : true,
    route: "direct",
    hideBalance: typeof p.hideBalance === "boolean" ? p.hideBalance : false,
    askExplorer: typeof p.askExplorer === "boolean" ? p.askExplorer : true,
    sendDelay: DELAY_CHOICES.includes(p.sendDelay as DelayChoice) ? (p.sendDelay as DelayChoice) : "off",
    randomizeFee: typeof p.randomizeFee === "boolean" ? p.randomizeFee : false,
    leftover: LEFTOVER_CHOICES.includes(p.leftover as LeftoverPref) ? (p.leftover as LeftoverPref) : "auto",
  };
}
