import * as btc from "@scure/btc-signer";
import { spendSecret, taprootScriptPubKey } from "./bip352.ts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { fromHex, hex, randomBytes } from "./bytes.ts";
import { loadSharedBlock, UnsupportedBlock } from "./blockshare.ts";
import { hintAddressUtxos, openChain, type ChainSource } from "./chain.ts";
import type { Account, ScanAccount } from "./keys.ts";
import { accountFromVault, p2trAddressFromScriptHex, scanAccountFrom } from "./keys.ts";
import {
  DEFAULT_BIRTHDAY,
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
import { RateLimitedError } from "./requests.ts";
import { buildPayjoinProposal, validatePayjoinProposal } from "./payjoin-proposal.ts";
import { mailboxUrls, type MailboxTransport } from "./mailbox.ts";
import type { OhttpKeyConfig } from "./ohttp.ts";
import {
  addWatch,
  noteWatchedOutput,
  applyBuiltSend,
  applyTxHex,
  markAbsentWatchSpent,
  recoverWatchedFromHints,
  confirmPendingUtxos,
  retryDeferred,
  confirmedBalance,
  emptyScanStore,
  pendingBalance,
  spendableBalance,
  applySharedSlice,
  SCAN_BUDGET_MS,
  scanStep,
  withTxHexCache,
  type LabeledUtxo,
  type ScanProgress,
  type ScanStore,
} from "./scan.ts";
import { evenPriv, sessionTweak, tweakSpend } from "./schnorr-util.ts";
import { buildSend, buildSplit, destinationNeedsPayjoin, planPayload, signPayjoinProposal, type PlanPayload } from "./send.ts";
import {
  clearSession,
  loadScanGrant,
  loadSession,
  loadVaultBlob,
  lockVault,
  persistVault,
  SCAN_GRANT_KEY,
  loadVaultBackup,
  restoreVaultBackup,
  saveScanGrant,
  saveSession,
  unlockVault,
  vaultFromMnemonic,
  type Kv,
  type UnlockedVault,
  type VaultBlob,
} from "./vault.ts";
import { createMnemonic } from "./vault.ts";
import { deriveDataKey, deriveScanKey, isSealed, openJson, sealJson } from "./datastore.ts";
import {
  WALLET_SCOPED,
  GLOBAL_KEYS,
  INDEX_KEY,
  LEGACY_ID,
  loadIndex,
  migrateLayout,
  saveIndex,
  scopedKv,
  V1_LIVE_KEYS,
  V1_MOUNTED_KEY,
  v1PackKey,
  walletKeys,
  type WalletEntry,
  type WalletIndex,
} from "./layout.ts";
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
  syncOneTimeWithScan,
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
  /** A replaced vault is still on this computer (one generation). */
  hasBackup?: boolean;
  unlocked: boolean;
  receive?: string;
  birthday?: number;
  lastHeight?: number;
  tip?: number;
  /** The block currently being read, when it is not finished. */
  reading?: { height: number; index: number; count: number };
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
    error?: string;
    id: string;
  };
  oneTimeFunded?: { index: number; value: string; outpoint: string; count: number; total: string };
  historyRebuilding?: boolean;
  hasHistory?: boolean;
  mnemonicWords?: number;
  hasPassphrase?: boolean;
  /** Wallets saved on this computer. One is open. */
  wallets?: { id: string; name: string; active: boolean; birthday: number; words?: number; hasPassphrase?: boolean; checked?: number }[];
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
  /** When this wallet last asked the mailbox. */
  checkedAt?: number;
  /** Send role: coins the signed original spends. Sending without Payjoin must reuse them. */
  inputs?: string[];
};

export type BroadcastResult = { kind: "txid"; txid: string } | { kind: "payjoin-pending" };

export const FOLLOW_TIP_STEPS = 24;

const PJ_SESSIONS = "privatebit.pj.sessions";

/** A mailbox or network miss should be tried again. A bad proposal should not. */
function payjoinRetryable(message: string): boolean {
  return /mailbox|failed to fetch|fetch failed|network|timeout|timed out|abort|429|503|rate limit|ECONN|ENOTFOUND/i.test(message);
}

const SCAN_KEY = "privatebit.scan";
const CHAIN_KEY = "privatebit.chain";
const CHAIN_SECRETS_KEY = "privatebit.chain.secrets";
const HISTORY_KEY = "privatebit.history";
const COINMETA_KEY = "privatebit.coinmeta";
const ONETIME_KEY = "privatebit.onetime";
/** Sealed with the scan key, which block matching keeps after Lock. Everything else uses the data key. */
const SCAN_SEALED = new Set([SCAN_KEY, CHAIN_SECRETS_KEY]);
const PJ_SEND = "privatebit.pj.send";
const PJ_HPKE = "privatebit.pj.hpke";
const SEND_HPKE_PREFIX = "send:";
const ORIGINAL_PREFIX = "orig:";
const P2TR_NETWORK: typeof btc.NETWORK = {
  bech32: FRACTAL.bech32,
  pubKeyHash: FRACTAL.pubKeyHash,
  scriptHash: FRACTAL.scriptHash,
  wif: FRACTAL.wif,
};

function encodeP2tr(xonly: Uint8Array): string {
  return btc.Address(P2TR_NETWORK).encode({ type: "tr", pubkey: xonly });
}

type ScanMark = { epoch: number; spendPub: string };

/** Test hooks shared by every wallet on one PrivateBit. */
export type CoreHooks = {
  /** Tests inject MemoryDirectory.ohttpTransport(). Production uses fetch. */
  mailboxTransport?: MailboxTransport;
  /** Tests inject the directory's OHTTP public config so RK URIs include OH. */
  ohttpConfig?: OhttpKeyConfig;
  /** Tests inject a mock chain. Production uses UniSat / Core. */
  sourceOverride?: ChainSource;
};

/**
 * One wallet. Its Kv is scoped to its own namespace (layout.ts), so everything it reads and
 * writes, including from a scan or Payjoin that outlives a switch, stays inside that wallet.
 * PrivateBit (below) owns the directory and decides which WalletCore is open.
 */
export class WalletCore {
  constructor(
    readonly kv: Kv,
    public chainCfg: ChainConfig = DEFAULT_CHAIN,
    readonly hooks: CoreHooks = {},
    readonly walletId: string = LEGACY_ID,
  ) {}

  get mailboxTransport(): MailboxTransport | undefined {
    return this.hooks.mailboxTransport;
  }
  get ohttpConfig(): OhttpKeyConfig | undefined {
    return this.hooks.ohttpConfig;
  }
  set ohttpConfig(v: OhttpKeyConfig | undefined) {
    this.hooks.ohttpConfig = v;
  }
  get sourceOverride(): ChainSource | undefined {
    return this.hooks.sourceOverride;
  }

  /** Lock and drop the scan grant: only the open wallet matches blocks. */
  async closeForSwitch(): Promise<void> {
    await this.lock();
    await this.kv.remove([SCAN_GRANT_KEY]);
    this.close();
  }

  /** Bumped by PrivateBit when this wallet is closed, so its scan stops at the next check. */
  close(): void {
    this.walletEpoch += 1;
    this.keyCache = undefined;
    this.grantCache = undefined;
    this.sessionCache = undefined;
    this.accountCache = undefined;
    this.scanHex = undefined;
  }

  /** Keys for the unlocked wallet, derived once per session. Dropped at Lock. */
  private keyCache?: { sig: string; key: Uint8Array; scanKey: Uint8Array; spendPub: string };
  /** Scan-only keys read from the grant after Lock. Can find coins, cannot spend or read history. */
  private grantCache?: { sig: string; key: Uint8Array; account: ScanAccount; birthday: number; spendPub: string };
  /** Serializes scan read-modify-write so a broadcast cannot be overwritten by an older scan. */
  private scanTail: Promise<void> = Promise.resolve();
  private scanDepth = 0;
  /** Bumped when the open wallet changes, so a scan of the previous one cannot write over the new one. */
  private walletEpoch = 0;
  /** Address hints and Payjoin are not checked on every block slice. */
  private sideWorkAt = 0;
  private scanHex?: { cfg: ChainConfig; source: ChainSource };
  private pjTail: Promise<unknown> = Promise.resolve();

  /** One hex cache for the whole catch-up, so parent transactions are not downloaded again every pass. */
  private cachedScanSource(): ChainSource {
    if (!this.scanHex || this.scanHex.cfg !== this.chainCfg) {
      this.scanHex = { cfg: this.chainCfg, source: withTxHexCache(this.source(), 4096) };
    }
    return this.scanHex.source;
  }

  private enqueueScan<T>(fn: () => Promise<T>): Promise<T> {
    if (this.scanDepth > 0) return fn();
    const run = this.scanTail.then(async () => {
      this.scanDepth += 1;
      try {
        return await fn();
      } finally {
        this.scanDepth -= 1;
      }
    });
    this.scanTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Session words turned into a seed once (BIP39 PBKDF2 is slow), reused until the session changes. */
  private sessionCache?: { raw: string; vault: UnlockedVault };

  private async session(): Promise<UnlockedVault | null> {
    const raw = (await this.kv.get(["privatebit.session"]))["privatebit.session"];
    if (!raw) {
      this.sessionCache = undefined;
      return null;
    }
    const text = JSON.stringify(raw);
    if (this.sessionCache?.raw === text) return this.sessionCache.vault;
    const vault = await loadSession(this.kv);
    if (!vault) return null;
    this.sessionCache = { raw: text, vault };
    return vault;
  }

  /** Full account (spend key included) derived once per session. */
  private accountCache?: { vault: UnlockedVault; account: Account };
  private accountOf(vault: UnlockedVault): Account {
    if (this.accountCache?.vault === vault) return this.accountCache.account;
    const account = accountFromVault(vault);
    this.accountCache = { vault, account };
    return account;
  }

  private keysFor(session: UnlockedVault): NonNullable<WalletCore["keyCache"]> {
    const sig = `${session.mnemonic}\n${session.passphrase}`;
    const c = this.keyCache;
    if (c && c.sig === sig) return c;
    const account = this.accountOf(session);
    const next = { sig, key: deriveDataKey(session.seed), scanKey: deriveScanKey(session.seed), spendPub: hex(account.spendPub) };
    this.keyCache = next;
    return next;
  }

  /** Data key for history, labels, frozen marks and Payjoin. Only while unlocked. */
  async dataKey(): Promise<Uint8Array | null> {
    const session = await this.session();
    if (!session) {
      this.keyCache = undefined;
      return null;
    }
    return this.keysFor(session).key;
  }

  /** Scan-only keys kept for matching after Lock. */
  private async grant(): Promise<NonNullable<WalletCore["grantCache"]> | null> {
    const g = await loadScanGrant(this.kv);
    if (!g) {
      this.grantCache = undefined;
      return null;
    }
    const sig = `${g.scanKey}:${g.spendPub}:${g.birthday}`;
    if (this.grantCache?.sig === sig) return this.grantCache;
    this.grantCache = {
      sig,
      key: fromHex(g.scanKey),
      account: scanAccountFrom(fromHex(g.scanSecret), fromHex(g.spendPub)),
      birthday: g.birthday,
      spendPub: g.spendPub,
    };
    return this.grantCache;
  }

  /** Key for the coin list and chain settings. Unlocked, or after Lock from the scan grant. */
  async scanKey(): Promise<Uint8Array | null> {
    const session = await this.session();
    if (session) return this.keysFor(session).scanKey;
    return (await this.grant())?.key ?? null;
  }

  /** Leave only what matching needs for after Lock. Never the words, seed or spend secret. */
  private async writeGrant(unlocked: UnlockedVault): Promise<void> {
    const account = accountFromVault(unlocked);
    await saveScanGrant(this.kv, {
      v: 2,
      scanSecret: hex(account.scanSecret),
      spendPub: hex(account.spendPub),
      scanKey: hex(deriveScanKey(unlocked.seed)),
      birthday: unlocked.birthday,
    });
    this.grantCache = undefined;
  }

  private async keyFor(name: string): Promise<Uint8Array | null> {
    return SCAN_SEALED.has(name) ? this.scanKey() : this.dataKey();
  }

  private async requireKey(name = HISTORY_KEY): Promise<Uint8Array> {
    const k = await this.keyFor(name);
    if (!k) throw new Error("locked");
    return k;
  }

  private async loadSealed<T>(name: string, fallback: () => T): Promise<{ value: T; status: "ok" | "missing" | "unreadable" | "plain" }> {
    const raw = (await this.kv.get([name]))[name];
    if (raw === undefined || raw === null) return { value: fallback(), status: "missing" };
    if (!isSealed(raw)) return { value: raw as T, status: "plain" };
    const key = await this.keyFor(name);
    if (key) {
      try {
        return { value: openJson<T>(key, name, raw), status: "ok" };
      } catch {
        /* older builds sealed everything with the data key */
      }
    }
    if (SCAN_SEALED.has(name)) {
      const legacy = await this.dataKey();
      if (legacy) {
        try {
          const value = openJson<T>(legacy, name, raw);
          const scanKey = await this.scanKey();
          if (scanKey) await this.kv.set({ [name]: sealJson(scanKey, name, value) });
          return { value, status: "ok" };
        } catch {
          /* unreadable below */
        }
      }
    }
    return { value: fallback(), status: "unreadable" };
  }

  private async saveSealed(name: string, value: unknown): Promise<void> {
    const key = await this.requireKey(name);
    await this.kv.set({ [name]: sealJson(key, name, value) });
  }

  /**
   * Move data written by older versions in plaintext under encryption. Runs on every unlock,
   * create and restore. Existing coins are kept: the plaintext scan is read, sealed and only
   * then overwritten, so nothing is lost if the worker stops halfway.
   */
  async migrateAtRest(): Promise<{ scan: boolean; chain: boolean }> {
    const key = await this.scanKey();
    if (!key || !(await this.dataKey())) return { scan: false, chain: false };
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

  private async loadOriginal(id: string): Promise<string | undefined> {
    const raw = await this.loadHpkeSecret(ORIGINAL_PREFIX + id);
    return raw ? new TextDecoder().decode(raw) : undefined;
  }

  private async saveOriginal(id: string, psbt: string): Promise<void> {
    await this.saveHpkeSecret(ORIGINAL_PREFIX + id, new TextEncoder().encode(psbt));
  }

  private async clearHpkeSecrets(): Promise<void> {
    await this.kv.remove([PJ_HPKE]);
  }

  source(): ChainSource {
    return this.sourceOverride ?? openChain(this.chainCfg);
  }

  async state(): Promise<WalletState> {
    const blob = await loadVaultBlob(this.kv);
    const session = await this.session();
    const hasBackup = !!(await loadVaultBackup(this.kv));
    if (!blob) {
      return { hasVault: false, hasBackup, unlocked: false, chain: redactChain(this.chainCfg) };
    }
    if (!session) {
      // Nothing about coins, codes or progress is shown before unlock.
      return {
        hasVault: true,
        hasBackup,
        unlocked: false,
        chain: redactChain(this.chainCfg),
      };
    }
    const scan = await this.loadScan();
    const account = this.accountOf(session);
    const meta = await this.loadCoinMeta();
    const frozen = frozenOutpoints(meta);
    const unspent = scan.utxos.filter((u) => !u.spent);
    const notFrozen = unspent.filter((u) => !frozen.has(outpointOf(u)));
    const sum = (list: typeof unspent): bigint => list.reduce((a, u) => a + BigInt(u.value), 0n);
    const pending = sum(notFrozen.filter((u) => u.height === 0));
    const confirmed = sum(notFrozen.filter((u) => u.height > 0));
    await this.closeExpired();
    const receive = (await this.loadPayjoinSessions()).filter(
      (s) => s.status === "proposed" || (s.status === "waiting" && s.expiresAt > Date.now()),
    );
    const live = receive[receive.length - 1];
    const sending = (await this.loadPayjoinSends()).filter((s) => s.status === "waiting" && s.expiresAt > Date.now()).pop();
    const hist = await this.loadHistory();
    const ot = await this.loadOneTime();
    const oneTimeCoins = unspent.filter((u) => u.kind === "bip86" && ot.records.some((r) => r.index === u.index));
    let oneTimeFunded: WalletState["oneTimeFunded"];
    const first = oneTimeCoins[0];
    if (first?.index !== undefined) {
      const total = oneTimeCoins.reduce((a, u) => a + BigInt(u.value), 0n);
      oneTimeFunded = {
        index: first.index,
        value: first.value,
        outpoint: outpointOf(first),
        count: oneTimeCoins.length,
        total: total.toString(),
      };
    }
    const words = session.mnemonic.trim().split(/\s+/).length;
    return {
      hasVault: true,
      hasBackup,
      unlocked: true,
      receive: account.receive,
      birthday: session.birthday,
      lastHeight: scan.lastHeight,
      tip: scan.tip,
      reading: scan.inflight
        ? {
            height: scan.inflight.height,
            index: scan.inflight.nextTx,
            count: scan.inflight.txCount ?? scan.inflight.txids.length,
          }
        : undefined,
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
          ? "Waiting for them to pay. Stay unlocked. Don't lock. You don't confirm anything."
          : live?.status === "proposed"
            ? "They paid. Your coin is added. Stay unlocked. Don't lock."
            : sending
              ? "Waiting for them to add an input. Stay unlocked. Don't lock."
              : undefined,
      payjoin: live
        ? { role: "receive", status: live.status, amount: live.amount, expiresAt: live.expiresAt, createdAt: live.createdAt, id: live.id, error: live.error }
        : sending
          ? { role: "send", status: sending.status, amount: sending.amount, expiresAt: sending.expiresAt, createdAt: sending.createdAt, id: sending.id, error: sending.error }
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
    const mnemonic = createMnemonic(256);
    if (args.words === 12) throw new Error("A new wallet uses 24 words.");
    const unlocked = vaultFromMnemonic({
      mnemonic,
      passphrase: args.passphrase,
      birthday: args.birthday,
    });
    const blob = lockVault(unlocked, args.password);
    await persistVault(this.kv, blob);
    await saveSession(this.kv, unlocked);
    await this.writeGrant(unlocked);
    await this.saveHistory(emptyHistory());
    await this.saveScan(emptyScanStore(args.birthday));
    return mnemonic;
  }

  /**
   * Create from words the user has already written down and checked (screen 05). Nothing is
   * saved before this call, so closing the popup during backup leaves no wallet behind.
   */
  async createChecked(args: { mnemonic: string; password: string; passphrase?: string; birthday: number; name?: string }): Promise<void> {
    if (args.birthday <= 0) throw new Error("birthday height required (Fractal tip is past 2M; 0 is genesis)");
    if (await loadVaultBlob(this.kv)) {
      throw new Error("A wallet is already on this computer. Unlock it, or restore from recovery words.");
    }
    const unlocked = vaultFromMnemonic(args);
    if (unlocked.mnemonic.trim().split(/\s+/).length !== 24) throw new Error("A new wallet uses 24 words.");
    const blob = lockVault(unlocked, args.password);
    await persistVault(this.kv, blob);
    await saveSession(this.kv, unlocked);
    await this.writeGrant(unlocked);
    await this.kv.remove([HISTORY_KEY, COINMETA_KEY, ONETIME_KEY]);
    await this.saveHistory(emptyHistory());
    await this.saveScan(emptyScanStore(args.birthday));
  }

  private restoredScan(account: Account, birthday: number): { scan: ScanStore; ot: OneTimeStore } {
    let scan = emptyScanStore(birthday);
    let ot = emptyOneTime();
    for (let i = 0; i < ONE_TIME_RESTORE_WINDOW; i++) {
      const k = account.oneTime(i);
      scan = addWatch(scan, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index: i });
      ot = setOneTimeStatus(issueRecord(ot, k.address, Date.now(), i), i, "swept");
    }
    return { scan, ot: { ...ot, restoredWindow: ONE_TIME_RESTORE_WINDOW } };
  }

  async restore(args: {
    mnemonic: string;
    password: string;
    passphrase?: string;
    birthday: number;
    name?: string;
  }): Promise<void> {
    if (args.birthday <= 0) throw new Error("birthday height required (Fractal tip is past 2M; 0 is genesis)");
    const unlocked = vaultFromMnemonic(args);
    const blob = lockVault(unlocked, args.password);
    // Restoring over a different wallet keeps that one as the previous vault (one generation).
    await persistVault(this.kv, blob, { keepPrevious: true });
    await saveSession(this.kv, unlocked);
    await this.writeGrant(unlocked);
    // History is rebuilt from the scan; typed labels cannot come back.
    await this.kv.remove([HISTORY_KEY, COINMETA_KEY, ONETIME_KEY]);
    await this.saveHistory(emptyHistory(true));
    const seeded = this.restoredScan(accountFromVault(unlocked), args.birthday);
    await this.saveOneTime(seeded.ot);
    await this.saveScan(seeded.scan);
  }

  /** Birthday is plaintext on the vault blob. Rewinds scan so that height is scanned again. */
  async setBirthday(birthday: number): Promise<void> {
    if (birthday <= 0) throw new Error("birthday height required (Fractal tip is past 2M; 0 is genesis)");
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    await persistVault(this.kv, { ...blob, birthday });
    const session = await this.session();
    if (session) {
      await saveSession(this.kv, { ...session, birthday });
      await this.writeGrant({ ...session, birthday });
    }
    const prev = await this.loadScan();
    let next = emptyScanStore(birthday);
    for (const w of prev.watch ?? []) next = addWatch(next, w);
    await this.saveScan(next);
  }

  async unlock(password: string): Promise<void> {
    this.sideWorkAt = 0;
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    const unlocked = unlockVault(blob, password);
    await saveSession(this.kv, unlocked);
    await this.writeGrant(unlocked);
    await this.retireStaleBackup(unlocked, password);
    await this.migrateAtRest();
  }

  /** Check the password without changing anything (backup screen, remove wallet). */
  async checkPassword(password: string): Promise<UnlockedVault> {
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    return unlockVault(blob, password);
  }

  /**
   * The old password stops working everywhere: the vault is rewritten without keeping a copy,
   * and an earlier copy of this same wallet (left by older builds) is deleted. A previous
   * different wallet that used the same password is moved to the new password too.
   */
  async changePassword(current: string, next: string): Promise<void> {
    if (next.length < 8) throw new Error("password too short");
    const unlocked = await this.checkPassword(current);
    await persistVault(this.kv, lockVault(unlocked, next));
    const bak = await loadVaultBackup(this.kv);
    if (!bak) return;
    let old: UnlockedVault;
    try {
      old = unlockVault(bak, current);
    } catch {
      return; // a different wallet with its own password
    }
    if (old.mnemonic === unlocked.mnemonic && old.passphrase === unlocked.passphrase) {
      await this.kv.remove(["privatebit.vault.bak"]);
    } else {
      await this.kv.set({ "privatebit.vault.bak": lockVault(old, next) });
    }
  }

  /** Older builds kept a copy of this same wallet after a password change. It is not a previous wallet. */
  private async retireStaleBackup(unlocked: UnlockedVault, password: string): Promise<void> {
    const bak = await loadVaultBackup(this.kv);
    if (!bak) return;
    try {
      const old = unlockVault(bak, password);
      if (old.mnemonic === unlocked.mnemonic && old.passphrase === unlocked.passphrase) {
        await this.kv.remove(["privatebit.vault.bak"]);
      }
    } catch {
      /* a different password: keep it, the user decides */
    }
  }

  /**
   * Lock drops the words, the seed, the spend key and the data key. Only the scan grant stays
   * (session storage), so new payments are still found; history and labels cannot be read.
   */
  async lock(): Promise<void> {
    if (await this.dataKey()) {
      try {
        await this.onScanSaved(await this.loadScan());
      } catch {
        /* history is rebuilt at the next unlock */
      }
    }
    this.keyCache = undefined;
    this.sessionCache = undefined;
    this.accountCache = undefined;
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
    const vault = await this.session();
    if (!vault) throw new Error("locked");
    return { vault, account: this.accountOf(vault), scan: await this.loadScan() };
  }

  async scanOnce(): Promise<ScanProgress> {
    return this.enqueueScan(() => this.scanOnceUnlocked());
  }

  private async scanStillHere(mark: ScanMark): Promise<boolean> {
    if (mark.epoch !== this.walletEpoch) return false;
    const session = await this.session();
    if (session) return this.keysFor(session).spendPub === mark.spendPub;
    const grant = await this.grant();
    return !!grant && grant.spendPub === mark.spendPub;
  }

  private async scanOnceUnlocked(): Promise<ScanProgress> {
    const epoch = this.walletEpoch;
    const idle: ScanProgress = { done: false, lastHeight: 0, tip: 0, height: 0, txIndex: 0, txCount: 0, skipped: 0 };
    const session = await this.session();
    const full = session ? this.accountOf(session) : undefined;
    const grant = full ? null : await this.grant();
    const account: ScanAccount | undefined = full ?? grant?.account;
    if (!account) return idle;
    {
    const scan = await this.loadScan();
    const mark: ScanMark = { epoch, spendPub: hex(account.spendPub) };
    const stopped = (): ScanProgress => ({
      done: false,
      lastHeight: scan.lastHeight,
      tip: scan.tip ?? scan.lastHeight,
      height: scan.lastHeight,
      txIndex: 0,
      txCount: 0,
      skipped: 0,
    });
    if (mark.epoch !== this.walletEpoch) return stopped();
    const source = this.cachedScanSource();
    const tip = await source.getTip();
    if (mark.epoch !== this.walletEpoch) return stopped();
    const started = Date.now();
    let store = await this.loadScan();
    if (started - this.sideWorkAt >= 20_000) {
      this.sideWorkAt = started;
      store = await this.loadScan();
      if (full) store = await this.ensureOneTimeWatches(full, store);
      store = await this.recoverWatches(account, source, store);
      if (full) store = await this.recoverOwnBroadcasts(full, source, store);
      store = await retryDeferred(account, source, store);
      store = await confirmPendingUtxos(source, store);
      if (!(await this.scanStillHere(mark))) return stopped();
      await this.saveScan(store, mark);
    }
    let progress: ScanProgress | undefined;
    let saved = true;
    let lastPersist = started;
    let sharedHeight = -1;
    let shared: Awaited<ReturnType<typeof loadSharedBlock>> | undefined;
    let ahead: { height: number; block: Promise<Awaited<ReturnType<typeof loadSharedBlock>>> } | undefined;
    if ((store.inflight?.txids.length ?? 0) > 0) store = { ...store, inflight: undefined };
    do {
      if (mark.epoch !== this.walletEpoch) return progress ?? stopped();
      const cursor = `${store.lastHeight}:${store.inflight?.height ?? ""}:${store.inflight?.nextTx ?? ""}`;
      const height = store.inflight?.height ?? store.lastHeight + 1;
      const legacy = (store.inflight?.txids.length ?? 0) > 0;
      if (!legacy && height <= tip.height && sharedHeight !== height) {
        try {
          if (store.inflight?.height !== height) {
            store = { ...store, tip: tip.height, inflight: { height, nextTx: 0, txids: [], txCount: 0 } };
            if (await this.scanStillHere(mark)) await this.saveScan(store, mark);
          }
          const queued = ahead?.height === height ? ahead.block : undefined;
          if (ahead?.height === height) ahead = undefined;
          shared = queued ? await queued : await loadSharedBlock(height, source);
          sharedHeight = height;
          if (height + 1 <= tip.height) {
            const next = height + 1;
            const block = loadSharedBlock(next, source);
            void block.catch(() => {});
            ahead = { height: next, block };
          }
        } catch (e) {
          if (e instanceof RateLimitedError) throw e;
          if (!(e instanceof UnsupportedBlock)) throw e;
          shared = undefined;
          sharedHeight = height;
        }
      }
      const step =
        !legacy && shared && shared.height === height
          ? applySharedSlice(
              account,
              store,
              shared,
              store.inflight?.height === height ? store.inflight.nextTx : 0,
              tip.height,
            )
          : await scanStep(account, source, store, tip.height);
      store = step.store;
      progress = step.progress;
      if (mark.epoch !== this.walletEpoch) return progress;
      const nowMs = Date.now();
      if (progress.done || nowMs - lastPersist >= 1_000 || nowMs - started >= SCAN_BUDGET_MS) {
        await this.saveScan(store, mark);
        lastPersist = nowMs;
        saved = true;
      } else {
        saved = false;
      }
      const now = `${store.lastHeight}:${store.inflight?.height ?? ""}:${store.inflight?.nextTx ?? ""}`;
      if (now === cursor) break;
    } while (!progress.done && Date.now() - started < SCAN_BUDGET_MS);
    if (!saved && (await this.scanStillHere(mark))) await this.saveScan(store, mark);
    return progress ?? stopped();
    }
  }

  /** Known scripts (one-time, Payjoin) via indexer hints, then raw tx hex. SP scan stays sequential. */
  private async recoverWatches(account: ScanAccount, source: ChainSource, store: ScanStore): Promise<ScanStore> {
    const watch = store.watch ?? [];
    if (!watch.length) return store;
    const hints: { txid: string; height: number }[] = [];
    const seen = new Set<string>();
    let next = store;
    for (const w of watch) {
      const addr = p2trAddressFromScriptHex(w.scriptPubKey);
      if (!addr) continue;
      let rows: { txid: string; height: number; vout?: number; value?: string; scriptPubKey?: string }[];
      try {
        rows = await hintAddressUtxos(this.chainCfg, addr);
      } catch {
        continue;
      }
      const unspent = new Set(rows.filter((h) => h.scriptPubKey).map((h) => h.txid));
      if (unspent.size) next = markAbsentWatchSpent(next, w.scriptPubKey, unspent);
      for (const h of rows) {
        if (h.scriptPubKey && h.vout !== undefined && h.value !== undefined) {
          next = noteWatchedOutput(next, {
            txid: h.txid,
            vout: h.vout,
            value: h.value,
            scriptPubKey: h.scriptPubKey,
            height: h.height,
          });
        }
        if (seen.has(h.txid)) continue;
        seen.add(h.txid);
        hints.push(h);
      }
    }
    if (!hints.length) return next;
    return recoverWatchedFromHints(account, source, next, hints);
  }

  /** One-time records stay watched even if an earlier scan store was replaced. */
  private async ensureOneTimeWatches(account: Account, store: ScanStore): Promise<ScanStore> {
    const ot = await this.loadOneTime();
    const indexes = new Set(ot.records.map((r) => r.index));
    if (ot.restoredWindow !== undefined) {
      for (let i = 0; i < ot.restoredWindow; i++) indexes.add(i);
    }
    let next = store;
    for (const index of indexes) {
      const k = account.oneTime(index);
      if ((next.watch ?? []).some((w) => w.scriptPubKey === k.scriptPubKey)) continue;
      next = addWatch(next, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index });
    }
    return next;
  }

  /** Pull txs this wallet broadcast back in, so a sweep is not stuck at height 0 behind the block scan. */
  private async recoverOwnBroadcasts(account: Account, source: ChainSource, store: ScanStore): Promise<ScanStore> {
    const hist = await this.loadHistory();
    let next = store;
    let n = 0;
    for (const e of Object.values(hist.entries)) {
      if (!e.fromWallet || n >= 8) continue;
      const outs = next.utxos.filter((u) => u.txid === e.txid);
      const ins = next.utxos.filter((u) => u.spentBy === e.txid);
      const pending = outs.some((u) => u.height === 0) || ins.some((u) => !(u.spentHeight && u.spentHeight > 0));
      const missingOut = outs.length === 0;
      const missingIn = ins.length === 0 && (e.kind === "self" || e.kind === "split" || e.kind === "sent" || e.kind === "payjoin-sent");
      if (!missingOut && !missingIn && !pending) continue;
      n += 1;
      try {
        const hexTx = await source.getTxHex(e.txid);
        const height = source.getTxHeight ? ((await source.getTxHeight(e.txid)) ?? 0) : 0;
        next = await applyTxHex(account, source, next, hexTx, height);
      } catch {
        /* next scan tries again */
      }
    }
    return next;
  }

  /** Needs the previous wallet's password. */
  async restoreBackup(password: string): Promise<void> {
    await restoreVaultBackup(this.kv, password);
    this.keyCache = undefined;
    this.grantCache = undefined;
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
    const receive = await this.loadPayjoinSessions();
    const reserved = new Set(
      receive
        .filter((s) => s.status === "waiting" && s.reserved)
        .map((s) => `${s.reserved!.txid}:${s.reserved!.vout}`),
    );
    const sends = await this.loadPayjoinSends();
    for (const s of sends) {
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

  /** Pasting a payment link this wallet created itself. Another wallet's link is not this one. */
  async assertNotOwnLink(destination: string): Promise<void> {
    const request = parseBip21(destination);
    if (!request.pj) return;
    const { account } = await this.requireAccount();
    const rk = request.receiverKey ? hex(request.receiverKey).toLowerCase() : "";
    void account;
    const own = (await this.loadPayjoinSessions()).some((s) => {
      if (rk && s.hpkePub && s.hpkePub.toLowerCase() === rk) return true;
      return s.pj === request.pj || s.bip21 === request.raw;
    });
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
    await this.requireAccount();
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
    await this.enqueueScan(async () => {
      await this.afterBroadcast(txid, built, extra?.kind ?? "sent", extra?.label, extra?.feeRate ?? 0);
      const fresh = await this.loadScan();
      let next = applyBuiltSend(fresh, hexTx, built.ourOutputs);
      const readHeight = this.source().getTxHeight;
      const height = readHeight ? await readHeight.call(this.source(), txid).catch(() => null) : null;
      if (height && height > 0) {
        next = {
          ...next,
          utxos: next.utxos.map((u) => {
            if (u.txid === txid) return { ...u, height };
            if (u.spentBy === txid) return { ...u, spentHeight: height };
            return u;
          }),
        };
      }
      await this.saveScan(next);
    });
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
    if (kind === "self" || kind === "split") {
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
      to: kind === "self" || kind === "split" ? undefined : built.request.raw,
      label,
      outpoints: [...spent, ...change],
      change: built.change,
      now: Date.now(),
      linked,
      pieces: kind === "split" ? built.ourOutputs.length : undefined,
    });
    await this.saveHistory(hist);
  }

  /** Scan newly indexed heights. One call already spends the catch-up budget. */
  async followTip(_maxSteps = FOLLOW_TIP_STEPS): Promise<ScanProgress> {
    return this.enqueueScan(async () => {
      try {
        await this.servicePayjoin();
      } catch {
        /* locked or no directory; finding coins must not wait on the mailbox */
      }
      return this.scanOnceUnlocked();
    });
  }

  /** True while this wallet can match blocks. Lock leaves this on until the browser quits or you switch. */
  async canIndex(): Promise<boolean> {
    if (await this.session()) return true;
    return !!(await loadScanGrant(this.kv));
  }

  /** True while this wallet still has blocks to match. */
  async catchingUp(): Promise<boolean> {
    if (!(await this.canIndex())) return false;
    const scan = await this.loadScan();
    if (scan.tip === undefined) return false;
    return !!scan.inflight || scan.lastHeight < scan.tip;
  }

  private async noteChecked(height: number): Promise<void> {
    const index = await loadIndex(this.kv);
    if (!index) return;
    const row = index.wallets.find((w) => w.id === this.walletId);
    if (!row || row.checked === height) return;
    row.checked = height;
    await saveIndex(this.kv, index);
  }

  async loadScan(): Promise<ScanStore> {
    const session = await this.session();
    const grant = session ? null : await this.grant();
    const birthday = session?.birthday ?? grant?.birthday ?? DEFAULT_BIRTHDAY;
    const got = await this.loadSealed<ScanStore>(SCAN_KEY, () => emptyScanStore(birthday));
    if (got.status === "missing" || got.status === "unreadable") return emptyScanStore(birthday);
    return got.value;
  }

  /** Seals the scan store and keeps history in step with it. Requires the wallet to be unlocked. */
  async saveScan(scan: ScanStore, mark?: ScanMark): Promise<void> {
    if (mark && !(await this.scanStillHere(mark))) return;
    if (!(await this.dataKey())) {
      // Locked: the coin list moves on; history and one-time records catch up at unlock.
      await this.saveSealed(SCAN_KEY, scan);
      await this.noteChecked(scan.lastHeight);
      return;
    }
    const ot = await this.loadOneTime();
    const synced = syncOneTimeWithScan(scan, ot);
    const next: ScanStore = synced.changedOt || synced.utxosSpent.some((s, i) => s !== scan.utxos[i]?.spent)
      ? { ...scan, utxos: scan.utxos.map((u, i) => (synced.utxosSpent[i] === u.spent ? u : { ...u, spent: synced.utxosSpent[i]! })) }
      : scan;
    if (mark && !(await this.scanStillHere(mark))) return;
    if (synced.changedOt) await this.saveOneTime({ ...ot, records: synced.records });
    if (mark && !(await this.scanStillHere(mark))) return;
    await this.saveSealed(SCAN_KEY, next);
    if (mark && !(await this.scanStillHere(mark))) return;
    await this.noteChecked(next.lastHeight);
    if (mark && !(await this.scanStillHere(mark))) return;
    await this.onScanSaved(next);
  }

  private async onScanSaved(scan: ScanStore): Promise<void> {
    const hist = await this.loadHistory();
    const meta = await this.loadCoinMeta();
    const next = deriveHistory(scan, hist, { now: Date.now(), meta });
    await this.saveHistory(next);
    // Address status is decided in saveScan. A restored wallet watches further indexes
    // once a coin is actually sitting at one of the earlier ones.
    const ot = await this.loadOneTime();
    const windowMax = ot.restoredWindow;
    if (windowMax !== undefined) {
      const withCoin = ot.records.filter((r) => scan.utxos.some((u) => u.kind === "bip86" && u.index === r.index && !u.spent));
      const maxFunded = withCoin.length ? Math.max(...withCoin.map((r) => r.index)) : -1;
      const want = maxFunded + ONE_TIME_RESTORE_WINDOW;
      const have = nextOneTimeIndex(ot);
      if (maxFunded >= 0 && want >= have) {
        const session = await this.session();
        if (session) {
          const account = this.accountOf(session);
          let sc = scan;
          let o = ot;
          for (let i = have; i <= want; i++) {
            const k = account.oneTime(i);
            sc = addWatch(sc, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index: i });
            o = setOneTimeStatus(issueRecord(o, k.address, Date.now(), i), i, "swept");
          }
          await this.saveSealed(SCAN_KEY, sc);
          await this.saveOneTime(o);
        }
      }
    }
    // Receiver Payjoin: proposed sessions are done once their output is seen.
    const sessions = await this.loadPayjoinSessions();
    let dirty = false;
    for (const s of sessions) {
      if (s.status !== "proposed") continue;
      const hit = scan.utxos.find((u) => u.scriptPubKey === s.scriptPubKey || u.scriptPubKey === s.extraScriptPubKey);
      if (hit) {
        s.status = "done";
        s.txid = hit.txid;
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
    await this.requireKey(HISTORY_KEY);
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
    const index = open?.index ?? nextOneTimeIndex(ot);
    const k = account.oneTime(index);
    const next = open ? ot : issueRecord(ot, k.address, Date.now(), index);
    if (!open) await this.saveOneTime(next);
    const watched = addWatch(scan, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index });
    await this.saveScan(watched);
    try {
      await this.saveScan(await this.recoverWatches(account, this.source(), watched));
    } catch {
      /* sequential scan still runs */
    }
    return next.records.find((r) => r.index === index)!;
  }

  async oneTimeView(): Promise<{
    open?: OneTimeRecord;
    waiting: { index: number; value: string; outpoint: string; address: string; height: number }[];
  }> {
    const { scan } = await this.requireAccount();
    const ot = await this.loadOneTime();
    const waiting = [];
    for (const r of ot.records) {
      for (const u of scan.utxos) {
        if (u.kind !== "bip86" || u.index !== r.index || u.spent) continue;
        waiting.push({ index: r.index, value: u.value, outpoint: outpointOf(u), address: r.address, height: u.height });
      }
    }
    waiting.sort((a, b) => a.index - b.index || a.outpoint.localeCompare(b.outpoint));
    return { open: visibleRecord(ot), waiting };
  }

  /** Plan the sweep: every unspent coin at that address, to our own receive code. Never adds other coins. */
  async planSweep(index: number, feeRate: number): Promise<ReturnType<typeof buildSend>> {
    const { account, scan } = await this.requireAccount();
    const coins = scan.utxos.filter((u) => u.kind === "bip86" && u.index === index && !u.spent);
    if (!coins.length) throw new Error("nothing at this one-time address");
    const { reserved, frozen } = await this.blockedOutpoints();
    const include = coins.map((c) => outpointOf(c));
    if (include.some((op) => frozen.has(op) || reserved.has(op))) throw new Error("this coin is frozen or reserved");
    return buildSend({
      account,
      utxos: scan.utxos,
      destination: account.receive,
      amount: 0n,
      feeRate,
      source: this.source(),
      skipOutpoints: new Set([...reserved, ...frozen]),
      include,
      max: true,
    });
  }

  async sweepOneTime(index: number, feeRate: number): Promise<BroadcastResult> {
    const built = await this.planSweep(index, feeRate);
    return this.broadcast(INTENT_SIMPLE_SEND, built, { kind: "self", feeRate });
  }

  /**
   * Retire the empty address on screen and issue the next one.
   * Coins still at an address have to move into the receive code first.
   */
  async replaceOneTime(): Promise<OneTimeRecord> {
    const { account, scan } = await this.requireAccount();
    const ot = await this.loadOneTime();
    const live = scan.utxos.some((u) => u.kind === "bip86" && !u.spent && ot.records.some((r) => r.index === u.index));
    if (live) throw new Error("Move the coins at your one-time address into your receive code first.");
    const open = visibleRecord(ot);
    let next = open ? setOneTimeStatus(ot, open.index, "swept") : ot;
    const index = nextOneTimeIndex(next);
    const k = account.oneTime(index);
    next = issueRecord(next, k.address, Date.now(), index);
    await this.saveOneTime(next);
    await this.saveScan(addWatch(scan, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index }));
    try {
      await this.saveScan(await this.recoverWatches(account, this.source(), await this.loadScan()));
    } catch {
      /* the new address stays watched for the next scan */
    }
    return (await this.loadOneTime()).records.find((r) => r.index === index)!;
  }

  private async splitCoinOrThrow(outpoint: string): Promise<LabeledUtxo> {
    const { scan } = await this.requireAccount();
    const coin = scan.utxos.find((u) => outpointOf(u) === outpoint && !u.spent);
    if (!coin) throw new Error("this coin is not in this wallet or already spent");
    const { reserved, frozen } = await this.blockedOutpoints();
    if (frozen.has(outpoint) || reserved.has(outpoint)) throw new Error("this coin is frozen or reserved");
    return coin;
  }

  /** Preview a user-chosen split. Amounts are the user's; we only check and build. */
  async planSplit(
    outpoint: string,
    amounts: string[],
    feeRate: number,
  ): Promise<{ pieces: string[]; fee: string; amount: string; vbytes: number; note: string }> {
    const { account } = await this.requireAccount();
    const built = await buildSplit({
      account,
      coin: await this.splitCoinOrThrow(outpoint),
      amounts: amounts.map((a) => BigInt(a)),
      feeRate,
      source: this.source(),
    });
    return {
      pieces: built.ourOutputs.map((o) => o.value),
      fee: built.fee.toString(),
      amount: built.amount.toString(),
      vbytes: built.vbytes,
      note: built.previewNote,
    };
  }

  async splitCoin(outpoint: string, amounts: string[], feeRate: number): Promise<BroadcastResult> {
    const { account } = await this.requireAccount();
    const built = await buildSplit({
      account,
      coin: await this.splitCoinOrThrow(outpoint),
      amounts: amounts.map((a) => BigInt(a)),
      feeRate,
      source: this.source(),
    });
    return this.broadcast(INTENT_SIMPLE_SEND, built, { kind: "split", feeRate });
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
      const key = await this.scanKey();
      if (key) await this.saveSealed(CHAIN_SECRETS_KEY, {});
    }
    await this.kv.set({ [CHAIN_KEY]: plain });
    this.chainCfg = migrateChainConfig({ ...plain, ...secrets });
  }

  /** Payment links and Payjoin sends for the UI. No keys, no PSBTs. */
  async sessions(): Promise<SessionView[]> {
    await this.closeExpired();
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
      checkedAt: s.checkedAt,
      txid: s.txid,
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
      checkedAt: s.checkedAt,
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
    delete all[ORIGINAL_PREFIX + id];
    await this.kv.set({ [PJ_HPKE]: all });
  }

  /** Stop waiting on a Payjoin you started. Nothing is broadcast. */
  async cancelSend(id: string): Promise<void> {
    const sends = await this.loadPayjoinSends();
    const s = sends.find((x) => x.id === id);
    if (!s) throw new Error("no such payment");
    if (s.status !== "waiting") throw new Error("this payment is not waiting");
    s.status = "failed";
    s.error = "cancelled";
    await this.savePayjoinSends(sends);
    const all = await this.hpkeSecrets();
    delete all[SEND_HPKE_PREFIX + id];
    await this.kv.set({ [PJ_HPKE]: all });
  }

  /** Delete every key of this wallet's namespace. PrivateBit updates the directory. */
  async deleteOwnKeys(): Promise<void> {
    this.close();
    await this.kv.remove([...V1_LIVE_KEYS, "privatebit.session", SCAN_GRANT_KEY]);
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
    await this.closeExpired();
    const now = Date.now();
    if ((await this.loadPayjoinSessions()).some((s) => (s.status === "waiting" || s.status === "proposed") && (s.status === "proposed" || s.expiresAt > now))) return true;
    return (await this.loadPayjoinSends()).some((s) => s.status === "waiting" && s.expiresAt > now);
  }

  /** A link or payment that ran out of time is history, not an open payment. */
  private async closeExpired(): Promise<void> {
    const now = Date.now();
    const sessions = await this.loadPayjoinSessions();
    let receiveDirty = false;
    for (const s of sessions) {
      if (s.status === "waiting" && now > s.expiresAt) {
        s.status = "failed";
        s.error = "expired";
        receiveDirty = true;
      }
    }
    if (receiveDirty) await this.savePayjoinSessions(sessions);
    const sends = await this.loadPayjoinSends();
    let sendDirty = false;
    for (const s of sends) {
      if (s.status === "waiting" && now > s.expiresAt) {
        s.status = "failed";
        s.error = "expired";
        sendDirty = true;
      }
    }
    if (sendDirty) await this.savePayjoinSends(sends);
  }

  async servicePayjoin(): Promise<{ processed: number; errors: string[] }> {
    const run = this.pjTail.then(() => this.servicePayjoinNow());
    this.pjTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Poll mailboxes and post a proposal. Window may be closed; vault must stay
   * unlocked (chrome.storage.session). Lock wipes keys and this is a no-op.
   */
  private async servicePayjoinNow(): Promise<{ processed: number; errors: string[] }> {
    const vault = await this.session();
    if (!vault) return { processed: 0, errors: [] };
    await this.closeExpired();
    const account = this.accountOf(vault);
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
        let original = await this.loadOriginal(s.id);
        let replyPk = s.replyPk ? fromHex(s.replyPk) : undefined;
        if (!original || !replyPk) {
          const got = await receiverTakeOriginal(s, cfg, sk);
          s.checkedAt = Date.now();
          if ("expired" in got) {
            s.status = "failed";
            s.error = "expired";
            continue;
          }
          if ("empty" in got) {
            s.error = undefined;
            continue;
          }
          original = got.original;
          replyPk = got.replyPk;
          s.replyPk = hex(replyPk);
          await this.saveOriginal(s.id, original);
          await this.savePayjoinSessions(sessions);
        }
        if (!s.reserved) {
          throw new Error("payment link is missing its reserved coin; create a new one");
        }
        const built = buildPayjoinProposal({
          originalB64: original,
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
        await receiverPostProposal(s, built.proposalB64, cfg, hpkeKeyPairFromSecret(sk), replyPk);
        s.replyPk = hex(replyPk);
        s.status = "proposed";
        s.error = undefined;
        s.checkedAt = Date.now();
        processed += 1;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push(message);
        s.checkedAt = Date.now();
        s.error = message;
        if (!payjoinRetryable(message)) s.status = "failed";
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
        if ("empty" in got) {
          s.checkedAt = Date.now();
          s.error = undefined;
          continue;
        }
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
        const message = e instanceof Error ? e.message : String(e);
        errors.push(message);
        s.checkedAt = Date.now();
        s.error = message;
        if (!payjoinRetryable(message)) s.status = "failed";
      }
    }
    await this.savePayjoinSends(sends);
    return processed;
  }
}


/** Every storage key PrivateBit may write: per-wallet names (before scoping) and shared ones. */
export const ALL_KEYS: string[] = [...WALLET_SCOPED, ...GLOBAL_KEYS];

function newWalletId(): string {
  return hex(randomBytes(8));
}

type Delegated<K extends keyof WalletCore> = WalletCore[K] extends (...a: infer A) => infer R ? (...a: A) => R : never;

/**
 * All wallets on this computer. Owns the directory (layout.ts) and the one WalletCore that is
 * open. Every wallet operation goes to the open core; a core that was closed keeps its own
 * namespace, so a late write from it cannot land in another wallet.
 */
export class PrivateBit {
  private hooks: CoreHooks = {};
  private current?: WalletCore;
  private layoutReady?: Promise<unknown>;
  /** Namespace a brand-new install will use for its first wallet. */
  private firstId?: string;

  constructor(
    readonly root: Kv,
    private defaultChain: ChainConfig = DEFAULT_CHAIN,
  ) {}

  get mailboxTransport(): MailboxTransport | undefined {
    return this.hooks.mailboxTransport;
  }
  set mailboxTransport(v: MailboxTransport | undefined) {
    this.hooks.mailboxTransport = v;
  }
  get ohttpConfig(): OhttpKeyConfig | undefined {
    return this.hooks.ohttpConfig;
  }
  set ohttpConfig(v: OhttpKeyConfig | undefined) {
    this.hooks.ohttpConfig = v;
  }
  get sourceOverride(): ChainSource | undefined {
    return this.hooks.sourceOverride;
  }
  set sourceOverride(v: ChainSource | undefined) {
    this.hooks.sourceOverride = v;
  }
  get chainCfg(): ChainConfig {
    return this.current?.chainCfg ?? this.defaultChain;
  }
  /** The open wallet's scoped storage (tests read the session through it). */
  get kv(): Kv {
    return this.current?.kv ?? this.root;
  }
  get activeId(): string | undefined {
    return this.current?.walletId;
  }

  /** Runs the one-time storage migration before anything else touches storage. */
  private async ready(): Promise<void> {
    if (!this.layoutReady) {
      this.layoutReady = migrateLayout(this.root).catch((e) => {
        this.layoutReady = undefined;
        throw e;
      });
    }
    await this.layoutReady;
  }

  private coreFor(id: string): WalletCore {
    return new WalletCore(scopedKv(this.root, id), this.current?.chainCfg ?? this.defaultChain, this.hooks, id);
  }

  /** The open wallet. With no wallet yet, an empty namespace for the first one. */
  async core(): Promise<WalletCore> {
    await this.ready();
    const index = await loadIndex(this.root);
    const id = index?.active ?? (this.firstId ??= newWalletId());
    if (!this.current || this.current.walletId !== id) {
      this.current?.close();
      this.current = new WalletCore(scopedKv(this.root, id), this.defaultChain, this.hooks, id);
      await this.current.loadChain();
    }
    return this.current;
  }

  private async index(): Promise<WalletIndex | null> {
    await this.ready();
    return loadIndex(this.root);
  }

  private async summaries(): Promise<WalletState["wallets"]> {
    const index = await this.index();
    if (!index) return undefined;
    return index.wallets.map((w) => ({
      id: w.id,
      name: w.name,
      active: w.id === index.active,
      birthday: w.birthday,
      words: w.words,
      hasPassphrase: w.hasPassphrase,
      checked: w.checked,
    }));
  }

  /** Record word count, passphrase presence and birthday for a wallet. Never the words. */
  private async remember(core: WalletCore, name?: string): Promise<void> {
    const st = await core.state();
    if (!st.hasVault) return;
    const index = (await this.index()) ?? { v: 2 as const, active: core.walletId, wallets: [] };
    const prev = index.wallets.find((w) => w.id === core.walletId);
    const entry: WalletEntry = {
      id: core.walletId,
      name: name?.trim() || prev?.name || (index.wallets.length ? `Wallet ${index.wallets.length + 1}` : "Wallet"),
      createdAt: prev?.createdAt ?? Date.now(),
      birthday: (await loadVaultBlob(core.kv))?.birthday ?? prev?.birthday ?? 0,
      ...(st.mnemonicWords ? { words: st.mnemonicWords } : prev?.words ? { words: prev.words } : {}),
      ...(st.unlocked ? { hasPassphrase: !!st.hasPassphrase } : prev?.hasPassphrase !== undefined ? { hasPassphrase: prev.hasPassphrase } : {}),
      ...(prev?.checked !== undefined ? { checked: prev.checked } : {}),
    };
    const wallets = prev ? index.wallets.map((w) => (w.id === entry.id ? entry : w)) : [...index.wallets, entry];
    await saveIndex(this.root, { v: 2, active: index.active, wallets });
  }

  private async activate(id: string): Promise<void> {
    const index = await this.index();
    if (!index || !index.wallets.some((w) => w.id === id)) throw new Error("no such wallet");
    await saveIndex(this.root, { ...index, active: id });
  }

  async state(): Promise<WalletState> {
    const core = await this.core();
    const st = await core.state();
    return { ...st, wallets: await this.summaries() };
  }

  async create(args: Parameters<WalletCore["create"]>[0]): Promise<string> {
    if (await this.index()) throw new Error("A wallet is already on this computer. Unlock it, or restore from recovery words.");
    const core = await this.core();
    const words = await core.create(args);
    await this.remember(core);
    return words;
  }

  async createChecked(args: Parameters<WalletCore["createChecked"]>[0]): Promise<void> {
    if (await this.index()) throw new Error("A wallet is already on this computer. Unlock it, or restore from recovery words.");
    const core = await this.core();
    await core.createChecked(args);
    await this.remember(core, args.name);
  }

  /** First wallet from words, or the open wallet restored over itself (forgot password). */
  async restore(args: Parameters<WalletCore["restore"]>[0]): Promise<void> {
    const core = await this.core();
    await core.restore(args);
    await this.remember(core, args.name);
  }

  /**
   * Add a wallet in its own namespace and open it. The wallet that was open is locked and
   * stops matching blocks until you switch back and unlock it.
   */
  async addWallet(args: {
    mnemonic: string;
    password: string;
    passphrase?: string;
    birthday: number;
    name?: string;
    kind: "create" | "import";
  }): Promise<void> {
    if (args.birthday <= 0) throw new Error("birthday height required (Fractal tip is past 2M; 0 is genesis)");
    const unlocked = vaultFromMnemonic(args);
    if (args.kind === "create" && unlocked.mnemonic.split(" ").length !== 24) throw new Error("A new wallet uses 24 words.");
    const index = await this.index();
    if (!index) {
      if (args.kind === "import") await this.restore(args);
      else await this.createChecked(args);
      return;
    }
    const prev = await this.core();
    const carried = prev.chainCfg;
    await prev.closeForSwitch();
    const id = newWalletId();
    const core = this.coreFor(id);
    if (args.kind === "import") await core.restore(args);
    else await core.createChecked(args);
    await core.saveChain(carried);
    const name = args.name?.trim() || `Wallet ${index.wallets.length + 1}`;
    await saveIndex(this.root, {
      v: 2,
      active: id,
      wallets: [...index.wallets, { id, name, createdAt: Date.now(), birthday: args.birthday }],
    });
    await this.remember(core, name);
    this.current = core;
  }

  /** Lock the open wallet and open another one. Its password is asked afterwards. */
  async openWallet(id: string): Promise<void> {
    const index = await this.index();
    if (!index || !index.wallets.some((w) => w.id === id)) throw new Error("no such wallet");
    const prev = await this.core();
    await prev.closeForSwitch();
    await this.activate(id);
    await this.core();
  }

  async renameWallet(id: string, name: string): Promise<void> {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!clean) throw new Error("Give the wallet a name.");
    const index = await this.index();
    if (!index || !index.wallets.some((w) => w.id === id)) throw new Error("no such wallet");
    await saveIndex(this.root, { ...index, wallets: index.wallets.map((w) => (w.id === id ? { ...w, name: clean } : w)) });
  }

  async unlock(password: string): Promise<void> {
    const core = await this.core();
    await core.unlock(password);
    await this.remember(core);
  }

  async setBirthday(birthday: number): Promise<void> {
    const core = await this.core();
    await core.setBirthday(birthday);
    await this.remember(core);
  }

  /**
   * Remove the open wallet only. The others stay, and one of them is opened (locked).
   * Removing the last wallet wipes every PrivateBit key; wiped tells the caller.
   */
  async removeWallet(password: string): Promise<{ wiped: boolean }> {
    const core = await this.core();
    await core.checkPassword(password);
    const index = await this.index();
    const ids = new Set([core.walletId, ...(index?.wallets ?? []).map((w) => w.id)]);
    if (!index || index.wallets.length <= 1) {
      core.close();
      const keys = new Set<string>([...GLOBAL_KEYS, ...V1_LIVE_KEYS, "privatebit.session", SCAN_GRANT_KEY, V1_MOUNTED_KEY]);
      for (const id of ids) {
        for (const k of walletKeys(id)) keys.add(k);
        keys.add(v1PackKey(id));
      }
      await this.root.remove([...keys]);
      this.current = undefined;
      this.firstId = undefined;
      return { wiped: true };
    }
    await core.deleteOwnKeys();
    await this.root.remove(walletKeys(core.walletId));
    const rest = index.wallets.filter((w) => w.id !== core.walletId);
    await saveIndex(this.root, { v: 2, active: rest[0]!.id, wallets: rest });
    this.current = undefined;
    await this.core();
    return { wiped: false };
  }

  // Everything below runs on the open wallet.
  private d<K extends keyof WalletCore>(k: K): Delegated<K> {
    return (async (...a: unknown[]) => {
      const core = await this.core();
      return (core[k] as (...x: unknown[]) => unknown).apply(core, a);
    }) as unknown as Delegated<K>;
  }
  lock = this.d("lock");
  checkPassword = this.d("checkPassword");
  changePassword = this.d("changePassword");
  restoreBackup = this.d("restoreBackup");
  requireAccount = this.d("requireAccount");
  scanOnce = this.d("scanOnce");
  scanToTip = this.d("scanToTip");
  followTip = this.d("followTip");
  canIndex = this.d("canIndex");
  catchingUp = this.d("catchingUp");
  dataKey = this.d("dataKey");
  migrateAtRest = this.d("migrateAtRest");
  loadScan = this.d("loadScan");
  saveScan = this.d("saveScan");
  loadHistory = this.d("loadHistory");
  saveHistory = this.d("saveHistory");
  history = this.d("history");
  setActivityLabel = this.d("setActivityLabel");
  loadCoinMeta = this.d("loadCoinMeta");
  saveCoinMeta = this.d("saveCoinMeta");
  setCoinMeta = this.d("setCoinMeta");
  coins = this.d("coins");
  loadOneTime = this.d("loadOneTime");
  saveOneTime = this.d("saveOneTime");
  issueOneTime = this.d("issueOneTime");
  oneTimeView = this.d("oneTimeView");
  planSweep = this.d("planSweep");
  sweepOneTime = this.d("sweepOneTime");
  replaceOneTime = this.d("replaceOneTime");
  planSplit = this.d("planSplit");
  splitCoin = this.d("splitCoin");
  startMigration = this.d("startMigration");
  migrationStatus = this.d("migrationStatus");
  finishMigration = this.d("finishMigration");
  cancelMigration = this.d("cancelMigration");
  loadChain = this.d("loadChain");
  saveChain = this.d("saveChain");
  sessions = this.d("sessions");
  cancelLink = this.d("cancelLink");
  cancelSend = this.d("cancelSend");
  loadPayjoinSessions = this.d("loadPayjoinSessions");
  savePayjoinSessions = this.d("savePayjoinSessions");
  offerPayjoin = this.d("offerPayjoin");
  loadPayjoinSends = this.d("loadPayjoinSends");
  savePayjoinSends = this.d("savePayjoinSends");
  waitingPayjoin = this.d("waitingPayjoin");
  servicePayjoin = this.d("servicePayjoin");
  blockedOutpoints = this.d("blockedOutpoints");
  planSend = this.d("planSend");
  plan = this.d("plan");
  assertNotOwnLink = this.d("assertNotOwnLink");
  maxAmount = this.d("maxAmount");
  feeRates = this.d("feeRates");
  broadcast = this.d("broadcast");

  /** Chain source for the open wallet's settings. */
  source(): ChainSource {
    return this.hooks.sourceOverride ?? openChain(this.chainCfg);
  }
  payjoinCfg(): PayjoinConfig {
    return (this.current ?? this.coreFor(this.firstId ??= newWalletId())).payjoinCfg();
  }
}

export type { VaultBlob };
export { INTENT_PAYJOIN, INTENT_SIMPLE_SEND };
