import type { Kv } from "./lib/vault.ts";
import { baseName } from "./lib/layout.ts";

const SESSION_KEYS = new Set([
  "privatebit.session",
  "privatebit.scan.grant",
  "privatebit.pj.hpke",
  "privatebit.pj.send",
  "privatebit.pj.grant",
  "privatebit.btc.pj.grant",
  "privatebit.btc.scan.grant",
  "privatebit.btc.pj.hpke",
  "privatebit.btc.pj.send",
  "privatebit.activity",
  "privatebit.lockinfo",
  "privatebit.health",
  "privatebit.onboard",
  "privatebit.fees",
]);

export function chromeKv(): Kv {
  return {
    async get(keys) {
      const [local, session] = await Promise.all([
        chrome.storage.local.get(keys),
        chrome.storage.session.get(keys),
      ]);
      return { ...local, ...session };
    },
    async set(items) {
      const session: Record<string, unknown> = {};
      const local: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(items)) {
        (SESSION_KEYS.has(baseName(k)) ? session : local)[k] = v;
      }
      if (Object.keys(local).length) await chrome.storage.local.set(local);
      if (Object.keys(session).length) await chrome.storage.session.set(session);
    },
    async remove(keys) {
      await Promise.all([chrome.storage.local.remove(keys), chrome.storage.session.remove(keys)]);
    },
  };
}
