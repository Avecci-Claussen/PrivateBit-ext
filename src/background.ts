import { chromeKv } from "./chrome-kv.ts";
import { installE2E } from "./e2e-hook.ts";
import { jsonSafe } from "./lib/json.ts";
import { DEFAULT_BIRTHDAY, DEFAULT_CHAIN, LEGACY_DEFAULT_BIRTHDAY, redactChain, type ChainConfig } from "./lib/network.ts";
import { INTENT_PAYJOIN, INTENT_SIMPLE_SEND, PrivateBit } from "./lib/wallet.ts";
import { autoLockDecision, touch, type ActivityState } from "./lib/autolock.ts";
import { DEFAULT_PREFS, normalizePrefs, PREFS_KEY, type Prefs } from "./lib/prefs.ts";
import { getPrice, PRICE_PERIOD_MIN, RateLimitedError, type FeeRates } from "./lib/requests.ts";
import { createMnemonic, loadVaultBlob } from "./lib/vault.ts";
import { openChain } from "./lib/chain.ts";
import { clearSharedChain } from "./lib/blockshare.ts";
import { backoffMs } from "./lib/net.ts";
import type { CoinMeta } from "./lib/coinmeta.ts";

const kv = chromeKv();
const wallet = new PrivateBit(kv, DEFAULT_CHAIN);
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

export type Health = { state: "ok" | "rate-limited" | "offline" | "error"; since?: number; at: number; detail?: string };
export type PriceCache = { usd?: number; at?: number; fetchedAt?: number; failedAt?: number };
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

async function noteHealth(e?: unknown): Promise<void> {
  const prev = (await kv.get([HEALTH_KEY]))[HEALTH_KEY] as Health | undefined;
  const now = Date.now();
  if (!e) {
    await kv.set({ [HEALTH_KEY]: { state: "ok", at: now } satisfies Health });
    return;
  }
  const code = errorCode(e);
  if (!code) return; // locked, no vault, or a logic error: not a reachability problem
  const since = prev && prev.state === code ? (prev.since ?? prev.at) : now;
  await kv.set({ [HEALTH_KEY]: { state: code, since, at: now } satisfies Health });
}

function ensureAlarms(): void {
  chrome.alarms.create(FOLLOW_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  chrome.alarms.create(LOCK_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  chrome.alarms.create(PRICE_ALARM, { periodInMinutes: PRICE_PERIOD_MIN, delayInMinutes: PRICE_PERIOD_MIN });
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
    pjTimer = setTimeout(() => void pumpPayjoin(), PJ_POLL_MS);
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
  const d = autoLockDecision(state, now, prefs.lockMinutes, await wallet.waitingPayjoin());
  if (d.lock) {
    await wallet.lock();
    await kv.remove([ACTIVITY_KEY, FEES_KEY]);
    await kv.set({ [LOCKINFO_KEY]: { by: "auto", minutes: prefs.lockMinutes, at: now } satisfies LockInfo });
    kickCatchup(0);
    return;
  }
  await kv.set({ [ACTIVITY_KEY]: d.next });
}

async function refreshPrice(force = false): Promise<PriceCache> {
  const prev = ((await kv.get([PRICE_KEY]))[PRICE_KEY] as PriceCache | undefined) ?? {};
  const prefs = await getPrefs();
  if (!prefs.usd || !(await isUnlocked())) return prev;
  const fresh = prev.fetchedAt && Date.now() - prev.fetchedAt < PRICE_PERIOD_MIN * 60_000;
  if (fresh && !force) return prev;
  try {
    const p = await getPrice();
    const next: PriceCache = { usd: p.usd, at: p.at, fetchedAt: p.fetchedAt };
    await kv.set({ [PRICE_KEY]: next });
    return next;
  } catch {
    const next: PriceCache = { ...prev, failedAt: Date.now() };
    await kv.set({ [PRICE_KEY]: next });
    return next;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  void pumpPayjoin();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  void pumpPayjoin();
});
ensureAlarms();
void pumpPayjoin();

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
    void runCatchup();
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
      await noteHealth();
      const mark = `${progress.lastHeight}:${progress.height}:${progress.txIndex}`;
      const moved = mark !== lastProgress;
      lastProgress = mark;
      if (moved) catchupFailures = 0;
      if (!progress.done) {
        if (!moved) catchupFailures++;
        kickCatchup(moved ? 0 : backoffMs(catchupFailures, 2_000, 120_000));
        chrome.alarms.create(CATCHUP_ALARM, { delayInMinutes: 0.5 });
      }
    } catch (e) {
      await noteHealth(e);
      catchupFailures++;
      kickCatchup(backoffMs(catchupFailures, 5_000, 300_000));
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
    void refreshPrice();
    return;
  }
  if (alarm.name !== FOLLOW_ALARM && alarm.name !== CATCHUP_ALARM) return;
  kickCatchup(0);
});

kickCatchup(0);

type PlanArgs = { destination: string; amount: string; feeRate?: number; coins?: string[]; max?: boolean };

type Msg =
  | { type: "STATE" }
  | { type: "BUNDLE" }
  | { type: "NEW_MNEMONIC"; add?: boolean }
  | { type: "ONBOARD_GET" }
  | { type: "ONBOARD_CLEAR" }
  | { type: "CREATE_CHECKED"; password: string; passphrase?: string; add?: boolean; name?: string }
  | { type: "RESTORE"; mnemonic: string; password: string; passphrase?: string; birthday: number; add?: boolean; name?: string }
  | { type: "SWITCH_WALLET"; id: string }
  | { type: "UNLOCK"; password: string }
  | { type: "RESTORE_BACKUP"; password: string }
  | { type: "LOCK" }
  | { type: "ACTIVITY" }
  | { type: "SCAN" }
  | { type: "SCAN_KICK" }
  | { type: "TIP" }
  | ({ type: "PLAN" } & PlanArgs)
  | ({ type: "BROADCAST"; intent: "payjoin" | "simple-send"; label?: string } & PlanArgs)
  | { type: "MAX_AMOUNT"; feeRate: number; coins?: string[] }
  | { type: "FEE_RATES"; force?: boolean }
  | { type: "PRICE"; force?: boolean }
  | { type: "PREFS_SET"; prefs: Partial<Prefs> }
  | { type: "COINS" }
  | { type: "SET_COIN_META"; outpoint: string; patch: Partial<CoinMeta> }
  | { type: "HISTORY" }
  | { type: "SET_LABEL"; txid: string; label?: string }
  | { type: "ONETIME_ISSUE" }
  | { type: "ONETIME_REPLACE" }
  | { type: "ONETIME_VIEW" }
  | { type: "SWEEP_PLAN"; index: number; feeRate: number }
  | { type: "SWEEP_ONETIME"; index: number; feeRate: number }
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
  | { type: "TEST_CHAIN"; chain: ChainConfig }
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
  };
}

async function birthdayForNewWallet(): Promise<number> {
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

async function planOf(m: PlanArgs) {
  return { amount: BigInt(m.amount || "0"), opts: { feeRate: m.feeRate, coins: m.coins, max: m.max } };
}

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.type) {
    case "STATE":
      return wallet.state();
    case "BUNDLE":
      return bundle();
    case "NEW_MNEMONIC": {
      if (!msg.add && (await loadVaultBlob(kv))) throw new Error("A wallet is already on this computer. Unlock it, or restore from recovery words.");
      const ob: Onboard = { mnemonic: createMnemonic(256), words: 24, createdAt: Date.now() };
      await kv.set({ [ONBOARD_KEY]: ob });
      return ob;
    }
    case "ONBOARD_GET":
      return (await kv.get([ONBOARD_KEY]))[ONBOARD_KEY] ?? null;
    case "ONBOARD_CLEAR":
      await kv.remove([ONBOARD_KEY]);
      return null;
    case "CREATE_CHECKED": {
      const ob = (await kv.get([ONBOARD_KEY]))[ONBOARD_KEY] as Onboard | undefined;
      if (!ob) throw new Error("Start again: the recovery words were cleared.");
      const birthday = await birthdayForNewWallet();
      if (msg.add) {
        await wallet.addWallet({ mnemonic: ob.mnemonic, password: msg.password, passphrase: msg.passphrase, birthday, name: msg.name, kind: "create" });
      } else {
        await wallet.createChecked({ mnemonic: ob.mnemonic, password: msg.password, passphrase: msg.passphrase, birthday, name: msg.name });
      }
      await kv.remove([ONBOARD_KEY, LOCKINFO_KEY]);
      await kv.set({ [ACTIVITY_KEY]: touch(undefined, Date.now()) });
      void refreshPrice(true);
      kickCatchup(0);
      return bundle();
    }
    case "RESTORE":
      if (msg.add) {
        await wallet.addWallet({ mnemonic: msg.mnemonic, password: msg.password, passphrase: msg.passphrase, birthday: msg.birthday, name: msg.name, kind: "import" });
      } else {
        await wallet.restore(msg);
      }
      await kv.remove([LOCKINFO_KEY]);
      await kv.set({ [ACTIVITY_KEY]: touch(undefined, Date.now()) });
      void refreshPrice(true);
      kickCatchup(0);
      return bundle();
    case "SWITCH_WALLET":
      await wallet.openWallet(msg.id);
      await kv.remove([ACTIVITY_KEY, FEES_KEY]);
      await kv.set({ [LOCKINFO_KEY]: { by: "user", at: Date.now() } satisfies LockInfo });
      return bundle();
    case "UNLOCK":
      await wallet.unlock(msg.password);
      await bumpLegacyBirthday();
      await kv.remove([LOCKINFO_KEY]);
      await kv.set({ [ACTIVITY_KEY]: touch(undefined, Date.now()) });
      void pumpPayjoin();
      void refreshPrice();
      kickCatchup(0);
      return bundle();
    case "RESTORE_BACKUP":
      await wallet.restoreBackup(msg.password);
      await kv.remove([ACTIVITY_KEY, FEES_KEY]);
      await kv.set({ [LOCKINFO_KEY]: { by: "user", at: Date.now() } satisfies LockInfo });
      return bundle();
    case "LOCK":
      await wallet.lock();
      await kv.remove([ACTIVITY_KEY, FEES_KEY]);
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
      await wallet.assertNotOwnLink(msg.destination);
      const { amount, opts } = await planOf(msg);
      const built = await wallet.planSend(msg.destination, amount, opts);
      const intent = msg.intent === "payjoin" ? INTENT_PAYJOIN : INTENT_SIMPLE_SEND;
      const result = await wallet.broadcast(intent, built, { label: msg.label, feeRate: opts.feeRate });
      if (result.kind === "payjoin-pending") schedulePayjoinWake();
      return { ...(result.kind === "txid" ? { txid: result.txid } : { pending: true }), fee: built.fee.toString() };
    }
    case "MAX_AMOUNT":
      return wallet.maxAmount(msg.feeRate, msg.coins);
    case "FEE_RATES": {
      const cached = (await kv.get([FEES_KEY]))[FEES_KEY] as (FeeRates & { fetchedAt: number }) | undefined;
      if (cached && !msg.force && Date.now() - cached.fetchedAt < 60_000) return cached;
      try {
        const r = await wallet.feeRates();
        const next = { ...r, fetchedAt: Date.now() };
        await kv.set({ [FEES_KEY]: next });
        await noteHealth();
        return next;
      } catch (e) {
        await noteHealth(e);
        throw e;
      }
    }
    case "PRICE":
      return refreshPrice(!!msg.force);
    case "PREFS_SET": {
      const prev = await getPrefs();
      const next = normalizePrefs({ ...prev, ...msg.prefs });
      await kv.set({ [PREFS_KEY]: next });
      if (!next.usd) await kv.remove([PRICE_KEY]);
      else if (!prev.usd) void refreshPrice(true);
      return next;
    }
    case "COINS":
      return wallet.coins();
    case "SET_COIN_META":
      await wallet.setCoinMeta(msg.outpoint, msg.patch);
      return wallet.coins();
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
      const cfg: ChainConfig = {
        ...msg.chain,
        rpcPassword: msg.chain.rpcPassword === "********" ? prev.rpcPassword : msg.chain.rpcPassword,
        unisatToken: msg.chain.unisatToken === "********" ? prev.unisatToken : msg.chain.unisatToken,
      };
      return openChain(cfg).getTip();
    }
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
      await kv.remove([ACTIVITY_KEY, FEES_KEY]);
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
      if (sender.id !== chrome.runtime.id) {
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
