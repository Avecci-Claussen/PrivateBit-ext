/**
 * Migration one-time addresses (DATA.md section 6, FLOWS.md section 10).
 * Records live encrypted in privatebit.onetime. An index is never issued twice.
 */
export type OneTimeStatus = "issued" | "funded" | "swept";
export type OneTimeRecord = { index: number; address: string; status: OneTimeStatus; createdAt: number };

export type OneTimeStore = {
  v: 1;
  records: OneTimeRecord[];
  /** Coins already in the wallet when a migration started; anything new is from the move. */
  migration?: { startedAt: number; known: string[]; fromHeight: number };
  /** Set after a restore: indexes below this were watched without being shown. */
  restoredWindow?: number;
};

export function emptyOneTime(): OneTimeStore {
  return { v: 1, records: [] };
}

export function nextOneTimeIndex(store: OneTimeStore): number {
  if (store.records.length === 0) return 0;
  return Math.max(...store.records.map((r) => r.index)) + 1;
}

export function issueRecord(store: OneTimeStore, address: string, now: number, index = nextOneTimeIndex(store)): OneTimeStore {
  if (store.records.some((r) => r.index === index)) throw new Error("one-time index already issued");
  return { ...store, records: [...store.records, { index, address, status: "issued", createdAt: now }] };
}

export function setOneTimeStatus(store: OneTimeStore, index: number, status: OneTimeStatus): OneTimeStore {
  return { ...store, records: store.records.map((r) => (r.index === index ? { ...r, status } : r)) };
}

/** The address is only shown while nothing has arrived. */
export function visibleRecord(store: OneTimeStore): OneTimeRecord | undefined {
  return store.records.filter((r) => r.status === "issued").sort((a, b) => b.index - a.index)[0];
}
