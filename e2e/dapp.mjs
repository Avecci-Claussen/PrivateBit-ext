// Website connections in the real extension (dist-e2e), offline, throwaway wallet, synthetic coins.
// The mock chain keeps "broadcast" transactions in memory; nothing reaches any network.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launch } from "./harness.mjs";
import { backupChecks, screens, SHARED } from "./paths.mjs";

const ROOT = SHARED;
const req = createRequire(join(ROOT, "package.json"));
const btc = req("@scure/btc-signer");
const { schnorr, secp256k1 } = req("@noble/curves/secp256k1");
const { sha256 } = req("@noble/hashes/sha256");
const OUT = screens("dapp");
const PAGE = readFileSync(join(ROOT, "e2e/dapp-site/index.html"));

function serve() {
  return new Promise((res) => {
    const s = createServer((q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(PAGE); });
    s.listen(0, "127.0.0.1", () => res({ s, url: `http://127.0.0.1:${s.address().port}/` }));
  });
}
const A = await serve();
const B = await serve();
const originA = new URL(A.url).origin;
const originB = new URL(B.url).origin;

const h = await launch({ out: OUT });
const { ctx, send, hook, page, ok, settle, act, open, setTheme, overflow, targets, axe, dashes, capture } = h;
const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (s) => Uint8Array.from(Buffer.from(s, "hex"));

const ob = await send({ type: "NEW_MNEMONIC" });
await send({ type: "CREATE_CHECKED", password: "throwaway-dapp", name: "Daily", checks: backupChecks(ob.mnemonic) });
await send({ type: "PREFS_SET", prefs: { priceSource: "off" } });
await hook(() => self.__pbE2E.fundOpenWallet("300000000", "Savings"));
const before = (await send({ type: "STATE" }));

const site = await ctx.newPage();
await site.goto(A.url);
// Audit M7 (independent): a site the user has not allowed cannot see PrivateBit at all.
await new Promise((r) => setTimeout(r, 1500));
ok("a new site cannot see PrivateBit", await site.evaluate(() => !("privatebit" in window) && !("unisat" in window)));
await site.bringToFront();
await send({ type: "DAPP_SHOW", origin: originA });
await site.waitForFunction(() => !!window.privatebit, null, { timeout: 10000 });
await site.reload();
await site.waitForFunction(() => !!window.privatebit, null, { timeout: 10000 });
ok("after the user allows it, the site sees PrivateBit, also after a reload", true);
const call = (method, ...params) => site.evaluate(async ([m, p]) => { try { return { ok: true, v: await window.privatebit[m](...p) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } }, [method, params]);
const start = (method, ...params) => site.evaluate(([m, p]) => { window.__r = window.privatebit[m](...p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, msg: e.message })); }, [method, params]);
const result = () => site.evaluate(() => window.__r);
const popups = [];
ctx.on("page", (x) => popups.push(x));
async function approvalWindow() {
  let p;
  for (let i = 0; i < 150 && !p; i++) {
    const at = popups.findIndex((x) => x.url().includes("popup.html#dapp="));
    if (at >= 0) p = popups.splice(at, 1)[0];
    else await new Promise((r) => setTimeout(r, 100));
  }
  if (!p) throw new Error("no approval window");
  await p.waitForLoadState();
  await p.waitForSelector("[data-act=dapp-approve], [data-act=dapp-close], #pw", { timeout: 15000 });
  await settle(p, 500);
  return p;
}
const shotPopup = async (p, label) => {
  for (const theme of ["dark", "light"]) {
    await setTheme(theme, p);
    await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme).catch(() => {});
    await p.reload(); await p.waitForSelector("[data-act=dapp-approve], #pw", { timeout: 15000 }); await settle(p, 500);
    for (const w of [380, 375]) {
      await p.setViewportSize({ width: w, height: 640 }); await settle(p, 250);
      await overflow(`${label} ${theme} ${w}`, p);
      await p.screenshot({ path: join(OUT, `${label}-${theme}-${w}.png`), fullPage: true });
    }
    if (theme === "dark") { await targets(label, p); await axe(label, p); await dashes(label, p); }
  }
  await setTheme("dark", p);
};

// Provider present, compatibility name set, nothing exposed before approval.
ok("provider injected as window.privatebit", await site.evaluate(() => !!window.privatebit?.isPrivateBit));
ok("compatibility name points to the same provider", await site.evaluate(() => window.unisat === window.privatebit));
let r = await call("getAccounts");
ok("getAccounts before connect is empty", r.ok && Array.isArray(r.v) && r.v.length === 0, JSON.stringify(r));
r = await call("getBalance");
ok("getBalance before connect is refused (4100)", !r.ok && r.code === 4100, JSON.stringify(r));
r = await call("getPublicKey");
ok("getPublicKey before connect is refused", !r.ok && r.code === 4100);
r = await call("getChain");
ok("getChain before connect is refused", !r.ok && r.code === 4100);
r = await site.evaluate(async () => { try { await window.privatebit.request("eth_requestAccounts"); } catch (e) { return e.code; } });
ok("unknown method is unsupported (4200)", r === 4200, String(r));
r = await site.evaluate(async () => { try { await window.privatebit.request("signPsbt", ["zz"]); } catch (e) { return e.code; } });
ok("malformed params rejected (-32602)", r === -32602, String(r));

// Connect: reject first.
await start("requestAccounts");
let w = await approvalWindow();
let t = await w.locator("body").innerText();
ok("connect popup shows the origin", t.includes(new URL(A.url).host), t.slice(0, 200));
ok("connect popup lists what the site will not see", /will not see/i.test(t) && /receive code/i.test(t));
await shotPopup(w, "connect");
await w.click("[data-act=dapp-reject]");
r = await result();
ok("connect rejected returns 4001", !r.ok && r.code === 4001, JSON.stringify(r));
r = await call("getAccounts");
ok("still no accounts after reject", r.ok && r.v.length === 0);

// Connect: approve.
await start("requestAccounts");
w = await approvalWindow();
await w.click("[data-act=dapp-approve]");
r = await result();
const addr = r.ok ? r.v[0] : "";
ok("connect approved returns one Taproot address", r.ok && r.v.length === 1 && /^bc1p/.test(addr), JSON.stringify(r));
const info = await hook((o) => self.__pbE2E.siteInfo(o), originA);
ok("site address is the per-site account", info?.address === addr, JSON.stringify(info));
ok("site path is m/86'/8228'/i'/0/0 with i >= 2^30", /^m\/86'\/8228'\/(\d+)'\/0\/0$/.test(info.path) && Number(info.path.split("/")[3].replace("'", "")) >= 2 ** 30, info.path);
ok("site address is not the receive code", !String(before.receive ?? "").includes(addr));
r = await call("getAccounts");
ok("getAccounts after connect", r.ok && r.v[0] === addr);
r = await call("getNetwork");
ok("getNetwork is livenet", r.ok && r.v === "livenet");
r = await call("getChain");
ok("getChain names Fractal", r.ok && r.v.enum === "FRACTAL_BITCOIN_MAINNET", JSON.stringify(r.v));
r = await call("getPublicKey");
const pub = r.v;
ok("getPublicKey is a 33 byte key", r.ok && /^0[23][0-9a-f]{64}$/.test(pub));
r = await call("getInscriptions", 0, 10);
ok("getInscriptions is refused clearly, never a fake empty list", !r.ok && /does not read inscriptions/.test(r.msg ?? ""));

// Balance only of the site account.
r = await call("getBalance");
ok("site balance starts at 0, private coins not visible", r.ok && r.v.total === 0, JSON.stringify(r.v));
const coin = await hook((o) => self.__pbE2E.fundSite(o, "40000"), originA);
r = await call("getBalance");
ok("getBalance shows the funded site coin", r.ok && r.v.total === 40000 && r.v.confirmed === 40000, JSON.stringify(r.v));
const after = await send({ type: "STATE" });
ok("private balance unchanged by the site coin", after.balance === before.balance, `${before.balance} -> ${after.balance}`);
const coinsList = await send({ type: "COINS" });
ok("site coin is not in the private coin list", !coinsList.some((c) => c.outpoint === `${coin.txid}:0`));

// signMessage, ECDSA, with the exact text shown.
const MSG = "Sign in to Sample dApp\nnonce: 42";
await start("signMessage", MSG, "ecdsa");
w = await approvalWindow();
t = await w.locator(".msgbox").innerText();
ok("message shown exactly", t === MSG, JSON.stringify(t));
await shotPopup(w, "sign-message");
// Second request from the same site while one waits.
r = await call("signMessage", "again");
ok("one pending approval per site (-32002)", !r.ok && r.code === -32002, JSON.stringify(r));
await w.click("[data-act=dapp-approve]");
r = await result();
let sigOk = false;
if (r.ok) {
  const b = Buffer.from(r.v, "base64");
  const enc = new TextEncoder();
  const m = enc.encode(MSG);
  const pre = Buffer.concat([Buffer.from("\x18Bitcoin Signed Message:\n", "latin1"), Buffer.from([m.length]), Buffer.from(m)]);
  const hsh = sha256(sha256(pre));
  const sig = secp256k1.Signature.fromCompact(b.subarray(1)).addRecoveryBit(b[0] - 31);
  sigOk = sig.recoverPublicKey(hsh).toHex(true) === pub;
}
ok("ECDSA signature recovers the site public key", sigOk, JSON.stringify(r).slice(0, 120));
await start("signMessage", "hello", "bip322-simple");
w = await approvalWindow();
await w.click("[data-act=dapp-approve]");
r = await result();
ok("BIP322 simple signature is one 64 byte witness item", r.ok && Buffer.from(r.v, "base64").length === 66 && Buffer.from(r.v, "base64")[0] === 1);

// signPsbt spending the funded site coin.
const NET = { bech32: "bc", pubKeyHash: 0, scriptHash: 5, wif: 0x80 };
const otherScript = "5120" + hex(schnorr.getPublicKey(fromHex("11".repeat(32))));
const otherAddr = btc.Address(NET).encode(btc.OutScript.decode(fromHex(otherScript)));
function psbt(inputs, outputs) {
  const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  for (const i of inputs) tx.addInput({ txid: i.txid, index: i.vout, witnessUtxo: { script: fromHex(i.script), amount: BigInt(i.value) } });
  for (const o of outputs) tx.addOutput({ script: fromHex(o.script), amount: BigInt(o.value) });
  return hex(tx.toPSBT());
}
const p1 = psbt([coin], [{ script: otherScript, value: 15000 }, { script: coin.script, value: 24000 }]);
await start("signPsbt", p1, { autoFinalized: true });
w = await approvalWindow();
t = await w.locator("body").innerText();
ok("sign review shows what leaves, what returns and the fee", /Leaves this site's account/i.test(t) && /Back to the site account/i.test(t) && /16,000\ssats/.test(t) && /1,000\ssats/.test(t), t.slice(0, 900));
ok("sign review names the chain", /Fractal/.test(t));
await shotPopup(w, "sign-psbt");
await w.click("[data-act=dapp-approve]");
r = await result();
let psbtOk = false;
if (r.ok) {
  const tx = btc.Transaction.fromPSBT(fromHex(r.v), { allowUnknownOutputs: true, disableScriptCheck: true });
  const wit = tx.getInput(0).finalScriptWitness;
  const pre = tx.preimageWitnessV1(0, [fromHex(coin.script)], 0, [40000n]);
  psbtOk = !!wit && wit.length === 1 && schnorr.verify(wit[0], pre, fromHex(info.output));
}
ok("signPsbt returns a finalized PSBT with a valid key path signature", psbtOk, JSON.stringify(r).slice(0, 160));

// signPsbts, not finalized.
await start("signPsbts", [p1, p1], [{ autoFinalized: false }, { autoFinalized: false }]);
w = await approvalWindow();
ok("signPsbts shows each transaction", /Transaction 2 of 2/i.test(await w.locator("body").innerText()));
await w.click("[data-act=dapp-approve]");
r = await result();
ok("signPsbts returns two PSBTs with tapKeySig", r.ok && r.v.length === 2 && r.v.every((x) => btc.Transaction.fromPSBT(fromHex(x), { allowUnknownOutputs: true, disableScriptCheck: true }).getInput(0).tapKeySig?.length === 64));

// Refusal: a private coin as input.
const priv = await hook(() => self.__pbE2E.privateCoin());
const p2 = psbt([coin, priv], [{ script: otherScript, value: 50000 }]);
await start("signPsbt", p2);
w = await approvalWindow();
t = await w.locator("body").innerText();
ok("private coin input is refused", /will not sign this/i.test(t) && /private balance/i.test(t), t.slice(0, 300));
ok("Sign button disabled when refused", await w.locator("[data-act=dapp-approve]").isDisabled());
await shotPopup(w, "sign-refused");
await w.click("[data-act=dapp-reject]");
r = await result();
ok("refused request ends as 4001", !r.ok && r.code === 4001);
// Direct approval attempt through the background is refused too.
await start("signPsbt", p2);
w = await approvalWindow();
const id = new URL(w.url()).hash.slice(6);
let threw = "";
try { await send({ type: "DAPP_DECIDE", id, approve: true }); } catch (e) { threw = String(e.message); }
ok("background refuses to sign private coins even if approved", /private balance/i.test(threw), threw);
r = await result();
ok("page gets an error", !r.ok);

// Unknown input warning + sighash warning.
const foreign = { txid: "ab".repeat(32), vout: 1, script: otherScript, value: "7000" };
const p3 = (() => {
  const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  tx.addInput({ txid: coin.txid, index: 0, witnessUtxo: { script: fromHex(coin.script), amount: 40000n } });
  tx.addInput({ txid: foreign.txid, index: 1, witnessUtxo: { script: fromHex(otherScript), amount: 7000n } });
  tx.addOutput({ script: fromHex(otherScript), amount: 46000n });
  return hex(tx.toPSBT());
})();
await start("signPsbt", p3, { toSignInputs: [{ index: 0, address: addr, sighashTypes: [0x81] }] });
w = await approvalWindow();
t = await w.locator("body").innerText();
ok("warns about inputs that are not yours", /Input 1 is not yours/.test(t) || /Not yours/.test(t));
ok("warns about ALL|ANYONECANPAY", /ALL\|ANYONECANPAY/.test(t));
await shotPopup(w, "sign-warnings");
await w.click("[data-act=dapp-reject]");
await result();

// A seller listing uses SINGLE|ANYONECANPAY. The review warns, and the locked output is the one at the signed input.
await start("signPsbt", p3, { toSignInputs: [{ index: 0, address: addr, sighashTypes: [0x83] }] });
w = await approvalWindow();
t = await w.locator("body").innerText();
ok("warns about SINGLE|ANYONECANPAY instead of refusing the listing", /SINGLE\|ANYONECANPAY/.test(t) && !/will not sign this/i.test(t), t.slice(0, 400));
await w.click("[data-act=dapp-reject]");
await result();

// Closing the popup rejects.
await start("signMessage", "close me");
w = await approvalWindow();
await w.close();
r = await result();
ok("closing the popup rejects (4001)", !r.ok && r.code === 4001, JSON.stringify(r));

// sendBitcoin from the site account (mock chain keeps it).
await hook(() => self.__pbE2E.acceptBroadcasts(true));
await start("sendBitcoin", otherAddr, 5000, { feeRate: 2, memo: "sample" });
w = await approvalWindow();
t = await w.locator("body").innerText();
ok("send review shows amount, fee and change back to the site", /Back to the site account/.test(t) && /sample/.test(t));
await shotPopup(w, "send");
await w.click("[data-act=dapp-approve]");
r = await result();
ok("sendBitcoin returns a txid", r.ok && /^[0-9a-f]{64}$/.test(r.v), JSON.stringify(r));
const seen = await hook(() => self.__pbE2E.seenBroadcasts());
const sent = seen.length ? btc.Transaction.fromRaw(fromHex(seen[seen.length - 1]), { allowUnknownOutputs: true }) : null;
ok("sent tx spends only the site coin", sent?.inputsLength === 1 && hex(sent.getInput(0).txid) === coin.txid);
ok("change returns to the same site account", !!sent && [...Array(sent.outputsLength).keys()].some((i) => hex(sent.getOutput(i).script) === coin.script));
r = await call("getBalance");
ok("site balance after the send", r.ok && r.v.total > 0 && r.v.total < 35000, JSON.stringify(r.v));
const after2 = await send({ type: "STATE" });
ok("private balance still unchanged", after2.balance === before.balance);
await hook(() => self.__pbE2E.acceptBroadcasts(false));

// Second site: separate account, sees nothing of the first.
// The "every website" switch shows PrivateBit to a site that was never allowed.
await send({ type: "DAPP_SET_VISIBILITY", all: true });
const siteB = await ctx.newPage();
await siteB.goto(B.url);
await siteB.waitForFunction(() => !!window.privatebit);
await send({ type: "DAPP_SET_VISIBILITY", all: false });
await siteB.evaluate(() => { window.__r = window.privatebit.requestAccounts().then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code })); });
w = await approvalWindow();
await w.click("[data-act=dapp-approve]");
const rb = await siteB.evaluate(() => window.__r);
ok("second site gets a different account", rb.ok && rb.v[0] !== addr && /^bc1p/.test(rb.v[0]));
ok("second site balance is its own (0)", (await siteB.evaluate(() => window.privatebit.getBalance())).total === 0);
const p4 = psbt([coin], [{ script: otherScript, value: 30000 }]);
await siteB.evaluate((p) => { window.__r = window.privatebit.signPsbt(p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code })); }, p4);
w = await approvalWindow();
t = await w.locator("body").innerText();
ok("site B cannot sign site A's coin", /another website/i.test(t) && (await w.locator("[data-act=dapp-approve]").isDisabled()), t.slice(0, 200));
await w.click("[data-act=dapp-reject]");

// Connected sites in Settings (full page and popup).
await page.bringToFront();
await capture("sites", (p) => open(p, "set-sites"), { widths: [375, 768, 1280, 1440] });
const st = await h.text(page);
ok("Connected sites lists both sites", st.includes(new URL(A.url).host) && st.includes(new URL(B.url).host));
await capture("site-detail", (p) => open(p, "site-detail", { origin: originA }), { widths: [375, 768, 1280, 1440] });
ok("site detail shows the per-site address and path", (await h.text(page)).includes("m/86'/8228'"));
await capture("settings-full", (p) => open(p, "settings"), { widths: [1280, 1440], popup: false });

// Chain switch: approval, events, per-chain account.
await site.evaluate(() => { window.__events = []; });
await start("switchChain", "BITCOIN_MAINNET");
w = await approvalWindow();
await shotPopup(w, "switch-chain");
await w.click("[data-act=dapp-approve]");
r = await result();
ok("switchChain approved", r.ok && r.v.enum === "BITCOIN_MAINNET", JSON.stringify(r));
await site.waitForTimeout(2200);
let ev = await site.evaluate(() => window.__events);
const acc = ev.find((e) => e[0] === "accountsChanged");
ok("chainChanged event to Bitcoin", ev.some((e) => e[0] === "chainChanged" && e[1].enum === "BITCOIN_MAINNET"), JSON.stringify(ev));
ok("networkChanged event", ev.some((e) => e[0] === "networkChanged" && e[1] === "livenet"));
ok("accountsChanged with the Bitcoin site account", !!acc && acc[1][0] && acc[1][0] !== addr);
const infoBtc = await hook((o) => self.__pbE2E.siteInfo(o), originA);
ok("Bitcoin site path is m/86'/0'/i'/0/0, same index", infoBtc.path === info.path.replace("8228'", "0'"), infoBtc.path);
r = await call("getBalance");
ok("Bitcoin site balance is separate (0)", r.ok && r.v.total === 0);
const coinB = await hook((o) => self.__pbE2E.fundSite(o, "25000"), originA);
const p5 = psbt([coinB], [{ script: otherScript, value: 20000 }, { script: coinB.script, value: 4000 }]);
await start("signPsbt", p5);
w = await approvalWindow();
ok("Bitcoin review names Bitcoin", /Bitcoin/.test(await w.locator("body").innerText()));
await w.click("[data-act=dapp-approve]");
r = await result();
ok("signPsbt works on Bitcoin", r.ok);
await start("signMessage", "on bitcoin", "ecdsa");
w = await approvalWindow();
await w.click("[data-act=dapp-approve]");
ok("signMessage works on Bitcoin", (await result()).ok);
// Switch back from Settings: pages hear it too.
await site.evaluate(() => { window.__events = []; });
await send({ type: "SET_NETWORK", network: "fractal" });
await site.waitForTimeout(2200);
ev = await site.evaluate(() => window.__events);
ok("Settings chain switch sends chainChanged and accountsChanged", ev.some((e) => e[0] === "chainChanged" && e[1].enum === "FRACTAL_BITCOIN_MAINNET") && ev.some((e) => e[0] === "accountsChanged" && e[1][0] === addr), JSON.stringify(ev));

// Lock: accounts go empty, reads wait for unlock.
await site.evaluate(() => { window.__events = []; });
await send({ type: "LOCK" });
await site.waitForTimeout(2200);
ev = await site.evaluate(() => window.__events);
ok("lock sends accountsChanged []", ev.some((e) => e[0] === "accountsChanged" && e[1].length === 0), JSON.stringify(ev));
r = await call("getAccounts");
ok("getAccounts while locked is empty", r.ok && r.v.length === 0);
await start("getBalance");
await site.waitForTimeout(800);
const waitingNow = await site.evaluate(() => Promise.race([window.__r, new Promise((res) => setTimeout(() => res("waiting"), 300))]));
ok("getBalance waits while locked", waitingNow === "waiting", JSON.stringify(waitingNow));
// A connect request while locked shows unlock first in its window.
await siteB.evaluate(() => { window.__r = window.privatebit.signMessage("after unlock").then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code })); });
w = await approvalWindow();
ok("locked request window asks to unlock first", (await w.locator("#pw").count()) === 1);
await shotPopup(w, "locked");
await w.fill("#pw", "throwaway-dapp");
await w.click("[data-act=unlock]");
await w.waitForSelector("[data-act=dapp-approve]", { timeout: 15000 });
ok("after unlock the same window shows the request", (await w.locator(".msgbox").innerText()) === "after unlock");
r = await result();
ok("waiting getBalance answers after unlock", r.ok && r.v.total > 0, JSON.stringify(r));
await w.click("[data-act=dapp-approve]");
ok("signMessage after unlock", (await siteB.evaluate(() => window.__r)).ok);
await site.waitForTimeout(800);
ev = await site.evaluate(() => window.__events);
ok("unlock sends accountsChanged with the account", ev.some((e) => e[0] === "accountsChanged" && e[1][0] === addr), JSON.stringify(ev));

// Rate limit.
const burst = await site.evaluate(async () => { const rs = await Promise.allSettled(Array.from({ length: 45 }, () => window.privatebit.getAccounts())); return rs.filter((x) => x.status === "rejected" && x.reason.code === -32002).length; });
ok("requests are rate limited", burst > 0, `${burst} limited`);
await site.waitForTimeout(10500);

// Disconnect from Settings.
await site.evaluate(() => { window.__events = []; });
await open(page, "site-detail", { origin: originA });
await page.click("[data-act=site-disconnect]");
await site.waitForTimeout(2200);
ev = await site.evaluate(() => window.__events);
ok("disconnect sends accountsChanged []", ev.some((e) => e[0] === "accountsChanged" && e[1].length === 0), JSON.stringify(ev));
r = await call("getAccounts");
ok("getAccounts after disconnect is empty", r.ok && r.v.length === 0);
r = await call("getBalance");
ok("getBalance after disconnect is refused", !r.ok && r.code === 4100);
await capture("site-disconnected", (p) => open(p, "site-detail", { origin: originA }), { widths: [375, 1280], popup: false });
// Reconnect gives the same account.
await start("requestAccounts");
w = await approvalWindow();
await w.click("[data-act=dapp-approve]");
r = await result();
ok("reconnect returns the same deterministic account", r.ok && r.v[0] === addr);
// Page-initiated disconnect.
r = await call("disconnect");
ok("page can disconnect itself", r.ok && (await call("getAccounts")).v.length === 0);

// Add funds review carries the on-chain link note and label.
await open(page, "site-detail", { origin: originA });
await page.click("[data-act=site-fund]");
await settle(page, 600);
ok("Add funds prefills the site address and label", (await page.inputValue("#to")) === addr && (await page.inputValue("#lbl")).startsWith("Moved to site account"));

// Move back to private: site coins go to the receive code, labeled in history.
await hook(() => self.__pbE2E.acceptBroadcasts(true));
const siteBal = (await send({ type: "DAPP_SITES" })).find((x) => x.origin === originA).balance;
const plan = await send({ type: "SITE_MOVE_PLAN", origin: originA, feeRate: 2 });
ok("move back plan sweeps the site account", BigInt(plan.amount) + BigInt(plan.fee) === BigInt(siteBal), JSON.stringify(plan));
const moved = await send({ type: "SITE_MOVE", origin: originA, feeRate: 2 });
ok("move back broadcast (mock chain)", moved.kind === "txid", JSON.stringify(moved));
const seen2 = await hook(() => self.__pbE2E.seenBroadcasts());
const mtx = btc.Transaction.fromRaw(fromHex(seen2[seen2.length - 1]), { allowUnknownOutputs: true });
ok("move back spends only site coins, one output", mtx.inputsLength >= 1 && mtx.outputsLength === 1 && [...Array(mtx.inputsLength).keys()].every((i) => !priv || hex(mtx.getInput(i).txid) !== priv.txid));
const after3 = await send({ type: "STATE" });
ok("private balance grows by the moved amount", BigInt(after3.balance) === BigInt(before.balance) + BigInt(plan.amount), `${before.balance} -> ${after3.balance}`);
const hist = await send({ type: "HISTORY" });
ok("history labels the move", JSON.stringify(hist).includes("Moved from site account 127.0.0.1"), JSON.stringify(hist).slice(0, 200));
ok("site account empty after the move", (await send({ type: "DAPP_SITES" })).find((x) => x.origin === originA).balance === 0);
await hook(() => self.__pbE2E.acceptBroadcasts(false));

// Page in an http(s) page only: extension pages and file pages have no provider (manifest matches).
await h.finish();
A.s.close(); B.s.close();
