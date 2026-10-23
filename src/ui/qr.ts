import QR from "qrcode";
import { raw, type Safe } from "./kit.ts";

/** QR as inline SVG. Dark modules on white so phone cameras read it in both themes. */
export function qrSvg(text: string, label = "QR code of the text shown below"): Safe {
  const q = QR.create(text, { errorCorrectionLevel: "M" });
  const n = q.modules.size;
  const d = q.modules.data;
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (d[y * n + x]) {
        let w = 1;
        while (x + w < n && d[y * n + x + w]) w++;
        path += `M${x} ${y}h${w}v1h-${w}z`;
        x += w - 1;
      }
    }
  }
  const esc = label.replace(/"/g, "&quot;");
  return raw(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${esc}"><rect width="${n}" height="${n}" fill="#ffffff"/><path fill="#110c26" d="${path}"/></svg>`,
  );
}
