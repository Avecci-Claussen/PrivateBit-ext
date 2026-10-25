import { html, I, mid, curNet, explorerHost, type Safe } from "./kit.ts";

export type PathLeg = { title: string; sub?: string };

/** From → to, shown on every transacting step so the user always sees who is paying whom. */
export function pathPreview(from: PathLeg, to: PathLeg): Safe {
  const leg = (k: string, p: PathLeg) =>
    html`<div class="path-leg"><span class="path-k">${k}</span><span class="path-t">${p.title}</span>${p.sub ? html`<span class="path-d">${p.sub}</span>` : ""}</div>`;
  return html`<div class="card path" aria-label="From and to">
  ${leg("From", from)}
  <div class="path-join" aria-hidden="true">${I("arrow-down", "s16")}</div>
  ${leg("To", to)}
</div>`;
}

export function txidLine(txid: string): Safe {
  return html`<div class="r"><span class="k">Transaction</span><span class="v"><span class="mono">${mid(txid, 10, 8)}</span><button class="link small" type="button" data-act="copy-act-txid">Copy</button></span></div>`;
}

/** Ask before opening the explorer: it learns the user's IP and which tx they looked at. */
export function explorerBlock(askOpen: boolean, askFirst: boolean, net: "fractal" | "bitcoin" = curNet()): Safe {
  const host = explorerHost(net);
  if (askOpen) {
    return html`<div class="banner warn" role="alert">${I("globe", "s16")}<div><span class="bt">Open ${host}?</span>It learns your IP and which transaction you looked at. <span class="row" data-st="62ee93"><button class="btn btn-primary btn-sm" type="button" data-act="explorer-open">Open</button><button class="btn btn-ghost btn-sm" type="button" data-act="explorer-cancel">Cancel</button></span></div></div>`;
  }
  return html`<button class="btn btn-secondary btn-block" type="button" data-act="explorer">${I("external-link", "s16")}View on ${host}</button>
  <p class="cap">Opening an explorer tells it your IP and which transaction you looked at.${askFirst ? " PrivateBit asks first." : ""}</p>`;
}
