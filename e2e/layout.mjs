// Centered main column in the full page view, at wide widths too.
import { launch } from "./harness.mjs";
import { screens } from "./paths.mjs";
const OUT = screens("dapp");
const h = await launch({ out: OUT });
const { send, hook, open, page, ok, capture } = h;
await send({ type: "NEW_MNEMONIC" });
await send({ type: "CREATE_CHECKED", password: "throwaway-layout", name: "Daily" });
await send({ type: "PREFS_SET", prefs: { priceSource: "off" } });
await hook(() => self.__pbE2E.fundOpenWallet("200000000"));
const W = [375, 768, 1280, 1440, 1920];
for (const route of ["home", "send", "settings", "activity"]) {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await open(page, route);
  const m = await page.evaluate(() => { const a = document.querySelector("aside.side").getBoundingClientRect(); const c = document.querySelector("main.content").getBoundingClientRect(); return { left: c.left - a.right, right: innerWidth - c.right }; });
  ok(`centered at 1920: ${route}`, Math.abs(m.left - m.right) <= 2, JSON.stringify(m));
  await capture(`layout-${route}`, (p) => open(p, route), { widths: W, popup: route === "home" });
}
await h.finish();
