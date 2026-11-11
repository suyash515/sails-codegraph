import fs from 'node:fs';
import path from 'node:path';
import { OperationalError } from '../util/errors.js';

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockHandle {
  release(): void;
}

/**
 * Cross-process advisory writer lock: an exclusive-create lock file holding the owner pid.
 * Stale locks (dead pid, or older than staleMs) are taken over. Waits are bounded.
 */
export function acquireWriteLock(storageDir: string, opts: { timeoutMs?: number; staleMs?: number } = {}): LockHandle {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const staleMs = opts.staleMs ?? 10 * 60_000;
  fs.mkdirSync(storageDir, { recursive: true });
  const lockPath = path.join(storageDir, 'write.lock');
  const deadline = Date.now() + timeoutMs;
  let delay = 10;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      fs.closeSync(fd);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (cur.pid === process.pid) fs.unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // Inspect existing lock
    try {
      const st = fs.statSync(lockPath);
      let holder: { pid?: number } = {};
      try {
        holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch {
        /* partially written: treat by age */
      }
      const age = Date.now() - st.mtimeMs;
      const dead = holder.pid !== undefined ? !pidAlive(holder.pid) : age > 2000;
      if (dead || age > staleMs) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* raced */
        }
        continue;
      }
    } catch {
      continue; // lock vanished between calls
    }
    if (Date.now() >= deadline) {
      throw new OperationalError(
        `Timed out after ${timeoutMs} ms waiting for the index write lock (${lockPath}).`,
        'Another sails-codegraph process is updating this index. Retry shortly, or remove the lock file if no such process exists.',
      );
    }
    sleepSync(delay);
    delay = Math.min(delay * 2, 250);
  }
}
