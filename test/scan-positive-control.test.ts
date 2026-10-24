/**
 * Positive control for the block download: a block built from the official BIP352 vector
 * (sender keys, input scripts, receiver keys) goes through the same code the worker runs:
 * loadSharedBlock (lookback, raw block, parent fetch, eligible inputs) then applySharedSlice
 * (tweak and match). If this finds the coin, the matching stage works; a live run with zero
 * matches only means nobody paid the throwaway wallet.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { secp256k1 } from "@noble/curves/secp256k1";
import { concatBytes, fromHex, hex } from "../src/lib/bytes.ts";
import { createSilentOutputs, type EligibleVin } from "../src/lib/bip352.ts";
import { loadSharedBlock, onBlockStats, resetSharedChainForTests, type BlockStats } from "../src/lib/blockshare.ts";
import type { ChainSource } from "../src/lib/chain.ts";
import { extractEligibleVins } from "../src/lib/extract-inputs.ts";
import { scanAccountFrom } from "../src/lib/keys.ts";
import { applySharedSlice, emptyScanStore } from "../src/lib/scan.ts";
import { parseTxHex } from "../src/lib/tx.ts";

type Vin = { txid: string; vout: number; scriptSig: string; txinwitness: string; prevout: { scriptPubKey: { hex: string } }; private_key: string };
const vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vectors/send_and_receive_test_vectors.json"), "utf8"),
) as { comment: string; sending: { given: { vin: Vin[]; recipients: { address: string }[] } }[]; receiving: { given: { key_material: { scan_priv_key: string; spend_priv_key: string } } }[] }[];
const tc = vectors.find((v) => v.comment === "Simple send: two inputs")!;

const u32 = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const u64 = (n: number) => concatBytes(u32(n), u32(0));
const varBytes = (b: Uint8Array) => concatBytes(new Uint8Array([b.length]), b);
const le = (txid: string) => fromHex(txid).reverse();

function tx(ins: { txid: string; vout: number; scriptSig: Uint8Array }[], outs: { script: Uint8Array; value: number }[], lock = 0): string {
  return hex(
    concatBytes(
      u32(2),
      new Uint8Array([ins.length]),
      ...ins.map((i) => concatBytes(le(i.txid), u32(i.vout), varBytes(i.scriptSig), u32(0xfffffffd))),
      new Uint8Array([outs.length]),
      ...outs.map((o) => concatBytes(u64(o.value), varBytes(o.script))),
      u32(lock),
    ),
  );
}
const coinbase = (tag: number) => tx([{ txid: "00".repeat(32), vout: 0xffffffff, scriptSig: new Uint8Array([1, tag]) }], [{ script: fromHex("51"), value: 0 }]);
function block(txs: string[], prev?: string): Uint8Array {
  const header = new Uint8Array(80);
  if (prev) header.set(le(prev), 4);
  return concatBytes(header, new Uint8Array([txs.length]), ...txs.map(fromHex));
}
const blockHash = (raw: Uint8Array) => hex(sha256(sha256(raw.slice(0, 80))).reverse());

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
  onBlockStats(undefined);
});

describe("positive control: BIP352 vector through the live block path", () => {
  it("parses, finds eligible inputs, fetches a parent, tweaks and matches the payment", async () => {
    resetSharedChainForTests();
    const given = tc.sending[0]!.given;
    // Parents carrying the vector's input scripts. One sits in an earlier block, one is fetched.
    const parents = given.vin.map((v, i) => tx([{ txid: "11".repeat(32), vout: i, scriptSig: new Uint8Array([1, i]) }], [{ script: fromHex(v.prevout.scriptPubKey.hex), value: 50_000 }], i + 1));
    const parentIds = parents.map((p) => parseTxHex(p).txid);
    const vins = given.vin.map((v, i) => ({ ...v, txid: parentIds[i]!, vout: 0 }));
    const eligible = extractEligibleVins(vins)!;
    expect(eligible).toHaveLength(2);
    const signers: EligibleVin[] = eligible.map((e, i) => ({ ...e, secret: fromHex(given.vin[i]!.private_key) }));
    const [out] = createSilentOutputs(signers, [{ address: given.recipients[0]!.address }], vins);
    const pay = tx(
      vins.map((v) => ({ txid: v.txid, vout: v.vout, scriptSig: fromHex(v.scriptSig) })),
      [{ script: concatBytes(new Uint8Array([0x51, 0x20]), out!.xonly), value: 40_000 }],
    );

    const H = 900_000;
    const raws = new Map<number, Uint8Array>();
    let prev: string | undefined;
    for (let h = H - 32; h <= H; h++) {
      const txs = h === H - 1 ? [coinbase(h & 255), parents[0]!] : h === H ? [coinbase(h & 255), pay] : [coinbase(h & 255)];
      const raw = block(txs, prev);
      raws.set(h, raw);
      prev = blockHash(raw);
    }
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      asked.push(url.pathname);
      if (url.pathname === `/api/tx/${parentIds[1]}/hex`) return new Response(parents[1]!);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const source = { kind: "unisat", getBlockRaw: async (h: number) => raws.get(h)! } as unknown as ChainSource;
    const stats: BlockStats[] = [];
    onBlockStats((s) => stats.push(s));

    const shared = await loadSharedBlock(H, source);
    const s = stats.find((x) => x.height === H)!;
    expect(s.txs).toBe(2);
    expect(s.taprootTxs).toBe(1);
    expect(s.parentsNeeded).toBe(1);
    expect(s.parentsFetched).toBe(1);
    expect(s.eligibleTxs).toBe(1);
    expect(s.eligibleInputs).toBe(2);
    expect(s.incomplete).toBe(0);
    expect(asked).toEqual([`/api/tx/${parentIds[1]}/hex`]);

    const keys = tc.receiving[0]!.given.key_material;
    const spendPub = secp256k1.getPublicKey(fromHex(keys.spend_priv_key), true);
    const account = scanAccountFrom(fromHex(keys.scan_priv_key), spendPub);
    const start = { ...emptyScanStore(H - 1), lastHeight: H - 1 };
    const got = applySharedSlice(account, start, shared, 0, H);
    expect(got.store.lastHeight).toBe(H);
    expect(got.store.utxos).toHaveLength(1);
    expect(got.store.utxos[0]!.scriptPubKey).toBe("5120" + hex(out!.xonly));
    expect(got.store.utxos[0]!.value).toBe("40000");
    expect(got.store.utxos[0]!.tweak).toBe(hex(out!.tweak));
    expect(got.store.utxos[0]!.height).toBe(H);

    // Negative control: a different receiver sees the same block and finds nothing.
    const other = scanAccountFrom(fromHex("01".repeat(32)), spendPub);
    expect(applySharedSlice(other, start, shared, 0, H).store.utxos).toHaveLength(0);
  });
});
