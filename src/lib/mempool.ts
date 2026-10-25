import { fromHex } from "./bytes.ts";
import { checkRawBlock } from "./blockparse.ts";
import { RateLimitedError } from "./requests.ts";
import { netFetch } from "./net.ts";

/** Whole blocks only. Addresses and broadcasts stay on the chain source. */
export const MEMPOOL_FRACTAL = "https://mempool.fractalbitcoin.io";
/** Bitcoin mainnet explorer (same API). */
export const MEMPOOL_BITCOIN = "https://mempool.space";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

async function mempoolFetch(path: string, base = MEMPOOL_FRACTAL, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await netFetch(`${base}${path}`, { ...init, headers: { accept: "*/*", "user-agent": UA, ...(init.headers ?? {}) } }, { timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof RateLimitedError) throw e;
    throw new Error(e instanceof Error ? e.message : "mempool unreachable");
  }
  if (res.status === 429 || res.status === 503) throw new RateLimitedError(`mempool ${path} ${res.status}`);
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`mempool ${path} ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res;
}

export async function mempoolBlockRaw(height: number, base = MEMPOOL_FRACTAL): Promise<Uint8Array> {
  const hash = await mempoolBlockHash(height, base);
  const res = await mempoolFetch(`/api/block/${hash}/raw`, base);
  const raw = new Uint8Array(await res.arrayBuffer());
  checkRawBlock(raw, hash, undefined, base === MEMPOOL_BITCOIN ? "bitcoin" : "fractal");
  return raw;
}

export async function mempoolTxHex(txid: string, base = MEMPOOL_FRACTAL): Promise<string | undefined> {
  const res = await netFetch(`${base}/api/tx/${txid}/hex`, { headers: { accept: "text/plain", "user-agent": UA } }, { timeoutMs: 12_000 });
  if (res.status === 404) return undefined;
  if (res.status === 429 || res.status === 503) throw new RateLimitedError(`mempool tx ${res.status}`);
  if (!res.ok) throw new Error(`mempool tx ${res.status}`);
  const hexTx = (await res.text()).trim();
  if (hexTx.length < 20 || hexTx.length % 2 !== 0) return undefined;
  fromHex(hexTx);
  return hexTx;
}

/** Chain tip from the same explorer that serves the blocks (not wallet-specific). */
export async function mempoolTip(base = MEMPOOL_FRACTAL): Promise<{ height: number; hash: string }> {
  const height = Number((await (await mempoolFetch("/api/blocks/tip/height", base)).text()).trim());
  if (!Number.isInteger(height) || height <= 0) throw new Error("mempool tip height");
  const hash = await mempoolBlockHash(height, base);
  return { height, hash };
}

export async function mempoolBlockHash(height: number, base = MEMPOOL_FRACTAL): Promise<string> {
  const hash = (await (await mempoolFetch(`/api/block-height/${height}`, base)).text()).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("mempool block hash");
  return hash;
}

/** Recommended fee rates (mempool.space format: fastestFee, halfHourFee, hourFee, economyFee, minimumFee). */
export async function mempoolFees(base = MEMPOOL_FRACTAL): Promise<unknown> {
  return (await mempoolFetch("/api/v1/fees/recommended", base)).json();
}

export async function mempoolBlockTxids(height: number, base = MEMPOOL_FRACTAL): Promise<string[]> {
  const hash = await mempoolBlockHash(height, base);
  const ids = (await (await mempoolFetch(`/api/block/${hash}/txids`, base)).json()) as unknown;
  if (!Array.isArray(ids) || ids.some((t) => typeof t !== "string")) throw new Error("mempool block txids");
  return ids as string[];
}

/** Send a signed transaction. Returns the txid the explorer reports. */
export async function mempoolBroadcast(txHex: string, base = MEMPOOL_FRACTAL): Promise<string> {
  const res = await mempoolFetch("/api/tx", base, { method: "POST", body: txHex, headers: { "content-type": "text/plain" } });
  const txid = (await res.text()).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`broadcast answer was not a txid: ${txid.slice(0, 80)}`);
  return txid;
}

/** Esplora page of 25 transactions, each input with its prevout script. */
type EsploraTx = { txid: string; vin: { txid: string; vout: number; is_coinbase?: boolean; prevout?: { scriptpubkey?: string } | null }[] };

export function parseEsploraPrevouts(page: unknown, into: Record<string, string>): number {
  if (!Array.isArray(page)) throw new Error("mempool block page");
  for (const tx of page as EsploraTx[]) {
    for (const vin of tx.vin ?? []) {
      if (vin.is_coinbase || !vin.prevout || typeof vin.prevout.scriptpubkey !== "string") continue;
      into[`${vin.txid}:${vin.vout}`] = vin.prevout.scriptpubkey.toLowerCase();
    }
  }
  return page.length;
}

/**
 * Prevout scripts for the transactions at `indexes` in a block, read 25 at a time from the
 * explorer's block pages. A Bitcoin block has thousands of transactions; fetching each parent
 * would be thousands of requests, this is about one per 25 transactions.
 */
export async function mempoolBlockPrevouts(hash: string, indexes: number[], base = MEMPOOL_BITCOIN, parallel = 4): Promise<Record<string, string>> {
  const pages = [...new Set(indexes.map((i) => Math.floor(i / 25) * 25))].sort((a, b) => a - b);
  const out: Record<string, string> = {};
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, pages.length) }, async () => {
      for (;;) {
        const p = pages[next++];
        if (p === undefined) return;
        parseEsploraPrevouts(await (await mempoolFetch(`/api/block/${hash}/txs/${p}`, base)).json(), out);
      }
    }),
  );
  return out;
}
