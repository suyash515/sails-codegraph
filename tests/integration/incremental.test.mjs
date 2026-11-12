import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFixture, indexed, edges, refs, node, write, remove, rename, edgeSet, exportNormalized, F, open } from '../helpers/util.mjs';

const CREATE_FN = F('api/controllers/payment/create.js', 'module.exports.fn');
const PROCESS_FN = F('api/helpers/payment/process.js', 'module.exports.fn');

function setup() {
  const root = copyFixture('incremental');
  const p = indexed(root);
  return { root, p };
}

const callersOf = (p, id) => p.queries.callers(id, { depth: 1 }).results.filter((r) => r.relation === 'CALLS').map((r) => r.sourceId);

test('Section 13 worked example: route -> action -> fn -> helper -> fn -> model', () => {
  const { p } = setup();
  try {
    const t = p.queries.traceRoute('POST', '/api/payments', { depth: 3 });
    assert.equal(t.matches.length, 1);
    assert.equal(t.matches[0].route.targetId, 'action:payment/create');
    const chain = t.matches[0].downstream.results.map((r) => `${r.sourceId} ${r.relation} ${r.targetId}`);
    assert.deepEqual(chain, [
      `action:payment/create IMPLEMENTED_BY ${CREATE_FN}`,
      `${CREATE_FN} CALLS helper:payment/process`,
      `helper:payment/process IMPLEMENTED_BY ${PROCESS_FN}`,
      `${PROCESS_FN} WRITES_MODEL model:payment`,
    ]);
    assert.equal(t.graph.status, 'current');
  } finally {
    p.close();
  }
});

test('T22 no-op sync reparses zero files', () => {
  const { p } = setup();
  try {
    const before = p.queries.graphMeta().generation;
    const s = p.indexer.sync();
    assert.equal(s.metrics.filesParsed, 0);
    assert.equal(s.metrics.filesUnchanged, s.metrics.filesEnumerated);
    assert.equal(s.metrics.edgesAdded + s.metrics.edgesRemoved, 0);
    assert.equal(s.generation, before, 'a no-op sync does not create a new generation');
    assert.equal(s.status, 'current');
  } finally {
    p.close();
  }
});

test('touching a file without changing content does not reparse it', () => {
  const { root, p } = setup();
  try {
    const fs = awaitFs;
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(`${root}/api/models/Payment.js`, t, t);
    const s = p.indexer.sync();
    assert.equal(s.metrics.filesParsed, 0);
    assert.equal(p.indexer.sync().metrics.filesParsed, 0, 'mtime was updated in the manifest');
  } finally {
    p.close();
  }
});

test('T23 controller changed to call another helper: only the controller is reparsed; old edge removed, new edge added', () => {
  const { root, p } = setup();
  try {
    write(root, 'api/helpers/payment/validate.js', `module.exports = { fn: async function (inputs, exits) { return exits.success(); } };\n`);
    p.indexer.sync();
    write(root, 'api/controllers/payment/create.js', `module.exports = {
  fn: async function (inputs, exits) {
    const result = await sails.helpers.payment.validate.with({ amount: inputs.amount });
    return exits.success(result);
  }
};
`);
    const s = p.indexer.sync();
    assert.deepEqual(s.files.changed, ['api/controllers/payment/create.js']);
    assert.equal(s.metrics.filesParsed, 1);
    assert.deepEqual(callersOf(p, 'helper:payment/process'), []);
    assert.deepEqual(callersOf(p, 'helper:payment/validate'), [CREATE_FN]);
    assert.deepEqual(s.summary.edgesRemoved.filter((e) => e[1] === 'CALLS'), [[CREATE_FN, 'CALLS', 'helper:payment/process']]);
    assert.deepEqual(s.summary.edgesAdded.filter((e) => e[1] === 'CALLS'), [[CREATE_FN, 'CALLS', 'helper:payment/validate']]);
  } finally {
    p.close();
  }
});

test('T23b call to a helper that does not exist is persisted as unresolved_missing', () => {
  const { root, p } = setup();
  try {
    write(root, 'api/controllers/payment/create.js', `module.exports = { fn: async function (inputs, exits) { await sails.helpers.payment.nope(); } };\n`);
    p.indexer.sync();
    const r = refs(p, 'source_node_id = ?', CREATE_FN);
    assert.deepEqual(r.map((x) => [x.resolution_status, x.unresolved_reason, x.lookup_key]), [['unresolved_missing', 'helper_not_found', 'helper-access:payment.nope']]);
  } finally {
    p.close();
  }
});

test('T24 helper deleted, caller untouched: raw reference survives and becomes unresolved; edge removed', () => {
  const { root, p } = setup();
  try {
    remove(root, 'api/helpers/payment/process.js');
    const s = p.indexer.sync();
    assert.equal(s.metrics.filesParsed, 0, 'caller is not reparsed');
    assert.deepEqual(s.files.deleted, ['api/helpers/payment/process.js']);
    assert.equal(node(p, 'helper:payment/process'), undefined);
    assert.equal(edges(p, "target_id = 'helper:payment/process'").length, 0);
    const r = refs(p, 'source_node_id = ?', CREATE_FN);
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].resolution_status, r[0].unresolved_reason], ['unresolved_missing', 'helper_not_found']);
    assert.ok(s.metrics.referencesReresolved >= 1);
  } finally {
    p.close();
  }
});

test('T25 helper added after an unresolved reference: existing caller resolves without reparsing', () => {
  const { root, p } = setup();
  try {
    const content = awaitFs.readFileSync(`${root}/api/helpers/payment/process.js`, 'utf8');
    remove(root, 'api/helpers/payment/process.js');
    p.indexer.sync();
    write(root, 'api/helpers/payment/process.js', content);
    const s = p.indexer.sync();
    assert.deepEqual(s.files.added, ['api/helpers/payment/process.js']);
    assert.equal(s.metrics.filesParsed, 1, 'only the new helper is parsed');
    assert.deepEqual(callersOf(p, 'helper:payment/process'), [CREATE_FN]);
    const ch = s.summary.referenceStatusChanges.find((c) => c.file === 'api/controllers/payment/create.js');
    assert.deepEqual([ch.from, ch.to], ['unresolved_missing', 'resolved']);
  } finally {
    p.close();
  }
});

test('T26/T58 helper renamed without caller edits: old key invalidated, new key registered, change summary lists it', () => {
  const { root, p } = setup();
  try {
    rename(root, 'api/helpers/payment/process.js', 'api/helpers/payment/execute.js');
    const s = p.indexer.sync();
    assert.equal(s.metrics.filesParsed, 1, 'only the renamed file is parsed (delete + add)');
    assert.deepEqual(s.files.added, ['api/helpers/payment/execute.js']);
    assert.deepEqual(s.files.deleted, ['api/helpers/payment/process.js']);
    assert.equal(node(p, 'helper:payment/process'), undefined);
    assert.ok(node(p, 'helper:payment/execute'));
    assert.deepEqual(callersOf(p, 'helper:payment/execute'), []);
    const r = refs(p, 'source_node_id = ?', CREATE_FN)[0];
    assert.equal(r.resolution_status, 'unresolved_missing');
    assert.ok(s.summary.nodesRemoved.includes('helper:payment/process'));
    assert.ok(s.summary.nodesAdded.includes('helper:payment/execute'));
    assert.deepEqual(s.summary.referenceStatusChanges.map((c) => [c.file, c.expression, c.from, c.to, c.reason]), [
      ['api/controllers/payment/create.js', 'sails.helpers.payment.process.with(...)', 'resolved', 'unresolved_missing', 'helper_not_found'],
    ]);
    assert.ok(s.summary.edgesRemoved.some((e) => e[0] === CREATE_FN && e[2] === 'helper:payment/process'));
    assert.equal(p.queries.graphMeta().status, 'current');
    // Persisted for get_index_status
    assert.deepEqual(p.queries.indexStatus().lastSyncSummary.generation, s.generation);
  } finally {
    p.close();
  }
});

test('T27 service export and model identity changes re-resolve all relevant references', () => {
  const { root, p } = setup();
  try {
    const LIST_FN = F('api/controllers/payment/list.js', 'module.exports.fn');
    write(root, 'api/services/LedgerService.js', 'module.exports = { sum: function (rows) { return rows.length; } };\n');
    let s = p.indexer.sync();
    assert.equal(s.metrics.filesParsed, 1);
    let e = edges(p, "source_id = ? AND kind = 'CALLS'", LIST_FN);
    assert.deepEqual(e.map((x) => [x.target_id, x.confidence]), [['service:LedgerService', 'medium']], 'falls back to the service entity when the method is gone');
    write(root, 'api/models/Payment.js', "module.exports = { identity: 'charge', globalId: 'Charge', attributes: {} };\n");
    s = p.indexer.sync();
    assert.equal(s.metrics.filesParsed, 1);
    e = edges(p, "source_id = ? AND kind = 'READS_MODEL'", LIST_FN);
    assert.equal(e.length, 0);
    assert.deepEqual(refs(p, "source_node_id = ? AND ref_kind = 'model' AND resolution_status != 'resolved'", LIST_FN).map((r) => r.unresolved_reason), ['unknown_global']);
    assert.ok(node(p, 'model:charge'));
    assert.equal(edges(p, "source_id = ? AND target_id = 'model:charge'", PROCESS_FN).length, 0);
  } finally {
    p.close();
  }
});

test('T28 route config changed: route edge replaced', () => {
  const { root, p } = setup();
  try {
    write(root, 'config/routes.js', `module.exports.routes = {\n  'POST /api/v2/payments': 'payment/create',\n  ...require('./routes/reports')\n};\n`);
    const s = p.indexer.sync();
    assert.equal(s.metrics.filesParsed, 1);
    assert.equal(node(p, 'route:POST /api/payments'), undefined);
    const e = edgeSet(p, ['ROUTES_TO']);
    assert.ok(e.has('route:POST /api/v2/payments ROUTES_TO action:payment/create'));
    assert.ok(e.has('route:GET /api/payments ROUTES_TO action:payment/list'));
    assert.equal(e.size, 2);
  } finally {
    p.close();
  }
});

test('T50 editing only a required route file updates the route table and reparses only that file', () => {
  const { root, p } = setup();
  try {
    write(root, 'config/routes/reports.js', "module.exports = {\n  'GET /api/reports': 'payment/list'\n};\n");
    const s = p.indexer.sync();
    assert.deepEqual(s.files.changed, ['config/routes/reports.js']);
    assert.equal(s.metrics.filesParsed, 1);
    const e = edgeSet(p, ['ROUTES_TO']);
    assert.ok(e.has('route:GET /api/reports ROUTES_TO action:payment/list'));
    assert.ok(!e.has('route:GET /api/payments ROUTES_TO action:payment/list'));
    assert.ok(e.has('route:POST /api/payments ROUTES_TO action:payment/create'));
  } finally {
    p.close();
  }
});

test('route action added later resolves the existing unresolved route target without reparsing routes', () => {
  const { root, p } = setup();
  try {
    write(root, 'config/routes.js', `module.exports.routes = {\n  'POST /api/payments': 'payment/create',\n  'GET /api/refunds': 'refund/list',\n  ...require('./routes/reports')\n};\n`);
    p.indexer.sync();
    assert.equal(refs(p, "source_node_id = 'route:GET /api/refunds'")[0].resolution_status, 'unresolved_missing');
    write(root, 'api/controllers/refund/list.js', 'module.exports = { fn: async function (i, exits) { return exits.success(); } };\n');
    const s = p.indexer.sync();
    assert.deepEqual(s.files.added, ['api/controllers/refund/list.js']);
    assert.equal(s.metrics.filesParsed, 1);
    assert.ok(edgeSet(p, ['ROUTES_TO']).has('route:GET /api/refunds ROUTES_TO action:refund/list'));
  } finally {
    p.close();
  }
});

test('T30 changes made while no watcher was running are caught by the next sync (new process)', () => {
  const { root, p } = setup();
  p.close();
  write(root, 'api/controllers/payment/create.js', 'module.exports = { fn: async function (inputs, exits) { return exits.success(); } };\n');
  write(root, 'api/helpers/payment/refund.js', 'module.exports = { fn: async function () {} };\n');
  const p2 = open(root);
  try {
    const c = p2.indexer.check();
    assert.equal(c.current, false);
    assert.deepEqual(c.changed, ['api/controllers/payment/create.js']);
    assert.deepEqual(c.added, ['api/helpers/payment/refund.js']);
    const s = p2.indexer.sync();
    assert.equal(s.metrics.filesParsed, 2);
    assert.deepEqual(callersOf(p2, 'helper:payment/process'), []);
    assert.equal(p2.indexer.check().current, true);
  } finally {
    p2.close();
  }
});

test('T31 syntax error after an edit: stale reported, last good representation kept, recovers when fixed', () => {
  const { root, p } = setup();
  try {
    write(root, 'api/controllers/payment/create.js', 'module.exports = { fn: async function (inputs, exits) { await sails.helpers.payment.validate( \n');
    const s = p.indexer.sync();
    assert.equal(s.status, 'stale');
    assert.deepEqual(s.files.parseErrors, ['api/controllers/payment/create.js']);
    assert.equal(p.queries.graphMeta().status, 'stale');
    assert.deepEqual(callersOf(p, 'helper:payment/process'), [CREATE_FN], 'last known-good edges retained');
    const st = p.queries.stats();
    assert.ok(st.pendingErrors.length >= 1);
    const c = p.indexer.check();
    assert.equal(c.current, false);
    // Another no-op sync does not reparse the broken file and stays stale.
    const again = p.indexer.sync();
    assert.equal(again.metrics.filesParsed, 0);
    assert.equal(again.status, 'stale');
    write(root, 'api/controllers/payment/create.js', 'module.exports = { fn: async function (inputs, exits) { return exits.success(); } };\n');
    const fixed = p.indexer.sync();
    assert.equal(fixed.status, 'current');
    assert.deepEqual(callersOf(p, 'helper:payment/process'), []);
    assert.equal(p.queries.stats().pendingErrors.length, 0);
  } finally {
    p.close();
  }
});

test('a brand new file with a syntax error leaves the graph stale (never current)', () => {
  const { root, p } = setup();
  try {
    write(root, 'api/helpers/broken.js', 'module.exports = {{{');
    const s = p.indexer.sync();
    assert.equal(s.status, 'stale');
    assert.deepEqual(s.files.parseErrors, ['api/helpers/broken.js']);
  } finally {
    p.close();
  }
});

test('incremental result equals a fresh full index of the same tree', () => {
  const { root, p } = setup();
  try {
    rename(root, 'api/helpers/payment/process.js', 'api/helpers/payment/execute.js');
    write(root, 'api/controllers/payment/create.js', `module.exports = { fn: async function (inputs, exits) { await sails.helpers.payment.execute(); await Payment.destroy({}); } };\n`);
    write(root, 'config/routes/reports.js', "module.exports = { 'GET /r': 'payment/list' };\n");
    remove(root, 'api/services/LedgerService.js');
    p.indexer.sync();
    const inc = JSON.stringify(exportNormalized(p).nodes) + JSON.stringify(exportNormalized(p).edges) + JSON.stringify(exportNormalized(p).references);
    p.indexer.sync({ full: true });
    const full = JSON.stringify(exportNormalized(p).nodes) + JSON.stringify(exportNormalized(p).edges) + JSON.stringify(exportNormalized(p).references);
    assert.equal(inc, full);
  } finally {
    p.close();
  }
});

test('config change forces a full re-index on the next sync', () => {
  const { root, p } = setup();
  p.close();
  write(root, 'sails-codegraph.config.json', JSON.stringify({ resolution: { externalGlobals: ['moment'] } }));
  const p2 = open(root);
  try {
    const s = p2.indexer.sync();
    assert.equal(s.metrics.mode, 'full');
    assert.equal(p2.indexer.sync().metrics.mode, 'incremental');
  } finally {
    p2.close();
  }
});

const awaitFs = await import('node:fs');
