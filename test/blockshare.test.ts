import { describe, expect, it } from "vitest";
import { MEMPOOL_FRACTAL } from "../src/lib/mempool.ts";
import * as btc from "@scure/btc-signer";
import { concatBytes, hex } from "../src/lib/bytes.ts";
import { parseBlockTransactions } from "../src/lib/blockparse.ts";
import { buildSharedBlock, loadSharedBlock, resetSharedChainForTests } from "../src/lib/blockshare.ts";
import type { ChainSource } from "../src/lib/chain.ts";
import { accountFromVault } from "../src/lib/keys.ts";
import { addWatch, applySharedSlice, emptyScanStore } from "../src/lib/scan.ts";
import { parseTxHex } from "../src/lib/tx.ts";
import { createMnemonic, vaultFromMnemonic } from "../src/lib/vault.ts";

/** A block whose header links to `prevHash` (display order hex), so reorg checks see a chain. */
function blockOf(txHexes: string[], prevHash?: string): Uint8Array {
  const body = txHexes.map((item) => fromHexSafe(item));
  const header = new Uint8Array(80);
  if (prevHash) header.set(fromHexSafe(prevHash).reverse(), 4);
  return concatBytes(header, new Uint8Array([txHexes.length]), ...body);
}

function fromHexSafe(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function coinbaseTo(xonly: Uint8Array): string {
  const script = new Uint8Array([0x51, 0x20, ...xonly]);
  const tx = concatBytes(
    new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x01]),
    new Uint8Array(32),
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0xff, 0xff, 0xff, 0xff, 0x01]),
    new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, script.length]),
    script,
    new Uint8Array(4),
  );
  return hex(tx);
}

describe("shared blocks", () => {
  it("reads a transaction out of a block", () => {
    const xonly = new Uint8Array(32).fill(0x11);
    const txHex = coinbaseTo(xonly);
    const parsed = parseBlockTransactions(blockOf([txHex]));
    expect(parsed).not.toBeNull();
    expect(parsed![0]!.txid).toBe(parseTxHex(txHex).txid);
    expect(parsed![0]!.vout[0]!.script[0]).toBe(0x51);
  });

  it("saves a block once and reuses it for a second wallet", async () => {
    resetSharedChainForTests();
    const xonly = new Uint8Array(32).fill(0x22);
    const raw = blockOf([coinbaseTo(xonly)]);
    let downloads = 0;
    const source = {
      kind: "unisat",
      async getBlockRaw() {
        downloads += 1;
        return raw;
      },
    } as unknown as ChainSource;
    const first = await loadSharedBlock(9, source);
    const downloadsAfter = downloads;
    const second = await loadSharedBlock(9, source);
    expect(downloadsAfter).toBeGreaterThan(1);
    expect(downloads).toBe(downloadsAfter);
    expect(second.txs).toEqual(first.txs);
    expect(first.txs).toHaveLength(1);
    const script = "5120" + "22".repeat(32);
    const watched = addWatch(emptyScanStore(9), { scriptPubKey: script, tweak: "aa", label: null, k: 0, kind: "bip86", index: 3 });
    const credited = applySharedSlice(
      accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 9 })),
      watched,
      first,
      0,
      9,
    );
    expect(credited.store.utxos).toHaveLength(1);
    expect(credited.store.utxos[0]?.kind).toBe("bip86");
    expect(credited.store.lastHeight).toBe(9);
    const other = applySharedSlice(
      accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 9 })),
      emptyScanStore(9),
      first,
      0,
      9,
    );
    expect(other.store.utxos).toHaveLength(0);
  });

  it("marks a taproot coin spent when a later saved block spends it", async () => {
    resetSharedChainForTests();
    const xonly = new Uint8Array(32).fill(0x33);
    const created = await buildSharedBlock(blockOf([coinbaseTo(xonly)]), 4, async () => undefined);
    const txid = created.block.txs[0]!.txid;
    const spend = new btc.Transaction({ allowUnknownOutputs: true });
    spend.addInput({ txid, index: 0, sequence: 0xffffffff });
    spend.addOutput({ script: new Uint8Array([0x6a]), amount: 0n });
    const spending = await buildSharedBlock(blockOf([spend.hex], created.block.hash), 5, async () => undefined);
    expect(spending.block.txs).toHaveLength(1);
    const script = "5120" + "33".repeat(32);
    let store = addWatch(emptyScanStore(4), { scriptPubKey: script, tweak: "", label: null, k: 0, kind: "bip86", index: 1 });
    store = applySharedSlice(
      accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 4 })),
      store,
      created.block,
      0,
      5,
    ).store;
    expect(store.utxos[0]?.spent).toBe(false);
    store = applySharedSlice(
      accountFromVault(vaultFromMnemonic({ mnemonic: createMnemonic(128), birthday: 4 })),
      store,
      spending.block,
      0,
      5,
    ).store;
    expect(store.utxos[0]?.spent).toBe(true);
    expect(store.utxos[0]?.spentBy).toBe(spending.block.txs[0]!.txid);
  });

  it.skipIf(!process.env.FRACTAL_BLOCK_PROBE)("builds a live block from recent blocks, not per transaction", async () => {
    resetSharedChainForTests();
    const source = { kind: "unisat" } as unknown as ChainSource;
    const started = Date.now();
    const block = await loadSharedBlock(2233740, source);
    expect(block.txs.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(90_000);
    const nextStarted = Date.now();
    const next = await loadSharedBlock(2233741, source);
    expect(next.txs.length).toBeGreaterThan(0);
    expect(Date.now() - nextStarted).toBeLessThan(20_000);
  });

  it.skipIf(!process.env.FRACTAL_BLOCK_PROBE)("parses a live mempool block", async () => {
    const hash = await (await fetch(`${MEMPOOL_FRACTAL}/api/block-height/2233745`)).text();
    const raw = new Uint8Array(await (await fetch(`${MEMPOOL_FRACTAL}/api/block/${hash.trim()}/raw`)).arrayBuffer());
    const txs = parseBlockTransactions(raw);
    expect(txs).not.toBeNull();
    expect(txs!.length).toBeGreaterThan(1000);
    expect(txs![0]!.txid).toMatch(/^[0-9a-f]{64}$/);
  });
});
