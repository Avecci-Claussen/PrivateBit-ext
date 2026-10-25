/**
 * Every network request of the wallet goes through netFetch:
 * - a timeout on every call (default 15 s), plus an optional caller signal (scan cancel);
 * - per host: a small gap between requests and a cap on parallel ones, so a scan cannot
 *   burst a public service into rate limiting;
 * - per host cool-down after a rate-limit answer, growing exponentially with jitter, so
 *   nothing hammers a service that already said stop. While cooling, calls fail fast.
 */
import { RateLimitedError } from "./requests.ts";

type Limit = { gapMs: number; parallel: number };

const LIMITS: Record<string, Limit> = {
  "open-api-fractal.unisat.io": { gapMs: 200, parallel: 4 },
  "mempool.fractalbitcoin.io": { gapMs: 50, parallel: 6 },
  "mempool.space": { gapMs: 120, parallel: 4 },
  "api.mexc.com": { gapMs: 1000, parallel: 1 },
  "api.coingecko.com": { gapMs: 1000, parallel: 1 },
};
const DEFAULT_LIMIT: Limit = { gapMs: 0, parallel: 6 };

type HostState = { nextAt: number; active: number; waiters: (() => void)[]; coolUntil: number; strikes: number };
const hosts = new Map<string, HostState>();

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Equal-jitter exponential backoff: half fixed, half random. attempt 0 -> base/2..base. */
export function backoffMs(attempt: number, baseMs = 2_000, capMs = 5 * 60_000, rand: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + rand() * (exp / 2));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

function state(host: string): HostState {
  let s = hosts.get(host);
  if (!s) {
    s = { nextAt: 0, active: 0, waiters: [], coolUntil: 0, strikes: 0 };
    hosts.set(host, s);
  }
  return s;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function acquire(host: string, signal?: AbortSignal): Promise<void> {
  const s = state(host);
  const lim = LIMITS[host] ?? DEFAULT_LIMIT;
  while (s.active >= lim.parallel) {
    await new Promise<void>((r) => s.waiters.push(r));
    signal?.throwIfAborted();
  }
  s.active += 1;
  const wait = s.nextAt - Date.now();
  s.nextAt = Math.max(Date.now(), s.nextAt) + lim.gapMs;
  if (wait > 0) await sleep(wait);
}

function release(host: string): void {
  const s = state(host);
  s.active = Math.max(0, s.active - 1);
  s.waiters.shift()?.();
}

/** Mark a host as rate limiting us (also used when a service says so in a 200 or 403 body). */
export function noteRateLimited(url: string): void {
  const s = state(hostOf(url));
  s.coolUntil = Date.now() + backoffMs(s.strikes, 5_000);
  s.strikes += 1;
}

export function coolingDown(url: string): boolean {
  return Date.now() < state(hostOf(url)).coolUntil;
}

export type NetOptions = { timeoutMs?: number; signal?: AbortSignal };

function combine(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any([a, b]);
  const c = new AbortController();
  const stop = () => c.abort();
  a.addEventListener("abort", stop, { once: true });
  b.addEventListener("abort", stop, { once: true });
  return c.signal;
}

export async function netFetch(url: string, init: RequestInit = {}, opts: NetOptions = {}): Promise<Response> {
  const host = hostOf(url);
  const s = state(host);
  if (Date.now() < s.coolUntil) throw new RateLimitedError(`${host} asked us to slow down; waiting`);
  opts.signal?.throwIfAborted();
  await acquire(host, opts.signal);
  try {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = combine(AbortSignal.timeout(timeoutMs), opts.signal ?? (init.signal as AbortSignal | undefined) ?? undefined);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? e;
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new Error(`${host} timed out after ${timeoutMs} ms`);
      throw e;
    }
    if (res.status === 429 || res.status === 503) {
      noteRateLimited(url);
      throw new RateLimitedError(`${host} ${res.status}`);
    }
    if (res.ok) s.strikes = 0;
    return res;
  } finally {
    release(host);
  }
}

/** Tests start every case with fresh host state. */
export function resetNetForTests(): void {
  hosts.clear();
}

/** Tests can make the per-host gaps zero. */
export function setHostLimitForTests(host: string, limit: Limit): void {
  LIMITS[host] = limit;
}
