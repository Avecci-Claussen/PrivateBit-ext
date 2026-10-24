/**
 * Test-only wiring for the browser end-to-end run (vite build --mode e2e).
 * The production build never includes this file (the call is behind import.meta.env.MODE,
 * and scripts/check-dist.mjs fails the build if "__pbE2E" appears in dist).
 * Everything is offline: a local mock chain and an in-memory Payjoin mailbox. No funds.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { spendSecret, taprootScriptPubKey } from "./lib/bip352.ts";
import { concatBytes, hex } from "./lib/bytes.ts";
import type { ChainSource } from "./lib/chain.ts";
import { MemoryDirectory } from "./lib/mailbox.ts";
import { DEFAULT_BIRTHDAY, DEFAULT_CHAIN } from "./lib/network.ts";
import { INTENT_PAYJOIN } from "./lib/policy.ts";
import { upsertUtxo, type LabeledUtxo } from "./lib/scan.ts";
import { evenPriv, sessionTweak } from "./lib/schnorr-util.ts";
import { memoryKv } from "./lib/vault.ts";
import { accountFromVault } from "./lib/keys.ts";
import { PrivateBit } from "./lib/wallet.ts";

const TIP = DEFAULT_BIRTHDAY + 40;
const BASE = DEFAULT_BIRTHDAY - 200;

function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
}

/** A tiny linked chain: each block has one coinbase paying an OP_RETURN. */
function mockChain(): ChainSource {
  const headers = new Map<number, Uint8Array>();
  const header = (h: number): Uint8Array => {
    let at = headers.get(h);
    if (at) return at;
    let start = h;
    while (start > BASE && !headers.has(start - 1)) start--;
    for (let x = start; x <= h; x++) {
      const prev = x <= BASE ? new Uint8Array(32) : sha256(sha256(headers.get(x - 1)!));
      const merkle = new Uint8Array(32);
      merkle.set(u32le(x));
      headers.set(x, concatBytes(u32le(0x20000000), prev, merkle, u32le(1_700_000_000 + x * 30), u32le(0x1d00ffff), u32le(x)));
    }
    at = headers.get(h)!;
    return at;
  };
  const coinbase = (h: number): Uint8Array =>
    concatBytes(
      new Uint8Array([1, 0, 0, 0, 1]),
      new Uint8Array(32),
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 4]),
      u32le(h),
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 1]),
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0x6a]),
      new Uint8Array(4),
    );
  return {
    kind: "core",
    async getTip() {
      return { height: TIP, hash: hex(sha256(sha256(header(TIP))).reverse()) };
    },
    async getBlockHash(h) {
      return hex(sha256(sha256(header(h))).reverse());
    },
    async getBlockRaw(h) {
      return concatBytes(header(h), new Uint8Array([1]), coinbase(h));
    },
    async getBlockTxids() {
      return [];
    },
    async getTxHex() {
      throw new Error("not in the mock chain");
    },
    async broadcast() {
      throw new Error("the end-to-end run never broadcasts");
    },
    async estimateFeeSatPerVb() {
      return 2;
    },
    async feeRates() {
      return { fastest: 3, halfHour: 2, hour: 2, economy: 1, minimum: 1 } as never;
    },
  };
}

function randomHex(n: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

export function installE2E(wallet: PrivateBit): void {
  const dir = new MemoryDirectory();
  const chain = mockChain();
  wallet.sourceOverride = chain;
  wallet.mailboxTransport = dir.ohttpTransport();
  wallet.ohttpConfig = dir.ohttp;
  let payer: PrivateBit | undefined;
  (self as unknown as { __pbE2E: unknown }).__pbE2E = {
    TIP,
    /** Give the open wallet one coin (fake outpoint, test only) so a payment link can be made. */
    async fundOpenWallet(value = "50000") {
      const core = await wallet.core();
      const coin: LabeledUtxo = { txid: randomHex(32), vout: 0, value, scriptPubKey: "5120" + randomHex(32), tweak: randomHex(32), label: null, k: 0, height: TIP, spent: false };
      await core.coins_.update((s) => {
        const next = { ...s, utxos: [...s.utxos] };
        upsertUtxo(next.utxos, coin);
        return next;
      }, { flush: true });
      return coin.txid;
    },
    /** A second, separate PrivateBit user pays the link through the in-memory mailbox. */
    async payLink(bip21: string, sats = 10_000) {
      payer = new PrivateBit(memoryKv(), { ...DEFAULT_CHAIN });
      payer.sourceOverride = chain;
      payer.mailboxTransport = dir.ohttpTransport();
      payer.ohttpConfig = dir.ohttp;
      await payer.create({ password: "payer", birthday: TIP });
      const { account, scan } = await payer.requireAccount();
      const txid = randomHex(32);
      const tweak = sessionTweak(txid, 0);
      const d = evenPriv(spendSecret({ spendSecret: account.spendSecret, tweak, label: null, scanSecret: account.scanSecret }));
      const xonly = secp256k1.getPublicKey(d, true).slice(1);
      upsertUtxo(scan.utxos, { txid, vout: 0, value: String(sats + 5_000), scriptPubKey: hex(taprootScriptPubKey(xonly)), tweak: hex(tweak), label: null, k: 0, height: TIP, spent: false });
      await payer.saveScan(scan);
      const built = await payer.planSend(bip21, BigInt(sats));
      await payer.broadcast(INTENT_PAYJOIN, built);
      void accountFromVault;
      return true;
    },
    /** Run the receiver's mailbox check now instead of waiting for its timer. */
    async service() {
      return wallet.servicePayjoin();
    },
    /** Move the open proposal past its deadline (what happens if the payer never broadcasts). */
    async expireProposal() {
      const core = await wallet.core();
      const sessions = await core.loadPayjoinSessions();
      for (const s of sessions) if (s.status === "proposed") s.proposalDeadline = Date.now() - 1;
      await core.savePayjoinSessions(sessions);
      return core.waitingPayjoin();
    },
  };
}
