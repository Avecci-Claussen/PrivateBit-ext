import { decodeSilentAddress } from "./bip352.ts";
import { parseFragment, pjQueryValue, splitMailbox, type Bip77Fragment } from "./bip77-uri.ts";

export type PaymentRequest = {
  raw: string;
  address: string;
  amount?: bigint;
  label?: string;
  message?: string;
  pj?: string;
  pjos?: boolean;
  silent: boolean;
  /** BIP77 RK from the pj= fragment. Required for HPKE Payjoin. */
  receiverKey?: Uint8Array;
  ohttp?: Bip77Fragment["ohttp"];
  sessionExpiresAt?: number;
};

export function parseBip21(input: string): PaymentRequest {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  let rest = trimmed;
  if (lower.startsWith("bitcoin:")) rest = trimmed.slice("bitcoin:".length);
  else if (lower.startsWith("fractal:")) rest = trimmed.slice("fractal:".length);

  const q = rest.indexOf("?");
  const address = q >= 0 ? rest.slice(0, q) : rest;
  const query = q >= 0 ? new URLSearchParams(rest.slice(q + 1)) : new URLSearchParams();
  const amountStr = query.get("amount");
  let amount: bigint | undefined;
  if (amountStr) {
    // Audit L7 (independent): no silent rounding. More than 8 decimals is refused.
    if (!/^\d*(\.\d{0,8})?$/.test(amountStr) || amountStr === "." || amountStr === "") throw new Error("The amount in this link is not a valid amount (at most 8 decimals).");
    const [w, f = ""] = amountStr.split(".");
    const frac = (f + "00000000").slice(0, 8);
    amount = BigInt(w || "0") * 100_000_000n + BigInt(frac);
  }
  if (/^(tsp1|tb1|bcrt1)/i.test(address)) throw new Error("This code is for a test network, not this chain.");
  let silent = false;
  try {
    decodeSilentAddress(address);
    silent = true;
  } catch {
    silent = address.toLowerCase().startsWith("sp1") || address.toLowerCase().startsWith("tsp1");
  }
  const pjos = query.get("pjos");
  const pj = query.get("pj") ?? undefined;
  let receiverKey: Uint8Array | undefined;
  let ohttp: Bip77Fragment["ohttp"];
  let sessionExpiresAt: number | undefined;
  if (pj) {
    const { fragment } = splitMailbox(pj);
    if (fragment) {
      const f = parseFragment(fragment);
      receiverKey = f.receiverKeyCompressed;
      ohttp = f.ohttp;
      sessionExpiresAt = f.expiresAt;
    }
  }
  return {
    raw: trimmed,
    address,
    amount,
    label: query.get("label") ?? undefined,
    message: query.get("message") ?? undefined,
    pj,
    pjos: pjos === null ? undefined : pjos !== "0",
    silent,
    receiverKey,
    ohttp,
    sessionExpiresAt,
  };
}

export function isSilentAddress(addr: string): boolean {
  try {
    decodeSilentAddress(addr);
    return true;
  } catch {
    return false;
  }
}

export function satsToBtcAmount(sats: bigint): string {
  const whole = sats / 100_000_000n;
  const frac = (sats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * BIP21. `pj` last. `pjos=0` on an unsecured directory (BIP77).
 * `pj` is uppercased per BIP77.
 */
export function encodeBip21(args: { address: string; amount?: bigint; pj?: string; pjos?: boolean }): string {
  const q: string[] = [];
  if (args.amount !== undefined && args.amount > 0n) {
    q.push(`amount=${satsToBtcAmount(args.amount)}`);
  }
  if (args.pjos === false) q.push("pjos=0");
  if (args.pj) q.push(`pj=${pjQueryValue(args.pj)}`);
  return q.length ? `bitcoin:${args.address}?${q.join("&")}` : `bitcoin:${args.address}`;
}
