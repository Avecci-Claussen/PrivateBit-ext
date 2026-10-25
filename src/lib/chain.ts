import { fromHex } from "./bytes.ts";
import { netFetch, noteRateLimited } from "./net.ts";
import { rejectAddressUtxoAsSot } from "./policy.ts";
import { DIRECT, fetchVia, parseRecommendedFees, RateLimitedError, type FeeRates, type RequestRoute } from "./requests.ts";
import { FRACTAL, migrateChainConfig, netInfo, publicServiceUrl, type ChainConfig, type ChainKind, type NetworkId } from "./network.ts";
import { effectiveUnisatToken } from "./builtin-key.ts";
import { checkRawBlock } from "./blockparse.ts";
import { verifyHeaderWithProof } from "./headerproof.ts";
import { MEMPOOL_BITCOIN, mempoolBlockHash, mempoolBlockPrevouts, mempoolBlockRaw, mempoolBlockTxids, mempoolBroadcast, mempoolFees, mempoolTip, mempoolTxHex } from "./mempool.ts";

export type Tip = { height: number; hash: string };

export type ChainSource = {
  kind: ChainKind;
  getTip(): Promise<Tip>;
  getBlockHash(height: number): Promise<string>;
  /** Raw block bytes, when the source can return a whole block. */
  getBlockRaw?(height: number): Promise<Uint8Array>;
  /** Block txids by height. UniSat has no hash-based tx list. */
  getBlockTxids(height: number): Promise<string[]>;
  getTxHex(txid: string): Promise<string>;
  /**
   * Prevout script for each input, from the indexer's paged input list.
   * Avoids downloading every parent transaction. Absent on a node, which parses parent hex.
   */
  listInputScripts?(txid: string): Promise<TxInputScript[]>;
  /** Confirming height when the indexer/node already has this tx in a block. */
  getTxHeight?(txid: string): Promise<number | null>;
  broadcast(txHex: string): Promise<string>;
  estimateFeeSatPerVb(): Promise<number>;
  /** Fee tiers for the picker. Optional so test doubles can omit it. */
  feeRates?(): Promise<FeeRates>;
  /** Which chain this source reads. Missing means Fractal (older test doubles). */
  net?: NetworkId;
  /**
   * Prevout scripts ("txid:vout" to script hex) for the transactions at `indexes` of a block.
   * Bitcoin blocks are big; this replaces thousands of parent lookups with a few pages.
   */
  blockPrevouts?(height: number, hash: string, indexes: number[]): Promise<Record<string, string>>;
};

/** Fee tiers for any source; falls back to one rate for every tier. */
export async function feeRatesOf(source: ChainSource): Promise<FeeRates> {
  if (source.feeRates) return source.feeRates();
  const r = await source.estimateFeeSatPerVb();
  return { fast: r, normal: r, slow: r, minimum: 1, source: "fallback" };
}

/** Methods that look like an address-UTXO index. Calling them is a policy violation. */
export type ForbiddenSot = {
  getAddressUtxos?(address: string): Promise<unknown>;
};

export function assertScanSource(source: ChainSource & ForbiddenSot): ChainSource {
  if (typeof source.getAddressUtxos === "function") {
    rejectAddressUtxoAsSot(source.kind);
  }
  return source;
}

/** Cloudflare 1010 bans generic Node UAs. Extension fetch already sends Chrome. */
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

const PAGE = 200;
/** `/tx/{txid}/ins` accepts this page size. One page covers the 500-input consolidations on Fractal. */
const INS_PAGE = 500;

export type TxInputScript = { txid: string; vout: number; scriptPubKey: string };

/**
 * UniSat `cursor` is the start offset of the page you asked for.
 * The body echoes that same offset. It is not the next page.
 * Advance by the number of rows returned. Stop on a short page or once `total` is covered.
 */
export function nextUnisatOffset(cursor: number, rowCount: number, pageSize: number, total?: number): number | null {
  if (rowCount <= 0) return null;
  const next = cursor + rowCount;
  if (rowCount < pageSize) return null;
  if (total !== undefined && next >= total) return null;
  if (next > 1_000_000) return null;
  return next;
}

export function unisatTotal(data: unknown): number | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const total = (data as { total?: unknown }).total;
  return typeof total === "number" ? total : undefined;
}

type UnisatEnvelope = { code?: number; msg?: string; data?: unknown };

export function unwrapUnisat<T>(body: unknown, path: string): T {
  if (!body || typeof body !== "object") throw new Error(`unisat ${path}: empty`);
  const env = body as UnisatEnvelope;
  if (env.code === -2004 || /request limit/i.test(env.msg ?? "")) {
    throw new RateLimitedError(`unisat ${path}: ${env.msg ?? "rate limited"}`);
  }
  if (env.code !== 0) throw new Error(`unisat ${path}: ${env.msg ?? String(env.code)}`);
  return env.data as T;
}

export function extractUnisatTxids(data: unknown): string[] {
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? ((data as { detail?: unknown }).detail ??
        (data as { list?: unknown }).list ??
        (data as { txs?: unknown }).txs)
      : null;
  if (!Array.isArray(rows)) return [];
  const out: string[] = [];
  for (const row of rows) {
    if (typeof row === "string" && /^[0-9a-fA-F]{64}$/.test(row)) out.push(row);
    else if (row && typeof row === "object" && typeof (row as { txid?: string }).txid === "string") {
      out.push((row as { txid: string }).txid);
    }
  }
  return out;
}

/** Input rows from `/tx/{txid}/ins`. `utxid` is the prevout. `txid` on the row is the spending transaction. */
export function parseUnisatInputs(data: unknown): TxInputScript[] {
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? ((data as { detail?: unknown }).detail ??
        (data as { list?: unknown }).list ??
        (data as { ins?: unknown }).ins)
      : null;
  if (!Array.isArray(rows)) return [];
  const out: TxInputScript[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as { utxid?: string; vout?: number; scriptPk?: string };
    if (typeof r.utxid !== "string" || !/^[0-9a-fA-F]{64}$/.test(r.utxid)) continue;
    if (typeof r.vout !== "number" || typeof r.scriptPk !== "string" || r.scriptPk.length < 4) continue;
    out.push({ txid: r.utxid, vout: r.vout, scriptPubKey: r.scriptPk });
  }
  return out;
}

/** Without a key the service answers 403 with code -2004 once its limit is hit. */
async function throwUnisatHttp(res: Response, url: string): Promise<never> {
  if (res.status === 429) {
    noteRateLimited(url);
    throw new RateLimitedError(`${url} 429`);
  }
  const body = await res.json().catch(() => null);
  try {
    if (body && typeof body === "object") unwrapUnisat<unknown>(body, url);
  } catch (e) {
    if (e instanceof RateLimitedError) noteRateLimited(url);
    throw e;
  }
  throw new Error(`${url} ${res.status}`);
}

async function unisatGet<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await netFetch(url, { headers }, { timeoutMs: 12_000 });
  if (!res.ok) await throwUnisatHttp(res, url);
  try {
    return unwrapUnisat<T>(await res.json(), url);
  } catch (e) {
    if (e instanceof RateLimitedError) noteRateLimited(url);
    throw e;
  }
}

type RpcAuth = { user?: string; password?: string };

/** Plain words for what went wrong talking to the user's own node. */
export class NodeError extends Error {
  constructor(
    message: string,
    readonly code: "auth" | "unreachable" | "timeout" | "not-json" | "http" | "rpc",
  ) {
    super(message);
    this.name = "NodeError";
  }
}

async function rpc(url: string, auth: RpcAuth, method: string, params: unknown[] = []): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth.user) {
    headers.authorization = `Basic ${btoa(`${auth.user}:${auth.password ?? ""}`)}`;
  }
  // Your own node gets a timeout too: a stalled node must not freeze the scan.
  let res: Response;
  try {
    res = await netFetch(
      url,
      { method: "POST", headers, body: JSON.stringify({ jsonrpc: "1.0", id: "privatebit", method, params }) },
      { timeoutMs: method === "getblock" ? 30_000 : 15_000 },
    );
  } catch (e) {
    if (e instanceof RateLimitedError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/timed out/i.test(msg)) throw new NodeError("Your node did not answer in time. Check that it is running and not busy starting up.", "timeout");
    throw new NodeError("Your node could not be reached. Check the address and port, and that the node allows connections from this computer (rpcallowip, rpcbind).", "unreachable");
  }
  return readRpcBody(res);
}

/** Exported for tests: turn a node's HTTP answer into a result or a plain error. */
export async function readRpcBody(res: Response): Promise<unknown> {
  if (res.status === 401 || res.status === 403) throw new NodeError("Your node rejected the username or password.", "auth");
  const text = await res.text().catch(() => "");
  if (!text.trim()) {
    throw new NodeError(res.ok ? "Your node sent an empty answer. Check that the address points to the RPC port." : `Your node answered with error ${res.status} and no details.`, res.ok ? "not-json" : "http");
  }
  let body: { result?: unknown; error?: { message?: string; code?: number } | null };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new NodeError("Your node did not answer like a Bitcoin node. Check that the address points to the RPC port, not a web page.", "not-json");
  }
  if (body && body.error) {
    if (body.error.code === -28) throw new NodeError(`Your node is still starting: ${body.error.message ?? "please wait"}`, "rpc");
    throw new NodeError(body.error.message || `Your node answered with error ${res.status}.`, "rpc");
  }
  if (!res.ok) throw new NodeError(`Your node answered with error ${res.status}.`, "http");
  return body?.result;
}

/** Bitcoin Core writes `__cookie__:password` to its .cookie file. Returns null for anything else. */
export function parseCookie(text: string): { user: string; password: string } | null {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const i = line.indexOf(":");
  if (i <= 0) return null;
  const user = line.slice(0, i);
  const password = line.slice(i + 1);
  if (user !== "__cookie__" || !/^[0-9a-fA-F]{16,}$/.test(password)) return null;
  return { user, password };
}

export type NodeCheck = { height: number; chain: string; txindex: boolean | "unknown"; blocks: number; headers: number };

/**
 * Which chain a node follows. Bitcoin and Fractal share the genesis block and both call
 * themselves "main", so a block only one of them has decides. "behind": the node has not
 * reached that block yet, so it cannot tell.
 */
export async function nodeFollows(cfg: { url: string; rpcUser?: string; rpcPassword?: string }, net: NetworkId): Promise<"yes" | "other" | "behind"> {
  const auth = { user: cfg.rpcUser, password: cfg.rpcPassword };
  const here = netInfo(net).checkpoint;
  const other = netInfo(net === "bitcoin" ? "fractal" : "bitcoin").checkpoint;
  const blocks = Number(((await rpc(cfg.url, auth, "getblockchaininfo")) as { blocks?: number }).blocks ?? 0);
  const hashAt = async (h: number): Promise<string | null> => (blocks >= h ? String(await rpc(cfg.url, auth, "getblockhash", [h])).toLowerCase() : null);
  const mine = await hashAt(here.height);
  if (mine === here.hash) return "yes";
  const theirs = await hashAt(other.height);
  if (theirs === other.hash || (mine !== null && mine !== here.hash)) return "other";
  return "behind";
}

/** Test a node: which chain it is on, how far it is, and whether its transaction index is on. */
export async function checkNode(cfg: { url: string; rpcUser?: string; rpcPassword?: string }): Promise<NodeCheck> {
  const auth = { user: cfg.rpcUser, password: cfg.rpcPassword };
  const info = (await rpc(cfg.url, auth, "getblockchaininfo")) as { chain?: string; blocks?: number; headers?: number };
  let txindex: boolean | "unknown" = "unknown";
  try {
    const idx = (await rpc(cfg.url, auth, "getindexinfo")) as Record<string, { synced?: boolean }> | null;
    txindex = !!idx && typeof idx === "object" && "txindex" in idx ? idx.txindex?.synced !== false : false;
  } catch (e) {
    if (e instanceof NodeError && e.code === "auth") throw e;
    txindex = "unknown";
  }
  const blocks = Number(info?.blocks ?? 0);
  return { height: blocks, blocks, headers: Number(info?.headers ?? blocks), chain: String(info?.chain ?? "unknown"), txindex };
}

export function coreSource(cfg: ChainConfig, net: NetworkId = "fractal"): ChainSource {
  const auth = { user: cfg.rpcUser, password: cfg.rpcPassword };
  return {
    kind: "core",
    async getTip() {
      const height = Number(await rpc(cfg.url, auth, "getblockcount"));
      const hash = String(await rpc(cfg.url, auth, "getblockhash", [height]));
      return { height, hash };
    },
    async getBlockHash(height) {
      return String(await rpc(cfg.url, auth, "getblockhash", [height]));
    },
    async getBlockRaw(height) {
      const hash = String(await rpc(cfg.url, auth, "getblockhash", [height]));
      const raw = fromHex(String(await rpc(cfg.url, auth, "getblock", [hash, 0])));
      // Item 4: the block must be the one asked for and match its merkle root. On Fractal a
      // merge-mined or indexer block's proof is read from the node and verified in full here.
      const kind = checkRawBlock(raw, hash, undefined, net, { ownNode: true });
      if (net === "fractal" && kind && kind !== "legacy") {
        const withProof = fromHex(String(await rpc(cfg.url, auth, "getblockheader", [hash, false, true])));
        verifyHeaderWithProof(withProof, hash);
      }
      return raw;
    },
    async getBlockTxids(height) {
      const hash = String(await rpc(cfg.url, auth, "getblockhash", [height]));
      const block = (await rpc(cfg.url, auth, "getblock", [hash, 1])) as { tx: string[] };
      return block.tx;
    },
    async getTxHex(txid) {
      return String(await rpc(cfg.url, auth, "getrawtransaction", [txid, false]));
    },
    async getTxHeight(txid) {
      const raw = (await rpc(cfg.url, auth, "getrawtransaction", [txid, true])) as {
        blockhash?: string;
        confirmations?: number;
      };
      if (!raw.blockhash || !raw.confirmations) return null;
      const header = (await rpc(cfg.url, auth, "getblockheader", [raw.blockhash])) as { height?: number };
      return typeof header.height === "number" && header.height > 0 ? header.height : null;
    },
    async broadcast(txHex) {
      return String(await rpc(cfg.url, auth, "sendrawtransaction", [txHex]));
    },
    async blockPrevouts(_height, hash) {
      // Bitcoin Core 25 and later list each input's prevout at verbosity 3; no txindex needed.
      const block = (await rpc(cfg.url, auth, "getblock", [hash, 3])) as {
        tx?: { vin?: { txid?: string; vout?: number; prevout?: { scriptPubKey?: { hex?: string } } }[] }[];
      };
      const out: Record<string, string> = {};
      for (const tx of block.tx ?? []) {
        for (const vin of tx.vin ?? []) {
          const spk = vin.prevout?.scriptPubKey?.hex;
          if (vin.txid && typeof vin.vout === "number" && typeof spk === "string") out[`${vin.txid}:${vin.vout}`] = spk.toLowerCase();
        }
      }
      if (Object.keys(out).length === 0 && (block.tx?.length ?? 0) > 1) throw new Error("node did not list prevouts");
      return out;
    },
    async estimateFeeSatPerVb() {
      const r = (await rpc(cfg.url, auth, "estimatesmartfee", [2])) as { feerate?: number };
      if (!r.feerate) return 1;
      return Math.max(1, Math.ceil((r.feerate * 1e8) / 1000));
    },
    async feeRates() {
      const rate = async (target: number): Promise<number | undefined> => {
        const r = (await rpc(cfg.url, auth, "estimatesmartfee", [target])) as { feerate?: number };
        return r.feerate ? Math.max(1, (r.feerate * 1e8) / 1000) : undefined;
      };
      const [f, n, sl] = [await rate(1), await rate(3), await rate(6)];
      const info = (await rpc(cfg.url, auth, "getmempoolinfo")) as { mempoolminfee?: number };
      const minimum = info.mempoolminfee ? Math.max(0.1, (info.mempoolminfee * 1e8) / 1000) : 1;
      const normal = n ?? f ?? sl ?? 1;
      return {
        fast: Math.max(f ?? normal, normal),
        normal,
        slow: Math.min(sl ?? normal, normal),
        minimum: Math.min(minimum, sl ?? normal),
        updatedAt: Date.now(),
        source: "node" as const,
        targets: { fast: 1, normal: 3, slow: 6 },
      };
    },
  };
}

function unisatHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": CHROME_UA,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/**
 * UniSat Open API as a tx/broadcast source. Not an SP index.
 * Address UTXO helpers are intentionally omitted so they cannot become SoT.
 * Block bytes for a scan come from the chain's block explorer, not from here.
 * `net` selects the host: Bitcoin is open-api.unisat.io, Fractal is open-api-fractal.unisat.io.
 */
export function unisatSource(cfg: ChainConfig, route: RequestRoute = DIRECT, net: NetworkId = "fractal"): ChainSource {
  const migrated = migrateChainConfig(cfg, net);
  const root = publicServiceUrl(migrated, net);
  // A built-in test key is for the Fractal host only. A key the user saved is sent to this host.
  const headers = unisatHeaders(effectiveUnisatToken(migrated.unisatToken, root, FRACTAL.defaultUnisat));
  return {
    kind: "unisat",
    net,
    async getTip() {
      const data = await unisatGet<{
        blocks?: number;
        height?: number;
        bestBlockHash?: string;
      }>(`${root}/v1/indexer/blockchain/info`, headers);
      const reported = data.blocks ?? data.height;
      if (typeof reported !== "number") throw new Error("unisat tip");
      for (const height of [reported, reported - 1]) {
        try {
          const block = await unisatGet<{ id?: string; hash?: string }>(
            `${root}/v1/indexer/height/${height}/block`,
            headers,
          );
          return { height, hash: block.id ?? block.hash ?? data.bestBlockHash ?? "" };
        } catch {
          continue;
        }
      }
      throw new Error("unisat tip not indexed");
    },
    async getBlockHash(height) {
      const data = await unisatGet<{ id?: string; hash?: string }>(
        `${root}/v1/indexer/height/${height}/block`,
        headers,
      );
      const hash = data.id ?? data.hash;
      if (!hash) throw new Error("unisat block hash");
      return hash;
    },
    async getBlockTxids(height) {
      let expected: number | undefined;
      let indexed = false;
      try {
        const meta = await unisatGet<{ ntx?: number }>(`${root}/v1/indexer/height/${height}/block`, headers);
        indexed = true;
        expected = typeof meta.ntx === "number" ? meta.ntx : undefined;
      } catch {
        indexed = false;
      }
      if (indexed && expected === 0) return [];
      const txids: string[] = [];
      let cursor = 0;
      for (;;) {
        if (expected !== undefined && txids.length >= expected) break;
        const page = await unisatGet<unknown>(
          `${root}/v1/indexer/block/${height}/txs?cursor=${cursor}&size=${PAGE}`,
          headers,
        );
        const ids = extractUnisatTxids(page);
        if (ids.length === 0) break;
        indexed = true;
        txids.push(...ids);
        const next = nextUnisatOffset(cursor, ids.length, PAGE, expected ?? unisatTotal(page));
        if (next === null) break;
        cursor = next;
      }
      if (!indexed) throw new Error(`unisat block ${height} not indexed yet`);
      return txids;
    },
    async getTxHex(txid) {
      const data = await unisatGet<string | { hex?: string }>(`${root}/v1/indexer/rawtx/${txid}`, headers);
      if (typeof data === "string" && data.length > 8) return data;
      if (data && typeof data === "object" && data.hex) return data.hex;
      throw new Error("unisat rawtx missing");
    },
    async listInputScripts(txid) {
      const out: TxInputScript[] = [];
      let cursor = 0;
      for (;;) {
        const page = await unisatGet<unknown>(
          `${root}/v1/indexer/tx/${txid}/ins?cursor=${cursor}&size=${INS_PAGE}`,
          headers,
        );
        const rows = parseUnisatInputs(page);
        out.push(...rows);
        const next = nextUnisatOffset(cursor, rows.length, INS_PAGE, unisatTotal(page));
        if (next === null) break;
        cursor = next;
      }
      return out;
    },
    async getTxHeight(txid) {
      const data = await unisatGet<{ height?: number }>(`${root}/v1/indexer/tx/${txid}`, headers);
      return typeof data.height === "number" && data.height > 0 ? data.height : null;
    },
    async broadcast(txHex) {
      // Broadcast: the service sees this transaction and our IP. Unavoidable for a public source.
      const res = await netFetch(
        `${root}/v1/indexer/local_pushtx`,
        { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ txHex }) },
        { timeoutMs: 20_000 },
      );
      const body: unknown = await res.json();
      const data = unwrapUnisat<string | { txid?: string }>(body, "local_pushtx");
      if (typeof data === "string" && data.length > 0) return data;
      if (data && typeof data === "object" && data.txid) return data.txid;
      throw new Error("unisat broadcast empty");
    },
    async estimateFeeSatPerVb() {
      const data = await unisatGet<{
        halfHourFee?: number;
        hourFee?: number;
        fastestFee?: number;
        economyFee?: number;
      }>(`${root}/v1/indexer/fees/recommended`, headers);
      const fee = data.halfHourFee ?? data.hourFee ?? data.fastestFee ?? data.economyFee ?? 1;
      return Math.max(1, Math.ceil(fee));
    },
    async feeRates() {
      // Fee requests go through the requests module so a proxy route can be added later.
      const url = `${root}/v1/indexer/fees/recommended`;
      const res = await fetchVia(route, url, { headers });
      if (!res.ok) await throwUnisatHttp(res, url);
      return parseRecommendedFees(unwrapUnisat<unknown>(await res.json(), "fees/recommended"));
    },
  };
}

export function openChain(cfg: ChainConfig, net: NetworkId = "fractal"): ChainSource {
  const migrated = migrateChainConfig(cfg, net);
  if (migrated.kind === "core") return { ...coreSource(migrated, net), net };
  const service = unisatSource({ ...migrated, url: publicServiceUrl(migrated, net) }, DIRECT, net);
  // A saved key is used for tip, transactions, fees and broadcast. Whole blocks stay on the explorer.
  const prefer = migrated.unisatToken ? "service" : "explorer";
  const pub = { ...withExplorerBlocks(service, netInfo(net).explorer, prefer), net };
  return withSendRoute(pub, migrated);
}

/** Ask only the data service, with no explorer fallback. Settings uses this to check a saved key. */
export async function pingDataService(cfg: ChainConfig, net: NetworkId): Promise<Tip> {
  return unisatSource(cfg, DIRECT, net).getTip();
}

/**
 * "Send payments through: Your own node". Reading still uses the public service; the signed
 * payment goes only to the node, so the public service never sees it or the IP sending it.
 * There is no fallback to the public service: if the node is down, the send fails and says so.
 */
export function withSendRoute(source: ChainSource, cfg: ChainConfig): ChainSource {
  if (cfg.kind === "core" || cfg.sendVia !== "node" || !cfg.sendNodeUrl) return source;
  const node = coreSource({ kind: "core", url: cfg.sendNodeUrl, rpcUser: cfg.sendNodeUser, rpcPassword: cfg.sendNodePassword });
  return { ...source, broadcast: (txHex) => node.broadcast(txHex) };
}

/** Public mode on Bitcoin: everything from one Esplora explorer (mempool.space). */
export function explorerSource(base: string, net: NetworkId): ChainSource {
  return {
    kind: "unisat",
    net,
    getTip: () => mempoolTip(base),
    getBlockHash: (height) => mempoolBlockHash(height, base),
    getBlockRaw: (height) => mempoolBlockRaw(height, base),
    getBlockTxids: (height) => mempoolBlockTxids(height, base),
    async getTxHex(txid) {
      const got = await mempoolTxHex(txid, base);
      if (!got) throw new Error(`transaction ${txid} not found`);
      return got;
    },
    broadcast: (txHex) => mempoolBroadcast(txHex, base),
    async estimateFeeSatPerVb() {
      return Math.max(1, Math.ceil(parseRecommendedFees(await mempoolFees(base)).normal));
    },
    feeRates: async () => parseRecommendedFees(await mempoolFees(base)),
    blockPrevouts: (_height, hash, indexes) => mempoolBlockPrevouts(hash, indexes, base),
  };
}

/**
 * Public mode. Whole blocks always come from this chain's explorer.
 * Without a key, tip, transactions and fees come from that explorer too, and the data service
 * is asked only when the explorer fails (without a key it refuses almost every request).
 * With a key, those calls go to this chain's UniSat host first. Bitcoin uses open-api.unisat.io.
 */
export function withExplorerBlocks(source: ChainSource, base = netInfo(source.net ?? "fractal").explorer, prefer: "explorer" | "service" = "explorer"): ChainSource {
  const either = async <T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
    try {
      return await primary();
    } catch (e) {
      try {
        return await fallback();
      } catch (e2) {
        // A limit on either side is what the user can act on (wait, or add a key), so report that.
        throw e instanceof RateLimitedError || !(e2 instanceof RateLimitedError) ? e : e2;
      }
    }
  };
  const first = <T>(explorer: () => Promise<T>, service: () => Promise<T>): Promise<T> =>
    prefer === "service" ? either(service, explorer) : either(explorer, service);
  const explorerFirst = <T>(explorer: () => Promise<T>, service: () => Promise<T>): Promise<T> => either(explorer, service);
  return {
    ...source,
    getTip: () => first(() => mempoolTip(base), () => source.getTip()),
    getTxHex: (txid) =>
      first(
        async () => {
          const got = await mempoolTxHex(txid, base);
          if (!got) throw new Error("mempool tx not found");
          return got;
        },
        () => source.getTxHex(txid),
      ),
    getBlockHash: (height) => explorerFirst(() => mempoolBlockHash(height, base), () => source.getBlockHash(height)),
    getBlockTxids: (height) => explorerFirst(() => mempoolBlockTxids(height, base), () => source.getBlockTxids(height)),
    getBlockRaw: (height) => mempoolBlockRaw(height, base),
    ...(base === MEMPOOL_BITCOIN
      ? { blockPrevouts: (_height: number, hash: string, indexes: number[]) => mempoolBlockPrevouts(hash, indexes, base) }
      : {}),
    estimateFeeSatPerVb: () =>
      first(
        async () => Math.max(1, Math.ceil(parseRecommendedFees(await mempoolFees(base)).normal)),
        () => source.estimateFeeSatPerVb(),
      ),
    feeRates: () =>
      first(
        async () => parseRecommendedFees(await mempoolFees(base)),
        () => (source.feeRates ? source.feeRates() : feeRatesOf({ ...source, feeRates: undefined })),
      ),
    broadcast: (txHex) =>
      prefer === "service"
        ? either(() => source.broadcast(txHex), () => mempoolBroadcast(txHex, base))
        : (source.net ?? "fractal") === "bitcoin"
          ? either(() => mempoolBroadcast(txHex, base), () => source.broadcast(txHex))
          : source.broadcast(txHex),
  };
}

export type WatchHint = { txid: string; height: number; vout?: number; value?: string; scriptPubKey?: string };

/** Parse UniSat address utxo-data. Hints only: coins are applied from the watched script. */
export function parseUnisatUtxoData(data: unknown): WatchHint[] {
  const rows = data && typeof data === "object" ? (data as { utxo?: unknown }).utxo : undefined;
  if (!Array.isArray(rows)) return [];
  const out: WatchHint[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as { txid?: string; vout?: number; height?: number; isSpent?: boolean; satoshi?: number | string; scriptPk?: string };
    if (typeof r.txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(r.txid)) continue;
    if (r.isSpent === true) continue;
    const value = typeof r.satoshi === "number" ? String(r.satoshi) : typeof r.satoshi === "string" && /^\d+$/.test(r.satoshi) ? r.satoshi : undefined;
    out.push({
      txid: r.txid,
      height: typeof r.height === "number" && r.height > 0 ? r.height : 0,
      ...(typeof r.vout === "number" ? { vout: r.vout } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(typeof r.scriptPk === "string" && r.scriptPk.length >= 4 ? { scriptPubKey: r.scriptPk.toLowerCase() } : {}),
    });
  }
  return out;
}

/**
 * The same source, bound to a scan run's cancel signal. After cancel no call starts, and a
 * call already in flight is abandoned (its result is ignored).
 */
export function cancellable(source: ChainSource, signal: AbortSignal): ChainSource {
  const stopped = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("cancelled")), { once: true });
  });
  stopped.catch(() => undefined);
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      signal.throwIfAborted();
      const r = await Promise.race([fn.apply(source, a), stopped]);
      signal.throwIfAborted();
      return r;
    };
  return {
    kind: source.kind,
    // The scan wraps the source twice. Dropping the chain here made Bitcoin parent lookups
    // use the Fractal explorer (mempool.fractalbitcoin.io).
    net: source.net,
    getTip: wrap(source.getTip),
    getBlockHash: wrap(source.getBlockHash),
    getBlockRaw: source.getBlockRaw ? wrap(source.getBlockRaw) : undefined,
    getBlockTxids: wrap(source.getBlockTxids),
    getTxHex: wrap(source.getTxHex),
    listInputScripts: source.listInputScripts ? wrap(source.listInputScripts) : undefined,
    getTxHeight: source.getTxHeight ? wrap(source.getTxHeight) : undefined,
    broadcast: wrap(source.broadcast),
    estimateFeeSatPerVb: wrap(source.estimateFeeSatPerVb),
    feeRates: source.feeRates ? wrap(source.feeRates) : undefined,
    blockPrevouts: source.blockPrevouts ? wrap(source.blockPrevouts) : undefined,
  };
}

/** Where a background check asks whether a transaction is in a block (the app's notifications). */
export type WatchEndpoint = { kind: "core" | "esplora"; url: string; headers: Record<string, string> };

/**
 * The block source a background confirmation check uses, reduced to what it needs.
 * Own node: Core RPC with its login (the node is yours, so asking it about a txid leaks nothing).
 * Public mode: the same block explorer the scanner reads blocks from. The check downloads the
 * txid list of each new block and looks for the payment on the phone, so the public service never
 * learns which transaction this wallet waits for (audit F-07). The UniSat token is never included.
 */
export function watchEndpoint(cfg: ChainConfig, net: NetworkId = "fractal"): WatchEndpoint {
  const m = migrateChainConfig(cfg, net);
  if (m.kind === "core") {
    const headers: Record<string, string> = {};
    if (m.rpcUser) headers.authorization = `Basic ${btoa(`${m.rpcUser}:${m.rpcPassword ?? ""}`)}`;
    return { kind: "core", url: m.url, headers };
  }
  return { kind: "esplora", url: netInfo(net).explorer.replace(/\/$/, ""), headers: { accept: "application/json" } };
}
