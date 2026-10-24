/**
 * The only writer of a wallet's coin list. Every change goes through one queue:
 *
 *   update(fn)          re-reads the current list inside the queue, applies fn, bumps rev
 *   commit(rev, next)   for work computed outside the queue (a scan step): refused with
 *                       StaleWriteError when anything else wrote since that rev was read
 *
 * Writes are kept in memory and persisted after a short quiet period (or at once with
 * flush), so a scan does not re-encrypt the whole list for every block. The list carries
 * its rev on disk, so a restarted worker continues from the last saved checkpoint.
 */
import type { ScanStore } from "./scan.ts";

export class StaleWriteError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`coin list changed while this change was prepared (rev ${expected}, now ${actual})`);
    this.name = "StaleWriteError";
  }
}

export type CoinStoreIo = {
  /** Read the list from storage. undefined marker lets the store notice outside edits. */
  load(): Promise<{ store: ScanStore; marker: unknown }>;
  /** Peek at the stored marker without decrypting. */
  marker(): Promise<unknown>;
  /** Seal and write. Returns the new marker. May adjust the list (returned store) before sealing. */
  persist(store: ScanStore): Promise<{ store: ScanStore; marker: unknown }>;
  /** After a write reached storage: history, one-time records, directory. */
  afterPersist?(store: ScanStore, urgent: boolean): Promise<void>;
};

export type Snapshot = { store: ScanStore; rev: number };

function clone<T>(v: T): T {
  return structuredClone(v);
}

export class CoinStore {
  private cur?: { store: ScanStore; rev: number; marker: unknown };
  private dirty = false;
  private urgent = false;
  private timer?: ReturnType<typeof setTimeout>;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private io: CoinStoreIo,
    readonly debounceMs = 1500,
  ) {}

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Load once; reload when storage was changed by someone else and nothing is pending here. */
  private async current(): Promise<{ store: ScanStore; rev: number; marker: unknown }> {
    if (this.cur && this.dirty) return this.cur;
    if (this.cur) {
      const marker = await this.io.marker();
      if (JSON.stringify(marker) === JSON.stringify(this.cur.marker)) return this.cur;
    }
    const got = await this.io.load();
    this.cur = { store: got.store, rev: got.store.rev ?? 0, marker: got.marker };
    return this.cur;
  }

  /** A private copy of the list and its rev. */
  read(): Promise<Snapshot> {
    return this.queue(async () => {
      const c = await this.current();
      return { store: clone(c.store), rev: c.rev };
    });
  }

  private async write(next: ScanStore, urgent: boolean): Promise<ScanStore> {
    if (this.closed) throw new Error("wallet closed");
    const c = await this.current();
    const rev = c.rev + 1;
    this.cur = { store: { ...next, rev }, rev, marker: c.marker };
    this.dirty = true;
    this.urgent ||= urgent;
    if (urgent) await this.persistNow();
    else this.schedule();
    return clone(this.cur.store);
  }

  /** Re-read inside the queue, change, write. Use for anything quick: broadcasts, watches. */
  update(fn: (store: ScanStore) => ScanStore | Promise<ScanStore>, opts: { flush?: boolean } = {}): Promise<ScanStore> {
    return this.queue(async () => {
      const c = await this.current();
      const next = await fn(clone(c.store));
      return this.write(next, opts.flush ?? true);
    });
  }

  /** Write work prepared from a snapshot. Refused if the list moved on since. */
  commit(baseRev: number, next: ScanStore, opts: { flush?: boolean } = {}): Promise<ScanStore> {
    return this.queue(async () => {
      const c = await this.current();
      if (c.rev !== baseRev) throw new StaleWriteError(baseRev, c.rev);
      return this.write(next, opts.flush ?? false);
    });
  }

  /** Replace the list outright (new wallet, restore, birthday change). */
  replace(next: ScanStore): Promise<ScanStore> {
    return this.queue(async () => {
      const c = this.cur ?? (await this.current().catch(() => undefined));
      const rev = (c?.rev ?? 0) + 1;
      this.cur = { store: { ...next, rev }, rev, marker: c?.marker };
      this.dirty = true;
      this.urgent = true;
      await this.persistNow();
      return clone(this.cur.store);
    });
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.queue(() => this.persistNow()).catch(() => undefined);
    }, this.debounceMs);
  }

  private async persistNow(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty || !this.cur) return;
    const urgent = this.urgent;
    const saved = await this.io.persist(this.cur.store);
    this.cur = { store: { ...saved.store, rev: this.cur.rev }, rev: this.cur.rev, marker: saved.marker };
    this.dirty = false;
    this.urgent = false;
    await this.io.afterPersist?.(this.cur.store, urgent);
  }

  /** Write anything pending now (end of a scan run, before lock or switch). */
  flush(): Promise<void> {
    return this.queue(() => this.persistNow());
  }

  /** Forget the in-memory copy (keys changed). Pending work is flushed first by the caller. */
  invalidate(): void {
    if (this.dirty) return;
    this.cur = undefined;
  }

  /** No more writes from this store (wallet switched or removed). */
  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get pending(): boolean {
    return this.dirty;
  }
}
