/**
 * Page-side provider, injected into the page's own JavaScript world. It holds no keys and no
 * wallet data: every call is a message to the content script, which relays it to PrivateBit.
 * Exposed as window.privatebit, plus the common Bitcoin wallet name dApps already look for
 * (only when no other wallet has taken it).
 */
type Listener = (data: unknown) => void;

(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w.privatebit) return;
  const ORIGIN = location.origin;
  let seq = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<string, Set<Listener>>();

  class ProviderError extends Error {
    code: number;
    constructor(code: number, message: string) {
      super(message);
      this.code = code;
    }
  }

  function call(method: string, params: unknown[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      window.postMessage({ target: "privatebit-cs", id, method, params }, ORIGIN);
    });
  }

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window || e.origin !== ORIGIN) return;
    const d = e.data as { target?: string; id?: number; result?: unknown; error?: { code: number; message: string }; event?: string; data?: unknown } | null;
    if (!d || d.target !== "privatebit-page") return;
    if (typeof d.event === "string") {
      for (const fn of listeners.get(d.event) ?? []) {
        try {
          fn(d.data);
        } catch {
          /* a page listener threw */
        }
      }
      return;
    }
    if (typeof d.id !== "number") return;
    const p = waiting.get(d.id);
    if (!p) return;
    waiting.delete(d.id);
    if (d.error) p.reject(new ProviderError(d.error.code, d.error.message));
    else p.resolve(d.result);
  });

  const provider = Object.freeze({
    isPrivateBit: true,
    requestAccounts: () => call("requestAccounts"),
    getAccounts: () => call("getAccounts"),
    getNetwork: () => call("getNetwork"),
    switchNetwork: (network: string) => call("switchNetwork", [network]),
    getChain: () => call("getChain"),
    switchChain: (chain: string) => call("switchChain", [chain]),
    getPublicKey: () => call("getPublicKey"),
    getBalance: () => call("getBalance"),
    getInscriptions: (cursor?: number, size?: number) => call("getInscriptions", [cursor, size]),
    signMessage: (text: string, type?: string) => call("signMessage", [text, type]),
    signPsbt: (psbtHex: string, options?: unknown) => call("signPsbt", [psbtHex, options]),
    signPsbts: (psbtHexs: string[], options?: unknown[]) => call("signPsbts", [psbtHexs, options]),
    pushPsbt: (psbtHex: string) => call("pushPsbt", [psbtHex]),
    pushTx: (arg: { rawtx: string } | string) => call("pushTx", [arg]),
    sendBitcoin: (to: string, satoshis: number, options?: unknown) => call("sendBitcoin", [to, satoshis, options]),
    disconnect: () => call("disconnect"),
    request: (method: string, params?: unknown[]) => call(method, params ?? []),
    on(event: string, fn: Listener) {
      if (typeof fn !== "function") return provider;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return provider;
    },
    removeListener(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
      return provider;
    },
    off(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
      return provider;
    },
  });

  Object.defineProperty(window, "privatebit", { value: provider, writable: false, configurable: false, enumerable: true });
  // Compatibility name used by Fractal and Bitcoin dApps. Left alone if another wallet set it.
  const ALIAS = "unisat";
  if (!(ALIAS in window)) Object.defineProperty(window, ALIAS, { value: provider, writable: true, configurable: true, enumerable: true });
  window.dispatchEvent(new Event("privatebit#initialized"));
})();
