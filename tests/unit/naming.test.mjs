import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { repoRoot } from '../helpers/util.mjs';

const { camelCase } = await import(path.join(repoRoot, 'dist/util/naming.js'));
const { normalizeActionTarget, parseRouteKey, routeId } = await import(path.join(repoRoot, 'dist/parser/sails-config.js'));
const { routeMatcher } = await import(path.join(repoRoot, 'dist/query/route-match.js'));
const { bestPolicyRule } = await import(path.join(repoRoot, 'dist/indexing/indexer.js'));
const { loadConfig } = await import(path.join(repoRoot, 'dist/config/load.js'));
const { normalizeRelative, safeJoin, resolvePosix } = await import(path.join(repoRoot, 'dist/util/paths.js'));
const { packageName, moduleCandidates } = await import(path.join(repoRoot, 'dist/parser/parse-file.js'));

test('helper access names use lodash camelCase semantics', () => {
  assert.equal(camelCase('find-by-email'), 'findByEmail');
  assert.equal(camelCase('format-welcome-message'), 'formatWelcomeMessage');
  assert.equal(camelCase('foo-bar'), 'fooBar');
  assert.equal(camelCase('findByEmail'), 'findByEmail');
  assert.equal(camelCase('process_payment'), 'processPayment');
  assert.equal(camelCase('FOO_bar'), 'fooBar');
  assert.equal(camelCase('foo2bar'), 'foo2Bar');
  assert.equal(camelCase('user'), 'user');
});

test('route action targets normalize to lower-cased action identities', () => {
  assert.equal(normalizeActionTarget('user/find'), 'user/find');
  assert.equal(normalizeActionTarget('UserController.create'), 'user/create');
  assert.equal(normalizeActionTarget('admin/UserController.create'), 'admin/user/create');
  assert.equal(normalizeActionTarget('/Payment/Create/'), 'payment/create');
});

test('route keys parse into method and path; verbless keys match all methods', () => {
  assert.deepEqual(parseRouteKey('POST /api/payments'), { method: 'POST', path: '/api/payments' });
  assert.deepEqual(parseRouteKey('get /users/:id'), { method: 'GET', path: '/users/:id' });
  assert.deepEqual(parseRouteKey('/legacy'), { method: '*', path: '/legacy' });
  assert.equal(routeId('POST', '/x'), 'route:POST /x');
  assert.equal(routeId('*', '/x'), 'route:/x');
});

test('Sails-style path patterns match concrete paths', () => {
  assert.deepEqual(routeMatcher('/users/:id')('/users/42'), { id: '42' });
  assert.equal(routeMatcher('/users/:id')('/users/42/extra'), null);
  assert.deepEqual(routeMatcher('/users/:id?')('/users'), {});
  assert.deepEqual(routeMatcher('/users/:id?')('/users/7'), { id: '7' });
  assert.deepEqual(routeMatcher('/files/*')('/files/a/b.txt'), { 0: 'a/b.txt' });
  assert.ok(routeMatcher('/api/payments')('/API/Payments/'));
});

test('policy precedence: exact > longest prefix > controller * > global *', () => {
  const span = { startLine: 1, startCol: 1, endLine: 1, endCol: 1, startOffset: 0, endOffset: 0 };
  const rules = [
    { matchedRule: '*', kind: 'global', pattern: '', value: { names: [] }, span },
    { matchedRule: 'UserController.*', kind: 'controller', pattern: 'user/', value: { names: [] }, span },
    { matchedRule: 'user/*', kind: 'prefix', pattern: 'user/', value: { names: [] }, span },
    { matchedRule: 'user/admin/*', kind: 'prefix', pattern: 'user/admin/', value: { names: [] }, span },
    { matchedRule: 'user/login', kind: 'exact', pattern: 'user/login', value: true, span },
  ];
  assert.equal(bestPolicyRule(rules, 'user/login').matchedRule, 'user/login');
  assert.equal(bestPolicyRule(rules, 'user/admin/x').matchedRule, 'user/admin/*');
  assert.equal(bestPolicyRule(rules, 'user/other').matchedRule, 'user/*');
  assert.equal(bestPolicyRule(rules.filter((r) => r.kind !== 'prefix'), 'user/other').matchedRule, 'UserController.*');
  assert.equal(bestPolicyRule(rules, 'payment/create').matchedRule, '*');
  assert.equal(bestPolicyRule([], 'payment/create'), null);
});

test('config validation: unknown keys warn, bad types and dangerous paths error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-cfg-'));
  const write = (o) => fs.writeFileSync(path.join(dir, 'sails-codegraph.config.json'), JSON.stringify(o));
  write({ bogus: 1, indexing: { debounceMs: 10, nope: true } });
  const ok = loadConfig(dir);
  assert.equal(ok.config.indexing.debounceMs, 10);
  assert.equal(ok.config.query.maxDepth, 5);
  assert.equal(ok.warnings.length, 2);
  write({ indexing: { debounceMs: 'fast' } });
  assert.throws(() => loadConfig(dir), /Invalid configuration/);
  write({ storage: { directory: '../outside' } });
  assert.throws(() => loadConfig(dir), /storage.directory/);
  write({ resolution: { extraModelReadMethods: ['x'], extraModelWriteMethods: ['x'] } });
  assert.throws(() => loadConfig(dir), /both read and write/);
  fs.writeFileSync(path.join(dir, 'sails-codegraph.config.json'), 'module.exports = {}');
  assert.throws(() => loadConfig(dir), /Invalid JSON/);
  const js = path.join(dir, 'cfg.js');
  fs.writeFileSync(js, 'process.exit(9)');
  assert.throws(() => loadConfig(dir, js), /never executed/);
});

test('path containment', () => {
  const root = '/srv/app';
  assert.equal(normalizeRelative(root, 'api/x.js'), 'api/x.js');
  assert.equal(normalizeRelative(root, './api/../api/x.js'), 'api/x.js');
  assert.equal(normalizeRelative(root, '../etc/passwd'), null);
  assert.equal(normalizeRelative(root, '/etc/passwd'), null);
  assert.throws(() => safeJoin(root, '../../etc/passwd'));
  assert.equal(resolvePosix('api/a/b.js', '../c'), 'api/c');
  assert.equal(resolvePosix('api/b.js', '../../../x'), null);
});

test('module specifiers: relative candidates and package names', () => {
  assert.deepEqual(moduleCandidates('api/services/A.js', './B'), ['api/services/B', 'api/services/B.js', 'api/services/B/index.js']);
  assert.deepEqual(moduleCandidates('api/services/A.js', './B.js'), ['api/services/B.js']);
  assert.equal(moduleCandidates('api/A.js', '../../x'), null);
  assert.equal(packageName('stripe'), 'stripe');
  assert.equal(packageName('node:fs'), 'node:fs');
  assert.equal(packageName('fs'), 'node:fs');
  assert.equal(packageName('fs/promises'), 'node:fs/promises');
  assert.equal(packageName('@sailshq/lodash'), '@sailshq/lodash');
  assert.equal(packageName('lodash/map'), 'lodash');
});
