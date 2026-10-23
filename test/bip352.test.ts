import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createSilentOutputs,
  decodeSilentAddress,
  detectOurUtxos,
  encodeSilentAddress,
  precomputeLabels,
  senderSharedSecret,
  spendSecret,
} from "../src/lib/bip352.ts";
import { extractEligibleVins, type RawVin } from "../src/lib/extract-inputs.ts";
import { fromHex, hex } from "../src/lib/bytes.ts";
import { evenPriv } from "../src/lib/schnorr-util.ts";
import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

const vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vectors/send_and_receive_test_vectors.json"), "utf8"),
) as Vector[];

type Vector = {
  comment: string;
  sending: {
    given: { vin: RawVin[]; recipients: { address: string }[] };
    expected: { outputs: string[][]; shared_secrets?: string[] };
  }[];
  receiving: {
    given: {
      vin: RawVin[];
      outputs: string[];
      key_material: { spend_priv_key: string; scan_priv_key: string };
      labels: number[];
    };
    expected: {
      outputs?: { pub_key: string; priv_key_tweak: string; signature?: string }[];
      n_outputs?: number;
      addresses: string[];
    };
  }[];
};

describe("BIP352 official vectors", () => {
  for (const tc of vectors) {
    it(`send: ${tc.comment}`, () => {
      for (const sending of tc.sending) {
        const eligible = extractEligibleVins(sending.given.vin);
        if (!eligible || eligible.length === 0) {
          expect(sending.expected.outputs.flat().length).toBe(0);
          continue;
        }
        const recips = sending.given.recipients.flatMap((r) => {
          const n = (r as { count?: number }).count ?? 1;
          return Array.from({ length: n }, () => ({ address: r.address, count: 1 as const }));
        });
        const outpoints = sending.given.vin.map((v) => ({ txid: v.txid, vout: v.vout }));
        const outs = createSilentOutputs(eligible, recips, outpoints);
        const got = new Set(outs.map((o) => hex(o.xonly)));
        const matched = sending.expected.outputs.some(
          (lst) => lst.length === got.size && lst.every((x) => got.has(x)),
        );
        expect(matched, `got ${[...got].join(",")}`).toBe(true);
        if (outs.length && sending.expected.shared_secrets?.length) {
          const shared = hex(
            senderSharedSecret(
              eligible,
              decodeSilentAddress(sending.given.recipients[0].address).scan,
              outpoints,
            ),
          );
          expect(sending.expected.shared_secrets).toContain(shared);
        }
      }
    });

    it(`receive: ${tc.comment}`, () => {
      for (const receiving of tc.receiving) {
        const eligible = extractEligibleVins(receiving.given.vin);
        if (!eligible || eligible.length === 0) {
          expect(receiving.expected.outputs!.length).toBe(0);
          continue;
        }
        const scanSecret = fromHex(receiving.given.key_material.scan_priv_key);
        const bSpend = fromHex(receiving.given.key_material.spend_priv_key);
        const spendPub = secp256k1.getPublicKey(bSpend, true);
        const scanPub = secp256k1.getPublicKey(scanSecret, true);
        const labels = precomputeLabels(scanSecret, receiving.given.labels);
        const found = detectOurUtxos({
          vins: eligible,
          taprootOutputs: receiving.given.outputs.map((x, vout) => ({ xonly: fromHex(x), vout })),
          scanSecret,
          spendPub,
          labels,
          outpoints: receiving.given.vin.map((v) => ({ txid: v.txid, vout: v.vout })),
        });
        if (receiving.expected.n_outputs !== undefined) {
          expect(found.length).toBe(receiving.expected.n_outputs);
        } else {
          const got = found.map((f) => hex(f.xonly)).sort();
          const want = (receiving.expected.outputs ?? []).map((o) => o.pub_key).sort();
          expect(got).toEqual(want);
        }
        const addr = encodeSilentAddress(scanPub, spendPub);
        expect(receiving.expected.addresses[0]).toBe(addr);

        // Official BIP352 reference.py: d = b_spend + priv_key_tweak; negate if odd Y; BIP340 sign.
        const msg = sha256(new TextEncoder().encode("message"));
        const aux = sha256(new TextEncoder().encode("random auxiliary data"));
        for (const o of receiving.expected.outputs ?? []) {
          const d = spendSecret({
            spendSecret: bSpend,
            tweak: fromHex(o.priv_key_tweak),
            label: null,
            scanSecret,
          });
          const even = evenPriv(d);
          expect(hex(secp256k1.getPublicKey(even, true).slice(1))).toBe(o.pub_key);
          if (o.signature) {
            expect(hex(schnorr.sign(msg, even, aux))).toBe(o.signature);
            expect(schnorr.verify(fromHex(o.signature), msg, fromHex(o.pub_key))).toBe(true);
          }
        }
      }
    });
  }
});

