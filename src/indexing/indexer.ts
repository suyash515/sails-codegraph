import fs from 'node:fs';
import type { LoadedConfig } from '../config/load.js';
import { enumerateFiles, addExtraFile, type Enumeration, type FileStat } from '../discovery/enumerate-files.js';
import { parseFile, categorize, type ParseOptions } from '../parser/parse-file.js';
import type { Diagnostic, IREdge, IRNode, ParsedFile, RawReference, RefSpec, Span } from '../graph/types.js';
import { resolveReference, modelMethodSets, targetOf, type ResolverEnv, type ResolvedEdge } from '../graph/resolver.js';
import { getMeta, migrate, openDatabase, setMeta, type DB } from '../storage/sqlite.js';
import { sha256 } from '../util/hash.js';
import { acquireWriteLock } from './lock.js';
import { routeId, type RouteItem, type RouteValue, type PolicyRule } from '../parser/sails-config.js';
import type { Logger } from '../util/log.js';
import { silentLogger } from '../util/log.js';
import { INDEXER_VERSION } from '../version.js';

export type IndexStatus = 'current' | 'stale' | 'partial' | 'initializing' | 'error';

export interface SyncOptions {
  full?: boolean;
  /** Paths flagged dirty by a watcher; hashed even when size/mtime are unchanged. */
  dirty?: Iterable<string>;
}

export interface SyncMetrics {
  mode: 'full' | 'incremental';
  filesEnumerated: number;
  filesParsed: number;
  filesUnchanged: number;
  filesAdded: number;
  filesChanged: number;
  filesDeleted: number;
  parseErrors: number;
  referencesResolved: number;
  referencesReresolved: number;
  nodesAdded: number;
  nodesRemoved: number;
  nodesChanged: number;
  edgesAdded: number;
  edgesRemoved: number;
  durationMs: number;
  generation: number;
}

export interface ChangeSummary {
  generation: number;
  totals: { nodesAdded: number; nodesRemoved: number; nodesChanged: number; edgesAdded: number; edgesRemoved: number; referenceStatusChanges: number };
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesChanged: string[];
  edgesAdded: [string, string, string][];
  edgesRemoved: [string, string, string][];
  referenceStatusChanges: { referenceId: string; file: string; expression: string; from: string; to: string; reason: string | null }[];
  truncated: boolean;
}

export interface SyncResult {
  status: IndexStatus;
  generation: number;
  committed: boolean;
  metrics: SyncMetrics;
  summary: ChangeSummary;
  files: { added: string[]; changed: string[]; deleted: string[]; parseErrors: string[] };
  warnings: string[];
}

export interface CheckResult {
  current: boolean;
  status: IndexStatus | 'missing';
  added: string[];
  changed: string[];
  deleted: string[];
  parseErrors: string[];
  reasons: string[];
}

const SUMMARY_CAP = 50;
const PARSE_RETRIES = 3;

export function parseOptionsFor(loaded: LoadedConfig): ParseOptions {
  const r = loaded.config.resolution;
  return {
    externalGlobals: r.externalGlobals,
    includeModelAssociations: r.includeModelAssociations,
    followRouteFileRequires: r.followRouteFileRequires,
    honorGlobalsConfig: r.honorGlobalsConfig,
  };
}

interface ManifestRow {
  path: string;
  content_hash: string;
  size_bytes: number;
  mtime_ms: number;
  status: string;
  pending_hash: string | null;
}

interface ParseOutcome {
  path: string;
  stat: FileStat;
  parsed: ParsedFile | null; // null => failed to read/parse reliably
  hash: string;
  error?: Diagnostic;
}

export class GraphIndexer {
  readonly db: DB;
  private logger: Logger;

  constructor(readonly loaded: LoadedConfig, opts: { logger?: Logger; db?: DB } = {}) {
    this.logger = opts.logger ?? silentLogger;
    this.db = opts.db ?? openDatabase(loaded.dbPath, { create: true });
    migrate(this.db);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  /** True if no successful index exists or the config / indexer version changed. */
  needsFullIndex(): boolean {
    const gen = getMeta<number>(this.db, 'generation') ?? 0;
    if (gen === 0) return true;
    if (getMeta<string>(this.db, 'configHash') !== this.loaded.hash) return true;
    if (getMeta<string>(this.db, 'indexerVersion') !== INDEXER_VERSION) return true;
    if (getMeta<string>(this.db, 'projectRoot') !== this.loaded.root) return true;
    if (getMeta<string>(this.db, 'lastScanComplete') === 'false') return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Enumeration + change detection

  private manifest(): Map<string, ManifestRow> {
    const rows = this.db.prepare('SELECT path, content_hash, size_bytes, mtime_ms, status, pending_hash FROM files').all() as ManifestRow[];
    return new Map(rows.map((r) => [r.path, r]));
  }

  private persistedRouteDeps(): Map<string, string[]> {
    const rows = this.db.prepare("SELECT dependent_file, dependency_file FROM file_dependencies WHERE kind = 'route_include' ORDER BY dependent_file, dependency_file").all() as { dependent_file: string; dependency_file: string }[];
    const m = new Map<string, string[]>();
    for (const r of rows) {
      if (!m.has(r.dependent_file)) m.set(r.dependent_file, []);
      m.get(r.dependent_file)!.push(r.dependency_file);
    }
    return m;
  }

  /** Add route include files (transitively) to an enumeration, given known dependency lists. */
  private addRouteDeps(en: Enumeration, deps: Map<string, string[]>): string[] {
    const added: string[] = [];
    for (const [dependent, list] of deps) {
      if (!en.files.has(dependent)) continue;
      for (const dep of list) {
        if (!dep.endsWith('.js')) continue;
        if (addExtraFile(this.loaded.root, this.loaded.config, dep, en)) added.push(dep);
      }
    }
    return added;
  }

  private readAndParse(stat: FileStat): ParseOutcome {
    const opts = parseOptionsFor(this.loaded);
    for (let attempt = 0; attempt < PARSE_RETRIES; attempt++) {
      let buf: Buffer;
      let before: fs.Stats;
      try {
        before = fs.statSync(stat.abs);
        if (before.size > this.loaded.config.indexing.maxFileBytes) {
          return { path: stat.path, stat, parsed: null, hash: '', error: { code: 'FILE_TOO_LARGE', severity: 'warning', message: `${stat.path} exceeds maxFileBytes`, filePath: stat.path } };
        }
        buf = fs.readFileSync(stat.abs);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { path: stat.path, stat, parsed: null, hash: '', error: { code: 'FILE_VANISHED', severity: 'warning', message: `${stat.path} was deleted while being read`, filePath: stat.path } };
        return { path: stat.path, stat, parsed: null, hash: '', error: { code: 'FILE_READ_ERROR', severity: 'error', message: `Cannot read ${stat.path}: ${(err as Error).message}`, filePath: stat.path } };
      }
      const hash = sha256(buf);
      const content = buf.toString('utf8');
      let parsed: ParsedFile;
      try {
        parsed = parseFile(stat.path, content, opts);
      } catch (err) {
        return { path: stat.path, stat, parsed: null, hash, error: { code: 'PARSE_ERROR', severity: 'error', message: `Internal parser failure for ${stat.path}: ${(err as Error).message}`, filePath: stat.path } };
      }
      parsed.sha256 = hash;
      let after: fs.Stats | null = null;
      try {
        after = fs.statSync(stat.abs);
      } catch {
        after = null;
      }
      if (after && after.size === before.size && after.mtimeMs === before.mtimeMs) {
        return { path: stat.path, stat: { ...stat, size: after.size, mtimeMs: after.mtimeMs }, parsed, hash };
      }
      if (!after) return { path: stat.path, stat, parsed: null, hash: '', error: { code: 'FILE_VANISHED', severity: 'warning', message: `${stat.path} was deleted while being parsed`, filePath: stat.path } };
    }
    return { path: stat.path, stat, parsed: null, hash: '', error: { code: 'FILE_CHANGED_DURING_SCAN', severity: 'warning', message: `${stat.path} kept changing while being parsed; it will be retried on the next sync.`, filePath: stat.path } };
  }

  /** Read-only freshness check (`sync --check`). Never mutates the database. */
  check(): CheckResult {
    const reasons: string[] = [];
    const gen = getMeta<number>(this.db, 'generation') ?? 0;
    if (gen === 0) return { current: false, status: 'missing', added: [], changed: [], deleted: [], parseErrors: [], reasons: ['No index exists yet; run `sails-codegraph index`.'] };
    const status = (getMeta<IndexStatus>(this.db, 'indexStatus') ?? 'error') as IndexStatus;
    if (getMeta<string>(this.db, 'configHash') !== this.loaded.hash) reasons.push('Configuration changed since the last index.');
    if (getMeta<string>(this.db, 'indexerVersion') !== INDEXER_VERSION) reasons.push('Indexer version changed since the last index.');
    const en = enumerateFiles(this.loaded.root, this.loaded.config);
    this.addRouteDeps(en, this.persistedRouteDeps());
    const prev = this.manifest();
    const added: string[] = [];
    const changed: string[] = [];
    const deleted: string[] = [];
    const parseErrors: string[] = [];
    for (const [p, st] of en.files) {
      const row = prev.get(p);
      if (!row) {
        added.push(p);
        continue;
      }
      if (row.status !== 'ok') parseErrors.push(p);
      if (row.size_bytes !== st.size || row.mtime_ms !== st.mtimeMs) {
        try {
          const h = sha256(fs.readFileSync(st.abs));
          if (h !== row.content_hash && h !== row.pending_hash) changed.push(p);
        } catch {
          changed.push(p);
        }
      }
    }
    for (const p of prev.keys()) if (!en.files.has(p)) deleted.push(p);
    if (status !== 'current') reasons.push(`Index status is ${status}.`);
    if (added.length || changed.length || deleted.length) reasons.push('Source files changed since the last scan.');
    if (parseErrors.length) reasons.push('Some files have parse errors.');
    return { current: reasons.length === 0, status, added, changed, deleted, parseErrors, reasons };
  }

  // -------------------------------------------------------------------------

  sync(opts: SyncOptions = {}): SyncResult {
    const lock = acquireWriteLock(this.loaded.storageDir);
    try {
      return this.syncLocked(opts);
    } finally {
      lock.release();
    }
  }

  private syncLocked(opts: SyncOptions): SyncResult {
    const t0 = Date.now();
    const full = !!opts.full || this.needsFullIndex();
    const dirty = new Set(opts.dirty ?? []);
    const warnings: string[] = [...this.loaded.warnings];
    const prev = full ? new Map<string, ManifestRow>() : this.manifest();
    const prevAll = this.manifest();

    const en = enumerateFiles(this.loaded.root, this.loaded.config);
    const outcomes = new Map<string, ParseOutcome>();
    const mtimeOnly: FileStat[] = [];
    const brokenUnchanged = new Set<string>();

    const examine = (paths: string[]) => {
      for (const p of paths) {
        const st = en.files.get(p)!;
        const row = prev.get(p);
        if (!row) {
          outcomes.set(p, this.readAndParse(st));
          continue;
        }
        const statChanged = row.size_bytes !== st.size || row.mtime_ms !== st.mtimeMs;
        if (!statChanged && !dirty.has(p)) {
          if (row.status !== 'ok') brokenUnchanged.add(p);
          continue;
        }
        let h: string;
        try {
          h = sha256(fs.readFileSync(st.abs));
        } catch {
          outcomes.set(p, this.readAndParse(st));
          continue;
        }
        if (h === row.content_hash && row.status === 'ok') {
          if (statChanged) mtimeOnly.push(st);
          continue;
        }
        if (row.status !== 'ok' && h === row.pending_hash) {
          brokenUnchanged.add(p);
          if (statChanged) mtimeOnly.push(st);
          continue;
        }
        outcomes.set(p, this.readAndParse(st));
      }
    };
    examine([...en.files.keys()]);

    // Route include closure: persisted deps of unchanged files + deps of freshly parsed files.
    const depMap = full ? new Map<string, string[]>() : this.persistedRouteDeps();
    for (let round = 0; round < 10; round++) {
      for (const o of outcomes.values()) {
        if (o.parsed) depMap.set(o.path, o.parsed.dependencies.filter((d) => d.kind === 'route_include').map((d) => d.dependencyFile));
        else if (!full && prevAll.has(o.path)) {
          /* keep persisted deps of a broken file */
        }
      }
      const added = this.addRouteDeps(en, depMap).filter((p) => !outcomes.has(p));
      if (!added.length) break;
      examine(added);
    }

    const deleted = [...prevAll.keys()].filter((p) => !en.files.has(p)).sort();
    const parsedOk: ParsedFile[] = [];
    const broken: ParseOutcome[] = [];
    for (const p of [...outcomes.keys()].sort()) {
      const o = outcomes.get(p)!;
      if (o.parsed && o.parsed.parseOk) parsedOk.push(o.parsed);
      else if (o.error?.code === 'FILE_VANISHED') deleted.push(p);
      else broken.push(o);
    }
    const addedPaths = parsedOk.filter((f) => !prevAll.has(f.path)).map((f) => f.path);
    const changedPaths = parsedOk.filter((f) => prevAll.has(f.path)).map((f) => f.path);

    const result = this.commit({ full, parsedOk, broken, deleted: [...new Set(deleted)].sort(), mtimeOnly, outcomes, en, brokenUnchanged, t0, warnings });
    result.files = { added: addedPaths, changed: changedPaths, deleted: [...new Set(deleted)].sort(), parseErrors: broken.map((b) => b.path).concat([...brokenUnchanged]).sort() };
    result.metrics.filesAdded = addedPaths.length;
    result.metrics.filesChanged = changedPaths.length;
    return result;
  }

  // -------------------------------------------------------------------------
  // Transactional commit

  private commit(args: {
    full: boolean;
    parsedOk: ParsedFile[];
    broken: ParseOutcome[];
    deleted: string[];
    mtimeOnly: FileStat[];
    outcomes: Map<string, ParseOutcome>;
    en: Enumeration;
    brokenUnchanged: Set<string>;
    t0: number;
    warnings: string[];
  }): SyncResult {
    const { full, parsedOk, broken, deleted, mtimeOnly, en } = args;
    const db = this.db;
    const cfg = this.loaded.config;
    const { reads, writes } = modelMethodSets(cfg.resolution.extraModelReadMethods, cfg.resolution.extraModelWriteMethods);
    const now = Date.now();

    const tracker = new ChangeTracker();
    let referencesResolved = 0;
    let referencesReresolved = 0;

    const stmts = {
      registryByOwner: db.prepare('SELECT lookup_key FROM registry_keys WHERE owner_file = ?').pluck(),
      nodesByOwner: db.prepare('SELECT id, kind, name, file_path, start_line, start_col, end_line, end_col, attributes_json FROM nodes WHERE owner = ?'),
      refsByOwner: db.prepare('SELECT id, resolution_status FROM raw_references WHERE owner = ?'),
      edgesByOrigin: db.prepare('SELECT source_id, kind, target_id FROM edges WHERE origin_reference_id = ?'),
      edgesByOwner: db.prepare('SELECT source_id, kind, target_id FROM edges WHERE owner = ?'),
      delEdgesByOrigin: db.prepare('DELETE FROM edges WHERE origin_reference_id = ?'),
      delEdgesByOwner: db.prepare('DELETE FROM edges WHERE owner = ?'),
      edgesByTarget: db.prepare('SELECT id, source_id, kind, target_id FROM edges WHERE target_id = ? OR source_id = ?'),
      delEdge: db.prepare('DELETE FROM edges WHERE id = ?'),
      delRefKeys: db.prepare('DELETE FROM reference_keys WHERE reference_id = ?'),
      delRefsByOwner: db.prepare('DELETE FROM raw_references WHERE owner = ?'),
      delNodesByOwner: db.prepare('DELETE FROM nodes WHERE owner = ?'),
      delRegistryByOwner: db.prepare('DELETE FROM registry_keys WHERE owner_file = ?'),
      delDiagByOwner: db.prepare('DELETE FROM diagnostics WHERE owner = ?'),
      delRecords: db.prepare('DELETE FROM file_records WHERE file_path = ?'),
      delDeps: db.prepare('DELETE FROM file_dependencies WHERE dependent_file = ?'),
      delFile: db.prepare('DELETE FROM files WHERE path = ?'),
      nodeOwner: db.prepare('SELECT owner FROM nodes WHERE id = ?').pluck(),
      insNode: db.prepare('INSERT INTO nodes(id, kind, name, file_path, start_line, start_col, end_line, end_col, attributes_json, owner) VALUES (?,?,?,?,?,?,?,?,?,?)'),
      insEdge: db.prepare(
        'INSERT OR REPLACE INTO edges(id, source_id, target_id, kind, origin_reference_id, resolution, confidence, attributes_json, owner, evidence_file, start_line, start_col, end_line, end_col, expression) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ),
      insRef: db.prepare(
        'INSERT OR REPLACE INTO raw_references(id, source_file, source_node_id, ref_kind, expression, lookup_key, lookup_context_json, start_line, start_col, end_line, end_col, resolution_status, unresolved_reason, target_id, owner) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ),
      getRef: db.prepare('SELECT * FROM raw_references WHERE id = ?'),
      updRef: db.prepare('UPDATE raw_references SET resolution_status = ?, unresolved_reason = ?, lookup_key = ?, target_id = ? WHERE id = ?'),
      insRefKey: db.prepare('INSERT OR IGNORE INTO reference_keys(reference_id, lookup_key) VALUES (?, ?)'),
      insRegistry: db.prepare('INSERT OR IGNORE INTO registry_keys(lookup_key, node_id, owner_file) VALUES (?,?,?)'),
      insDiag: db.prepare('INSERT OR REPLACE INTO diagnostics(id, file_path, severity, code, message, start_line, start_col, owner) VALUES (?,?,?,?,?,?,?,?)'),
      insRecord: db.prepare('INSERT OR REPLACE INTO file_records(file_path, kind, data_json) VALUES (?,?,?)'),
      insDep: db.prepare('INSERT OR IGNORE INTO file_dependencies(dependent_file, dependency_file, kind) VALUES (?,?,?)'),
      upsertFile: db.prepare(
        'INSERT OR REPLACE INTO files(path, content_hash, size_bytes, mtime_ms, parsed_at_ms, status, generation, pending_hash, counts_json) VALUES (?,?,?,?,?,?,?,?,?)',
      ),
      updFileMtime: db.prepare('UPDATE files SET mtime_ms = ?, size_bytes = ? WHERE path = ?'),
      markFileBroken: db.prepare('UPDATE files SET status = ?, pending_hash = ?, size_bytes = ?, mtime_ms = ? WHERE path = ?'),
      lookup: db.prepare('SELECT node_id FROM registry_keys WHERE lookup_key = ? ORDER BY node_id').pluck(),
      nodeAttrs: db.prepare('SELECT attributes_json FROM nodes WHERE id = ?').pluck(),
      nodeKind: db.prepare('SELECT kind FROM nodes WHERE id = ?').pluck(),
      record: db.prepare('SELECT data_json FROM file_records WHERE file_path = ? AND kind = ?').pluck(),
      serviceOf: db.prepare("SELECT id FROM nodes WHERE file_path = ? AND kind = 'SERVICE' ORDER BY id LIMIT 1").pluck(),
      refsForKey: db.prepare('SELECT reference_id FROM reference_keys WHERE lookup_key = ?').pluck(),
    };

    const env: ResolverEnv = {
      lookup: (key) => stmts.lookup.all(key) as string[],
      nodeAttributes: (id) => {
        const j = stmts.nodeAttrs.get(id) as string | undefined;
        return j ? JSON.parse(j) : null;
      },
      nodeKind: (id) => (stmts.nodeKind.get(id) as string | undefined) ?? null,
      fileRecord: (p, kind) => {
        const j = stmts.record.get(p, kind) as string | undefined;
        return j ? JSON.parse(j) : null;
      },
      serviceOfModule: (p) => (stmts.serviceOf.get(p) as string | undefined) ?? null,
      ensureSyntheticNode: (id, kind, name, attributes) => {
        if (stmts.nodeOwner.get(id) !== undefined) return;
        stmts.insNode.run(id, kind, name, null, null, null, null, null, JSON.stringify(attributes), '#pkg');
        tracker.nodeAdded(id, `${kind}|${name}`);
      },
      modelReads: reads,
      modelWrites: writes,
    };

    const nodeSig = (r: { kind: string; name: string; file_path: string | null; start_line: number | null; start_col: number | null; end_line: number | null; end_col: number | null; attributes_json: string }) =>
      `${r.kind}|${r.name}|${r.file_path}|${r.start_line}:${r.start_col}-${r.end_line}:${r.end_col}|${r.attributes_json}`;

    const removeEdges = (rows: { source_id: string; kind: string; target_id: string }[]) => {
      for (const e of rows) tracker.edgeRemoved(e.source_id, e.kind, e.target_id);
    };

    const removeOwner = (owner: string, affectedKeys: Set<string>) => {
      for (const k of stmts.registryByOwner.all(owner) as string[]) affectedKeys.add(k);
      const nodes = stmts.nodesByOwner.all(owner) as Parameters<typeof nodeSig>[0][] & { id: string }[];
      for (const n of nodes as (Parameters<typeof nodeSig>[0] & { id: string })[]) tracker.nodeRemoved(n.id, nodeSig(n));
      for (const r of stmts.refsByOwner.all(owner) as { id: string; resolution_status: string }[]) {
        removeEdges(stmts.edgesByOrigin.all(r.id) as never);
        stmts.delEdgesByOrigin.run(r.id);
        stmts.delRefKeys.run(r.id);
        tracker.refRemoved(r.id, r.resolution_status);
      }
      const structuralOwner = `file:${owner}`;
      removeEdges(stmts.edgesByOwner.all(structuralOwner) as never);
      stmts.delEdgesByOwner.run(structuralOwner);
      for (const n of nodes as { id: string }[]) {
        for (const e of stmts.edgesByTarget.all(n.id, n.id) as { id: string; source_id: string; kind: string; target_id: string }[]) {
          tracker.edgeRemoved(e.source_id, e.kind, e.target_id);
          stmts.delEdge.run(e.id);
        }
      }
      stmts.delRefsByOwner.run(owner);
      stmts.delNodesByOwner.run(owner);
      stmts.delRegistryByOwner.run(owner);
      stmts.delDiagByOwner.run(owner);
      stmts.delDiagByOwner.run(`#parse:${owner}`);
    };

    const insertDiag = (owner: string, d: Diagnostic, n: number) => {
      const id = `${owner}|${d.code}|${d.span?.startLine ?? 0}:${d.span?.startCol ?? 0}|${n}`;
      stmts.insDiag.run(id, d.filePath, d.severity, d.code, d.message, d.span?.startLine ?? null, d.span?.startCol ?? null, owner);
    };

    const insertEdge = (owner: string, e: { source: string; target: string; kind: string; resolution: string; confidence: string; attributes: Record<string, unknown> }, origin: string | null, ev: { file: string; span: Span; expression?: string } | null, idHint?: string) => {
      const id = idHint ?? (origin ? `${origin}>${e.kind}>${e.target}` : `${owner}>${e.source}>${e.kind}>${e.target}`);
      stmts.insEdge.run(
        id, e.source, e.target, e.kind, origin, e.resolution, e.confidence, JSON.stringify(e.attributes), owner,
        ev?.file ?? null, ev?.span.startLine ?? null, ev?.span.startCol ?? null, ev?.span.endLine ?? null, ev?.span.endCol ?? null, ev?.expression ?? null,
      );
      tracker.edgeAdded(e.source, e.kind, e.target);
    };

    const insertNode = (n: IRNode, owner: string) => {
      const attrs = JSON.stringify(n.attributes);
      stmts.insNode.run(n.id, n.kind, n.name, n.filePath, n.span?.startLine ?? null, n.span?.startCol ?? null, n.span?.endLine ?? null, n.span?.endCol ?? null, attrs, owner);
      tracker.nodeAdded(n.id, `${n.kind}|${n.name}|${n.filePath}|${n.span?.startLine ?? null}:${n.span?.startCol ?? null}-${n.span?.endLine ?? null}:${n.span?.endCol ?? null}|${attrs}`);
    };

    const insertRef = (r: RawReference, sourceFile: string, owner: string) => {
      stmts.insRef.run(r.id, sourceFile, r.sourceNodeId, r.refKind, r.expression, null, JSON.stringify(r.spec), r.span.startLine, r.span.startCol, r.span.endLine, r.span.endCol, 'pending', null, null, owner);
    };

    /** (Re)resolve one reference: drop its derived edges, evaluate, store edges, keys and status. */
    const resolveRef = (refId: string): void => {
      const row = stmts.getRef.get(refId) as
        | { id: string; source_file: string; source_node_id: string; expression: string; lookup_context_json: string; start_line: number; start_col: number; end_line: number; end_col: number; resolution_status: string; owner: string }
        | undefined;
      if (!row) return;
      removeEdges(stmts.edgesByOrigin.all(refId) as never);
      stmts.delEdgesByOrigin.run(refId);
      stmts.delRefKeys.run(refId);
      const spec = JSON.parse(row.lookup_context_json) as RefSpec;
      const r = resolveReference(spec, env);
      const span: Span = { startLine: row.start_line, startCol: row.start_col, endLine: row.end_line, endCol: row.end_col, startOffset: 0, endOffset: 0 };
      for (const e of r.edges as ResolvedEdge[]) {
        insertEdge('ref', { source: row.source_node_id, ...e }, refId, { file: row.source_file, span, expression: row.expression });
      }
      for (const k of r.keys) stmts.insRefKey.run(refId, k);
      stmts.updRef.run(r.status, r.reason, r.primaryKey, targetOf(r), refId);
      tracker.refStatus(refId, row.resolution_status, r.status, r.reason, row.source_file, row.expression);
    };

    const txn = db.transaction(() => {
      const prevGen = getMeta<number>(db, 'generation') ?? 0;
      const generation = prevGen + 1;
      const affectedKeys = new Set<string>();
      const routeFilesBefore = new Set((db.prepare("SELECT file_path FROM file_records WHERE kind = 'route_fragment'").pluck().all() as string[]));
      let policiesDirty = full;
      let routesDirty = full;

      if (full) {
        // Snapshot for the change summary, then clear everything except metadata.
        for (const n of db.prepare('SELECT id, kind, name, file_path, start_line, start_col, end_line, end_col, attributes_json FROM nodes').all() as (Parameters<typeof nodeSig>[0] & { id: string })[]) tracker.nodeRemoved(n.id, nodeSig(n));
        for (const e of db.prepare('SELECT source_id, kind, target_id FROM edges').all() as { source_id: string; kind: string; target_id: string }[]) tracker.edgeRemoved(e.source_id, e.kind, e.target_id);
        for (const r of db.prepare('SELECT id, resolution_status FROM raw_references').all() as { id: string; resolution_status: string }[]) tracker.refRemoved(r.id, r.resolution_status);
        for (const t of ['files', 'nodes', 'raw_references', 'edges', 'diagnostics', 'reference_keys', 'registry_keys', 'file_dependencies', 'file_records', 'derived_attributes']) db.exec(`DELETE FROM ${t}`);
      }

      // 1. Remove records owned by deleted and successfully re-parsed files.
      const replaced = new Set<string>([...deleted, ...parsedOk.map((f) => f.path)]);
      for (const p of [...replaced].sort()) {
        if (!full) removeOwner(p, affectedKeys);
        stmts.delRecords.run(p);
        stmts.delDeps.run(p);
        if (deleted.includes(p)) stmts.delFile.run(p);
        if (p === 'config/policies.js') policiesDirty = true;
        if (routeFilesBefore.has(p) || p === 'config/routes.js') routesDirty = true;
      }

      // 2. Insert new file-owned IR (pass 1: registration).
      const newRefIds: string[] = [];
      for (const f of parsedOk) {
        const idMap = disambiguateIds(f, (id) => stmts.nodeOwner.get(id) as string | undefined);
        for (const n of f.nodes) insertNode(n, f.path);
        for (const e of f.edges) insertEdge(`file:${f.path}`, e, null, null);
        for (const r of f.registry) {
          stmts.insRegistry.run(r.key, r.nodeId, f.path);
          affectedKeys.add(r.key);
        }
        for (const r of f.references) {
          insertRef(r, f.path, f.path);
          newRefIds.push(r.id);
          tracker.refAdded(r.id);
        }
        f.diagnostics.forEach((d, i) => insertDiag(f.path, d, i));
        if (idMap.size) {
          for (const [from, to] of idMap) insertDiag(f.path, { code: 'NODE_ID_CONFLICT', severity: 'error', message: `Entity ${from} is also defined by another file; this one is stored as ${to}.`, filePath: f.path }, 1000);
        }
        for (const rec of f.records) stmts.insRecord.run(f.path, rec.kind, JSON.stringify(rec.data));
        for (const d of f.dependencies) stmts.insDep.run(f.path, d.dependencyFile, d.kind);
        const o = args.outcomes.get(f.path)!;
        stmts.upsertFile.run(f.path, f.sha256, o.stat.size, o.stat.mtimeMs, now, 'ok', generation, null, JSON.stringify(f.counts));
        if (f.path === 'config/policies.js') policiesDirty = true;
        if (f.records.some((r) => r.kind === 'route_fragment')) routesDirty = true;
      }

      // 3. Broken files: keep the last good representation, annotate as stale.
      for (const b of broken) {
        const owner = `#parse:${b.path}`;
        stmts.delDiagByOwner.run(owner);
        const diags = b.parsed?.diagnostics.filter((d) => d.code === 'PARSE_ERROR') ?? [];
        if (b.error) diags.push(b.error);
        diags.forEach((d, i) => insertDiag(owner, { ...d, filePath: b.path }, i));
        const existed = stmts.markFileBroken.run(b.error?.code === 'FILE_CHANGED_DURING_SCAN' ? 'stale' : 'parse_error', b.hash || null, b.stat.size, b.stat.mtimeMs, b.path).changes > 0;
        if (!existed) {
          // New file that never parsed: register a FILE node so it is visible, but nothing else.
          stmts.upsertFile.run(b.path, '', b.stat.size, b.stat.mtimeMs, now, b.error?.code === 'FILE_CHANGED_DURING_SCAN' ? 'stale' : 'parse_error', 0, b.hash || null, '{}');
        }
      }
      for (const st of mtimeOnly) stmts.updFileMtime.run(st.mtimeMs, st.size, st.path);

      // 4. Pass 2: resolve new references + existing references touching affected keys.
      const toResolve = new Set<string>(newRefIds);
      const reresolve = new Set<string>();
      for (const k of affectedKeys) {
        for (const id of stmts.refsForKey.all(k) as string[]) if (!toResolve.has(id)) reresolve.add(id);
      }
      for (const id of [...toResolve].sort()) resolveRef(id);
      for (const id of [...reresolve].sort()) resolveRef(id);
      referencesResolved = toResolve.size;
      referencesReresolved = reresolve.size;

      // 5. Derived passes.
      if (!policiesDirty) for (const k of affectedKeys) if (k.startsWith('action:') || k.startsWith('policy:')) policiesDirty = true;
      if (routesDirty) referencesResolved += this.rebuildRoutes(db, tracker, insertEdge, insertNode, insertRef, insertDiag, resolveRef, removeEdges);
      if (policiesDirty) this.rebuildPolicies(db, tracker, insertEdge, insertDiag, removeEdges);
      this.recomputeDerivedDiagnostics(db, insertDiag);
      // Scan-level diagnostics (skipped files)
      stmts.delDiagByOwner.run('#scan');
      en.skipped.forEach((s, i) => insertDiag('#scan', { code: s.code, severity: 'warning', message: s.message, filePath: s.path }, i));
      // Garbage-collect synthetic package/json nodes no longer referenced.
      for (const id of db.prepare("SELECT id FROM nodes WHERE owner = '#pkg' AND NOT EXISTS (SELECT 1 FROM edges WHERE target_id = nodes.id)").pluck().all() as string[]) {
        db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
        tracker.nodeRemoved(id, 'synthetic');
      }

      // 6. Metadata
      const brokenCount = (db.prepare("SELECT count(*) FROM files WHERE status != 'ok'").pluck().get() as number) ?? 0;
      const status: IndexStatus = brokenCount > 0 ? 'stale' : 'current';
      const fileCount = db.prepare('SELECT count(*) FROM files').pluck().get() as number;
      const summary = tracker.summary(generation);
      // A sync that changed nothing does not create a new generation (keeps cursors valid).
      const prevStatus = getMeta<string>(db, 'indexStatus');
      const changed =
        full || parsedOk.length > 0 || deleted.length > 0 || broken.length > 0 || prevStatus !== status || Object.values(summary.totals).some((n) => n > 0);
      const committedGeneration = changed ? generation : prevGen;
      summary.generation = committedGeneration;
      setMeta(db, 'generation', committedGeneration);
      setMeta(db, 'indexerVersion', INDEXER_VERSION);
      setMeta(db, 'projectRoot', this.loaded.root);
      setMeta(db, 'configHash', this.loaded.hash);
      setMeta(db, 'indexStatus', status);
      setMeta(db, 'lastScanComplete', 'true');
      setMeta(db, 'lastSuccessfulScanAt', new Date().toISOString());
      setMeta(db, 'fileCount', fileCount);
      setMeta(db, 'lastSyncSummary', summary);
      if (changed) setMeta(db, 'lastChangeSummary', summary);
      return { generation: committedGeneration, status, summary };
    });

    let out: { generation: number; status: IndexStatus; summary: ChangeSummary };
    try {
      out = txn.immediate();
    } catch (err) {
      this.logger.error(`Index transaction rolled back: ${(err as Error).message}`);
      try {
        setMeta(db, 'indexStatus', 'error');
        setMeta(db, 'lastError', (err as Error).message);
      } catch {
        /* ignore */
      }
      throw err;
    }
    const s = out.summary;
    const metrics: SyncMetrics = {
      mode: full ? 'full' : 'incremental',
      filesEnumerated: en.files.size,
      filesParsed: args.outcomes.size,
      filesUnchanged: en.files.size - args.outcomes.size,
      filesAdded: 0,
      filesChanged: 0,
      filesDeleted: deleted.length,
      parseErrors: broken.length + args.brokenUnchanged.size,
      referencesResolved,
      referencesReresolved,
      nodesAdded: s.totals.nodesAdded,
      nodesRemoved: s.totals.nodesRemoved,
      nodesChanged: s.totals.nodesChanged,
      edgesAdded: s.totals.edgesAdded,
      edgesRemoved: s.totals.edgesRemoved,
      durationMs: Date.now() - args.t0,
      generation: out.generation,
    };
    return { status: out.status, generation: out.generation, committed: true, metrics, summary: s, files: { added: [], changed: [], deleted: [], parseErrors: [] }, warnings: args.warnings };
  }

  // -------------------------------------------------------------------------
  // Derived: routes

  private rebuildRoutes(
    db: DB,
    tracker: ChangeTracker,
    insertEdge: (owner: string, e: { source: string; target: string; kind: string; resolution: string; confidence: string; attributes: Record<string, unknown> }, origin: string | null, ev: { file: string; span: Span; expression?: string } | null, idHint?: string) => void,
    insertNode: (n: IRNode, owner: string) => void,
    insertRef: (r: RawReference, sourceFile: string, owner: string) => void,
    insertDiag: (owner: string, d: Diagnostic, n: number) => void,
    resolveRef: (id: string) => void,
    removeEdges: (rows: { source_id: string; kind: string; target_id: string }[]) => void,
  ): number {
    const owner = '#routes';
    // Remove previous derived route data.
    for (const n of db.prepare('SELECT id, kind, name, file_path, start_line, start_col, end_line, end_col, attributes_json FROM nodes WHERE owner = ?').all(owner) as { id: string; kind: string; name: string; file_path: string; start_line: number; start_col: number; end_line: number; end_col: number; attributes_json: string }[]) {
      tracker.nodeRemoved(n.id, `${n.kind}|${n.name}|${n.file_path}|${n.start_line}:${n.start_col}-${n.end_line}:${n.end_col}|${n.attributes_json}`);
    }
    for (const r of db.prepare('SELECT id, resolution_status FROM raw_references WHERE owner = ?').all(owner) as { id: string; resolution_status: string }[]) {
      removeEdges(db.prepare('SELECT source_id, kind, target_id FROM edges WHERE origin_reference_id = ?').all(r.id) as never);
      db.prepare('DELETE FROM edges WHERE origin_reference_id = ?').run(r.id);
      db.prepare('DELETE FROM reference_keys WHERE reference_id = ?').run(r.id);
      tracker.refRemoved(r.id, r.resolution_status);
    }
    removeEdges(db.prepare('SELECT source_id, kind, target_id FROM edges WHERE owner = ?').all(owner) as never);
    db.prepare('DELETE FROM edges WHERE owner = ?').run(owner);
    db.prepare('DELETE FROM raw_references WHERE owner = ?').run(owner);
    db.prepare('DELETE FROM nodes WHERE owner = ?').run(owner);
    db.prepare('DELETE FROM registry_keys WHERE owner_file = ?').run(owner);
    db.prepare('DELETE FROM diagnostics WHERE owner = ?').run(owner);
    if (!this.loaded.config.resolution.includeExplicitRoutes) return 0;

    const fragment = (p: string): { items: RouteItem[] } | null => {
      const j = db.prepare("SELECT data_json FROM file_records WHERE file_path = ? AND kind = 'route_fragment'").pluck().get(p) as string | undefined;
      return j ? JSON.parse(j) : null;
    };
    const ordered = new Map<string, { entry: Extract<RouteItem, { t: 'entry' }>; file: string }>();
    let diagN = 0;
    const visit = (file: string, stack: string[]) => {
      const frag = fragment(file);
      if (!frag) return;
      for (const item of frag.items) {
        if (item.t === 'entry') {
          const norm = `${item.method} ${item.path}`;
          const prev = ordered.get(norm);
          if (prev) ordered.set(norm, { entry: item, file }); // keep first position, last value (JS object semantics)
          else ordered.set(norm, { entry: item, file });
        } else if (item.t === 'include') {
          const target = item.modules.find((m) => fragment(m) !== null);
          if (!target) {
            insertDiag(owner, { code: 'ROUTE_INCLUDE_MISSING', severity: 'warning', message: `Required route file not found or not readable: ${item.modules[0]}`, filePath: file, span: item.span }, diagN++);
            continue;
          }
          if (stack.includes(target) || stack.length > 10) {
            insertDiag(owner, { code: 'ROUTE_INCLUDE_CYCLE', severity: 'warning', message: `Route file require cycle at ${target}`, filePath: file, span: item.span }, diagN++);
            continue;
          }
          visit(target, [...stack, target]);
        }
      }
    };
    visit('config/routes.js', ['config/routes.js']);

    let order = 0;
    const refIds: string[] = [];
    for (const [, { entry, file }] of ordered) {
      const id = routeId(entry.method, entry.path);
      const v: RouteValue = entry.value;
      const attrs: Record<string, unknown> = { method: entry.method, path: entry.path, key: entry.key, order: order++, declaredIn: file, target: describeTarget(v) };
      if (Object.keys(v.meta).length) attrs.metadata = v.meta;
      insertNode({ id, kind: 'ROUTE', name: `${entry.method === '*' ? '' : `${entry.method} `}${entry.path}`, filePath: file, span: entry.span, attributes: attrs }, owner);
      db.prepare('INSERT OR IGNORE INTO registry_keys(lookup_key, node_id, owner_file) VALUES (?,?,?)').run(`node:${id}`, id, owner);
      if (v.kind === 'action') {
        const refId = `ref:#routes:${id}`;
        insertRef({ id: refId, sourceNodeId: id, refKind: 'route_target', expression: `'${entry.key}': '${v.raw}'`, span: entry.span, spec: { type: 'action', key: `action:${v.action}` } }, file, owner);
        tracker.refAdded(refId);
        refIds.push(refId);
      } else if (v.kind === 'function') {
        insertEdge(owner, { source: id, target: v.fnId, kind: 'ROUTES_TO', resolution: 'static', confidence: 'high', attributes: { inline: true } }, null, { file, span: entry.span, expression: `'${entry.key}': function` });
      } else if (v.kind === 'unsupported') {
        insertDiag(owner, { code: 'ROUTE_TARGET_UNSUPPORTED', severity: 'info', message: `Route ${entry.key} target is not statically interpretable: ${v.text}`, filePath: file, span: entry.span }, diagN++);
      }
    }
    for (const r of refIds) resolveRef(r);
    return refIds.length;
  }

  // -------------------------------------------------------------------------
  // Derived: policies

  private rebuildPolicies(
    db: DB,
    tracker: ChangeTracker,
    insertEdge: (owner: string, e: { source: string; target: string; kind: string; resolution: string; confidence: string; attributes: Record<string, unknown> }, origin: string | null, ev: { file: string; span: Span; expression?: string } | null) => void,
    insertDiag: (owner: string, d: Diagnostic, n: number) => void,
    removeEdges: (rows: { source_id: string; kind: string; target_id: string }[]) => void,
  ): void {
    const owner = '#policies';
    removeEdges(db.prepare('SELECT source_id, kind, target_id FROM edges WHERE owner = ?').all(owner) as never);
    db.prepare('DELETE FROM edges WHERE owner = ?').run(owner);
    db.prepare('DELETE FROM derived_attributes WHERE owner = ?').run(owner);
    db.prepare('DELETE FROM diagnostics WHERE owner = ?').run(owner);
    if (!this.loaded.config.resolution.includePolicies) return;
    const j = db.prepare("SELECT data_json FROM file_records WHERE file_path = 'config/policies.js' AND kind = 'policy_rules'").pluck().get() as string | undefined;
    const rules: PolicyRule[] = j ? (JSON.parse(j).rules as PolicyRule[]) : [];
    const configReadable = j ? JSON.parse(j).readable !== false : false;
    const actions = db.prepare("SELECT id, attributes_json FROM nodes WHERE kind = 'ACTION' ORDER BY id").all() as { id: string; attributes_json: string }[];
    const setAttr = db.prepare('INSERT OR REPLACE INTO derived_attributes(node_id, key, value_json, owner) VALUES (?,?,?,?)');
    const lookup = db.prepare('SELECT node_id FROM registry_keys WHERE lookup_key = ? ORDER BY node_id').pluck();
    let diagN = 0;
    for (const a of actions) {
      const key = (JSON.parse(a.attributes_json).lookupKey as string | undefined) ?? a.id.slice('action:'.length).toLowerCase();
      const rule = bestPolicyRule(rules, key);
      if (!rule) {
        setAttr.run(a.id, 'policies', JSON.stringify(configReadable ? 'none' : 'unknown'), owner);
        continue;
      }
      setAttr.run(a.id, 'policyRule', JSON.stringify({ matchedRule: rule.matchedRule, file: 'config/policies.js', line: rule.span.startLine }), owner);
      if (rule.value === true) {
        setAttr.run(a.id, 'policies', JSON.stringify('public'), owner);
      } else if (rule.value === false) {
        setAttr.run(a.id, 'access', JSON.stringify('blocked'), owner);
        setAttr.run(a.id, 'policies', JSON.stringify('blocked'), owner);
        insertDiag(owner, { code: 'ACTION_BLOCKED', severity: 'info', message: `Action ${a.id} is blocked by policy rule '${rule.matchedRule}' (false).`, filePath: 'config/policies.js', span: rule.span }, diagN++);
      } else if (rule.value === null) {
        setAttr.run(a.id, 'policies', JSON.stringify('unknown'), owner);
      } else {
        const names: string[] = [];
        rule.value.names.forEach((n, order) => {
          names.push(n.name);
          const ids = lookup.all(`policy:${n.name.toLowerCase()}`) as string[];
          if (ids.length !== 1) return;
          insertEdge(owner, { source: a.id, target: ids[0], kind: 'GUARDED_BY', resolution: 'sails_convention', confidence: 'high', attributes: { order, matchedRule: rule.matchedRule, ruleSpan: { file: 'config/policies.js', startLine: rule.span.startLine, startCol: rule.span.startCol } } }, null, {
            file: 'config/policies.js',
            span: n.span,
            expression: `'${rule.matchedRule}': '${n.name}'`,
          });
        });
        setAttr.run(a.id, 'policies', JSON.stringify(names), owner);
      }
    }
    void tracker;
  }

  private recomputeDerivedDiagnostics(db: DB, insertDiag: (owner: string, d: Diagnostic, n: number) => void): void {
    const owner = '#derived';
    db.prepare('DELETE FROM diagnostics WHERE owner = ?').run(owner);
    const rows = db
      .prepare(
        "SELECT lookup_key, group_concat(node_id, '|') AS ids FROM registry_keys WHERE (lookup_key LIKE 'helper-access:%' OR lookup_key LIKE 'action:%' OR lookup_key LIKE 'model:%' OR lookup_key LIKE 'model-global:%' OR lookup_key LIKE 'policy:%' OR lookup_key LIKE 'service-global:%') GROUP BY lookup_key HAVING count(*) > 1 ORDER BY lookup_key",
      )
      .all() as { lookup_key: string; ids: string }[];
    const fileOf = db.prepare('SELECT file_path FROM nodes WHERE id = ?').pluck();
    let n = 0;
    for (const r of rows) {
      const ids = r.ids.split('|').sort();
      const files = ids.map((i) => fileOf.get(i) as string).filter(Boolean);
      const code = r.lookup_key.startsWith('helper-access:')
        ? 'HELPER_NAME_COLLISION'
        : r.lookup_key.startsWith('action:')
          ? 'ACTION_IDENTITY_CONFLICT'
          : r.lookup_key.startsWith('policy:')
            ? 'POLICY_NAME_COLLISION'
            : r.lookup_key.startsWith('service')
              ? 'SERVICE_NAME_COLLISION'
              : 'MODEL_IDENTITY_COLLISION';
      for (const f of files) {
        insertDiag(owner, { code, severity: 'error', message: `${r.lookup_key} is defined by multiple files (${files.join(', ')}); references to it are ambiguous.`, filePath: f }, n++);
      }
    }
  }
}

function describeTarget(v: RouteValue): Record<string, unknown> {
  switch (v.kind) {
    case 'action':
      return { kind: 'action', action: v.action, raw: v.raw };
    case 'function':
      return { kind: 'function', functionId: v.fnId };
    case 'redirect':
      return { kind: 'redirect', redirect: v.to };
    case 'view':
      return { kind: 'view', view: v.view };
    case 'response':
      return { kind: 'response', response: v.response };
    default:
      return { kind: 'unsupported', text: v.text };
  }
}

/** Sails policy precedence: exact > longest wildcard prefix > controller '*' > global '*'. Most specific replaces. */
export function bestPolicyRule(rules: PolicyRule[], actionKey: string): PolicyRule | null {
  let best: PolicyRule | null = null;
  let bestRank = -1;
  for (const r of rules) {
    let rank = -1;
    if (r.kind === 'exact' && r.pattern === actionKey) rank = 3_000_000;
    else if (r.kind === 'prefix' && actionKey.startsWith(r.pattern)) rank = 2_000_000 + r.pattern.length;
    else if (r.kind === 'controller' && actionKey.startsWith(r.pattern)) rank = 1_000_000 + r.pattern.length;
    else if (r.kind === 'global') rank = 0;
    if (rank > bestRank || (rank === bestRank && rank >= 0)) {
      // Later duplicates override earlier ones (JS object semantics).
      best = r;
      bestRank = rank;
    }
  }
  return best;
}

/** Rename colliding entity ids (same canonical id owned by another file). */
function disambiguateIds(f: ParsedFile, ownerOf: (id: string) => string | undefined): Map<string, string> {
  const idMap = new Map<string, string>();
  for (const n of f.nodes) {
    if (n.kind === 'FUNCTION' || n.kind === 'FILE' || n.kind === 'MODULE') continue;
    const owner = ownerOf(n.id);
    if (owner !== undefined && owner !== f.path) idMap.set(n.id, `${n.id}@${f.path}`);
  }
  if (!idMap.size) return idMap;
  const m = (id: string) => idMap.get(id) ?? id;
  for (const n of f.nodes) n.id = m(n.id);
  for (const e of f.edges as IREdge[]) {
    e.source = m(e.source);
    e.target = m(e.target);
  }
  for (const r of f.registry) {
    r.nodeId = m(r.nodeId);
    if (r.key.startsWith('node:')) r.key = `node:${m(r.key.slice(5))}`;
  }
  for (const r of f.references) r.sourceNodeId = m(r.sourceNodeId);
  return idMap;
}

// ---------------------------------------------------------------------------

class ChangeTracker {
  private removedNodes = new Map<string, string>();
  private addedNodes = new Map<string, string>();
  private edgeDelta = new Map<string, number>();
  private refBefore = new Map<string, string>();
  private refAfter = new Map<string, { status: string; reason: string | null; file: string; expression: string }>();
  private newRefs = new Set<string>();

  nodeRemoved(id: string, sig: string): void {
    if (this.addedNodes.has(id)) {
      // removed after being added within the same transaction
      this.addedNodes.delete(id);
      return;
    }
    if (!this.removedNodes.has(id)) this.removedNodes.set(id, sig);
  }
  nodeAdded(id: string, sig: string): void {
    this.addedNodes.set(id, sig);
  }
  edgeRemoved(s: string, k: string, t: string): void {
    const key = `${s}\u0000${k}\u0000${t}`;
    this.edgeDelta.set(key, (this.edgeDelta.get(key) ?? 0) - 1);
  }
  edgeAdded(s: string, k: string, t: string): void {
    const key = `${s}\u0000${k}\u0000${t}`;
    this.edgeDelta.set(key, (this.edgeDelta.get(key) ?? 0) + 1);
  }
  refRemoved(id: string, status: string): void {
    if (!this.refBefore.has(id) && !this.newRefs.has(id)) this.refBefore.set(id, status);
  }
  refAdded(id: string): void {
    this.newRefs.add(id);
  }
  refStatus(id: string, before: string, after: string, reason: string | null, file: string, expression: string): void {
    if (!this.refBefore.has(id) && before !== 'pending') this.refBefore.set(id, before);
    this.refAfter.set(id, { status: after, reason, file, expression });
  }

  summary(generation: number): ChangeSummary {
    const nodesAdded: string[] = [];
    const nodesRemoved: string[] = [];
    const nodesChanged: string[] = [];
    for (const [id, sig] of this.addedNodes) {
      const before = this.removedNodes.get(id);
      if (before === undefined) nodesAdded.push(id);
      else if (before !== sig && before !== 'synthetic') nodesChanged.push(id);
    }
    for (const id of this.removedNodes.keys()) if (!this.addedNodes.has(id)) nodesRemoved.push(id);
    const edgesAdded: [string, string, string][] = [];
    const edgesRemoved: [string, string, string][] = [];
    for (const [key, d] of this.edgeDelta) {
      const [s, k, t] = key.split('\u0000') as [string, string, string];
      for (let i = 0; i < d; i++) edgesAdded.push([s, k, t]);
      for (let i = 0; i < -d; i++) edgesRemoved.push([s, k, t]);
    }
    const changes: ChangeSummary['referenceStatusChanges'] = [];
    for (const [id, after] of this.refAfter) {
      const before = this.refBefore.get(id);
      if (before !== undefined && before !== after.status) {
        changes.push({ referenceId: id, file: after.file, expression: after.expression, from: before, to: after.status, reason: after.reason });
      }
    }
    const sortTriples = (a: [string, string, string], b: [string, string, string]) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1);
    nodesAdded.sort();
    nodesRemoved.sort();
    nodesChanged.sort();
    edgesAdded.sort(sortTriples);
    edgesRemoved.sort(sortTriples);
    changes.sort((a, b) => (a.referenceId < b.referenceId ? -1 : 1));
    const totals = {
      nodesAdded: nodesAdded.length,
      nodesRemoved: nodesRemoved.length,
      nodesChanged: nodesChanged.length,
      edgesAdded: edgesAdded.length,
      edgesRemoved: edgesRemoved.length,
      referenceStatusChanges: changes.length,
    };
    const truncated = Object.values(totals).some((n) => n > SUMMARY_CAP);
    return {
      generation,
      totals,
      nodesAdded: nodesAdded.slice(0, SUMMARY_CAP),
      nodesRemoved: nodesRemoved.slice(0, SUMMARY_CAP),
      nodesChanged: nodesChanged.slice(0, SUMMARY_CAP),
      edgesAdded: edgesAdded.slice(0, SUMMARY_CAP),
      edgesRemoved: edgesRemoved.slice(0, SUMMARY_CAP),
      referenceStatusChanges: changes.slice(0, SUMMARY_CAP),
      truncated,
    };
  }
}

export { categorize };
