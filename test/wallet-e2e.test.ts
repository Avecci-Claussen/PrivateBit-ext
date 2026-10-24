import { describe, expect, it } from "vitest";
import { PrivateBit } from "../src/lib/wallet.ts";
import { DEFAULT_CHAIN } from "../src/lib/network.ts";
import { envUnisatToken } from "./live-env.ts";
import { memoryKv } from "../src/lib/vault.ts";
import { emptyScanStore, scanRange } from "../src/lib/scan.ts";
import { accountFromVault } from "../src/lib/keys.ts";
import { loadSession } from "../src/lib/vault.ts";

const live = !!envUnisatToken();

describe.skipIf(!live)("PrivateBit first-run against UniSat", () => {
  it("creates a vault, shows an sp1 receive code, talks to UniSat, scans a small block", { timeout: 120_000 }, async () => {
    const w = new PrivateBit(memoryKv(), { ...DEFAULT_CHAIN, unisatToken: envUnisatToken() || undefined });
    const tip = await w.source().getTip();
    expect(tip.height).toBeGreaterThan(2_000_000);

    const mnemonic = await w.create({ password: "test-pw-for-local-only", birthday: tip.height });
    expect(mnemonic.split(" ").length).toBe(12);

    const st = await w.state();
    expect(st.unlocked).toBe(true);
    expect(st.receive?.startsWith("sp1")).toBe(true);
    expect(st.chain.kind).toBe("unisat");
    expect(st.chain.url).not.toMatch(/mempool/);
    expect(st.balance).toBe("0");

    const session = await loadSession(w.kv);
    expect(session).not.toBeNull();
    const account = accountFromVault(session!);
    const small = await scanRange(account, w.source(), emptyScanStore(2_228_000), 2_228_000);
    expect(small.lastHeight).toBe(2_228_000);

    await expect(w.planSend(st.receive!, 1000n)).rejects.toThrow(/no coins/);

    await w.lock();
    expect((await w.state()).unlocked).toBe(false);
    await w.unlock("test-pw-for-local-only");
    expect((await w.state()).receive).toBe(st.receive);
  });
});
