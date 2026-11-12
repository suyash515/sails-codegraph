import fs from 'node:fs';
import fg from 'fast-glob';
import type { CodegraphConfig } from '../config/schema.js';
import { safeJoin, normalizeRelative, toPosix } from '../util/paths.js';

export interface FileStat {
  path: string; // root-relative POSIX
  abs: string;
  size: number;
  mtimeMs: number;
}

export interface Enumeration {
  files: Map<string, FileStat>;
  skipped: { path: string; code: string; message: string }[];
}

function ignorePatterns(config: CodegraphConfig): string[] {
  const storage = toPosix(config.storage.directory).replace(/^\.\//, '').replace(/\/$/, '');
  return [...config.exclude, `${storage}/**`, '**/.sails-codegraph/**'];
}

/** Deterministic enumeration of eligible source files (sorted, POSIX, root-relative). */
export function enumerateFiles(root: string, config: CodegraphConfig): Enumeration {
  const entries = fg.sync(config.include, {
    cwd: root,
    ignore: ignorePatterns(config),
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: config.indexing.followSymlinks,
    unique: true,
    suppressErrors: true,
  });
  const out: Enumeration = { files: new Map(), skipped: [] };
  for (const rel of entries.sort()) addFile(root, config, rel, out);
  return out;
}

/** Check and add an extra path (e.g. a required route file) subject to excludes and containment. */
export function addExtraFile(root: string, config: CodegraphConfig, rel: string, out: Enumeration): boolean {
  const norm = normalizeRelative(root, rel);
  if (!norm || out.files.has(norm)) return false;
  const allowed = fg.sync([fg.escapePath(norm)], { cwd: root, ignore: ignorePatterns(config), onlyFiles: true, dot: true, suppressErrors: true });
  if (!allowed.length) return false;
  return addFile(root, config, norm, out);
}

function addFile(root: string, config: CodegraphConfig, rel: string, out: Enumeration): boolean {
  let abs: string;
  try {
    abs = safeJoin(root, rel);
  } catch {
    out.skipped.push({ path: rel, code: 'PATH_OUTSIDE_ROOT', message: `Skipped ${rel}: outside project root.` });
    return false;
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() && !config.indexing.followSymlinks) {
    out.skipped.push({ path: rel, code: 'SYMLINK_SKIPPED', message: `Skipped symbolic link ${rel} (indexing.followSymlinks is false).` });
    return false;
  }
  if (st.isSymbolicLink()) {
    try {
      const real = fs.realpathSync(abs);
      const relReal = normalizeRelative(fs.realpathSync(root), real);
      if (relReal === null) {
        out.skipped.push({ path: rel, code: 'PATH_OUTSIDE_ROOT', message: `Skipped ${rel}: symlink target outside project root.` });
        return false;
      }
      st = fs.statSync(abs);
    } catch {
      return false;
    }
  }
  if (!st.isFile()) return false;
  if (st.size > config.indexing.maxFileBytes) {
    out.skipped.push({ path: rel, code: 'FILE_TOO_LARGE', message: `Skipped ${rel}: ${st.size} bytes exceeds indexing.maxFileBytes (${config.indexing.maxFileBytes}).` });
    return false;
  }
  out.files.set(rel, { path: rel, abs, size: st.size, mtimeMs: st.mtimeMs });
  return true;
}
