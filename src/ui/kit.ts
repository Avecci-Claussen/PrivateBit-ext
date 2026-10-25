/**
 * Tiny HTML kit. Every interpolated value is escaped unless it is already a Safe fragment,
 * so wallet data (labels, codes, errors from servers) can never inject markup.
 */
import { ICONS } from "./icons.ts";
import MP from "./mark-paths.json";

export class Safe {
  constructor(readonly s: string) {}
  toString(): string {
    return this.s;
  }
}

export function esc(v: unknown): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Part = Safe | string | number | bigint | boolean | null | undefined | Part[];

function part(v: Part): string {
  if (v === null || v === undefined || v === false || v === true) return "";
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...vals: Part[]): Safe {
  let out = strings[0]!;
  for (let i = 0; i < vals.length; i++) out += part(vals[i]!) + strings[i + 1]!;
  return new Safe(out);
}

export const raw = (s: string): Safe => new Safe(s);
export const join = (xs: Part[]): Safe => new Safe(xs.map(part).join(""));

export function I(name: string, cls = ""): Safe {
  const inner = ICONS[name] ?? "";
  return new Safe(
    `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`,
  );
}

const MARKP = MP as { STEM: string; UP: string; LO: string };
export function MARK(sz = 24, label = true, cls = "mark"): Safe {
  return new Safe(
    `<svg class="${cls}" width="${sz}" height="${sz}" viewBox="0 0 64 64" ${label ? 'role="img" aria-label="PrivateBit"' : 'aria-hidden="true"'}><path class="mk-n" d="${MARKP.STEM}"/><path class="mk-v" d="${MARKP.UP}"/><path class="mk-o" d="${MARKP.LO}"/></svg>`,
  );
}

/** The chain on screen, set from each bundle. Every unit and chain name reads it. */
export type UiNet = "fractal" | "bitcoin";
let uiNet: UiNet = "fractal";
export function setUiNet(n: string | undefined): void {
  uiNet = n === "bitcoin" ? "bitcoin" : "fractal";
}
export function curNet(): UiNet {
  return uiNet;
}
export function UNIT(): string {
  return uiNet === "bitcoin" ? "BTC" : "FB";
}
export function CHAIN(): string {
  return uiNet === "bitcoin" ? "Bitcoin" : "Fractal Bitcoin";
}
export function CHAIN_SHORT(): string {
  return uiNet === "bitcoin" ? "Bitcoin" : "Fractal";
}
export function blockTimeText(): string {
  return uiNet === "bitcoin" ? "Bitcoin makes a block about every 10 minutes." : "Fractal makes a block about every 30 seconds.";
}
export function explorerHost(net: UiNet = uiNet): string {
  return net === "bitcoin" ? "mempool.space" : "mempool.fractalbitcoin.io";
}
export function txLink(txid: string, net: UiNet = uiNet): string {
  return net === "bitcoin" ? `https://mempool.space/tx/${txid}` : `https://mempool.fractalbitcoin.io/tx/${txid}`;
}

export function NETLOGO(which: "fractal" | "btc" | "bitcoin" | "current" = "current", cls = ""): Safe {
  const net = which === "current" ? (uiNet === "bitcoin" ? "btc" : "fractal") : which === "bitcoin" ? "btc" : which;
  return new Safe(
    `<img class="nlogo ${net === "btc" ? "btc" : "fb"} ${cls}" src="img/${net === "btc" ? "bitcoin" : "fractal"}.svg" alt="" width="18" height="18">`,
  );
}

export function ntag(text = CHAIN_SHORT()): Safe {
  return html`<span class="ntag">${NETLOGO()}${text}</span>`;
}

/* ---------- formatting ---------- */

const NBSP = "\u00a0";

/** sats (bigint|string|number) to an FB string. Trims trailing zeros unless dp is fixed. */
export function fb(v: bigint | string | number, o: { dp?: number; unit?: boolean; trim?: boolean; sign?: boolean } = {}): string {
  let n = BigInt(v);
  const neg = n < 0n;
  if (neg) n = -n;
  const whole = n / 100_000_000n;
  let frac = (n % 100_000_000n).toString().padStart(8, "0");
  const dp = o.dp ?? 8;
  frac = frac.slice(0, dp);
  if (o.trim) frac = frac.replace(/0+$/, "");
  const w = whole.toLocaleString("en-US");
  const sign = neg ? "\u2212" : o.sign && n > 0n ? "+" : "";
  return `${sign}${w}${frac ? "." + frac : ""}${o.unit === false ? "" : NBSP + UNIT()}`;
}

/** Short form for lists: up to 4 decimals but never hides a non-zero amount. */
export function fbShort(v: bigint | string | number, o: { unit?: boolean; sign?: boolean } = {}): string {
  const n = BigInt(v);
  const a = n < 0n ? -n : n;
  if (a !== 0n && a < 10_000n) return fb(n, { ...o, trim: true });
  return fb(n, { ...o, dp: 4, trim: true });
}

export function sats(v: bigint | string | number): string {
  return `${BigInt(v).toLocaleString("en-US")}${NBSP}sats`;
}

/** Parse a user FB amount like "0.04" into sats. Returns null when invalid. */
export function parseFb(s: string): bigint | null {
  const t = s.trim().replace(/,/g, "");
  if (!/^\d*(\.\d{0,8})?$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  return BigInt(w || "0") * 100_000_000n + BigInt((f + "00000000").slice(0, 8));
}

export function usd(satsV: bigint | string | number, price: number | undefined, o: { approx?: boolean } = {}): string {
  if (!price) return "";
  const v = (Math.abs(Number(BigInt(satsV))) / 1e8) * price;
  if (v > 0 && v < 0.01) return `<${NBSP}$0.01`;
  const s = v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${o.approx === false ? "" : "\u2248" + NBSP}$${s}`;
}

export const mid = (s: string, a = 10, b = 6): string => (s.length <= a + b + 1 ? s : `${s.slice(0, a)}\u2026${s.slice(-b)}`);

/** Full code in groups of four with the head and tail emphasised for checking. */
export function codeHi(s: string, a = 8, b = 8): Safe {
  const g = s.match(/.{1,4}/g) ?? [];
  return join(g.map((x, i) => html`<span class="g${i < a / 4 || i >= g.length - b / 4 ? " hl" : ""}">${x}</span>`));
}

export const num = (n: number): string => n.toLocaleString("en-US");

const DAY = 86_400_000;
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
export function hm(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
export function dayLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  if (sameDay(d, new Date(now))) return "Today";
  if (sameDay(d, new Date(now - DAY))) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}
export function when(ms: number, now = Date.now()): string {
  return `${dayLabel(ms, now)}, ${hm(ms)}`;
}
export function longDate(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}, ${hm(ms)}`;
}
export function left(ms: number): string {
  if (ms <= 0) return "0 min";
  const m = Math.ceil(ms / 60_000);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}
