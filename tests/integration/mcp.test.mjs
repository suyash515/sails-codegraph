import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { copyFixture, cliPath, write, F } from '../helpers/util.mjs';
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_TOOLS = [
  'analyze_changes', 'analyze_impact', 'find_paths', 'find_symbol', 'get_callees', 'get_callers', 'get_file_outline',
  'get_index_status', 'get_model_usage', 'get_overview', 'get_symbol', 'get_unresolved', 'list_routes', 'sync_index', 'trace_route',
];

let root;
let client;
let stderr = '';

before(async () => {
  root = copyFixture('sails-app');
  fs.writeFileSync(path.join(root, 'sails-codegraph.config.json'), JSON.stringify({ indexing: { mcpScanIntervalMs: 0 } }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, 'mcp', '--root', root], stderr: 'pipe' });
  transport.stderr?.on('data', (d) => (stderr += d.toString()));
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
});

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { raw: r, data: JSON.parse(text) };
};

test('T37 MCP server registers the documented tools with input schemas', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, REQUIRED_TOOLS);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 20);
  }
});

test('T37 data tools return structured JSON with graph freshness metadata', async () => {
  const ov = await call('get_overview');
  assert.equal(ov.data.graph.status, 'current');
  assert.ok(ov.data.components.helpers.includes('helper:payment/process'));
  assert.deepEqual(ov.raw.structuredContent.graph, ov.data.graph);

  const fs1 = await call('find_symbol', { query: 'find-by-email' });
  assert.equal(fs1.data.results[0].id, 'helper:user/find-by-email');

  const callers = await call('get_callers', { symbolId: 'helper:user/find-by-email', depth: 1 });
  assert.ok(callers.data.results.some((r) => r.sourceId === F('api/controllers/user/view-profile.js', 'module.exports.fn')));
  assert.equal(typeof callers.data.graph.generation, 'number');

  const callees = await call('get_callees', { symbolId: 'action:payment/create', depth: 2 });
  assert.ok(callees.data.results.some((r) => r.targetId === 'helper:payment/process'));

  const tr = await call('trace_route', { path: 'POST /api/payments' });
  assert.equal(tr.data.matches[0].route.targetId, 'action:payment/create');
  const tr2 = await call('trace_route', { method: 'GET', path: '/users/42' });
  assert.equal(tr2.data.matches[0].route.id, 'route:GET /users/:id');

  const imp = await call('analyze_impact', { symbolId: 'helper:payment/process', depth: 3 });
  assert.ok(imp.data.affectedEntryPoints.some((e) => e.id === 'route:POST /api/payments'));

  const un = await call('get_unresolved', { groupBy: 'reason' });
  assert.equal(un.data.counts.unresolved, 4);
  assert.ok(un.data.groups['unresolved_missing:unknown_global'] === 1);

  const st = await call('get_index_status');
  assert.equal(st.data.graph.status, 'current');
  assert.equal(st.data.coverage.implicit_blueprints, 'not_analyzed');

  const sym = await call('get_symbol', { symbolId: 'helper:payment/process', includeSnippet: true });
  assert.ok(sym.data.symbol.attributes.inputs.amount);

  const out = await call('get_file_outline', { file: 'api/services/PaymentService.js' });
  assert.ok(out.data.symbols.some((s) => s.id === 'service:PaymentService'));

  const routes = await call('list_routes', { method: 'POST' });
  assert.ok(routes.data.routes.length >= 3);

  const mu = await call('get_model_usage', { model: 'Payment' });
  assert.equal(mu.data.model.id, 'model:payment');

  const ch = await call('analyze_changes', { files: ['api/helpers/payment/process.js', 'api/models/Payment.js'] });
  assert.ok(ch.data.affectedEntryPoints.length > 0);

  const fp = await call('find_paths', { from: 'route:POST /api/payments', to: 'model:payment' });
  assert.equal(fp.data.paths.length, 1);
});

test('MCP tool errors are structured with hints, not crashes; path traversal denied', async () => {
  const nf = await call('get_callers', { symbolId: 'helper:payment/proces' });
  assert.equal(nf.raw.isError, true);
  assert.match(nf.data.error.message, /not found/);
  assert.ok(nf.data.error.candidates.some((c) => c.id === 'helper:payment/process'));
  const amb = await call('get_callers', { symbolId: 'create' });
  assert.equal(amb.raw.isError, true);
  assert.equal(amb.data.error.code, 'ambiguous_symbol');
  const trav = await call('get_file_outline', { file: '../../../etc/passwd' });
  assert.equal(trav.raw.isError, true);
  assert.match(trav.data.error.message, /outside the project root/);
  const bad = await client.callTool({ name: 'get_callers', arguments: { symbolId: 'x', depth: 'deep' } }).catch((e) => ({ thrown: e }));
  assert.ok(bad.thrown || bad.isError, 'schema validation rejects bad input');
});

test('T57 over MCP: oversized results are truncated deterministically with a hint and a valid cursor', async () => {
  const small = copyFixture('sails-app');
  fs.writeFileSync(path.join(small, 'sails-codegraph.config.json'), JSON.stringify({ mcp: { maxResponseBytes: 3000 } }));
  const c2 = new Client({ name: 'budget-client', version: '0.0.0' });
  await c2.connect(new StdioClientTransport({ command: process.execPath, args: [cliPath, 'mcp', '--root', small], stderr: 'ignore' }));
  try {
    const run = async (args) => JSON.parse((await c2.callTool({ name: 'get_callers', arguments: args })).content[0].text);
    const args = { symbolId: 'model:user', relations: ['READS_MODEL', 'WRITES_MODEL', 'CALLS'], depth: 5, detail: 'full' };
    const a = await run(args);
    const b = await run(args);
    assert.deepEqual(a, b);
    assert.ok(Buffer.byteLength(JSON.stringify(a)) <= 3000);
    assert.equal(a.truncated, true);
    assert.match(a.hint, /truncated/);
    assert.ok(a.results.length > 0);
    assert.ok(a.nextCursor);
    const next = await run({ ...args, cursor: a.nextCursor });
    assert.notDeepEqual(next.results[0], a.results[0]);
    const imp = JSON.parse((await c2.callTool({ name: 'analyze_impact', arguments: { symbolId: 'model:user', depth: 5, detail: 'full' } })).content[0].text);
    assert.ok(Buffer.byteLength(JSON.stringify(imp)) <= 3000);
    assert.equal(imp.truncated, true);
  } finally {
    await c2.close();
  }
});

test('freshness: queries see file changes without an explicit sync (syncIfNeeded)', async () => {
  write(root, 'api/helpers/payment/process.js', 'module.exports = { fn: async function (inputs, exits) { return exits.success(); } };\n');
  const r = await call('get_callees', { symbolId: 'helper:payment/process', includeModelAccess: true });
  assert.ok(!r.data.results.some((x) => x.relation === 'WRITES_MODEL'));
  const st = await call('get_index_status');
  assert.ok(st.data.lastChangeSummary.totals.edgesRemoved >= 1);
  const s = await call('sync_index', {});
  assert.equal(s.data.metrics.filesParsed, 0);
  const forced = await call('sync_index', { force: true });
  assert.equal(forced.data.metrics.mode, 'full');
});

test('stderr carries logs (never stdout)', () => {
  assert.match(stderr, /graph ready/);
});

test('T37 raw stdio: stdout contains only JSON-RPC messages', async () => {
  const child = spawn(process.execPath, [cliPath, 'mcp', '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
  await waitFor(() => out.includes('"id":1'));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_overview', arguments: {} } });
  await waitFor(() => out.includes('"id":2'));
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
  const lines = out.split('\n').filter(Boolean);
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0');
});

async function waitFor(fn, ms = 20000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
