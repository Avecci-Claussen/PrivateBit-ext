import * as btc from "@scure/btc-signer";
import { spendSecret, taprootScriptPubKey } from "./bip352.ts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { fromHex, hex, randomBytes } from "./bytes.ts";
import { loadSharedBlock, UnsupportedBlock } from "./blockshare.ts";
import { hintAddressUtxos, openChain, type ChainSource } from "./chain.ts";
import type { Account } from "./keys.ts";
import { accountFromVault, p2trAddressFromScriptHex } from "./keys.ts";
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
  ensureIndex,
  INDEX_KEY,
  LIVE_KEYS,
  loadIndex,
  MOUNTED_KEY,
  packKey,
  saveIndex,
  stagePack,
  switchWallet as mountWallet,
  type WalletEntry,
} from "./wallets.ts";
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
/** Every storage key this wallet may write, so Remove wallet can prove nothing is left. */
export const ALL_KEYS = [
  "privatebit.vault",
  "privatebit.session",
  SCAN_GRANT_KEY,
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
  INDEX_KEY,
  MOUNTED_KEY,
];
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
  /** Set only while matching blocks, including after Lock. Never used to spend. */
  private indexKey?: Uint8Array;
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

  /** Data key for encryption at rest. The UI can read it only while unlocked. A scan may hold it after Lock. */
  async dataKey(): Promise<Uint8Array | null> {
    if (this.indexKey) return this.indexKey;
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

  private async walletSummaries(): Promise<WalletState["wallets"]> {
    const index = await ensureIndex(this.kv);
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

  /** Remember word count and passphrase presence for the open wallet. Never stores the words. */
  private async rememberOpen(name?: string): Promise<void> {
    const blob = await loadVaultBlob(this.kv);
    const index = await ensureIndex(this.kv);
    if (!blob || !index) return;
    const session = await loadSession(this.kv);
    const words = session ? session.mnemonic.trim().split(/\s+/).length : undefined;
    const next = index.wallets.map((w) => {
      if (w.id !== index.active) return w;
      const entry: WalletEntry = {
        ...w,
        birthday: blob.birthday,
        ...(name && (w.name === "Wallet" || w.name.startsWith("Wallet ")) ? { name } : {}),
        ...(words ? { words } : {}),
        ...(session ? { hasPassphrase: session.passphrase.length > 0 } : {}),
      };
      return entry;
    });
    await saveIndex(this.kv, { ...index, wallets: next });
  }

  async state(): Promise<WalletState> {
    const blob = await loadVaultBlob(this.kv);
    const session = await loadSession(this.kv);
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
        wallets: await this.walletSummaries(),
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
      wallets: await this.walletSummaries(),
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
    await this.saveHistory(emptyHistory());
    await this.saveScan(emptyScanStore(args.birthday));
    await this.rememberOpen();
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
    await this.kv.remove([HISTORY_KEY, COINMETA_KEY, ONETIME_KEY]);
    await this.saveHistory(emptyHistory());
    await this.saveScan(emptyScanStore(args.birthday));
    await this.rememberOpen(args.name);
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
    await persistVault(this.kv, blob);
    await saveSession(this.kv, unlocked);
    // History is rebuilt from the scan; typed labels cannot come back.
    await this.kv.remove([HISTORY_KEY, COINMETA_KEY, ONETIME_KEY]);
    await this.saveHistory(emptyHistory(true));
    const seeded = this.restoredScan(accountFromVault(unlocked), args.birthday);
    await this.saveOneTime(seeded.ot);
    await this.saveScan(seeded.scan);
    await this.rememberOpen(args.name);
  }

  /**
   * Add a wallet beside the one that is open, then open the new one.
   * The previous wallet stays on this computer, locked, until you switch back.
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
    const words = unlocked.mnemonic.split(" ").length;
    if (args.kind === "create" && words !== 24) throw new Error("A new wallet uses 24 words.");
    if (!(await loadVaultBlob(this.kv))) {
      if (args.kind === "import") await this.restore(args);
      else await this.createChecked(args);
      await this.rememberOpen(args.name);
      return;
    }
    const index = await ensureIndex(this.kv);
    if (!index) throw new Error("no wallet on this computer");
    const id = hex(randomBytes(8));
    const name = args.name?.trim() || `Wallet ${index.wallets.length + 1}`;
    const key = deriveDataKey(unlocked.seed);
    const account = accountFromVault(unlocked);
    const values: Record<string, unknown> = { "privatebit.vault": lockVault(unlocked, args.password) };
    const carried = splitChainSecrets(this.chainCfg);
    values["privatebit.chain"] = carried.plain;
    if (carried.secrets.unisatToken || carried.secrets.rpcPassword) {
      values["privatebit.chain.secrets"] = sealJson(key, CHAIN_SECRETS_KEY, carried.secrets);
    }
    if (args.kind === "import") {
      const seeded = this.restoredScan(account, args.birthday);
      values["privatebit.scan"] = sealJson(key, SCAN_KEY, seeded.scan);
      values["privatebit.history"] = sealJson(key, HISTORY_KEY, emptyHistory(true));
      values["privatebit.onetime"] = sealJson(key, ONETIME_KEY, seeded.ot);
    } else {
      values["privatebit.scan"] = sealJson(key, SCAN_KEY, emptyScanStore(args.birthday));
      values["privatebit.history"] = sealJson(key, HISTORY_KEY, emptyHistory());
    }
    await stagePack(this.kv, id, values);
    await saveIndex(this.kv, {
      ...index,
      wallets: [
        ...index.wallets,
        { id, name, createdAt: Date.now(), birthday: args.birthday, words, hasPassphrase: unlocked.passphrase.length > 0 },
      ],
    });
    this.walletEpoch += 1;
    this.sideWorkAt = 0;
    this.keyCache = undefined;
    this.scanHex = undefined;
    await mountWallet(this.kv, id);
    await saveSession(this.kv, unlocked);
    await this.loadChain();
    await this.keepOnlyThisWallet(account);
  }

  /** Lock and open a different wallet. Its password is asked afterwards. */
  async openWallet(id: string): Promise<void> {
    this.walletEpoch += 1;
    this.sideWorkAt = 0;
    this.keyCache = undefined;
    this.scanHex = undefined;
    await mountWallet(this.kv, id);
    await this.loadChain();
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
    await this.rememberOpen();
  }

  async unlock(password: string): Promise<void> {
    this.sideWorkAt = 0;
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    const unlocked = unlockVault(blob, password);
    await saveSession(this.kv, unlocked);
    await this.migrateAtRest();
    await this.rememberOpen();
    await this.keepOnlyThisWallet(accountFromVault(unlocked));
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
    return this.enqueueScan(() => this.scanOnceUnlocked());
  }

  /** Script this account can spend, or null when the coin is not ours. */
  private ownedScript(account: Account, u: { tweak: string; label: number | null; kind?: "sp" | "bip86"; index?: number; scriptPubKey: string }): string | null {
    const spk = u.scriptPubKey.toLowerCase();
    try {
      if (u.kind === "bip86") {
        if (u.index === undefined) return null;
        const want = account.oneTime(u.index).scriptPubKey.toLowerCase();
        return want === spk ? want : null;
      }
      const tweak = fromHex(u.tweak);
      const sec = spendSecret({
        spendSecret: account.spendSecret,
        tweak,
        label: u.label,
        scanSecret: account.scanSecret,
      });
      const xonly = secp256k1.getPublicKey(sec, true).slice(1);
      if (hex(taprootScriptPubKey(xonly)).toLowerCase() === spk) return spk;
      const pj = tweakSpend(account.spendSecret, tweak);
      return hex(taprootScriptPubKey(pj.xonly)).toLowerCase() === spk ? spk : null;
    } catch {
      return null;
    }
  }

  /**
   * A scan that was still running can save the previous wallet's coins into the one just opened.
   * Drop those coins and the activity rows that came from them. Our own coins stay.
   */
  private async keepOnlyThisWallet(account: Account): Promise<void> {
    const index = await loadIndex(this.kv);
    if (!index || index.wallets.length < 2) return;
    await this.dropForeignPayjoins(account);
    const scan = await this.loadScan();
    const utxos = scan.utxos.filter((u) => this.ownedScript(account, u) !== null);
    const watch = (scan.watch ?? []).filter((w) => this.ownedScript(account, w) !== null);
    const hist = await this.loadHistory();
    const live = new Set<string>();
    for (const u of utxos) {
      live.add(u.txid);
      if (u.spentBy) live.add(u.spentBy);
    }
    const entries: HistoryStore["entries"] = {};
    for (const [txid, entry] of Object.entries(hist.entries)) if (live.has(txid)) entries[txid] = entry;
    const droppedCoins = utxos.length !== scan.utxos.length;
    const droppedWatch = watch.length !== (scan.watch ?? []).length;
    const droppedHist = Object.keys(entries).length !== Object.keys(hist.entries).length;
    if (!droppedCoins && !droppedWatch && !droppedHist) return;
    const next: ScanStore = { ...scan, utxos, watch };
    await this.saveSealed(SCAN_KEY, next);
    if (droppedHist) await this.saveHistory({ ...hist, entries });
  }

  /** A payment link belongs to this wallet only if this wallet's spend key created it. */
  private payjoinIsMine(account: Account, s: PayjoinReceiveSession): boolean {
    if (!s.tweak || !s.scriptPubKey) return false;
    try {
      const pay = tweakSpend(account.spendSecret, fromHex(s.tweak));
      return hex(taprootScriptPubKey(pay.xonly)).toLowerCase() === s.scriptPubKey.toLowerCase();
    } catch {
      return false;
    }
  }

  private sendIsMine(account: Account, s: PayjoinSendSession): boolean {
    return s.signableInputs.some((inp) => this.ownedScript(account, inp) !== null);
  }

  /** Drop another wallet's links if they were left in the open wallet's storage. */
  private async dropForeignPayjoins(account: Account): Promise<void> {
    const sessions = await this.loadPayjoinSessions();
    const mine = sessions.filter((s) => this.payjoinIsMine(account, s));
    if (mine.length !== sessions.length) await this.savePayjoinSessions(mine);
    const sends = await this.loadPayjoinSends();
    const mySends = sends.filter((s) => this.sendIsMine(account, s));
    if (mySends.length !== sends.length) await this.savePayjoinSends(mySends);
  }

  private async scanStillHere(mark: { epoch: number; mnemonic: string; passphrase: string }): Promise<boolean> {
    if (mark.epoch !== this.walletEpoch) return false;
    const session = await loadSession(this.kv);
    if (session) return session.mnemonic === mark.mnemonic && session.passphrase === mark.passphrase;
    const grant = await loadScanGrant(this.kv);
    return !!grant && grant.mnemonic === mark.mnemonic && grant.passphrase === mark.passphrase;
  }

  private async scanOnceUnlocked(): Promise<ScanProgress> {
    const epoch = this.walletEpoch;
    const unlocked = (await loadSession(this.kv)) ?? (await loadScanGrant(this.kv));
    const idle: ScanProgress = { done: false, lastHeight: 0, tip: 0, height: 0, txIndex: 0, txCount: 0, skipped: 0 };
    if (!unlocked) return idle;
    this.indexKey = deriveDataKey(unlocked.seed);
    try {
    const account = accountFromVault(unlocked);
    const scan = await this.loadScan();
    const mark = { epoch, mnemonic: unlocked.mnemonic, passphrase: unlocked.passphrase };
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
      await this.keepOnlyThisWallet(account);
      if (mark.epoch !== this.walletEpoch) return stopped();
      store = await this.loadScan();
      store = await this.ensureOneTimeWatches(account, store);
      store = await this.recoverWatches(account, source, store);
      store = await this.recoverOwnBroadcasts(account, source, store);
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
    } finally {
      this.indexKey = undefined;
    }
  }

  /** Known scripts (one-time, Payjoin) via indexer hints, then raw tx hex. SP scan stays sequential. */
  private async recoverWatches(account: Account, source: ChainSource, store: ScanStore): Promise<ScanStore> {
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

  async restoreBackup(): Promise<void> {
    await restoreVaultBackup(this.kv);
    this.keyCache = undefined;
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
    const session = await loadSession(this.kv);
    const account = session ? accountFromVault(session) : undefined;
    const receive = account ? await this.payjoinsForAccount(account) : await this.loadPayjoinSessions();
    const reserved = new Set(
      receive
        .filter((s) => s.status === "waiting" && s.reserved)
        .map((s) => `${s.reserved!.txid}:${s.reserved!.vout}`),
    );
    let sends = await this.loadPayjoinSends();
    if (account) {
      const index = await loadIndex(this.kv);
      if (index && index.wallets.length >= 2) {
        const mine = sends.filter((s) => this.sendIsMine(account, s));
        if (mine.length !== sends.length) await this.savePayjoinSends(mine);
        sends = mine;
      }
    }
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
    const own = (await this.payjoinsForAccount(account)).some((s) => {
      if (rk && s.hpkePub && s.hpkePub.toLowerCase() === rk) return true;
      return s.pj === request.pj || s.bip21 === request.raw;
    });
    if (own) throw new PolicyError("This is your own payment link. Share it with the person paying you.");
  }

  /** This wallet's links only. With two wallets, a link from the other one is removed from this list. */
  private async payjoinsForAccount(account: Account): Promise<PayjoinReceiveSession[]> {
    const sessions = await this.loadPayjoinSessions();
    const index = await loadIndex(this.kv);
    if (!index || index.wallets.length < 2) return sessions;
    const mine = sessions.filter((s) => this.payjoinIsMine(account, s));
    if (mine.length !== sessions.length) await this.savePayjoinSessions(mine);
    return mine;
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
    if (await loadSession(this.kv)) return true;
    return !!(await loadScanGrant(this.kv));
  }

  /** True while this wallet still has blocks to match. */
  async catchingUp(): Promise<boolean> {
    if (!(await this.canIndex())) return false;
    const was = this.indexKey;
    if (!was && !(await loadSession(this.kv))) {
      const grant = await loadScanGrant(this.kv);
      if (grant) this.indexKey = deriveDataKey(grant.seed);
    }
    try {
      const scan = await this.loadScan();
      if (scan.tip === undefined) return false;
      return !!scan.inflight || scan.lastHeight < scan.tip;
    } finally {
      if (!was) this.indexKey = undefined;
    }
  }

  private async noteChecked(height: number): Promise<void> {
    const index = await loadIndex(this.kv);
    if (!index) return;
    const row = index.wallets.find((w) => w.id === index.active);
    if (!row || row.checked === height) return;
    row.checked = height;
    await saveIndex(this.kv, index);
  }

  async loadScan(): Promise<ScanStore> {
    const session = await loadSession(this.kv);
    const grant = !session && this.indexKey ? await loadScanGrant(this.kv) : null;
    const birthday = session?.birthday ?? grant?.birthday ?? DEFAULT_BIRTHDAY;
    const got = await this.loadSealed<ScanStore>(SCAN_KEY, () => emptyScanStore(birthday));
    if (got.status === "missing" || (got.status === "unreadable" && !session && !this.indexKey)) return emptyScanStore(birthday);
    return got.value;
  }

  /** Seals the scan store and keeps history in step with it. Requires the wallet to be unlocked. */
  async saveScan(scan: ScanStore, mark?: { epoch: number; mnemonic: string; passphrase: string }): Promise<void> {
    if (mark && !(await this.scanStillHere(mark))) return;
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
        const session = await loadSession(this.kv);
        if (session) {
          const account = accountFromVault(session);
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
      const key = await this.dataKey();
      if (key) await this.saveSealed(CHAIN_SECRETS_KEY, {});
    }
    await this.kv.set({ [CHAIN_KEY]: plain });
    this.chainCfg = migrateChainConfig({ ...plain, ...secrets });
  }

  /** Payment links and Payjoin sends for the UI. No keys, no PSBTs. */
  async sessions(): Promise<SessionView[]> {
    await this.closeExpired();
    const session = await loadSession(this.kv);
    const account = session ? accountFromVault(session) : undefined;
    const recSrc = account ? await this.payjoinsForAccount(account) : await this.loadPayjoinSessions();
    const rec = recSrc.map((s): SessionView => ({
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
    let sendSrc = await this.loadPayjoinSends();
    if (account) {
      const index = await loadIndex(this.kv);
      if (index && index.wallets.length >= 2) {
        const mine = sendSrc.filter((s) => this.sendIsMine(account, s));
        if (mine.length !== sendSrc.length) await this.savePayjoinSends(mine);
        sendSrc = mine;
      }
    }
    const snd = sendSrc.map((s): SessionView => ({
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

  /** Delete every privatebit.* key. The caller also clears alarms and reads storage back. */
  async removeWallet(password: string): Promise<void> {
    await this.checkPassword(password);
    this.keyCache = undefined;
    this.scanHex = undefined;
    const index = await loadIndex(this.kv);
    const packs = (index?.wallets ?? []).map((w) => packKey(w.id));
    if (!index || index.wallets.length <= 1) {
      await this.kv.remove([...ALL_KEYS, ...LIVE_KEYS, ...packs]);
      return;
    }
    const doomed = index.active;
    const other = index.wallets.find((w) => w.id !== doomed);
    if (!other) {
      await this.kv.remove([...ALL_KEYS, ...LIVE_KEYS, ...packs]);
      return;
    }
    await mountWallet(this.kv, other.id);
    const fresh = await loadIndex(this.kv);
    if (fresh) await saveIndex(this.kv, { ...fresh, wallets: fresh.wallets.filter((w) => w.id !== doomed) });
    await this.kv.remove([packKey(doomed)]);
    await this.loadChain();
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
    const vault = await loadSession(this.kv);
    if (!vault) return { processed: 0, errors: [] };
    await this.closeExpired();
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

export type { VaultBlob };
export { INTENT_PAYJOIN, INTENT_SIMPLE_SEND };
