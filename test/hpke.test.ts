import { describe, expect, it } from "vitest";
import { fromHex, hex } from "../src/lib/bytes.ts";
import {
  PADDED_MESSAGE_BYTES,
  PADDED_PLAINTEXT_A_LENGTH,
  PADDED_PLAINTEXT_B_LENGTH,
  decryptMessageA,
  decryptMessageB,
  encryptMessageA,
  encryptMessageB,
  genHpkeKeyPair,
} from "../src/lib/bip77-hpke.ts";
import { ellswiftDecodeUncompressed, ellswiftEncodeUncompressed } from "../src/lib/ellswift.ts";
import {
  deriveKeyPair,
  encap,
  setupSenderBase,
  skToUncompressed,
} from "../src/lib/hpke.ts";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  BIP77_OHTTP_PURPOSE,
  encodeAllowedPurposes,
  encodeOhttpKeyConfig,
  encapsulateRequest,
  decapsulateResponse,
  gatewayHandle,
  genOhttpKeyPair,
  parseOhttpKeys,
} from "../src/lib/ohttp.ts";
import { encodeBip21, parseBip21 } from "../src/lib/bip21.ts";
import { attachFragment, encodeFragment, parseFragment } from "../src/lib/bip77-uri.ts";

function compactHex(s: string): string {
  return s.replace(/\s/g, "").toLowerCase();
}

describe("DHKEM(secp256k1) draft-wahby", () => {
  it("matches the published ECDH x-coordinate", () => {
    const sk = fromHex("30FBC0D41CD01885333211FF53B9ED29BCBDCCC3FF13625A82DB61A7BB8EAE19");
    const pk = fromHex(
      compactHex(
        "04 3EE73144 07753D1B A296DE29 F07B2CD5 505CA94B 614F127E 71F3C19F C7845DAF 49C9BB4B F4D00D3B 5411C8EB 86D59A2D CADC5A13 115FA9FE F44D1E0B 7EF11CAB",
      ),
    );
    const shared = secp256k1.getSharedSecret(sk, pk, false);
    expect(hex(shared.subarray(1, 33))).toBe(
      compactHex("3ADDFBC2 B30E3D1B 1DF262A4 D6CECF73 A11DF8BD 93E0EB21 FC11847C 6F3DDBE2"),
    );
  });

  it("DeriveKeyPair matches ChaCha20-Poly1305 Base vector B.3.1", () => {
    const ikmE = fromHex("77caf1617fb3723972a56cd2085081c9f66baae825ce5f363c0a86ec87013fa0");
    const ikmR = fromHex("71b530bed75fc3fa2f8e8bb163203e6ee676565cc61cd59d66352676341c0688");
    const e = deriveKeyPair(ikmE);
    const r = deriveKeyPair(ikmR);
    expect(hex(e.sk)).toBe("1300156862599d00ecbb066644bf4d4505b56a9b235eae7a8632defc4335d5c0");
    expect(hex(r.sk)).toBe("4a99cf59fb6af25c324299a39fef2db3931667ee89528e3aacc8b61d591ad643");
    expect(hex(e.pk)).toBe(
      compactHex(
        "0471788be0ccf916302c4f2225bba89a0ff3832df1fe50b48d8ccb910be74e30241428ba6de731ccf538ded2913febdfe14b2648fafb8fdd35b8aa91804c706076",
      ),
    );
    const info = fromHex("609dcb9844f8412343191f93add1177186c03a36");
    const { shared } = encap(r.pk, e.sk);
    expect(hex(shared)).toBe("a81a3ccf56f48c699eb9f393e0701692836f9ac2e06b493ccbf99ac68a792bbe");
    const setup = setupSenderBase(r.pk, info, e.sk);
    expect(hex(setup.ctx.key)).toBe("4c260fe82e8c3737e7a70c3223cb16fc205682255389ad4bc3e7fae42c46b062");
    expect(hex(setup.ctx.baseNonce)).toBe("e035bbf3c39ff5a7196cfe84");
    expect(hex(setup.ctx.exporterSecret)).toBe(
      "83e82aad90186ddd7e1db090c840ee70eb6cac7531b64dc52a12997462c8d0d8",
    );
  });
});

describe("ElligatorSwift (BIP324 §4.1)", () => {
  it("round-trips an uncompressed secp256k1 point", () => {
    const pk = skToUncompressed(fromHex("11".repeat(32)));
    const ell = ellswiftEncodeUncompressed(pk);
    expect(ell.length).toBe(64);
    expect(hex(ellswiftDecodeUncompressed(ell))).toBe(hex(pk));
  });
});

describe("BIP77 Message A/B", () => {
  it("round-trips a padded original and a proposal", () => {
    const receiver = genHpkeKeyPair();
    const reply = genHpkeKeyPair();
    const a = encryptMessageA(new TextEncoder().encode("cHNidP8foo"), reply.pkCompressed, receiver.pkCompressed);
    expect(a.length).toBe(PADDED_MESSAGE_BYTES);
    const opened = decryptMessageA(a, receiver.sk);
    expect(hex(opened.replyPkCompressed)).toBe(hex(reply.pkCompressed));
    expect(opened.body.length).toBe(PADDED_PLAINTEXT_A_LENGTH);
    expect(new TextDecoder().decode(opened.body.subarray(0, 10))).toBe("cHNidP8foo");

    const b = encryptMessageB(new TextEncoder().encode("cHNidP8bar"), receiver, reply.pkCompressed);
    expect(b.length).toBe(PADDED_MESSAGE_BYTES);
    const proposal = decryptMessageB(b, receiver.pkCompressed, reply.sk);
    expect(proposal.length).toBe(PADDED_PLAINTEXT_B_LENGTH);
    expect(new TextDecoder().decode(proposal.subarray(0, 10))).toBe("cHNidP8bar");
  });

  it("rejects the wrong receiver secret", () => {
    const receiver = genHpkeKeyPair();
    const other = genHpkeKeyPair();
    const reply = genHpkeKeyPair();
    const a = encryptMessageA(new Uint8Array([1, 2, 3]), reply.pkCompressed, receiver.pkCompressed);
    expect(() => decryptMessageA(a, other.sk)).toThrow(/open failed/);
  });
});

describe("OHTTP (RFC 9458 + BIP77 pad)", () => {
  it("parses the payjo.in RFC 9540 secp256k1 key configuration", () => {
    const live = fromHex(
      "0100160439c9604d9ef100a565ad34275b2bc3618c2426812bb6787bbf770cacf54d509729f6f4fa88b29f8a8b432a415cbd2a3209425cd96b24e3c8a11410352e38cf91000400010003",
    );
    const cfg = parseOhttpKeys(live);
    expect(cfg.keyId).toBe(1);
    expect(cfg.compressedPub.length).toBe(33);
    expect(cfg.compressedPub[0] === 2 || cfg.compressedPub[0] === 3).toBe(true);
    const encoded = encodeOhttpKeyConfig(cfg);
    expect(parseOhttpKeys(encoded).keyId).toBe(1);
    expect(hex(parseOhttpKeys(encoded).compressedPub)).toBe(hex(cfg.compressedPub));
  });

  it("advertises BIP77 allowed_purposes in TLS ALPN list encoding", () => {
    const body = encodeAllowedPurposes();
    expect(body[0]).toBe(0);
    const innerLen = (body[0]! << 8) | body[1]!;
    expect(innerLen).toBe(body.length - 2);
    const labelLen = body[2]!;
    expect(new TextDecoder().decode(body.subarray(3, 3 + labelLen))).toBe(BIP77_OHTTP_PURPOSE);
  });

  it("encapsulates a mailbox POST through a gateway", () => {
    const gw = genOhttpKeyPair(1);
    const { wire, session } = encapsulateRequest(
      {
        method: "POST",
        scheme: "https",
        authority: "payjo.in",
        path: "/ABCDEFGH",
        body: new Uint8Array(7168).fill(7),
      },
      gw,
    );
    expect(wire.length).toBe(8192);
    const resp = gatewayHandle(wire, gw, (req) => {
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/ABCDEFGH");
      expect(req.body?.length).toBe(7168);
      return { status: 200, body: new TextEncoder().encode("ok") };
    });
    expect(resp.length).toBe(8192);
    const inner = decapsulateResponse(resp, session);
    expect(inner.status).toBe(200);
    expect(new TextDecoder().decode(inner.body)).toBe("ok");
  });
});

describe("BIP77 URI fragment", () => {
  it("round-trips EX/OH/RK and percent-encodes # in pj=", () => {
    const rk = genHpkeKeyPair();
    const oh = genOhttpKeyPair(1);
    const expiresAt = 1_800_000_000_000;
    const frag = encodeFragment({
      expiresAt,
      receiverKeyCompressed: rk.pkCompressed,
      ohttp: { keyId: Uint8Array.of(0, 1), compressedPub: oh.compressedPub },
    });
    expect(frag.startsWith("EX1")).toBe(true);
    expect(frag).toMatch(/-OH1/);
    expect(frag).toMatch(/-RK1/);
    const parsed = parseFragment(frag);
    expect(hex(parsed.receiverKeyCompressed!)).toBe(hex(rk.pkCompressed));
    expect(hex(parsed.ohttp!.compressedPub)).toBe(hex(oh.compressedPub));
    const pj = attachFragment("https://payjo.in/ABCDEFGH", frag);
    const uri = encodeBip21({ address: "bc1p" + "q".repeat(59), amount: 10_000n, pj, pjos: false });
    expect(uri).toMatch(/pjos=0/);
    expect(uri).toContain("%23");
    expect(uri).not.toMatch(/pj=.*#/i);
    const req = parseBip21(uri);
    expect(hex(req.receiverKey!)).toBe(hex(rk.pkCompressed));
    expect(req.ohttp?.compressedPub.length).toBe(33);
  });
});
