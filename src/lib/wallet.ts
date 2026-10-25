import * as btc from "@scure/btc-signer";
import { MEMPOOL_BITCOIN, MEMPOOL_FRACTAL, mempoolTxHex } from "./mempool.ts";
import { spendSecret, taprootScriptPubKey } from "./bip352.ts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { fromHex, hex, randomBytes } from "./bytes.ts";
import { dropBox, open as openBox, seal as sealBox, type SealedBox } from "./sessionkeys.ts";
import { sha256 } from "@noble/hashes/sha256";
import { setSharedChainNetwork, forgetSharedFrom, IncompleteBlock, loadSharedBlock, pruneSharedBelow, UnsupportedBlock, type SharedBlock } from "./blockshare.ts";
import { cancellable, openChain, type ChainSource } from "./chain.ts";
import type { Account, ScanAccount } from "./keys.ts";
import { accountFromVault, p2trAddressFromScriptHex, scanAccountFrom } from "./keys.ts";
import {
  DEFAULT_BIRTHDAY,
  DEFAULT_CHAIN,
  DEFAULT_OHTTP_RELAY,
  NETWORK_IDS,
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
  fetchDirectoryOhttpBytes,
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
import { buildPayjoinProposal, checkOriginal, proposalTxid, validatePayjoinProposal } from "./payjoin-proposal.ts";
import { CoinStore, StaleWriteError } from "./coinstore.ts";
import { mailboxUrls, type MailboxTransport } from "./mailbox.ts";
import { parseOhttpKeys, type OhttpKeyConfig } from "./ohttp.ts";
import {
  addWatch,
  noteWatchedOutput,
  applyBuiltSend,
  applyTxHex,
  markAbsentWatchSpent,
  recoverWatchedFromHints,
  retryDeferred,
  confirmedBalance,
  emptyScanStore,
  pendingBalance,
  spendableBalance,
  applySharedSlice,
  noteBlockHash,
  pruneWatches,
  ReorgError,
  rollbackTo,
  SCAN_BUDGET_MS,
  scanStep,
  withTxHexCache,
  type LabeledUtxo,
  type WatchedOutput,
  type ScanProgress,
  type ScanStore,
} from "./scan.ts";
import { evenPriv, pjSessionId, sessionTweak, tweakSpend } from "./schnorr-util.ts";
import { buildSend, buildSplit, inputSecret, destinationNeedsPayjoin, groupInputLabels, paymentOutputAddress, planDigest, planPayload, signPayjoinProposal, type PlanPayload } from "./send.ts";
import { isPlanSeed, jitterFeeRate, newPlanSeed } from "./plan-random.ts";
import type { SignableInput } from "./send.ts";
import type { OwnedOutput } from "./scan.ts";
import { privateUtxos } from "./scan.ts";
import {
  buildSiteSend,
  emptySites,
  normalizeOrigin,
  parsePsbt,
  reviewPsbt,
  signMessageBip322,
  signMessageEcdsa,
  signReviewedPsbt,
  siteHost,
  upsertSite,
  pickSiteIndex,
  type OwnerOf,
  type PsbtReview,
  type SignPsbtOptions,
  type SiteKey,
  type SiteRecord,
  type SiteSendPlan,
  type SiteStore,
} from "./sites.ts";
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
  vaultNeedsStrongerKdf,
  vaultFromMnemonic,
  type Kv,
  type UnlockedVault,
  type SessionVault,
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
  netKv,
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
  protectedOutpoints,
  ordOutputVerdict,
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
import { leftoverLimit, maxSendable, type LeftoverPref } from "./coinselect.ts";
import { FRACTAL_CHAIN_ID, isNetworkId, netInfo, splitChainSecrets, type ChainSecrets, type NetworkId } from "./network.ts";
import { parseBip21 } from "./bip21.ts";

export type WalletState = {
  hasVault: boolean;
  /** The chain shown. */
  net?: NetworkId;
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
  /** An open payment link or Payjoin send (it keeps going after Lock with scoped keys). */
  payjoin?: {
    role: "receive" | "send";
    status: string;
    amount?: string;
    expiresAt: number;
    /** When this open state ends by itself (link expiry, or the payer's time to broadcast). */
    deadline: number;
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
  /** 1.0.0 asset guard: unlocked by hand, and what the ord server said (if asked). */
  assetOk?: boolean;
  asset?: "none" | "held";
  kind: "sp" | "bip86";
  pending: boolean;
  /** In a signed payment that waits to be sent (delayed sending). */
  held?: boolean;
};

export type PlanOptions = {
  feeRate?: number;
  coins?: string[];
  max?: boolean;
  /** Plan seed from the review (plan-random.ts). Missing: a fresh one is made. */
  seed?: string;
  /** "Randomize fee slightly": move the rate by up to 5%, never below `minFeeRate`. */
  randomizeFee?: boolean;
  minFeeRate?: number;
  /** Small leftover rule for no-change sending. */
  leftover?: LeftoverPref;
};

/** A signed payment held for "Delay sending by a random time". Never broadcast until sendAt. */
export type DelayedSend = {
  id: string;
  createdAt: number;
  sendAt: number;
  status: "waiting" | "sent" | "failed";
  txHex: string;
  txid?: string;
  error?: string;
  sentAt?: number;
  /** History, labels and the coin list were updated for this send. */
  recorded?: boolean;
  label?: string;
  feeRate: number;
  amount: string;
  fee: string;
  change: string;
  destination: string;
  signableInputs: SignableInput[];
  ourOutputs: OwnedOutput[];
};
export type DelayedView = Omit<DelayedSend, "txHex" | "signableInputs" | "ourOutputs">;

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
  /** When this open session ends by itself if nothing happens. */
  deadline?: number;
  /** Cancel is offered in every open state. */
  cancellable?: boolean;
};

export type BroadcastResult = { kind: "txid"; txid: string } | { kind: "payjoin-pending" } | { kind: "delayed"; id: string; sendAt: number };

type BuiltPlan = Awaited<ReturnType<typeof buildSend>> & { feeRate?: number };

export const FOLLOW_TIP_STEPS = 24;
/** During a scan, history is rebuilt at most this often. */
const HISTORY_EVERY_MS = 10_000;

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
const SITES_KEY = "privatebit.sites";
/** Sealed with the scan key, which block matching keeps after Lock. Everything else uses the data key. */
/** Held payments are sealed with the scan key so the worker can still send them after Lock. */
const DELAYED_KEY = "privatebit.delayed";
/** Bitcoin only: the first block to read (plain number, not secret). */
const BIRTHDAY_KEY = "privatebit.birthday";
const SCAN_SEALED = new Set([SCAN_KEY, CHAIN_SECRETS_KEY, DELAYED_KEY]);
const PJ_SEND = "privatebit.pj.send";
const PJ_HPKE = "privatebit.pj.hpke";
const SEND_HPKE_PREFIX = "send:";
/** Sealed (session key slot "pj") scoped keys for Payjoins that keep going after Lock. */
const PJ_GRANT = "privatebit.pj.grant";
/** Wrong password count and wait, kept on disk so a restart does not reset it (security audit v1, I2). */
const UNLOCK_GUARD = "privatebit.unlock.guard";
const FREE_TRIES = 3;
const FIRST_WAIT_MS = 30_000;
const MAX_WAIT_MS = 60 * 60_000;
export function unlockWaitMs(fails: number): number {
  if (fails < FREE_TRIES) return 0;
  return Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (fails - FREE_TRIES));
}
function waitText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s} seconds`;
  const m = Math.ceil(s / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}
const PJ_GRANT_AAD = "privatebit/pj-grant/v1";
const PJ_HPKE_AAD = "privatebit/pj-hpke/v1";
/**
 * What a waiting Payjoin needs while the wallet is locked, and nothing more: for a payment link,
 * the session and the secret of its one reserved coin; for a Payjoin send, the secrets of the
 * coins it already spends. Never the seed, the spend secret or any other coin's key.
 */
type PjGrant = {
  v: 1;
  recv: Array<{ s: PayjoinReceiveSession; secret: string }>;
  sends: Array<{ id: string; secrets: Record<string, string> }>;
  /** Sends finished while locked; history and change are recorded at the next unlock. */
  done: Array<{ id: string; proposal: string; txHex: string; txid: string }>;
};
const ORIGINAL_PREFIX = "orig:";
const OHTTP_KEYS_KEY = "privatebit.pj.ohttpkeys";
const OHTTP_KEYS_TTL_MS = 7 * 24 * 60 * 60_000;
/** After we post a proposal, the payer has this long to broadcast it. Then the link ends as "not sent". */
export const PROPOSAL_DEADLINE_MS = 60 * 60 * 1000;
/** A closed link may still be paid late (the payer broadcasts after all); we look for it this long. */
const LATE_PAYMENT_MS = 7 * 24 * 60 * 60 * 1000;

/** Receive states: waiting (link open, deadline expiresAt), proposed (deadline proposalDeadline), done, failed. */
function receiveOpen(s: PayjoinReceiveSession): boolean {
  return s.status === "waiting" || s.status === "proposed";
}

function receiveDeadline(s: PayjoinReceiveSession): number {
  return s.status === "proposed" ? (s.proposalDeadline ?? (s.proposedAt ?? s.createdAt) + PROPOSAL_DEADLINE_MS) : s.expiresAt;
}
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

class ScanStopped extends Error {
  constructor() {
    super("scan stopped: wallet changed");
    this.name = "ScanStopped";
  }
}

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
    readonly net: NetworkId = "fractal",
  ) {}

  /** Bitcoin: where reading starts (the vault's birthday is a Fractal height). */
  private startHeight?: number;
  private birthdayFor(fractalBirthday?: number): number {
    if (this.net === "fractal") return fractalBirthday ?? DEFAULT_BIRTHDAY;
    return this.startHeight ?? netInfo(this.net).defaultBirthday;
  }

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
    this.cancelScan();
    // Session-only Payjoin secrets are deleted, never carried over (audit H9). The UI asks first.
    await this.cancelOpenPayjoins("wallet switched").catch(() => undefined);
    // A held payment belongs to this wallet. It goes out now rather than waiting unseen (the UI says so first).
    await this.sendAllDelayedNow().catch(() => undefined);
    await this.settle().catch(() => undefined);
    await this.lock();
    await this.kv.remove([SCAN_GRANT_KEY]);
    this.close();
  }

  /** Bumped by PrivateBit when this wallet is closed, so its scan stops at the next check. */
  close(): void {
    this.cancelScan();
    this.coins_.close();
    this.walletEpoch += 1;
    this.keyCache = undefined;
    this.grantCache = undefined;
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

  /** One scan run at a time per wallet. Writes to the coin list are serialized by CoinStore. */
  private enqueueScan<T>(fn: () => Promise<T>): Promise<T> {
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
  /**
   * The open session: the seed is opened from its sealed box for this call only (see
   * sessionkeys.ts). Nothing here is cached; callers that are done with the seed zero it.
   */
  private async session(): Promise<SessionVault | null> {
    const vault = await loadSession(this.kv);
    if (!vault) this.keyCache = undefined;
    return vault;
  }

  /**
   * Full account (spend key included) for one operation. Derived fresh each time and never
   * cached, so the spend secret lives only as long as the operation that asked for it. The seed
   * copy it came from is zeroed right away.
   */
  private accountOf(vault: SessionVault): Account {
    const account = accountFromVault(vault, 0, this.net);
    return account;
  }

  private keysFor(session: SessionVault): NonNullable<WalletCore["keyCache"]> {
    const sig = session.sig;
    const c = this.keyCache;
    if (c && c.sig === sig) return c;
    const account = this.accountOf(session);
    const next = { sig, key: deriveDataKey(session.seed), scanKey: deriveScanKey(session.seed), spendPub: hex(account.spendPub) };
    account.spendSecret.fill(0);
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

  /** After a chain switch while unlocked: leave this chain's scan keys too, so it keeps reading after Lock. */
  async ensureGrant(): Promise<void> {
    const session = await this.session();
    if (session && !(await loadScanGrant(this.kv))) await this.writeGrant(session);
  }

  /** Leave only what matching needs for after Lock. Never the words, seed or spend secret. */
  private async writeGrant(unlocked: { seed: Uint8Array; birthday: number }): Promise<void> {
    const account = accountFromVault(unlocked, 0, this.net);
    await saveScanGrant(this.kv, {
      v: 2,
      scanSecret: hex(account.scanSecret),
      spendPub: hex(account.spendPub),
      scanKey: hex(deriveScanKey(unlocked.seed)),
      birthday: unlocked.birthday,
    });
    this.grantCache = undefined;
    this.coins_.invalidate();
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
    await this.sealPlainSessions();
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

  /** Mailbox keys of open Payjoins, sealed under the session "pj" key (never plain in storage). */
  private async hpkeSecrets(): Promise<Record<string, string>> {
    const rec = (await this.kv.get([PJ_HPKE]))[PJ_HPKE] as (SealedBox & { sealed?: 1 }) | Record<string, string> | undefined;
    if (!rec) return {};
    if ((rec as { sealed?: 1 }).sealed !== 1) {
      // An older build kept these plain. Seal them now.
      const plain = rec as Record<string, string>;
      await this.writeHpke(plain);
      return { ...plain };
    }
    const raw = await openBox(rec as SealedBox, PJ_HPKE_AAD);
    return raw ? (JSON.parse(new TextDecoder().decode(raw)) as Record<string, string>) : {};
  }

  private async writeHpke(all: Record<string, string>): Promise<void> {
    const prev = (await this.kv.get([PJ_HPKE]))[PJ_HPKE] as SealedBox | undefined;
    if (!Object.keys(all).length) await this.kv.remove([PJ_HPKE]);
    else {
      const box = await sealBox(new TextEncoder().encode(JSON.stringify(all)), PJ_HPKE_AAD);
      await this.kv.set({ [PJ_HPKE]: { ...box, sealed: 1 } });
    }
    await dropBox(prev);
  }

  private async saveHpkeSecret(id: string, sk: Uint8Array): Promise<void> {
    const all = await this.hpkeSecrets();
    all[id] = hex(sk);
    await this.writeHpke(all);
  }

  private async loadPjGrant(): Promise<PjGrant | null> {
    const box = (await this.kv.get([PJ_GRANT]))[PJ_GRANT] as SealedBox | undefined;
    const raw = await openBox(box, PJ_GRANT_AAD);
    if (!raw) return null;
    const g = JSON.parse(new TextDecoder().decode(raw)) as PjGrant;
    raw.fill(0);
    return g.v === 1 ? g : null;
  }

  private async savePjGrant(g: PjGrant): Promise<void> {
    const prev = (await this.kv.get([PJ_GRANT]))[PJ_GRANT] as SealedBox | undefined;
    const open = g.recv.some((x) => receiveOpen(x.s)) || g.sends.length > 0 || g.done.length > 0;
    if (!open) await this.kv.remove([PJ_GRANT]);
    else await this.kv.set({ [PJ_GRANT]: await sealBox(new TextEncoder().encode(JSON.stringify(g)), PJ_GRANT_AAD) });
    await dropBox(prev);
  }

  /**
   * At Lock: scoped keys for each waiting Payjoin, so it can finish without the wallet staying
   * unlocked. Returns false when nothing is waiting.
   */
  private async writePjGrant(): Promise<boolean> {
    const now = Date.now();
    const recv = (await this.loadPayjoinSessions()).filter((s) => receiveOpen(s) && s.reserved && now <= receiveDeadline(s));
    const sends = (await this.loadPayjoinSends()).filter((s) => s.status === "waiting" && s.expiresAt > now);
    if (!recv.length && !sends.length) {
      const box = (await this.kv.get([PJ_GRANT]))[PJ_GRANT] as SealedBox | undefined;
      await this.kv.remove([PJ_GRANT]);
      await dropBox(box);
      return false;
    }
    const { account } = await this.requireAccount();
    const grant: PjGrant = {
      v: 1,
      recv: recv.map((s) => ({ s: { ...s, inputSecret: undefined }, secret: hex(evenPriv(inputSecret(account, s.reserved!))) })),
      sends: sends.map((s) => ({ id: s.id, secrets: Object.fromEntries(s.signableInputs.map((u) => [`${u.txid}:${u.vout}`, hex(inputSecret(account, u))])) })),
      done: [],
    };
    account.spendSecret.fill(0);
    await this.savePjGrant(grant);
    return true;
  }

  /** At unlock: take back what happened while locked into the sealed sessions and history. */
  private async absorbPjGrant(account: Account): Promise<void> {
    const g = await this.loadPjGrant();
    if (!g) return;
    if (g.recv.length) {
      const sessions = await this.loadPayjoinSessions();
      for (const x of g.recv) {
        const i = sessions.findIndex((s) => s.id === x.s.id);
        if (i >= 0) sessions[i] = { ...sessions[i]!, ...x.s, inputSecret: undefined };
      }
      await this.savePayjoinSessions(sessions);
    }
    if (g.done.length) {
      const sends = await this.loadPayjoinSends();
      for (const d of g.done) {
        const s = sends.find((x) => x.id === d.id);
        if (s) await this.recordPayjoinSend(account, s, d.proposal, d.txHex, d.txid).catch(() => undefined);
      }
    }
    const box = (await this.kv.get([PJ_GRANT]))[PJ_GRANT] as SealedBox | undefined;
    await this.kv.remove([PJ_GRANT]);
    await dropBox(box);
  }

  /** Locked version of closeExpired, on the grant's copy of each link. */
  private async closeExpiredLocked(g: PjGrant): Promise<void> {
    const now = Date.now();
    const gone: string[] = [];
    for (const x of g.recv) {
      const s = x.s;
      if (!receiveOpen(s) || now <= receiveDeadline(s)) continue;
      const proposed = s.status === "proposed";
      if (proposed) s.fallbackTxid = await this.broadcastOriginal(s.id);
      this.endReceive(s, proposed ? (s.fallbackTxid ? "not broadcast by the payer; their original payment was sent instead" : "not broadcast") : "expired");
      x.secret = "";
      gone.push(s.id, ORIGINAL_PREFIX + s.id);
    }
    const sends = await this.loadPayjoinSends();
    let dirty = false;
    for (const s of sends) {
      if (s.status === "waiting" && now > s.expiresAt) {
        this.endSend(s, "expired");
        g.sends = g.sends.filter((x) => x.id !== s.id);
        gone.push(SEND_HPKE_PREFIX + s.id);
        dirty = true;
      }
    }
    if (dirty) await this.savePayjoinSends(sends);
    if (gone.length) await this.forgetPayjoinSecrets(gone);
    await this.savePjGrant(g);
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
    const got = await this.kv.get([PJ_HPKE, PJ_GRANT]);
    await this.kv.remove([PJ_HPKE, PJ_GRANT]);
    await dropBox(got[PJ_HPKE] as SealedBox | undefined);
    await dropBox(got[PJ_GRANT] as SealedBox | undefined);
  }

  source(): ChainSource {
    return this.sourceOverride ?? openChain(this.chainCfg, this.net);
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
    for (const op of protectedOutpoints(scan.utxos, meta)) frozen.add(op);
    const unspent = scan.utxos.filter((u) => !u.spent);
    const notFrozen = unspent.filter((u) => !frozen.has(outpointOf(u)));
    const sum = (list: typeof unspent): bigint => list.reduce((a, u) => a + BigInt(u.value), 0n);
    const pending = sum(notFrozen.filter((u) => u.height === 0));
    const confirmed = sum(notFrozen.filter((u) => u.height > 0));
    await this.closeExpired();
    const receive = (await this.loadPayjoinSessions()).filter(receiveOpen);
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
    const words = session.words;
    return {
      hasVault: true,
      hasBackup,
      unlocked: true,
      receive: account.receive,
      birthday: this.birthdayFor(session.birthday),
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
            ? "They paid. Your coin is added. Waiting for them to broadcast."
            : sending
              ? "Waiting for them to add an input. Stay unlocked. Don't lock."
              : undefined,
      payjoin: live
        ? { role: "receive", status: live.status, amount: live.amount, expiresAt: live.expiresAt, deadline: receiveDeadline(live), createdAt: live.createdAt, id: live.id, error: live.error }
        : sending
          ? { role: "send", status: sending.status, amount: sending.amount, expiresAt: sending.expiresAt, deadline: sending.expiresAt, createdAt: sending.createdAt, id: sending.id, error: sending.error }
          : undefined,
      oneTimeFunded,
      historyRebuilding: hist.rebuilding === true,
      hasHistory: Object.keys(hist.entries).length > 0,
      mnemonicWords: words,
      hasPassphrase: session.hasPassphrase,
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
    // Audit H2: links are derived by index, so watch the first ones right away.
    for (const w of pjWatchesFor(account, 0, PJ_GAP)) scan = addWatch(scan, w);
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
    const seeded = this.restoredScan(accountFromVault(unlocked, 0, this.net), args.birthday);
    await this.saveOneTime(seeded.ot);
    await this.saveScan(seeded.scan);
  }

  /** Birthday is plaintext on the vault blob. Rewinds scan so that height is scanned again. */
  async setBirthday(birthday: number): Promise<void> {
    if (birthday <= 0) throw new Error("birthday height required (Fractal tip is past 2M; 0 is genesis)");
    if (this.net !== "fractal") {
      // Bitcoin keeps its own start; the vault's birthday stays the Fractal one.
      await this.kv.set({ [BIRTHDAY_KEY]: birthday });
      this.startHeight = birthday;
      const prevB = await this.loadScan();
      let nextB = emptyScanStore(birthday);
      for (const w of prevB.watch ?? []) nextB = addWatch(nextB, w);
      await this.coins_.replace(nextB);
      return;
    }
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
    await this.coins_.replace(next);
  }

  async unlock(password: string): Promise<void> {
    this.sideWorkAt = 0;
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    const unlocked = await this.passwordGate(() => unlockVault(blob, password));
    // Audit L9: re-save an older vault with the current scrypt cost. Same words, same password.
    if (vaultNeedsStrongerKdf(blob)) await persistVault(this.kv, lockVault(unlocked, password)).catch(() => undefined);
    await saveSession(this.kv, unlocked);
    await this.writeGrant(unlocked);
    await this.retireStaleBackup(unlocked, password);
    await this.migrateAtRest();
    await this.afterUnlock();
  }

  /** Work that waited for the data key: link deadlines and payments found while locked. */
  private async afterUnlock(): Promise<void> {
    try {
      // What a Payjoin did while locked goes back into the sealed sessions and history first.
      const { account } = await this.requireAccount();
      await this.absorbPjGrant(account);
      account.spendSecret.fill(0);
    } catch {
      /* absorbed again at the next Payjoin step */
    }
    try {
      await this.closeExpired();
      await this.notePayjoinPaid(await this.loadScan());
      await this.finishDelayedRecords();
    } catch {
      /* the next scan step runs it again */
    }
  }

  /** Check the password without changing anything (backup screen, remove wallet). */
  async checkPassword(password: string): Promise<UnlockedVault> {
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    return this.passwordGate(() => unlockVault(blob, password));
  }

  /**
   * Every password check goes through here. After 3 wrong passwords each try waits, doubling
   * from 30 seconds up to an hour. Kept in local storage, so restarting does not reset it.
   */
  private async passwordGate<T>(f: () => T): Promise<T> {
    const g = ((await this.kv.get([UNLOCK_GUARD]))[UNLOCK_GUARD] as { fails: number; until: number } | undefined) ?? { fails: 0, until: 0 };
    const now = Date.now();
    if (g.until > now) throw new Error(`Too many wrong passwords. Try again in ${waitText(g.until - now)}.`);
    try {
      const r = f();
      if (g.fails) await this.kv.remove([UNLOCK_GUARD]);
      return r;
    } catch (e) {
      if (/wrong password/i.test(String((e as Error).message))) {
        const fails = g.fails + 1;
        await this.kv.set({ [UNLOCK_GUARD]: { fails, until: now + unlockWaitMs(fails) } });
      }
      throw e;
    }
  }

  /** This wallet's fingerprint, from the session or the scan grant. Unknown when neither is there. */
  async fingerprint(): Promise<string | undefined> {
    const s = await this.session();
    if (s) return walletFingerprint(this.keysFor(s).spendPub);
    const g = await loadScanGrant(this.kv);
    return g ? walletFingerprint(g.spendPub) : undefined;
  }

  /** True when this seed opens this wallet's coin list (works while locked, no fingerprint needed). */
  async ownsSeed(seed: Uint8Array): Promise<boolean> {
    const raw = (await this.kv.get([SCAN_KEY]))[SCAN_KEY];
    if (!raw || !isSealed(raw)) return false;
    for (const key of [deriveScanKey(seed), deriveDataKey(seed)]) {
      try {
        openJson(key, SCAN_KEY, raw);
        return true;
      } catch {
        /* not this one */
      }
    }
    return false;
  }

  /**
   * Open this wallet with its recovery words, which prove ownership. Coins, labels and history
   * stay. The password changes only when newPassword is given (forgot password).
   */
  async openWithWords(args: { mnemonic: string; passphrase?: string; newPassword?: string }): Promise<void> {
    const blob = await loadVaultBlob(this.kv);
    if (!blob) throw new Error("no vault");
    const unlocked = vaultFromMnemonic({ mnemonic: args.mnemonic, passphrase: args.passphrase, birthday: blob.birthday });
    const known = await this.fingerprint();
    const fp = walletFingerprint(hex(accountFromVault(unlocked).spendPub));
    if (known ? known !== fp : !(await this.ownsSeed(unlocked.seed))) throw new Error("These words belong to a different wallet.");
    this.sideWorkAt = 0;
    if (args.newPassword) {
      await persistVault(this.kv, lockVault(unlocked, args.newPassword));
      await this.retireStaleBackup(unlocked, args.newPassword);
    }
    await saveSession(this.kv, unlocked);
    await this.writeGrant(unlocked);
    await this.migrateAtRest();
    await this.afterUnlock();
  }

  /**
   * The old password stops working everywhere: the vault is rewritten without keeping a copy,
   * and an earlier copy of this same wallet (left by older builds) is deleted. A previous
   * different wallet that used the same password is moved to the new password too.
   */
  async changePassword(current: string, next: string): Promise<void> {
    // Audit M1 (independent): new passwords are at least 12 characters. Existing ones still unlock.
    if ([...next].length < 12) throw new Error("password too short");
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
        await this.coins_.flush();
        await this.onScanSaved(await this.loadScan());
      } catch {
        /* history is rebuilt at the next unlock */
      }
    }
    this.cancelScan();
    let keepPj = false;
    if (await this.dataKey()) {
      // Done while the data key is still there: the sessions are sealed with it.
      const sessions = await this.loadPayjoinSessions();
      let dirty = false;
      for (const s of sessions) {
        if (s.inputSecret) {
          s.inputSecret = undefined;
          dirty = true;
        }
      }
      if (dirty) await this.savePayjoinSessions(sessions);
      keepPj = await this.writePjGrant().catch(() => false);
    }
    this.keyCache = undefined;
    await clearSession(this.kv);
    if (!keepPj) {
      await this.clearHpkeSecrets();
      await this.kv.remove([PJ_SEND]);
    }
  }

  async requireAccount(): Promise<{ vault: Omit<SessionVault, "seed">; account: Account; scan: ScanStore }> {
    const vault = await this.session();
    if (!vault) throw new Error("locked");
    const account = this.accountOf(vault);
    vault.seed.fill(0);
    const { seed: _gone, ...info } = vault;
    return { vault: info, account, scan: await this.loadScan() };
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
    try {
      return await this.scanRun();
    } catch (e) {
      // Another writer moved the list on, or the wallet was switched: stop; the next run starts fresh.
      if (e instanceof StaleWriteError || e instanceof ScanStopped) {
        const s = await this.loadScan().catch(() => undefined);
        return { done: false, lastHeight: s?.lastHeight ?? 0, tip: s?.tip ?? 0, height: s?.lastHeight ?? 0, txIndex: 0, txCount: 0, skipped: 0 };
      }
      throw e;
    }
  }

  /** Cancel handle for the scan run in progress. Lock, switch and remove abort it. */
  private runAbort?: AbortController;
  /** Heights whose input data came back incomplete, and how often. Bounded by the run. */
  private incomplete = new Map<number, number>();

  /** Stop the scan run in progress (Lock, switch, remove). The next run resumes from the checkpoint. */
  cancelScan(): void {
    this.runAbort?.abort(new ScanStopped());
    this.runAbort = undefined;
  }

  /**
   * One scan run, in three stages per block:
   *   fetch   download the block (or its transactions) with no lock held,
   *   match   compare it to a snapshot of the coin list, CPU only,
   *   persist commit against the snapshot's rev; if anything else wrote meanwhile, redo the
   *           block from a fresh read (the block itself is cached).
   * Runs until the tip or the time budget. Progress is saved as a checkpoint, so a worker
   * restart continues from the last saved block.
   */
  private async scanRun(): Promise<ScanProgress> {
    const epoch = this.walletEpoch;
    const idle: ScanProgress = { done: false, lastHeight: 0, tip: 0, height: 0, txIndex: 0, txCount: 0, skipped: 0 };
    const session = await this.session();
    const full = session ? this.accountOf(session) : undefined;
    const grant = full ? null : await this.grant();
    const account: ScanAccount | undefined = full ?? grant?.account;
    if (!account) return idle;
    const mark: ScanMark = { epoch, spendPub: hex(account.spendPub) };
    this.cancelScan();
    const abort = new AbortController();
    this.runAbort = abort;
    const signal = abort.signal;
    const source = cancellable(this.cachedScanSource(), signal);
    let snap = await this.coins_.read();
    const stopped = (): ScanProgress => ({
      done: false,
      lastHeight: snap.store.lastHeight,
      tip: snap.store.tip ?? snap.store.lastHeight,
      height: snap.store.lastHeight,
      txIndex: 0,
      txCount: 0,
      skipped: 0,
    });
    try {
      const tip = await source.getTip();
      if (mark.epoch !== this.walletEpoch) return stopped();
      await this.checkReorg(source, mark);
      const started = Date.now();
      if (started - this.sideWorkAt >= 20_000) {
        this.sideWorkAt = started;
        await this.sideWork(full, account, source, mark);
      }
      let progress: ScanProgress | undefined;
      let ahead: { height: number; block: Promise<SharedBlock> } | undefined;
      for (;;) {
        signal.throwIfAborted();
        if (mark.epoch !== this.walletEpoch) return progress ?? stopped();
        snap = await this.coins_.read();
        let store = snap.store;
        const height = store.inflight?.height ?? store.lastHeight + 1;
        if (height > tip.height) {
          if (store.tip !== tip.height) store = { ...store, tip: tip.height };
          snap = { store: await this.scanCommit(store, mark, snap.rev), rev: snap.rev + 1 };
          progress = { done: true, lastHeight: store.lastHeight, tip: tip.height, height: store.lastHeight, txIndex: 0, txCount: 0, skipped: 0 };
          break;
        }
        const cursor = `${store.lastHeight}:${store.inflight?.height ?? ""}:${store.inflight?.nextTx ?? ""}`;
        // fetch
        let block: SharedBlock | undefined;
        const legacy = (this.incomplete.get(height) ?? 0) >= 3;
        if (!legacy) {
          try {
            const queued = ahead?.height === height ? ahead.block : undefined;
            ahead = undefined;
            block = await (queued ?? loadSharedBlock(height, source));
            signal.throwIfAborted();
            this.incomplete.delete(height);
            if (height + 1 <= tip.height) {
              const nextBlock = loadSharedBlock(height + 1, source);
              void nextBlock.catch(() => {});
              ahead = { height: height + 1, block: nextBlock };
            }
          } catch (e) {
            if (e instanceof IncompleteBlock) {
              // Never matched or saved with inputs missing. Retried; after 3 tries per-transaction data is used.
              this.incomplete.set(height, (this.incomplete.get(height) ?? 0) + 1);
              if (this.incomplete.size > 64) this.incomplete.delete(this.incomplete.keys().next().value!);
              throw e;
            }
            if (!(e instanceof UnsupportedBlock)) throw e;
          }
        }
        if (block && store.inflight && store.inflight.txids.length > 0) {
          // A block left half read on the per-transaction path (older builds used it for every block).
          // Read it again whole from the shared copy; coins already found are kept, never doubled.
          // Without this, a store from an older build kept asking the data service per transaction.
          store = { ...store, inflight: undefined };
        }
        // match
        let step: { store: ScanStore; progress: ScanProgress };
        try {
          step = block
            ? applySharedSlice(account, store, block, store.inflight?.height === height ? store.inflight.nextTx : 0, tip.height)
            : await scanStep(account, source, store, tip.height);
        } catch (e) {
          if (e instanceof ReorgError) {
            await this.handleReorg(source, mark, e.height);
            ahead = undefined;
            continue;
          }
          throw e;
        }
        if (!block && step.store.lastHeight > store.lastHeight) {
          // Per-transaction path has no header; ask for this block's hash for reorg detection.
          noteBlockHash(step.store, step.store.lastHeight, await source.getBlockHash(step.store.lastHeight).catch(() => undefined));
        }
        signal.throwIfAborted();
        // persist (version checked against the snapshot)
        try {
          await this.scanCommit(step.store, mark, snap.rev);
        } catch (e) {
          if (e instanceof StaleWriteError) continue;
          throw e;
        }
        progress = step.progress;
        const now = `${step.store.lastHeight}:${step.store.inflight?.height ?? ""}:${step.store.inflight?.nextTx ?? ""}`;
        if (now === cursor || progress.done || Date.now() - started >= SCAN_BUDGET_MS) break;
      }
      await this.settle();
      return progress ?? stopped();
    } finally {
      if (this.runAbort === abort) this.runAbort = undefined;
    }
  }

  /** Commit a scan step (to memory; persisted by CoinStore). Throws if the wallet changed. */
  private async scanCommit(store: ScanStore, mark: ScanMark, baseRev?: number): Promise<ScanStore> {
    if (!(await this.scanStillHere(mark))) throw new ScanStopped();
    return this.coins_.commit(baseRev ?? store.rev ?? 0, store, { flush: false });
  }

  /** Once per run: is the last block we matched still on the chain? */
  private async checkReorg(source: ChainSource, mark: ScanMark): Promise<void> {
    const snap = await this.coins_.read();
    const last = snap.store.recent?.[snap.store.recent.length - 1];
    if (!last || last[0] !== snap.store.lastHeight) return;
    const hash = (await source.getBlockHash(last[0])).toLowerCase();
    if (hash && hash !== last[1]) await this.handleReorg(source, mark, last[0]);
  }

  /** Walk back through recent hashes to the fork, roll the coin list back, forget cached blocks. */
  private async handleReorg(source: ChainSource, mark: ScanMark, height: number): Promise<void> {
    const snap = await this.coins_.read();
    const recent = [...(snap.store.recent ?? [])].reverse();
    let fork = recent.length ? recent[recent.length - 1]![0] : height;
    for (const [h, hash] of recent) {
      if (h >= height) continue;
      const now = (await source.getBlockHash(h).catch(() => "")).toLowerCase();
      if (now === hash) {
        fork = h + 1;
        break;
      }
      fork = h;
    }
    if (!(await this.scanStillHere(mark))) throw new ScanStopped();
    await forgetSharedFrom(fork);
    await this.coins_.update((cur) => rollbackTo(cur, fork), { flush: true });
  }

  /**
   * Every 20 s: keep one-time watches, retry deferred transactions, prune old watches,
   * prune the shared block cache. Nothing here sends a txid or an address of ours anywhere.
   */
  private async sideWork(full: Account | undefined, account: ScanAccount, source: ChainSource, mark: ScanMark): Promise<void> {
    const keep = full ? await this.watchesToKeep() : null;
    const ot = full ? await this.oneTimeIndexes() : null;
    const sites = full ? (await this.loadSites().catch(() => emptySites())).sites.map((x) => x.index) : null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = await this.coins_.read();
      let store = snap.store;
      if (full && ot) store = this.withOneTimeWatches(full, store, ot);
      if (full && sites) store = this.withSiteWatches(full, store, sites);
      if (full && ot) {
        // Audit H2: keep every derived link output watched, plus a gap past the last one used.
        const pj = pjWatchesFor(full, 0, pjNextIndex(full, store, await this.loadOneTime()) + PJ_GAP);
        for (const w of pj) {
          store = addWatch(store, w);
          keep?.add(w.scriptPubKey);
        }
      }
      // Deferred holes are transactions of blocks we scanned, not ours; refetching them reveals nothing about us.
      store = await retryDeferred(account, source, store);
      if (keep) store = pruneWatches(store, keep);
      try {
        await this.scanCommit(store, mark, snap.rev);
        break;
      } catch (e) {
        if (!(e instanceof StaleWriteError)) throw e;
      }
    }
    if (full) await this.recoverPayjoinChange(account, source).catch(() => undefined);
    const pos = (await this.coins_.read()).store.lastHeight;
    if (pos > 5_000) void pruneSharedBelow(pos - 5_000).catch(() => undefined);
  }

  /** Payjoin sends already checked for missing change in this run of the app. */
  private changeChecked = new Set<string>();

  /**
   * Recovery for Payjoins sent before the change fix: their change was never added. Re-read each
   * sent Payjoin that has no change recorded, match it with our own spent coins, and fill in the
   * coin and the history row. Read only; nothing is signed or broadcast.
   */
  private async recoverPayjoinChange(account: ScanAccount, source: ChainSource): Promise<void> {
    const hist = await this.loadHistory();
    const todo = Object.values(hist.entries).filter(
      (e) => e.kind === "payjoin-sent" && !e.change && !e.changeChecked && !this.changeChecked.has(e.txid),
    );
    if (todo.length === 0) return;
    let found = false;
    for (const e of todo.slice(0, 8)) {
      this.changeChecked.add(e.txid);
      // Audit M8 (independent): one look per Payjoin, ever. With your node, ask the node. In public
      // mode ask the block explorer, never with the data service token, and take the height from history.
      let txHex: string | undefined;
      try {
        txHex = source.kind === "core" ? await source.getTxHex(e.txid) : await mempoolTxHex(e.txid, this.net === "bitcoin" ? MEMPOOL_BITCOIN : MEMPOOL_FRACTAL);
      } catch {
        txHex = undefined;
      }
      if (!txHex) {
        this.changeChecked.delete(e.txid);
        continue;
      }
      e.changeChecked = true;
      found = true;
      const height = source.kind === "core" && source.getTxHeight ? ((await source.getTxHeight(e.txid).catch(() => null)) ?? 0) : (e.height ?? 0);
      for (let attempt = 0; attempt < 3; attempt++) {
        const snap = await this.coins_.read();
        const next = await applyTxHex(account, source, snap.store, txHex, height);
        try {
          await this.coins_.commit(snap.rev, next, { flush: true });
          break;
        } catch (err) {
          if (!(err instanceof StaleWriteError)) throw err;
        }
      }
      const mine = (await this.coins_.read()).store.utxos.filter((u) => u.txid === e.txid);
      if (mine.length === 0) continue;
      const value = mine.reduce((a, u) => a + BigInt(u.value), 0n);
      e.change = value.toString();
      const ops = new Set(e.outpoints ?? []);
      for (const u of mine) ops.add(`${u.txid}:${u.vout}`);
      e.outpoints = [...ops];
      found = true;
    }
    if (found) await this.saveHistory(hist);
  }

  /** Scripts of payment links that are open, or closed less than a week ago. */
  private async watchesToKeep(): Promise<Set<string> | null> {
    const keep = new Set<string>();
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // Locked in the meantime: the sessions cannot be read, so nothing is pruned this time.
    const sessions = await this.readPayjoinSessions();
    if (!sessions) return null;
    for (const s of sessions) {
      const open = s.status === "waiting" || s.status === "proposed";
      if (open || (s.closedAt ?? s.expiresAt ?? 0) > weekAgo) {
        if (s.scriptPubKey) keep.add(s.scriptPubKey.toLowerCase());
        if (s.extraScriptPubKey) keep.add(s.extraScriptPubKey.toLowerCase());
      }
    }
    return keep;
  }

  /** One-time indexes that must stay watched, even if an earlier coin list was replaced. */
  private async oneTimeIndexes(): Promise<number[]> {
    const ot = await this.loadOneTime();
    const indexes = new Set(ot.records.map((r) => r.index));
    if (ot.restoredWindow !== undefined) for (let i = 0; i < ot.restoredWindow; i++) indexes.add(i);
    return [...indexes];
  }

  private withOneTimeWatches(account: Account, store: ScanStore, indexes: number[]): ScanStore {
    let next = store;
    for (const index of indexes) {
      const k = account.oneTime(index);
      if ((next.watch ?? []).some((w) => w.scriptPubKey === k.scriptPubKey)) continue;
      next = addWatch(next, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index });
    }
    return next;
  }

  private withSiteWatches(account: Account, store: ScanStore, indexes: number[]): ScanStore {
    let next = store;
    for (const index of indexes) {
      const k = account.site!(index);
      if ((next.watch ?? []).some((w) => w.scriptPubKey === k.scriptPubKey)) continue;
      next = addWatch(next, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "site", index });
    }
    return next;
  }

  /**
   * Apply a transaction we just broadcast. Parents are fetched outside the writer queue, then
   * committed against the rev they were prepared from; a concurrent write means try again.
   */
  private async applyOwnTx(account: ScanAccount, txHex: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const snap = await this.coins_.read();
      const next = await applyTxHex(account, this.source(), snap.store, txHex, 0);
      try {
        await this.coins_.commit(snap.rev, next, { flush: true });
        return;
      } catch (e) {
        if (!(e instanceof StaleWriteError)) throw e;
      }
    }
    throw new Error("could not record the broadcast payment; it will appear after the next block");
  }

  /** Apply our own broadcast and return the change it gave back to us. */
  private async applyOwnTxChange(account: ScanAccount, txHex: string, txid: string): Promise<{ value: bigint; outpoints: string[] }> {
    await this.applyOwnTx(account, txHex);
    const store = (await this.coins_.read()).store;
    const mine = store.utxos.filter((u) => u.txid === txid);
    return { value: mine.reduce((a, u) => a + BigInt(u.value), 0n), outpoints: mine.map((u) => `${u.txid}:${u.vout}`) };
  }

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
  async blockedOutpoints(): Promise<{ reserved: Set<string>; frozen: Set<string>; guarded: Set<string> }> {
    const receive = await this.loadPayjoinSessions();
    const reserved = new Set(
      receive
        .filter((s) => receiveOpen(s) && s.reserved)
        .map((s) => `${s.reserved!.txid}:${s.reserved!.vout}`),
    );
    const sends = await this.loadPayjoinSends();
    for (const s of sends) {
      if (s.status !== "waiting") continue;
      for (const inp of s.signableInputs) reserved.add(`${inp.txid}:${inp.vout}`);
    }
    for (const d of await this.loadDelayed()) {
      if (d.status !== "waiting") continue;
      for (const inp of d.signableInputs) reserved.add(`${inp.txid}:${inp.vout}`);
    }
    const meta = await this.loadCoinMeta();
    const frozen = frozenOutpoints(meta);
    // 1.0.0 asset guard: coins that may hold an inscription or rune are never picked by the wallet.
    const scan = await this.loadScan().catch(() => undefined);
    const guarded = scan ? protectedOutpoints(scan.utxos, meta) : new Set<string>();
    for (const op of guarded) frozen.add(op);
    return { reserved, frozen, guarded };
  }

  async planSend(destination: string, amount: bigint, opts: PlanOptions = {}): Promise<BuiltPlan> {
    const { account, scan } = await this.requireAccount();
    const chosenRate = opts.feeRate ?? (await this.source().estimateFeeSatPerVb());
    if (!Number.isFinite(chosenRate) || chosenRate <= 0) throw new Error("fee rate must be above 0 sat/vB");
    const seed = isPlanSeed(opts.seed) ? opts.seed : newPlanSeed();
    const feeRate = opts.randomizeFee ? jitterFeeRate(chosenRate, seed, opts.minFeeRate) : chosenRate;
    const { reserved, frozen } = await this.blockedOutpoints();
    const skipOutpoints = new Set([...reserved, ...frozen]);
    if (!opts.coins) {
      // Automatic never touches a one-time coin; it is moved by its own sweep.
      for (const u of scan.utxos) if (u.kind === "bip86") skipOutpoints.add(outpointOf(u));
    }
    const built = await buildSend({
      account,
      utxos: scan.utxos,
      destination,
      amount,
      feeRate,
      source: this.source(),
      skipOutpoints,
      include: opts.coins,
      max: opts.max,
      leftover: leftoverLimit(feeRate, opts.leftover ?? "auto"),
      seed,
    });
    return { ...built, feeRate };
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
    return this.payloadOf(await this.planSend(destination, amount, opts));
  }

  private async payloadOf(built: BuiltPlan): Promise<PlanPayload> {
    const meta = await this.loadCoinMeta().catch(() => ({}) as CoinMetaMap);
    const inputs = built.signableInputs.map((u) => `${u.txid}:${u.vout}`);
    return {
      ...planPayload(built),
      ...(built.feeRate !== undefined ? { feeRate: built.feeRate } : {}),
      inputLabels: groupInputLabels(inputs, (op) => meta[op]?.label),
      planId: planDigest(built.psbtBase64, { chain: netInfo(this.net).planChain, wallet: this.walletId }),
    };
  }

  /**
   * Confirm binds to the reviewed plan (audit M10). The plan is built again from the same
   * request; it is sent only if its id matches the one reviewed. Otherwise nothing is signed
   * for broadcast and the new plan comes back for a second review.
   */
  async confirmPlan(
    planId: string,
    destination: string,
    amount: bigint,
    opts: PlanOptions & { feeRate: number },
  ): Promise<{ ok: true; built: BuiltPlan } | { ok: false; plan: PlanPayload }> {
    if (!/^[0-9a-f]{64}$/.test(planId)) throw new PolicyError("Review the payment first.");
    if (!Number.isFinite(opts.feeRate) || opts.feeRate <= 0) throw new PolicyError("Review the payment first.");
    await this.assertNotOwnLink(destination);
    const built = await this.planSend(destination, amount, opts);
    const now = await this.payloadOf(built);
    if (now.planId !== planId) return { ok: false, plan: now };
    return { ok: true, built };
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
    extra?: { label?: string; feeRate?: number; kind?: HistoryKind; holdMs?: number },
  ): Promise<BroadcastResult> {
    await this.requireAccount();
    if (intent !== INTENT_PAYJOIN && extra?.holdMs && extra.holdMs > 0) {
      // "Delay sending by a random time": signed now, held encrypted, sent by the worker later.
      const held = await this.holdDelayed(built, { label: extra.label, feeRate: extra.feeRate ?? 0, holdMs: extra.holdMs });
      return { kind: "delayed", id: held.id, sendAt: held.sendAt };
    }
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
        label: extra?.label,
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
    // Re-read inside the writer queue so a scan step prepared earlier cannot undo this.
    // Confirmation comes from our own block scan; the txid is not looked up anywhere.
    await this.coins_.update((fresh) => applyBuiltSend(fresh, hexTx, built.ourOutputs), { flush: true });
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
    const linked = spent.some((op) => meta[op]?.linked) || built.signableInputs.some((u) => u.kind === "bip86" || u.kind === "site");
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
      onchain: kind === "self" || kind === "split" ? undefined : paymentOutputAddress(built.txHex, built.ourOutputs.map((o) => o.vout)),
      net: this.net,
      label,
      outpoints: [...spent, ...change],
      change: built.change,
      now: Date.now(),
      linked,
      pieces: kind === "split" ? built.ourOutputs.length : undefined,
    });
    await this.saveHistory(hist);
  }

  /* ---------- delayed sending ---------- */

  /** One change to the held list at a time: the timer, Send now and Cancel never race. */
  private delayTail: Promise<unknown> = Promise.resolve();
  private delayLocked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.delayTail.then(fn);
    this.delayTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async loadDelayed(): Promise<DelayedSend[]> {
    const got = await this.loadSealed<DelayedSend[]>(DELAYED_KEY, () => []);
    return Array.isArray(got.value) ? got.value : [];
  }

  /** False when the held list exists but cannot be opened right now (no key): never overwrite it then. */
  private async delayedReadable(): Promise<boolean> {
    const got = await this.loadSealed<DelayedSend[]>(DELAYED_KEY, () => []);
    return got.status !== "unreadable";
  }

  private async saveDelayed(list: DelayedSend[]): Promise<void> {
    // An empty list leaves no record, so an idle chain gets no scan grant at unlock.
    if (!list.length) await this.kv.remove([DELAYED_KEY]);
    else await this.saveSealed(DELAYED_KEY, list);
  }

  /** Held payments for the UI, without the signed transaction. */
  async delayedView(): Promise<DelayedView[]> {
    return (await this.loadDelayed()).map(({ txHex: _t, signableInputs: _s, ourOutputs: _o, ...v }) => v);
  }

  async holdDelayed(built: BuiltPlan, extra: { label?: string; feeRate: number; holdMs: number }): Promise<DelayedSend> {
    return this.delayLocked(async () => {
      const now = Date.now();
      const entry: DelayedSend = {
        id: hex(randomBytes(8)),
        createdAt: now,
        sendAt: now + Math.max(0, Math.round(extra.holdMs)),
        status: "waiting",
        txHex: built.txHex,
        label: extra.label,
        feeRate: extra.feeRate,
        amount: built.amount.toString(),
        fee: built.fee.toString(),
        change: built.change.toString(),
        destination: built.request.raw,
        signableInputs: built.signableInputs,
        ourOutputs: built.ourOutputs,
      };
      if (!(await this.delayedReadable())) throw new Error("held payments cannot be read right now; unlock and try again");
      const list = (await this.loadDelayed()).filter((d) => d.status === "waiting" || !d.recorded);
      list.push(entry);
      await this.saveDelayed(list);
      return entry;
    });
  }

  /** Cancel is safe: a held payment was never broadcast. Its coins become spendable again. */
  async cancelDelayed(id: string): Promise<boolean> {
    return this.delayLocked(async () => {
      const list = await this.loadDelayed();
      const d = list.find((x) => x.id === id);
      if (!d || d.status !== "waiting") return false;
      await this.saveDelayed(list.filter((x) => x.id !== id));
      return true;
    });
  }

  async sendAllDelayedNow(): Promise<void> {
    for (const d of await this.loadDelayed()) if (d.status === "waiting") await this.runDelayed({ only: d.id });
  }

  /** Drop a "not sent" entry after the user has seen it. */
  async dismissDelayed(id: string): Promise<void> {
    await this.delayLocked(async () => {
      const list = await this.loadDelayed();
      await this.saveDelayed(list.filter((x) => !(x.id === id && x.status === "failed")));
    });
  }

  /**
   * Broadcast every held payment that is due (or the one asked for with Send now). Works after
   * Lock: the list is sealed with the scan key. History and labels need the data key, so after
   * Lock they are written at the next unlock. Returns when the next one is due.
   */
  async runDelayed(opts: { now?: number; only?: string } = {}): Promise<{ sent: string[]; failed: string[]; next?: number }> {
    return this.delayLocked(async () => {
      const now = opts.now ?? Date.now();
      if (!(await this.delayedReadable())) return { sent: [], failed: [] };
      const list = await this.loadDelayed();
      const sent: string[] = [];
      const failed: string[] = [];
      for (const d of list) {
        if (d.status !== "waiting") continue;
        if (opts.only ? d.id !== opts.only : d.sendAt > now) continue;
        try {
          d.txid = await this.source().broadcast(d.txHex);
          d.status = "sent";
          d.sentAt = Date.now();
          sent.push(d.id);
          await this.coins_.update((fresh) => applyBuiltSend(fresh, d.txHex, d.ourOutputs), { flush: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/failed to fetch|fetch failed|network|timeout|timed out|abort|429|503|rate limit|request limit/i.test(msg)) {
            // Not reached the network: try again in a minute, still held.
            d.sendAt = now + 60_000;
          } else {
            d.status = "failed";
            d.error = msg;
            failed.push(d.id);
          }
        }
      }
      await this.recordDelayed(list);
      await this.saveDelayed(list);
      const next = list.filter((d) => d.status === "waiting").reduce<number | undefined>((m, d) => (m === undefined || d.sendAt < m ? d.sendAt : m), undefined);
      return { sent, failed, ...(next !== undefined ? { next } : {}) };
    });
  }

  /** Write history and labels for held payments that went out while locked. Mutates `list`. */
  private async recordDelayed(list: DelayedSend[]): Promise<void> {
    if (!(await this.dataKey())) return;
    for (const d of list) {
      if (d.status !== "sent" || d.recorded || !d.txid) continue;
      const builtLike = {
        signableInputs: d.signableInputs,
        ourOutputs: d.ourOutputs,
        amount: BigInt(d.amount),
        fee: BigInt(d.fee),
        change: BigInt(d.change),
        request: { raw: d.destination },
        txHex: d.txHex,
      } as unknown as Awaited<ReturnType<typeof buildSend>>;
      await this.afterBroadcast(d.txid, builtLike, "sent", d.label, d.feeRate);
      d.recorded = true;
    }
    // Sent and recorded entries are done; history has them now.
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.status === "sent" && list[i]!.recorded) list.splice(i, 1);
  }

  /** At unlock: finish the records of payments that were sent while locked. */
  async finishDelayedRecords(): Promise<void> {
    await this.delayLocked(async () => {
      const list = await this.loadDelayed();
      if (!list.some((d) => d.status === "sent" && !d.recorded)) return;
      await this.recordDelayed(list);
      await this.saveDelayed(list);
    });
  }

  /** Scan newly indexed heights. One call already spends the catch-up budget. */
  async followTip(_maxSteps = FOLLOW_TIP_STEPS): Promise<ScanProgress> {
    // Payjoin runs on its own timer (background.ts). Finding coins never waits on a mailbox.
    return this.enqueueScan(() => this.scanOnceUnlocked());
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

  /** Raw read from storage. Only CoinStore calls this; everything else uses loadScan. */
  private async readScanFromDisk(): Promise<ScanStore> {
    const session = await this.session();
    const grant = session ? null : await this.grant();
    const birthday = this.birthdayFor(session?.birthday ?? grant?.birthday);
    const got = await this.loadSealed<ScanStore>(SCAN_KEY, () => emptyScanStore(birthday));
    if (got.status === "missing") return emptyScanStore(birthday);
    if (got.status === "unreadable") {
      // Never let an empty list be written over a list we merely cannot read right now.
      throw new Error("locked");
    }
    return got.value;
  }

  private async scanMarker(): Promise<unknown> {
    const raw = (await this.kv.get([SCAN_KEY]))[SCAN_KEY];
    if (raw === undefined || raw === null) return null;
    return isSealed(raw) ? raw.nonce : JSON.stringify(raw);
  }

  /** One-time records decide which bip86 coins count as moved. Needs the data key. */
  private async syncOneTime(scan: ScanStore): Promise<ScanStore> {
    if (!(await this.dataKey())) return scan;
    const ot = await this.loadOneTime();
    const synced = syncOneTimeWithScan(scan, ot);
    if (synced.changedOt) await this.saveOneTime({ ...ot, records: synced.records });
    if (!synced.changedOt && !synced.utxosSpent.some((sp, i) => sp !== scan.utxos[i]?.spent)) return scan;
    return { ...scan, utxos: scan.utxos.map((u, i) => (synced.utxosSpent[i] === u.spent ? u : { ...u, spent: synced.utxosSpent[i]! })) };
  }

  /** History is rebuilt at most every HISTORY_EVERY_MS during a scan; at once after a user action. */
  private historyAt = 0;
  private historyStale = false;
  private async afterScanPersist(scan: ScanStore, urgent: boolean): Promise<void> {
    await this.noteChecked(scan.lastHeight);
    await this.notePayjoinPaid(scan);
    if (!(await this.dataKey())) {
      this.historyStale = true;
      return;
    }
    if (!urgent && Date.now() - this.historyAt < HISTORY_EVERY_MS) {
      this.historyStale = true;
      return;
    }
    await this.onScanSaved(scan);
  }

  private async notePayjoinPaid(scan: ScanStore): Promise<void> {
    // Locked: the coins are still found (their scripts are in the coin list); the link is
    // marked paid at the next unlock, which runs this again.
    if (!(await this.dataKey())) return;
    // Receiver Payjoin: done when the proposal's txid shows up (our reserved coin spent by it,
    // or one of its outputs found), or when the link's address is paid at all. A link that
    // ended without payment in the last week is still matched, for a payer who broadcast late.
    const sessions = await this.loadPayjoinSessions();
    const weekAgo = Date.now() - LATE_PAYMENT_MS;
    let dirty = false;
    for (const s of sessions) {
      const late = s.status === "failed" && (s.closedAt ?? 0) > weekAgo;
      if (!receiveOpen(s) && !late) continue;
      const byTxid = s.proposedTxid
        ? scan.utxos.find((u) => u.txid === s.proposedTxid) ??
          scan.utxos.find((u) => s.reserved && u.txid === s.reserved.txid && u.vout === s.reserved.vout && u.spentBy === s.proposedTxid)
        : undefined;
      const paid = scan.utxos.find((u) => u.scriptPubKey === s.scriptPubKey);
      const txid = byTxid ? (byTxid.txid === s.proposedTxid ? byTxid.txid : s.proposedTxid) : paid?.txid;
      if (txid) {
        s.status = "done";
        s.error = undefined;
        s.txid = txid;
        s.closedAt = Date.now();
        dirty = true;
      }
    }
    if (dirty) await this.savePayjoinSessions(sessions);
  }

  /** The single writer for this wallet's coin list. */
  readonly coins_ = new CoinStore({
    load: async () => {
      const marker = await this.scanMarker();
      return { store: await this.readScanFromDisk(), marker };
    },
    marker: () => this.scanMarker(),
    persist: async (store) => {
      const synced = await this.syncOneTime(store);
      await this.saveSealed(SCAN_KEY, synced);
      return { store: synced, marker: await this.scanMarker() };
    },
    afterPersist: (store, urgent) => this.afterScanPersist(store, urgent),
  });

  /** Write anything pending and bring history up to date. End of a scan run, Lock, switch. */
  async settle(): Promise<void> {
    await this.coins_.flush();
    if (this.historyStale && (await this.dataKey())) {
      await this.onScanSaved(await this.loadScan());
    }
  }

  /** The private wallet's coins. A website account's coins never show up here (see loadScanAll, sites.ts). */
  async loadScan(): Promise<ScanStore> {
    const all = await this.loadScanAll();
    return all.utxos.some((u) => u.kind === "site") ? { ...all, utxos: privateUtxos(all.utxos) } : all;
  }

  /** Every coin the scan found, website accounts included. */
  async loadScanAll(): Promise<ScanStore> {
    if (!(await this.scanKey())) {
      // No key at all (browser restarted while locked): nothing is readable, not even from memory.
      this.coins_.invalidate();
      const session = await this.session();
      return emptyScanStore(this.birthdayFor(session?.birthday));
    }
    try {
      return (await this.coins_.read()).store;
    } catch (e) {
      if (e instanceof Error && e.message === "locked") {
        const session = await this.session();
        const grant = session ? null : await this.grant();
        return emptyScanStore(this.birthdayFor(session?.birthday ?? grant?.birthday));
      }
      throw e;
    }
  }

  /**
   * Save a list read with loadScan. Refused with StaleWriteError if the list changed since
   * (its rev moved on). A list without a rev replaces whatever is stored.
   */
  async saveScan(scan: ScanStore, mark?: ScanMark): Promise<ScanStore | undefined> {
    if (mark && !(await this.scanStillHere(mark))) return undefined;
    if (!(await this.scanKey())) throw new Error("locked");
    if (scan.rev === undefined) return this.coins_.replace(scan);
    return this.coins_.commit(scan.rev, scan, { flush: true });
  }

  private async onScanSaved(scan: ScanStore): Promise<void> {
    this.historyAt = Date.now();
    this.historyStale = false;
    const hist = await this.loadHistory();
    const meta = await this.loadCoinMeta();
    const next = deriveHistory(scan, hist, { now: Date.now(), meta });
    await this.saveHistory(next);
    // Address status is decided in saveScan. A restored wallet watches further indexes
    // once a coin is actually sitting at one of the earlier ones.
    const ot = await this.loadOneTime();
    // Audit H2: a coin at a link output moves the watched gap of link outputs on at once.
    {
      const session = await this.session();
      if (session) {
        const account = this.accountOf(session);
        const have = new Set((scan.watch ?? []).map((w) => w.scriptPubKey.toLowerCase()));
        const missing = pjWatchesFor(account, 0, pjNextIndex(account, scan, ot) + PJ_GAP).filter((w) => !have.has(w.scriptPubKey));
        if (missing.length) void this.coins_.update((cur) => missing.reduce((acc, w) => addWatch(acc, w), cur)).catch(() => undefined);
      }
    }
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
          const watches: WatchedOutput[] = [];
          let o = ot;
          for (let i = have; i <= want; i++) {
            const k = account.oneTime(i);
            watches.push({ scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index: i });
            o = setOneTimeStatus(issueRecord(o, k.address, Date.now(), i), i, "swept");
          }
          await this.saveOneTime(o);
          // May run inside a CoinStore write; queue the change instead of waiting on it.
          void this.coins_
            .update((cur) => watches.reduce((acc, w) => addWatch(acc, w), cur))
            .catch(() => undefined);
        }
      }
    }
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

  /**
   * Ask the user's ord server about one coin (GET /output/<outpoint>, JSON). Only on request: the
   * server learns this outpoint. A clear answer from a full index is kept in the coin's notes.
   */
  async checkCoinAsset(outpoint: string): Promise<"none" | "held" | "unknown"> {
    const { scan } = await this.requireAccount();
    if (!scan.utxos.some((u) => outpointOf(u) === outpoint && !u.spent)) throw new Error("no such coin");
    const base = this.chainCfg.ordUrl;
    if (!base) throw new Error("set an ord server first");
    if (!/^[0-9a-f]{64}:\d{1,6}$/.test(outpoint)) throw new Error("bad outpoint");
    const res = await fetch(`${base}/output/${outpoint}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error(`the ord server answered ${res.status}`);
    const verdict = ordOutputVerdict(await res.json().catch(() => undefined));
    if (verdict) await this.saveCoinMeta(setCoinMeta(await this.loadCoinMeta(), outpoint, { asset: verdict }));
    return verdict ?? "unknown";
  }

  async coins(): Promise<CoinView[]> {
    const { scan } = await this.requireAccount();
    const meta = await this.loadCoinMeta();
    const { reserved } = await this.blockedOutpoints();
    const held = new Set<string>();
    for (const d of await this.loadDelayed()) if (d.status === "waiting") for (const inp of d.signableInputs) held.add(`${inp.txid}:${inp.vout}`);
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
          assetOk: m.assetOk,
          asset: m.asset,
          kind: u.kind === "bip86" ? "bip86" : "sp",
          pending: u.height === 0,
          held: held.has(op) || undefined,
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
    void scan;
    // Watched locally by the block scan. The address is never sent to a lookup service.
    await this.coins_.update((cur) => addWatch(cur, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index }));
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
    if (include.some((op) => frozen.has(op) || reserved.has(op))) throw new Error("this coin is frozen, reserved or protected (it may hold an inscription or rune; unlock it in Coins first)");
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
    void scan;
    await this.coins_.update((cur) => addWatch(cur, { scriptPubKey: k.scriptPubKey, tweak: "", label: null, k: 0, kind: "bip86", index }));
    return (await this.loadOneTime()).records.find((r) => r.index === index)!;
  }

  private async splitCoinOrThrow(outpoint: string): Promise<LabeledUtxo> {
    const { scan } = await this.requireAccount();
    const coin = scan.utxos.find((u) => outpointOf(u) === outpoint && !u.spent);
    if (!coin) throw new Error("this coin is not in this wallet or already spent");
    const { reserved, frozen } = await this.blockedOutpoints();
    if (frozen.has(outpoint) || reserved.has(outpoint)) throw new Error("this coin is frozen, reserved or protected (it may hold an inscription or rune; unlock it in Coins first)");
    return coin;
  }

  /** Preview a user-chosen split. Amounts are the user's; we only check and build. */
  // ---------- Connected websites (sites.ts) ----------

  async loadSites(): Promise<SiteStore> {
    const got = await this.loadSealed<SiteStore>(SITES_KEY, emptySites);
    return got.value?.v === 1 ? got.value : emptySites();
  }

  private async saveSites(s: SiteStore): Promise<void> {
    await this.saveSealed(SITES_KEY, s);
  }

  /** Record for an origin, connected or not. Needs the wallet unlocked. */
  async siteRecord(origin: string): Promise<SiteRecord | undefined> {
    if (!(await this.dataKey())) return undefined;
    const o = normalizeOrigin(origin);
    return (await this.loadSites()).sites.find((x) => x.origin === o);
  }

  private siteKeyOf(account: Account, index: number): SiteKey {
    const k = account.site!(index);
    return {
      index,
      path: k.path,
      scriptPubKey: k.scriptPubKey,
      address: k.address,
      publicKey: hex(k.internalPub!),
      output: hex(k.output),
      secret: k.secret,
      internalSecret: k.internalSecret!,
    };
  }

  /** Approve a website: its own account (same one again on reconnect), watched by the block scan. */
  async connectSite(origin: string): Promise<SiteRecord> {
    const { account } = await this.requireAccount();
    const { store, site } = upsertSite(await this.loadSites(), origin, Date.now());
    await this.saveSites(store);
    await this.coins_.update((cur) => this.withSiteWatches(account, cur, [site.index]), { flush: true });
    return site;
  }

  /**
   * Audit M3 (independent): bring back a website's account by its address (after a restore, or a
   * site you forgot). The account comes from the recovery words and the site's origin, so the same
   * origin gives the same account. Added disconnected and watched; the site gets no access.
   */
  async findSite(origin: string): Promise<SiteRecord> {
    const { account } = await this.requireAccount();
    const o = normalizeOrigin(origin);
    const store = await this.loadSites();
    let site = store.sites.find((x) => x.origin === o);
    if (!site) {
      const now = Date.now();
      site = { origin: o, index: pickSiteIndex(o, store.sites), connected: false, connectedAt: now, lastUsed: now };
      await this.saveSites({ v: 1, sites: [...store.sites, site] });
    }
    await this.coins_.update((cur) => this.withSiteWatches(account, cur, [site!.index]), { flush: true });
    return site;
  }

  /** The website loses access. Its account and coins stay, so they can still be moved back. */
  async disconnectSite(origin: string): Promise<void> {
    const o = normalizeOrigin(origin);
    const s = await this.loadSites();
    await this.saveSites({ v: 1, sites: s.sites.map((x) => (x.origin === o ? { ...x, connected: false } : x)) });
  }

  async forgetSite(origin: string): Promise<void> {
    const o = normalizeOrigin(origin);
    const site = await this.siteRecord(o);
    if (!site) return;
    if ((await this.siteCoins(site.index)).length) throw new Error("move the coins out of this site's account first");
    const s = await this.loadSites();
    await this.saveSites({ v: 1, sites: s.sites.filter((x) => x.origin !== o) });
  }

  /** The connected site's key on the open chain. Throws when not connected or locked. */
  async siteKey(origin: string): Promise<{ site: SiteRecord; key: SiteKey }> {
    const { account } = await this.requireAccount();
    const site = await this.siteRecord(origin);
    if (!site?.connected) throw new Error("not connected");
    return { site, key: this.siteKeyOf(account, site.index) };
  }

  async siteCoins(index: number): Promise<LabeledUtxo[]> {
    const all = await this.loadScanAll();
    return all.utxos.filter((u) => u.kind === "site" && u.index === index && !u.spent);
  }

  /** Site coins the wallet may spend by itself: not ones that may hold an inscription or rune. */
  private async siteSpendable(index: number): Promise<LabeledUtxo[]> {
    const meta = await this.loadCoinMeta();
    const coins = await this.siteCoins(index);
    const guarded = protectedOutpoints(coins, meta);
    return coins.filter((u) => !guarded.has(outpointOf(u)));
  }

  async siteBalance(index: number): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    const coins = await this.siteCoins(index);
    const sum = (l: LabeledUtxo[]) => Number(l.reduce((a, u) => a + BigInt(u.value), 0n));
    const confirmed = sum(coins.filter((u) => u.height > 0));
    const unconfirmed = sum(coins.filter((u) => u.height === 0));
    return { confirmed, unconfirmed, total: confirmed + unconfirmed };
  }

  async sitesView(): Promise<{ origin: string; connected: boolean; connectedAt: number; lastUsed?: number; address: string; path: string; balance: number; coins: number }[]> {
    const { account } = await this.requireAccount();
    const out = [];
    for (const s of (await this.loadSites()).sites) {
      const k = account.site!(s.index);
      const coins = await this.siteCoins(s.index);
      out.push({
        origin: s.origin,
        connected: s.connected,
        connectedAt: s.connectedAt,
        lastUsed: s.lastUsed,
        address: k.address,
        path: k.path,
        balance: Number(coins.reduce((a, u) => a + BigInt(u.value), 0n)),
        coins: coins.length,
      });
    }
    return out.sort((a, b) => Number(b.connected) - Number(a.connected) || (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  }

  /** Who owns a script or outpoint, for a site's PSBT review. Nothing leaves the extension. */
  private async ownerLookup(origin: string): Promise<OwnerOf> {
    const { account } = await this.requireAccount();
    const o = normalizeOrigin(origin);
    const all = await this.loadScanAll();
    const otherSite = new Set<string>();
    for (const s of (await this.loadSites()).sites) if (s.origin !== o) otherSite.add(account.site!(s.index).scriptPubKey);
    const privScripts = new Set<string>();
    const privOutpoints = new Set<string>();
    for (const u of all.utxos) {
      if (u.kind === "site") continue;
      privScripts.add(u.scriptPubKey);
      privOutpoints.add(`${u.txid}:${u.vout}`);
    }
    for (const w of all.watch ?? []) if (w.kind !== "site") privScripts.add(w.scriptPubKey);
    return (script, outpoint) => {
      if (otherSite.has(script)) return "other-site";
      if (privScripts.has(script) || (outpoint && privOutpoints.has(outpoint))) return "private";
      return "unknown";
    };
  }

  async siteReviewPsbt(origin: string, psbt: string, opts: SignPsbtOptions): Promise<PsbtReview> {
    const { key } = await this.siteKey(origin);
    return reviewPsbt(parsePsbt(psbt), key, await this.ownerLookup(origin), opts);
  }

  async siteSignPsbt(origin: string, psbt: string, opts: SignPsbtOptions & { autoFinalized: boolean }): Promise<string> {
    const { key } = await this.siteKey(origin);
    const tx = parsePsbt(psbt);
    const review = reviewPsbt(tx, key, await this.ownerLookup(origin), opts);
    await this.touchSite(origin);
    return signReviewedPsbt(tx, review, key, opts.autoFinalized);
  }

  async siteSignMessage(origin: string, text: string, type: "ecdsa" | "bip322-simple"): Promise<string> {
    const { key } = await this.siteKey(origin);
    await this.touchSite(origin);
    return type === "bip322-simple" ? signMessageBip322(text, key) : signMessageEcdsa(text, key.internalSecret);
  }

  async sitePlanSend(origin: string, to: string, sats: number, feeRate: number, memos: string[]): Promise<SiteSendPlan> {
    const { key } = await this.siteKey(origin);
    if (/^sp1/i.test(to.trim())) throw new Error("a website account cannot pay a private code; use Move back to private in Settings");
    return buildSiteSend({ coins: await this.siteSpendable(key.index), key, to: to.trim(), amount: BigInt(sats), feeRate, memos });
  }

  /** Broadcast a transaction a website account made, and note its own outputs and spends. */
  async siteBroadcast(origin: string, txHex: string): Promise<string> {
    const { key } = await this.siteKey(origin);
    const parsed = btc.Transaction.fromRaw(fromHex(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
    // Audit L1 (independent): a site can only relay transactions that spend its own account.
    // Anything else would make PrivateBit's server connection carry unrelated transactions.
    const mine = new Set((await this.siteCoins(key.index)).map((u) => `${u.txid}:${u.vout}`));
    let spendsSite = false;
    for (let i = 0; i < parsed.inputsLength; i++) {
      const inp = parsed.getInput(i);
      if (inp.txid && mine.has(`${hex(inp.txid)}:${inp.index}`)) spendsSite = true;
    }
    if (!spendsSite) throw new Error("This transaction does not spend this site's account, so PrivateBit does not send it.");
    const ours: OwnedOutput[] = [];
    for (let i = 0; i < parsed.outputsLength; i++) {
      const o = parsed.getOutput(i);
      if (o.script && hex(o.script) === key.scriptPubKey) ours.push({ vout: i, value: String(o.amount ?? 0n), scriptPubKey: key.scriptPubKey, tweak: "", label: null, k: 0, kind: "site", index: key.index });
    }
    const txid = await this.source().broadcast(txHex);
    await this.coins_.update((fresh) => applyBuiltSend(fresh, txHex, ours), { flush: true });
    await this.touchSite(origin);
    return txid;
  }

  private async touchSite(origin: string): Promise<void> {
    const o = normalizeOrigin(origin);
    const s = await this.loadSites();
    await this.saveSites({ v: 1, sites: s.sites.map((x) => (x.origin === o ? { ...x, lastUsed: Date.now() } : x)) });
  }

  /** Sweep a website account into this wallet's own receive code. Allowed while disconnected. */
  async planSiteMoveBack(origin: string, feeRate: number): Promise<ReturnType<typeof buildSend>> {
    const { account } = await this.requireAccount();
    const site = await this.siteRecord(origin);
    if (!site) throw new Error("unknown site");
    const coins = await this.siteSpendable(site.index);
    if (!coins.length) throw new Error((await this.siteCoins(site.index)).length ? "the coins in this site's account are small Taproot coins that may hold an inscription or rune; move them with the site" : "nothing in this site's account");
    return buildSend({
      account,
      utxos: coins,
      destination: account.receive,
      amount: 0n,
      feeRate,
      source: this.source(),
      include: coins.map((c) => outpointOf(c)),
      max: true,
    });
  }

  async siteMoveBack(origin: string, feeRate: number): Promise<BroadcastResult> {
    const built = await this.planSiteMoveBack(origin, feeRate);
    return this.broadcast(INTENT_SIMPLE_SEND, built, { kind: "self", feeRate, label: `Moved from site account ${siteHost(normalizeOrigin(origin))}` });
  }

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
    if (this.net !== "fractal") {
      const b = (await this.kv.get([BIRTHDAY_KEY]))[BIRTHDAY_KEY];
      this.startHeight = typeof b === "number" && b > 0 ? b : undefined;
    }
    const got = await this.kv.get([CHAIN_KEY]);
    const stored = got[CHAIN_KEY] as ChainConfig | undefined;
    const migrated = migrateChainConfig(stored ?? DEFAULT_CHAIN);
    const { plain } = splitChainSecrets(migrated);
    const secretsInPlain = !!(stored?.unisatToken || stored?.rpcPassword || stored?.sendNodePassword);
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
      sendNodePassword: secrets.sendNodePassword ?? migrated.sendNodePassword,
    });
    return this.chainCfg;
  }

  async saveChain(cfg: ChainConfig): Promise<void> {
    const prev = await this.loadChain();
    const next = migrateChainConfig({
      ...cfg,
      rpcPassword: isRedactedSecret(cfg.rpcPassword) ? prev.rpcPassword : cfg.rpcPassword,
      unisatToken: isRedactedSecret(cfg.unisatToken) ? prev.unisatToken : cfg.unisatToken,
      sendNodePassword: isRedactedSecret(cfg.sendNodePassword) ? prev.sendNodePassword : cfg.sendNodePassword,
    });
    const clearToken = cfg.unisatToken === "";
    const { plain, secrets } = splitChainSecrets(next);
    if (clearToken) delete secrets.unisatToken;
    if (secrets.unisatToken || secrets.rpcPassword || secrets.sendNodePassword || clearToken) {
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
      deadline: receiveOpen(s) ? receiveDeadline(s) : undefined,
      cancellable: receiveOpen(s),
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
      deadline: s.status === "waiting" ? s.expiresAt : undefined,
      cancellable: s.status === "waiting",
    }));
    return [...rec, ...snd].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Cancel a payment link in any open state. Its keys are deleted and its coin is free again.
   * After a proposal the payer could still broadcast it; that payment is then picked up as late.
   */
  async cancelLink(id: string): Promise<void> {
    const sessions = await this.loadPayjoinSessions();
    const s = sessions.find((x) => x.id === id);
    if (!s) throw new Error("no such payment link");
    if (!receiveOpen(s)) throw new Error("this payment link has already ended");
    this.endReceive(s, "cancelled");
    await this.savePayjoinSessions(sessions);
    await this.forgetPayjoinSecrets([id, ORIGINAL_PREFIX + id]);
  }

  /** Stop waiting on a Payjoin you started. Nothing is broadcast. */
  async cancelSend(id: string): Promise<void> {
    const sends = await this.loadPayjoinSends();
    const s = sends.find((x) => x.id === id);
    if (!s) throw new Error("no such payment");
    if (s.status !== "waiting") throw new Error("this payment has already ended");
    this.endSend(s, "cancelled");
    await this.savePayjoinSends(sends);
    await this.forgetPayjoinSecrets([SEND_HPKE_PREFIX + id]);
  }

  /** Every open link and payment of this wallet ends (used before a wallet switch or removal). */
  async cancelOpenPayjoins(reason: string): Promise<number> {
    let n = 0;
    const sessions = await this.loadPayjoinSessions();
    for (const s of sessions) if (receiveOpen(s)) (this.endReceive(s, reason), n++);
    if (n) await this.savePayjoinSessions(sessions);
    const sends = await this.loadPayjoinSends();
    let m = 0;
    for (const s of sends) if (s.status === "waiting") (this.endSend(s, reason), m++);
    if (m) await this.savePayjoinSends(sends);
    await this.clearHpkeSecrets();
    return n + m;
  }

  private endReceive(s: PayjoinReceiveSession, reason: string): void {
    s.status = "failed";
    s.error = reason;
    s.inputSecret = undefined;
    s.closedAt = Date.now();
  }

  private endSend(s: PayjoinSendSession, reason: string): void {
    s.status = "failed";
    s.error = reason;
    s.closedAt = Date.now();
  }

  private async forgetPayjoinSecrets(ids: string[]): Promise<void> {
    const all = await this.hpkeSecrets();
    let dirty = false;
    for (const id of ids) if (id in all) (delete all[id], (dirty = true));
    if (dirty) await this.writeHpke(all);
  }

  /** Delete every key of this wallet's namespace. PrivateBit updates the directory. */
  async deleteOwnKeys(): Promise<void> {
    this.close();
    await this.kv.remove([...V1_LIVE_KEYS, "privatebit.session", SCAN_GRANT_KEY, PJ_GRANT]);
  }

  /**
   * Payment link sessions, sealed with the data key (audit M7): they hold the link's tweaks,
   * scripts and the reserved coin. Null when they cannot be read (locked). A plaintext copy
   * from an older build is still read, and sealed as soon as the data key is there.
   */
  private async readPayjoinSessions(): Promise<PayjoinReceiveSession[] | null> {
    const got = await this.loadSealed<PayjoinReceiveSession[]>(PJ_SESSIONS, () => []);
    if (got.status === "ok" || got.status === "missing") return got.value;
    if (got.status === "plain") {
      if (await this.dataKey()) await this.sealPlainSessions();
      return got.value;
    }
    return null;
  }

  async loadPayjoinSessions(): Promise<PayjoinReceiveSession[]> {
    return (await this.readPayjoinSessions()) ?? [];
  }

  /** Needs the data key: while locked nothing about payment links is written. */
  async savePayjoinSessions(sessions: PayjoinReceiveSession[]): Promise<void> {
    await this.saveSealed(PJ_SESSIONS, sessions);
  }

  /** Seal a plaintext session list in place. The sealed copy is checked before it replaces the plain one. */
  private async sealPlainSessions(): Promise<boolean> {
    const key = await this.dataKey();
    const raw = (await this.kv.get([PJ_SESSIONS]))[PJ_SESSIONS];
    if (!key || raw === undefined || raw === null || isSealed(raw)) return false;
    const sealed = sealJson(key, PJ_SESSIONS, raw);
    if (JSON.stringify(openJson(key, PJ_SESSIONS, sealed)) !== JSON.stringify(raw)) throw new Error("session migration check failed");
    // Same key: the plaintext value is overwritten, not left next to the sealed one.
    await this.kv.set({ [PJ_SESSIONS]: sealed });
    return true;
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
        .filter((s) => receiveOpen(s) && s.reserved)
        .map((s) => `${s.reserved!.txid}:${s.reserved!.vout}`),
    );
    const metaNow = await this.loadCoinMeta();
    const frozenOut = frozenOutpoints(metaNow);
    for (const op of protectedOutpoints(scan.utxos, metaNow)) frozenOut.add(op);
    const spendable = scan.utxos
      .filter(
        (u) =>
          !u.spent &&
          u.kind !== "bip86" &&
          u.kind !== "site" &&
          !reservedOut.has(`${u.txid}:${u.vout}`) &&
          !frozenOut.has(`${u.txid}:${u.vout}`),
      )
      .slice()
      .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
    if (spendable.length === 0) {
      throw new PolicyError("Receive coins first, then you can create a payment link.");
    }
    // Audit M4: a random eligible coin, not always the largest one.
    const coin = spendable[Number(BigInt("0x" + hex(randomBytes(4))) % BigInt(spendable.length))]!;
    // Audit H2: the link's outputs come from the scan key and the next link index.
    const ot = await this.loadOneTime();
    const pjIndex = pjNextIndex(account, scan, ot);
    const sessionId = pjSessionId(account.scanSecret, pjIndex);
    const payTweak = sessionTweak(sessionId, 0);
    const extraTweak = sessionTweak(sessionId, 1);
    const pay = tweakSpend(account.spendSecret, payTweak);
    const extra = tweakSpend(account.spendSecret, extraTweak);
    const payScript = taprootScriptPubKey(pay.xonly);
    const extraScript = taprootScriptPubKey(extra.xonly);
    if (!this.ohttpConfig) this.ohttpConfig = await this.directoryKeys(directory);
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
    await this.coins_.update((cur) =>
      addWatch(addWatch(cur, { scriptPubKey: hex(payScript), tweak: hex(payTweak), label: null, k: 0 }), {
        scriptPubKey: hex(extraScript),
        tweak: hex(extraTweak),
        label: null,
        k: 0,
      }),
    );
    await this.saveHpkeSecret(session.id, hpke.sk);
    const sessions = await this.loadPayjoinSessions();
    sessions.push(session);
    await this.savePayjoinSessions(sessions);
    await this.saveOneTime({ ...(await this.loadOneTime()), pjNext: pjIndex + 1 });
    return session;
  }

  async loadPayjoinSends(): Promise<PayjoinSendSession[]> {
    const got = await this.kv.get([PJ_SEND]);
    return (got[PJ_SEND] as PayjoinSendSession[]) ?? [];
  }

  async savePayjoinSends(sessions: PayjoinSendSession[]): Promise<void> {
    await this.kv.set({ [PJ_SEND]: sessions });
  }

  /** True while a link or a Payjoin send is open. Every open state has a deadline, so this always ends. */
  async waitingPayjoin(): Promise<boolean> {
    if (!(await this.dataKey())) {
      const g = await this.loadPjGrant();
      if (g && g.recv.some((x) => receiveOpen(x.s))) return true;
      return (await this.loadPayjoinSends()).some((s) => s.status === "waiting");
    }
    await this.closeExpired();
    if ((await this.loadPayjoinSessions()).some(receiveOpen)) return true;
    return (await this.loadPayjoinSends()).some((s) => s.status === "waiting");
  }

  /** Open sessions past their deadline end: a link that was never paid, a proposal never broadcast. */
  private async closeExpired(): Promise<void> {
    // Locked: deadlines are applied at the next unlock (the link's keys are gone anyway).
    if (!(await this.dataKey())) return;
    const now = Date.now();
    const sessions = await this.loadPayjoinSessions();
    const gone: string[] = [];
    let receiveDirty = false;
    for (const s of sessions) {
      if (!receiveOpen(s) || now <= receiveDeadline(s)) continue;
      const proposed = s.status === "proposed";
      // Audit M4 (independent): a payer who never broadcasts the proposal still pays. The original
      // payment is broadcast instead (BIP78), so asking for a proposal to see our coin is not free.
      if (proposed) s.fallbackTxid = await this.broadcastOriginal(s.id);
      this.endReceive(s, proposed ? (s.fallbackTxid ? "not broadcast by the payer; their original payment was sent instead" : "not broadcast") : "expired");
      gone.push(s.id, ORIGINAL_PREFIX + s.id);
      receiveDirty = true;
    }
    if (receiveDirty) await this.savePayjoinSessions(sessions);
    const sends = await this.loadPayjoinSends();
    let sendDirty = false;
    for (const s of sends) {
      if (s.status === "waiting" && now > s.expiresAt) {
        this.endSend(s, "expired");
        gone.push(SEND_HPKE_PREFIX + s.id);
        sendDirty = true;
      }
    }
    if (sendDirty) await this.savePayjoinSends(sends);
    if (gone.length) await this.forgetPayjoinSecrets(gone);
  }

  /**
   * Audit M5 (independent) and security audit v1 item 5: the mailbox's public encryption keys,
   * kept a week, and never fetched straight from the mailbox unless the user allowed it (see
   * fetchDirectoryOhttpBytes for the order).
   */
  private async directoryKeys(directory: string): Promise<OhttpKeyConfig> {
    const cached = (await this.kv.get([OHTTP_KEYS_KEY]))[OHTTP_KEYS_KEY] as { directory: string; raw: string; at: number } | undefined;
    if (cached && cached.directory === directory && Date.now() - cached.at < OHTTP_KEYS_TTL_MS && Date.now() >= cached.at) {
      try {
        return parseOhttpKeys(fromHex(cached.raw));
      } catch {
        // Fetched again below.
      }
    }
    const raw = await fetchDirectoryOhttpBytes(directory, {
      relay: this.chainCfg.ohttpRelay || DEFAULT_OHTTP_RELAY,
      allowDirect: this.chainCfg.directMailboxKeys === true,
    });
    await this.kv.set({ [OHTTP_KEYS_KEY]: { directory, raw: hex(raw), at: Date.now() } });
    return parseOhttpKeys(raw);
  }

  /** The payer's signed original for a link, broadcast. Undefined when there is none or it was refused. */
  private async broadcastOriginal(id: string): Promise<string | undefined> {
    const original = await this.loadOriginal(id).catch(() => undefined);
    if (!original) return undefined;
    try {
      const raw = hex(parsePsbt(original).extract());
      return await this.source().broadcast(raw);
    } catch {
      // Already spent (the payer sent the proposal or another payment), or not final.
      return undefined;
    }
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
    let grant: PjGrant | null = null;
    let account: Account | undefined;
    let sessions: PayjoinReceiveSession[];
    if (vault) {
      account = this.accountOf(vault);
      vault.seed.fill(0);
      await this.absorbPjGrant(account);
      await this.closeExpired();
      sessions = await this.loadPayjoinSessions();
    } else {
      // Locked: only what the waiting payments need, sealed at Lock (security audit v1, M6/L13).
      grant = await this.loadPjGrant();
      if (!grant) return { processed: 0, errors: [] };
      await this.closeExpiredLocked(grant);
      sessions = grant.recv.map((g) => g.s);
    }
    const secretFor = (s: PayjoinReceiveSession): Uint8Array => {
      if (account) return evenPriv(inputSecret(account, s.reserved!));
      const g = grant!.recv.find((x) => x.s.id === s.id);
      if (!g) throw new Error("no key for this payment link");
      return fromHex(g.secret);
    };
    const saveSessions = async (): Promise<void> => {
      if (grant) await this.savePjGrant(grant);
      else await this.savePayjoinSessions(sessions);
    };
    const cfg = this.payjoinCfg();
    let processed = 0;
    const errors: string[] = [];
    for (const s of sessions) {
      if (s.inputSecret) s.inputSecret = undefined;
      if (s.status !== "waiting") continue;
      try {
        const sk = await this.loadHpkeSecret(s.id);
        if (!sk) {
          this.endReceive(s, "HPKE receiver key is gone (locked or session expired)");
          errors.push(s.error!);
          continue;
        }
        let original = await this.loadOriginal(s.id);
        let replyPk = s.replyPk ? fromHex(s.replyPk) : undefined;
        if (!original || !replyPk) {
          const got = await receiverTakeOriginal(s, cfg, sk);
          s.checkedAt = Date.now();
          if ("expired" in got) {
            this.endReceive(s, "expired");
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
          await saveSessions();
        }
        if (!s.reserved) {
          throw new Error("payment link is missing its reserved coin; create a new one");
        }
        // BIP78 receiver checks on the original, and the reserved coin re-checked, before we sign.
        const scan = await this.loadScan();
        // Frozen marks are sealed with the data key; while locked they cannot change, and the
        // reserved coin was checked against them when the link was made and at Lock.
        const meta = account ? await this.loadCoinMeta() : null;
        const reservedKey = `${s.reserved.txid}:${s.reserved.vout}`;
        const stillOurs = scan.utxos.find((u) => `${u.txid}:${u.vout}` === reservedKey && !u.spent);
        const problems = checkOriginal({
          originalB64: original,
          payScript: s.scriptPubKey,
          amount: s.amount ? BigInt(s.amount) : undefined,
          ourOutpoints: new Set(scan.utxos.map((u) => `${u.txid}:${u.vout}`)),
          ourScripts: new Set([...scan.utxos.map((u) => u.scriptPubKey.toLowerCase()), s.extraScriptPubKey.toLowerCase()]),
        });
        if (!stillOurs) problems.push("the reserved coin is no longer available");
        else if (meta && frozenOutpoints(meta).has(reservedKey)) problems.push("the reserved coin is frozen");
        if (problems.length) {
          this.endReceive(s, `refused: ${problems.join("; ")}`);
          errors.push(s.error!);
          await this.forgetPayjoinSecrets([s.id, ORIGINAL_PREFIX + s.id]);
          continue;
        }
        const built = buildPayjoinProposal({
          originalB64: original,
          receiverInput: { ...s.reserved, spent: false },
          // Audit H1: same key choice as every other spend (a coin from an earlier link included).
          receiverSecret: secretFor(s),
          extraScript: fromHex(s.extraScriptPubKey),
          extraTweak: s.extraTweak,
        });
        await receiverPostProposal(s, built.proposalB64, cfg, hpkeKeyPairFromSecret(sk), replyPk);
        s.replyPk = hex(replyPk);
        s.status = "proposed";
        s.error = undefined;
        s.checkedAt = Date.now();
        s.proposedAt = Date.now();
        s.proposalDeadline = s.proposedAt + PROPOSAL_DEADLINE_MS;
        s.proposedTxid = proposalTxid(built.proposalB64);
        processed += 1;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push(message);
        s.checkedAt = Date.now();
        s.error = message;
        if (!payjoinRetryable(message)) this.endReceive(s, message);
      }
    }
    await saveSessions();
    const sent = await this.servicePayjoinSends(account ?? null, grant, errors);
    if (grant) await this.savePjGrant(grant);
    return { processed: processed + sent, errors };
  }

  private async servicePayjoinSends(
    account: Account | null,
    grant: PjGrant | null,
    errors: string[],
  ): Promise<number> {
    const sends = await this.loadPayjoinSends();
    let processed = 0;
    const cfg = this.payjoinCfg();
    for (const s of sends) {
      if (s.status !== "waiting") continue;
      if (Date.now() > s.expiresAt) {
        this.endSend(s, "expired");
        continue;
      }
      const sk = await this.loadHpkeSecret(SEND_HPKE_PREFIX + s.id);
      if (!sk) {
        this.endSend(s, "HPKE sender reply key is gone (locked or session expired)");
        errors.push(s.error!);
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
        const scoped = grant?.sends.find((x) => x.id === s.id)?.secrets;
        if (!account && !scoped) throw new Error("no keys for this Payjoin; unlock to finish it");
        const signed = signPayjoinProposal({
          proposalB64: proposal,
          account: account ?? { scoped: scoped! },
          inputs: s.signableInputs,
        });
        const txid = await this.source().broadcast(signed.txHex);
        s.status = "done";
        s.txid = txid;
        s.closedAt = Date.now();
        await this.forgetPayjoinSecrets([SEND_HPKE_PREFIX + s.id]);
        if (!account) {
          // History and change need the data key: recorded at the next unlock (absorbPjGrant).
          grant!.sends = grant!.sends.filter((x) => x.id !== s.id);
          grant!.done.push({ id: s.id, proposal, txHex: signed.txHex, txid });
          processed += 1;
          continue;
        }
        await this.recordPayjoinSend(account, s, proposal, signed.txHex, txid);
        processed += 1;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push(message);
        s.checkedAt = Date.now();
        s.error = message;
        if (!payjoinRetryable(message)) this.endSend(s, message);
      }
    }
    await this.savePayjoinSends(sends);
    return processed;
  }

  /** History, labels and our change for a Payjoin we sent. Needs the account (unlocked). */
  private async recordPayjoinSend(account: Account, s: PayjoinSendSession, proposal: string, txHex: string, txid: string): Promise<void> {
    const signed = { txHex };
    {
      {
        // Our change first: the receiver's input means only our own inputs find it (see scan.ts).
        const change = await this.applyOwnTxChange(account, signed.txHex, txid);
        try {
          const ours = [...s.signableInputs.map((u) => `${u.txid}:${u.vout}`), ...change.outpoints];
          // Audit L6: the real fee, from the proposal's own input values.
          let fee = 0n;
          let vsize = 0;
          try {
            const t = btc.Transaction.fromPSBT(Uint8Array.from(atob(proposal), (c) => c.charCodeAt(0)));
            fee = t.fee;
            vsize = btc.Transaction.fromRaw(fromHex(signed.txHex), { allowUnknownOutputs: true }).vsize;
          } catch {
            /* unknown fee stays unrecorded */
          }
          const hist = recordBroadcast(await this.loadHistory(), {
            txid,
            kind: "payjoin-sent",
            net: this.net,
            amount: BigInt(s.amount || "0"),
            fee,
            feeRate: fee > 0n && vsize > 0 ? Math.round((Number(fee) / vsize) * 10) / 10 : 0,
            to: s.destination,
            label: s.label ?? this.pendingSendLabels.get(s.id),
            outpoints: ours,
            change: change.value,
            now: Date.now(),
          });
          const e = hist.entries[txid];
          if (e && fee === 0n) delete e.fee;
          await this.saveHistory(hist);
          const label = s.label ?? this.pendingSendLabels.get(s.id);
          if (label && change.outpoints.length > 0) {
            let meta = await this.loadCoinMeta();
            for (const op of change.outpoints) meta = setCoinMeta(meta, op, { label });
            await this.saveCoinMeta(meta);
          }
        } catch {
          /* history is best effort; the payment is already broadcast */
        }
      }
    }
  }
}


/** Every storage key PrivateBit may write: per-wallet names (before scoping) and shared ones. */
/** Payjoin link indexes watched past the last one used (audit H2). */
export const PJ_GAP = 10;
const pjCache = new Map<string, WatchedOutput[]>();

/** The payment and extra outputs of link `index`, as watch entries. */
export function pjOutputs(account: Account, index: number): WatchedOutput[] {
  const key = `${hex(account.spendPub)}:${hex(account.scanPub)}:${index}`;
  let got = pjCache.get(key);
  if (!got) {
    const id = pjSessionId(account.scanSecret, index);
    got = [0, 1].map((i) => {
      const t = sessionTweak(id, i);
      return { scriptPubKey: hex(taprootScriptPubKey(tweakSpend(account.spendSecret, t).xonly)), tweak: hex(t), label: null, k: 0 };
    });
    if (pjCache.size > 5000) pjCache.clear();
    pjCache.set(key, got);
  }
  return got.map((w) => ({ ...w }));
}

export function pjWatchesFor(account: Account, from: number, to: number): WatchedOutput[] {
  const out: WatchedOutput[] = [];
  for (let i = from; i < to; i++) out.push(...pjOutputs(account, i));
  return out;
}

/** First link index not used yet: after the stored counter and after any coin found at a link output. */
export function pjNextIndex(account: Account, store: ScanStore, ot: { pjNext?: number }): number {
  const seen = new Set(store.utxos.map((u) => u.scriptPubKey.toLowerCase()));
  let next = ot.pjNext ?? 0;
  for (let i = 0; i < next + PJ_GAP; i++) if (pjOutputs(account, i).some((w) => seen.has(w.scriptPubKey))) next = Math.max(next, i + 1);
  return next;
}

export const ALL_KEYS: string[] = [...WALLET_SCOPED, ...GLOBAL_KEYS];

/**
 * Short one-way id of a wallet's keys (hash of its spend public key). Kept in the directory to
 * spot the same words imported twice. It cannot be turned back into a key or an address.
 */
export function walletFingerprint(spendPubHex: string): string {
  const tag = new TextEncoder().encode("PrivateBit wallet fingerprint v1:");
  const pub = fromHex(spendPubHex);
  const msg = new Uint8Array(tag.length + pub.length);
  msg.set(tag);
  msg.set(pub, tag.length);
  return hex(sha256(msg)).slice(0, 16);
}

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

  /** The chain every wallet is shown on. One at a time; switching keeps the wallet unlocked. */
  net: NetworkId = "fractal";

  private coreFor(id: string): WalletCore {
    return new WalletCore(netKv(scopedKv(this.root, id), this.net), this.current?.chainCfg ?? this.defaultChain, this.hooks, id, this.net);
  }

  /**
   * Show the open wallet on another chain. Nothing is locked or moved: each chain has its own
   * coins, history and settings. Scanning for the old chain stops; the new one starts after Lock too.
   */
  async setNetwork(net: NetworkId): Promise<void> {
    if (!isNetworkId(net)) throw new Error("unknown network");
    if (net === this.net && this.current?.net === net) return;
    this.net = net;
    setSharedChainNetwork(net);
    const old = this.current;
    if (old) {
      // A held payment keeps its own time on its chain (runDelayed services every chain).
      await old.settle().catch(() => undefined);
      old.close();
      this.current = undefined;
    }
    const core = await this.core();
    await core.ensureGrant().catch(() => undefined);
  }

  /** The open wallet. With no wallet yet, an empty namespace for the first one. */
  async core(): Promise<WalletCore> {
    await this.ready();
    const index = await loadIndex(this.root);
    const id = index?.active ?? (this.firstId ??= newWalletId());
    if (!this.current || this.current.walletId !== id) {
      this.current?.close();
      this.current = new WalletCore(netKv(scopedKv(this.root, id), this.net), this.defaultChain, this.hooks, id, this.net);
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
    const fp = (await core.fingerprint()) ?? prev?.fp;
    if (fp) entry.fp = fp;
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
    return { ...st, net: this.net, wallets: await this.summaries() };
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
   * Import recovery words. Never replaces a wallet: with no wallet it creates the first one,
   * otherwise it adds one. Words already on this computer open that wallet instead (nothing is
   * deleted or rescanned); with resetPassword its password becomes the one just typed.
   */
  async importWallet(args: {
    mnemonic: string;
    password: string;
    passphrase?: string;
    birthday: number;
    name?: string;
    resetPassword?: boolean;
  }): Promise<{ result: "created" | "added" | "existing"; id: string; name: string; passwordChanged: boolean }> {
    if (args.birthday <= 0) throw new Error("birthday height required (Fractal tip is past 2M; 0 is genesis)");
    const probe = vaultFromMnemonic({ mnemonic: args.mnemonic, passphrase: args.passphrase, birthday: args.birthday });
    const fp = walletFingerprint(hex(accountFromVault(probe).spendPub));
    const index = await this.index();
    if (!index) {
      await this.restore(args);
      const core = await this.core();
      const entry = (await this.index())?.wallets.find((w) => w.id === core.walletId);
      return { result: "created", id: core.walletId, name: entry?.name ?? "Wallet", passwordChanged: false };
    }
    const match = await this.findWallet(index, fp, probe.seed);
    if (match) {
      if (match.id !== (await this.core()).walletId) await this.openWallet(match.id);
      const core = await this.core();
      await core.openWithWords({ mnemonic: args.mnemonic, passphrase: args.passphrase, newPassword: args.resetPassword ? args.password : undefined });
      await this.remember(core);
      return { result: "existing", id: match.id, name: match.name, passwordChanged: args.resetPassword === true };
    }
    await this.addWallet({ ...args, kind: "import" });
    const core = await this.core();
    const entry = (await this.index())?.wallets.find((w) => w.id === core.walletId);
    return { result: "added", id: core.walletId, name: entry?.name ?? "Wallet", passwordChanged: false };
  }

  /** The wallet these keys belong to, by fingerprint, or by opening its coin list (older entries). */
  private async findWallet(index: WalletIndex, fp: string, seed: Uint8Array): Promise<WalletEntry | undefined> {
    for (const w of index.wallets) {
      if (w.fp) {
        if (w.fp === fp) return w;
        continue;
      }
      const core = w.id === this.current?.walletId ? this.current : this.coreFor(w.id);
      try {
        const known = await core.fingerprint();
        if (known ? known === fp : await core.ownsSeed(seed)) return w;
      } finally {
        if (core !== this.current) core.close();
      }
    }
    return undefined;
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
    await this.closeOtherChainsForSwitch(prev);
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
    await this.closeOtherChainsForSwitch(prev);
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
    await this.prepareOtherChains(core).catch(() => undefined);
  }

  /** Wallet switch: the other chains' held payments go out now too and their scan grants go (the UI says so first). */
  private async closeOtherChainsForSwitch(prev: WalletCore): Promise<void> {
    for (const other of await this.otherChainCores(prev).catch(() => [] as WalletCore[])) {
      try {
        await other.sendAllDelayedNow().catch(() => undefined);
        await other.kv.remove([SCAN_GRANT_KEY]);
      } finally {
        other.close();
      }
    }
  }

  /** The open wallet on a chain that is not on screen (closed by the caller). */
  private async otherChainCores(core: WalletCore): Promise<WalletCore[]> {
    const out: WalletCore[] = [];
    for (const net of NETWORK_IDS) {
      if (net === core.net) continue;
      const other = new WalletCore(netKv(scopedKv(this.root, core.walletId), net), this.defaultChain, this.hooks, core.walletId, net);
      await other.loadChain();
      out.push(other);
    }
    return out;
  }

  /**
   * A chain with held payments gets its own scan grant at unlock, so they go out on time even
   * while another chain is on screen. Chains without held payments get nothing.
   */
  private async prepareOtherChains(core: WalletCore): Promise<void> {
    for (const other of await this.otherChainCores(core)) {
      try {
        const raw = (await other.kv.get([DELAYED_KEY]))[DELAYED_KEY];
        if (raw !== undefined) await other.ensureGrant();
      } finally {
        other.close();
      }
    }
  }

  /**
   * Broadcast held payments that are due on every chain of the open wallet, not only the one on
   * screen. Send now (only) acts on the chain on screen. Returns when the next one is due.
   */
  async runDelayed(opts: { now?: number; only?: string } = {}): Promise<{ sent: string[]; failed: string[]; next?: number }> {
    const core = await this.core();
    const r = await core.runDelayed(opts);
    if (opts.only) return r;
    const sent = [...r.sent];
    const failed = [...r.failed];
    let next = r.next;
    for (const other of await this.otherChainCores(core)) {
      try {
        const o = await other.runDelayed(opts);
        sent.push(...o.sent);
        failed.push(...o.failed);
        if (o.next !== undefined && (next === undefined || o.next < next)) next = o.next;
      } catch {
        // That chain's list cannot be opened now (no grant yet): it is tried again after unlock.
      } finally {
        other.close();
      }
    }
    return { sent, failed, ...(next !== undefined ? { next } : {}) };
  }

  /** Held payments waiting on chains that are not on screen, for the overview. */
  async delayedElsewhere(): Promise<{ net: NetworkId; count: number; next: number }[]> {
    const core = await this.core();
    const out: { net: NetworkId; count: number; next: number }[] = [];
    for (const other of await this.otherChainCores(core)) {
      try {
        const waiting = (await other.delayedView()).filter((d) => d.status === "waiting");
        if (waiting.length) out.push({ net: other.net, count: waiting.length, next: Math.min(...waiting.map((d) => d.sendAt)) });
      } catch {
        /* not readable now */
      } finally {
        other.close();
      }
    }
    return out;
  }

  async setBirthday(birthday: number): Promise<void> {
    const core = await this.core();
    await core.setBirthday(birthday);
    await this.remember(core);
  }

  /** Check one wallet's password without opening it. */
  async checkWalletPassword(id: string, password: string): Promise<void> {
    const open = await this.core();
    const core = id === open.walletId ? open : this.coreFor(id);
    try {
      await core.checkPassword(password);
    } finally {
      if (core !== open) core.close();
    }
  }

  /**
   * Remove one wallet: the open one by default, or another by id (its own password).
   * The others stay. Removing the open wallet opens another one, locked. Removing the last
   * wallet wipes every PrivateBit key; wiped tells the caller.
   */
  async removeWallet(password: string, id?: string): Promise<{ wiped: boolean; removedOpen: boolean }> {
    const open = await this.core();
    if (id && id !== open.walletId) {
      const index = await this.index();
      if (!index || !index.wallets.some((w) => w.id === id)) throw new Error("no such wallet");
      await this.checkWalletPassword(id, password);
      const other = this.coreFor(id);
      await other.cancelOpenPayjoins("wallet removed").catch(() => undefined);
      await other.deleteOwnKeys();
      await this.root.remove(walletKeys(id));
      await saveIndex(this.root, { ...index, wallets: index.wallets.filter((w) => w.id !== id) });
      return { wiped: false, removedOpen: false };
    }
    return { ...(await this.removeOpenWallet(password)), removedOpen: true };
  }

  private async removeOpenWallet(password: string): Promise<{ wiped: boolean }> {
    const core = await this.core();
    await core.checkPassword(password);
    await core.cancelOpenPayjoins("wallet removed").catch(() => undefined);
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
  checkCoinAsset = this.d("checkCoinAsset");
  coins = this.d("coins");
  loadOneTime = this.d("loadOneTime");
  saveOneTime = this.d("saveOneTime");
  issueOneTime = this.d("issueOneTime");
  oneTimeView = this.d("oneTimeView");
  planSweep = this.d("planSweep");
  loadSites = this.d("loadSites");
  siteRecord = this.d("siteRecord");
  connectSite = this.d("connectSite");
  disconnectSite = this.d("disconnectSite");
  forgetSite = this.d("forgetSite");
  findSite = this.d("findSite");
  siteKey = this.d("siteKey");
  siteBalance = this.d("siteBalance");
  sitesView = this.d("sitesView");
  siteReviewPsbt = this.d("siteReviewPsbt");
  siteSignPsbt = this.d("siteSignPsbt");
  siteSignMessage = this.d("siteSignMessage");
  sitePlanSend = this.d("sitePlanSend");
  siteBroadcast = this.d("siteBroadcast");
  planSiteMoveBack = this.d("planSiteMoveBack");
  siteMoveBack = this.d("siteMoveBack");
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
  confirmPlan = this.d("confirmPlan");
  assertNotOwnLink = this.d("assertNotOwnLink");
  maxAmount = this.d("maxAmount");
  feeRates = this.d("feeRates");
  broadcast = this.d("broadcast");
  delayedView = this.d("delayedView");
  cancelDelayed = this.d("cancelDelayed");
  dismissDelayed = this.d("dismissDelayed");
  finishDelayedRecords = this.d("finishDelayedRecords");
  loadDelayed = this.d("loadDelayed");

  /** Chain source for the open wallet's settings. */
  source(): ChainSource {
    return this.hooks.sourceOverride ?? openChain(this.chainCfg, this.net);
  }
  payjoinCfg(): PayjoinConfig {
    return (this.current ?? this.coreFor(this.firstId ??= newWalletId())).payjoinCfg();
  }
}

export type { VaultBlob };
export { INTENT_PAYJOIN, INTENT_SIMPLE_SEND };
