import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { copyFixture, open, write, remove, api, cli, cliPath, F } from '../helpers/util.mjs';

const waitFor = async (fn, ms = 15000) => {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('T29 watcher coalesces rapid saves into a consistent graph without duplicate edges', async () => {
  const root = copyFixture('incremental');
  fs.writeFileSync(path.join(root, 'sails-codegraph.config.json'), JSON.stringify({ indexing: { debounceMs: 150, reconcileIntervalMs: 60000 } }));
  const p = open(root);
  const coord = new api.SyncCoordinator(p.indexer, 0);
  await coord.sync();
  const syncs = [];
  const handle = api.startWatcher(p.loaded, coord, { info() {}, warn() {}, error() {}, debug() {} }, { onSynced: (s) => syncs.push(s) });
  try {
    await new Promise((r) => setTimeout(r, 300)); // let chokidar finish its initial scan
    for (let i = 0; i < 10; i++) {
      write(root, 'api/controllers/payment/create.js', `module.exports = { fn: async function (inputs, exits) {\n  await sails.helpers.payment.process.with({ n: ${i} });\n  ${i % 2 ? 'await Payment.find();' : ''}\n} };\n`);
      write(root, `api/helpers/burst/h${i}.js`, 'module.exports = { fn: async function () {} };\n');
    }
    await waitFor(() => p.queries.read(() => p.indexer.db.prepare("SELECT count(*) FROM nodes WHERE kind = 'HELPER'").pluck().get()) === 11);
    await waitFor(async () => !coord.hasDirty && p.indexer.check().current);
    assert.ok(syncs.length >= 1 && syncs.length < 10, `bursts were coalesced (${syncs.length} syncs for 20 writes)`);
    const dup = p.indexer.db.prepare('SELECT source_id, kind, target_id, start_line, count(*) c FROM edges GROUP BY source_id, kind, target_id, start_line, start_col HAVING c > 1').all();
    assert.deepEqual(dup, []);
    const calls = p.indexer.db.prepare("SELECT target_id FROM edges WHERE source_id = ? AND kind = 'CALLS'").pluck().all(F('api/controllers/payment/create.js', 'module.exports.fn'));
    assert.deepEqual(calls, ['helper:payment/process']);
    const model = p.indexer.db.prepare("SELECT count(*) FROM edges WHERE source_id = ? AND kind = 'READS_MODEL'").pluck().get(F('api/controllers/payment/create.js', 'module.exports.fn'));
    assert.equal(model, 1, 'final content (i = 9) has a Payment.find()');
    remove(root, 'api/helpers/burst/h0.js');
    await waitFor(() => p.indexer.db.prepare("SELECT count(*) FROM nodes WHERE kind = 'HELPER'").pluck().get() === 10);
    assert.equal(coord.watcher.mode, 'watching');
  } finally {
    await handle.close();
    p.close();
  }
});

test('T32 two git worktrees with different code keep independent graphs', () => {
  const base = copyFixture('incremental');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(base, 'init', '-q');
  git(base, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.');
  git(base, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-wt-'));
  fs.rmSync(wt, { recursive: true });
  git(base, 'worktree', 'add', '-q', wt);
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'linked worktree has a .git file');
  write(wt, 'api/helpers/payment/refund.js', 'module.exports = { fn: async function () {} };\n');
  remove(wt, 'api/helpers/payment/process.js');
  const a = cli(['index', '--json'], { cwd: path.join(base, 'api') });
  const b = cli(['index', '--json'], { cwd: path.join(wt, 'api', 'helpers') });
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.ok(fs.existsSync(path.join(base, '.sails-codegraph', 'graph.sqlite')));
  assert.ok(fs.existsSync(path.join(wt, '.sails-codegraph', 'graph.sqlite')));
  const helpers = (root) => cli(['query', 'symbol', 'helper:', '--kind', 'HELPER', '--json', '--root', root]).json().results.map((r) => r.id).sort();
  assert.deepEqual(helpers(base), ['helper:payment/process']);
  assert.deepEqual(helpers(fs.realpathSync(wt)), ['helper:payment/refund']);
  const status = cli(['stats', '--json'], { cwd: wt }).json();
  assert.equal(status.meta.projectRoot, fs.realpathSync(wt));
});

test('concurrent writers (CLI processes) serialize via the lock and leave a consistent graph', async () => {
  const root = copyFixture('sails-app');
  cli(['index', '--root', root]);
  write(root, 'api/helpers/payment/process.js', 'module.exports = { fn: async function () { await Payment.find(); } };\n');
  const run = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [cliPath, 'sync', '--json', '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code, out }));
  });
  const results = await Promise.all([run(), run(), run()]);
  for (const r of results) assert.equal(r.code, 0, r.out);
  const parsed = results.map((r) => JSON.parse(r.out).metrics.filesParsed).sort();
  assert.deepEqual(parsed, [0, 0, 1], 'exactly one writer applied the change');
  assert.equal(cli(['sync', '--check', '--root', root]).code, 0);
  assert.equal(fs.existsSync(path.join(root, '.sails-codegraph', 'write.lock')), false);
});
