/**
 * Content script (isolated world). Relays requests from the page provider to the background
 * over a port and passes answers and events back. It reads nothing from the page and adds
 * nothing to it; the background takes the origin from the browser, not from here.
 */
(() => {
  const PORT = "pb-dapp";
  const ORIGIN = location.origin;
  let port: chrome.runtime.Port | null = null;
  const inflight = new Set<number>();

  function toPage(msg: Record<string, unknown>): void {
    window.postMessage({ ...msg, target: "privatebit-page" }, ORIGIN);
  }

  function open(): chrome.runtime.Port {
    if (port) return port;
    const p = chrome.runtime.connect({ name: PORT });
    p.onMessage.addListener((m: { id?: number; event?: string }) => {
      if (typeof m?.id === "number") inflight.delete(m.id);
      toPage(m as Record<string, unknown>);
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      // The service worker restarted or the extension reloaded: fail what was waiting.
      for (const id of inflight) toPage({ id, error: { code: 4900, message: "PrivateBit restarted, try again" } });
      inflight.clear();
    });
    port = p;
    return p;
  }

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window || e.origin !== ORIGIN) return;
    const d = e.data as { target?: string; id?: unknown; method?: unknown; params?: unknown } | null;
    if (!d || d.target !== "privatebit-cs" || typeof d.id !== "number") return;
    try {
      inflight.add(d.id);
      open().postMessage({ id: d.id, method: d.method, params: d.params });
    } catch {
      inflight.delete(d.id);
      toPage({ id: d.id, error: { code: 4900, message: "PrivateBit is not available" } });
    }
  });

  // Connect once so pages hear accountsChanged after they connect, without polling.
  try {
    open();
  } catch {
    /* extension context gone */
  }
})();
