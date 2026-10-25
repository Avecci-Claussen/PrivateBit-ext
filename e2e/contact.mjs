// Builds a contact sheet (HTML plus one PNG per group) from every screenshot in screens/.
import { chromium } from "playwright";
import { readdirSync, writeFileSync } from "node:fs";
import { chromePath, screens } from "./paths.mjs";
const DIR = screens();
const files = readdirSync(DIR).filter((f) => f.endsWith(".png") && !f.startsWith("contact-sheet"));
const groups = {
  popup: files.filter((f) => f.startsWith("popup-")),
  "full-wallets-switcher": files.filter((f) => /^full-(wallets|home-switcher|switcher-open|switch-confirm|remove)/.test(f)),
  "full-payjoin": files.filter((f) => f.startsWith("full-payjoin")),
  "full-settings": files.filter((f) => f.startsWith("full-settings")),
};
const page = (names) => `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#222;font:12px system-ui;color:#eee}
.g{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}figure{margin:0;background:#333;padding:6px;border-radius:6px}
img{width:100%;height:340px;object-fit:contain;object-position:top;background:#111}figcaption{padding-top:4px}</style>
<div class="g">${names.sort().map((n) => `<figure><img src="file://${DIR}/${n}"><figcaption>${n.replace(".png", "")}</figcaption></figure>`).join("")}</div>`;
const b = await chromium.launch({ executablePath: chromePath(), args: ["--allow-file-access-from-files"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
let index = `<!doctype html><meta charset="utf-8"><title>PrivateBit screens</title><style>body{font:14px system-ui;background:#222;color:#eee;padding:16px}img{max-width:100%}</style>`;
for (const [name, list] of Object.entries(groups)) {
  const html = `${DIR}/contact-sheet-${name}.html`;
  writeFileSync(html, page(list));
  await p.goto(`file://${html}`);
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${DIR}/contact-sheet-${name}.png`, fullPage: true });
  index += `<h2>${name} (${list.length})</h2><img src="contact-sheet-${name}.png">`;
}
writeFileSync(`${DIR}/contact-sheet.html`, index);
await b.close();
console.log(Object.entries(groups).map(([k, v]) => `${k}: ${v.length}`).join(", "), `total ${files.length}`);
