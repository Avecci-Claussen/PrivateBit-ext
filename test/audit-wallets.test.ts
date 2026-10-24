// Step 7: failure cases for the multi-wallet manager (audit findings on remove, rename, switch).
import { describe, expect, it } from "vitest";
import { createMnemonic } from "../src/lib/vault.ts";
import { PrivateBit } from "../src/lib/wallet.ts";
import { dumpKv } from "./helpers/kv.ts";

async function three() {
  const kv = dumpKv();
  const w = new PrivateBit(kv);
  const wordsA = await w.create({ password: "pw-a-1234", birthday: 100 });
  const a = w.activeId!;
  const wordsB = createMnemonic(256);
  await w.addWallet({ mnemonic: wordsB, password: "pw-b-1234", birthday: 100, kind: "import", name: "B" });
  const b = w.activeId!;
  await w.addWallet({ mnemonic: createMnemonic(256), password: "pw-c-1234", birthday: 100, kind: "create", name: "C" });
  const c = w.activeId!;
  return { kv, w, a, b, c, wordsA, wordsB };
}

describe("audit: removing and managing wallets", () => {
  it("removes a wallet that is not open, by id, with that wallet's own password", async () => {
    const { kv, w, b, c, wordsB } = await three();
    const res = await w.removeWallet("pw-b-1234", b);
    expect(res).toEqual({ wiped: false, removedOpen: false });
    const st = await w.state();
    expect(st.wallets!.map((x) => x.name)).not.toContain("B");
    expect(st.wallets).toHaveLength(2);
    expect(w.activeId).toBe(c);
    expect(st.unlocked).toBe(true); // the open wallet was not touched
    expect(Object.keys(kv.dump()).some((k) => k.includes(`.w.${b}.`))).toBe(false);
    expect(kv.text()).not.toContain(wordsB);
  });

  it("refuses to remove another wallet with the open wallet's password", async () => {
    const { w, b } = await three();
    await expect(w.removeWallet("pw-c-1234", b)).rejects.toThrow(/wrong password/);
    expect((await w.state()).wallets).toHaveLength(3);
  });

  it("refuses an unknown wallet id", async () => {
    const { w } = await three();
    await expect(w.removeWallet("pw-c-1234", "ffffffffffffffff")).rejects.toThrow(/no such wallet/);
    await expect(w.checkWalletPassword("ffffffffffffffff", "x")).rejects.toThrow();
  });

  it("checks a closed wallet's password without opening it", async () => {
    const { w, a, c } = await three();
    await w.checkWalletPassword(a, "pw-a-1234");
    await expect(w.checkWalletPassword(a, "pw-c-1234")).rejects.toThrow(/wrong password/);
    expect(w.activeId).toBe(c);
    expect((await w.state()).unlocked).toBe(true);
  });

  it("removing the open wallet of three leaves two, one opened locked, both intact", async () => {
    const { w, a, b } = await three();
    const res = await w.removeWallet("pw-c-1234");
    expect(res).toEqual({ wiped: false, removedOpen: true });
    const st = await w.state();
    expect(st.wallets!.map((x) => x.id).sort()).toEqual([a, b].sort());
    expect(st.unlocked).toBe(false);
    await w.openWallet(b);
    await w.unlock("pw-b-1234");
    await w.openWallet(a);
    await w.unlock("pw-a-1234");
  });

  it("rename trims, caps at 40 characters, and refuses an empty name", async () => {
    const { w, a } = await three();
    await w.renameWallet(a, "   Daily    spending   ");
    expect((await w.state()).wallets!.find((x) => x.id === a)!.name).toBe("Daily spending");
    await w.renameWallet(a, "x".repeat(80));
    expect((await w.state()).wallets!.find((x) => x.id === a)!.name).toHaveLength(40);
    await expect(w.renameWallet(a, "   ")).rejects.toThrow(/name/);
    await expect(w.renameWallet("ffffffffffffffff", "Z")).rejects.toThrow(/no such wallet/);
  });

  it("switching locks the open wallet and leaves no words in storage", async () => {
    const { kv, w, a, wordsA } = await three();
    await w.openWallet(a);
    expect((await w.state()).unlocked).toBe(false);
    expect(kv.text()).not.toContain(wordsA);
  });
});
