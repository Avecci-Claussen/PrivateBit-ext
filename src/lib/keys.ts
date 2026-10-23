import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1";
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
};

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
  };
}
