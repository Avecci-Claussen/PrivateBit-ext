import { fromHex } from "./bytes.ts";
import { RateLimitedError } from "./requests.ts";

/** Whole blocks only. Addresses and broadcasts stay on the chain source. */
export const MEMPOOL_FRACTAL = "https://mempool.fractalbitcoin.io";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

async function mempoolFetch(path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${MEMPOOL_FRACTAL}${path}`, {
      headers: { accept: "*/*", "user-agent": UA },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "mempool unreachable");
  }
  if (res.status === 429 || res.status === 503) throw new RateLimitedError(`mempool ${path} ${res.status}`);
  if (!res.ok) throw new Error(`mempool ${path} ${res.status}`);
  return res;
}

export async function mempoolBlockRaw(height: number): Promise<Uint8Array> {
  const hash = (await (await mempoolFetch(`/api/block-height/${height}`)).text()).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error("mempool block hash");
  const res = await mempoolFetch(`/api/block/${hash}/raw`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function mempoolTxHex(txid: string): Promise<string | undefined> {
  const res = await fetch(`${MEMPOOL_FRACTAL}/api/tx/${txid}/hex`, {
    headers: { accept: "text/plain", "user-agent": UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 404) return undefined;
  if (res.status === 429 || res.status === 503) throw new RateLimitedError(`mempool tx ${res.status}`);
  if (!res.ok) throw new Error(`mempool tx ${res.status}`);
  const hexTx = (await res.text()).trim();
  if (hexTx.length < 20 || hexTx.length % 2 !== 0) return undefined;
  fromHex(hexTx);
  return hexTx;
}
