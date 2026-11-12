import path from 'node:path';

/** Convert an OS path to forward slashes. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Normalize a user-supplied, root-relative path into canonical POSIX form.
 * Returns null when the path is absolute outside the root or escapes it via `..`.
 */
export function normalizeRelative(root: string, input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) return null;
  const abs = path.resolve(root, input);
  const rel = path.relative(root, abs);
  if (rel === '' ) return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

/** Safely join a root-relative POSIX path to an absolute root; throws if it escapes. */
export function safeJoin(root: string, relPosix: string): string {
  const abs = path.resolve(root, ...relPosix.split('/'));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathContainmentError(relPosix);
  }
  return abs;
}

export class PathContainmentError extends Error {
  readonly code = 'PATH_OUTSIDE_ROOT';
  constructor(p: string) {
    super(`Path is outside the project root: ${p}`);
  }
}

/** Resolve a POSIX relative specifier against the directory of a POSIX file path. Returns null if it escapes. */
export function resolvePosix(fromFile: string, spec: string): string | null {
  const dir = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(dir, spec));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return null;
  return joined.replace(/\/$/, '');
}
