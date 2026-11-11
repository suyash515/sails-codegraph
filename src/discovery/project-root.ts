import fs from 'node:fs';
import path from 'node:path';
import { UserInputError } from '../util/errors.js';

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isPlausibleSailsRoot(dir: string): boolean {
  if (fs.existsSync(path.join(dir, 'package.json')) && isDir(path.join(dir, 'api'))) return true;
  if (isDir(path.join(dir, 'api', 'controllers')) && isDir(path.join(dir, 'config'))) return true;
  return false;
}

/**
 * Root discovery: --root, then SAILS_CODEGRAPH_ROOT, then walk upward from cwd.
 * Works whether `.git` is a directory, a file (linked worktree) or absent.
 */
export function discoverProjectRoot(explicit?: string, cwd = process.cwd()): string {
  if (explicit) {
    const abs = path.resolve(cwd, explicit);
    if (!isDir(abs)) throw new UserInputError(`--root does not exist or is not a directory: ${explicit}`);
    return fs.realpathSync(abs);
  }
  const env = process.env.SAILS_CODEGRAPH_ROOT;
  if (env) {
    const abs = path.resolve(cwd, env);
    if (!isDir(abs)) throw new UserInputError(`SAILS_CODEGRAPH_ROOT does not exist or is not a directory: ${env}`);
    return fs.realpathSync(abs);
  }
  let dir = path.resolve(cwd);
  for (;;) {
    if (isPlausibleSailsRoot(dir)) return fs.realpathSync(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new UserInputError(
    `Could not find a Sails project root from ${cwd}.`,
    'Run inside a Sails app (package.json + api/), or pass --root <path> / set SAILS_CODEGRAPH_ROOT.',
  );
}

/** Detect the Sails version declared in package.json, statically. */
export function detectSailsVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg?.dependencies?.sails ?? pkg?.devDependencies?.sails ?? null;
  } catch {
    return null;
  }
}

/** Describe the git worktree situation without executing git. */
export function describeGit(root: string): { kind: 'none' | 'main' | 'linked-worktree'; gitPath?: string } {
  let dir = root;
  for (;;) {
    const g = path.join(dir, '.git');
    try {
      const st = fs.statSync(g);
      if (st.isDirectory()) return { kind: 'main', gitPath: g };
      if (st.isFile()) return { kind: 'linked-worktree', gitPath: g };
    } catch {
      /* continue */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { kind: 'none' };
    dir = parent;
  }
}
