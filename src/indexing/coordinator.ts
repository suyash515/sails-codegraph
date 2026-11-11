import type { GraphIndexer, SyncResult, SyncOptions } from './indexer.js';
import type { Logger } from '../util/log.js';
import { silentLogger } from '../util/log.js';
import { setMeta } from '../storage/sqlite.js';

export interface WatcherState {
  mode: 'disabled' | 'watching' | 'fallback_polling' | 'stopped';
  error?: string;
}

/**
 * Single logical writer for one process: serializes syncs, coalesces requests, consumes
 * watcher dirty flags and throttles stat reconciliation (mcpScanIntervalMs).
 */
export class SyncCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Promise<SyncResult | null> | null = null;
  private dirty = new Set<string>();
  private lastScanAt = 0;
  lastResult: SyncResult | null = null;
  lastError: string | null = null;
  watcher: WatcherState = { mode: 'disabled' };

  constructor(private indexer: GraphIndexer, private scanIntervalMs: number, private logger: Logger = silentLogger) {}

  markDirty(paths: Iterable<string>): void {
    for (const p of paths) this.dirty.add(p);
  }

  get hasDirty(): boolean {
    return this.dirty.size > 0;
  }

  /** Sync only when dirty paths are pending or the scan interval elapsed. Coalesces callers. */
  syncIfNeeded(): Promise<SyncResult | null> {
    const due = Date.now() - this.lastScanAt >= this.scanIntervalMs;
    if (!this.dirty.size && !due) return this.pending ?? Promise.resolve(null);
    return this.sync();
  }

  /** Request a sync; concurrent requests share one run. */
  sync(opts: Omit<SyncOptions, 'dirty'> = {}): Promise<SyncResult | null> {
    if (this.pending && !opts.full) return this.pending;
    const run = this.queue.then(() => this.runNow(opts));
    this.pending = run.finally(() => {
      if (this.pending === wrapped) this.pending = null;
    });
    const wrapped = this.pending;
    this.queue = this.pending.catch(() => undefined);
    return this.pending;
  }

  private runNow(opts: Omit<SyncOptions, 'dirty'>): SyncResult | null {
    const dirty = [...this.dirty];
    this.dirty.clear();
    try {
      const r = this.indexer.sync({ ...opts, dirty });
      this.lastResult = r;
      this.lastError = null;
      this.lastScanAt = Date.now();
      return r;
    } catch (err) {
      for (const d of dirty) this.dirty.add(d);
      this.lastError = (err as Error).message;
      this.logger.error(`sync failed: ${this.lastError}`);
      try {
        setMeta(this.indexer.db, 'lastError', this.lastError);
      } catch {
        /* ignore */
      }
      return null;
    }
  }
}
