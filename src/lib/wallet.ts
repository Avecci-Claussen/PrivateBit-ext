import * as btc from "@scure/btc-signer";
import { spendSecret, taprootScriptPubKey } from "./bip352.ts";
import { fromHex, hex, randomBytes } from "./bytes.ts";
import { openChain, type ChainSource } from "./chain.ts";
import type { Account } from "./keys.ts";
import { accountFromVault } from "./keys.ts";
import {
  DEFAULT_CHAIN,
  DEFAULT_PAYJOIN_DIRECTORY,
  FRACTAL,
  isRedactedSecret,
  migrateChainConfig,
  redactChain,
  type ChainConfig,
} from "./network.ts";
import {
  INTENT_PAYJOIN,
  INTENT_SIMPLE_SEND,
  PolicyError,
  psbtForBroadcast,
  type BroadcastIntent,
} from "./policy.ts";
import {
  createReceiverSession,
  fetchDirectoryOhttp,
  postOriginalV2,
  receiverPostProposal,
  receiverTakeOriginal,
  takeProposalV2,
  type PayjoinConfig,
  type PayjoinReceiveSession,
  type PayjoinSendSession,
} from "./payjoin.ts";
import { hpkeKeyPairFromSecret } from "./bip77-hpke.ts";
import { buildPayjoinProposal, validatePayjoinProposal } from "./payjoin-proposal.ts";
import { mailboxUrls, type MailboxTransport } from "./mailbox.ts";
import type { OhttpKeyConfig } from "./ohttp.ts";
import {
  addWatch,
  applyBuiltSend,
  applyTxHex,
  confirmedBalance,
  emptyScanStore,
  pendingBalance,
  spendableBalance,
  scanStep,
  type ScanProgress,
  type ScanStore,
} from "./scan.ts";
import { evenPriv, sessionTweak, tweakSpend } from "./schnorr-util.ts";
import { buildSend, destinationNeedsPayjoin, planPayload, signPayjoinProposal, type PlanPayload } from "./send.ts";
import {
  clearSession,
  loadSession,
  loadVaultBlob,
  lockVault,
  persistVault,
  saveSession,
  unlockVault,
  vaultFromMnemonic,
  type Kv,
  type UnlockedVault,
  type VaultBlob,
} from "./vault.ts";
import { createMnemonic } from "./vault.ts";

export type WalletState = {
  hasVault: boolean;
  unlocked: boolean;
  receive?: string;
  birthday?: number;
  lastHeight?: number;
  tip?: number;
  watching?: boolean;
  balance?: string;
  confirmed?: string;
  pending?: string;
  chain: ChainConfig;
  /** BIP21 with pj= mailbox. Copy this to the other PrivateBit user. */
  payjoinBip21?: string;
  payjoinStatus?: string;
};

export type BroadcastResult = { kind: "txid"; txid: string } | { kind: "payjoin-pending" };

export const FOLLOW_TIP_STEPS = 24;

const PJ_SESSIONS = "privatebit.pj.sessions";
const PJ_SEND = "privatebit.pj.send";
const PJ_HPKE = "privatebit.pj.hpke";
const SEND_HPKE_PREFIX = "send:";
const P2TR_NETWORK: btc.BTC_NETWORK = {
  bech32: FRACTAL.bech32,
  pubKeyHash: FRACTAL.pubKeyHash,
  scriptHash: FRACTAL.scriptHash,
  wif: FRACTAL.wif,
};

function encodeP2tr(xonly: Uint8Array): string {
  return btc.Address(P2TR_NETWORK).encode({ type: "tr", pubkey: xonly });
}

export class PrivateBit {
  /** Tests inject MemoryDirectory.ohttpTransport(). Production uses fetch. */
  mailboxTransport?: MailboxTransport;
  /** Tests inject the directory's OHTTP public config so RK URIs include OH. */
  ohttpConfig?: OhttpKeyConfig;
  /** Tests inject a mock chain. Production uses UniSat / Core. */
  sourceOverride?: ChainSource;

  constructor(
    readonly kv: Kv,
    public chainCfg: ChainConfig = DEFAULT_CHAIN,
  ) {}

  payjoinCfg(): PayjoinConfig {
    return {
      directory: this.chainCfg.payjoinDirectory || DEFAULT_PAYJOIN_DIRECTORY,
      ohttpRelay: this.chainCfg.ohttpRelay,
      receiverOnline: true,
      transport: this.mailboxTransport,
      ohttp: this.ohttpConfig,
    };
  }

  private async hpkeSecrets(): Promise<Record<string, string>> {
    const got = await this.kv.get([PJ_HPKE]);
    return (got[PJ_HPKE] as Record<string, string>) ?? {};
  }

  private async saveHpkeSecret(id: string, sk: Uint8Array): Promise<void> {
    const all = await this.hpkeSecrets();
    all[id] = hex(sk);
    await this.kv.set({ [PJ_HPKE]: all });
  }

  private async loadHpkeSecret(id: string): Promise<Uint8Array | undefined> {
    const all = await this.hpkeSecrets();
    const h = all[id];
    return h ? fromHex(h) : undefined;
  }

  private async clearHpkeSecrets(): Promise<void> {
    await this.kv.remove([PJ_HPKE]);
  }

  source(): ChainSource {
    return this.sourceOverride ?? openChain(this.chainCfg);
  }

  async state(): Promise<WalletState> {
    const blob = await loadVaultBlob(this.kv);
    const session = await loadSession(this.kv);
    const scan = await this.loadScan();
    if (!blob) {
      return { hasVault: false, unlocked: false, chain: redactChain(this.chainCfg) };
    }
    if (!session) {
      return {
        hasVault: true,
        unlocked: false,
        birthday: blob.birthday,
        lastHeight: scan.lastHeight,
        tip: scan.tip,
        chain: redactChain(this.chainCfg),
      };
    }
    const account = accountFromVault(session);
    const pending = pendingBalance(scan);
    const confirmed = confirmedBalance(scan);
    const live = (await this.loadPayjoinSessions()).find((s) => s.status === "waiting" || s.status === "proposed");
    const sending = (await this.loadPayjoinSends()).find((s) => s.status === "waiting");
    return {
      hasVault: true,
      unlocked: true,
      receive: account.receive,
      birthday: session.birthday,
      lastHeight: scan.lastHeight,
      tip: scan.tip,
      watching: scan.tip !== undefined && scan.lastHeight >= scan.tip && !scan.inflight,
      balance: spendableBalance(scan).toString(),
      confirmed: confirmed.toString(),
      pending: pending.toString(),
      chain: redactChain(this.chainCfg),
      payjoinBip21: live?.bip21,
      payjoinStatus:
        live?.status === "waiting"
          ? "Waiting for them to pay — you can close this (don't lock)"
          : live?.status === "proposed"
            ? "Finishing payment"
            : sending
              ? "Waiting for them to add an input — you can close this (don't lock)"
              : undefined,
    };
  }

  async create(args: { password: string; passphrase?: string; birthday: number; words?: 12 | 24 }): Promise<string> {
    if (args.birthday <= 0) throw new Error("birthday height required (Fractal tip is past 2M; 0 is genesis)");
    const mnemonic = createMnemonic(args.words === 24 ? 256 : 128);
    const unlocked = vaultFromMnemonic({
      mnemonic,
      passphrase: args.passphrase,
      birthday: args.birthday,
    });
    const blob = lockVault(unlocked, args.password);
    await persistVault(this.kv, blob);
    await saveSession(this.kv, unlocked);
    await this.saveScan(emptyScanStore(args.birthday));
    return mnemonic;
  }

  async restore(args: {
    mnemonic: string;
    password: string;
    passphrase?: string;
    birthday: number;
  }): Promise<void> {
    if (args.birthday <= 0) throw new Error("birthday height required (Fractal tip is past 2M; 0 is genesis)");
    const unlocked = vaultFromMnemonic(args);
    const blob = lockVault(unlocked, args.password);
    await persistVault(this.kv, blob);
    await saveSession(this.kv, unlocked);
    await this.saveScan(emptyScanStore(args.birthday));
  }

  /** Birthday is plaintext on the vault blob. Rewinds scan so that height is scanned again. */
  async setBirthday(birthday: number): Promise<void> {
    if (birthday <= 0) throw new Error("birthday height required (Fractal tip is past 2M; 0 is genesis)");
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    await persistVault(this.kv, { ...blob, birthday });
    const session = await loadSession(this.kv);
    if (session) await saveSession(this.kv, { ...session, birthday });
    await this.saveScan(emptyScanStore(birthday));
  }

  async unlock(password: string): Promise<void> {
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    const unlocked = unlockVault(blob, password);
    await saveSession(this.kv, unlocked);
  }

  async lock(): Promise<void> {
    await clearSession(this.kv);
    await this.clearHpkeSecrets();
    await this.kv.remove([PJ_SEND]);
    const sessions = await this.loadPayjoinSessions();
    let dirty = false;
    for (const s of sessions) {
      if (s.inputSecret) {
        s.inputSecret = undefined;
        dirty = true;
      }
    }
    if (dirty) await this.savePayjoinSessions(sessions);
  }

  async requireAccount(): Promise<{ vault: UnlockedVault; account: Account; scan: ScanStore }> {
    const vault = await loadSession(this.kv);
    if (!vault) throw new Error("locked");
    return { vault, account: accountFromVault(vault), scan: await this.loadScan() };
  }

  async scanOnce(): Promise<ScanProgress> {
    const { account, scan } = await this.requireAccount();
    const tip = await this.source().getTip();
    const { store, progress } = await scanStep(account, this.source(), scan, tip.height);
    await this.saveScan(store);
    return progress;
  }

  async scanToTip(onProgress?: (h: number, tip: number) => void): Promise<ScanStore> {
    for (;;) {
      const progress = await this.scanOnce();
      onProgress?.(progress.height, progress.tip);
      if (progress.done) return this.loadScan();
    }
  }

  async planSend(destination: string, amount: bigint): Promise<ReturnType<typeof buildSend>> {
    const { account, scan } = await this.requireAccount();
    const feeRate = await this.source().estimateFeeSatPerVb();
    const skipOutpoints = new Set(
      (await this.loadPayjoinSessions())
        .filter((s) => s.status === "waiting" && s.reserved)
        .map((s) => `${s.reserved!.txid}:${s.reserved!.vout}`),
    );
    for (const s of await this.loadPayjoinSends()) {
      if (s.status !== "waiting") continue;
      for (const inp of s.signableInputs) skipOutpoints.add(`${inp.txid}:${inp.vout}`);
    }
    return buildSend({
      account,
      utxos: scan.utxos,
      destination,
      amount,
      feeRate,
      source: this.source(),
      skipOutpoints,
    });
  }

  async plan(destination: string, amount: bigint): Promise<PlanPayload> {
    return planPayload(await this.planSend(destination, amount));
  }

  async broadcast(intent: BroadcastIntent, built: Awaited<ReturnType<typeof buildSend>>): Promise<BroadcastResult> {
    const { account, scan } = await this.requireAccount();
    if (intent === INTENT_PAYJOIN) {
      if (!destinationNeedsPayjoin(built.request) || !built.request.pj) {
        throw new PolicyError(
          "Payjoin only runs on a PrivateBit payment link (pj= mailbox with RK and OH). A raw sp1/bc1 or a BIP78 https URL cannot Payjoin. Use Simple send, or paste the payment link.",
        );
      }
      const posted = await postOriginalV2({
        originalPsbt: built.psbtBase64,
        request: built.request,
        cfg: this.payjoinCfg(),
      });
      if ("ok" in posted && posted.ok === false) {
        throw new PolicyError(`Payjoin failed (${posted.reason}); original PSBT is not broadcast`);
      }
      const id = mailboxUrls(posted.pj).id;
      await this.saveHpkeSecret(SEND_HPKE_PREFIX + id, posted.replySk);
      const send: PayjoinSendSession = {
        id,
        pj: posted.pj,
        originalPsbt: built.psbtBase64,
        signableInputs: built.signableInputs,
        destination: built.request.raw,
        amount: built.request.amount?.toString() ?? "0",
        rk: hex(posted.rk),
        replyPk: hex(posted.replyPk),
        createdAt: Date.now(),
        expiresAt: built.request.sessionExpiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
        status: "waiting",
      };
      const sends = await this.loadPayjoinSends();
      sends.push(send);
      await this.savePayjoinSends(sends);
      return { kind: "payjoin-pending" };
    }
    const hexTx = built.txHex;
    void psbtForBroadcast(INTENT_SIMPLE_SEND, null, built.psbtBase64);
    const txid = await this.source().broadcast(hexTx);
    await this.saveScan(applyBuiltSend(scan, hexTx, built.ourOutputs));
    return { kind: "txid", txid };
  }

  /** Scan newly indexed heights after catch-up. One alarm tick = a few batches. */
  async followTip(maxSteps = FOLLOW_TIP_STEPS): Promise<ScanProgress> {
    try {
      await this.servicePayjoin();
    } catch {
      /* locked or no directory */
    }
    let progress: ScanProgress | undefined;
    for (let i = 0; i < maxSteps; i++) {
      progress = await this.scanOnce();
      if (progress.done) return progress;
    }
    return progress!;
  }

  async loadScan(): Promise<ScanStore> {
    const got = await this.kv.get(["privatebit.scan"]);
    return (got["privatebit.scan"] as ScanStore) ?? emptyScanStore(0);
  }

  async saveScan(scan: ScanStore): Promise<void> {
    await this.kv.set({ "privatebit.scan": scan });
  }

  async loadChain(): Promise<ChainConfig> {
    const got = await this.kv.get(["privatebit.chain"]);
    const stored = got["privatebit.chain"] as ChainConfig | undefined;
    const migrated = migrateChainConfig(stored ?? DEFAULT_CHAIN);
    this.chainCfg = migrated;
    if (JSON.stringify(stored ?? null) !== JSON.stringify(migrated)) {
      await this.kv.set({ "privatebit.chain": migrated });
    }
    return this.chainCfg;
  }

  async saveChain(cfg: ChainConfig): Promise<void> {
    const prev = await this.loadChain();
    this.chainCfg = migrateChainConfig({
      ...cfg,
      rpcPassword: isRedactedSecret(cfg.rpcPassword) ? prev.rpcPassword : cfg.rpcPassword,
      unisatToken: isRedactedSecret(cfg.unisatToken) ? prev.unisatToken : cfg.unisatToken,
    });
    await this.kv.set({ "privatebit.chain": this.chainCfg });
  }

  async loadPayjoinSessions(): Promise<PayjoinReceiveSession[]> {
    const got = await this.kv.get([PJ_SESSIONS]);
    return (got[PJ_SESSIONS] as PayjoinReceiveSession[]) ?? [];
  }

  async savePayjoinSessions(sessions: PayjoinReceiveSession[]): Promise<void> {
    await this.kv.set({ [PJ_SESSIONS]: sessions });
  }

  /**
   * Receiver: publish a BIP21 with pj= mailbox for exactly one other user
   * (BIP78/77 is two-party). Requires a spendable UTXO we can add as our input.
   */
  async offerPayjoin(amountSats: bigint): Promise<PayjoinReceiveSession> {
    const { account, scan } = await this.requireAccount();
    const directory = this.chainCfg.payjoinDirectory?.trim() || DEFAULT_PAYJOIN_DIRECTORY;
    const reservedOut = new Set(
      (await this.loadPayjoinSessions())
        .filter((s) => s.status === "waiting" && s.reserved)
        .map((s) => `${s.reserved!.txid}:${s.reserved!.vout}`),
    );
    const spendable = scan.utxos
      .filter((u) => !u.spent && !reservedOut.has(`${u.txid}:${u.vout}`))
      .slice()
      .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
    if (spendable.length === 0) {
      throw new PolicyError("Receive coins first, then you can create a payment link.");
    }
    const coin = spendable[0]!;
    const sessionId = hex(randomBytes(32));
    const payTweak = sessionTweak(sessionId, 0);
    const extraTweak = sessionTweak(sessionId, 1);
    const pay = tweakSpend(account.spendSecret, payTweak);
    const extra = tweakSpend(account.spendSecret, extraTweak);
    const payScript = taprootScriptPubKey(pay.xonly);
    const extraScript = taprootScriptPubKey(extra.xonly);
    if (!this.ohttpConfig) this.ohttpConfig = await fetchDirectoryOhttp(directory);
    const ohttp = this.ohttpConfig;
    const { session, hpke } = createReceiverSession({
      directory,
      address: encodeP2tr(pay.xonly),
      scriptPubKey: hex(payScript),
      tweak: hex(payTweak),
      extraScriptPubKey: hex(extraScript),
      extraTweak: hex(extraTweak),
      amount: amountSats > 0n ? amountSats : undefined,
      ohttp,
    });
    session.reserved = {
      txid: coin.txid,
      vout: coin.vout,
      value: coin.value,
      scriptPubKey: coin.scriptPubKey,
      tweak: coin.tweak,
      label: coin.label,
      k: coin.k,
      height: coin.height,
    };
    let nextScan = addWatch(scan, { scriptPubKey: hex(payScript), tweak: hex(payTweak), label: null, k: 0 });
    nextScan = addWatch(nextScan, { scriptPubKey: hex(extraScript), tweak: hex(extraTweak), label: null, k: 0 });
    await this.saveScan(nextScan);
    await this.saveHpkeSecret(session.id, hpke.sk);
    const sessions = await this.loadPayjoinSessions();
    sessions.push(session);
    await this.savePayjoinSessions(sessions);
    return session;
  }

  async loadPayjoinSends(): Promise<PayjoinSendSession[]> {
    const got = await this.kv.get([PJ_SEND]);
    return (got[PJ_SEND] as PayjoinSendSession[]) ?? [];
  }

  async savePayjoinSends(sessions: PayjoinSendSession[]): Promise<void> {
    await this.kv.set({ [PJ_SEND]: sessions });
  }

  async waitingPayjoin(): Promise<boolean> {
    if ((await this.loadPayjoinSessions()).some((s) => s.status === "waiting")) return true;
    return (await this.loadPayjoinSends()).some((s) => s.status === "waiting");
  }

  /**
   * Poll mailboxes and post a proposal. Window may be closed; vault must stay
   * unlocked (chrome.storage.session). Lock wipes keys and this is a no-op.
   */
  async servicePayjoin(): Promise<{ processed: number; errors: string[] }> {
    const vault = await loadSession(this.kv);
    if (!vault) return { processed: 0, errors: [] };
    const account = accountFromVault(vault);
    const cfg = this.payjoinCfg();
    const sessions = await this.loadPayjoinSessions();
    let processed = 0;
    const errors: string[] = [];
    for (const s of sessions) {
      if (s.inputSecret) s.inputSecret = undefined;
      if (s.status !== "waiting") continue;
      try {
        const sk = await this.loadHpkeSecret(s.id);
        if (!sk) {
          s.status = "failed";
          s.error = "HPKE receiver key is gone (locked or session expired)";
          errors.push(s.error);
          continue;
        }
        const got = await receiverTakeOriginal(s, cfg, sk);
        if ("expired" in got) {
          s.status = "failed";
          s.error = "expired";
          continue;
        }
        if ("empty" in got) continue;
        if (!s.reserved) {
          throw new Error("payment link is missing its reserved coin; create a new one");
        }
        const built = buildPayjoinProposal({
          originalB64: got.original,
          receiverInput: { ...s.reserved, spent: false },
          receiverSecret: evenPriv(
            spendSecret({
              spendSecret: account.spendSecret,
              tweak: fromHex(s.reserved.tweak),
              label: s.reserved.label,
              scanSecret: account.scanSecret,
            }),
          ),
          extraScript: fromHex(s.extraScriptPubKey),
          extraTweak: s.extraTweak,
        });
        await receiverPostProposal(s, built.proposalB64, cfg, hpkeKeyPairFromSecret(sk), got.replyPk);
        s.replyPk = hex(got.replyPk);
        s.status = "proposed";
        processed += 1;
      } catch (e) {
        s.status = "failed";
        s.error = e instanceof Error ? e.message : String(e);
        errors.push(s.error);
      }
    }
    await this.savePayjoinSessions(sessions);
    const sent = await this.servicePayjoinSends(account, errors);
    return { processed: processed + sent, errors };
  }

  private async servicePayjoinSends(
    account: Account,
    errors: string[],
  ): Promise<number> {
    const sends = await this.loadPayjoinSends();
    let processed = 0;
    const cfg = this.payjoinCfg();
    for (const s of sends) {
      if (s.status !== "waiting") continue;
      if (Date.now() > s.expiresAt) {
        s.status = "failed";
        s.error = "expired";
        continue;
      }
      const sk = await this.loadHpkeSecret(SEND_HPKE_PREFIX + s.id);
      if (!sk) {
        s.status = "failed";
        s.error = "HPKE sender reply key is gone (locked or session expired)";
        errors.push(s.error);
        continue;
      }
      try {
        const got = await takeProposalV2({
          pj: s.pj,
          originalPsbt: s.originalPsbt,
          rk: fromHex(s.rk),
          replySk: sk,
          cfg,
          validate: validatePayjoinProposal,
        });
        if ("empty" in got) continue;
        const proposal = psbtForBroadcast(INTENT_PAYJOIN, got, null);
        const scan = await this.loadScan();
        const signed = signPayjoinProposal({
          proposalB64: proposal,
          account,
          inputs: s.signableInputs,
        });
        const txid = await this.source().broadcast(signed.txHex);
        await this.saveScan(await applyTxHex(account, this.source(), scan, signed.txHex, 0));
        s.status = "done";
        s.txid = txid;
        processed += 1;
      } catch (e) {
        s.status = "failed";
        s.error = e instanceof Error ? e.message : String(e);
        errors.push(s.error);
      }
    }
    await this.savePayjoinSends(sends);
    return processed;
  }
}

export type { VaultBlob };
export { INTENT_PAYJOIN, INTENT_SIMPLE_SEND };
