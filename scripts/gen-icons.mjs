import fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let pkg;
try {
  pkg = require.resolve("lucide-static/package.json");
} catch {
  console.error("lucide-static is not installed. Install it locally before regenerating icons.");
  process.exit(1);
}
const root = dirname(pkg);
const LU = join(root, "icons") + "/";
const names = `arrow-down-left arrow-left arrow-right-left arrow-up-right ban check chevron-down chevron-right circle-alert circle-check circle-dollar-sign circle-x clipboard-paste clock coins copy download external-link eye eye-off globe hard-drive history hourglass info key-round link-2 loader-circle lock lock-keyhole menu qr-code refresh-cw route scan-line server settings shield-check snowflake sun timer triangle-alert unplug x wallet file-key blocks trash-2 pencil arrow-right`.split(" ");
const out = {};
for (const n of names) {
  const s = fs.readFileSync(LU + n + ".svg", "utf8").replace(/<!--.*?-->/s, "").trim();
  const inner = s.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/\n\s*/g, "").trim();
  out[n] = inner;
}
const ver = JSON.parse(fs.readFileSync(pkg, "utf8")).version;
fs.writeFileSync("src/ui/icons.ts", `// Generated from lucide-static ${ver} (ISC license). Inner SVG markup only.\nexport const ICONS: Record<string, string> = ${JSON.stringify(out, null, 1)};\n`);
console.log(Object.keys(out).length);
