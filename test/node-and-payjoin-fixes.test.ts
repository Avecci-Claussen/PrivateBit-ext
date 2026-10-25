// Own node answers in plain words, cookie paste, txindex check; BIP77 reply mailbox; network table.
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkNode, NodeError, parseCookie, readRpcBody, withSendRoute, openChain } from "../src/lib/chain.ts";
import { replyMailboxUrl, mailboxShortId, ohttpRelayTransport, MAILBOX_EMPTY } from "../src/lib/mailbox.ts";
import { genOhttpKeyPair } from "../src/lib/ohttp.ts";
import { derivationPath, migrateChainConfig, NETWORKS, redactChain, splitChainSecrets } from "../src/lib/network.ts";
import { netKeyName, netKv, WALLET_SCOPED } from "../src/lib/layout.ts";
import { memoryKv } from "../src/lib/vault.ts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { resetNetForTests } from "../src/lib/net.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("own node answers", () => {
  it("401 and 403 say the username or password was rejected", async () => {
    await expect(readRpcBody(new Response("", { status: 401 }))).rejects.toThrow("Your node rejected the username or password.");
    await expect(readRpcBody(new Response("Forbidden", { status: 403 }))).rejects.toThrow(/rejected the username/);
  });
  it("empty and non JSON bodies are explained", async () => {
    await expect(readRpcBody(new Response("", { status: 200 }))).rejects.toThrow(/empty answer/);
    await expect(readRpcBody(new Response("<html>hi</html>", { status: 200 }))).rejects.toThrow(/did not answer like a Bitcoin node/);
    await expect(readRpcBody(new Response("", { status: 500 }))).rejects.toThrow(/error 500/);
  });
  it("RPC errors come through, warmup is named", async () => {
    await expect(readRpcBody(json({ result: null, error: { code: -28, message: "Loading block index" } }, 500))).rejects.toThrow(/still starting/);
    await expect(readRpcBody(json({ result: null, error: { code: -5, message: "No such mempool tx" } }, 500))).rejects.toThrow("No such mempool tx");
    expect(await readRpcBody(json({ result: 5, error: null }))).toBe(5);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetNetForTests();
  });

  it("an unreachable port and a timeout get their own messages", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const e = await checkNode({ url: "http://127.0.0.1:8332" }).catch((x) => x);
    expect(e).toBeInstanceOf(NodeError);
    expect((e as NodeError).code).toBe("unreachable");
    expect((e as Error).message).toMatch(/could not be reached/);
    resetNetForTests();
    vi.stubGlobal("fetch", async () => {
      const err = new Error("t");
      err.name = "TimeoutError";
      throw err;
    });
    const t = await checkNode({ url: "http://127.0.0.1:8333" }).catch((x) => x);
    expect((t as NodeError).code).toBe("timeout");
  });

  it("checks the chain and whether txindex is on", async () => {
    const answers: Record<string, unknown> = {
      getblockchaininfo: { chain: "main", blocks: 900_100, headers: 900_100 },
      getindexinfo: { txindex: { synced: true, best_block_height: 900_100 } },
    };
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => json({ result: answers[JSON.parse(String(init.body)).method], error: null }));
    expect(await checkNode({ url: "http://127.0.0.1:8332" })).toMatchObject({ chain: "main", height: 900_100, txindex: true });
    resetNetForTests();
    answers.getindexinfo = {};
    expect((await checkNode({ url: "http://127.0.0.1:8334" })).txindex).toBe(false);
  });
});

describe("cookie paste", () => {
  it("reads __cookie__:password", () => {
    expect(parseCookie("__cookie__:0123456789abcdef0123456789abcdef\n")).toEqual({ user: "__cookie__", password: "0123456789abcdef0123456789abcdef" });
  });
  it("refuses anything else", () => {
    expect(parseCookie("alice:hunter2")).toBeNull();
    expect(parseCookie("__cookie__:")).toBeNull();
    expect(parseCookie("")).toBeNull();
  });
});

describe("send route", () => {
  it("public mode with a send node broadcasts only through the node", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      calls.push(`${u} ${JSON.parse(String(init.body)).method}`);
      return json({ result: "aa".repeat(32), error: null });
    });
    const src = withSendRoute(
      { kind: "unisat", getTip: async () => ({ height: 1, hash: "" }), getBlockHash: async () => "", getBlockTxids: async () => [], getTxHex: async () => "", broadcast: async () => { throw new Error("public service must not be used"); }, estimateFeeSatPerVb: async () => 1 },
      { kind: "unisat", url: "x", sendVia: "node", sendNodeUrl: "http://127.0.0.1:8332", sendNodeUser: "u", sendNodePassword: "p" },
    );
    expect(await src.broadcast("00")).toBe("aa".repeat(32));
    expect(calls).toEqual(["http://127.0.0.1:8332 sendrawtransaction"]);
    vi.unstubAllGlobals();
  });
  it("the send node password is a secret: split out and redacted", () => {
    const cfg = migrateChainConfig({ kind: "unisat", url: "https://open-api-fractal.unisat.io", sendVia: "node", sendNodeUrl: "http://127.0.0.1:8332", sendNodePassword: "pw" });
    expect(cfg.sendVia).toBe("node");
    const { plain, secrets } = splitChainSecrets(cfg);
    expect(plain.sendNodePassword).toBeUndefined();
    expect(secrets.sendNodePassword).toBe("pw");
    expect(redactChain(cfg).sendNodePassword).not.toBe("pw");
    expect(migrateChainConfig({ kind: "unisat", sendVia: "node" }).sendVia).toBeUndefined();
  });
  it("Bitcoin public mode reads from the Bitcoin explorer", () => {
    const s = openChain({ kind: "unisat", url: "x" }, "bitcoin");
    expect(s.net).toBe("bitcoin");
    expect(typeof s.blockPrevouts).toBe("function");
  });
});

describe("BIP77 reply mailbox", () => {
  it("the proposal goes to /<reply short id> next to the receiver's mailbox, never /<id>/proposal", () => {
    const pk = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true);
    const url = replyMailboxUrl("https://payjo.in/ABCDEFGH12345#RK1Q-EX1Q", pk);
    expect(url).toBe(`https://payjo.in/${mailboxShortId(pk)}`);
    expect(url).not.toMatch(/proposal/);
  });
  it("a quiet long poll is 'nothing yet', not an error", async () => {
    vi.stubGlobal("fetch", async () => {
      const err = new Error("t");
      err.name = "TimeoutError";
      throw err;
    });
    const t = ohttpRelayTransport(genOhttpKeyPair(1), "https://relay.invalid");
    expect((await t.get("https://payjo.in/ABCDEFGH12345")).status).toBe(MAILBOX_EMPTY);
    await expect(t.post("https://payjo.in/ABCDEFGH12345", "x")).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});

describe("networks", () => {
  it("Fractal key paths are unchanged; Bitcoin uses the standard BIP352 coin type", () => {
    expect(derivationPath(0)).toEqual({ spend: "m/352'/8228'/0'/0'/0", scan: "m/352'/8228'/0'/1'/0" });
    expect(derivationPath(0, "bitcoin")).toEqual({ spend: "m/352'/0'/0'/0'/0", scan: "m/352'/0'/0'/1'/0" });
  });
  it("each chain names itself and keeps plans apart", () => {
    expect(NETWORKS.bitcoin.unit).toBe("BTC");
    expect(NETWORKS.fractal.unit).toBe("FB");
    expect(NETWORKS.bitcoin.planChain).not.toBe(NETWORKS.fractal.planChain);
    expect(NETWORKS.bitcoin.txUrl("ab")).toBe("https://mempool.space/tx/ab");
  });
  it("Bitcoin data lives under its own names; Fractal names are untouched", async () => {
    expect(netKeyName("privatebit.scan", "fractal")).toBe("privatebit.scan");
    expect(netKeyName("privatebit.scan", "bitcoin")).toBe("privatebit.btc.scan");
    expect(netKeyName("privatebit.vault", "bitcoin")).toBe("privatebit.vault");
    for (const k of ["privatebit.btc.scan", "privatebit.btc.history", "privatebit.btc.delayed"]) expect(WALLET_SCOPED as readonly string[]).toContain(k);
    const kv = memoryKv();
    await netKv(kv, "bitcoin").set({ "privatebit.history": 1, "privatebit.vault": 2 });
    expect(await kv.get(["privatebit.btc.history", "privatebit.vault", "privatebit.history"])).toEqual({ "privatebit.btc.history": 1, "privatebit.vault": 2 });
  });
});
