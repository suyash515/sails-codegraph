import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixture, indexed, edgeSet, edges, refs, node, F, fixturesDir } from '../helpers/util.mjs';

let root;
let p;
before(() => {
  root = copyFixture('sails-app');
  p = indexed(root);
});
after(() => p.close());

const has = (s) => edgeSet(p).has(s);

test('T36 indexing never executes project code', () => {
  assert.equal(fs.existsSync(path.join(root, 'PWNED.txt')), false);
  assert.ok(node(p, 'helper:side-effect'));
});

test('ground truth: 100% precision and recall on the supported fixture patterns', () => {
  const expected = new Set(JSON.parse(fs.readFileSync(path.join(fixturesDir, 'expected', 'sails-app.edges.json'), 'utf8')).relationships);
  assert.ok(expected.size >= 50, 'ground truth has at least 50 relationships');
  const produced = new Set([...edgeSet(p)].filter((e) => !e.includes(' CONTAINS ')));
  const correct = [...produced].filter((e) => expected.has(e));
  const precision = correct.length / produced.size;
  const recall = correct.length / expected.size;
  const missing = [...expected].filter((e) => !produced.has(e));
  const extra = [...produced].filter((e) => !expected.has(e));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  assert.equal(precision, 1);
  assert.equal(recall, 1);
});

test('T05/T06/T07 helper naming and direct helper calls', () => {
  assert.ok(has(`${F('api/controllers/user/view-profile.js', 'module.exports.fn')} CALLS helper:format-welcome-message`));
  assert.ok(has(`${F('api/controllers/user/view-profile.js', 'module.exports.fn')} CALLS helper:user/find-by-email`));
  const h = node(p, 'helper:user/find-by-email');
  assert.equal(JSON.parse(h.attributes_json).accessName, 'sails.helpers.user.findByEmail');
});

test('T08 .with(...) helper call: one CALLS edge to the helper, none to with/exec', () => {
  const e = edges(p, "source_id = ? AND kind = 'CALLS'", F('api/controllers/payment/create.js', 'module.exports.fn'));
  assert.equal(e.length, 1);
  assert.equal(e[0].target_id, 'helper:payment/process');
  assert.deepEqual(JSON.parse(e[0].attributes_json), { invocation: 'with', argKeys: ['amount'] });
  assert.equal(e[0].resolution, 'sails_convention');
  assert.equal(e[0].confidence, 'high');
  assert.deepEqual([e[0].evidence_file, e[0].start_line, e[0].start_col], ['api/controllers/payment/create.js', 10, 26]);
});

test('T09/T10 literal computed helper access resolves; variable access is unresolved_dynamic', () => {
  const e = edges(p, "source_id = ? AND target_id = 'helper:user/find-by-email'", F('api/controllers/user/view-profile.js', 'module.exports.fn'));
  assert.equal(e.length, 2);
  const dyn = refs(p, "resolution_status = 'unresolved_dynamic'");
  assert.equal(dyn.length, 1);
  assert.equal(dyn[0].expression, 'sails.helpers[name].findByEmail(...)');
});

test('T11 global service method resolves to the concrete function', () => {
  assert.ok(has(`${F('api/controllers/payment/refund.js', 'module.exports.fn')} CALLS ${F('api/services/PaymentService.js', 'module.exports.refund')}`));
});

test('T12/T41 require() alias and destructured require resolve without global names', () => {
  assert.ok(has(`${F('api/services/NotifyService.js', 'module.exports.notify')} CALLS ${F('api/services/PaymentService.js', 'module.exports.refund')}`));
  assert.ok(has(`${F('api/services/NotifyService.js', 'module.exports.notify')} CALLS ${F('api/services/PaymentService.js', 'charge')}`));
});

test('T13/T14 model reads and writes with operation metadata; no bogus fetch call', () => {
  const find = edges(p, "source_id = ? AND kind = 'READS_MODEL'", F('api/helpers/user/find-by-email.js', 'module.exports.fn'));
  assert.deepEqual(find.map((e) => [e.target_id, JSON.parse(e.attributes_json).operation]), [['model:user', 'findOne']]);
  const w = edges(p, 'source_id = ?', F('api/helpers/payment/process.js', 'module.exports.fn'));
  assert.deepEqual(w.map((e) => [e.kind, e.target_id, JSON.parse(e.attributes_json)]), [['WRITES_MODEL', 'model:payment', { operation: 'create', modifiers: ['fetch'] }]]);
});

test('T15 local User shadows the model global', () => {
  const e = edges(p, 'source_id = ?', F('api/controllers/shadow.js', 'module.exports.fn'));
  assert.deepEqual(e.map((x) => [x.kind, x.target_id]), [['CALLS', F('api/controllers/shadow.js', 'module.exports.fn.User.findOne')]]);
});

test('T16 model associations', () => {
  assert.ok(has('model:user ASSOCIATES_WITH model:pet'));
  assert.ok(has('model:pet ASSOCIATES_WITH model:user'));
  const e = edges(p, "source_id = 'model:user' AND kind = 'ASSOCIATES_WITH'");
  assert.deepEqual(JSON.parse(e[0].attributes_json), { attribute: 'pets', type: 'collection', via: 'owner' });
});

test('T17/T18/T19/T49 route forms', () => {
  assert.ok(has('route:POST /api/payments ROUTES_TO action:payment/create'));
  assert.ok(has('route:POST /legacy-user ROUTES_TO action:user/create'));
  assert.ok(has('route:GET /legacy-user/:id ROUTES_TO action:user/find'));
  assert.ok(has('route:/legacy ROUTES_TO action:legacy'));
  assert.ok(has(`route:GET /health ROUTES_TO ${F('config/routes.js', 'module.exports.routes["GET /health"]')}`));
  for (const id of ['route:GET /', 'route:GET /old', 'route:GET /moved']) {
    assert.ok(node(p, id), `${id} exists`);
    assert.equal(edges(p, 'source_id = ?', id).length, 0, `${id} has no invented edge`);
  }
  assert.equal(JSON.parse(node(p, 'route:/legacy').attributes_json).method, '*');
  assert.deepEqual(JSON.parse(node(p, 'route:GET /old').attributes_json).target, { kind: 'redirect', redirect: '/new' });
  assert.deepEqual(JSON.parse(node(p, 'route:GET /').attributes_json).target, { kind: 'view', view: 'pages/homepage' });
  assert.deepEqual(JSON.parse(node(p, 'route:POST /api/payments/:id/refund').attributes_json).metadata, { csrf: false });
  const missing = refs(p, "ref_kind = 'route_target' AND resolution_status != 'resolved'");
  assert.deepEqual(missing.map((r) => [r.source_node_id, r.resolution_status, r.unresolved_reason]), [['route:GET /missing', 'unresolved_missing', 'action_not_found']]);
});

test('T50 (static part) routes spread from a required file are merged', () => {
  assert.ok(has('route:GET /admin/dashboard ROUTES_TO action:admin/user/create'));
  const n = node(p, 'route:GET /admin/dashboard');
  assert.equal(n.file_path, 'config/routes/admin.js');
  const deps = p.indexer.db.prepare('SELECT dependency_file FROM file_dependencies WHERE dependent_file = ?').pluck().all('config/routes.js');
  assert.ok(deps.includes('config/routes/admin.js'));
});

test('T20/T52 policy precedence, ordered arrays, matchedRule and unguarded/blocked actions', () => {
  const guards = (a) => edges(p, "source_id = ? AND kind = 'GUARDED_BY'", a).map((e) => {
    const at = JSON.parse(e.attributes_json);
    return [at.order, e.target_id, at.matchedRule];
  }).sort();
  assert.deepEqual(guards('action:payment/create'), [[0, 'policy:isLoggedIn', 'payment/*'], [1, 'policy:isAdmin', 'payment/*']]);
  assert.deepEqual(guards('action:payment/refund'), [[0, 'policy:isAdmin', 'payment/refund'], [1, 'policy:isLoggedIn', 'payment/refund']]);
  assert.deepEqual(guards('action:shadow'), [[0, 'policy:isLoggedIn', '*']]);
  assert.deepEqual(guards('action:user/create'), [[0, 'policy:isLoggedIn', 'UserController.*']]);
  assert.deepEqual(guards('action:user/find'), []);
  assert.deepEqual(guards('action:user/view-profile'), []);
  const sym = p.queries.getSymbol('action:legacy');
  assert.equal(sym.symbol.attributes.access, 'blocked');
  assert.equal(p.queries.getSymbol('action:user/find').symbol.attributes.policies, 'public');
  const e = edges(p, "source_id = 'action:payment/create' AND kind = 'GUARDED_BY'")[0];
  assert.equal(e.evidence_file, 'config/policies.js');
  const unresolvedPolicy = refs(p, "ref_kind = 'policy' AND resolution_status != 'resolved'");
  assert.deepEqual(unresolvedPolicy.map((r) => r.unresolved_reason), ['policy_not_found']);
});

test('T39/T40 get_unresolved contains only genuine project gaps', () => {
  const u = p.queries.unresolved({});
  const exprs = u.results.map((r) => r.expression).sort();
  assert.deepEqual(exprs, ["'GET /missing': 'nothing/here'", "'isAuditor' (admin/*)", 'Paymnet.create(...)', 'sails.helpers[name].findByEmail(...)']);
  const typo = u.results.find((r) => r.expression === 'Paymnet.create(...)');
  assert.deepEqual([typo.status, typo.reason], ['unresolved_missing', 'unknown_global']);
  assert.ok(u.counts.filtered.external > 0);
  assert.ok(u.counts.filtered.plumbing > 0);
  for (const r of u.results) assert.doesNotMatch(r.expression, /console|res\.|exits\.|_\.|stripe|JSON/);
});

test('T42/T43/T44 shorthand exports, this.sibling (inferred/medium), function references', () => {
  const self = edges(p, "source_id = ? AND kind = 'CALLS'", F('api/services/PaymentService.js', 'module.exports.refund'));
  assert.deepEqual(self.map((e) => [e.target_id, e.resolution, e.confidence]), [[F('api/services/PaymentService.js', 'charge'), 'inferred', 'medium']]);
  assert.ok(has(`${F('api/services/PaymentService.js', 'module.exports.formatAll')} REFERENCES ${F('api/services/PaymentService.js', 'validate')}`));
});

test('T45 helper .with().intercept().tolerate(): one CALLS edge with modifiers metadata', () => {
  const e = edges(p, "source_id = ? AND target_id = 'helper:payment/process'", F('api/controllers/payment/refund.js', 'module.exports.fn'));
  assert.equal(e.length, 1);
  assert.deepEqual(JSON.parse(e[0].attributes_json), { invocation: 'with', modifiers: ['intercept', 'tolerate'], argKeys: ['amount'] });
});

test('T46 nested classic controller identity and alias', () => {
  assert.ok(node(p, 'action:admin/user/create'));
  assert.ok(has('route:POST /admin/user ROUTES_TO action:admin/user/create'));
  const alias = p.indexer.db.prepare("SELECT node_id FROM registry_keys WHERE lookup_key = 'action-alias:admin/usercontroller.create'").pluck().all();
  assert.deepEqual(alias, ['action:admin/user/create']);
  assert.ok(has(`${F('api/controllers/admin/UserController.js', 'module.exports.create')} WRITES_MODEL model:user`));
});

test('T54 populate with a declared association yields inferred READS_MODEL', () => {
  const e = edges(p, "source_id = ? AND target_id = 'model:pet'", F('api/controllers/user/view-profile.js', 'module.exports.fn'));
  assert.deepEqual(e.map((x) => [x.kind, x.resolution, x.confidence, JSON.parse(x.attributes_json)]), [['READS_MODEL', 'inferred', 'medium', { operation: 'populate', via: 'pets' }]]);
});

test('T55 package imports are IMPORTS -> PACKAGE and external, never unresolved', () => {
  assert.ok(has('module:api/services/PaymentService.js IMPORTS package:stripe'));
  assert.ok(has('module:api/services/NotifyService.js IMPORTS package:node:fs'));
  const ext = refs(p, "ref_kind = 'import' AND resolution_status = 'external'");
  assert.ok(ext.length >= 3);
  assert.equal(node(p, 'package:stripe').kind, 'PACKAGE');
});

test('helper and action contracts are extracted (inputs/exits)', () => {
  const s = p.queries.getSymbol('helper:payment/process').symbol;
  assert.deepEqual(s.attributes.inputs, { amount: { type: 'number', required: true } });
  const a = p.queries.getSymbol('action:payment/create').symbol;
  assert.deepEqual(a.attributes.exits, { success: { description: 'Created' } });
});

test('T21 full index twice: identical deterministic output', () => {
  const { exportNormalized } = awaitHelpers;
  const a = JSON.stringify(exportNormalized(p));
  p.indexer.sync({ full: true });
  const b = JSON.stringify(exportNormalized(p));
  assert.equal(a, b);
  const root2 = copyFixture('sails-app');
  const p2 = indexed(root2);
  const c = JSON.stringify(exportNormalized(p2)).replaceAll(root2, root);
  p2.close();
  assert.equal(a, c);
});

const awaitHelpers = await import('../helpers/util.mjs');
