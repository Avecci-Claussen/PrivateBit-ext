import { S } from "./app.ts";
import { PRICE_STALE_MS } from "../lib/requests.ts";
import { usd as usdFmt } from "./kit.ts";

export function scanning(): { on: boolean; pct: number; at: number; tip: number; from: number } {
  const st = S.b?.state;
  const tip = st?.tip ?? 0;
  const at = st?.lastHeight ?? 0;
  const from = st?.birthday ?? at;
  if (!st?.unlocked || !tip || at >= tip) return { on: false, pct: 100, at, tip, from };
  const span = Math.max(1, tip - from);
  const pct = Math.max(0, Math.min(99, Math.floor(((at - from) / span) * 100)));
  // A few blocks behind is normal following, not a scan.
  return { on: tip - at > 3, pct, at, tip, from };
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
  if (!p?.usd || !p.fetchedAt) return { kind: p?.failedAt ? "na" : "na" };
  if (Date.now() - p.fetchedAt > PRICE_STALE_MS) return { kind: "stale", usd: p.usd, at: p.fetchedAt };
  return { kind: "ok", usd: p.usd, at: p.fetchedAt };
}

export function usd(sats: bigint | string | number, o: { approx?: boolean } = {}): string {
  const p = price();
  if (p.kind === "off" || p.kind === "na") return "";
  return usdFmt(sats, p.usd, o);
}

export const hidden = (): boolean => S.f.hideBal === true;
