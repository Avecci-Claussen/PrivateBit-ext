import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { checkRawBlock, merkleRoot } from "../src/lib/blockparse.ts";
import { fromHex, hex } from "../src/lib/bytes.ts";
import blocks from "./vectors/fractal-blocks.json";

const hashOf = (raw: Uint8Array) => hex(sha256(sha256(raw.subarray(0, 80))).slice().reverse());

describe("audit M2 (independent): raw blocks from an explorer are checked", () => {
  it("accepts real Fractal blocks (own work and merge mined)", () => {
    for (const h of Object.values(blocks)) {
      const raw = fromHex(h);
      expect(() => checkRawBlock(raw, hashOf(raw))).not.toThrow();
    }
  });

  it("refuses a changed transaction, a different block and a header without work", () => {
    const raw = fromHex(blocks.fractal_2236863);
    const tx = raw.slice();
    tx[90] ^= 1;
    expect(() => checkRawBlock(tx, hashOf(raw))).toThrow(/merkle root/);
    expect(() => checkRawBlock(raw, "00".repeat(32))).toThrow(/hash does not match/);
    // Header nonce changed: same transactions, but the hash no longer meets the target.
    const nonce = raw.slice();
    nonce[79] ^= 0xff;
    expect(() => checkRawBlock(nonce)).toThrow(/proof of work/);
    // Target made trivially easy.
    const easy = raw.slice();
    easy.set([0xff, 0xff, 0x7f, 0x20], 72);
    expect(() => checkRawBlock(easy)).toThrow(/too easy/);
  });

  it("merkle root of one and three transactions", () => {
    const a = "11".repeat(32);
    expect(hex(merkleRoot([a]))).toBe(a);
    const r3 = merkleRoot([a, "22".repeat(32), "33".repeat(32)]);
    expect(r3.length).toBe(32);
  });
});
