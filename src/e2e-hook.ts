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
import { DEFAULT_CHAIN, netInfo, type NetworkId } from "./lib/network.ts";
import { recordBroadcast } from "./lib/history.ts";
import { INTENT_PAYJOIN } from "./lib/policy.ts";
import { upsertUtxo, type LabeledUtxo } from "./lib/scan.ts";
import { evenPriv, sessionTweak } from "./lib/schnorr-util.ts";
import { memoryKv } from "./lib/vault.ts";
import { accountFromVault } from "./lib/keys.ts";
import { PrivateBit } from "./lib/wallet.ts";
import * as btc from "@scure/btc-signer";
import { fromHex } from "./lib/bytes.ts";

// Each chain gets its own short mock chain just past its default start height.
const tipOf = (net: NetworkId): number => netInfo(net).defaultBirthday + 40;
const baseOf = (h: number): number => (h < 2_000_000 ? netInfo("bitcoin").defaultBirthday : netInfo("fractal").defaultBirthday) - 200;

function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
}

/** A tiny linked chain: each block has one coinbase paying an OP_RETURN. */
/** Test only: when set, the mock chain "accepts" a transaction and returns its txid. Nothing leaves the browser. */
const mock = { accept: false, seen: [] as string[] };

function mockChain(netNow: () => NetworkId): ChainSource {
  const headers = new Map<number, Uint8Array>();
  const header = (h: number): Uint8Array => {
    let at = headers.get(h);
    if (at) return at;
    let start = h;
    const BASE = baseOf(h);
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
    get net() {
      return netNow();
    },
    async getTip() {
      const TIP = tipOf(netNow());
      return { height: TIP, hash: hex(sha256(sha256(header(TIP))).reverse()) };
    },
    async blockPrevouts() {
      return {};
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
    async broadcast(txHex: string) {
      if (!mock.accept) throw new Error("the end-to-end run never broadcasts");
      mock.seen.push(txHex);
      return btc.Transaction.fromRaw(fromHex(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true }).id;
    },
    async estimateFeeSatPerVb() {
      return 2;
    },
    async feeRates() {
      return { fast: 3, normal: 2, slow: 1, minimum: 1, updatedAt: Date.now(), source: "service" as const };
    },
  };
}

function randomHex(n: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

export function installE2E(wallet: PrivateBit): void {
  const dir = new MemoryDirectory();
  const chain = mockChain(() => wallet.net);
  wallet.sourceOverride = chain;
  wallet.mailboxTransport = dir.ohttpTransport();
  wallet.ohttpConfig = dir.ohttp;
  let payer: PrivateBit | undefined;
  (self as unknown as { __pbE2E: unknown }).__pbE2E = {
    get TIP() {
      return tipOf(wallet.net);
    },
    /** Give the open wallet one coin (fake outpoint, test only) so a payment link can be made. */
    async fundOpenWallet(value = "50000", label?: string) {
      const core = await wallet.core();
      const coin: LabeledUtxo = { txid: randomHex(32), vout: 0, value, scriptPubKey: hex(taprootScriptPubKey(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true).slice(1))), tweak: randomHex(32), label: null, k: 0, height: tipOf(wallet.net), spent: false };
      await core.coins_.update((s) => {
        const next = { ...s, utxos: [...s.utxos] };
        upsertUtxo(next.utxos, coin);
        return next;
      }, { flush: true });
      if (label) await wallet.setCoinMeta(`${coin.txid}:0`, { label });
      return coin.txid;
    },
    /** Let the mock chain take transactions (kept in memory, never sent). */
    acceptBroadcasts(on = true) {
      mock.accept = on;
      return mock.seen.length;
    },
    seenBroadcasts() {
      return mock.seen.slice();
    },
    /** A connected site's account on the open chain (address, script, path). */
    async siteInfo(origin: string) {
      const core = await wallet.core();
      const { account } = await core.requireAccount();
      const site = await core.siteRecord(origin);
      if (!site) return null;
      const k = account.site!(site.index);
      return { address: k.address, script: k.scriptPubKey, path: k.path, index: site.index, connected: site.connected, output: hex(k.output) };
    },
    /** Give a site account one synthetic coin (fake outpoint, test only). */
    async fundSite(origin: string, value = "40000") {
      const core = await wallet.core();
      const { account } = await core.requireAccount();
      const site = await core.siteRecord(origin);
      if (!site) throw new Error("site not connected");
      const k = account.site!(site.index);
      const coin: LabeledUtxo = { txid: randomHex(32), vout: 0, value, scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, height: tipOf(wallet.net), spent: false, kind: "site", index: site.index };
      await core.coins_.update((st) => {
        const next = { ...st, utxos: [...st.utxos] };
        upsertUtxo(next.utxos, coin);
        return next;
      }, { flush: true });
      return { txid: coin.txid, vout: 0, script: k.scriptPubKey, value };
    },
    /** One private coin of the open wallet (txid, script), for the refusal test. */
    async privateCoin() {
      const core = await wallet.core();
      const scan = await core.loadScan();
      const u = scan.utxos.find((x) => !x.spent);
      return u ? { txid: u.txid, vout: u.vout, script: u.scriptPubKey, value: u.value } : null;
    },
    /** Write a sent payment into history the way a real broadcast would (no transaction exists). */
    async addSent(e: { to: string; onchain: string; amount: string; fee: string; change: string; label?: string; kind?: "sent" | "split" | "self" }) {
      const core = await wallet.core();
      const txid = randomHex(32);
      const hist = recordBroadcast(await core.loadHistory(), {
        txid,
        kind: e.kind ?? "sent",
        amount: BigInt(e.amount),
        fee: BigInt(e.fee),
        feeRate: 2,
        to: e.kind && e.kind !== "sent" ? undefined : e.to,
        onchain: e.kind && e.kind !== "sent" ? undefined : e.onchain,
        net: wallet.net,
        label: e.label,
        outpoints: [],
        change: BigInt(e.change),
        now: Date.now(),
        pieces: e.kind === "split" ? 3 : undefined,
      });
      await core.saveHistory(hist);
      return txid;
    },
    /** A second, separate PrivateBit user pays the link through the in-memory mailbox. */
    async payLink(bip21: string, sats = 10_000) {
      payer = new PrivateBit(memoryKv(), { ...DEFAULT_CHAIN });
      payer.sourceOverride = chain;
      payer.mailboxTransport = dir.ohttpTransport();
      payer.ohttpConfig = dir.ohttp;
      await payer.create({ password: "payer", birthday: tipOf("fractal") });
      const { account, scan } = await payer.requireAccount();
      const txid = randomHex(32);
      const tweak = sessionTweak(txid, 0);
      const d = evenPriv(spendSecret({ spendSecret: account.spendSecret, tweak, label: null, scanSecret: account.scanSecret }));
      const xonly = secp256k1.getPublicKey(d, true).slice(1);
      upsertUtxo(scan.utxos, { txid, vout: 0, value: String(sats + 5_000), scriptPubKey: hex(taprootScriptPubKey(xonly)), tweak: hex(tweak), label: null, k: 0, height: tipOf("fractal"), spent: false });
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
