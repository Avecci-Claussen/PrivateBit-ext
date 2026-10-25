import type { WalletState, CoinView, SessionView, DelayedView } from "../lib/wallet.ts";
import type { Prefs } from "../lib/prefs.ts";
import type { ActivityState } from "../lib/autolock.ts";
import type { HistoryEntry } from "../lib/history.ts";
import type { FeeRates } from "../lib/requests.ts";
import type { PlanPayload } from "../lib/send.ts";
import type { ChainConfig } from "../lib/network.ts";
import type { OneTimeRecord } from "../lib/onetime.ts";

export type Health = { state: "ok" | "rate-limited" | "offline" | "error"; since?: number; at: number; retryAt?: number };
export type PriceCache = { usd?: number; at?: number; fetchedAt?: number; failedAt?: number; source?: "coingecko" | "mexc"; asset?: string; error?: string };
export type LockInfo = { by: "auto" | "user"; minutes?: number; at: number };
export type Bundle = {
  state: WalletState;
  prefs: Prefs;
  health: Health | null;
  lockinfo: LockInfo | null;
  price: PriceCache | null;
  activity: ActivityState | null;
  waiting: boolean;
  delayed?: DelayedView[];
  /** Held payments on a chain that is not on screen: they keep their own time. */
  delayedElsewhere?: { net: "fractal" | "bitcoin"; count: number; next: number }[];
};
export type Fees = FeeRates & { fetchedAt: number };
export type { WalletState, CoinView, SessionView, HistoryEntry, PlanPayload, ChainConfig, OneTimeRecord, Prefs, DelayedView };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function call<T = unknown>(msg: Record<string, unknown> & { type: string }): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: T; error?: string; code?: string } | undefined;
  if (!r) throw new ApiError("PrivateBit did not answer. Close and open it again.");
  if (!r.ok) throw new ApiError(r.error ?? "error", r.code);
  return r.data as T;
}
