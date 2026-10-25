import { HDKey } from "@scure/bip32";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import * as btc from "@scure/btc-signer";
import { fromHex, hex } from "./bytes.ts";
import { ser256, scalar } from "./schnorr-util.ts";
import {
  encodeSilentAddress,
  labeledSpendPub,
  precomputeLabels,
  type LabelBook,
} from "./bip352.ts";
import { derivationPath, FRACTAL, type NetworkId } from "./network.ts";
import type { UnlockedVault } from "./vault.ts";

export type Account = {
  spendSecret: Uint8Array;
  scanSecret: Uint8Array;
  spendPub: Uint8Array;
  scanPub: Uint8Array;
  receive: string;
  changeSpendPub: Uint8Array;
  labels: LabelBook;
  birthday: number;
  /** Migration one-time address at m/86'/8228'/0'/0/index. Not linked to the sp1 code. */
  oneTime: (index: number) => OneTimeKey;
  /** A connected website's own account at m/86'/coin'/index'/0/0 (sites.ts). */
  site?: (index: number) => OneTimeKey;
};

/**
 * What block matching needs and nothing more. This is what stays in memory after Lock:
 * it can recognize incoming payments but cannot spend, sign or show the recovery words.
 */
export type ScanAccount = Pick<Account, "scanSecret" | "spendPub" | "labels">;

export function scanAccountFrom(scanSecret: Uint8Array, spendPub: Uint8Array): ScanAccount {
  return { scanSecret, spendPub, labels: precomputeLabels(scanSecret, []) };
}

/** BIP86 key-path Taproot under the Fractal coin type. Never m/86'/0'/..., which other wallets use. */
export const ONE_TIME_ACCOUNT_PATH = `m/86'/${FRACTAL.coinType}'/0'/0`;
export const ONE_TIME_PATH_LABEL = "m/86'/8228'/0'/0/i";
export const ONE_TIME_RESTORE_WINDOW = 5;

export type OneTimeKey = {
  index: number;
  path: string;
  /** x-only internal key P. */
  internal: Uint8Array;
  /** x-only output key Q = P + H_TapTweak(x(P))G. */
  output: Uint8Array;
  scriptPubKey: string;
  address: string;
  /** Private key for Q with even Y, ready for BIP340 signing and BIP352 input hashing. */
  secret: Uint8Array;
  /** Untweaked private key and its compressed public key (message signing, getPublicKey). */
  internalSecret?: Uint8Array;
  internalPub?: Uint8Array;
};

const N = secp256k1.CURVE.n;

/**
 * Bitcoin one-time addresses use account 352' under m/86'/0', so they never overlap with the
 * ordinary m/86'/0'/0' account another wallet would show for the same words.
 */
export const ONE_TIME_ACCOUNT_PATH_BITCOIN = "m/86'/0'/352'/0";

export function oneTimeKeyFromHd(hd: HDKey, index: number, net: NetworkId = "fractal"): OneTimeKey {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error("bad one-time index");
  const path = `${net === "bitcoin" ? ONE_TIME_ACCOUNT_PATH_BITCOIN : ONE_TIME_ACCOUNT_PATH}/${index}`;
  return taprootKeyAt(hd, path, index);
}

/** BIP86 key path key at any path. Same math as the one-time address. */
export function taprootKeyAt(hd: HDKey, path: string, index: number): OneTimeKey {
  const node = hd.derive(path);
  if (!node.privateKey) throw new Error("one-time derive failed");
  const d0 = node.privateKey;
  const pub = secp256k1.getPublicKey(d0, true);
  const internal = pub.slice(1);
  const d = pub[0] === 0x03 ? N - scalar(d0) : scalar(d0);
  const t = scalar(schnorr.utils.taggedHash("TapTweak", internal));
  if (t >= N) throw new Error("tap tweak out of range");
  let q = (d + t) % N;
  const qPub = secp256k1.getPublicKey(ser256(q), true);
  if (qPub[0] === 0x03) q = N - q;
  const secret = ser256(q);
  const output = qPub.slice(1);
  // Fractal and Bitcoin use the same address prefixes.
  const addrNet: typeof btc.NETWORK = {
    bech32: FRACTAL.bech32,
    pubKeyHash: FRACTAL.pubKeyHash,
    scriptHash: FRACTAL.scriptHash,
    wif: FRACTAL.wif,
  };
  const address = btc.Address(addrNet).encode({ type: "tr", pubkey: output });
  return { index, path, internal, output, scriptPubKey: "5120" + hex(output), address, secret, internalSecret: d0, internalPub: pub };
}

export function oneTimeKey(seed: Uint8Array, index: number, net: NetworkId = "fractal"): OneTimeKey {
  return oneTimeKeyFromHd(HDKey.fromMasterSeed(seed), index, net);
}

const TAPROOT_NET: typeof btc.NETWORK = {
  bech32: FRACTAL.bech32,
  pubKeyHash: FRACTAL.pubKeyHash,
  scriptHash: FRACTAL.scriptHash,
  wif: FRACTAL.wif,
};

/** bc1p from a 34-byte P2TR script. Used to ask the indexer for a watched one-time address. */
export function p2trAddressFromScriptHex(scriptPubKey: string): string | null {
  if (!/^5120[0-9a-fA-F]{64}$/i.test(scriptPubKey)) return null;
  try {
    return btc.Address(TAPROOT_NET).encode({ type: "tr", pubkey: fromHex(scriptPubKey.slice(4)) });
  } catch {
    return null;
  }
}

/** A website's own account: m/86'/coin'/index'/0/0, index from sites.ts siteIndex (2^30 and up). */
export function sitePath(index: number, net: NetworkId): string {
  if (!Number.isInteger(index) || index < 0x40000000 || index >= 0x80000000) throw new Error("bad site index");
  return `m/86'/${net === "bitcoin" ? 0 : FRACTAL.coinType}'/${index}'/0/0`;
}
export function siteKeyFromHd(hd: HDKey, index: number, net: NetworkId): OneTimeKey {
  return taprootKeyAt(hd, sitePath(index, net), index);
}

export function accountFromVault(vault: Pick<UnlockedVault, "seed" | "birthday">, extraLabels = 0, net: NetworkId = "fractal"): Account {
  const hd = HDKey.fromMasterSeed(vault.seed);
  const paths = derivationPath(0, net);
  const spendNode = hd.derive(paths.spend);
  const scanNode = hd.derive(paths.scan);
  if (!spendNode.privateKey || !scanNode.privateKey) {
    throw new Error("hardened derive failed");
  }
  const spendSecret = spendNode.privateKey;
  const scanSecret = scanNode.privateKey;
  const spendPub = secp256k1.getPublicKey(spendSecret, true);
  const scanPub = secp256k1.getPublicKey(scanSecret, true);
  const receive = encodeSilentAddress(scanPub, spendPub, FRACTAL.spHrp);
  const changeSpendPub = labeledSpendPub(spendPub, scanSecret, 0);
  const extra: number[] = [];
  for (let m = 1; m <= extraLabels; m++) extra.push(m);
  const labels = precomputeLabels(scanSecret, extra);
  return {
    spendSecret,
    scanSecret,
    spendPub,
    scanPub,
    receive,
    changeSpendPub,
    labels,
    birthday: vault.birthday,
    oneTime: (index: number) => oneTimeKeyFromHd(hd, index, net),
    site: (index: number) => siteKeyFromHd(hd, index, net),
  };
}
