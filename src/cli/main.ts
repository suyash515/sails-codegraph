#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import { openProject, type Project } from '../project.js';
import { CONFIG_FILE_NAME, defaultConfigObject } from '../config/schema.js';
import { discoverProjectRoot, describeGit, detectSailsVersion, isPlausibleSailsRoot } from '../discovery/project-root.js';
import { loadConfig } from '../config/load.js';
import { UserInputError, OperationalError } from '../util/errors.js';
import { createLogger, type Logger } from '../util/log.js';
import { PACKAGE_VERSION } from '../version.js';
import { SyncCoordinator } from '../indexing/coordinator.js';
import { startWatcher } from '../indexing/watcher.js';
import { getSchemaVersion } from '../storage/sqlite.js';
import { SCHEMA_VERSION } from '../storage/migrations.js';
import type { Detail } from '../query/service.js';
import type { EdgeKind } from '../graph/types.js';

interface GlobalOpts {
  root?: string;
  config?: string;
  json?: boolean;
  verbose?: boolean;
  color?: boolean;
}

let verboseFlag = false;

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function printJson(obj: unknown): void {
  out(JSON.stringify(obj, null, 2));
}

function intOpt(name: string) {
  return (v: string) => {
    if (!/^\d+$/.test(v)) throw new UserInputError(`--${name} must be a non-negative integer (got "${v}").`);
    return Number(v);
  };
}

function globals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals() as GlobalOpts;
}

function loggerFor(g: GlobalOpts): Logger {
  return createLogger({ verbose: g.verbose, quiet: !!g.json });
}

function withProject<T>(cmd: Command, fn: (p: Project, g: GlobalOpts) => T): T {
  const g = globals(cmd);
  const project = openProject({ root: g.root, config: g.config, logger: loggerFor(g) });
  try {
    return fn(project, g);
  } finally {
    project.close();
  }
}

// ---------------------------------------------------------------------------
// Human formatting

function fmtLoc(file: unknown, line: unknown, col?: unknown): string {
  if (!file) return '';
  return `${file}:${line ?? '?'}${col ? `:${col}` : ''}`;
}

function printGraphLine(g: { generation: number; status: string; scannedAt: string | null }): void {
  out(`graph: generation ${g.generation}, status ${g.status}, scanned ${g.scannedAt ?? 'never'}`);
}

function printEdges(res: { results: Record<string, unknown>[]; graph: { generation: number; status: string; scannedAt: string | null }; truncated?: boolean; unresolvedRelatedCount?: number; boundaryWarnings?: Record<string, unknown>[] }): void {
  printGraphLine(res.graph);
  if (!res.results.length) out('(no relationships)');
  for (const r of res.results) {
    const ev = r.evidence as Record<string, unknown> | undefined;
    out(`${'  '.repeat(Math.max(0, (r.depth as number) - 1))}[${r.depth}] ${r.sourceId} --${r.relation}--> ${r.targetId}  (${r.resolution}/${r.confidence})${ev ? `  ${fmtLoc(ev.file, ev.startLine, ev.startCol)} ${ev.expression ?? ''}` : ''}`);
  }
  if (res.unresolvedRelatedCount) out(`unresolved references at the boundary: ${res.unresolvedRelatedCount}`);
  for (const w of res.boundaryWarnings ?? []) out(`  ! ${w.expression} (${w.status}${w.reason ? `: ${w.reason}` : ''}) ${fmtLoc(w.file, w.startLine)}`);
  if (res.truncated) out('(truncated; use --limit/--offset or --cursor)');
}

// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  program
    .name('sails-codegraph')
    .description('Static, local-first code graph for Sails.js applications (CLI + MCP stdio server).')
    .version(PACKAGE_VERSION)
    .option('--root <path>', 'project root (default: SAILS_CODEGRAPH_ROOT or upward discovery from cwd)')
    .option('--config <file>', `config file (default: <root>/${CONFIG_FILE_NAME})`)
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging and stack traces on stderr')
    .option('--no-color', 'disable colored output')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeErr: (s) => process.stderr.write(s), writeOut: (s) => process.stdout.write(s) });

  // init
  program
    .command('init')
    .description(`create ${CONFIG_FILE_NAME} if absent`)
    .option('--force', 'overwrite an existing config file')
    .option('--update-gitignore', 'append .sails-codegraph/ to .gitignore')
    .action(function (this: Command, opts: { force?: boolean; updateGitignore?: boolean }) {
      const g = globals(this);
      const root = discoverProjectRoot(g.root);
      const file = g.config ? path.resolve(g.config) : path.join(root, CONFIG_FILE_NAME);
      const exists = fs.existsSync(file);
      if (exists && !opts.force) throw new UserInputError(`${file} already exists.`, 'Use --force to overwrite it.');
      fs.writeFileSync(file, `${JSON.stringify(defaultConfigObject(), null, 2)}\n`);
      let gitignore = 'not requested';
      const gi = path.join(root, '.gitignore');
      if (opts.updateGitignore) {
        const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
        if (!/^\.sails-codegraph\/?$/m.test(cur)) {
          fs.writeFileSync(gi, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}.sails-codegraph/\n`);
          gitignore = 'updated';
        } else gitignore = 'already present';
      }
      if (g.json) printJson({ configFile: file, overwritten: exists, gitignore });
      else {
        out(`${exists ? 'Overwrote' : 'Created'} ${file}`);
        if (!opts.updateGitignore) out('Recommendation: add `.sails-codegraph/` to .gitignore (or re-run with --update-gitignore).');
      }
    });

  // index
  program
    .command('index')
    .description('full discovery, parsing and resolution as one consistent generation')
    .action(function (this: Command) {
      withProject(this, (p, g) => {
        const r = p.indexer.sync({ full: true });
        report(r, g);
        if (r.status === 'error') process.exitCode = 1;
      });
    });

  // sync
  program
    .command('sync')
    .description('reconcile added, edited, deleted and renamed files since the last scan')
    .option('--check', 'only check freshness; never modify the index (exit 3 if not current)')
    .action(function (this: Command, opts: { check?: boolean }) {
      withProject(this, (p, g) => {
        if (opts.check) {
          const c = p.indexer.check();
          if (g.json) printJson(c);
          else {
            out(c.current ? 'Index is current.' : 'Index is NOT current.');
            for (const r of c.reasons) out(`- ${r}`);
            for (const [label, list] of [['added', c.added], ['changed', c.changed], ['deleted', c.deleted], ['parse errors', c.parseErrors]] as const) {
              if (list.length) out(`${label}: ${list.join(', ')}`);
            }
          }
          if (!c.current) process.exitCode = 3;
          return;
        }
        const r = p.indexer.sync({});
        report(r, g);
      });
    });

  // watch
  program
    .command('watch')
    .description('initial sync, then watch and incrementally update until terminated')
    .action(async function (this: Command) {
      const g = globals(this);
      const logger = createLogger({ verbose: g.verbose });
      const p = openProject({ root: g.root, config: g.config, logger });
      const coord = new SyncCoordinator(p.indexer, p.loaded.config.indexing.mcpScanIntervalMs, logger);
      const first = await coord.sync();
      if (first) logger.info(`initial sync: generation ${first.generation} (${first.status}), ${first.metrics.filesParsed} file(s) parsed`);
      const handle = startWatcher(p.loaded, coord, logger, {
        onSynced: (summary) => {
          if (g.json) out(JSON.stringify({ event: 'synced', summary }));
        },
      });
      logger.info(`watching ${p.root} (Ctrl+C to stop)`);
      await new Promise<void>((resolve) => {
        const stop = () => resolve();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      await handle.close();
      p.close();
    });

  // stats
  program
    .command('stats')
    .description('entity/edge counts, resolution breakdown, scan status and pending diagnostics')
    .action(function (this: Command) {
      withProject(this, (p, g) => {
        const s = p.queries.stats();
        if (g.json) return printJson(s);
        printGraphLine(s.graph);
        out(`root: ${s.meta.projectRoot}  files: ${s.meta.fileCount}  sails: ${s.sailsVersion ?? 'unknown'}`);
        out(`nodes: ${JSON.stringify(s.nodes)}`);
        out(`edges: ${JSON.stringify(s.edges)}`);
        out(`references: ${JSON.stringify(s.references)}`);
        out(`filtered (not persisted): ${JSON.stringify(s.filteredReferences)}`);
        out(`diagnostics: ${JSON.stringify(s.diagnostics)}`);
        out(`coverage: ${Object.entries(s.coverage).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        for (const e of s.pendingErrors as Record<string, unknown>[]) out(`! ${e.file_path}: ${e.code} ${e.message}`);
      });
    });

  // query
  const query = program.command('query').description('query the graph');
  const detailOpt = () => new Option('--detail <level>', 'summary or full').choices(['summary', 'full']);

  query
    .command('symbol <query>')
    .description('lookup by canonical id or fuzzy name')
    .option('--kind <kinds...>', 'restrict to node kinds')
    .option('--limit <n>', 'max results', intOpt('limit'))
    .option('--detail', 'show node detail (attributes, immediate edges)')
    .option('--snippet', 'with --detail: include a bounded source snippet')
    .action(function (this: Command, q: string, opts: { kind?: string[]; limit?: number; detail?: boolean; snippet?: boolean }) {
      withProject(this, (p, g) => {
        if (opts.detail) {
          const r = p.queries.getSymbol(q, { includeSnippet: opts.snippet, limit: opts.limit });
          if (g.json) return printJson(r);
          const s = r.symbol as Record<string, unknown>;
          printGraphLine(r.graph as never);
          out(`${s.id} [${s.kind}] ${fmtLoc(s.file, s.startLine)}`);
          out(`attributes: ${JSON.stringify(s.attributes)}`);
          for (const e of r.outgoing as Record<string, unknown>[]) out(`  --${e.relation}--> ${e.targetId}`);
          for (const e of r.incoming as Record<string, unknown>[]) out(`  <--${e.relation}-- ${e.sourceId}`);
          if (r.snippet) out(String((r.snippet as { text?: string }).text ?? ''));
          return;
        }
        const r = p.queries.findSymbol(q, { kinds: opts.kind, limit: opts.limit });
        if (g.json) return printJson(r);
        printGraphLine(r.graph);
        if (!r.results.length) out('(no matches)');
        if (r.results.length > 1) out(`${r.results.length} matches:`);
        for (const m of r.results) out(`${m.id}  [${m.kind}]  ${fmtLoc(m.file, m.startLine, m.startCol)}`);
      });
    });

  const traversalCmd = (name: 'callers' | 'callees') =>
    query
      .command(`${name} <symbol>`)
      .description(name === 'callers' ? 'incoming call relationships (bounded)' : 'outgoing call relationships (bounded)')
      .option('--depth <n>', 'traversal depth', intOpt('depth'))
      .option('--limit <n>', 'max results', intOpt('limit'))
      .option('--offset <n>', 'skip results', intOpt('offset'))
      .option('--cursor <cursor>', 'pagination cursor')
      .option('--relations <kinds...>', 'edge kinds to follow')
      .option('--include-references', 'also follow REFERENCES edges')
      .option('--include-model-access', 'include model access edges as leaves (callees)')
      .option('--exclude-paths <globs...>', 'hide results in these files')
      .addOption(detailOpt())
      .action(function (this: Command, symbol: string, opts: { depth?: number; limit?: number; offset?: number; cursor?: string; relations?: string[]; includeReferences?: boolean; includeModelAccess?: boolean; excludePaths?: string[]; detail?: Detail }) {
        withProject(this, (p, g) => {
          const o = { ...opts, relations: opts.relations?.map((r) => r.toUpperCase() as EdgeKind) };
          const r = name === 'callers' ? p.queries.callers(symbol, o) : p.queries.callees(symbol, o);
          if (g.json) return printJson(r);
          out(`${name} of ${r.query.symbolId} (depth ${r.query.depth})`);
          printEdges(r);
        });
      });
  traversalCmd('callers');
  traversalCmd('callees');

  query
    .command('route <route...>')
    .description('trace an explicit route (key or concrete request path), e.g. "POST /api/payments/42"')
    .option('--depth <n>', 'downstream depth', intOpt('depth'))
    .option('--limit <n>', 'max downstream results', intOpt('limit'))
    .addOption(detailOpt())
    .action(function (this: Command, route: string[], opts: { depth?: number; limit?: number; detail?: Detail }) {
      withProject(this, (p, g) => {
        const joined = route.join(' ');
        const r = p.queries.traceRoute(undefined, joined, opts);
        if (g.json) return printJson(r);
        printGraphLine(r.graph);
        if (!r.matches.length) out(r.hint ?? 'No route matched.');
        for (const m of r.matches) {
          const rt = m.route as Record<string, unknown>;
          out(`${m.primary ? '*' : ' '} ${rt.id} -> ${rt.targetId ?? JSON.stringify(rt.target)}  ${fmtLoc(rt.file, rt.startLine)}${m.params && Object.keys(m.params).length ? `  params=${JSON.stringify(m.params)}` : ''}`);
          for (const pol of m.policies) out(`    guarded by ${pol.policyId} (order ${pol.order}, rule '${pol.matchedRule}')`);
          const ds = m.downstream as { results: Record<string, unknown>[] } | null;
          for (const e of ds?.results ?? []) out(`    ${'  '.repeat((e.depth as number) - 1)}${e.sourceId} --${e.relation}--> ${e.targetId}`);
        }
        out(r.note);
      });
    });

  query
    .command('routes')
    .description('list explicit routes in declaration order')
    .option('--method <method>', 'filter by HTTP method')
    .option('--prefix <prefix>', 'filter by path prefix')
    .option('--action <action>', 'filter by target action')
    .option('--limit <n>', 'max results', intOpt('limit'))
    .option('--offset <n>', 'skip results', intOpt('offset'))
    .action(function (this: Command, opts: { method?: string; prefix?: string; action?: string; limit?: number; offset?: number }) {
      withProject(this, (p, g) => {
        const r = p.queries.listRoutes({ method: opts.method, pathPrefix: opts.prefix, action: opts.action, limit: opts.limit, offset: opts.offset });
        if (g.json) return printJson(r);
        printGraphLine(r.graph);
        for (const rt of r.routes) out(`${String(rt.order).padStart(3)}  ${rt.method} ${rt.path} -> ${rt.targetId ?? JSON.stringify(rt.target)}${rt.policies ? `  [${(rt.policies as string[]).join(', ')}]` : ''}`);
      });
    });

  query
    .command('impact [symbol]')
    .description('reverse-reachability candidates (not a guarantee of regression)')
    .option('--files <paths...>', 'seed from all nodes owned by these files')
    .option('--git-diff', 'seed from files changed per `git diff --name-only HEAD` plus untracked files')
    .option('--depth <n>', 'traversal depth', intOpt('depth'))
    .option('--limit <n>', 'max results', intOpt('limit'))
    .option('--offset <n>', 'skip results', intOpt('offset'))
    .option('--exclude-paths <globs...>', 'hide results in these files')
    .addOption(detailOpt())
    .action(function (this: Command, symbol: string | undefined, opts: { files?: string[]; gitDiff?: boolean; depth?: number; limit?: number; offset?: number; excludePaths?: string[]; detail?: Detail }) {
      withProject(this, (p, g) => {
        let r: Record<string, unknown>;
        if (opts.files?.length || opts.gitDiff) r = p.queries.analyzeChanges(opts);
        else if (symbol) r = p.queries.impact(symbol, opts);
        else throw new UserInputError('Provide a symbol or --files <paths...>.');
        if (g.json) return printJson(r);
        printGraphLine(r.graph as never);
        out('Entry points:');
        for (const e of r.affectedEntryPoints as Record<string, unknown>[]) out(`  ${e.id} (distance ${e.distance})${e.policies ? ` policies=${JSON.stringify(e.policies)}` : ''}`);
        out('Potentially affected:');
        for (const [kind, list] of Object.entries(r.potentiallyAffected as Record<string, Record<string, unknown>[]>)) {
          out(`  ${kind}:`);
          for (const a of list) out(`    ${a.id} (distance ${a.distance}) via ${(a.reasonPath as { id: string; relation: string }[]).map((s) => `${s.relation}:${s.id}`).join(' <- ')}`);
        }
        for (const w of r.missingCoverageWarnings as string[]) out(`! ${w}`);
        out(String(r.note));
      });
    });

  query
    .command('unresolved')
    .description('unresolved references with evidence')
    .option('--file <path>', 'only references in this file')
    .option('--kind <kind>', 'reference kind (call, model, import, route_target, policy, ...)')
    .option('--reason <reason>', 'reason or status filter')
    .addOption(new Option('--group-by <field>', 'group counts').choices(['reason', 'file', 'key']))
    .option('--limit <n>', 'max results', intOpt('limit'))
    .option('--offset <n>', 'skip results', intOpt('offset'))
    .action(function (this: Command, opts: { file?: string; kind?: string; reason?: string; groupBy?: 'reason' | 'file' | 'key'; limit?: number; offset?: number }) {
      withProject(this, (p, g) => {
        const r = p.queries.unresolved(opts);
        if (g.json) return printJson(r);
        printGraphLine(r.graph);
        out(`unresolved: ${r.counts.unresolved} ${JSON.stringify(r.counts.byStatus)}; filtered: ${JSON.stringify(r.counts.filtered)}`);
        if (r.groups) for (const [k, v] of Object.entries(r.groups)) out(`  ${v}\t${k}`);
        for (const u of r.results) out(`${fmtLoc(u.file, u.startLine, u.startCol)}  ${u.expression}  ${u.status}${u.reason ? ` (${u.reason})` : ''}`);
      });
    });

  query
    .command('file <path>')
    .description('outline of entities/functions in one file')
    .action(function (this: Command, file: string) {
      withProject(this, (p, g) => {
        const r = p.queries.fileOutline(file);
        if (g.json) return printJson(r);
        printGraphLine(r.graph);
        out(`${r.file.path} (${r.file.status})`);
        for (const s of r.symbols) out(`  ${String(s.startLine).padStart(4)}-${String(s.endLine).padEnd(4)} ${String(s.kind).padEnd(8)} ${s.id}  in:${s.incomingCalls} out:${s.outgoingCalls}${s.implements ? `  implements ${(s.implements as string[]).join(', ')}` : ''}`);
        for (const u of r.unresolved as Record<string, unknown>[]) out(`  ! ${u.startLine}:${u.startCol} ${u.expression} ${u.status}${u.reason ? ` (${u.reason})` : ''}`);
      });
    });

  query
    .command('model-usage <model>')
    .description('accessors of a model grouped by operation, plus associations')
    .option('--limit <n>', 'max accessors per group', intOpt('limit'))
    .action(function (this: Command, model: string, opts: { limit?: number }) {
      withProject(this, (p, g) => {
        const r = p.queries.modelUsage(model, opts);
        if (g.json) return printJson(r);
        printGraphLine(r.graph);
        out(`${r.model.id} (${r.model.file})`);
        for (const [k, list] of Object.entries(r.accessors)) {
          if (!list.length) continue;
          out(`  ${k}:`);
          for (const a of list) out(`    ${a.sourceId} ${a.operation}  ${fmtLoc((a.evidence as Record<string, unknown>).file, (a.evidence as Record<string, unknown>).startLine)}`);
        }
        for (const a of r.associations.outgoing) out(`  -> ${a.targetId} (${a.attribute}: ${a.type})`);
        for (const a of r.associations.incoming) out(`  <- ${a.sourceId} (${a.attribute}: ${a.type})`);
      });
    });

  query
    .command('path <from> <to>')
    .description('bounded shortest path(s) between two nodes')
    .option('--max-depth <n>', 'maximum depth', intOpt('max-depth'))
    .option('--limit <n>', 'maximum number of paths', intOpt('limit'))
    .action(function (this: Command, from: string, to: string, opts: { maxDepth?: number; limit?: number }) {
      withProject(this, (p, g) => {
        const r = p.queries.findPaths(from, to, opts);
        if (g.json) return printJson(r);
        printGraphLine(r.graph);
        if (!r.paths.length) out('(no path within bounds)');
        for (const path of r.paths) out(path.map((s, i) => (i === 0 ? s.id : `--${s.relation}--> ${s.id}`)).join(' '));
      });
    });

  // export
  program
    .command('export')
    .description('deterministic JSON graph export')
    .addOption(new Option('--format <format>', 'export format').choices(['json']).default('json'))
    .option('--output <file>', 'write to a file instead of stdout')
    .action(function (this: Command, opts: { format: string; output?: string }) {
      withProject(this, (p, g) => {
        const data = p.queries.exportGraph();
        const text = `${JSON.stringify(data, null, 2)}\n`;
        if (opts.output) {
          fs.writeFileSync(path.resolve(opts.output), text);
          if (g.json) printJson({ output: path.resolve(opts.output), nodes: data.nodes.length, edges: data.edges.length });
          else out(`Wrote ${data.nodes.length} nodes and ${data.edges.length} edges to ${opts.output}`);
        } else process.stdout.write(text);
      });
    });

  // doctor
  program
    .command('doctor')
    .description('validate project detection, config, permissions, DB schema and MCP prerequisites')
    .action(async function (this: Command) {
      const g = globals(this);
      const checks = await doctor(g);
      if (g.json) printJson({ checks, ok: !checks.some((c) => c.status === 'fail') });
      else for (const c of checks) out(`${c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'FAIL'}  ${c.check}: ${c.detail}`);
      if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
    });

  // mcp
  program
    .command('mcp')
    .description('start the MCP stdio server (stdout carries JSON-RPC only)')
    .option('--watch', 'run the embedded file watcher inside the MCP process')
    .action(async function (this: Command, opts: { watch?: boolean }) {
      const g = globals(this);
      const { runMcpServer } = await import('../mcp/server.js');
      await runMcpServer({ root: g.root, config: g.config, watch: opts.watch, verbose: g.verbose });
    });

  return program;
}

function report(r: import('../indexing/indexer.js').SyncResult, g: GlobalOpts): void {
  if (g.json) {
    printJson({ status: r.status, generation: r.generation, metrics: r.metrics, files: r.files, summary: r.summary, warnings: r.warnings });
    return;
  }
  const m = r.metrics;
  out(`${m.mode === 'full' ? 'Indexed' : 'Synced'}: generation ${r.generation}, status ${r.status}`);
  out(`files: ${m.filesEnumerated} enumerated, ${m.filesParsed} parsed, ${m.filesUnchanged} unchanged, ${m.filesDeleted} deleted, ${m.parseErrors} with parse errors`);
  out(`graph changes: +${m.nodesAdded}/-${m.nodesRemoved} nodes (~${m.nodesChanged}), +${m.edgesAdded}/-${m.edgesRemoved} edges; ${m.referencesReresolved} existing reference(s) re-resolved (${m.durationMs} ms)`);
  for (const c of r.summary.referenceStatusChanges.slice(0, 10)) out(`  ${c.file}: ${c.expression} ${c.from} -> ${c.to}${c.reason ? ` (${c.reason})` : ''}`);
  if (r.files.parseErrors.length) out(`! parse errors (graph is not current): ${r.files.parseErrors.join(', ')}`);
  for (const w of r.warnings) out(`! ${w}`);
}

async function doctor(g: GlobalOpts): Promise<{ check: string; status: 'ok' | 'warn' | 'fail'; detail: string }[]> {
  const checks: { check: string; status: 'ok' | 'warn' | 'fail'; detail: string }[] = [];
  const [maj, min] = process.versions.node.split('.').map(Number);
  checks.push({ check: 'node', status: maj > 22 || (maj === 22 && min >= 13) ? 'ok' : 'fail', detail: `Node ${process.versions.node} (requires >= 22.13)` });
  let root: string;
  try {
    root = discoverProjectRoot(g.root);
    checks.push({ check: 'project root', status: isPlausibleSailsRoot(root) ? 'ok' : 'warn', detail: `${root}${isPlausibleSailsRoot(root) ? '' : ' (does not look like a Sails app: expected package.json + api/)'}` });
  } catch (err) {
    checks.push({ check: 'project root', status: 'fail', detail: (err as Error).message });
    return checks;
  }
  const sails = detectSailsVersion(root);
  checks.push({ check: 'sails dependency', status: sails ? 'ok' : 'warn', detail: sails ? `sails ${sails} (Sails 1.x conventions targeted)` : 'sails not found in package.json' });
  const git = describeGit(root);
  checks.push({ check: 'git', status: 'ok', detail: git.kind === 'none' ? 'not a git checkout (fine)' : git.kind === 'linked-worktree' ? 'linked worktree (.git is a file); index is per-worktree' : 'git checkout' });
  let loaded;
  try {
    loaded = loadConfig(root, g.config);
    checks.push({ check: 'config', status: loaded.warnings.length ? 'warn' : 'ok', detail: `${loaded.configPath ?? 'defaults (no config file)'}${loaded.warnings.length ? `; ${loaded.warnings.join(' ')}` : ''}` });
  } catch (err) {
    checks.push({ check: 'config', status: 'fail', detail: (err as Error).message });
    return checks;
  }
  try {
    fs.mkdirSync(loaded.storageDir, { recursive: true });
    fs.accessSync(loaded.storageDir, fs.constants.W_OK);
    checks.push({ check: 'storage', status: 'ok', detail: `${loaded.storageDir} is writable` });
  } catch (err) {
    checks.push({ check: 'storage', status: 'fail', detail: `${loaded.storageDir}: ${(err as Error).message}` });
  }
  try {
    const { openDatabase } = await import('../storage/sqlite.js');
    if (fs.existsSync(loaded.dbPath)) {
      const db = openDatabase(loaded.dbPath, { readonly: true });
      const v = getSchemaVersion(db);
      const gen = (db.prepare("SELECT value FROM index_meta WHERE key = 'generation'").pluck().get() as string | undefined) ?? '0';
      const st = (db.prepare("SELECT value FROM index_meta WHERE key = 'indexStatus'").pluck().get() as string | undefined) ?? '"none"';
      db.close();
      checks.push({ check: 'database', status: v === SCHEMA_VERSION ? 'ok' : 'warn', detail: `schema v${v} (expected v${SCHEMA_VERSION}), generation ${gen}, status ${JSON.parse(st)}` });
    } else {
      const db = openDatabase(':memory:');
      db.close();
      checks.push({ check: 'database', status: 'warn', detail: 'no index yet; run `sails-codegraph index` (SQLite driver loads fine)' });
    }
  } catch (err) {
    checks.push({ check: 'database', status: 'fail', detail: `SQLite unavailable: ${(err as Error).message}` });
  }
  try {
    await import('@modelcontextprotocol/server');
    await import('@modelcontextprotocol/server/stdio');
    checks.push({ check: 'mcp', status: 'ok', detail: '@modelcontextprotocol/server (v2) is available; run `sails-codegraph mcp`' });
  } catch (err) {
    checks.push({ check: 'mcp', status: 'fail', detail: `MCP SDK not loadable: ${(err as Error).message}` });
  }
  const gi = path.join(root, '.gitignore');
  const ignored = fs.existsSync(gi) && /^\/?\.sails-codegraph\/?$/m.test(fs.readFileSync(gi, 'utf8'));
  checks.push({ check: 'gitignore', status: ignored ? 'ok' : 'warn', detail: ignored ? '.sails-codegraph/ is ignored' : 'add .sails-codegraph/ to .gitignore (init --update-gitignore)' });
  return checks;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram();
  verboseFlag = argv.includes('--verbose');
  const jsonFlag = argv.includes('--json');
  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help') return 0;
      return 2;
    }
    const e = err as Error & { exitCode?: number; hint?: string; details?: unknown };
    const exitCode = err instanceof UserInputError ? 2 : err instanceof OperationalError ? 1 : 1;
    process.stderr.write(`sails-codegraph: ${e.message}\n`);
    if (e.hint) process.stderr.write(`hint: ${e.hint}\n`);
    if (verboseFlag && e.stack) process.stderr.write(`${e.stack}\n`);
    if (jsonFlag) printJson({ error: { message: e.message, hint: e.hint ?? null, details: e.details ?? null, exitCode } });
    return exitCode;
  }
}

const isEntry = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry) {
  main().then(
    (code) => {
      // Let the mcp/watch commands keep running; they manage their own lifecycle.
      if (code !== 0) process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`sails-codegraph: ${(err as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
