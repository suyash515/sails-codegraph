import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { copyFixture, cli, write } from '../helpers/util.mjs';

test('CLI end-to-end: index, stats, queries, sync --check exit codes, export', () => {
  const root = copyFixture('incremental');
  // Runs without init / config file; discovers root from cwd.
  let r = cli(['index', '--json'], { cwd: path.join(root, 'api', 'controllers') });
  assert.equal(r.code, 0, r.stderr);
  const idx = r.json();
  assert.equal(idx.status, 'current');
  assert.equal(idx.metrics.filesParsed, idx.metrics.filesEnumerated);
  assert.ok(fs.existsSync(path.join(root, '.sails-codegraph', 'graph.sqlite')));

  r = cli(['sync', '--check', '--root', root]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  r = cli(['sync', '--json', '--root', root]);
  assert.equal(r.code, 0);
  assert.equal(r.json().metrics.filesParsed, 0);

  r = cli(['stats', '--json', '--root', root]);
  assert.equal(r.code, 0);
  const st = r.json();
  assert.equal(st.nodes.HELPER, 1);
  assert.equal(st.coverage.implicit_blueprints, 'not_analyzed');

  r = cli(['query', 'symbol', 'helper:payment/process', '--root', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /helper:payment\/process\s+\[HELPER\]\s+api\/helpers\/payment\/process\.js:1:18/);

  r = cli(['query', 'callers', 'helper:payment/process', '--depth', '2', '--json', '--root', root]);
  assert.equal(r.code, 0);
  const callers = r.json();
  assert.equal(callers.query.tool, 'get_callers');
  assert.equal(callers.graph.status, 'current');
  assert.ok(callers.results.some((x) => x.relation === 'CALLS'));
  assert.equal(typeof callers.truncated, 'boolean');

  r = cli(['query', 'callees', 'action:payment/create', '--depth', '2', '--json', '--root', root]);
  assert.equal(r.code, 0);
  r = cli(['query', 'route', 'POST /api/payments', '--json', '--root', root]);
  assert.equal(r.json().matches[0].route.targetId, 'action:payment/create');
  r = cli(['query', 'route', 'GET', '/api/payments', '--root', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /route:GET \/api\/payments -> action:payment\/list/);
  r = cli(['query', 'impact', 'helper:payment/process', '--depth', '3', '--json', '--root', root]);
  assert.ok(r.json().affectedEntryPoints.some((e) => e.id === 'route:POST /api/payments'));
  r = cli(['query', 'impact', '--files', 'api/helpers/payment/process.js', '--depth', '3', '--json', '--root', root]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json().query.files, ['api/helpers/payment/process.js']);
  r = cli(['query', 'unresolved', '--group-by', 'reason', '--json', '--root', root]);
  assert.equal(r.code, 0);
  assert.equal(r.json().counts.unresolved, 0);
  r = cli(['query', 'file', 'api/controllers/payment/create.js', '--json', '--root', root]);
  assert.equal(r.json().file.status, 'ok');
  r = cli(['query', 'routes', '--method', 'POST', '--prefix', '/api', '--json', '--root', root]);
  assert.deepEqual(r.json().routes.map((x) => x.id), ['route:POST /api/payments']);
  r = cli(['query', 'model-usage', 'model:payment', '--json', '--root', root]);
  assert.equal(r.json().model.id, 'model:payment');
  r = cli(['query', 'path', 'route:POST /api/payments', 'model:payment', '--json', '--root', root]);
  assert.equal(r.json().paths.length, 1);

  const out = path.join(root, 'graph.json');
  r = cli(['export', '--format', 'json', '--output', out, '--root', root]);
  assert.equal(r.code, 0);
  const g = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(g.format, 'sails-codegraph/graph@1');

  // Stale detection (exit 3) without mutating the DB
  write(root, 'api/helpers/payment/process.js', 'module.exports = { fn: async function () { return 2; } };\n');
  const genBefore = cli(['stats', '--json', '--root', root]).json().graph.generation;
  r = cli(['sync', '--check', '--json', '--root', root]);
  assert.equal(r.code, 3);
  assert.deepEqual(r.json().changed, ['api/helpers/payment/process.js']);
  assert.equal(cli(['stats', '--json', '--root', root]).json().graph.generation, genBefore, 'check is read-only');
  r = cli(['sync', '--root', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /1 parsed/);
  assert.equal(cli(['sync', '--check', '--root', root]).code, 0);
});

test('CLI errors: exit codes 2 for invalid input, no stack traces on stdout', () => {
  const root = copyFixture('incremental');
  let r = cli(['index', '--bogus-option', '--root', root]);
  assert.equal(r.code, 2);
  r = cli(['query', 'callers', 'nope:nothing', '--root', root]);
  assert.equal(r.code, 2, 'query before index is invalid input');
  cli(['index', '--root', root]);
  r = cli(['query', 'callers', 'nope:nothing', '--root', root]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Symbol not found/);
  assert.doesNotMatch(r.stdout, /at .*\.js:\d+/);
  r = cli(['query', 'callers', 'fn', '--json', '--root', root]);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.details.code, 'ambiguous_symbol');
  r = cli(['query', 'file', '../../etc/passwd', '--root', root]);
  assert.equal(r.code, 2);
  r = cli(['query', 'callers', 'helper:payment/process', '--depth', 'abc', '--root', root]);
  assert.equal(r.code, 2);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-empty-'));
  r = cli(['stats'], { cwd: empty, env: { SAILS_CODEGRAPH_ROOT: '' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Could not find a Sails project root/);
  fs.writeFileSync(path.join(root, 'sails-codegraph.config.json'), '{"indexing": {"debounceMs": "x"}}');
  r = cli(['stats', '--root', root]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Invalid configuration/);
});

test('init creates the config only when absent; --force overwrites; --update-gitignore', () => {
  const root = copyFixture('incremental');
  let r = cli(['init', '--root', root]);
  assert.equal(r.code, 0);
  const cfg = path.join(root, 'sails-codegraph.config.json');
  assert.ok(fs.existsSync(cfg));
  assert.match(r.stdout, /Recommendation/);
  r = cli(['init', '--root', root]);
  assert.equal(r.code, 2);
  r = cli(['init', '--force', '--update-gitignore', '--root', root]);
  assert.equal(r.code, 0);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.sails-codegraph\/$/m);
  r = cli(['index', '--root', root]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '', 'generated config produces no unknown-key warnings');
});

test('SAILS_CODEGRAPH_ROOT env var and doctor', () => {
  const root = copyFixture('incremental');
  let r = cli(['doctor', '--json'], { cwd: os.tmpdir(), env: { SAILS_CODEGRAPH_ROOT: root } });
  assert.equal(r.code, 0, r.stdout);
  const checks = Object.fromEntries(r.json().checks.map((c) => [c.check, c.status]));
  assert.equal(checks['project root'], 'ok');
  assert.equal(checks.mcp, 'ok');
  assert.equal(checks.config, 'ok');
});
