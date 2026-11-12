import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFixture, indexed, F, repoRoot, write } from '../helpers/util.mjs';

const { fitResponse } = await import(path.join(repoRoot, 'dist/query/budget.js'));

let root;
let p;
before(() => {
  root = copyFixture('sails-app');
  p = indexed(root);
});
after(() => p.close());

test('every query result carries graph metadata', () => {
  const r = p.queries.callers('helper:payment/process');
  assert.deepEqual(Object.keys(r.graph).sort(), ['generation', 'scannedAt', 'status']);
  assert.equal(r.graph.status, 'current');
  assert.ok(r.graph.generation >= 1);
});

test('callers of a helper include the calling function with exact evidence, depth and via', () => {
  const r = p.queries.callers('helper:payment/process', { depth: 2 });
  const direct = r.results.filter((x) => x.depth === 1 && x.relation === 'CALLS').map((x) => x.sourceId).sort();
  assert.deepEqual(direct, [F('api/controllers/payment/create.js', 'module.exports.fn'), F('api/controllers/payment/refund.js', 'module.exports.fn')]);
  const e = r.results.find((x) => x.sourceId === F('api/controllers/payment/create.js', 'module.exports.fn'));
  assert.deepEqual(e.evidence, { file: 'api/controllers/payment/create.js', startLine: 10, startCol: 26, endLine: 10, endCol: 87, expression: 'sails.helpers.payment.process.with(...)' });
  assert.equal(e.via, 'helper:payment/process');
  assert.ok(r.results.some((x) => x.sourceId === 'action:payment/create' && x.relation === 'IMPLEMENTED_BY'));
  assert.ok(r.nodes['action:payment/create']);
  assert.equal(r.nodes['helper:payment/process'].kind, 'HELPER');
});

test('callees from an action expand through IMPLEMENTED_BY; model access only on request', () => {
  const plain = p.queries.callees('action:payment/create', { depth: 3 });
  assert.ok(plain.results.some((x) => x.relation === 'CALLS' && x.targetId === 'helper:payment/process'));
  assert.ok(!plain.results.some((x) => x.relation === 'WRITES_MODEL'));
  const withModels = p.queries.callees('action:payment/create', { depth: 3, includeModelAccess: true });
  assert.ok(withModels.results.some((x) => x.relation === 'WRITES_MODEL' && x.targetId === 'model:payment'));
});

test('T33 circular calls: traversal is bounded and cycle-safe', () => {
  const r = p.queries.callees(F('api/services/NotifyService.js', 'ping'), { depth: 5 });
  assert.deepEqual(r.results.map((x) => `${x.sourceId.split('::')[1]}>${x.targetId.split('::')[1]}`), ['ping>pong', 'pong>ping']);
  assert.equal(r.cycleDetected, true);
});

test('T34 multiple matching symbols return ambiguity instead of an arbitrary choice', () => {
  const found = p.queries.findSymbol('create');
  assert.ok(found.results.length > 2);
  assert.throws(() => p.queries.callers('create'), (err) => {
    assert.match(err.message, /ambiguous/);
    assert.equal(err.details.code, 'ambiguous_symbol');
    assert.ok(err.details.candidates.length >= 2);
    return true;
  });
  assert.throws(() => p.queries.callers('helper:nope/zzz'), (err) => err.details.code === 'symbol_not_found');
  // A unique exact name resolves.
  assert.equal(p.queries.getSymbol('PaymentService').symbol.id, 'service:PaymentService');
});

test('T35 paths outside the root are denied', () => {
  assert.throws(() => p.queries.fileOutline('../../etc/passwd'), /outside the project root/);
  assert.throws(() => p.queries.fileOutline('/etc/passwd'), /outside the project root/);
  assert.throws(() => p.queries.analyzeChanges({ files: ['../x.js'] }), /outside the project root/);
  assert.throws(() => p.queries.unresolved({ file: '../../x.js' }), /outside the project root/);
});

test('T44 REFERENCES are excluded from default callers but included in impact', () => {
  const v = F('api/services/PaymentService.js', 'validate');
  const def = p.queries.callers(v, { depth: 1 });
  assert.deepEqual(def.results.filter((x) => x.relation !== 'IMPLEMENTED_BY').map((x) => [x.sourceId.split('::')[1], x.relation]), [['charge', 'CALLS']]);
  const withRefs = p.queries.callers(v, { depth: 1, includeReferences: true });
  assert.ok(withRefs.results.some((x) => x.relation === 'REFERENCES'));
  const imp = p.queries.impact(v, { depth: 1 });
  const fns = imp.potentiallyAffected.FUNCTION.map((x) => x.id);
  assert.ok(fns.includes(F('api/services/PaymentService.js', 'module.exports.formatAll')));
});

test('T51 concrete path matches patterns in declaration order', () => {
  const r = p.queries.traceRoute('GET', '/users/42');
  assert.deepEqual(r.matches.map((m) => [m.route.id, m.primary, m.matchType]), [['route:GET /users/:id', true, 'concrete']]);
  assert.deepEqual(r.matches[0].params, { id: '42' });
  const me = p.queries.traceRoute(undefined, 'GET /users/me');
  assert.deepEqual(me.matches.map((m) => [m.route.id, m.primary, m.matchType]), [['route:GET /users/me', true, 'pattern'], ['route:GET /users/:id', false, 'concrete']]);
  const legacy = p.queries.traceRoute('DELETE', '/legacy');
  assert.deepEqual(legacy.matches.map((m) => m.route.id), ['route:/legacy'], 'verbless route matches all methods');
  assert.match(r.note, /Blueprint/);
  const none = p.queries.traceRoute('GET', '/nope/1');
  assert.equal(none.matches.length, 0);
  assert.ok(none.hint);
});

test('trace_route shows policies in order and downstream model access', () => {
  const r = p.queries.traceRoute(undefined, 'POST /api/payments/9/refund', { depth: 4 });
  const m = r.matches[0];
  assert.equal(m.route.targetId, 'action:payment/refund');
  assert.deepEqual(m.policies.map((x) => [x.order, x.policyId]), [[0, 'policy:isAdmin'], [1, 'policy:isLoggedIn']]);
  const rel = m.downstream.results.map((x) => `${x.relation} ${x.targetId}`);
  assert.ok(rel.includes('WRITES_MODEL model:payment'));
});

test('list_routes in declaration order with filters', () => {
  const all = p.queries.listRoutes({});
  assert.equal(all.routes[0].id, 'route:GET /');
  assert.deepEqual(all.routes.map((r) => r.order), [...all.routes.keys()]);
  const post = p.queries.listRoutes({ method: 'POST', pathPrefix: '/api' });
  assert.deepEqual(post.routes.map((r) => r.id), ['route:POST /api/payments', 'route:POST /api/payments/:id/refund']);
  assert.deepEqual(post.routes[0].policies, ['policy:isLoggedIn', 'policy:isAdmin']);
  const byAction = p.queries.listRoutes({ action: 'user/view-profile' });
  assert.equal(byAction.routes.length, 2);
});

test('impact returns affected entry points with policies, distance and reason paths', () => {
  const r = p.queries.impact('helper:payment/process', { depth: 3 });
  const eps = r.affectedEntryPoints.map((e) => e.id);
  assert.ok(eps.includes('route:POST /api/payments'));
  assert.ok(eps.includes('action:payment/refund'));
  const action = r.affectedEntryPoints.find((e) => e.id === 'action:payment/create');
  assert.deepEqual(action.policies, ['policy:isLoggedIn', 'policy:isAdmin']);
  const route = r.potentiallyAffected.ROUTE.find((x) => x.id === 'route:POST /api/payments');
  assert.equal(route.reasonPath[0].id, 'helper:payment/process');
  assert.equal(route.reasonPath.at(-1).relation, 'ROUTES_TO');
  assert.ok(r.missingCoverageWarnings.length >= 1);
});

test('T56 analyze_changes with two files seeds from owned nodes and returns entry-point routes', () => {
  const r = p.queries.analyzeChanges({ files: ['api/helpers/user/find-by-email.js', 'api/models/Payment.js'], depth: 3 });
  assert.ok(r.seeds > 2);
  assert.deepEqual(r.entitiesIfDeletedOrRenamed.map((e) => e.id).sort(), ['helper:user/find-by-email', 'model:payment']);
  const routes = r.affectedEntryPoints.filter((e) => e.kind === 'ROUTE').map((e) => e.id).sort();
  assert.deepEqual(routes, ['route:GET /users/:id', 'route:GET /users/me', 'route:POST /api/payments', 'route:POST /api/payments/:id/refund']);
});

test('model usage groups accessors by operation', () => {
  const r = p.queries.modelUsage('User');
  assert.equal(r.model.id, 'model:user');
  assert.ok(r.accessors.read.length >= 2);
  assert.ok(r.accessors.write.length >= 2);
  assert.deepEqual(r.associations.outgoing.map((a) => a.targetId), ['model:pet']);
  assert.deepEqual(r.associations.incoming.map((a) => a.sourceId).sort(), ['model:payment', 'model:pet']);
  const pet = p.queries.modelUsage('model:pet');
  assert.deepEqual(pet.accessors.populate.map((a) => a.operation), ['populate']);
  assert.ok(Object.values(r.entryPoints).flat().includes('route:POST /legacy-user'));
});

test('file outline: functions, owners, call counts, unresolved references', () => {
  const r = p.queries.fileOutline('api/controllers/user/view-profile.js');
  assert.equal(r.file.status, 'ok');
  const fn = r.symbols.find((s) => s.id === F('api/controllers/user/view-profile.js', 'module.exports.fn'));
  assert.deepEqual(fn.implements, ['action:user/view-profile']);
  assert.equal(fn.outgoingCalls, 3);
  assert.equal(r.unresolved.length, 1);
  assert.throws(() => p.queries.fileOutline('api/nope.js'), /not indexed/);
});

test('get_symbol detail with snippet and freshness caveat', () => {
  const r = p.queries.getSymbol('helper:user/find-by-email', { includeSnippet: true });
  assert.equal(r.snippet.freshness, 'matches_indexed_content');
  assert.match(r.snippet.text, /Find by email/);
  assert.ok(r.incoming.some((e) => e.relation === 'CALLS'));
});

test('find_paths between a route and a model', () => {
  const r = p.queries.findPaths('route:POST /api/payments', 'model:payment', { maxDepth: 5 });
  assert.equal(r.paths.length, 1);
  assert.deepEqual(r.paths[0].map((s) => s.relation), ['START', 'ROUTES_TO', 'IMPLEMENTED_BY', 'CALLS', 'IMPLEMENTED_BY', 'WRITES_MODEL']);
});

test('pagination is stable and cursors from another generation are rejected (cursor_stale)', () => {
  const page1 = p.queries.callers('model:user', { depth: 1, relations: ['READS_MODEL', 'WRITES_MODEL'], limit: 2 });
  const all = p.queries.callers('model:user', { depth: 1, relations: ['READS_MODEL', 'WRITES_MODEL'], limit: 100 });
  assert.equal(page1.truncated, true);
  const page2 = p.queries.callers('model:user', { depth: 1, relations: ['READS_MODEL', 'WRITES_MODEL'], limit: 2, cursor: page1.nextCursor });
  assert.deepEqual([...page1.results, ...page2.results], all.results.slice(0, 4));
  write(root, 'api/helpers/new.js', 'module.exports = { fn: async function () {} };\n');
  p.indexer.sync();
  assert.throws(() => p.queries.callers('model:user', { depth: 1, cursor: page1.nextCursor }), /cursor_stale/);
});

test('depth and limit are clamped to configured maxima', () => {
  const r = p.queries.callees('action:payment/create', { depth: 50, limit: 100000 });
  assert.equal(r.query.depth, 5);
  assert.equal(r.query.limit, 500);
  assert.throws(() => p.queries.callees('action:payment/create', { depth: 0 }), /depth/);
});

test('T57 response budget: deterministic truncation with truncated flag and cursor/hint', () => {
  const big = { query: { tool: 'x' }, graph: { generation: 1 }, results: Array.from({ length: 500 }, (_, i) => ({ sourceId: `function:a.js::f${i}`, targetId: 'helper:x', relation: 'CALLS', pad: 'y'.repeat(100) })), nodes: {}, truncated: false };
  const a = fitResponse(big, 5000, (o) => `cursor-${o}`);
  const b = fitResponse(big, 5000, (o) => `cursor-${o}`);
  assert.deepEqual(a, b);
  assert.ok(Buffer.byteLength(JSON.stringify(a)) <= 5000);
  assert.equal(a.truncated, true);
  assert.ok(a.results.length > 0 && a.results.length < 500);
  assert.equal(a.results[0].sourceId, 'function:a.js::f0');
  assert.equal(a.nextCursor, `cursor-${a.results.length}`);
  assert.match(a.hint, /truncated/);
  const small = { results: [1], truncated: false };
  assert.equal(fitResponse(small, 5000), small);
});
