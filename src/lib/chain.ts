import { fromHex } from "./bytes.ts";
import { rejectAddressUtxoAsSot } from "./policy.ts";
import { DIRECT, fetchVia, parseRecommendedFees, RateLimitedError, type FeeRates, type RequestRoute } from "./requests.ts";
import { FRACTAL, migrateChainConfig, type ChainConfig, type ChainKind } from "./network.ts";

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
  if (res.status === 429) throw new RateLimitedError(`${url} 429`);
  const body = await res.json().catch(() => null);
  if (body && typeof body === "object") unwrapUnisat<unknown>(body, url);
  throw new Error(`${url} ${res.status}`);
}

async function unisatGet<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) await throwUnisatHttp(res, url);
  return unwrapUnisat<T>(await res.json(), url);
}

type RpcAuth = { user?: string; password?: string };

async function rpc(url: string, auth: RpcAuth, method: string, params: unknown[] = []): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth.user) {
    headers.authorization = `Basic ${btoa(`${auth.user}:${auth.password ?? ""}`)}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "1.0", id: "privatebit", method, params }),
  });
  const body = (await res.json()) as { result: unknown; error: { message: string } | null };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

export function coreSource(cfg: ChainConfig): ChainSource {
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
      return fromHex(String(await rpc(cfg.url, auth, "getblock", [hash, 0])));
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
 * UniSat Fractal Open API as a tx/broadcast source. Not an SP index.
 * Address UTXO helpers are intentionally omitted so they cannot become SoT.
 * Block bytes for a scan come from mempool.fractalbitcoin.io, not from here.
 */
export function unisatSource(cfg: ChainConfig, route: RequestRoute = DIRECT): ChainSource {
  const migrated = migrateChainConfig(cfg);
  const root = (migrated.url || FRACTAL.defaultUnisat).replace(/\/$/, "");
  const headers = unisatHeaders(migrated.unisatToken);
  return {
    kind: "unisat",
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
      const res = await fetch(`${root}/v1/indexer/local_pushtx`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ txHex }),
      });
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

export function openChain(cfg: ChainConfig): ChainSource {
  const migrated = migrateChainConfig(cfg);
  if (migrated.kind === "core") return coreSource(migrated);
  return unisatSource(migrated);
}

export type WatchHint = { txid: string; height: number; vout?: number; value?: string; scriptPubKey?: string };

/** Parse UniSat address utxo-data. Hints only — coins are applied from the watched script. */
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

/** Newest address history page. `start` echoes the cursor; detail is newest first. */
export function parseUnisatAddressHistory(data: unknown): WatchHint[] {
  const rows = data && typeof data === "object" ? (data as { detail?: unknown }).detail : undefined;
  if (!Array.isArray(rows)) return [];
  const out: WatchHint[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as { txid?: string; height?: number };
    if (typeof r.txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(r.txid)) continue;
    out.push({ txid: r.txid, height: typeof r.height === "number" && r.height > 0 ? r.height : 0 });
  }
  return out;
}

/**
 * Candidate txids for a known address (one-time / Payjoin watch). Not a Silent Payment SoT:
 * callers must fetch tx hex and match the watched script.
 */
export async function hintAddressUtxos(cfg: ChainConfig, address: string): Promise<WatchHint[]> {
  const migrated = migrateChainConfig(cfg);
  if (migrated.kind !== "unisat" || !address) return [];
  const root = (migrated.url || FRACTAL.defaultUnisat).replace(/\/$/, "");
  const headers = unisatHeaders(migrated.unisatToken);
  const out: WatchHint[] = [];
  const seen = new Set<string>();
  const size = 100;
  let cursor = 0;
  for (;;) {
    const data = await unisatGet<unknown>(
      `${root}/v1/indexer/address/${encodeURIComponent(address)}/utxo-data?cursor=${cursor}&size=${size}`,
      headers,
    );
    const rows = data && typeof data === "object" && Array.isArray((data as { utxo?: unknown }).utxo)
      ? (data as { utxo: unknown[] }).utxo
      : [];
    for (const hint of parseUnisatUtxoData(data)) {
      const key = hint.vout === undefined ? hint.txid : `${hint.txid}:${hint.vout}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seen.add(hint.txid);
      out.push(hint);
    }
    const next = nextUnisatOffset(cursor, rows.length, size, unisatTotal(data));
    if (next === null) break;
    cursor = next;
  }
  // One-time addresses have one or two payments. The newest history page covers that
  // even when the unspent list has not caught up yet. Busy addresses are not walked.
  try {
    const history = await unisatGet<unknown>(
      `${root}/v1/indexer/address/${encodeURIComponent(address)}/history?cursor=0&size=20`,
      headers,
    );
    for (const hint of parseUnisatAddressHistory(history)) {
      if (seen.has(hint.txid)) continue;
      seen.add(hint.txid);
      out.push(hint);
    }
  } catch {
    /* The unspent list above still stands when history is unavailable. */
  }
  return out;
}
