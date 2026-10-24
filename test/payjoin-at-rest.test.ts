// Audit M7: payment link sessions are encrypted at rest with the wallet's data key.
import { describe, expect, it } from "vitest";
import { PrivateBit } from "../src/lib/wallet.ts";
import { scopedName } from "../src/lib/layout.ts";
import { isSealed } from "../src/lib/datastore.ts";
import { dumpKv } from "./helpers/kv.ts";

const KEY = "privatebit.pj.sessions";
const session = (over: Record<string, unknown> = {}) => ({
  id: "aa".repeat(32),
  status: "waiting",
  createdAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  scriptPubKey: "5120" + "77".repeat(32),
  extraScriptPubKey: "5120" + "88".repeat(32),
  tweak: "99".repeat(32),
  reserved: { txid: "cd".repeat(32), vout: 1, value: "50000", scriptPubKey: "5120" + "66".repeat(32), tweak: "55".repeat(32), label: null, k: 0, height: 3 },
  ...over,
});

async function wallet() {
  const kv = dumpKv();
  const w = new PrivateBit(kv);
  await w.create({ password: "password1", birthday: 100 });
  return { kv, w, name: scopedName(w.activeId!, KEY) };
}

describe("payment link sessions at rest", () => {
  it("are written sealed; no tweak, script or reserved coin in storage", async () => {
    const { kv, w, name } = await wallet();
    await w.savePayjoinSessions([session() as never]);
    const raw = kv.dump()[name];
    expect(isSealed(raw)).toBe(true);
    const text = kv.text();
    expect(text).not.toContain("77".repeat(32));
    expect(text).not.toContain("99".repeat(32));
    expect(text).not.toContain("cd".repeat(32));
    expect((await w.loadPayjoinSessions())[0]?.id).toBe("aa".repeat(32));
  });

  it("a plaintext list from an older build is sealed on unlock and the plaintext is gone", async () => {
    const { kv, w, name } = await wallet();
    await w.lock();
    await kv.set({ [name]: [session()] });
    expect(kv.text()).toContain("99".repeat(32));
    await w.unlock("password1");
    expect(isSealed(kv.dump()[name])).toBe(true);
    expect(kv.text()).not.toContain("99".repeat(32));
    expect(kv.text()).not.toContain("cd".repeat(32));
    const back = await w.loadPayjoinSessions();
    expect(back).toHaveLength(1);
    expect(back[0]!.reserved!.txid).toBe("cd".repeat(32));
  });

  it("while locked nothing is readable or writable, and the sealed list survives intact", async () => {
    const { kv, w, name } = await wallet();
    await w.savePayjoinSessions([session()] as never);
    const before = JSON.stringify(kv.dump()[name]);
    await w.lock();
    expect(await w.loadPayjoinSessions()).toEqual([]);
    await expect(w.savePayjoinSessions([])).rejects.toThrow(/locked/);
    expect(JSON.stringify(kv.dump()[name])).toBe(before);
    await w.unlock("password1");
    expect(await w.loadPayjoinSessions()).toHaveLength(1);
  });

  it("lock clears the input secret before the data key goes", async () => {
    const { kv, w } = await wallet();
    await w.savePayjoinSessions([session({ inputSecret: "ee".repeat(32) })] as never);
    await w.lock();
    expect(kv.text()).not.toContain("ee".repeat(32));
    await w.unlock("password1");
    expect((await w.loadPayjoinSessions())[0]!.inputSecret).toBeUndefined();
  });

  it("an expired link is closed at the next unlock", async () => {
    const { w } = await wallet();
    await w.savePayjoinSessions([session({ expiresAt: Date.now() + 50 })] as never);
    await w.lock();
    await new Promise((r) => setTimeout(r, 80));
    await w.unlock("password1");
    expect((await w.loadPayjoinSessions())[0]!.status).toBe("failed");
  });
});
