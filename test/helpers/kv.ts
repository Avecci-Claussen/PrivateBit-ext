import type { Kv } from "../../src/lib/vault.ts";

/** In-memory storage that can be dumped, to prove what is and is not written. */
export function dumpKv(): Kv & { dump(): Record<string, unknown>; text(): string } {
  const m = new Map<string, unknown>();
  return {
    async get(keys) {
      const o: Record<string, unknown> = {};
      for (const k of keys) if (m.has(k)) o[k] = structuredClone(m.get(k));
      return o;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) m.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of keys) m.delete(k);
    },
    dump() {
      return Object.fromEntries(m);
    },
    text() {
      return JSON.stringify(Object.fromEntries(m));
    },
  };
}
