import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const cliPath = path.join(repoRoot, 'dist', 'cli', 'main.js');
export const fixturesDir = path.join(repoRoot, 'tests', 'fixtures');

const dist = (p) => import(path.join(repoRoot, 'dist', p));
export const api = await dist('index.js');

/** Copy a fixture into a fresh temp directory and return its absolute (real) path. */
export function copyFixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scg-${name}-`));
  fs.cpSync(path.join(fixturesDir, name), dir, { recursive: true });
  return fs.realpathSync(dir);
}

export function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  // Make sure mtime changes even on coarse-grained filesystems.
  const t = new Date(Date.now() + Math.floor(Math.random() * 1000) + 1000);
  fs.utimesSync(abs, t, t);
}

export function remove(root, rel) {
  fs.rmSync(path.join(root, rel), { force: true });
}

export function rename(root, from, to) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.renameSync(path.join(root, from), path.join(root, to));
}

export function open(root, opts = {}) {
  return api.openProject({ root, ...opts });
}

/** Index (full) a root and return the open project. */
export function indexed(root) {
  const p = open(root);
  p.indexer.sync({ full: true });
  return p;
}

export function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: opts.cwd ?? repoRoot, env: { ...process.env, ...(opts.env ?? {}) }, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
}

/** All non-structural edges as "source KIND target" strings. */
export function edgeSet(project, kinds) {
  const rows = project.indexer.db.prepare('SELECT source_id, kind, target_id FROM edges ORDER BY source_id, kind, target_id').all();
  return new Set(rows.filter((r) => !kinds || kinds.includes(r.kind)).map((r) => `${r.source_id} ${r.kind} ${r.target_id}`));
}

export function edges(project, where = '1=1', ...params) {
  return project.indexer.db.prepare(`SELECT * FROM edges WHERE ${where} ORDER BY source_id, kind, target_id, id`).all(...params);
}

export function refs(project, where = '1=1', ...params) {
  return project.indexer.db.prepare(`SELECT * FROM raw_references WHERE ${where} ORDER BY id`).all(...params);
}

export function node(project, id) {
  return project.indexer.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
}

export const F = (file, qname) => `function:${file}::${qname}`;

export function exportNormalized(project) {
  const g = project.queries.exportGraph();
  delete g.meta.generation;
  delete g.meta.scannedAt;
  return g;
}
