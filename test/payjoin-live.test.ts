import { describe, expect, it } from "vitest";
import { hex, randomBytes } from "../src/lib/bytes.ts";
import { mailboxShortId, ohttpRelayTransport } from "../src/lib/mailbox.ts";
import { DEFAULT_OHTTP_RELAY, DEFAULT_PAYJOIN_DIRECTORY } from "../src/lib/network.ts";
import { fetchDirectoryOhttp } from "../src/lib/payjoin.ts";
import { secp256k1 } from "@noble/curves/secp256k1";

// Talks to the public payjo.in directory: opt in with PRIVATEBIT_LIVE_PAYJOIN=1.
describe.skipIf(!process.env.PRIVATEBIT_LIVE_PAYJOIN)("payjo.in OHTTP live roundtrip", () => {
  it(
    "fetches RFC 9540 keys and GETs/POSTs a mailbox through the default relay",
    { timeout: 90_000 },
    async () => {
      const cfg = await fetchDirectoryOhttp(DEFAULT_PAYJOIN_DIRECTORY);
      expect(cfg.keyId).toBeGreaterThanOrEqual(0);
      expect(cfg.compressedPub.length).toBe(33);

      const id = mailboxShortId(secp256k1.getPublicKey(randomBytes(32), true));
      const mailbox = `${DEFAULT_PAYJOIN_DIRECTORY}/${id}`;
      const t = ohttpRelayTransport(cfg, DEFAULT_OHTTP_RELAY);

      const blob = randomBytes(7168);
      const posted = await t.post(mailbox, blob);
      expect(posted.status).toBe(200);

      const got = await t.get(mailbox);
      expect(got.status).toBe(200);
      expect(hex(got.bytes)).toBe(hex(blob));
    },
  );
});
