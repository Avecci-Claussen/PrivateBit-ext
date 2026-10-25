/**
 * Website connections, background side.
 *
 * Pages talk to the content script, which relays over a runtime port named DAPP_PORT. The origin
 * is taken from the browser (port.sender), never from the page. Nothing about the wallet is
 * answered before the user approves the site in a popup. A site only sees its own account.
 */
import { DAPP_PORT, DappError, ERR, NEEDS_APPROVAL, parseEnvelope, parseRequest, RateLimit, type DappRequest } from "../lib/dapp-proto.ts";
import { chainInfo, cleartextAllowed, normalizeOrigin, parsePsbt, siteHost, type PsbtReview } from "../lib/sites.ts";
import type { NetworkId } from "../lib/network.ts";
import type { PrivateBit } from "../lib/wallet.ts";
import { hex } from "../lib/bytes.ts";

export type DappDeps = {
  wallet: PrivateBit;
  /** Same path as the Settings chain switch. */
  switchNetwork: (net: NetworkId) => Promise<void>;
  /** Rejections within 2 minutes before a site has to wait (L10). The e2e build raises it. */
  rejectLimit?: number;
};

type Pending = {
  id: string;
  origin: string;
  req: DappRequest;
  port: chrome.runtime.Port;
  resolve: (v: unknown) => void;
  reject: (e: DappError) => void;
  windowId?: number;
  createdAt: number;
  /** The exact payment shown in the review. Approve broadcasts this one, never a new plan. */
  sendTx?: string;
  sendView?: PendingView["send"];
  /** The chain the payment was planned on. */
  sendNet?: NetworkId;
};

export type PendingView = {
  id: string;
  origin: string;
  host: string;
  method: DappRequest["method"];
  chain: { id: NetworkId; name: string };
  unlocked: boolean;
  address?: string;
  connected?: boolean;
  balance?: number;
  message?: { text: string; type: string };
  psbts?: PsbtReview[];
  send?: { to: string; amount: string; fee: string; change: string; memos: string[]; feeRate: number; error?: string };
  switchTo?: { id: NetworkId; name: string };
};

const UNLOCK_WAIT_MS = 5 * 60_000;

/**
 * Audit M7 (independent): which websites can see PrivateBit at all. The page provider is added
 * only to these origins (or to every site when the user chose that), so other sites, trackers and
 * ads cannot tell PrivateBit is installed. Kept outside the sealed data so it works while locked.
 */
export const VISIBLE_KEY = "privatebit.dapp.visible";
export type Visibility = { all: boolean; origins: string[] };

export async function loadVisibility(): Promise<Visibility> {
  const got = (await chrome.storage.local.get([VISIBLE_KEY]))[VISIBLE_KEY] as Partial<Visibility> | undefined;
  return { all: got?.all === true, origins: Array.isArray(got?.origins) ? got!.origins.filter((o) => typeof o === "string") : [] };
}

export async function saveVisibility(v: Visibility): Promise<void> {
  await chrome.storage.local.set({ [VISIBLE_KEY]: { all: v.all, origins: [...new Set(v.origins)].sort() } });
}

export async function showToOrigins(origins: string[]): Promise<void> {
  const v = await loadVisibility();
  const next = [...new Set([...v.origins, ...origins.map((o) => normalizeOrigin(o))])];
  if (next.length !== v.origins.length) await saveVisibility({ ...v, origins: next });
}

export async function hideFromOrigin(origin: string): Promise<void> {
  const v = await loadVisibility();
  const o = normalizeOrigin(origin);
  if (v.origins.includes(o)) await saveVisibility({ ...v, origins: v.origins.filter((x) => x !== o) });
}

/** Add the page provider to one document. No-op where the browser has no scripting API (the phone app). */
export async function injectProvider(target: { tabId: number; documentId?: string }): Promise<boolean> {
  const scripting = (chrome as { scripting?: typeof chrome.scripting }).scripting;
  if (!scripting?.executeScript) return false;
  try {
    await scripting.executeScript({
      target: target.documentId ? { tabId: target.tabId, documentIds: [target.documentId] } : { tabId: target.tabId, frameIds: [0] },
      world: "MAIN" as chrome.scripting.ExecutionWorld,
      files: ["inpage.js"],
      injectImmediately: true,
    });
    return true;
  } catch {
    return false;
  }
}
const chainName = (n: NetworkId): string => chainInfo(n).name.replace(" Mainnet", "");

export function installDapp(deps: DappDeps) {
  const { wallet } = deps;
  const ports = new Map<chrome.runtime.Port, { origin: string; last?: string; lastChain?: string }>();
  const pending = new Map<string, Pending>();
  const rate = new RateLimit(30, 10_000);
  // Audit L1 (independent): relaying is cheap to abuse, so it gets its own, tighter limit.
  const pushRate = new RateLimit(5, 60_000);
  // Audit L10 (independent): after several rejections in a row a site waits before it can ask again.
  const rejects = new Map<string, number[]>();
  const REJECT_LIMIT = deps.rejectLimit ?? 3;
  const REJECT_WINDOW_MS = 2 * 60_000;
  const REJECT_COOLDOWN_MS = 60_000;
  function noteReject(origin: string): void {
    const now = Date.now();
    rejects.set(origin, [...(rejects.get(origin) ?? []).filter((t) => now - t < REJECT_WINDOW_MS), now]);
  }
  function coolingDown(origin: string): boolean {
    const now = Date.now();
    const l = (rejects.get(origin) ?? []).filter((t) => now - t < REJECT_WINDOW_MS);
    return l.length >= REJECT_LIMIT && now - l[l.length - 1] < REJECT_COOLDOWN_MS;
  }
  let unlockWaiters: (() => void)[] = [];

  const unlocked = async (): Promise<boolean> => !!(await wallet.dataKey().catch(() => null));

  function waitUnlock(): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        unlockWaiters = unlockWaiters.filter((f) => f !== done);
        reject(new DappError(ERR.disconnected, "PrivateBit is locked"));
      }, UNLOCK_WAIT_MS);
      const done = (): void => {
        clearTimeout(t);
        resolve();
      };
      unlockWaiters.push(done);
    });
  }

  async function connected(origin: string): Promise<boolean> {
    return !!(await wallet.siteRecord(origin))?.connected;
  }

  async function accountsFor(origin: string): Promise<string[]> {
    if (!(await unlocked())) return [];
    if (!(await connected(origin))) return [];
    const { key } = await wallet.siteKey(origin);
    return [key.address];
  }

  /** Locked: wait. Not connected: refuse. */
  async function requireConnected(origin: string): Promise<void> {
    if (!(await unlocked())) await waitUnlock();
    if (!(await connected(origin))) throw new DappError(ERR.unauthorized, "connect first with requestAccounts");
  }

  function post(port: chrome.runtime.Port, msg: unknown): void {
    try {
      port.postMessage(msg);
    } catch {
      ports.delete(port);
    }
  }

  /** Audit L4 (independent): a random delay per page so sites cannot line up the exact moment of a lock or unlock. */
  function postLater(port: chrome.runtime.Port, msg: unknown): void {
    const ms = crypto.getRandomValues(new Uint16Array(1))[0] % 1000;
    setTimeout(() => post(port, msg), ms);
  }

  /** accountsChanged / chainChanged / networkChanged to every page that should hear it. */
  async function refreshEvents(): Promise<void> {
    const isOpen = await unlocked();
    if (isOpen) {
      const ws = unlockWaiters;
      unlockWaiters = [];
      for (const f of ws) f();
    }
    for (const [port, st] of ports) {
      const accounts = isOpen ? await accountsFor(st.origin).catch(() => []) : [];
      const a = JSON.stringify(accounts);
      if (st.last !== undefined && st.last !== a) postLater(port, { target: "privatebit-page", event: "accountsChanged", data: accounts });
      st.last = a;
      if (!accounts.length) continue;
      const ch = chainInfo(wallet.net);
      if (st.lastChain !== undefined && st.lastChain !== ch.enum) {
        postLater(port, { target: "privatebit-page", event: "chainChanged", data: ch });
        postLater(port, { target: "privatebit-page", event: "networkChanged", data: ch.network });
      }
      st.lastChain = ch.enum;
    }
  }

  function closeWindow(p: Pending): void {
    if (p.windowId !== undefined) chrome.windows.remove(p.windowId).catch(() => undefined);
  }

  function settle(id: string, err?: DappError, value?: unknown): void {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (err) p.reject(err);
    else p.resolve(value);
    closeWindow(p);
  }

  async function ask(origin: string, req: DappRequest, port: chrome.runtime.Port): Promise<unknown> {
    for (const p of pending.values()) if (p.origin === origin) throw new DappError(ERR.busy, "a request from this site is already waiting for you");
    if (coolingDown(origin)) throw new DappError(ERR.busy, "you rejected several requests from this site, try again in a minute");
    const id = hex(crypto.getRandomValues(new Uint8Array(12)));
    return new Promise((resolve, reject) => {
      const p: Pending = { id, origin, req, port, resolve, reject, createdAt: Date.now() };
      pending.set(id, p);
      void chrome.windows
        .create({ url: chrome.runtime.getURL(`popup.html#dapp=${id}`), type: "popup", width: 380, height: 640, focused: true })
        .then((w) => {
          if (!pending.has(id)) {
            if (w?.id !== undefined) chrome.windows.remove(w.id).catch(() => undefined);
            return;
          }
          p.windowId = w?.id;
        })
        .catch(() => settle(id, new DappError(ERR.internal, "could not open the approval window")));
    });
  }

  async function handleRequest(origin: string, req: DappRequest, port: chrome.runtime.Port): Promise<unknown> {
    switch (req.method) {
      case "getAccounts":
        return accountsFor(origin);
      case "disconnect":
        if (await unlocked()) await wallet.disconnectSite(origin);
        await refreshEvents();
        return true;
      case "requestAccounts": {
        if ((await unlocked()) && (await connected(origin))) return accountsFor(origin);
        await ask(origin, req, port);
        return accountsFor(origin);
      }
      default:
        break;
    }
    // Locked: a request that needs approval opens its window now, which asks to unlock first.
    if (NEEDS_APPROVAL.has(req.method) && req.method !== "switchNetwork" && !(await unlocked())) return ask(origin, req, port);
    await requireConnected(origin);
    switch (req.method) {
      case "getNetwork":
        return chainInfo(wallet.net).network;
      case "getChain":
        return chainInfo(wallet.net);
      case "getPublicKey":
        return (await wallet.siteKey(origin)).key.publicKey;
      case "getBalance":
        return wallet.siteBalance((await wallet.siteKey(origin)).key.index);
      case "getInscriptions":
        // 1.0.0 does not read inscriptions (planned for 1.0.1). Saying "none" could make a site
        // treat an inscribed coin as plain, so this is a clear refusal instead of an empty list.
        throw new DappError(ERR.unsupported, "PrivateBit 1.0.0 does not read inscriptions or runes");
      case "pushTx":
        if (!pushRate.take(origin)) throw new DappError(ERR.busy, "too many transactions, slow down");
        return wallet.siteBroadcast(origin, req.rawtx);
      case "pushPsbt": {
        if (!pushRate.take(origin)) throw new DappError(ERR.busy, "too many transactions, slow down");
        const tx = parsePsbt(req.psbt);
        let raw: string;
        try {
          raw = hex(tx.extract());
        } catch {
          throw new DappError(ERR.invalid, "PSBT is not finalized");
        }
        return wallet.siteBroadcast(origin, raw);
      }
      case "switchNetwork":
        return "livenet";
      case "switchChain":
        if (req.chain === wallet.net) return chainInfo(wallet.net);
        return ask(origin, req, port);
      case "signMessage":
      case "signPsbt":
      case "signPsbts":
      case "sendBitcoin":
        return ask(origin, req, port);
      default:
        throw new DappError(ERR.unsupported, "not supported");
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== DAPP_PORT) return;
    const s = port.sender;
    // Only our own content script, in a top-level tab frame, on an http(s) page.
    if (!s || s.id !== chrome.runtime.id || !s.tab || (s.frameId ?? 0) !== 0) {
      port.disconnect();
      return;
    }
    let origin: string;
    try {
      origin = normalizeOrigin(s.origin ?? new URL(s.url ?? "").origin);
      // Audit L11 (independent): plain http only for this computer or the local network.
      if (origin.startsWith("http:") && !cleartextAllowed(new URL(origin).hostname)) throw new Error("http");
    } catch {
      port.disconnect();
      return;
    }
    const st: { origin: string; last?: string; lastChain?: string } = { origin };
    ports.set(port, st);
    const tabId = s.tab.id;
    const documentId = (s as { documentId?: string }).documentId;
    if (tabId !== undefined) {
      void loadVisibility().then((v) => (v.all || v.origins.includes(origin) ? injectProvider({ tabId, documentId }) : false));
    }
    void accountsFor(origin)
      .catch(() => [])
      .then((a) => {
        st.last = JSON.stringify(a);
        st.lastChain = chainInfo(wallet.net).enum;
      });
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      for (const p of [...pending.values()]) if (p.port === port) settle(p.id, new DappError(ERR.rejected, "the page was closed"));
    });
    port.onMessage.addListener((raw: unknown) => {
      const env = parseEnvelope(raw);
      if (!env) return;
      const reply = (body: { result?: unknown; error?: { code: number; message: string } }): void => post(port, { target: "privatebit-page", id: env.id, ...body });
      if (!rate.take(origin)) {
        reply({ error: { code: ERR.busy, message: "too many requests, slow down" } });
        return;
      }
      void (async () => {
        try {
          const req = parseRequest(env.method, env.params);
          const result = await handleRequest(origin, req, port);
          reply({ result });
        } catch (e) {
          const err = e instanceof DappError ? e : new DappError(ERR.internal, e instanceof Error ? e.message : String(e));
          reply({ error: { code: err.code, message: err.message } });
        }
      })();
    });
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    for (const p of [...pending.values()]) if (p.windowId === windowId) settle(p.id, new DappError(ERR.rejected, "you closed the request"));
  });

  async function feeRateFor(req: { feeRate?: number }): Promise<number> {
    if (req.feeRate) return req.feeRate;
    try {
      return (await wallet.feeRates()).normal || 2;
    } catch {
      return 2;
    }
  }

  /** What the approval popup shows. Computed when the user looks, after unlock. */
  async function view(id: string): Promise<PendingView> {
    const p = pending.get(id);
    if (!p) throw new Error("This request is no longer waiting. It was answered, or the page closed it.");
    const net = wallet.net;
    const base: PendingView = { id, origin: p.origin, host: siteHost(p.origin), method: p.req.method, chain: { id: net, name: chainName(net) }, unlocked: await unlocked() };
    if (!base.unlocked) return base;
    const rec = await wallet.siteRecord(p.origin);
    base.connected = !!rec?.connected;
    if (p.req.method === "requestAccounts") return base;
    if (!base.connected) {
      settle(id, new DappError(ERR.unauthorized, "connect first with requestAccounts"));
      throw new Error("This site is not connected. Nothing was signed.");
    }
    const { key } = await wallet.siteKey(p.origin);
    base.address = key.address;
    base.balance = (await wallet.siteBalance(key.index)).total;
    const r = p.req;
    if (r.method === "signMessage") base.message = { text: r.text, type: r.type };
    if (r.method === "signPsbt") base.psbts = [await wallet.siteReviewPsbt(p.origin, r.psbt, r.options)];
    if (r.method === "signPsbts") base.psbts = await Promise.all(r.psbts.map((x, i) => wallet.siteReviewPsbt(p.origin, x, r.options[i]!)));
    if (r.method === "switchChain") base.switchTo = { id: r.chain, name: chainName(r.chain) };
    if (r.method === "sendBitcoin") {
      // Planned once per request, so every look at the review shows the payment approve sends.
      if (!p.sendView) {
        const feeRate = await feeRateFor(r);
        try {
          const plan = await wallet.sitePlanSend(p.origin, r.to, r.sats, feeRate, r.memos);
          p.sendTx = plan.txHex;
          p.sendNet = net;
          p.sendView = { to: r.to, amount: plan.amount, fee: plan.fee, change: plan.change, memos: r.memos, feeRate };
        } catch (e) {
          p.sendTx = undefined;
          base.send = { to: r.to, amount: String(r.sats), fee: "0", change: "0", memos: r.memos, feeRate, error: e instanceof Error ? e.message : String(e) };
          return base;
        }
      }
      base.send = p.sendView;
    }
    return base;
  }

  async function decide(id: string, approve: boolean): Promise<unknown> {
    const p = pending.get(id);
    if (!p) throw new Error("This request is no longer waiting.");
    if (!approve) {
      noteReject(p.origin);
      settle(id, new DappError(ERR.rejected, "you rejected the request"));
      return { done: true };
    }
    if (!(await unlocked())) throw new Error("Unlock first");
    const r = p.req;
    try {
      let value: unknown;
      switch (r.method) {
        case "requestAccounts":
          await wallet.connectSite(p.origin);
          await showToOrigins([p.origin]).catch(() => undefined);
          value = true;
          break;
        case "signMessage":
          value = await wallet.siteSignMessage(p.origin, r.text, r.type);
          break;
        case "signPsbt":
          value = await wallet.siteSignPsbt(p.origin, r.psbt, r.options);
          break;
        case "signPsbts": {
          const out: string[] = [];
          for (let i = 0; i < r.psbts.length; i++) out.push(await wallet.siteSignPsbt(p.origin, r.psbts[i]!, r.options[i]!));
          value = out;
          break;
        }
        case "sendBitcoin": {
          // Audit F-03: send exactly what the review showed (same coins, fee and outputs).
          if (!p.sendTx) throw new Error("Nothing was sent. Review the payment first.");
          if (p.sendNet !== wallet.net) throw new Error("Nothing was sent. The chain changed after the review.");
          value = await wallet.siteBroadcast(p.origin, p.sendTx);
          break;
        }
        case "switchChain":
          await deps.switchNetwork(r.chain);
          value = chainInfo(r.chain);
          break;
        default:
          throw new Error("nothing to approve");
      }
      settle(id, undefined, value);
      void refreshEvents();
      return { done: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      settle(id, new DappError(ERR.internal, msg));
      throw e;
    }
  }

  return {
    view,
    decide,
    refreshEvents,
    async disconnect(origin: string) {
      await wallet.disconnectSite(origin);
      await refreshEvents();
    },
    /** For tests and Settings: how many pages are listening. */
    portCount: () => ports.size,
  };
}
