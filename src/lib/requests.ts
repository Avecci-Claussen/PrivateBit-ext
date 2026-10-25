/**
 * The one module that sends price and fee requests (DATA.md section 7).
 * Every price and fee call goes through fetchVia(route, url), so a proxy route can be
 * added later by rewriting the URL here without touching any caller.
 * Nothing in these requests carries wallet data: no amounts, addresses or codes.
 */
export type RequestRoute = { route: "direct" } | { route: "proxy"; base: string };

export const DIRECT: RequestRoute = { route: "direct" };

export const PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=fractal-bitcoin&vs_currencies=usd&include_last_updated_at=true";
export const PRICE_HOST = "api.coingecko.com";

/** Price older than this shows as stale. */
export const PRICE_STALE_MS = 30 * 60 * 1000;
/** Refresh period while unlocked. */
export const PRICE_PERIOD_MIN = 10;
/** Fee rates older than this show their time in amber. */
export const FEE_STALE_MS = 10 * 60 * 1000;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function routeUrl(route: RequestRoute, url: string): string {
  if (route.route === "direct") return url;
  const base = route.base.replace(/\/$/, "");
  return `${base}/${encodeURIComponent(url)}`;
}

export class RateLimitedError extends Error {
  constructor(message = "rate limited") {
    super(message);
    this.name = "RateLimitedError";
  }
}

export async function fetchVia(
  route: RequestRoute,
  url: string,
  init: RequestInit = {},
  fetcher: Fetcher = (u, i) => netFetchLazy(u, i),
): Promise<Response> {
  const res = await fetcher(routeUrl(route, url), { ...init, credentials: "omit", referrerPolicy: "no-referrer" });
  if (res.status === 429) throw new RateLimitedError();
  return res;
}

export type Price = { usd: number; at: number; fetchedAt: number };

export function parsePrice(body: unknown, now = Date.now()): Price {
  const fb = (body as { "fractal-bitcoin"?: { usd?: unknown; last_updated_at?: unknown } })?.["fractal-bitcoin"];
  const usd = fb?.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) throw new Error("price missing");
  const at = typeof fb?.last_updated_at === "number" ? fb.last_updated_at * 1000 : now;
  return { usd, at, fetchedAt: now };
}

export type PriceSource = "coingecko" | "mexc";
export type PricePref = PriceSource | "off";
export const PRICE_SOURCES: PricePref[] = ["coingecko", "mexc", "off"];
export const PRICE_HOSTS: Record<PriceSource, string> = { coingecko: "api.coingecko.com", mexc: "api.mexc.com" };
export type PricedAsset = { coingecko: string; mexc: string };
export type SourcedPrice = Price & { source: PriceSource; asset: string };

export function coingeckoUrl(id: string): string {
  return `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_last_updated_at=true`;
}
export function mexcUrl(symbol: string): string {
  return `https://api.mexc.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
}

/** CoinGecko answers `{ "<id>": { usd, last_updated_at } }`; an unknown id is `{}`. */
export function parseCoingecko(body: unknown, id: string, now = Date.now()): Price {
  const row = (body as Record<string, { usd?: unknown; last_updated_at?: unknown }> | null)?.[id];
  const usd = row?.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) throw new Error(`CoinGecko has no USD price for ${id}`);
  const at = typeof row?.last_updated_at === "number" ? row.last_updated_at * 1000 : now;
  return { usd, at, fetchedAt: now };
}

/** MEXC answers `{ symbol, price: "0.38" }` (USDT, read as USD); errors are `{ code, msg }`. */
export function parseMexc(body: unknown, symbol: string, now = Date.now()): Price {
  const b = body as { symbol?: unknown; price?: unknown; msg?: unknown } | null;
  if (!b || b.symbol !== symbol) throw new Error(`MEXC has no price for ${symbol}${typeof b?.msg === "string" ? `: ${b.msg}` : ""}`);
  const usd = Number(b.price);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`MEXC price for ${symbol} is not a number`);
  return { usd, at: now, fetchedAt: now };
}

async function priceFrom(source: PriceSource, asset: PricedAsset, fetcher?: Fetcher): Promise<SourcedPrice> {
  const url = source === "coingecko" ? coingeckoUrl(asset.coingecko) : mexcUrl(asset.mexc);
  const res = await fetchVia(DIRECT, url, { headers: { accept: "application/json" } }, fetcher);
  if (!res.ok) throw new Error(`${source === "coingecko" ? "CoinGecko" : "MEXC"} answered ${res.status}`);
  const body = await res.json();
  const p = source === "coingecko" ? parseCoingecko(body, asset.coingecko) : parseMexc(body, asset.mexc);
  return { ...p, source, asset: source === "coingecko" ? asset.coingecko : asset.mexc };
}

/** The chosen source first; if it fails, the other one. Both failing throws the first error. */
export async function getPriceWithFallback(pref: PriceSource, asset: PricedAsset, fetcher?: Fetcher): Promise<SourcedPrice> {
  const order: PriceSource[] = pref === "mexc" ? ["mexc", "coingecko"] : ["coingecko", "mexc"];
  let first: unknown;
  for (const s of order) {
    try {
      return await priceFrom(s, asset, fetcher);
    } catch (e) {
      first ??= e;
    }
  }
  throw first instanceof Error ? first : new Error("price unavailable");
}

export async function getPrice(route: RequestRoute = DIRECT, fetcher?: Fetcher): Promise<Price> {
  const res = await fetchVia(route, PRICE_URL, { headers: { accept: "application/json" } }, fetcher);
  if (!res.ok) throw new Error(`price ${res.status}`);
  return parsePrice(await res.json());
}

export function priceIsStale(p: Pick<Price, "at" | "fetchedAt"> | null | undefined, now = Date.now()): boolean {
  if (!p) return true;
  return now - p.fetchedAt > PRICE_STALE_MS;
}

export type FeeRates = {
  fast: number;
  normal: number;
  slow: number;
  minimum: number;
  /** ms since epoch, when the service says it computed the rates. */
  updatedAt?: number;
  source: "service" | "node" | "fallback";
  /** Confirmation targets in blocks (node only). */
  targets?: { fast: number; normal: number; slow: number };
};

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
  return undefined;
}

function timeMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  return undefined;
}

/**
 * Block data service GET /v1/indexer/fees/recommended:
 * { fastestFee, halfHourFee, hourFee, economyFee, minimumFee, updateTime } in sat/vB.
 * Fast = fastestFee, Normal = halfHourFee, Slow = economyFee (hourFee is not shown).
 */
export function parseRecommendedFees(data: unknown): FeeRates {
  const d = (data ?? {}) as Record<string, unknown>;
  const fastest = num(d.fastestFee);
  const half = num(d.halfHourFee);
  const hour = num(d.hourFee);
  const economy = num(d.economyFee);
  const minimum = num(d.minimumFee);
  const normal = half ?? hour ?? fastest ?? economy;
  if (normal === undefined) throw new Error("fee rates missing");
  const fast = Math.max(fastest ?? normal, normal);
  const slow = Math.min(economy ?? hour ?? normal, normal);
  const min = Math.min(minimum ?? 1, slow);
  return { fast, normal, slow, minimum: min, updatedAt: timeMs(d.updateTime), source: "service" };
}

export type FeeCheck = { ok: true } | { ok: false; reason: "invalid" | "too-low" | "too-high" };

/** Custom rate guard: below the service minimum blocks Review (31d). */
export function checkCustomFee(rate: number, minimum: number, fast: number): FeeCheck {
  if (!Number.isFinite(rate) || rate <= 0) return { ok: false, reason: "invalid" };
  if (rate < minimum) return { ok: false, reason: "too-low" };
  if (rate > Math.max(1000, fast * 50)) return { ok: false, reason: "too-high" };
  return { ok: true };
}

/** Loaded lazily to keep requests.ts free of an import cycle with net.ts. */
async function netFetchLazy(url: string, init?: RequestInit): Promise<Response> {
  const { netFetch } = await import("./net.ts");
  return netFetch(url, init);
}
