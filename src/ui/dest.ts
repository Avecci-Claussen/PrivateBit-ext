import * as btc from "@scure/btc-signer";
import { parseBip21 } from "../lib/bip21.ts";
import { decodeSilentAddress } from "../lib/bip352.ts";
import { FRACTAL } from "../lib/network.ts";

const NET: typeof btc.NETWORK = { bech32: FRACTAL.bech32, pubKeyHash: FRACTAL.pubKeyHash, scriptHash: FRACTAL.scriptHash, wif: FRACTAL.wif };

export type Dest =
  | { kind: "none" }
  | { kind: "sp"; address: string }
  | { kind: "paylink"; address: string; amount?: bigint; expiresAt?: number }
  | { kind: "notpb"; address: string; amount?: bigint }
  | { kind: "address"; address: string; amount?: bigint; type: string }
  | { kind: "error"; msg: string };

function addrType(a: string): string | null {
  try {
    const d = btc.Address(NET).decode(a);
    return d.type === "tr" ? "Taproot" : d.type === "wpkh" ? "SegWit" : d.type === "wsh" ? "SegWit script" : d.type === "pkh" ? "Legacy" : d.type === "sh" ? "Script" : d.type;
  } catch {
    return null;
  }
}

export function classify(input: string): Dest {
  const t = input.trim();
  if (!t) return { kind: "none" };
  let r;
  try {
    r = parseBip21(t);
  } catch {
    return { kind: "error", msg: "This payment link cannot be read. Copy it again from where you got it." };
  }
  const a = r.address;
  const low = a.toLowerCase();
  if (low.startsWith("tsp1")) return { kind: "error", msg: "This is a test network code. PrivateBit sends on mainnet only." };
  if (low.startsWith("sp1")) {
    try {
      const d = decodeSilentAddress(a);
      void d;
    } catch {
      return { kind: "error", msg: "This code has a typo: the checksum does not match. Copy it again from where you got it." };
    }
    if (r.pj) return { kind: "error", msg: "This link mixes a receive code with Payjoin. Ask the sender for a new payment link." };
    return { kind: "sp", address: a };
  }
  const type = addrType(a);
  if (!type) {
    if (/^(tb1|bcrt1|[mn2])/i.test(a)) return { kind: "error", msg: "This is a test network address. PrivateBit sends on mainnet only." };
    return { kind: "error", msg: "This is not a receive code, payment link or address PrivateBit can pay. Check you copied all of it." };
  }
  if (r.pj) {
    if (r.receiverKey && r.receiverKey.length === 33) return { kind: "paylink", address: a, amount: r.amount, expiresAt: r.sessionExpiresAt };
    return { kind: "notpb", address: a, amount: r.amount };
  }
  return { kind: "address", address: a, amount: r.amount, type };
}
