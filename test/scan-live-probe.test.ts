// Read-only live probe of block download and matching on Fractal mainnet (public sources, no key).
// Throwaway wallet, no funds, nothing is broadcast. Opt in: PRIVATEBIT_PROBE_SCAN=1 (minutes: PROBE_MINUTES).
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { onBlockStats, resetSharedChainForTests, type BlockStats } from "../src/lib/blockshare.ts";
import { openChain } from "../src/lib/chain.ts";
import { DEFAULT_CHAIN } from "../src/lib/network.ts";
import { backoffMs } from "../src/lib/net.ts";
import { memoryKv } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";

const live = !!process.env.PRIVATEBIT_PROBE_SCAN;
const MINUTES = Number(process.env.PROBE_MINUTES ?? "4");
const BEHIND = Number(process.env.PROBE_BEHIND ?? "40");
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), "privatebit-live-scan.json");

describe.skipIf(!live)("live scan probe (read-only)", () => {
  it(
    "downloads, parses, matches and persists blocks from the public sources",
    async () => {
      resetSharedChainForTests();
      const calls: Record<string, { n: number; ms: number; status: Record<string, number> }> = {};
      const real = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const route = url.pathname.replace(/[0-9a-fA-F]{64}/g, ":hash").replace(/\/\d+(?=\/|$)/g, "/:n");
        const key = `${url.host} ${init?.method ?? "GET"} ${route}`;
        const row = (calls[key] ??= { n: 0, ms: 0, status: {} });
        const t = Date.now();
        try {
          const r = await real(input, init);
          row.n++;
          row.ms += Date.now() - t;
          row.status[r.status] = (row.status[r.status] ?? 0) + 1;
          return r;
        } catch (e) {
          row.n++;
          row.status.error = (row.status.error ?? 0) + 1;
          throw e;
        }
      }) as typeof fetch;
      const blocks: BlockStats[] = [];
      onBlockStats((s) => {
        blocks.push(s);
        console.log(
          `block ${s.height}: ${s.txs} txs, ${s.taprootTxs} with taproot outputs, ${s.parentsNeeded} parents needed (${s.parentsFetched} fetched, ${s.parentsNotFound} not found), ${s.eligibleTxs} eligible txs / ${s.eligibleInputs} inputs, lookback ${s.lookbackBlocks} blocks, ${Math.round(s.bytes / 1024)} KB, ${s.ms.total} ms (lookback ${s.ms.lookback}, raw ${s.ms.raw}, parents ${s.ms.parents})${s.incomplete ? `, INCOMPLETE ${s.incomplete}` : ""}`,
        );
      });

      const tip = await openChain(DEFAULT_CHAIN).getTip();
      const w = new PrivateBit(memoryKv());
      await w.create({ password: "throwaway-probe", birthday: tip.height - BEHIND });
      const start = await w.loadScan();
      const t0 = Date.now();
      const timeline: { s: number; lastHeight: number; tip?: number; inflight?: string; error?: string }[] = [];
      const errors: string[] = [];
      let failures = 0;
      let last = "";
      while (Date.now() - t0 < MINUTES * 60_000) {
        let wait = 0;
        try {
          const p = await w.followTip();
          const mark = `${p.lastHeight}:${p.height}:${p.txIndex}`;
          const moved = mark !== last;
          last = mark;
          if (moved) failures = 0;
          else failures++;
          if (p.done) wait = 5_000;
          else if (!moved) wait = backoffMs(failures, 2_000, 120_000);
        } catch (e) {
          const msg = (e as Error).message;
          errors.push(`${Math.round((Date.now() - t0) / 1000)}s ${(e as Error).name}: ${msg}`);
          failures++;
          wait = backoffMs(failures, 5_000, 300_000);
        }
        const s = await w.loadScan();
        timeline.push({ s: Math.round((Date.now() - t0) / 1000), lastHeight: s.lastHeight, tip: s.tip, inflight: s.inflight ? `${s.inflight.height}:${s.inflight.nextTx}` : undefined });
        if (wait) await new Promise((r) => setTimeout(r, Math.min(wait, MINUTES * 60_000 - (Date.now() - t0))));
      }
      globalThis.fetch = real;
      onBlockStats(undefined);
      const end = await w.loadScan();
      const minutes = (Date.now() - t0) / 60_000;
      const matched = end.lastHeight - start.lastHeight;
      const summary = {
        tipAtStart: tip.height,
        startHeight: start.lastHeight,
        endHeight: end.lastHeight,
        tipAtEnd: end.tip,
        minutes: Number(minutes.toFixed(2)),
        blocksMatched: matched,
        blocksPerMinute: Number((matched / minutes).toFixed(2)),
        coinsFound: end.utxos.length,
        tweaksComputed: blocks.reduce((n, b) => n + b.eligibleTxs, 0),
        errors,
        calls,
        blocks,
        timeline,
      };
      writeFileSync(OUT, JSON.stringify(summary, null, 2));
      console.log(JSON.stringify({ ...summary, blocks: blocks.length, timeline: timeline.length }, null, 2));
      expect(end.lastHeight).toBeGreaterThanOrEqual(start.lastHeight);
    },
    (MINUTES + 2) * 60_000,
  );
});
