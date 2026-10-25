import { netInfo } from "../lib/network.ts";
import { curNet } from "./kit.ts";
import { S } from "./app.ts";
import { PRICE_STALE_MS } from "../lib/requests.ts";
import { usd as usdFmt } from "./kit.ts";

export function scanning(): {
  on: boolean;
  pct: number;
  at: number;
  tip: number;
  from: number;
  reading?: { height: number; index: number; count: number };
} {
  const st = S.b?.state;
  const tip = st?.tip ?? 0;
  const at = st?.lastHeight ?? 0;
  const from = st?.birthday ?? at;
  const reading = st?.reading;
  if (!st?.unlocked || !tip || at >= tip) return { on: false, pct: 100, at, tip, from };
  const span = Math.max(1, tip - from);
  const pct = Math.max(0, Math.min(99, Math.floor(((at - from) / span) * 100)));
  // A few blocks behind is normal following, not a scan.
  return { on: tip - at > 3, pct, at, tip, from, reading };
}

export function health(): "ok" | "rate-limited" | "offline" {
  const h = S.b?.health;
  if (!h || h.state === "ok" || h.state === "error") return "ok";
  return h.state;
}

export function status(): string {
  if (S.b?.state.payjoin) return "payjoin";
  const h = health();
  if (h === "offline") return "offline";
  if (h === "rate-limited") return "limited";
  if (scanning().on) return "scan";
  return "private";
}

/** price: number when usable, plus whether it is stale, or "off" / "na". */
export function price(): { kind: "ok" | "stale" | "na" | "off"; usd?: number; at?: number } {
  const b = S.b;
  if (!b || b.prefs.usd === false) return { kind: "off" };
  const p = b.price;
  if (!p?.usd || !p.fetchedAt) return { kind: "na" };
  // A price for the other chain's coin is never shown.
  const asset = netInfo(curNet()).price;
  if (p.asset && p.asset !== asset.coingecko && p.asset !== asset.mexc) return { kind: "na" };
  if (Date.now() - p.fetchedAt > PRICE_STALE_MS) return { kind: "stale", usd: p.usd, at: p.fetchedAt };
  return { kind: "ok", usd: p.usd, at: p.fetchedAt };
}

export function usd(sats: bigint | string | number, o: { approx?: boolean } = {}): string {
  const p = price();
  if (p.kind === "off" || p.kind === "na") return "";
  return usdFmt(sats, p.usd, o);
}

export const hidden = (): boolean => S.f.hideBal === true;

/** One line about how far the wallet has looked. Never claims "up to date" without a known tip. */
/** Seconds until the block download tries again, when it is waiting after a failure. */
export function retryIn(now = Date.now()): number | undefined {
  const r = S.b?.health?.retryAt;
  if (!r || r <= now) return undefined;
  return Math.max(1, Math.ceil((r - now) / 1000));
}

export function retryText(secs: number): string {
  return secs >= 90 ? `retrying in ${Math.round(secs / 60)} min` : `retrying in ${secs} s`;
}

export function syncLine(): string {
  const st = S.b?.state;
  const sc = scanning();
  const at = st?.lastHeight ?? 0;
  const checked = !!st && at >= (st.birthday ?? 0);
  const h = health();
  const wait = retryIn();
  if (wait && (sc.on || (S.b?.health?.state ?? "ok") !== "ok"))
    return sc.on
      ? `Waiting for the data service, ${retryText(wait)}. Block ${at.toLocaleString("en-US")} of ${sc.tip.toLocaleString("en-US")}`
      : `Waiting for the data service, ${retryText(wait)}. Last checked block ${at.toLocaleString("en-US")}`;
  if (sc.on) return `Downloading blocks, ${at.toLocaleString("en-US")} of ${sc.tip.toLocaleString("en-US")}`;
  if (!st?.tip) {
    if (h !== "ok") return checked ? `Last checked block ${at.toLocaleString("en-US")}` : "Waiting for block data";
    return "Checking for new blocks\u2026";
  }
  if (h !== "ok") return `Last checked block ${at.toLocaleString("en-US")}`;
  return `Up to date, block ${at.toLocaleString("en-US")}`;
}
