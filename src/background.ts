import { chromeKv } from "./chrome-kv.ts";
import { installE2E } from "./e2e-hook.ts";
import { jsonSafe } from "./lib/json.ts";
import { DEFAULT_BIRTHDAY, DEFAULT_CHAIN, LEGACY_DEFAULT_BIRTHDAY, isNetworkId, netInfo, redactChain, type ChainConfig, type NetworkId } from "./lib/network.ts";
import { INTENT_PAYJOIN, INTENT_SIMPLE_SEND, PrivateBit } from "./lib/wallet.ts";
import { dropAllKeys } from "./lib/sessionkeys.ts";
import { autoLockDecision, touch, type ActivityState } from "./lib/autolock.ts";
import { DEFAULT_PREFS, normalizePrefs, PREFS_KEY, type Prefs } from "./lib/prefs.ts";
import { testPayjoinRoute } from "./lib/payjoin.ts";
import { randomDelayMs } from "./lib/plan-random.ts";
import { getPriceWithFallback, PRICE_PERIOD_MIN, RateLimitedError, type FeeRates, type PriceSource } from "./lib/requests.ts";
import { createMnemonic, loadVaultBlob } from "./lib/vault.ts";
import { checkNode, nodeFollows, openChain, watchEndpoint } from "./lib/chain.ts";
import { clearSharedChain, formatBlockStats, onBlockStats } from "./lib/blockshare.ts";
import { backoffMs } from "./lib/net.ts";
import type { CoinMeta } from "./lib/coinmeta.ts";
import { hideFromOrigin, injectProvider, installDapp, loadVisibility, saveVisibility, showToOrigins } from "./dapp/background-dapp.ts";
import { normalizeOrigin } from "./lib/sites.ts";

const kv = chromeKv();
const wallet = new PrivateBit(kv, DEFAULT_CHAIN);

/** The chain from the last session, set before anything reads a wallet. */
const networkReady: Promise<void> = (async () => {
  try {
    const prefs = normalizePrefs((await kv.get([PREFS_KEY]))[PREFS_KEY]);
    await wallet.setNetwork(prefs.network);
  } catch {
    /* Fractal stays */
  }
})();
// Browser end-to-end build only (vite build --mode e2e). Removed from the production bundle.
if (import.meta.env.MODE === "e2e") installE2E(wallet);
const FOLLOW_ALARM = "privatebit.follow-tip";
const CATCHUP_ALARM = "privatebit.catchup";
const PJ_ALARM = "privatebit.payjoin";
const PJ_SOON = "privatebit.payjoin.soon";
const LOCK_ALARM = "privatebit.autolock";
const PRICE_ALARM = "privatebit.price";

const ACTIVITY_KEY = "privatebit.activity";
const LOCKINFO_KEY = "privatebit.lockinfo";
const HEALTH_KEY = "privatebit.health";
const PRICE_KEY = "privatebit.price";
const ONBOARD_KEY = "privatebit.onboard";
const FEES_KEY = "privatebit.fees";

export type Health = {
  state: "ok" | "rate-limited" | "offline" | "error";
  since?: number;
  at: number;
  detail?: string;
  /** When the block download tries again after a failure or a run with no progress. */
  retryAt?: number;
};
export type PriceCache = { usd?: number; at?: number; fetchedAt?: number; failedAt?: number; source?: PriceSource; asset?: string; error?: string };
export type LockInfo = { by: "auto" | "user"; minutes?: number; at: number };

async function getPrefs(): Promise<Prefs> {
  return normalizePrefs((await kv.get([PREFS_KEY]))[PREFS_KEY]);
}

function errorCode(e: unknown): "rate-limited" | "offline" | undefined {
  if (e instanceof RateLimitedError) return "rate-limited";
  const m = e instanceof Error ? e.message : String(e);
  if (/rate limit|request limit|429/i.test(m)) return "rate-limited";
  if (e instanceof TypeError || /failed to fetch|fetch failed|network|ECONN|ENOTFOUND/i.test(m)) return "offline";
  return undefined;
}

async function noteHealth(e?: unknown, retryInMs?: number): Promise<void> {
  const prev = (await kv.get([HEALTH_KEY]))[HEALTH_KEY] as Health | undefined;
  const now = Date.now();
  const retryAt = retryInMs !== undefined ? now + retryInMs : undefined;
  if (!e) {
    await kv.set({ [HEALTH_KEY]: { state: "ok", at: now, ...(retryAt ? { retryAt } : {}) } satisfies Health });
    return;
  }
  const code = errorCode(e) ?? (retryAt ? "error" : undefined);
  if (!code) return; // locked, no vault, or a logic error: not a reachability problem
  const since = prev && prev.state === code ? (prev.since ?? prev.at) : now;
  await kv.set({ [HEALTH_KEY]: { state: code, since, at: now, ...(retryAt ? { retryAt } : {}) } satisfies Health });
}

/** Uniform random wait in [lo, hi) ms, from the system CSPRNG. */
function jitterMs(lo: number, hi: number): number {
  return lo + (crypto.getRandomValues(new Uint32Array(1))[0]! % Math.max(1, hi - lo));
}

/**
 * Security audit v1 (I8): price and fee requests run on their own random schedule, whether the
 * wallet is locked or not, so the price and fee services cannot tell when someone unlocks,
 * opens Send or is using the wallet. Each run picks the next one 0.7x to 1.3x the period away.
 */
function schedulePrice(): void {
  const base = PRICE_PERIOD_MIN * 60_000 * 2;
  chrome.alarms.create(PRICE_ALARM, { when: Date.now() + jitterMs(base * 0.7, base * 1.3) });
}
const FEE_ALARM = "privatebit.fees.poll";
const FEE_PERIOD_MS = 8 * 60_000;
function scheduleFees(): void {
  chrome.alarms.create(FEE_ALARM, { when: Date.now() + jitterMs(FEE_PERIOD_MS * 0.7, FEE_PERIOD_MS * 1.3) });
}
async function refreshFees(): Promise<(FeeRates & { fetchedAt: number }) | undefined> {
  try {
    await wallet.loadChain();
    const r = await wallet.feeRates();
    const next = { ...r, fetchedAt: Date.now() };
    await kv.set({ [FEES_KEY]: next });
    await noteHealth();
    return next;
  } catch (e) {
    await noteHealth(e);
    return undefined;
  }
}

function ensureAlarms(): void {
  chrome.alarms.create(FOLLOW_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  chrome.alarms.create(LOCK_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  void chrome.alarms.get(PRICE_ALARM).then((a) => (a ? undefined : schedulePrice()));
  void chrome.alarms.get(FEE_ALARM).then((a) => (a ? undefined : scheduleFees()));
}

function schedulePayjoinWake(): void {
  chrome.alarms.create(PJ_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  chrome.alarms.create(PJ_SOON, { when: Date.now() + 15_000 });
}

/** Payjoin polls on its own timer, separate from block scanning. Alarms wake a sleeping worker. */
const PJ_POLL_MS = 10_000;
let pjTimer: ReturnType<typeof setTimeout> | undefined;
let pjRunning = false;

function stopPayjoinTimer(): void {
  if (pjTimer !== undefined) clearTimeout(pjTimer);
  pjTimer = undefined;
}

async function pumpPayjoin(): Promise<void> {
  await networkReady;
  if (pjRunning) return;
  pjRunning = true;
  stopPayjoinTimer();
  let again = false;
  try {
    await wallet.loadChain();
    await wallet.servicePayjoin();
    again = await wallet.waitingPayjoin();
  } catch {
    /* no vault yet, or locked: the next alarm tries again */
    again = await wallet.waitingPayjoin().catch(() => false);
  } finally {
    pjRunning = false;
  }
  if (again) {
    schedulePayjoinWake();
    pjTimer = setTimeout(() => void pumpPayjoin(), jitterMs(PJ_POLL_MS * 0.6, PJ_POLL_MS * 1.4));
  } else {
    await chrome.alarms.clear(PJ_ALARM);
    await chrome.alarms.clear(PJ_SOON);
  }
}

async function isUnlocked(): Promise<boolean> {
  return !!(await wallet.dataKey());
}

async function checkAutoLock(): Promise<void> {
  if (!(await isUnlocked())) return;
  const prefs = await getPrefs();
  const now = Date.now();
  const got = (await kv.get([ACTIVITY_KEY]))[ACTIVITY_KEY] as ActivityState | undefined;
  const state = got ?? touch(undefined, now);
  // Security audit v1: a waiting Payjoin no longer holds the lock. It finishes with its scoped keys.
  const d = autoLockDecision(state, now, prefs.lockMinutes);
  if (d.lock) {
    await wallet.lock();
    await kv.remove([ACTIVITY_KEY]);
    await kv.set({ [LOCKINFO_KEY]: { by: "auto", minutes: prefs.lockMinutes, at: now } satisfies LockInfo });
    kickCatchup(0);
    return;
  }
  await kv.set({ [ACTIVITY_KEY]: d.next });
}

/** First run only: no price yet. Fetched after a random wait, not at the moment of the click. */
async function priceIfMissing(): Promise<void> {
  const prev = (await kv.get([PRICE_KEY]))[PRICE_KEY] as PriceCache | undefined;
  if (prev?.usd) return;
  setTimeout(() => void refreshPrice(true), jitterMs(5_000, 60_000));
}

async function refreshPrice(force = false): Promise<PriceCache> {
  const prev = ((await kv.get([PRICE_KEY]))[PRICE_KEY] as PriceCache | undefined) ?? {};
  const prefs = await getPrefs();
  if (prefs.priceSource === "off") return prev;
  const asset = netInfo(prefs.network).price;
  // A cached price for the other coin is not shown, and not reused.
  const sameAsset = prev.asset === asset.coingecko || prev.asset === asset.mexc;
  const fresh = sameAsset && prev.fetchedAt && Date.now() - prev.fetchedAt < PRICE_PERIOD_MIN * 60_000;
  if (fresh && !force) return prev;
  try {
    const p = await getPriceWithFallback(prefs.priceSource, asset);
    const next: PriceCache = { usd: p.usd, at: p.at, fetchedAt: p.fetchedAt, source: p.source, asset: p.asset };
    await kv.set({ [PRICE_KEY]: next });
    return next;
  } catch (e) {
    const base = sameAsset ? prev : {};
    const next: PriceCache = { ...base, failedAt: Date.now(), error: e instanceof Error ? e.message : String(e) };
    await kv.set({ [PRICE_KEY]: next });
    return next;
  }
}

// Audit I6 (independent): keep wallet storage away from content scripts. Session storage is
// already limited by default; this states it, and covers local storage where the browser allows it.
for (const area of [chrome.storage.session, chrome.storage.local] as Array<{ setAccessLevel?: (o: { accessLevel: string }) => Promise<void> } | undefined>) {
  void area?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  void pumpPayjoin();
});
chrome.runtime.onStartup.addListener(() => {
  // A new browser session: session storage is empty, so the session keys left in IndexedDB open nothing. Delete them.
  void dropAllKeys();
  ensureAlarms();
  void pumpPayjoin();
});
ensureAlarms();
void pumpPayjoin();

// One line per downloaded block in the service worker console: counts only, never keys or coins.
onBlockStats((s) => console.info(`[PrivateBit] ${formatBlockStats(s)}`));

let catchupTimer: ReturnType<typeof setTimeout> | undefined;
let catchupRunning = false;
/** Failed or stuck runs in a row. Drives exponential backoff with jitter; reset on progress. */
let catchupFailures = 0;
let lastProgress = "";

/** Keep reading blocks in this worker. Chrome alarms cannot fire faster than about 30 seconds. */
function kickCatchup(delayMs: number): void {
  if (catchupTimer !== undefined) clearTimeout(catchupTimer);
  catchupTimer = setTimeout(() => {
    catchupTimer = undefined;
    void networkReady.then(() => runCatchup());
  }, delayMs);
}

async function runCatchup(): Promise<void> {
  if (catchupRunning) return;
  catchupRunning = true;
  try {
    if (!(await wallet.canIndex())) return;
    chrome.alarms.create(CATCHUP_ALARM, { delayInMinutes: 0.5 });
    try {
      await bumpLegacyBirthday();
      await wallet.loadChain();
      const progress = await wallet.followTip();
      const mark = `${progress.lastHeight}:${progress.height}:${progress.txIndex}`;
      const moved = mark !== lastProgress;
      lastProgress = mark;
      if (moved) catchupFailures = 0;
      const wait = progress.done || moved ? undefined : backoffMs(++catchupFailures, 2_000, 120_000);
      await noteHealth(undefined, wait);
      console.info(`[PrivateBit] scan: block ${progress.lastHeight} of ${progress.tip}${wait ? `, no progress, retrying in ${Math.round(wait / 1000)} s` : ""}`);
      if (!progress.done) {
        kickCatchup(wait ?? 0);
        chrome.alarms.create(CATCHUP_ALARM, { delayInMinutes: 0.5 });
      }
    } catch (e) {
      catchupFailures++;
      const wait = backoffMs(catchupFailures, 5_000, 300_000);
      await noteHealth(e, wait);
      console.warn(`[PrivateBit] scan paused: ${e instanceof Error ? e.message : String(e)}. Retrying in ${Math.round(wait / 1000)} s`);
      kickCatchup(wait);
    }
  } finally {
    catchupRunning = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PJ_ALARM || alarm.name === PJ_SOON) {
    void pumpPayjoin();
    return;
  }
  if (alarm.name === LOCK_ALARM) {
    void checkAutoLock();
    return;
  }
  if (alarm.name === PRICE_ALARM) {
    schedulePrice();
    void refreshPrice(true);
    return;
  }
  if (alarm.name === FEE_ALARM) {
    scheduleFees();
    void refreshFees();
    return;
  }
  if (alarm.name === DELAY_ALARM) {
    void pumpDelayed();
    return;
  }
  if (alarm.name !== FOLLOW_ALARM && alarm.name !== CATCHUP_ALARM) return;
  kickCatchup(0);
});

kickCatchup(0);
void pumpDelayed();

type PlanArgs = { destination: string; amount: string; feeRate?: number; coins?: string[]; max?: boolean; seed?: string };

type Msg =
  | { type: "STATE" }
  | { type: "BUNDLE" }
  | { type: "WATCH_SOURCE" }
  | { type: "NEW_MNEMONIC"; add?: boolean }
  | { type: "ONBOARD_GET" }
  | { type: "ONBOARD_CLEAR" }
  | { type: "CREATE_CHECKED"; password: string; passphrase?: string; add?: boolean; name?: string }
  | { type: "RESTORE"; mnemonic: string; password: string; passphrase?: string; birthday: number; add?: boolean; name?: string; forgot?: boolean }
  | { type: "SWITCH_WALLET"; id: string }
  | { type: "UNLOCK"; password: string }
  | { type: "RESTORE_BACKUP"; password: string }
  | { type: "LOCK" }
  | { type: "ACTIVITY" }
  | { type: "SCAN" }
  | { type: "SCAN_KICK" }
  | { type: "TIP" }
  | ({ type: "PLAN" } & PlanArgs)
  | ({ type: "BROADCAST"; intent: "payjoin" | "simple-send"; label?: string; planId?: string; sendNow?: boolean } & PlanArgs)
  | { type: "MAX_AMOUNT"; feeRate: number; coins?: string[] }
  | { type: "FEE_RATES"; force?: boolean }
  | { type: "PRICE"; force?: boolean }
  | { type: "PREFS_SET"; prefs: Partial<Prefs> }
  | { type: "COINS" }
  | { type: "SET_COIN_META"; outpoint: string; patch: Partial<CoinMeta> }
  | { type: "ASSET_CHECK"; outpoint: string }
  | { type: "HISTORY" }
  | { type: "SET_LABEL"; txid: string; label?: string }
  | { type: "ONETIME_ISSUE" }
  | { type: "ONETIME_REPLACE" }
  | { type: "ONETIME_VIEW" }
  | { type: "SWEEP_PLAN"; index: number; feeRate: number }
  | { type: "DAPP_VIEW"; id: string }
  | { type: "DAPP_DECIDE"; id: string; approve: boolean }
  | { type: "DAPP_SITES" }
  | { type: "DAPP_DISCONNECT"; origin: string }
  | { type: "DAPP_FORGET"; origin: string }
  | { type: "DAPP_FIND_SITE"; origin: string }
  | { type: "DAPP_VISIBILITY" }
  | { type: "DAPP_SET_VISIBILITY"; all: boolean }
  | { type: "DAPP_SHOW"; origin: string }
  | { type: "DAPP_HIDE"; origin: string }
  | { type: "SITE_MOVE_PLAN"; origin: string; feeRate: number }
  | { type: "SITE_MOVE"; origin: string; feeRate: number }
  | { type: "SWEEP_ONETIME"; index: number; feeRate: number }
  | { type: "DELAYED_SEND_NOW"; id: string }
  | { type: "DELAYED_CANCEL"; id: string }
  | { type: "DELAYED_DISMISS"; id: string }
  | { type: "SPLIT_PLAN"; outpoint: string; amounts: string[]; feeRate: number }
  | { type: "SPLIT_COIN"; outpoint: string; amounts: string[]; feeRate: number }
  | { type: "MIGRATE_START" }
  | { type: "MIGRATE_STATUS" }
  | { type: "MIGRATE_FINISH"; label: string }
  | { type: "MIGRATE_CANCEL" }
  | { type: "SESSIONS" }
  | { type: "CANCEL_LINK"; id: string }
  | { type: "CANCEL_SEND"; id: string }
  | { type: "SAVE_CHAIN"; chain: ChainConfig }
  | { type: "LOAD_CHAIN" }
  | { type: "TEST_CHAIN"; chain: ChainConfig; sendNode?: boolean }
  | { type: "SET_NETWORK"; network: NetworkId }
  | { type: "PJ_TEST"; directory: string; relay: string; allowDirect?: boolean }
  | { type: "SET_BIRTHDAY"; birthday: number }
  | { type: "FOLLOW_TIP" }
  | { type: "OFFER_PAYJOIN"; amount: string }
  | { type: "SERVICE_PAYJOIN" }
  | { type: "SHOW_WORDS"; password: string }
  | { type: "CHANGE_PASSWORD"; current: string; next: string }
  | { type: "REMOVE_WALLET"; password: string; id?: string }
  | { type: "CHECK_WALLET_PASSWORD"; id: string; password: string }
  | { type: "RENAME_WALLET"; id: string; name: string };

type Onboard = { mnemonic: string; words: 24; createdAt: number };
/** Audit L4: new recovery words wait in memory for at most this long, then the setup starts again. */
const ONBOARD_TTL_MS = 30 * 60_000;
async function pendingOnboard(): Promise<Onboard | undefined> {
  const ob = (await kv.get([ONBOARD_KEY]))[ONBOARD_KEY] as Onboard | undefined;
  if (ob && !(Date.now() - ob.createdAt < ONBOARD_TTL_MS)) {
    await kv.remove([ONBOARD_KEY]);
    return undefined;
  }
  return ob;
}

async function bundle() {
  const got = await kv.get([HEALTH_KEY, LOCKINFO_KEY, PRICE_KEY, PREFS_KEY, ACTIVITY_KEY]);
  return {
    state: await wallet.state(),
    prefs: normalizePrefs(got[PREFS_KEY]),
    health: (got[HEALTH_KEY] as Health | undefined) ?? null,
    lockinfo: (got[LOCKINFO_KEY] as LockInfo | undefined) ?? null,
    price: (got[PRICE_KEY] as PriceCache | undefined) ?? null,
    activity: (got[ACTIVITY_KEY] as ActivityState | undefined) ?? null,
    waiting: await wallet.waitingPayjoin(),
    delayed: await wallet.delayedView().catch(() => []),
    delayedElsewhere: await wallet.delayedElsewhere().catch(() => []),
  };
}

async function birthdayForNewWallet(): Promise<number> {
  // The vault keeps the Fractal start. On Bitcoin the tip is a Bitcoin height, so it cannot be used here.
  if (wallet.net !== "fractal") return DEFAULT_BIRTHDAY;
  try {
    const tip = await wallet.source().getTip();
    await noteHealth();
    return tip.height > DEFAULT_BIRTHDAY ? tip.height : DEFAULT_BIRTHDAY;
  } catch (e) {
    await noteHealth(e);
    return DEFAULT_BIRTHDAY;
  }
}

/** Move wallets still on the previous shipped start so the first scan is not thousands of blocks. */
async function bumpLegacyBirthday(): Promise<void> {
  const st = await wallet.state();
  if (st.unlocked && st.birthday === LEGACY_DEFAULT_BIRTHDAY) {
    await wallet.setBirthday(DEFAULT_BIRTHDAY);
  }
}

/** The network minimum for "Randomize fee slightly": the cached fee reading, or 1 sat/vB. */
async function minimumFeeRate(): Promise<number> {
  const cached = (await kv.get([FEES_KEY]))[FEES_KEY] as FeeRates | undefined;
  const m = cached?.minimum;
  return typeof m === "number" && Number.isFinite(m) && m > 0 ? m : 1;
}

async function planOf(m: PlanArgs) {
  const prefs = await getPrefs();
  return {
    amount: BigInt(m.amount || "0"),
    opts: {
      feeRate: m.feeRate,
      coins: m.coins,
      max: m.max,
      seed: m.seed,
      randomizeFee: prefs.randomizeFee,
      minFeeRate: await minimumFeeRate(),
      leftover: prefs.leftover,
    },
    prefs,
  };
}

/* ---------- delayed sending ---------- */

const DELAY_ALARM = "pb.delayed";
let delayTimer: ReturnType<typeof setTimeout> | undefined;

/** Wake for the next held payment. The alarm survives a worker restart; the timer is precise while awake. */
async function scheduleDelayed(next: number | undefined): Promise<void> {
  if (delayTimer !== undefined) clearTimeout(delayTimer);
  delayTimer = undefined;
  if (next === undefined) {
    await chrome.alarms.clear(DELAY_ALARM);
    return;
  }
  // Chrome runs alarms at most every 30 seconds; the timer covers the short waits.
  chrome.alarms.create(DELAY_ALARM, { when: Math.max(Date.now() + 30_000, next) });
  const wait = Math.max(0, next - Date.now());
  if (wait < 5 * 60_000) delayTimer = setTimeout(() => void pumpDelayed(), wait + 50);
}

async function pumpDelayed(): Promise<void> {
  try {
    await networkReady;
    await wallet.loadChain();
    const r = await wallet.runDelayed();
    if (r.sent.length) kickCatchup(0);
    await scheduleDelayed(r.next);
  } catch {
    // No vault, or the list cannot be opened yet: look again in a minute.
    chrome.alarms.create(DELAY_ALARM, { delayInMinutes: 1 });
  }
}


async function switchNetwork(network: NetworkId): Promise<void> {
  if (!isNetworkId(network)) throw new Error("Unknown network");
  const prev = await getPrefs();
  await kv.set({ [PREFS_KEY]: normalizePrefs({ ...prev, network }) });
  await kv.remove([FEES_KEY, HEALTH_KEY, PRICE_KEY]);
  await wallet.setNetwork(network);
  setTimeout(() => void refreshPrice(true), jitterMs(2_000, 30_000));
  void pumpDelayed();
  void pumpPayjoin();
  kickCatchup(0);
}

// Website connections: content script ports, approval popups, events.
const dapp = installDapp({ wallet, rejectLimit: import.meta.env.MODE === "e2e" ? 100 : undefined, switchNetwork: async (n) => {
  await networkReady;
  await switchNetwork(n);
} });
// Lock, unlock, wallet switch and chain switch all write one of these keys: tell connected pages.
chrome.storage.onChanged.addListener((changes) => {
  const keys = Object.keys(changes);
  if (keys.some((k) => k === LOCKINFO_KEY || k === PREFS_KEY || k.endsWith(".session") || k.endsWith(".sites") || k === "privatebit.wallets")) {
    void dapp.refreshEvents().catch(() => undefined);
  }
});

async function handle(msg: Msg): Promise<unknown> {
  await networkReady;
  switch (msg.type) {
    case "STATE":
      return wallet.state();
    case "BUNDLE":
      return bundle();
    case "WATCH_SOURCE": {
      // For the Android app's background confirmation check. Unlocked only; never includes keys.
      if (!(await wallet.state()).unlocked) throw new Error("locked");
      return watchEndpoint(await wallet.loadChain(), wallet.net);
    }
    case "NEW_MNEMONIC": {
      if (!msg.add && (await loadVaultBlob(kv))) throw new Error("A wallet is already on this computer. Unlock it, or restore from recovery words.");
      const ob: Onboard = { mnemonic: createMnemonic(256), words: 24, createdAt: Date.now() };
      await kv.set({ [ONBOARD_KEY]: ob });
      return ob;
    }
    case "ONBOARD_GET":
      return (await pendingOnboard()) ?? null;
    case "ONBOARD_CLEAR":
      await kv.remove([ONBOARD_KEY]);
      return null;
    case "CREATE_CHECKED": {
      const ob = await pendingOnboard();
      if (!ob) throw new Error("Start again: the recovery words were cleared.");
      const birthday = await birthdayForNewWallet();
      if (msg.add) {
        await wallet.addWallet({ mnemonic: ob.mnemonic, password: msg.password, passphrase: msg.passphrase, birthday, name: msg.name, kind: "create" });
      } else {
        await wallet.createChecked({ mnemonic: ob.mnemonic, password: msg.password, passphrase: msg.passphrase, birthday, name: msg.name });
      }
      await kv.remove([ONBOARD_KEY, LOCKINFO_KEY]);
      if (wallet.net !== "fractal") {
        // A new wallet has no older coins: start the Bitcoin scan at the Bitcoin tip.
        const tip = await wallet.source().getTip().catch(() => null);
        if (tip && tip.height > 0) await wallet.setBirthday(tip.height).catch(() => undefined);
      }
      await kv.set({ [ACTIVITY_KEY]: touch(undefined, Date.now()) });
      void priceIfMissing();
      kickCatchup(0);
      return bundle();
    }
    case "RESTORE": {
      // Import never replaces a wallet (audit M5): it adds one, or opens the same words already here.
      // The typed start block belongs to the open chain. The vault keeps the Fractal one, so
      // on Bitcoin the vault gets the Fractal default and Bitcoin gets the typed block.
      const onBitcoin = wallet.net === "bitcoin";
      const imported = await wallet.importWallet({
        mnemonic: msg.mnemonic,
        password: msg.password,
        passphrase: msg.passphrase,
        birthday: onBitcoin ? netInfo("fractal").defaultBirthday : msg.birthday,
        name: msg.name,
        resetPassword: msg.forgot === true,
      });
      if (onBitcoin && imported.result === "added" && msg.birthday > 0) await wallet.setBirthday(msg.birthday);
      await kv.remove([LOCKINFO_KEY]);
      await kv.set({ [ACTIVITY_KEY]: touch(undefined, Date.now()) });
      void pumpPayjoin();
      void priceIfMissing();
      kickCatchup(0);
      return { ...(await bundle()), imported };
    }
    case "SWITCH_WALLET":
      await wallet.openWallet(msg.id);
      void pumpDelayed();
      await kv.remove([ACTIVITY_KEY]);
      await kv.set({ [LOCKINFO_KEY]: { by: "user", at: Date.now() } satisfies LockInfo });
      return bundle();
    case "UNLOCK":
      await wallet.unlock(msg.password);
      // Sites connected before this version stay visible to their pages (audit M7, independent).
      void wallet.loadSites().then((st) => showToOrigins(st.sites.map((x) => x.origin))).catch(() => undefined);
      await bumpLegacyBirthday();
      await kv.remove([LOCKINFO_KEY]);
      await kv.set({ [ACTIVITY_KEY]: touch(undefined, Date.now()) });
      void pumpPayjoin();
      void pumpDelayed();
      void priceIfMissing();
      // I8: coins are found while locked, so there is no need to hit the server the moment of unlock.
      kickCatchup(jitterMs(3_000, 30_000));
      return bundle();
    case "RESTORE_BACKUP":
      await wallet.restoreBackup(msg.password);
      await kv.remove([ACTIVITY_KEY]);
      await kv.set({ [LOCKINFO_KEY]: { by: "user", at: Date.now() } satisfies LockInfo });
      return bundle();
    case "LOCK":
      await wallet.lock();
      await kv.remove([ACTIVITY_KEY, FEES_KEY, ONBOARD_KEY]);
      await kv.set({ [LOCKINFO_KEY]: { by: "user", at: Date.now() } satisfies LockInfo });
      kickCatchup(0);
      return null;
    case "ACTIVITY": {
      const got = (await kv.get([ACTIVITY_KEY]))[ACTIVITY_KEY] as ActivityState | undefined;
      await kv.set({ [ACTIVITY_KEY]: touch(got, Date.now()) });
      return null;
    }
    case "SCAN_KICK":
    case "SCAN":
    case "FOLLOW_TIP":
      kickCatchup(0);
      return msg.type === "SCAN_KICK" ? null : bundle();
    case "TIP":
      return wallet.source().getTip();
    case "PLAN": {
      const { amount, opts } = await planOf(msg);
      return wallet.plan(msg.destination, amount, opts);
    }
    case "BROADCAST": {
      // Only the reviewed plan is sent (audit M10). A changed plan comes back for review.
      const { amount, opts, prefs } = await planOf(msg);
      if (typeof msg.planId !== "string" || typeof opts.feeRate !== "number") throw new Error("Review the payment first.");
      const checked = await wallet.confirmPlan(msg.planId, msg.destination, amount, { ...opts, feeRate: opts.feeRate });
      if (!checked.ok) return { changed: true, plan: checked.plan };
      const built = checked.built;
      const intent = msg.intent === "payjoin" ? INTENT_PAYJOIN : INTENT_SIMPLE_SEND;
      // Payjoin is never delayed: the receiver is waiting for the payer's transaction.
      const holdMs = intent === INTENT_PAYJOIN || msg.sendNow ? 0 : randomDelayMs(prefs.sendDelay);
      const result = await wallet.broadcast(intent, built, { label: msg.label, feeRate: built.feeRate ?? opts.feeRate, holdMs });
      if (result.kind === "payjoin-pending") schedulePayjoinWake();
      if (result.kind === "delayed") {
        await scheduleDelayed(result.sendAt);
        return { delayed: { id: result.id, sendAt: result.sendAt }, fee: built.fee.toString() };
      }
      return { ...(result.kind === "txid" ? { txid: result.txid } : { pending: true }), fee: built.fee.toString() };
    }
    case "MAX_AMOUNT":
      return wallet.maxAmount(msg.feeRate, msg.coins);
    case "FEE_RATES": {
      const cached = (await kv.get([FEES_KEY]))[FEES_KEY] as (FeeRates & { fetchedAt: number }) | undefined;
      // I8: opening Send reads the fees fetched on the random schedule. Only a tap on refresh,
      // or no usable rates at all, asks the server now.
      if (cached && !msg.force && Date.now() - cached.fetchedAt < 3 * FEE_PERIOD_MS) return cached;
      const next = await refreshFees();
      if (!next) throw new Error("Could not read fee rates. Check the connection and try again.");
      scheduleFees();
      return next;
    }
    case "PRICE":
      // I8: the popup shows the price from the random schedule; only an explicit refresh fetches.
      if (msg.force) return refreshPrice(true);
      return ((await kv.get([PRICE_KEY]))[PRICE_KEY] as PriceCache | undefined) ?? {};
    case "PREFS_SET": {
      const prev = await getPrefs();
      const patch: Partial<Prefs> = { ...msg.prefs };
      // The old on/off switch still works: on picks the last source, or CoinGecko.
      if (patch.usd !== undefined && patch.priceSource === undefined) patch.priceSource = patch.usd ? (prev.priceSource === "off" ? "coingecko" : prev.priceSource) : "off";
      delete patch.usd;
      const next = normalizePrefs({ ...prev, ...patch });
      await kv.set({ [PREFS_KEY]: next });
      if (!next.usd) await kv.remove([PRICE_KEY]);
      else if (!prev.usd || prev.priceSource !== next.priceSource) void refreshPrice(true);
      return next;
    }
    case "COINS":
      return wallet.coins();
    case "SET_COIN_META": {
      // What an ord server said is set only by ASSET_CHECK, never by the page.
      const { asset: _asset, ...patch } = msg.patch;
      void _asset;
      await wallet.setCoinMeta(msg.outpoint, patch);
      return wallet.coins();
    }
    case "ASSET_CHECK":
      return { verdict: await wallet.checkCoinAsset(msg.outpoint), coins: await wallet.coins() };
    case "HISTORY":
      return wallet.history();
    case "SET_LABEL":
      await wallet.setActivityLabel(msg.txid, msg.label);
      return wallet.history();
    case "ONETIME_ISSUE":
      return wallet.issueOneTime();
    case "ONETIME_REPLACE":
      return wallet.replaceOneTime();
    case "ONETIME_VIEW":
      return wallet.oneTimeView();
    case "SWEEP_PLAN": {
      const b = await wallet.planSweep(msg.index, msg.feeRate);
      return { fee: b.fee.toString(), amount: b.amount.toString(), vbytes: b.vbytes, count: b.signableInputs.length };
    }
    case "SWEEP_ONETIME":
      return wallet.sweepOneTime(msg.index, msg.feeRate);
    case "DELAYED_SEND_NOW": {
      const r = await wallet.runDelayed({ only: msg.id });
      if (r.sent.length) kickCatchup(0);
      await scheduleDelayed(r.next);
      return { ...r, bundle: await bundle() };
    }
    case "DELAYED_CANCEL": {
      await wallet.cancelDelayed(msg.id);
      const left = (await wallet.delayedView()).filter((d) => d.status === "waiting");
      await scheduleDelayed(left.reduce<number | undefined>((m, d) => (m === undefined || d.sendAt < m ? d.sendAt : m), undefined));
      return bundle();
    }
    case "DELAYED_DISMISS":
      await wallet.dismissDelayed(msg.id);
      return bundle();
    case "SPLIT_PLAN":
      return wallet.planSplit(msg.outpoint, msg.amounts, msg.feeRate);
    case "SPLIT_COIN":
      return wallet.splitCoin(msg.outpoint, msg.amounts, msg.feeRate);
    case "MIGRATE_START":
      await wallet.startMigration();
      return wallet.migrationStatus();
    case "MIGRATE_STATUS":
      return wallet.migrationStatus();
    case "MIGRATE_FINISH":
      await wallet.finishMigration(msg.label);
      return null;
    case "MIGRATE_CANCEL":
      await wallet.cancelMigration();
      return null;
    case "SESSIONS":
      return wallet.sessions();
    case "CANCEL_LINK":
      await wallet.cancelLink(msg.id);
      return wallet.sessions();
    case "CANCEL_SEND":
      await wallet.cancelSend(msg.id);
      return wallet.sessions();
    case "SAVE_CHAIN":
      await wallet.saveChain(msg.chain);
      await kv.remove([FEES_KEY]);
      return redactChain(await wallet.loadChain());
    case "LOAD_CHAIN":
      return redactChain(await wallet.loadChain());
    case "TEST_CHAIN": {
      const prev = await wallet.loadChain();
      // Audit L5: a saved secret only goes back to the address it was saved for.
      const same = (a?: string, b?: string) => !!a && !!b && a.trim().replace(/\/$/, "") === b.trim().replace(/\/$/, "");
      const cfg: ChainConfig = {
        ...msg.chain,
        rpcPassword: msg.chain.rpcPassword === "********" ? (same(msg.chain.url, prev.url) ? prev.rpcPassword : undefined) : msg.chain.rpcPassword,
        unisatToken: msg.chain.unisatToken === "********" ? (same(msg.chain.url, prev.url) ? prev.unisatToken : undefined) : msg.chain.unisatToken,
        sendNodePassword: msg.chain.sendNodePassword === "********" ? (same(msg.chain.sendNodeUrl, prev.sendNodeUrl) ? prev.sendNodePassword : undefined) : msg.chain.sendNodePassword,
      };
      const net = wallet.net;
      const nodeCfg = cfg.kind === "core" ? { url: cfg.url, rpcUser: cfg.rpcUser, rpcPassword: cfg.rpcPassword } : msg.sendNode && cfg.sendNodeUrl ? { url: cfg.sendNodeUrl, rpcUser: cfg.sendNodeUser, rpcPassword: cfg.sendNodePassword } : undefined;
      if (!nodeCfg) return { ...(await openChain(cfg, net).getTip()), net };
      const check = await checkNode(nodeCfg);
      const onChain = await nodeFollows(nodeCfg, net);
      return { ...check, net, onChain };
    }
    case "PJ_TEST":
      return testPayjoinRoute(msg.directory.trim(), msg.relay.trim(), undefined, msg.allowDirect === true);
    case "SET_NETWORK": {
      await switchNetwork(msg.network);
      return bundle();
    }
    case "DAPP_VIEW":
      return dapp.view(msg.id);
    case "DAPP_DECIDE":
      return dapp.decide(msg.id, msg.approve);
    case "DAPP_SITES":
      return wallet.sitesView();
    case "DAPP_DISCONNECT":
      await dapp.disconnect(msg.origin);
      return wallet.sitesView();
    case "DAPP_FORGET":
      await wallet.forgetSite(msg.origin);
      await hideFromOrigin(msg.origin);
      return wallet.sitesView();
    case "DAPP_FIND_SITE":
      await wallet.findSite(msg.origin);
      return wallet.sitesView();
    case "DAPP_VISIBILITY":
      return loadVisibility();
    case "DAPP_SET_VISIBILITY": {
      const v = await loadVisibility();
      await saveVisibility({ ...v, all: msg.all });
      return loadVisibility();
    }
    case "DAPP_SHOW": {
      // From the popup, on the tab the user is looking at: let this site see PrivateBit now.
      const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      let origin = "";
      try {
        origin = normalizeOrigin(new URL(tab?.url ?? "").origin);
      } catch {
        throw new Error("Open the website in this window first.");
      }
      if (origin !== normalizeOrigin(msg.origin)) throw new Error("The website in this window changed. Try again.");
      await showToOrigins([origin]);
      if (tab?.id !== undefined) await injectProvider({ tabId: tab.id });
      return loadVisibility();
    }
    case "DAPP_HIDE":
      await hideFromOrigin(msg.origin);
      return loadVisibility();
    case "SITE_MOVE_PLAN": {
      const b = await wallet.planSiteMoveBack(msg.origin, msg.feeRate);
      return { fee: b.fee.toString(), amount: b.amount.toString(), vbytes: b.vbytes, count: b.signableInputs.length };
    }
    case "SITE_MOVE":
      return wallet.siteMoveBack(msg.origin, msg.feeRate);
    case "SET_BIRTHDAY":
      await wallet.setBirthday(msg.birthday);
      return bundle();
    case "OFFER_PAYJOIN": {
      const session = await wallet.offerPayjoin(BigInt(msg.amount || "0"));
      schedulePayjoinWake();
      void pumpPayjoin();
      return { id: session.id, bip21: session.bip21 };
    }
    case "SERVICE_PAYJOIN":
      return wallet.servicePayjoin();
    case "SHOW_WORDS": {
      const v = await wallet.checkPassword(msg.password);
      return { mnemonic: v.mnemonic };
    }
    case "CHANGE_PASSWORD":
      await wallet.changePassword(msg.current, msg.next);
      return null;
    case "CHECK_WALLET_PASSWORD":
      await wallet.checkWalletPassword(msg.id, msg.password);
      return null;
    case "RENAME_WALLET":
      await wallet.renameWallet(msg.id, msg.name);
      return bundle();
    case "REMOVE_WALLET": {
      // One wallet goes (the open one, or another by id). Storage is cleared only after the last.
      const { wiped, removedOpen } = await wallet.removeWallet(msg.password, msg.id);
      if (!removedOpen) return { wiped: false, removedOpen: false, left: (await wallet.state()).wallets?.length ?? 0 };
      stopPayjoinTimer();
      await chrome.alarms.clear(PJ_ALARM);
      await chrome.alarms.clear(PJ_SOON);
      await kv.remove([ACTIVITY_KEY]);
      if (!wiped) {
        await kv.set({ [LOCKINFO_KEY]: { by: "user", at: Date.now() } satisfies LockInfo });
        return { wiped: false, left: (await wallet.state()).wallets?.length ?? 0 };
      }
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      // Downloaded blocks hold no wallet data, but nothing of PrivateBit should stay behind.
      await clearSharedChain().catch(() => undefined);
      const left = { ...(await chrome.storage.local.get(null)), ...(await chrome.storage.session.get(null)) };
      return { wiped: true, left: Object.keys(left).length };
    }
    default:
      throw new Error("unknown");
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, sender, send) => {
  const reply = (payload: { ok: boolean; data?: unknown; error?: string; code?: string }): void => {
    send(jsonSafe(payload));
  };
  void (async () => {
    try {
      // Extension pages only. Content scripts share our id, so the sender URL decides.
      if (sender.id !== chrome.runtime.id || !(sender.url ?? "").startsWith(chrome.runtime.getURL(""))) {
        reply({ ok: false, error: "forbidden" });
        return;
      }
      await wallet.loadChain();
      reply({ ok: true, data: await handle(msg) });
    } catch (e) {
      reply({ ok: false, error: e instanceof Error ? e.message : String(e), code: errorCode(e) });
    }
  })();
  return true;
});

export type { Prefs };
export { DEFAULT_PREFS };
