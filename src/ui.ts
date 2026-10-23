import type { WalletState } from "./lib/wallet.ts";
import type { ChainConfig } from "./lib/network.ts";
import { DEFAULT_BIRTHDAY, DEFAULT_CHAIN, DEFAULT_OHTTP_RELAY, FRACTAL } from "./lib/network.ts";
import { DEFAULT_PAYJOIN_DIRECTORY } from "./lib/payjoin.ts";

type Rpc = (msg: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

function rpc(): Rpc {
  return (msg) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        const le = chrome.runtime.lastError?.message;
        if (le) resolve({ ok: false, error: le });
        else resolve(res ?? { ok: false, error: "no response" });
      });
    });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}

function sats(n: string | undefined): string {
  if (!n) return "0";
  const v = BigInt(n);
  const whole = v / 100_000_000n;
  const frac = (v % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function mount(root: HTMLElement, opts: { settings: boolean }): void {
  const call = rpc();
  const err = el("div", { class: "err" });
  let followTimer: ReturnType<typeof setInterval> | undefined;
  let payjoinTimer: ReturnType<typeof setInterval> | undefined;
  let catchingUp = false;

  function stopFollow(): void {
    if (followTimer) {
      clearInterval(followTimer);
      followTimer = undefined;
    }
    if (payjoinTimer) {
      clearInterval(payjoinTimer);
      payjoinTimer = undefined;
    }
  }

  function patchUnlocked(st: WalletState, progress?: { done: boolean; lastHeight: number; tip: number; height: number; txIndex: number; txCount: number; skipped?: number }): boolean {
    const bal = root.querySelector("#pb-bal");
    if (!bal) return false;
    bal.textContent = sats(st.balance);
    const pend = root.querySelector("#pb-pend");
    if (pend) {
      const pending = st.pending && st.pending !== "0";
      pend.textContent = pending
        ? `${sats(st.confirmed)} confirmed · ${sats(st.pending)} incoming`
        : st.watching
          ? "Up to date"
          : "Finding your coins…";
    }
    const ck = root.querySelector("#pb-ck");
    if (ck) ck.textContent = st.payjoinStatus ?? "";
    const pj = root.querySelector("#pb-pj");
    if (pj && st.payjoinBip21) pj.textContent = st.payjoinBip21;
    if (progress) {
      err.textContent = progress.done ? "Up to date." : "Finding your coins…";
      if (!err.parentElement) root.append(err);
    }
    return true;
  }

  function startFollow(): void {
    if (followTimer) return;
    followTimer = setInterval(() => {
      void (async () => {
        const r = await call({ type: "FOLLOW_TIP" });
        if (!r.ok) return;
        const st = r.data as WalletState & {
          progress?: {
            done: boolean;
            lastHeight: number;
            tip: number;
            height: number;
            txIndex: number;
            txCount: number;
            skipped?: number;
          };
        };
        if (!patchUnlocked(st, st.progress)) stopFollow();
      })();
    }, 15_000);
  }

  function startPayjoinLoop(): void {
    if (payjoinTimer) return;
    payjoinTimer = setInterval(() => {
      void (async () => {
        const r = await call({ type: "SERVICE_PAYJOIN" });
        if (!r.ok) return;
        patchUnlocked(r.data as WalletState);
      })();
    }, 3_000);
  }

  async function refresh(): Promise<void> {
    const res = await call({ type: "STATE" });
    root.replaceChildren();
    if (!res.ok) {
      root.append(el("p", { class: "err" }, [res.error ?? "error"]));
      return;
    }
    const st = res.data as WalletState;
    paint(st);
  }

  function paint(st: WalletState): void {
    root.replaceChildren();
    const brand = el("div", { class: "brand" }, [
      el("h1", {}, ["PrivateBit"]),
      el("span", { class: "tag" }, [FRACTAL.name]),
    ]);
    root.append(brand);
    err.textContent = "";

    if (!st.hasVault) {
      stopFollow();
      const pass = el("input", { type: "password", id: "pw", placeholder: "choose a password" });
      const phrase = el("input", { type: "password", id: "pp", placeholder: "optional extra phrase" });
      const mnemonic = el("textarea", { id: "mn", placeholder: "your 12 or 24 words" });
      const birth = el("input", { type: "number", id: "bd", value: String(DEFAULT_BIRTHDAY) });
      async function birthdayForNewWallet(): Promise<number> {
        const r = await call({ type: "TIP" });
        if (!r.ok) return DEFAULT_BIRTHDAY;
        return (r.data as { height: number }).height;
      }
      const extra = el("details", { class: "more" });
      extra.append(
        el("summary", {}, ["I already have a backup"]),
        el("p", { class: "muted" }, [
          "Paste the words from this wallet. If you received coins before, keep the block number below at or before that time. Too high and those coins won't show.",
        ]),
        el("label", {}, ["Secret words"]),
        mnemonic,
        el("label", {}, ["Extra passphrase (only if you set one)"]),
        phrase,
        el("label", {}, ["Look back from block"]),
        birth,
        el("div", { class: "row" }, [
          button("Restore wallet", "ghost", async () => {
            const r = await call({
              type: "RESTORE",
              mnemonic: mnemonic.value,
              password: pass.value,
              passphrase: phrase.value,
              birthday: Number(birth.value) || DEFAULT_BIRTHDAY,
            });
            if (!r.ok) return fail(r.error);
            await refresh();
          }),
        ]),
      );
      root.append(
        el("p", { class: "muted" }, [
          "A new receive code every payment. Moving from UniSat or a reused address? Create a wallet, copy your code, send the coins here, then stop using the old address.",
        ]),
        el("label", {}, ["Password"]),
        pass,
        el("div", { class: "row" }, [
          button("Create wallet", "primary", async () => {
            if (!pass.value) return fail("Choose a password first.");
            const birthday = await birthdayForNewWallet();
            const r = await call({
              type: "CREATE",
              password: pass.value,
              passphrase: "",
              birthday,
              words: 12,
            });
            if (!r.ok) return fail(r.error);
            const mn = (r.data as { mnemonic: string }).mnemonic;
            alert(`Write these words down and keep them private.\n\n${mn}`);
            await refresh();
          }),
        ]),
        extra,
        err,
      );
      return;
    }

    if (!st.unlocked) {
      stopFollow();
      const pass = el("input", { type: "password" });
      root.append(
        el("p", { class: "muted" }, ["Vault locked."]),
        el("label", {}, ["Password"]),
        pass,
        el("div", { class: "row" }, [
          button("Unlock", "primary", async () => {
            const r = await call({ type: "UNLOCK", password: pass.value });
            if (!r.ok) return fail(r.error);
            await refresh();
          }),
        ]),
        err,
      );
      return;
    }

    async function scanToTip(): Promise<void> {
      for (;;) {
        const r = await call({ type: "SCAN" });
        if (!r.ok) return fail(r.error);
        const p = (r.data as {
          progress?: {
            done: boolean;
            lastHeight: number;
            tip: number;
            height: number;
            txIndex: number;
            txCount: number;
            skipped?: number;
          };
        }).progress;
        if (p) {
          err.textContent = p.done ? "Up to date." : "Finding your coins…";
          if (!err.parentElement) root.append(err);
        }
        if (!p || p.done) break;
      }
      await refresh();
    }
    startFollow();
    if (st.payjoinBip21) startPayjoinLoop();
    if (!st.watching && !catchingUp) {
      catchingUp = true;
      void scanToTip().finally(() => {
        catchingUp = false;
      });
    }
    const pending = st.pending && st.pending !== "0";
    const ready = Boolean(st.watching);
    root.append(
      el("p", { class: "muted" }, ["Balance"]),
      el("div", { class: "balance", id: "pb-bal" }, [sats(st.balance)]),
      el("p", { class: "muted", id: "pb-pend" }, [
        pending
          ? `${sats(st.confirmed)} confirmed · ${sats(st.pending)} incoming`
          : ready
            ? "Up to date"
            : "Finding your coins…",
      ]),
      el("p", { class: "muted", id: "pb-ck" }, [st.payjoinStatus ?? ""]),
      el("label", {}, ["Your code"]),
      el("div", { class: "addr" }, [st.receive ?? ""]),
      el("p", { class: "muted" }, [
        "Coming from UniSat or any old reused address? Send those coins to this code. When they arrive, stop using the old address. This code is Fractal — not Bitcoin.",
      ]),
      el("div", { class: "row" }, [
        button("Copy code", "primary", async () => {
          if (st.receive) await navigator.clipboard.writeText(st.receive);
        }),
        button("Lock", "ghost", async () => {
          await call({ type: "LOCK" });
          await refresh();
        }),
      ]),
    );

    const pjBox = el("pre", { class: "addr", id: "pb-pj" }, [st.payjoinBip21 ?? ""]);
    root.append(
      el("hr"),
      el("label", {}, ["Get paid by another PrivateBit user"]),
      el("p", { class: "muted" }, [
        "Creates a PrivateBit payment link (Payjoin). The other person must paste this link — a plain sp1 send cannot Payjoin. You can close this window. Lock wipes Payjoin keys and the link dies.",
      ]),
      el("div", { class: "row" }, [
        button("Create payment link", "primary", async () => {
          const r = await call({ type: "OFFER_PAYJOIN", amount: "0" });
          if (!r.ok) return fail(r.error);
          const data = r.data as WalletState & { session?: { bip21: string } };
          pjBox.textContent = data.session?.bip21 ?? data.payjoinBip21 ?? "";
          patchUnlocked(data);
          startFollow();
          startPayjoinLoop();
        }),
        button("Copy link", "ghost", async () => {
          const text = pjBox.textContent ?? st.payjoinBip21 ?? "";
          if (!text) return fail("Create a payment link first.");
          await navigator.clipboard.writeText(text);
        }),
      ]),
      pjBox,
    );

    const dest = el("textarea", { placeholder: "Paste a code or a payment link" });
    const amt = el("input", { placeholder: "Amount in sats" });
    const previewBox = el("pre", { class: "addr" }, [""]);
    let reviewed: { destination: string; amount: string; payjoin: boolean } | null = null;
    root.append(
      el("hr"),
      el("label", {}, ["Send"]),
      dest,
      amt,
      el("div", { class: "row" }, [
        button("Review", "ghost", async () => {
          if (!dest.value.trim()) return fail("Paste where to send.");
          const r = await call({ type: "PLAN", destination: dest.value, amount: amt.value || "0" });
          if (!r.ok) return fail(r.error);
          const plan = r.data as {
            previewNote?: string;
            fee?: string;
            change?: string;
            hasPayjoin?: boolean;
            preview?: { warnings: string[]; outputs: { value: string; note: string }[] };
          };
          const lines = [
            plan.previewNote ?? "",
            plan.fee ? `Fee ${plan.fee} sats` : "",
            plan.change ? `Change ${plan.change} sats` : "",
            ...(plan.preview?.warnings ?? []),
            ...(plan.preview?.outputs ?? []).map((o) => `${o.value} → ${o.note}`),
          ].filter(Boolean);
          previewBox.textContent = lines.join("\n") || "Looks correct. Confirm send.";
          reviewed = { destination: dest.value, amount: amt.value || "0", payjoin: Boolean(plan.hasPayjoin) };
        }),
        button("Confirm send", "primary", async () => {
          if (!reviewed) return fail("Review the payment first.");
          if (reviewed.destination !== dest.value || reviewed.amount !== (amt.value || "0")) {
            return fail("You changed the payment. Review again.");
          }
          const r = await call({
            type: "BROADCAST",
            intent: reviewed.payjoin ? "payjoin" : "simple-send",
            destination: dest.value,
            amount: amt.value || "0",
          });
          if (!r.ok) return fail(r.error);
          const sent = r.data as WalletState & { txid?: string; pending?: boolean };
          previewBox.textContent = sent.pending
            ? "Waiting for them to add an input. You can close this; don't lock."
            : `Sent. ${(sent.txid ?? "").slice(0, 12)}…`;
          reviewed = null;
          patchUnlocked(sent);
          if (sent.pending) {
            startFollow();
            startPayjoinLoop();
          }
        }),
      ]),
      previewBox,
      err,
    );

    if (!opts.settings) {
      root.append(
        el("div", { class: "row" }, [
          button("More", "ghost", async () => {
            chrome.runtime.openOptionsPage();
          }),
        ]),
      );
    }

    if (opts.settings) {
      const birth = el("input", {
        type: "number",
        id: "bd",
        value: String(st.birthday && st.birthday > 0 ? st.birthday : DEFAULT_BIRTHDAY),
      });
      const kind = el("select");
      for (const k of ["unisat", "core"] as const) {
        const o = el("option", { value: k }, [k === "unisat" ? "UniSat Open API" : "Your node"]);
        if (st.chain.kind === k) o.selected = true;
        kind.append(o);
      }
      const url = el("input", { value: st.chain.url || DEFAULT_CHAIN.url });
      const user = el("input", { value: st.chain.rpcUser ?? "", placeholder: "rpc user" });
      const password = el("input", { type: "password", value: st.chain.rpcPassword ?? "", placeholder: "rpc password" });
      const token = el("input", {
        type: "password",
        value: st.chain.unisatToken ?? "",
        placeholder: "API token (optional)",
      });
      const dir = el("input", {
        value: st.chain.payjoinDirectory ?? DEFAULT_PAYJOIN_DIRECTORY,
        placeholder: DEFAULT_PAYJOIN_DIRECTORY,
      });
      const relay = el("input", {
        value: st.chain.ohttpRelay ?? DEFAULT_OHTTP_RELAY,
        placeholder: DEFAULT_OHTTP_RELAY,
      });
      const details = el("details", { class: "more" });
      details.append(
        el("summary", {}, ["Advanced"]),
        el("p", { class: "muted" }, [
          `Scan from block ${st.birthday ?? "—"} · chain ${st.lastHeight ?? "—"} / ${st.tip ?? "—"}. Payment links use BIP77 HPKE (mailbox cannot read the PSBT) and OHTTP (relay hides your IP). Close the window is fine. Lock wipes those keys.`,
        ]),
        el("label", {}, ["Look back from block"]),
        birth,
        el("div", { class: "row" }, [
          button("Rescan from this block", "ghost", async () => {
            const height = Number(birth.value) || DEFAULT_BIRTHDAY;
            const r = await call({ type: "SET_BIRTHDAY", birthday: height });
            if (!r.ok) return fail(r.error);
            await scanToTip();
          }),
        ]),
        el("label", {}, ["Source"]),
        kind,
        url,
        user,
        password,
        token,
        el("label", {}, ["Payment mailbox"]),
        dir,
        el("label", {}, ["OHTTP relay"]),
        relay,
        el("div", { class: "row" }, [
          button("Save", "ghost", async () => {
            const chain: ChainConfig = {
              kind: kind.value as ChainConfig["kind"],
              url: url.value,
              rpcUser: user.value || undefined,
              rpcPassword: password.value || undefined,
              unisatToken: token.value || undefined,
              payjoinDirectory: dir.value.trim() || DEFAULT_PAYJOIN_DIRECTORY,
              ohttpRelay: relay.value.trim() || DEFAULT_OHTTP_RELAY,
            };
            for (const raw of [chain.url, chain.payjoinDirectory]) {
              if (!raw) continue;
              try {
                const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
                const origin = `${u.protocol}//${u.host}/*`;
                await chrome.permissions.request({ origins: [origin] });
              } catch {
                /* invalid URL — SAVE_CHAIN will reject */
              }
            }
            const r = await call({ type: "SAVE_CHAIN", chain });
            if (!r.ok) return fail(r.error);
          }),
        ]),
      );
      root.append(el("hr"), details);
    }
  }

  function button(label: string, cls: string, fn: () => Promise<void>): HTMLButtonElement {
    const b = el("button", { class: cls }, [label]) as HTMLButtonElement;
    b.addEventListener("click", () => void fn().catch((e) => fail(e instanceof Error ? e.message : String(e))));
    return b;
  }

  function fail(msg?: string): void {
    err.textContent = msg ?? "error";
    if (!err.parentElement) root.append(err);
  }

  void refresh();
}
