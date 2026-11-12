import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import type { SyncCoordinator } from './coordinator.js';
import type { Logger } from '../util/log.js';
import { toPosix } from '../util/paths.js';

export interface WatchHandle {
  close(): Promise<void>;
}

/**
 * chokidar watcher feeding the coordinator. Events are debounced and coalesced; a periodic
 * reconciliation (stat-based sync) recovers from dropped events. The watcher is an optimization only.
 */
export function startWatcher(
  loaded: LoadedConfig,
  coordinator: SyncCoordinator,
  logger: Logger,
  hooks: { onSynced?: (summary: unknown) => void } = {},
): WatchHandle {
  const { debounceMs, reconcileIntervalMs, followSymlinks } = loaded.config.indexing;
  const storage = path.resolve(loaded.storageDir);
  const ignoredDirs = new Set(['node_modules', '.git', '.tmp']);
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const trigger = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void coordinator.sync().then((r) => {
        if (r && (r.metrics.filesParsed || r.metrics.filesDeleted)) {
          logger.info(`synced generation ${r.generation}: ${r.metrics.filesParsed} parsed, ${r.metrics.filesDeleted} deleted (${r.status})`);
          hooks.onSynced?.(r.summary);
        }
      });
    }, debounceMs);
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = chokidar.watch(loaded.root, {
      ignoreInitial: true,
      followSymlinks,
      persistent: true,
      ignored: (p: string) => {
        const abs = path.resolve(p);
        if (abs === storage || abs.startsWith(storage + path.sep)) return true;
        const rel = toPosix(path.relative(loaded.root, abs));
        if (rel.startsWith('..')) return true;
        return rel.split('/').some((seg) => ignoredDirs.has(seg) || seg === 'assets');
      },
      awaitWriteFinish: false,
    });
    const onEvent = (p: string) => {
      const rel = toPosix(path.relative(loaded.root, p));
      if (!rel.endsWith('.js')) return;
      coordinator.markDirty([rel]);
      trigger();
    };
    watcher.on('add', onEvent).on('change', onEvent).on('unlink', onEvent).on('unlinkDir', () => trigger()).on('addDir', () => trigger());
    watcher.on('error', (err) => {
      coordinator.watcher = { mode: 'fallback_polling', error: (err as Error).message };
      logger.warn(`watcher error, falling back to periodic reconciliation: ${(err as Error).message}`);
    });
    coordinator.watcher = { mode: 'watching' };
  } catch (err) {
    coordinator.watcher = { mode: 'fallback_polling', error: (err as Error).message };
    logger.warn(`watcher failed to start, using periodic reconciliation: ${(err as Error).message}`);
  }

  const interval = setInterval(() => {
    if (!closed) void coordinator.sync();
  }, reconcileIntervalMs);
  interval.unref?.();

  return {
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      coordinator.watcher = { mode: 'stopped' };
      if (watcher) await watcher.close();
    },
  };
}
