import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../helpers/util.mjs';

const { parseFile } = api;
const fnIds = (r) => r.nodes.filter((n) => n.kind === 'FUNCTION').map((n) => n.id.split('::')[1]);

test('T01 actions2 module.exports.fn anonymous async function -> ACTION + FUNCTION + IMPLEMENTED_BY', () => {
  const r = parseFile('api/controllers/payment/create.js', `module.exports = {\n  fn: async function (inputs, exits) {\n    return exits.success();\n  }\n};\n`);
  const fn = r.nodes.find((n) => n.id === 'function:api/controllers/payment/create.js::module.exports.fn');
  assert.ok(fn);
  assert.deepEqual([fn.span.startLine, fn.span.startCol, fn.span.endLine, fn.span.endCol], [2, 7, 4, 4]);
  assert.ok(r.nodes.find((n) => n.id === 'action:payment/create' && n.kind === 'ACTION'));
  assert.ok(r.edges.find((e) => e.source === 'action:payment/create' && e.kind === 'IMPLEMENTED_BY' && e.target === fn.id));
  assert.equal(r.references.length, 0, 'exits.success is plumbing, not a reference');
});

test('T02 actions2 arrow fn is discovered', () => {
  const r = parseFile('api/controllers/x.js', `module.exports = { fn: async () => { return 1; } };`);
  assert.deepEqual(fnIds(r), ['module.exports.fn']);
  assert.ok(r.edges.find((e) => e.kind === 'IMPLEMENTED_BY' && e.source === 'action:x'));
});

test('T03 classic controller with two actions', () => {
  const r = parseFile('api/controllers/UserController.js', `module.exports = {\n  create: async function (req, res) {},\n  find: function (req, res) {},\n  _config: {}\n};`);
  const actions = r.nodes.filter((n) => n.kind === 'ACTION').map((n) => n.id).sort();
  assert.deepEqual(actions, ['action:user/create', 'action:user/find']);
  assert.ok(r.registry.find((k) => k.key === 'action-alias:usercontroller.create'));
});

test('T04 module.exports = function -> exported anonymous FUNCTION', () => {
  const r = parseFile('api/policies/isLoggedIn.js', `module.exports = async function (req, res, proceed) { return proceed(); };`);
  assert.deepEqual(fnIds(r), ['module.exports']);
  assert.ok(r.edges.find((e) => e.source === 'policy:isLoggedIn' && e.kind === 'IMPLEMENTED_BY'));
  assert.equal(r.references.length, 0);
});

test('Section 7.3: all function shapes produce FUNCTION nodes with stable lexical names', () => {
  const src = `
function named() {}
const expression = function () {};
const arrow = async () => {};
module.exports = {
  fn: async function (inputs, exits) {},
  other: () => {},
  method() {},
  nested: { deep: function () {} }
};
exports.run = async function () {};
class Service { async execute() {} }
[1].map(function () {});
`;
  const r = parseFile('lib/shapes.js', src);
  assert.deepEqual(fnIds(r).sort(), [
    '$anon1',
    'Service.execute',
    'arrow',
    'exports.run',
    'expression',
    'module.exports.fn',
    'module.exports.method',
    'module.exports.nested.deep',
    'module.exports.other',
    'named',
  ]);
});

test('T15 a local binding shadows the User model global', () => {
  const r = parseFile('api/controllers/s.js', `module.exports = { fn: async function () { const User = makeThing(); await User.findOne(); } };`);
  assert.ok(!r.references.some((x) => x.spec.type === 'global_member' && x.spec.name === 'User'));
});

test('T39 console/res/exits/_ /JSON are not persisted references; counted instead', () => {
  const r = parseFile('api/controllers/UserController.js', `module.exports = {
    find: async function (req, res) {
      console.log('x'); _.map([], (x) => x); JSON.parse('{}'); sails.log.info('y');
      req.param('id'); return res.json({});
    }
  };`);
  assert.equal(r.references.length, 0);
  assert.equal(r.counts.external, 3);
  assert.ok(r.counts.plumbing >= 3);
});

test('a locally declared res object is not plumbing (and not a reference either)', () => {
  const r = parseFile('lib/x.js', `function f() { const res = { json() {} }; res.json(); }`);
  assert.equal(r.counts.plumbing, 0);
  assert.equal(r.references.filter((x) => x.refKind === 'call').length, 1, 'res.json resolves to the local object method');
});

test('helper invocation styles and modifiers', () => {
  const r = parseFile('api/controllers/a.js', `module.exports = { fn: async function () {
    await sails.helpers.formatWelcomeMessage('Ada');
    await sails.helpers.user.findByEmail.with({ email: 1 });
    sails.helpers.payment.processPayment.with({ amount: 1 }).exec(() => {});
    await sails.helpers['user']['findByEmail'].with({ email: 2 });
    sails.helpers.x.y.with({}).intercept('a', () => 1).tolerate('b');
    const h = sails.helpers.user.findByEmail;
    await h.with({});
    sails.helpers[name].x();
  } };`);
  const specs = r.references.map((x) => x.spec);
  const helper = specs.filter((s) => s.type === 'helper');
  assert.deepEqual(helper.map((s) => [s.access, s.edge, s.call.invocation, s.call.modifiers.join(',')]), [
    ['formatWelcomeMessage', 'CALLS', 'direct', ''],
    ['user.findByEmail', 'CALLS', 'with', ''],
    ['payment.processPayment', 'CALLS', 'with', 'exec'],
    ['user.findByEmail', 'CALLS', 'with', ''],
    ['x.y', 'CALLS', 'with', 'intercept,tolerate'],
    ['user.findByEmail', 'REFERENCES', 'none', ''],
    ['user.findByEmail', 'CALLS', 'with', ''],
  ]);
  assert.ok(specs.some((s) => s.type === 'preset' && s.status === 'unresolved_dynamic'));
});

test('model operations keep modifiers, populate yields a separate reference, native query visible', () => {
  const r = parseFile('api/helpers/h.js', `module.exports = { fn: async function () {
    await User.create({}).fetch();
    await sails.models['user'].find().populate('pets');
    await User.getDatastore().sendNativeQuery('select 1');
    await sails.sendNativeQuery('select 1');
    await sails.models[x].find();
  } };`);
  const s = r.references.map((x) => x.spec);
  assert.deepEqual(s[0], { type: 'global_member', name: 'User', member: 'create', modifiers: ['fetch'], edge: 'CALLS' });
  assert.equal(s[1].type, 'model_member');
  assert.equal(s[1].identity, 'user');
  assert.deepEqual(s[2], { type: 'populate', base: { identity: 'user' }, via: 'pets' });
  assert.equal(s[3].native, true);
  assert.deepEqual([s[4].status, s[4].reason], ['unsupported', 'native_query_no_model']);
  assert.deepEqual([s[5].status, s[5].reason], ['unresolved_dynamic', 'computed_model_identity']);
});

test('destructured require, shorthand exports, this.sibling, function references', () => {
  const r = parseFile('api/services/S.js', `
const { charge, refund: doRefund } = require('./PaymentService');
function local() {}
module.exports = {
  local,
  a: function () { charge(); doRefund(); this.local(); [1].map(local); },
  b: () => { this.local(); }
};`);
  const s = r.references.map((x) => [x.refKind, x.spec.type, x.spec.member ?? x.spec.nodeId ?? x.spec.modules?.[0], x.spec.resolution ?? '']);
  assert.deepEqual(s, [
    ['import', 'import', 'api/services/PaymentService', ''],
    ['call', 'module_member', 'charge', 'static'],
    ['call', 'module_member', 'refund', 'static'],
    ['call', 'module_member', 'local', 'inferred'],
    ['reference', 'node', 'function:api/services/S.js::local', ''],
  ]);
  assert.ok(r.registry.find((k) => k.key === 'export:api/services/S.js#local' && k.nodeId === 'function:api/services/S.js::local'));
});

test('package imports and outside-root requires', () => {
  const r = parseFile('api/x.js', `require('stripe'); require('node:fs'); require('../../../etc/x'); require(dyn); import y from './y';`);
  const s = r.references.map((x) => x.spec);
  assert.deepEqual(s.map((x) => x.type), ['package', 'package', 'preset', 'preset', 'import']);
  assert.equal(s[2].reason, 'outside_root');
  assert.equal(s[3].reason, 'computed_require');
});

test('syntax errors are reported, not thrown', () => {
  const r = parseFile('api/controllers/bad.js', `module.exports = { fn: async function ( { `);
  assert.equal(r.parseOk, false);
  assert.ok(r.diagnostics.some((d) => d.code === 'PARSE_ERROR'));
});

test('deeply nested source does not crash the parser', () => {
  const deep = `${'['.repeat(5000)}${']'.repeat(5000)}`;
  const r = parseFile('lib/deep.js', `const x = ${deep};`);
  assert.equal(typeof r.parseOk, 'boolean');
});
