import { chromeKv } from "./chrome-kv.ts";
import { jsonSafe } from "./lib/json.ts";
import { DEFAULT_CHAIN, redactChain, type ChainConfig } from "./lib/network.ts";
import { INTENT_PAYJOIN, INTENT_SIMPLE_SEND, PrivateBit } from "./lib/wallet.ts";

const wallet = new PrivateBit(chromeKv(), DEFAULT_CHAIN);
const FOLLOW_ALARM = "privatebit.follow-tip";
const PJ_ALARM = "privatebit.payjoin";
const PJ_SOON = "privatebit.payjoin.soon";

function ensureFollowAlarm(): void {
  chrome.alarms.create(FOLLOW_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
}

function schedulePayjoinWake(): void {
  chrome.alarms.create(PJ_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  chrome.alarms.create(PJ_SOON, { when: Date.now() + 15_000 });
}

async function pumpPayjoin(): Promise<void> {
  try {
    await wallet.loadChain();
    await wallet.servicePayjoin();
    if (await wallet.waitingPayjoin()) schedulePayjoinWake();
    else {
      await chrome.alarms.clear(PJ_ALARM);
      await chrome.alarms.clear(PJ_SOON);
    }
  } catch {
    /* no vault yet */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureFollowAlarm();
  void pumpPayjoin();
});
chrome.runtime.onStartup.addListener(() => {
  ensureFollowAlarm();
  void pumpPayjoin();
});
ensureFollowAlarm();
void pumpPayjoin();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PJ_ALARM || alarm.name === PJ_SOON) {
    void pumpPayjoin();
    return;
  }
  if (alarm.name !== FOLLOW_ALARM) return;
  void (async () => {
    try {
      await wallet.loadChain();
      await wallet.followTip();
    } catch {
      /* locked, or UniSat tip not indexed yet */
    }
  })();
});

type Msg =
  | { type: "STATE" }
  | { type: "CREATE"; password: string; passphrase?: string; birthday: number; words?: 12 | 24 }
  | { type: "RESTORE"; mnemonic: string; password: string; passphrase?: string; birthday: number }
  | { type: "UNLOCK"; password: string }
  | { type: "LOCK" }
  | { type: "SCAN" }
  | { type: "TIP" }
  | { type: "PLAN"; destination: string; amount: string }
  | { type: "BROADCAST"; intent: "payjoin" | "simple-send"; destination: string; amount: string }
  | { type: "SAVE_CHAIN"; chain: ChainConfig }
  | { type: "LOAD_CHAIN" }
  | { type: "SET_BIRTHDAY"; birthday: number }
  | { type: "FOLLOW_TIP" }
  | { type: "OFFER_PAYJOIN"; amount: string }
  | { type: "SERVICE_PAYJOIN" };

chrome.runtime.onMessage.addListener((msg: Msg, sender, send) => {
  const reply = (payload: { ok: boolean; data?: unknown; error?: string }): void => {
    send(jsonSafe(payload));
  };
  void (async () => {
    try {
      if (sender.id !== chrome.runtime.id) {
        reply({ ok: false, error: "forbidden" });
        return;
      }
      await wallet.loadChain();
      switch (msg.type) {
        case "STATE":
          reply({ ok: true, data: await wallet.state() });
          break;
        case "CREATE": {
          const mnemonic = await wallet.create(msg);
          reply({ ok: true, data: { mnemonic } });
          break;
        }
        case "RESTORE":
          await wallet.restore(msg);
          reply({ ok: true });
          break;
        case "UNLOCK":
          await wallet.unlock(msg.password);
          reply({ ok: true, data: await wallet.state() });
          break;
        case "LOCK":
          await wallet.lock();
          reply({ ok: true });
          break;
        case "SCAN": {
          const progress = await wallet.scanOnce();
          reply({ ok: true, data: { ...(await wallet.state()), progress } });
          break;
        }
        case "TIP":
          reply({ ok: true, data: await wallet.source().getTip() });
          break;
        case "PLAN": {
          const data = await wallet.plan(msg.destination, BigInt(msg.amount || "0"));
          reply({ ok: true, data });
          break;
        }
        case "BROADCAST": {
          const built = await wallet.planSend(msg.destination, BigInt(msg.amount || "0"));
          const intent = msg.intent === "payjoin" ? INTENT_PAYJOIN : INTENT_SIMPLE_SEND;
          const result = await wallet.broadcast(intent, built);
          if (result.kind === "payjoin-pending") schedulePayjoinWake();
          reply({
            ok: true,
            data: {
              ...(result.kind === "txid" ? { txid: result.txid } : { pending: true }),
              ...(await wallet.state()),
            },
          });
          break;
        }
        case "SAVE_CHAIN":
          await wallet.saveChain(msg.chain);
          reply({ ok: true });
          break;
        case "LOAD_CHAIN":
          reply({ ok: true, data: redactChain(await wallet.loadChain()) });
          break;
        case "SET_BIRTHDAY":
          await wallet.setBirthday(msg.birthday);
          reply({ ok: true, data: await wallet.state() });
          break;
        case "FOLLOW_TIP": {
          const progress = await wallet.followTip();
          reply({ ok: true, data: { ...(await wallet.state()), progress } });
          break;
        }
        case "OFFER_PAYJOIN": {
          const session = await wallet.offerPayjoin(BigInt(msg.amount || "0"));
          schedulePayjoinWake();
          void pumpPayjoin();
          reply({ ok: true, data: { session, ...(await wallet.state()) } });
          break;
        }
        case "SERVICE_PAYJOIN": {
          const serviced = await wallet.servicePayjoin();
          reply({ ok: true, data: { ...serviced, ...(await wallet.state()) } });
          break;
        }
        default:
          reply({ ok: false, error: "unknown" });
      }
    } catch (e) {
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true;
});
