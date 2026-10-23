import { HDKey } from "@scure/bip32";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import * as btc from "@scure/btc-signer";
import { hex } from "./bytes.ts";
import { ser256, scalar } from "./schnorr-util.ts";
import {
  encodeSilentAddress,
  labeledSpendPub,
  precomputeLabels,
  type LabelBook,
} from "./bip352.ts";
import { derivationPath, FRACTAL } from "./network.ts";
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
};

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
};

const N = secp256k1.CURVE.n;

export function oneTimeKeyFromHd(hd: HDKey, index: number): OneTimeKey {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error("bad one-time index");
  const path = `${ONE_TIME_ACCOUNT_PATH}/${index}`;
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
  const net: typeof btc.NETWORK = {
    bech32: FRACTAL.bech32,
    pubKeyHash: FRACTAL.pubKeyHash,
    scriptHash: FRACTAL.scriptHash,
    wif: FRACTAL.wif,
  };
  const address = btc.Address(net).encode({ type: "tr", pubkey: output });
  return { index, path, internal, output, scriptPubKey: "5120" + hex(output), address, secret };
}

export function oneTimeKey(seed: Uint8Array, index: number): OneTimeKey {
  return oneTimeKeyFromHd(HDKey.fromMasterSeed(seed), index);
}

export function accountFromVault(vault: UnlockedVault, extraLabels = 0): Account {
  const hd = HDKey.fromMasterSeed(vault.seed);
  const paths = derivationPath(0);
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
    oneTime: (index: number) => oneTimeKeyFromHd(hd, index),
  };
}
