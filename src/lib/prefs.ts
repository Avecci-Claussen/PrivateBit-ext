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
};

export const DEFAULT_PREFS: Prefs = {
  lockMinutes: 15,
  usd: true,
  route: "direct",
  hideBalance: false,
  askExplorer: true,
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
  };
}
