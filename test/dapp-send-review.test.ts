import { describe, expect, it } from "vitest";
import { installDapp } from "../src/dapp/background-dapp.ts";
import { DAPP_PORT } from "../src/lib/dapp-proto.ts";
import type { PrivateBit } from "../src/lib/wallet.ts";

type L = (...a: any[]) => void;
function setup() {
  let onConnect: L = () => undefined;
  const created: string[] = [];
  (globalThis as any).chrome = {
    runtime: { id: "pbid", getURL: (p: string) => `chrome-extension://pbid/${p}`, onConnect: { addListener: (f: L) => (onConnect = f) } },
    windows: { create: async (o: { url: string }) => (created.push(o.url), { id: created.length }), remove: async () => undefined, onRemoved: { addListener: () => undefined } },
    storage: { local: { get: async () => ({}), set: async () => undefined } },
  };
  let plans = 0;
  const sent: string[] = [];
  const wallet = {
    net: "bitcoin",
    dataKey: async () => new Uint8Array(32),
    siteRecord: async () => ({ connected: true }),
    siteKey: async () => ({ key: { address: "bc1pself", index: 0, publicKey: "02" } }),
    siteBalance: async () => ({ total: 50000 }),
    feeRates: async () => ({ normal: 3 }),
    sitePlanSend: async () => {
      plans++;
      return { txHex: `tx${plans}`, amount: "1000", fee: String(200 + plans), change: "100" };
    },
    siteBroadcast: async (_o: string, raw: string) => (sent.push(raw), "txid-" + raw),
  };
  const api = installDapp({ wallet: wallet as unknown as PrivateBit, switchNetwork: async () => undefined });
  const msgs: any[] = [];
  let onMsg: L = () => undefined;
  const port = {
    name: DAPP_PORT,
    sender: { id: "pbid", tab: { id: 1 }, frameId: 0, origin: "https://shop.example" },
    postMessage: (m: unknown) => msgs.push(m),
    onDisconnect: { addListener: () => undefined },
    onMessage: { addListener: (f: L) => (onMsg = f) },
    disconnect: () => undefined,
  };
  onConnect(port);
  const pendingId = async (): Promise<string> => {
    for (let i = 0; i < 50 && !created.length; i++) await new Promise((r) => setTimeout(r, 5));
    return created[created.length - 1]!.split("#dapp=")[1]!;
  };
  return { api, wallet, sent, msgs, send: (m: unknown) => onMsg(m), pendingId, plans: () => plans };
}

describe("audit F-03: a site payment sends exactly what the review showed", () => {
  it("plans once and approve broadcasts that same transaction", async () => {
    const t = setup();
    t.send({ id: 1, method: "sendBitcoin", params: ["bc1qdest", 1000] });
    const id = await t.pendingId();
    const v1 = await t.api.view(id);
    const v2 = await t.api.view(id);
    expect(v1.send).toEqual(v2.send);
    expect(t.plans()).toBe(1);
    await t.api.decide(id, true);
    expect(t.sent).toEqual(["tx1"]);
  });

  it("does not send when the chain changed after the review", async () => {
    const t = setup();
    t.send({ id: 2, method: "sendBitcoin", params: ["bc1qdest", 1000] });
    const id = await t.pendingId();
    await t.api.view(id);
    t.wallet.net = "fractal";
    await expect(t.api.decide(id, true)).rejects.toThrow(/chain changed/);
    expect(t.sent).toEqual([]);
  });

  it("does not send a payment that was never reviewed", async () => {
    const t = setup();
    t.send({ id: 3, method: "sendBitcoin", params: ["bc1qdest", 1000] });
    const id = await t.pendingId();
    await expect(t.api.decide(id, true)).rejects.toThrow(/Review the payment first/);
    expect(t.sent).toEqual([]);
  });

  it("refuses ports from frames or from outside a tab", () => {
    let onConnect: L = () => undefined;
    (globalThis as any).chrome = { runtime: { id: "pbid", getURL: (p: string) => p, onConnect: { addListener: (f: L) => (onConnect = f) } }, windows: { onRemoved: { addListener: () => undefined } } };
    const api = installDapp({ wallet: {} as PrivateBit, switchNetwork: async () => undefined });
    let cut = 0;
    const mk = (sender: object) => ({ name: DAPP_PORT, sender, disconnect: () => cut++, onDisconnect: { addListener: () => undefined }, onMessage: { addListener: () => undefined } });
    onConnect(mk({ id: "pbid", tab: { id: 1 }, frameId: 3, origin: "https://a.example" }));
    onConnect(mk({ id: "pbid", origin: "https://a.example" }));
    onConnect(mk({ id: "other", tab: { id: 1 }, frameId: 0, origin: "https://a.example" }));
    expect(cut).toBe(3);
    expect(api.portCount()).toBe(0);
  });
});

describe("independent audit L10: rejection cooldown", () => {
  it("after three rejections the site waits before it can ask again", async () => {
    const t = setup();
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      t.send({ id: 10 + i, method: "sendBitcoin", params: ["bc1qdest", 1000] });
      for (let k = 0; k < 50; k++) {
        await new Promise((r) => setTimeout(r, 5));
        const id = await t.pendingId();
        if (!created.includes(id)) { created.push(id); break; }
      }
      await t.api.decide(created[created.length - 1]!, false);
    }
    t.send({ id: 20, method: "sendBitcoin", params: ["bc1qdest", 1000] });
    for (let k = 0; k < 50 && !t.msgs.some((m) => m.id === 20); k++) await new Promise((r) => setTimeout(r, 5));
    const r = t.msgs.find((m) => m.id === 20);
    expect(r?.error?.message).toMatch(/try again in a minute/);
  });
});
