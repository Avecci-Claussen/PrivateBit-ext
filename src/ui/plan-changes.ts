import { fb, sats } from "./kit.ts";
import type { PlanPayload } from "../lib/send.ts";

/** Plain words for what differs between the reviewed plan and the one that would be sent now. */
export function planChanges(before: PlanPayload, now: PlanPayload): string[] {
  const out: string[] = [];
  if (before.amount !== now.amount) out.push(`The amount is now ${fb(now.amount)} (it was ${fb(before.amount)}).`);
  if (before.fee !== now.fee) out.push(`The network fee is now ${sats(now.fee)} (it was ${sats(before.fee)}).`);
  const a = [...before.inputs].sort().join(",");
  const b = [...now.inputs].sort().join(",");
  if (a !== b) out.push("Different coins pay for it, because your coins changed after you reviewed.");
  if (before.change !== now.change && before.fee === now.fee && before.amount === now.amount) out.push(`The change back to you is now ${fb(now.change)}.`);
  if (!out.length) out.push("The payment details changed after you reviewed.");
  return out;
}
