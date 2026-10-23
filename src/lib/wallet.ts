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
import { deriveDataKey, isSealed, openJson, sealJson } from "./datastore.ts";
import {
  carryCoinMeta,
  coinStatus,
  frozenOutpoints,
  outpointOf,
  setCoinMeta,
  type CoinMeta,
  type CoinMetaMap,
  type CoinStatus,
} from "./coinmeta.ts";
import {
  deriveHistory,
  emptyHistory,
  historyList,
  recordBroadcast,
  setHistoryLabel,
  type HistoryEntry,
  type HistoryKind,
  type HistoryStore,
} from "./history.ts";
import {
  emptyOneTime,
  issueRecord,
  nextOneTimeIndex,
  setOneTimeStatus,
  visibleRecord,
  type OneTimeRecord,
  type OneTimeStore,
} from "./onetime.ts";
import { ONE_TIME_RESTORE_WINDOW } from "./keys.ts";
import { feeRatesOf } from "./chain.ts";
import type { FeeRates } from "./requests.ts";
import { maxSendable } from "./coinselect.ts";
import { splitChainSecrets, type ChainSecrets } from "./network.ts";
import { parseBip21 } from "./bip21.ts";

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
  /** Spendable: not spent and not frozen. */
  frozen?: string;
  coinCount?: number;
  /** An open payment link or Payjoin send (auto lock waits for it). */
  payjoin?: {
    role: "receive" | "send";
    status: string;
    amount?: string;
    expiresAt: number;
    createdAt: number;
    id: string;
  };
  oneTimeFunded?: { index: number; value: string; outpoint: string };
  historyRebuilding?: boolean;
  hasHistory?: boolean;
  mnemonicWords?: number;
  hasPassphrase?: boolean;
};

export type CoinView = {
  outpoint: string;
  txid: string;
  vout: number;
  value: string;
  height: number;
  status: CoinStatus;
  label?: string;
  reason?: string;
  linked?: boolean;
  frozen?: boolean;
  kind: "sp" | "bip86";
  pending: boolean;
};

export type PlanOptions = {
  feeRate?: number;
  coins?: string[];
  max?: boolean;
};

export type SessionView = {
  role: "receive" | "send";
  id: string;
  status: string;
  error?: string;
  amount?: string;
  createdAt: number;
  expiresAt: number;
  bip21?: string;
  reservedValue?: string;
  reservedOutpoint?: string;
  destination?: string;
  txid?: string;
  /** Send role: coins the signed original spends. Sending without Payjoin must reuse them. */
  inputs?: string[];
};

export type BroadcastResult = { kind: "txid"; txid: string } | { kind: "payjoin-pending" };

export const FOLLOW_TIP_STEPS = 24;

const PJ_SESSIONS = "privatebit.pj.sessions";
const SCAN_KEY = "privatebit.scan";
const CHAIN_KEY = "privatebit.chain";
const CHAIN_SECRETS_KEY = "privatebit.chain.secrets";
const HISTORY_KEY = "privatebit.history";
const COINMETA_KEY = "privatebit.coinmeta";
const ONETIME_KEY = "privatebit.onetime";
/** Every storage key this wallet may write, so Remove wallet can prove nothing is left. */
export const ALL_KEYS = [
  "privatebit.vault",
  "privatebit.session",
  SCAN_KEY,
  CHAIN_KEY,
  CHAIN_SECRETS_KEY,
  HISTORY_KEY,
  COINMETA_KEY,
  ONETIME_KEY,
  "privatebit.prefs",
  "privatebit.price",
  "privatebit.activity",
  "privatebit.lockinfo",
  "privatebit.health",
  "privatebit.onboard",
  "privatebit.fees",
  "privatebit.pj.sessions",
  "privatebit.pj.send",
  "privatebit.pj.hpke",
];
const PJ_SEND = "privatebit.pj.send";
const PJ_HPKE = "privatebit.pj.hpke";
const SEND_HPKE_PREFIX = "send:";
const P2TR_NETWORK: typeof btc.NETWORK = {
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

  private keyCache?: { mnemonic: string; passphrase: string; key: Uint8Array };

  /** Data key for encryption at rest. Exists only while unlocked; never written anywhere. */
  async dataKey(): Promise<Uint8Array | null> {
    const session = await loadSession(this.kv);
    if (!session) {
      this.keyCache = undefined;
      return null;
    }
    const c = this.keyCache;
    if (c && c.mnemonic === session.mnemonic && c.passphrase === session.passphrase) return c.key;
    const key = deriveDataKey(session.seed);
    this.keyCache = { mnemonic: session.mnemonic, passphrase: session.passphrase, key };
    return key;
  }

  private async requireKey(): Promise<Uint8Array> {
    const k = await this.dataKey();
    if (!k) throw new Error("locked");
    return k;
  }

  private async loadSealed<T>(name: string, fallback: () => T): Promise<{ value: T; status: "ok" | "missing" | "unreadable" | "plain" }> {
    const raw = (await this.kv.get([name]))[name];
    if (raw === undefined || raw === null) return { value: fallback(), status: "missing" };
    if (!isSealed(raw)) return { value: raw as T, status: "plain" };
    const key = await this.dataKey();
    if (!key) return { value: fallback(), status: "unreadable" };
    try {
      return { value: openJson<T>(key, name, raw), status: "ok" };
    } catch {
      return { value: fallback(), status: "unreadable" };
    }
  }

  private async saveSealed(name: string, value: unknown): Promise<void> {
    const key = await this.requireKey();
    await this.kv.set({ [name]: sealJson(key, name, value) });
  }

  /**
   * Move data written by older versions in plaintext under encryption. Runs on every unlock,
   * create and restore. Existing coins are kept: the plaintext scan is read, sealed and only
   * then overwritten, so nothing is lost if the worker stops halfway.
   */
  async migrateAtRest(): Promise<{ scan: boolean; chain: boolean }> {
    const key = await this.dataKey();
    if (!key) return { scan: false, chain: false };
    let scanMoved = false;
    let chainMoved = false;
    const raw = (await this.kv.get([SCAN_KEY, CHAIN_KEY]));
    const scanRaw = raw[SCAN_KEY];
    if (scanRaw && !isSealed(scanRaw)) {
      const store = scanRaw as ScanStore;
      const sealed = sealJson(key, SCAN_KEY, store);
      // Verify before replacing the only copy.
      const back = openJson<ScanStore>(key, SCAN_KEY, sealed);
      if (JSON.stringify(back) !== JSON.stringify(store)) throw new Error("scan migration check failed");
      await this.kv.set({ [SCAN_KEY]: sealed });
      scanMoved = true;
    }
    const chainRaw = raw[CHAIN_KEY] as ChainConfig | undefined;
    if (chainRaw && (chainRaw.unisatToken || chainRaw.rpcPassword)) {
      const { plain, secrets } = splitChainSecrets(chainRaw);
      const prev = await this.loadSealed<ChainSecrets>(CHAIN_SECRETS_KEY, () => ({}));
      await this.saveSealed(CHAIN_SECRETS_KEY, { ...prev.value, ...secrets });
      await this.kv.set({ [CHAIN_KEY]: plain });
      chainMoved = true;
    }
    if (scanMoved || chainMoved) await this.loadChain();
    return { scan: scanMoved, chain: chainMoved };
  }

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
    if (!blob) {
      return { hasVault: false, unlocked: false, chain: redactChain(this.chainCfg) };
    }
    if (!session) {
      // Nothing about coins, codes or progress is shown before unlock.
      return {
        hasVault: true,
        unlocked: false,
        chain: redactChain(this.chainCfg),
      };
    }
    const scan = await this.loadScan();
    const account = accountFromVault(session);
    const meta = await this.loadCoinMeta();
    const frozen = frozenOutpoints(meta);
    const unspent = scan.utxos.filter((u) => !u.spent);
    const notFrozen = unspent.filter((u) => !frozen.has(outpointOf(u)));
    const sum = (list: typeof unspent): bigint => list.reduce((a, u) => a + BigInt(u.value), 0n);
    const pending = sum(notFrozen.filter((u) => u.height === 0));
    const confirmed = sum(notFrozen.filter((u) => u.height > 0));
    const receive = (await this.loadPayjoinSessions()).filter((s) => s.status === "waiting" || s.status === "proposed");
    const live = receive[receive.length - 1];
    const sending = (await this.loadPayjoinSends()).filter((s) => s.status === "waiting").pop();
    const hist = await this.loadHistory();
    const ot = await this.loadOneTime();
    const funded = ot.records.find((r) => r.status === "funded");
    let oneTimeFunded: WalletState["oneTimeFunded"];
    if (funded) {
      const coin = unspent.find((u) => u.kind === "bip86" && u.index === funded.index);
      if (coin) oneTimeFunded = { index: funded.index, value: coin.value, outpoint: outpointOf(coin) };
    }
    const words = session.mnemonic.trim().split(/\s+/).length;
    return {
      hasVault: true,
      unlocked: true,
      receive: account.receive,
      birthday: session.birthday,
      lastHeight: scan.lastHeight,
      tip: scan.tip,
      watching: scan.tip !== undefined && scan.lastHeight >= scan.tip && !scan.inflight,
      balance: (pending + confirmed).toString(),
      confirmed: confirmed.toString(),
      pending: pending.toString(),
      frozen: sum(unspent.filter((u) => frozen.has(outpointOf(u)))).toString(),
      coinCount: unspent.length,
      chain: redactChain(this.chainCfg),
      payjoinBip21: live?.status === "waiting" ? live.bip21 : undefined,
      payjoinStatus:
        live?.status === "waiting"
          ? "Waiting for them to pay. You can close this window, but don't lock."
          : live?.status === "proposed"
            ? "Finishing payment"
            : sending
              ? "Waiting for them to add an input. You can close this window, but don't lock."
              : undefined,
      payjoin: live
        ? { role: "receive", status: live.status, amount: live.amount, expiresAt: live.expiresAt, createdAt: live.createdAt, id: live.id }
        : sending
          ? { role: "send", status: sending.status, amount: sending.amount, expiresAt: sending.expiresAt, createdAt: sending.createdAt, id: sending.id }
          : undefined,
      oneTimeFunded,
      historyRebuilding: hist.rebuilding === true,
      hasHistory: Object.keys(hist.entries).length > 0,
      mnemonicWords: words,
      hasPassphrase: session.passphrase.length > 0,
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
    await this.saveHistory(emptyHistory());
    await this.saveScan(emptyScanStore(args.birthday));
    return mnemonic;
  }

  /**
   * Create from words the user has already written down and checked (screen 05). Nothing is
   * saved before this call, so closing the popup during backup leaves no wallet behind.
   */
  async createChecked(args: { mnemonic: string; password: string; passphrase?: string; birthday: number }): Promise<void> {
    if (args.birthday <= 0) throw new Error("birthday height required (Fractal tip is past 2M; 0 is genesis)");
    const unlocked = vaultFromMnemonic(args);
    const blob = lockVault(unlocked, args.password);
    await persistVault(this.kv, blob);
    await saveSession(this.kv, unlocked);
    await this.kv.remove([HISTORY_KEY, COINMETA_KEY, ONETIME_KEY]);
    await this.saveHistory(emptyHistory());
    await this.saveScan(emptyScanStore(args.birthday));
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
    // History is rebuilt from the scan; typed labels cannot come back.
    await this.kv.remove([HISTORY_KEY, COINMETA_KEY, ONETIME_KEY]);
    await this.saveHistory(emptyHistory(true));
    let scan = emptyScanStore(args.birthday);
    // Watch the first one-time addresses in case a migration was in progress before the restore.
    const account = accountFromVault(unlocked);
    let ot = emptyOneTime();
    for (let i = 0; i < ONE_TIME_RESTORE_WINDOW; i++) {
      const k = account.oneTime(i);
      scan = addWatch(scan, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index: i });
      ot = issueRecord(ot, k.address, Date.now(), i);
      ot = setOneTimeStatus(ot, i, "swept");
    }
    // Restored records are hidden ("swept") until a coin shows up at one of them.
    await this.saveOneTime({ ...ot, restoredWindow: ONE_TIME_RESTORE_WINDOW });
    await this.saveScan(scan);
  }

  /** Birthday is plaintext on the vault blob. Rewinds scan so that height is scanned again. */
  async setBirthday(birthday: number): Promise<void> {
    if (birthday <= 0) throw new Error("birthday height required (Fractal tip is past 2M; 0 is genesis)");
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    await persistVault(this.kv, { ...blob, birthday });
    const session = await loadSession(this.kv);
    if (session) await saveSession(this.kv, { ...session, birthday });
    const prev = await this.loadScan();
    let next = emptyScanStore(birthday);
    for (const w of prev.watch ?? []) next = addWatch(next, w);
    await this.saveScan(next);
  }

  async unlock(password: string): Promise<void> {
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    const unlocked = unlockVault(blob, password);
    await saveSession(this.kv, unlocked);
    await this.migrateAtRest();
  }

  /** Check the password without changing anything (backup screen, remove wallet). */
  async checkPassword(password: string): Promise<UnlockedVault> {
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    return unlockVault(blob, password);
  }

  async changePassword(current: string, next: string): Promise<void> {
    if (next.length < 8) throw new Error("password too short");
    const unlocked = await this.checkPassword(current);
    await persistVault(this.kv, lockVault(unlocked, next));
  }

  async lock(): Promise<void> {
    this.keyCache = undefined;
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

  /** Outpoints that automatic selection must never use: reserved, frozen, one-time coins. */
  async blockedOutpoints(): Promise<{ reserved: Set<string>; frozen: Set<string> }> {
    const reserved = new Set(
      (await this.loadPayjoinSessions())
        .filter((s) => s.status === "waiting" && s.reserved)
        .map((s) => `${s.reserved!.txid}:${s.reserved!.vout}`),
    );
    for (const s of await this.loadPayjoinSends()) {
      if (s.status !== "waiting") continue;
      for (const inp of s.signableInputs) reserved.add(`${inp.txid}:${inp.vout}`);
    }
    return { reserved, frozen: frozenOutpoints(await this.loadCoinMeta()) };
  }

  async planSend(destination: string, amount: bigint, opts: PlanOptions = {}): Promise<ReturnType<typeof buildSend>> {
    const { account, scan } = await this.requireAccount();
    const feeRate = opts.feeRate ?? (await this.source().estimateFeeSatPerVb());
    if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error("fee rate must be above 0 sat/vB");
    const { reserved, frozen } = await this.blockedOutpoints();
    const skipOutpoints = new Set([...reserved, ...frozen]);
    if (!opts.coins) {
      // Automatic never touches a one-time coin; it is moved by its own sweep.
      for (const u of scan.utxos) if (u.kind === "bip86") skipOutpoints.add(outpointOf(u));
    }
    return buildSend({
      account,
      utxos: scan.utxos,
      destination,
      amount,
      feeRate,
      source: this.source(),
      skipOutpoints,
      include: opts.coins,
      max: opts.max,
    });
  }

  /** Pasting a payment link this wallet created itself. */
  async assertNotOwnLink(destination: string): Promise<void> {
    const request = parseBip21(destination);
    if (!request.pj) return;
    const own = (await this.loadPayjoinSessions()).some((s) => s.pj === request.pj || s.bip21 === request.raw);
    if (own) throw new PolicyError("This is your own payment link. Share it with the person paying you.");
  }

  async plan(destination: string, amount: bigint, opts: PlanOptions = {}): Promise<PlanPayload> {
    await this.assertNotOwnLink(destination);
    return planPayload(await this.planSend(destination, amount, opts));
  }

  async maxAmount(feeRate: number, coins?: string[]): Promise<{ amount: string; fee: string }> {
    const { scan } = await this.requireAccount();
    const { reserved, frozen } = await this.blockedOutpoints();
    const skip = new Set([...reserved, ...frozen]);
    if (!coins) for (const u of scan.utxos) if (u.kind === "bip86") skip.add(outpointOf(u));
    const m = maxSendable(scan.utxos, feeRate, skip, coins);
    return { amount: m.amount.toString(), fee: m.fee.toString() };
  }

  async feeRates(): Promise<FeeRates> {
    return feeRatesOf(this.source());
  }

  async broadcast(
    intent: BroadcastIntent,
    built: Awaited<ReturnType<typeof buildSend>>,
    extra?: { label?: string; feeRate?: number; kind?: HistoryKind },
  ): Promise<BroadcastResult> {
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
      if (extra?.label) this.pendingSendLabels.set(id, extra.label);
      return { kind: "payjoin-pending" };
    }
    const hexTx = built.txHex;
    void psbtForBroadcast(INTENT_SIMPLE_SEND, null, built.psbtBase64);
    const txid = await this.source().broadcast(hexTx);
    await this.afterBroadcast(txid, built, extra?.kind ?? "sent", extra?.label, extra?.feeRate ?? 0);
    await this.saveScan(applyBuiltSend(scan, hexTx, built.ourOutputs));
    return { kind: "txid", txid };
  }

  private pendingSendLabels = new Map<string, string>();

  private async afterBroadcast(
    txid: string,
    built: Awaited<ReturnType<typeof buildSend>>,
    kind: HistoryKind,
    label: string | undefined,
    feeRate: number,
  ): Promise<void> {
    const spent = built.signableInputs.map((u) => `${u.txid}:${u.vout}`);
    const change = built.ourOutputs.map((o) => `${txid}:${o.vout}`);
    let meta = await this.loadCoinMeta();
    const linked = spent.some((op) => meta[op]?.linked) || built.signableInputs.some((u) => u.kind === "bip86");
    if (kind === "self") {
      meta = carryCoinMeta(meta, spent, change);
      if (linked) for (const op of change) meta = setCoinMeta(meta, op, { linked: true });
    } else if (label) {
      for (const op of change) meta = setCoinMeta(meta, op, { label });
    }
    await this.saveCoinMeta(meta);
    const hist = recordBroadcast(await this.loadHistory(), {
      txid,
      kind,
      amount: built.amount,
      fee: built.fee,
      feeRate,
      to: kind === "self" ? undefined : built.request.raw,
      label,
      outpoints: [...spent, ...change],
      change: built.change,
      now: Date.now(),
      linked,
    });
    await this.saveHistory(hist);
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
    const got = await this.loadSealed<ScanStore>(SCAN_KEY, () => emptyScanStore(0));
    return got.value;
  }

  /** Seals the scan store and keeps history in step with it. Requires the wallet to be unlocked. */
  async saveScan(scan: ScanStore): Promise<void> {
    await this.saveSealed(SCAN_KEY, scan);
    await this.onScanSaved(scan);
  }

  private async onScanSaved(scan: ScanStore): Promise<void> {
    const hist = await this.loadHistory();
    const meta = await this.loadCoinMeta();
    const next = deriveHistory(scan, hist, { now: Date.now(), meta });
    await this.saveHistory(next);
    // One-time address: mark funded when its coin shows up, then hide the address.
    const ot = await this.loadOneTime();
    let changed = false;
    let o = ot;
    for (const r of ot.records) {
      const coin = scan.utxos.find((u) => u.kind === "bip86" && u.index === r.index);
      if (!coin) continue;
      if ((r.status === "issued" || r.status === "swept") && !coin.spent) {
        o = setOneTimeStatus(o, r.index, "funded");
        changed = true;
      } else if (r.status === "funded" && coin.spent) {
        o = setOneTimeStatus(o, r.index, "swept");
        changed = true;
      }
    }
    // Restore window: if one of the watched indexes was funded, watch the next one too.
    const windowMax = o.restoredWindow;
    if (windowMax !== undefined && changed) {
      const maxFunded = Math.max(-1, ...o.records.filter((r) => r.status !== "issued" && scan.utxos.some((u) => u.kind === "bip86" && u.index === r.index)).map((r) => r.index));
      const want = maxFunded + ONE_TIME_RESTORE_WINDOW;
      const have = nextOneTimeIndex(o);
      if (want >= have) {
        const session = await loadSession(this.kv);
        if (session) {
          const account = accountFromVault(session);
          let sc = scan;
          for (let i = have; i <= want; i++) {
            const k = account.oneTime(i);
            sc = addWatch(sc, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index: i });
            o = setOneTimeStatus(issueRecord(o, k.address, Date.now(), i), i, "swept");
          }
          await this.saveSealed(SCAN_KEY, sc);
        }
      }
    }
    if (changed) await this.saveOneTime(o);
    // Receiver Payjoin: proposed sessions are done once their output is seen.
    const sessions = await this.loadPayjoinSessions();
    let dirty = false;
    for (const s of sessions) {
      if (s.status !== "proposed") continue;
      if (scan.utxos.some((u) => u.scriptPubKey === s.scriptPubKey || u.scriptPubKey === s.extraScriptPubKey)) {
        s.status = "done";
        dirty = true;
      }
    }
    if (dirty) await this.savePayjoinSessions(sessions);
  }

  async loadHistory(): Promise<HistoryStore> {
    const got = await this.loadSealed<HistoryStore>(HISTORY_KEY, () => emptyHistory(true));
    if (got.status === "unreadable" || got.status === "plain") {
      // Could not read it: start again and rebuild from the scan.
      return emptyHistory(true);
    }
    if (got.status === "missing") return emptyHistory(true);
    return got.value;
  }

  async saveHistory(h: HistoryStore): Promise<void> {
    await this.saveSealed(HISTORY_KEY, h);
  }

  async history(): Promise<{ entries: HistoryEntry[]; rebuilding: boolean }> {
    await this.requireKey();
    const h = await this.loadHistory();
    return { entries: historyList(h), rebuilding: h.rebuilding === true };
  }

  async setActivityLabel(txid: string, label: string | undefined): Promise<void> {
    const clean = label?.replace(/\s+/g, " ").trim().slice(0, 64) || undefined;
    await this.saveHistory(setHistoryLabel(await this.loadHistory(), txid, clean));
  }

  async loadCoinMeta(): Promise<CoinMetaMap> {
    const got = await this.loadSealed<CoinMetaMap>(COINMETA_KEY, () => ({}));
    return got.status === "ok" || got.status === "missing" ? got.value : {};
  }

  async saveCoinMeta(meta: CoinMetaMap): Promise<void> {
    await this.saveSealed(COINMETA_KEY, meta);
  }

  async setCoinMeta(outpoint: string, patch: Partial<CoinMeta>): Promise<void> {
    const { scan } = await this.requireAccount();
    if (!scan.utxos.some((u) => outpointOf(u) === outpoint)) throw new Error("no such coin");
    await this.saveCoinMeta(setCoinMeta(await this.loadCoinMeta(), outpoint, patch));
  }

  async coins(): Promise<CoinView[]> {
    const { scan } = await this.requireAccount();
    const meta = await this.loadCoinMeta();
    const { reserved } = await this.blockedOutpoints();
    return scan.utxos
      .filter((u) => !u.spent)
      .map((u) => {
        const op = outpointOf(u);
        const m = meta[op] ?? {};
        return {
          outpoint: op,
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          height: u.height,
          status: coinStatus(u, meta, reserved),
          label: m.label,
          reason: m.reason,
          linked: m.linked || u.kind === "bip86" || undefined,
          frozen: m.frozen,
          kind: u.kind === "bip86" ? "bip86" : "sp",
          pending: u.height === 0,
        } satisfies CoinView;
      })
      .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  }

  async loadOneTime(): Promise<OneTimeStore> {
    const got = await this.loadSealed<OneTimeStore>(ONETIME_KEY, emptyOneTime);
    return got.status === "ok" || got.status === "missing" ? got.value : emptyOneTime();
  }

  async saveOneTime(o: OneTimeStore): Promise<void> {
    await this.saveSealed(ONETIME_KEY, o);
  }

  /** Issue the next one-time address (never an index twice) and watch it locally. */
  async issueOneTime(): Promise<OneTimeRecord> {
    const { account, scan } = await this.requireAccount();
    const ot = await this.loadOneTime();
    const open = visibleRecord(ot);
    if (open) return open;
    const index = nextOneTimeIndex(ot);
    const k = account.oneTime(index);
    const next = issueRecord(ot, k.address, Date.now(), index);
    await this.saveOneTime(next);
    await this.saveScan(addWatch(scan, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index }));
    return next.records.find((r) => r.index === index)!;
  }

  async oneTimeView(): Promise<{ open?: OneTimeRecord; funded?: { index: number; value: string; outpoint: string; address: string } }> {
    const { scan } = await this.requireAccount();
    const ot = await this.loadOneTime();
    const f = ot.records.find((r) => r.status === "funded");
    let funded;
    if (f) {
      const coin = scan.utxos.find((u) => u.kind === "bip86" && u.index === f.index && !u.spent);
      if (coin) funded = { index: f.index, value: coin.value, outpoint: outpointOf(coin), address: f.address };
    }
    return { open: visibleRecord(ot), funded };
  }

  /** Plan the sweep: only that coin, to our own receive code. Never adds other coins. */
  async planSweep(index: number, feeRate: number): Promise<ReturnType<typeof buildSend>> {
    const { account, scan } = await this.requireAccount();
    const coin = scan.utxos.find((u) => u.kind === "bip86" && u.index === index && !u.spent);
    if (!coin) throw new Error("nothing at this one-time address");
    const { reserved, frozen } = await this.blockedOutpoints();
    const op = outpointOf(coin);
    if (frozen.has(op) || reserved.has(op)) throw new Error("this coin is frozen or reserved");
    return buildSend({
      account,
      utxos: scan.utxos,
      destination: account.receive,
      amount: 0n,
      feeRate,
      source: this.source(),
      skipOutpoints: new Set([...reserved, ...frozen]),
      include: [op],
      max: true,
    });
  }

  async sweepOneTime(index: number, feeRate: number): Promise<BroadcastResult> {
    const built = await this.planSweep(index, feeRate);
    const r = await this.broadcast(INTENT_SIMPLE_SEND, built, { kind: "self", feeRate });
    await this.saveOneTime(setOneTimeStatus(await this.loadOneTime(), index, "swept"));
    return r;
  }

  /** Migration guide: remember which coins exist now, so new ones can be labeled Linked. */
  async startMigration(): Promise<void> {
    const { scan } = await this.requireAccount();
    const ot = await this.loadOneTime();
    if (ot.migration) return;
    await this.saveOneTime({
      ...ot,
      migration: { startedAt: Date.now(), known: scan.utxos.map(outpointOf), fromHeight: scan.lastHeight },
    });
  }

  async migrationStatus(): Promise<{ active: boolean; arrived: CoinView[]; lastHeight: number }> {
    const { scan } = await this.requireAccount();
    const ot = await this.loadOneTime();
    if (!ot.migration) return { active: false, arrived: [], lastHeight: scan.lastHeight };
    const known = new Set(ot.migration.known);
    const coins = await this.coins();
    return { active: true, arrived: coins.filter((c) => !known.has(c.outpoint)), lastHeight: scan.lastHeight };
  }

  /** User confirmed the move: label new coins as Linked to the old wallet address. */
  async finishMigration(label: string): Promise<void> {
    const st = await this.migrationStatus();
    let meta = await this.loadCoinMeta();
    for (const c of st.arrived) meta = setCoinMeta(meta, c.outpoint, { linked: true, label: meta[c.outpoint]?.label ?? label });
    await this.saveCoinMeta(meta);
    const ot = await this.loadOneTime();
    const { migration: _m, ...rest } = ot;
    await this.saveOneTime(rest as OneTimeStore);
  }

  async cancelMigration(): Promise<void> {
    const ot = await this.loadOneTime();
    const { migration: _m, ...rest } = ot;
    await this.saveOneTime(rest as OneTimeStore);
  }

  async loadChain(): Promise<ChainConfig> {
    const got = await this.kv.get([CHAIN_KEY]);
    const stored = got[CHAIN_KEY] as ChainConfig | undefined;
    const migrated = migrateChainConfig(stored ?? DEFAULT_CHAIN);
    const { plain } = splitChainSecrets(migrated);
    const secretsInPlain = !!(stored?.unisatToken || stored?.rpcPassword);
    if (stored && !secretsInPlain && JSON.stringify(stored) !== JSON.stringify(plain)) {
      await this.kv.set({ [CHAIN_KEY]: plain });
    }
    let secrets: ChainSecrets = {};
    const sealed = await this.loadSealed<ChainSecrets>(CHAIN_SECRETS_KEY, () => ({}));
    if (sealed.status === "ok") secrets = sealed.value;
    // Legacy plaintext secrets are still used until the next unlock moves them under encryption.
    this.chainCfg = migrateChainConfig({
      ...plain,
      unisatToken: secrets.unisatToken ?? migrated.unisatToken,
      rpcPassword: secrets.rpcPassword ?? migrated.rpcPassword,
    });
    return this.chainCfg;
  }

  async saveChain(cfg: ChainConfig): Promise<void> {
    const prev = await this.loadChain();
    const next = migrateChainConfig({
      ...cfg,
      rpcPassword: isRedactedSecret(cfg.rpcPassword) ? prev.rpcPassword : cfg.rpcPassword,
      unisatToken: isRedactedSecret(cfg.unisatToken) ? prev.unisatToken : cfg.unisatToken,
    });
    const clearToken = cfg.unisatToken === "";
    const { plain, secrets } = splitChainSecrets(next);
    if (clearToken) delete secrets.unisatToken;
    if (secrets.unisatToken || secrets.rpcPassword || clearToken) {
      await this.saveSealed(CHAIN_SECRETS_KEY, secrets);
    } else {
      const key = await this.dataKey();
      if (key) await this.saveSealed(CHAIN_SECRETS_KEY, {});
    }
    await this.kv.set({ [CHAIN_KEY]: plain });
    this.chainCfg = migrateChainConfig({ ...plain, ...secrets });
  }

  /** Payment links and Payjoin sends for the UI. No keys, no PSBTs. */
  async sessions(): Promise<SessionView[]> {
    const rec = (await this.loadPayjoinSessions()).map((s): SessionView => ({
      role: "receive",
      id: s.id,
      status: s.status,
      error: s.error,
      amount: s.amount,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      bip21: s.status === "waiting" ? s.bip21 : undefined,
      reservedValue: s.reserved?.value,
      reservedOutpoint: s.reserved ? `${s.reserved.txid}:${s.reserved.vout}` : undefined,
    }));
    const snd = (await this.loadPayjoinSends()).map((s): SessionView => ({
      role: "send",
      id: s.id,
      status: s.status,
      error: s.error,
      amount: s.amount,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      destination: s.destination,
      txid: s.txid,
      inputs: s.signableInputs.map((i) => `${i.txid}:${i.vout}`),
    }));
    return [...rec, ...snd].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Cancel a waiting payment link: its keys are deleted and its coin is free again. */
  async cancelLink(id: string): Promise<void> {
    const sessions = await this.loadPayjoinSessions();
    const s = sessions.find((x) => x.id === id);
    if (!s) throw new Error("no such payment link");
    if (s.status !== "waiting") throw new Error("this payment link is not waiting");
    s.status = "failed";
    s.error = "cancelled";
    s.inputSecret = undefined;
    await this.savePayjoinSessions(sessions);
    const all = await this.hpkeSecrets();
    delete all[id];
    await this.kv.set({ [PJ_HPKE]: all });
  }

  /** Delete every privatebit.* key. The caller also clears alarms and reads storage back. */
  async removeWallet(password: string): Promise<void> {
    await this.checkPassword(password);
    this.keyCache = undefined;
    await this.kv.remove(ALL_KEYS);
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
    const frozenOut = frozenOutpoints(await this.loadCoinMeta());
    const spendable = scan.utxos
      .filter(
        (u) =>
          !u.spent &&
          u.kind !== "bip86" &&
          !reservedOut.has(`${u.txid}:${u.vout}`) &&
          !frozenOut.has(`${u.txid}:${u.vout}`),
      )
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
        s.status = "done";
        s.txid = txid;
        try {
          const ours = s.signableInputs.map((u) => `${u.txid}:${u.vout}`);
          const hist = recordBroadcast(await this.loadHistory(), {
            txid,
            kind: "payjoin-sent",
            amount: BigInt(s.amount || "0"),
            fee: 0n,
            feeRate: 0,
            to: s.destination,
            label: this.pendingSendLabels.get(s.id),
            outpoints: ours,
            now: Date.now(),
          });
          const e = hist.entries[txid];
          if (e) delete e.fee;
          await this.saveHistory(hist);
        } catch {
          /* history is best effort; the payment is already broadcast */
        }
        await this.saveScan(await applyTxHex(account, this.source(), scan, signed.txHex, 0));
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
