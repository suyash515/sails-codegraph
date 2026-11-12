// Synthetic benchmark: generates a Sails-like app with N files and measures full index,
// no-op sync, single-file edit and a callers query. Usage: node scripts/bench.mjs [files=1000]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { openProject } = await import(path.join(root, 'dist/index.js'));
const N = Number(process.argv[2] ?? 1000);
const app = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-bench-'));
const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true }); fs.writeFileSync(path.join(app, rel), s); };
w('package.json', '{"name":"bench","dependencies":{"sails":"^1.5.0"}}');
const per = Math.floor(N / 4);
const routes = [];
for (let i = 0; i < per; i++) {
  w(`api/models/M${i}.js`, `module.exports = { attributes: { name: { type: 'string' }, other: { model: 'm${(i + 1) % per}' } } };\n`);
  w(`api/helpers/group${i % 20}/do-thing-${i}.js`, `module.exports = { inputs: { id: { type: 'number' } }, fn: async function (inputs, exits) {\n  const r = await M${i}.findOne({ id: inputs.id });\n  await Svc${i % 50}.run${i % 5}(r);\n  return exits.success(r);\n} };\n`);
  w(`api/controllers/area${i % 30}/action-${i}.js`, `module.exports = { fn: async function (inputs, exits) {\n  const x = await sails.helpers.group${i % 20}.doThing${i}.with({ id: 1 });\n  await M${(i * 7) % per}.create({}).fetch();\n  return exits.success(x);\n} };\n`);
  routes.push(`  'POST /area${i % 30}/action-${i}': 'area${i % 30}/action-${i}',`);
}
for (let i = 0; i < Math.min(50, per); i++) w(`api/services/Svc${i}.js`, `function helper() { return 1; }\nmodule.exports = {\n${[0, 1, 2, 3, 4].map((k) => `  run${k}: function (r) { return helper(r); },`).join('\n')}\n};\n`);
for (let i = 50; i < per; i++) w(`lib/util${i}.js`, `exports.f = function () { return ${i}; };\n`);
w('config/routes.js', `module.exports.routes = {\n${routes.join('\n')}\n};\n`);
w('config/policies.js', "module.exports.policies = { '*': 'isLoggedIn' };\n");
w('api/policies/isLoggedIn.js', 'module.exports = async function (req, res, proceed) { return proceed(); };\n');

const p = openProject({ root: app });
const mem = () => Math.round(process.memoryUsage().rss / 1e6);
const t = (fn) => { const s = performance.now(); const r = fn(); return [Math.round(performance.now() - s), r]; };
const [fullMs, full] = t(() => p.indexer.sync({ full: true }));
const [noopMs, noop] = t(() => p.indexer.sync());
w('api/helpers/group0/do-thing-0.js', `module.exports = { fn: async function (inputs, exits) { await M1.find(); return exits.success(); } };\n`);
const [editMs, edit] = t(() => p.indexer.sync());
const [qMs] = t(() => p.queries.callers('helper:group0/do-thing-0', { depth: 2 }));
const db = p.indexer.db;
const c = (sql) => db.prepare(sql).pluck().get();
const out = {
  environment: { node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, cpu: os.cpus()[0]?.model },
  files: full.metrics.filesEnumerated,
  nodes: c('SELECT count(*) FROM nodes'),
  edges: c('SELECT count(*) FROM edges'),
  rawReferences: c('SELECT count(*) FROM raw_references'),
  fullIndex: { ms: fullMs, filesParsed: full.metrics.filesParsed },
  noopSync: { ms: noopMs, filesParsed: noop.metrics.filesParsed },
  singleFileEdit: { ms: editMs, filesParsed: edit.metrics.filesParsed, referencesReresolved: edit.metrics.referencesReresolved },
  callersQueryMs: qMs,
  rssMB: mem(),
  dbBytes: fs.statSync(p.loaded.dbPath).size,
};
p.close();
fs.rmSync(app, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 2));
