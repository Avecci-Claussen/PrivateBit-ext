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
  /** Next Payjoin link index (audit H2). Links are derived from the scan key by index. */
  pjNext?: number;
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

/**
 * Keep one-time records and the coins that belong to them in step.
 * The address is swept only when every coin at that index is spent.
 * A later payment to the same address is still spendable and reopens it.
 */
export function syncOneTimeWithScan(
  scan: { utxos: { kind?: "sp" | "bip86" | "site"; index?: number; spent: boolean }[] },
  ot: OneTimeStore,
): { utxosSpent: boolean[]; records: OneTimeRecord[]; changedOt: boolean } {
  const utxosSpent = scan.utxos.map((u) => u.spent);
  let changedOt = false;
  const records = ot.records.map((r) => {
    const mine = scan.utxos.filter((u) => u.kind === "bip86" && u.index === r.index);
    if (mine.length === 0) return r;
    const live = mine.some((u) => !u.spent);
    const status: OneTimeStatus = live ? "funded" : "swept";
    if (r.status === status) return r;
    changedOt = true;
    return { ...r, status };
  });
  return { utxosSpent, records, changedOt };
}
