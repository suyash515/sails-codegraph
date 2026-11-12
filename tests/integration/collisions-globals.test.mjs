import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFixture, indexed, edges, refs, write, F } from '../helpers/util.mjs';

test('T47 standalone + classic action identity collision -> ACTION_IDENTITY_CONFLICT and ambiguous references', () => {
  const root = copyFixture('sails-collisions');
  const p = indexed(root);
  try {
    const diags = p.indexer.db.prepare("SELECT code, file_path FROM diagnostics WHERE code = 'ACTION_IDENTITY_CONFLICT' ORDER BY file_path").all();
    assert.deepEqual(diags.map((d) => d.file_path), ['api/controllers/UserController.js', 'api/controllers/user/create.js']);
    const r = refs(p, "ref_kind = 'route_target'");
    assert.deepEqual(r.map((x) => [x.resolution_status, x.unresolved_reason]), [['ambiguous', 'action_identity_conflict']]);
    assert.equal(edges(p, "kind = 'ROUTES_TO'").length, 0, 'no arbitrary choice');
  } finally {
    p.close();
  }
});

test('T48 helper collision find-by-email.js + findByEmail.js -> ambiguous + HELPER_NAME_COLLISION', () => {
  const root = copyFixture('sails-collisions');
  const p = indexed(root);
  try {
    const diags = p.indexer.db.prepare("SELECT file_path FROM diagnostics WHERE code = 'HELPER_NAME_COLLISION' ORDER BY file_path").pluck().all();
    assert.deepEqual(diags, ['api/helpers/find-by-email.js', 'api/helpers/findByEmail.js']);
    const r = refs(p, 'source_node_id = ?', F('api/controllers/caller.js', 'module.exports.fn'));
    assert.deepEqual(r.map((x) => [x.resolution_status, x.unresolved_reason]), [['ambiguous', 'helper_name_collision']]);
    assert.equal(edges(p, 'source_id = ?', F('api/controllers/caller.js', 'module.exports.fn')).length, 0);
    // Resolving the collision (deleting one file) re-resolves the untouched caller.
    const { rmSync } = awaitFs;
    rmSync(`${root}/api/helpers/findByEmail.js`);
    const s = p.indexer.sync();
    assert.equal(s.metrics.filesParsed, 0);
    const after = edges(p, 'source_id = ?', F('api/controllers/caller.js', 'module.exports.fn'));
    assert.deepEqual(after.map((e) => e.target_id), ['helper:find-by-email']);
    assert.equal(p.indexer.db.prepare("SELECT count(*) FROM diagnostics WHERE code = 'HELPER_NAME_COLLISION'").pluck().get(), 0);
  } finally {
    p.close();
  }
});

test('T53 config/globals.js models:false and services:false', () => {
  const root = copyFixture('sails-globals-off');
  const p = indexed(root);
  try {
    const fn = F('api/controllers/list.js', 'module.exports.fn');
    const e = edges(p, 'source_id = ?', fn);
    assert.deepEqual(e.map((x) => [x.kind, x.target_id, x.start_line]), [['READS_MODEL', 'model:user', 4]], 'only sails.models.user.find() resolves');
    const r = refs(p, "source_node_id = ? AND resolution_status != 'resolved'", fn);
    assert.deepEqual(r.map((x) => [x.expression, x.unresolved_reason]), [
      ['User.find(...)', 'model_globals_disabled'],
      ['MailService.send(...)', 'service_globals_disabled'],
    ]);
    assert.equal(p.queries.coverage().globals_config, 'read');
    // Re-enabling globals re-resolves without reparsing the controller.
    write(root, 'config/globals.js', "module.exports.globals = { models: true, services: true };\n");
    const s = p.indexer.sync();
    assert.deepEqual(s.files.changed, ['config/globals.js']);
    assert.equal(s.metrics.filesParsed, 1);
    const after = edges(p, 'source_id = ?', fn).map((x) => [x.kind, x.target_id]);
    assert.deepEqual(after, [['CALLS', F('api/services/MailService.js', 'module.exports.send')], ['READS_MODEL', 'model:user'], ['READS_MODEL', 'model:user']]);
  } finally {
    p.close();
  }
});

const awaitFs = await import('node:fs');
