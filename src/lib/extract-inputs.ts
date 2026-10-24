import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import type { EligibleVin } from "./bip352.ts";
import { concatBytes, equalBytes, fromHex } from "./bytes.ts";

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/** BIP341 NUMS H: lift_x(sha256(uncompressed G)). Internal key that means "skip". */
function numsH(): Uint8Array {
  const G = secp256k1.ProjectivePoint.BASE.toRawBytes(false);
  const x = sha256(G);
  return x;
}

const NUMS_H = numsH();

export type RawVin = {
  txid: string;
  vout: number;
  scriptSig?: string;
  txinwitness?: string | string[] | Uint8Array[];
  prevout: { scriptPubKey: { hex: string } };
  private_key?: string;
};

function readCompactSize(buf: Uint8Array, i: number): { n: number; i: number } {
  if (i >= buf.length) throw new Error("compactSize");
  const b = buf[i];
  if (b < 0xfd) return { n: b, i: i + 1 };
  if (b === 0xfd) return { n: buf[i + 1] | (buf[i + 2] << 8), i: i + 3 };
  throw new Error("compactSize too large");
}

/** Bitcoin Core dumps txinwitness as a serialized witness, not a single stack item. */
function deserializeWitness(hexStr: string): Uint8Array[] {
  if (!hexStr) return [];
  const buf = fromHex(hexStr);
  try {
    const { n, i: start } = readCompactSize(buf, 0);
    let i = start;
    const stack: Uint8Array[] = [];
    for (let k = 0; k < n; k++) {
      const len = readCompactSize(buf, i);
      i = len.i;
      stack.push(buf.slice(i, i + len.n));
      i += len.n;
    }
    if (i === buf.length && n > 0) return stack;
  } catch {
    /* fall through: treat as a single stack item */
  }
  return [buf];
}

function witnessStack(w: string | string[] | Uint8Array[] | undefined): Uint8Array[] {
  if (!w) return [];
  if (Array.isArray(w)) {
    if (w.length === 0) return [];
    if (w[0] instanceof Uint8Array) return w as Uint8Array[];
    return (w as string[]).filter(Boolean).map((x) => fromHex(x));
  }
  return deserializeWitness(w);
}

function isCompressedPub(p: Uint8Array): boolean {
  return p.length === 33 && (p[0] === 0x02 || p[0] === 0x03);
}

function lastCompressedFromScriptSig(script: Uint8Array, spkHash: Uint8Array): Uint8Array | null {
  for (let i = script.length; i >= 33; i--) {
    const chunk = script.slice(i - 33, i);
    if (isCompressedPub(chunk) && hash160eq(chunk, spkHash)) return chunk;
  }
  return null;
}

function hash160eq(pub: Uint8Array, h20: Uint8Array): boolean {
  return equalBytes(hash160(pub), h20);
}

function skipSegwitVgt1(spk: Uint8Array): boolean {
  if (spk.length < 2) return false;
  const v = spk[0];
  if (v >= 0x52 && v <= 0x60 && spk[1] >= 2 && spk[1] <= 40) return true;
  return false;
}

function controlBlockInternalKey(witness: Uint8Array[]): Uint8Array | null {
  if (witness.length < 2) return null;
  const control = witness[witness.length - 1];
  if (control.length < 33) return null;
  return control.slice(1, 33);
}

/**
 * Eligible input pubs for BIP352 shared-secret derivation.
 * Returns null if the whole transaction must be skipped (SegWit v>1 input).
 */
export function extractEligibleVins(vins: RawVin[]): EligibleVin[] | null {
  const out: EligibleVin[] = [];
  for (const vin of vins) {
    const spk = fromHex(vin.prevout.scriptPubKey.hex);
    if (skipSegwitVgt1(spk)) return null;
    const wit = witnessStack(vin.txinwitness);
    if (wit.length > 1 && wit[wit.length - 1].length > 0 && wit[wit.length - 1][0] === 0x50) {
      wit.pop();
    }
    const scriptSig = vin.scriptSig ? fromHex(vin.scriptSig) : new Uint8Array();
    const secret = vin.private_key ? fromHex(vin.private_key) : undefined;

    // P2TR: 51 20 {32}
    if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20) {
      const internal = controlBlockInternalKey(wit);
      if (internal && equalBytes(internal, NUMS_H)) continue;
      const xonly = spk.slice(2);
      out.push({
        txid: vin.txid,
        vout: vin.vout,
        pubkey: concatBytes(new Uint8Array([0x02]), xonly),
        taproot: true,
        secret,
      });
      continue;
    }

    // P2WPKH: 00 14 {20}
    if (spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14) {
      const pub = wit[wit.length - 1];
      if (pub && isCompressedPub(pub) && hash160eq(pub, spk.slice(2))) {
        out.push({ txid: vin.txid, vout: vin.vout, pubkey: pub, taproot: false, secret });
      }
      continue;
    }

    // P2SH: a9 14 {20} 87 : nested P2WPKH redeem 00 14 {20}
    if (spk.length === 23 && spk[0] === 0xa9 && spk[1] === 0x14 && spk[22] === 0x87) {
      const redeem = scriptSig.length > 1 ? scriptSig.slice(1) : scriptSig;
      const nestedP2wpkh =
        redeem.length === 22 && redeem[0] === 0x00 && redeem[1] === 0x14
          ? redeem
          : scriptSig.length === 23 && scriptSig[0] === 0x16
            ? scriptSig.slice(1)
            : null;
      if (nestedP2wpkh) {
        const pub = wit[wit.length - 1];
        if (pub && isCompressedPub(pub) && hash160eq(pub, nestedP2wpkh.slice(2))) {
          out.push({ txid: vin.txid, vout: vin.vout, pubkey: pub, taproot: false, secret });
        }
      }
      continue;
    }

    // P2PKH: 76 a9 14 {20} 88 ac
    if (
      spk.length === 25 &&
      spk[0] === 0x76 &&
      spk[1] === 0xa9 &&
      spk[2] === 0x14 &&
      spk[23] === 0x88 &&
      spk[24] === 0xac
    ) {
      const pub = lastCompressedFromScriptSig(scriptSig, spk.slice(3, 23));
      if (pub) {
        out.push({ txid: vin.txid, vout: vin.vout, pubkey: pub, taproot: false, secret });
      }
    }
  }
  return out;
}
