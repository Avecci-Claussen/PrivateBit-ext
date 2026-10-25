import { LEFTOVER_CHOICES, type LeftoverPref } from "./coinselect.ts";
import { DELAY_CHOICES, type DelayChoice } from "./plan-random.ts";
import { isNetworkId, type NetworkId } from "./network.ts";
import { PRICE_SOURCES, type PricePref } from "./requests.ts";

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
  /** The chain shown (Fractal or Bitcoin). */
  network: NetworkId;
  /** Where the USD price comes from. "off" makes no price requests (same as usd false). */
  priceSource: PricePref;
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
  network: "fractal",
  priceSource: "coingecko",
};

export const PREFS_KEY = "privatebit.prefs";

export function normalizePrefs(raw: unknown): Prefs {
  const p = (raw && typeof raw === "object" ? raw : {}) as Partial<Prefs>;
  const lock = LOCK_CHOICES.includes(p.lockMinutes as LockMinutes) ? (p.lockMinutes as LockMinutes) : 15;
  const priceSource: PricePref = PRICE_SOURCES.includes(p.priceSource as PricePref) ? (p.priceSource as PricePref) : p.usd === false ? "off" : "coingecko";
  return {
    lockMinutes: lock,
    usd: priceSource !== "off",
    route: "direct",
    hideBalance: typeof p.hideBalance === "boolean" ? p.hideBalance : false,
    askExplorer: typeof p.askExplorer === "boolean" ? p.askExplorer : true,
    sendDelay: DELAY_CHOICES.includes(p.sendDelay as DelayChoice) ? (p.sendDelay as DelayChoice) : "off",
    randomizeFee: typeof p.randomizeFee === "boolean" ? p.randomizeFee : false,
    leftover: LEFTOVER_CHOICES.includes(p.leftover as LeftoverPref) ? (p.leftover as LeftoverPref) : "auto",
    network: isNetworkId(p.network) ? p.network : "fractal",
    priceSource,
  };
}
