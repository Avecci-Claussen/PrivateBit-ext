// Item 4: Fractal header proofs. Vectors were mined on a local fractald v0.4.0 regtest node and
// accepted by it (tools/fractal-regtest/mine_aux.py); the indexer cold-signature vector is
// fractald's own (src/test/indexer_tests.cpp).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { fromHex, hex, concatBytes } from "../src/lib/bytes.ts";
import { BlockCheckError, blockKind, checkRawBlock } from "../src/lib/blockparse.ts";
import {
  FRACTAL_REGTEST_INDEXER_COLD_KEY,
  FRACTAL_REGTEST_POW_LIMIT_BITS as RT,
  expectedChainIndex,
  indexerColdMessage,
  parseHeaderWithProof,
  verifyAuxPow,
  verifyHeaderWithProof,
  verifyIndexerProof,
} from "../src/lib/headerproof.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/fractal-auxpow-regtest.json", import.meta.url), "utf8")) as {
  vectors: { hash: string; headerWithProof: string; chainMerkleHeight?: number; legacy?: boolean }[];
};
const aux = fx.vectors.filter((v) => !v.legacy);
const dsha = (b: Uint8Array) => sha256(sha256(b));

describe("AuxPoW from a real fractald node", () => {
  it("both merge-mined blocks verify (empty and 2-level chain merkle tree)", () => {
    expect(aux.length).toBe(2);
    for (const v of aux) expect(verifyHeaderWithProof(fromHex(v.headerWithProof), v.hash)).toBe("auxpow");
    expect(aux.map((v) => v.chainMerkleHeight)).toEqual([0, 2]);
  });

  it("a normal block has no proof and verifies as legacy", () => {
    const v = fx.vectors.find((x) => x.legacy)!;
    expect(verifyHeaderWithProof(fromHex(v.headerWithProof), v.hash)).toBe("legacy");
  });

  it("the wrong block hash is refused", () => {
    expect(() => verifyHeaderWithProof(fromHex(aux[0]!.headerWithProof), aux[1]!.hash)).toThrow(/does not match/);
  });

  it("tampering anywhere in the auxpow is refused", () => {
    const v = aux[1]!;
    const raw = fromHex(v.headerWithProof);
    const p = parseHeaderWithProof(raw);
    // Wrong chain index.
    expect(() => verifyAuxPow({ ...p, aux: { ...p.aux!, chainIndex: (p.aux!.chainIndex + 1) % 4 } })).toThrow(BlockCheckError);
    // Wrong branch node.
    const branch = p.aux!.chainMerkleBranch.map((b) => b.slice());
    branch[0]![0] ^= 1;
    expect(() => verifyAuxPow({ ...p, aux: { ...p.aux!, chainMerkleBranch: branch } })).toThrow(/root missing/);
    // Coinbase not in the parent.
    const mb = p.aux!.merkleBranch.map((b) => b.slice());
    mb[0]![5] ^= 1;
    expect(() => verifyAuxPow({ ...p, aux: { ...p.aux!, merkleBranch: mb } })).toThrow(/merkle root incorrect/);
    // Parent from our own chain ID.
    const parent = p.aux!.parent.slice();
    parent[2] = 0x24;
    parent[3] = 0x20;
    expect(() => verifyAuxPow({ ...p, aux: { ...p.aux!, parent } })).toThrow(/our chain ID/);
  });

  it("a parent header without work is refused", () => {
    const p = parseHeaderWithProof(fromHex(aux[0]!.headerWithProof));
    const parent = p.aux!.parent.slice();
    // Regtest target is half the hash space: find a nonce whose hash is above it.
    for (let n = 0; n < 1000; n++) {
      parent[76] = n & 0xff;
      parent[77] = n >> 8;
      if (dsha(parent)[31]! >= 0x80) break;
    }
    expect(() => verifyAuxPow({ ...p, aux: { ...p.aux!, parent } })).toThrow(/proof of work|merkle/);
  });

  it("expected index matches the reference algorithm", () => {
    expect(expectedChainIndex(7, 0x2024, 0)).toBe(0);
    for (const n of [0, 1, 7, 0xffffffff]) expect(expectedChainIndex(n, 0x2024, 2)).toBeLessThan(4);
  });

  it("explorer blocks: merge-mined and indexer kinds are told apart, unknown chain IDs refused", () => {
    const h = new Uint8Array(80);
    h.set([0x00, 0x01, 0x24, 0x20]);
    expect(blockKind(h)).toBe("auxpow");
    h.set([0x00, 0x01, 0x26, 0x20]);
    expect(blockKind(h)).toBe("indexer");
    h.set([0x00, 0x01, 0x99, 0x20]);
    expect(() => blockKind(h)).toThrow(/unknown block type/);
    expect(blockKind(h, "bitcoin")).toBe("legacy");
  });

  it("Bitcoin: version bit 8 never skips proof of work", () => {
    const h = new Uint8Array(81);
    h.set([0x00, 0x01, 0x24, 0x20]);
    h[80] = 0;
    // Bits of an easy target: refused as too easy on Bitcoin before any skip.
    h.set([0xff, 0xff, 0x00, 0x1d], 72);
    expect(() => checkRawBlock(h, undefined, [{ txid: hex(h.subarray(36, 68).slice().reverse()) }], "bitcoin")).toThrow(/too easy|proof of work/);
  });
});

describe("indexer proofs (FIP-101)", () => {
  it("fractald's cold-signature vector: same message hash, signature verifies", () => {
    const x = { hotPubKey: fromHex("fb3bba7269d7d92a6c19a629e9759fabc1b656cdef71ed1cc201e58ec8c5aec0"), authTimestamp: 1769575544, rangeStart: 0, rangeEnd: 65535 };
    const msg = indexerColdMessage(x);
    expect(hex(msg.slice().reverse())).toBe("7d075f68d38fecfd889dc4c88e82961f3abe83c426adf37809c0853326cb91b3");
    const sig = fromHex("eb820b5b33873938666e61be7c49542be6a3804766814cbf575c6c3292fe89d44af33d1425ec091f1736fe5cb619d3800c6d4d227e92bba03b85915cde639d60");
    expect(schnorr.verify(sig, msg, fromHex(FRACTAL_REGTEST_INDEXER_COLD_KEY))).toBe(true);
  });

  function indexerBlock(opts: { expired?: boolean; badHot?: boolean } = {}) {
    const cold = fromHex("11".repeat(32));
    const hot = fromHex("22".repeat(32));
    const hotPub = schnorr.getPublicKey(hot);
    const header = new Uint8Array(80);
    header.set([0x00, 0x01, 0x26, 0x20]);
    header.set(fromHex("33".repeat(32)), 4); // prev: cursor 0x3333
    header.set([0x10, 0x00, 0x00, 0x60], 68); // time
    header.set([0xff, 0xff, 0x7f, 0x20], 72); // regtest powLimit bits
    const proof = { hotPubKey: hotPub, authTimestamp: opts.expired ? 0x5fffffff : 0x70000000, rangeStart: 0x3000, rangeEnd: 0x3fff };
    for (let n = 0; ; n++) {
      new DataView(header.buffer).setUint32(76, n, true);
      if (dsha(concatBytes(hotPub, header))[31]! < 0x7f) break;
    }
    const coldSig = schnorr.sign(indexerColdMessage(proof), cold);
    const hotSig = schnorr.sign(dsha(header), opts.badHot ? cold : hot);
    const tail = new Uint8Array(8);
    new DataView(tail.buffer).setUint32(0, proof.authTimestamp, true);
    new DataView(tail.buffer).setUint16(4, proof.rangeStart, true);
    new DataView(tail.buffer).setUint16(6, proof.rangeEnd, true);
    const raw = concatBytes(header, hotPub, tail, coldSig, hotSig);
    return { raw, coldKey: hex(schnorr.getPublicKey(cold)) };
  }

  it("a full proof verifies; wrong cold key, expiry or hot signature are refused", { timeout: 120_000 }, () => {
    const ok = indexerBlock();
    const p = parseHeaderWithProof(ok.raw);
    expect(p.kind).toBe("indexer");
    expect(() => verifyIndexerProof(p, ok.coldKey, RT)).not.toThrow();
    expect(() => verifyIndexerProof(p, undefined, RT)).toThrow(/cold signature/);
    expect(() => verifyIndexerProof(p, ok.coldKey)).toThrow(/powLimit/);
    expect(() => verifyIndexerProof(parseHeaderWithProof(indexerBlock({ expired: true }).raw), ok.coldKey, RT)).toThrow(/expired/);
    expect(() => verifyIndexerProof(parseHeaderWithProof(indexerBlock({ badHot: true }).raw), ok.coldKey, RT)).toThrow(/hot signature/);
    const out = { ...p, indexer: { ...p.indexer!, rangeStart: 0, rangeEnd: 0x100 } };
    expect(() => verifyIndexerProof(out, ok.coldKey, RT)).toThrow(/cursor/);
  });
});

describe("explorer runs without checkable work", () => {
  it("a linked run longer than the limit is refused; a normal block resets it", async () => {
    const { noteExplorerHeader, resetExplorerHeadersForTests, MAX_UNPROVEN_RUN } = await import("../src/lib/blockshare.ts");
    resetExplorerHeadersForTests();
    const dsha2 = (b: Uint8Array) => sha256(sha256(b));
    let prev: Uint8Array = new Uint8Array(32);
    const make = (aux: boolean) => {
      const h = new Uint8Array(80);
      h.set(aux ? [0x00, 0x01, 0x24, 0x20] : [0x00, 0x00, 0x00, 0x20]);
      h.set(prev, 4);
      prev = dsha2(h);
      return h;
    };
    noteExplorerHeader(100, make(false));
    for (let i = 1; i <= MAX_UNPROVEN_RUN; i++) noteExplorerHeader(100 + i, make(true));
    expect(() => noteExplorerHeader(101 + MAX_UNPROVEN_RUN, make(true))).toThrow(/without checkable work/);
    resetExplorerHeadersForTests();
  });
});
