import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { LoadedConfig } from '../config/load.js';
import type { DB } from '../storage/sqlite.js';
import type { Statement } from 'better-sqlite3';
import { getMeta } from '../storage/sqlite.js';
import { UserInputError } from '../util/errors.js';
import { normalizeRelative, safeJoin } from '../util/paths.js';
import { UNRESOLVED_STATUSES, type EdgeKind, type NodeKind } from '../graph/types.js';
import { routeMatcher } from './route-match.js';
import { detectSailsVersion } from '../discovery/project-root.js';
import { createHash } from 'node:crypto';

export interface GraphMeta {
  generation: number;
  status: string;
  scannedAt: string | null;
}

export type Detail = 'summary' | 'full';

export interface TraversalOptions {
  depth?: number;
  limit?: number;
  offset?: number;
  cursor?: string;
  relations?: EdgeKind[];
  includeReferences?: boolean;
  includeModelAccess?: boolean;
  excludePaths?: string[];
  detail?: Detail;
}

export interface NodeRow {
  id: string;
  kind: NodeKind;
  name: string;
  file_path: string | null;
  start_line: number | null;
  start_col: number | null;
  end_line: number | null;
  end_col: number | null;
  attributes_json: string;
  owner: string;
}

export interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  kind: EdgeKind;
  origin_reference_id: string | null;
  resolution: string;
  confidence: string;
  attributes_json: string;
  owner: string;
  evidence_file: string | null;
  start_line: number | null;
  start_col: number | null;
  end_line: number | null;
  end_col: number | null;
  expression: string | null;
}

export interface NodeSummary {
  kind: string;
  name: string;
  file: string | null;
  startLine: number | null;
  endLine: number | null;
}

const MODEL_EDGES: EdgeKind[] = ['READS_MODEL', 'WRITES_MODEL', 'USES_MODEL'];
const ESSENTIAL_ATTRS = ['operation', 'invocation', 'modifiers', 'order', 'matchedRule', 'via', 'member', 'inline', 'self', 'attribute', 'type'];
const ENTRY_KINDS = new Set(['ROUTE', 'ACTION']);

export class QueryService {
  private stmt: Record<string, Statement<unknown[], unknown>> = {};

  constructor(readonly db: DB, readonly loaded: LoadedConfig) {}

  private q(sql: string): Statement<unknown[], unknown> {
    let s = this.stmt[sql];
    if (!s) {
      s = this.db.prepare<unknown[], unknown>(sql);
      this.stmt[sql] = s;
    }
    return s;
  }

  /** Run a query against one consistent committed generation. */
  read<T>(fn: () => T): T {
    if (this.db.inTransaction) return fn();
    return this.db.transaction(fn)();
  }

  graphMeta(): GraphMeta {
    return {
      generation: getMeta<number>(this.db, 'generation') ?? 0,
      status: getMeta<string>(this.db, 'indexStatus') ?? 'initializing',
      scannedAt: getMeta<string>(this.db, 'lastSuccessfulScanAt') ?? null,
    };
  }

  private requireIndex(): void {
    if ((getMeta<number>(this.db, 'generation') ?? 0) === 0) {
      throw new UserInputError('No graph index exists yet.', 'Run `sails-codegraph index` first (MCP does this automatically at startup).');
    }
  }

  // -------------------------------------------------------------------------
  // Bounds and cursors

  depthOf(d?: number): number {
    const q = this.loaded.config.query;
    if (d === undefined || d === null) return q.defaultDepth;
    if (!Number.isInteger(d) || d < 1) throw new UserInputError(`depth must be a positive integer (max ${q.maxDepth}).`);
    return Math.min(d, q.maxDepth);
  }

  limitOf(l?: number): number {
    const q = this.loaded.config.query;
    if (l === undefined || l === null) return q.defaultLimit;
    if (!Number.isInteger(l) || l < 1) throw new UserInputError(`limit must be a positive integer (max ${q.maxLimit}).`);
    return Math.min(l, q.maxLimit);
  }

  encodeCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ g: this.graphMeta().generation, o: offset })).toString('base64url');
  }

  offsetOf(opts: { offset?: number; cursor?: string }): number {
    if (opts.cursor) {
      let parsed: { g: number; o: number };
      try {
        parsed = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8'));
      } catch {
        throw new UserInputError('Invalid cursor.', 'Omit the cursor to restart from the first page.');
      }
      if (parsed.g !== this.graphMeta().generation) {
        throw new UserInputError('cursor_stale: the graph changed since this cursor was issued.', 'Re-run the query without a cursor.', { code: 'cursor_stale' });
      }
      return Math.max(0, Number(parsed.o) || 0);
    }
    if (opts.offset !== undefined) {
      if (!Number.isInteger(opts.offset) || opts.offset < 0) throw new UserInputError('offset must be a non-negative integer.');
      return opts.offset;
    }
    return 0;
  }

  private page<T>(items: T[], opts: { limit?: number; offset?: number; cursor?: string }): { items: T[]; truncated: boolean; nextCursor: string | null; total: number; offset: number } {
    const limit = this.limitOf(opts.limit);
    const offset = this.offsetOf(opts);
    const slice = items.slice(offset, offset + limit);
    const truncated = offset + limit < items.length;
    return { items: slice, truncated, total: items.length, offset, nextCursor: truncated ? this.encodeCursor(offset + limit) : null };
  }

  // -------------------------------------------------------------------------
  // Node helpers

  node(id: string): NodeRow | undefined {
    return this.q('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  }

  summarize(n: NodeRow): NodeSummary {
    return { kind: n.kind, name: n.name, file: n.file_path, startLine: n.start_line, endLine: n.end_line };
  }

  derivedAttributes(id: string): Record<string, unknown> {
    const rows = this.q('SELECT key, value_json FROM derived_attributes WHERE node_id = ? ORDER BY key').all(id) as { key: string; value_json: string }[];
    const o: Record<string, unknown> = {};
    for (const r of rows) o[r.key] = JSON.parse(r.value_json);
    return o;
  }

  nodeAttributes(n: NodeRow): Record<string, unknown> {
    return { ...JSON.parse(n.attributes_json), ...this.derivedAttributes(n.id) };
  }

  private nodesMap(ids: Iterable<string>): Record<string, NodeSummary> {
    const out: Record<string, NodeSummary> = {};
    for (const id of [...new Set(ids)].sort()) {
      const n = this.node(id);
      if (n) out[id] = this.summarize(n);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // find_symbol

  findSymbol(query: string, opts: { kinds?: string[]; limit?: number } = {}) {
    return this.read(() => {
      this.requireIndex();
      if (!query || typeof query !== 'string') throw new UserInputError('query must be a non-empty string.');
      const limit = this.limitOf(opts.limit);
      const kinds = opts.kinds?.map((k) => k.toUpperCase());
      const matches = this.rankSymbols(query, kinds);
      const page = matches.slice(0, limit);
      return {
        query: { tool: 'find_symbol', query, kinds: kinds ?? null, limit },
        graph: this.graphMeta(),
        results: page.map(({ n, score, match }) => ({ id: n.id, ...this.summarize(n), startCol: n.start_col, match, score })),
        total: matches.length,
        truncated: matches.length > limit,
      };
    });
  }

  private rankSymbols(query: string, kinds?: string[]): { n: NodeRow; score: number; match: string }[] {
    const qLower = query.toLowerCase();
    const exact = this.node(query);
    const out = new Map<string, { n: NodeRow; score: number; match: string }>();
    const add = (n: NodeRow, score: number, match: string) => {
      if (kinds && !kinds.includes(n.kind)) return;
      const prev = out.get(n.id);
      if (!prev || prev.score < score) out.set(n.id, { n, score, match });
    };
    if (exact) add(exact, 100, 'exact_id');
    const like = `%${qLower.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.q("SELECT * FROM nodes WHERE kind NOT IN ('FILE') AND (lower(name) LIKE ? ESCAPE '\\' OR lower(id) LIKE ? ESCAPE '\\') LIMIT 5000").all(like, like) as NodeRow[];
    for (const n of rows) {
      const name = n.name.toLowerCase();
      const id = n.id.toLowerCase();
      const tail = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
      const last = name.split(/[./]/).pop() ?? name;
      let score = 0;
      let match = 'partial';
      if (id === qLower) [score, match] = [95, 'exact_id_ci'];
      else if (name === qLower || tail === qLower) [score, match] = [90, 'exact_name'];
      else if (last === qLower) [score, match] = [80, 'name_segment'];
      else if (name.startsWith(qLower) || tail.startsWith(qLower)) [score, match] = [60, 'prefix'];
      else [score, match] = [40 - Math.min(30, Math.abs(name.length - qLower.length)), 'partial'];
      // Prefer framework entities slightly over raw functions.
      if (n.kind !== 'FUNCTION' && n.kind !== 'MODULE') score += 2;
      add(n, score, match);
    }
    return [...out.values()].sort((a, b) => b.score - a.score || (a.n.id < b.n.id ? -1 : 1));
  }

  /** Resolve a symbol argument to exactly one node or throw with candidates. */
  resolveSymbol(arg: string, kinds?: string[]): NodeRow {
    this.requireIndex();
    if (!arg || typeof arg !== 'string') throw new UserInputError('A symbol id or name is required.');
    const exact = this.node(arg);
    if (exact && (!kinds || kinds.includes(exact.kind))) return exact;
    const ranked = this.rankSymbols(arg, kinds);
    const top = ranked.filter((r) => r.score >= 80);
    if (top.length === 1) return top[0].n;
    if (top.length > 1) {
      // Prefer a unique best score.
      const best = top[0].score;
      const bests = top.filter((t) => t.score === best);
      if (bests.length === 1 && best >= 90) return bests[0].n;
      throw new UserInputError(`Symbol "${arg}" is ambiguous (${top.length} matches).`, 'Use one of the candidate canonical ids.', {
        code: 'ambiguous_symbol',
        candidates: top.slice(0, 10).map((t) => ({ id: t.n.id, kind: t.n.kind, file: t.n.file_path, startLine: t.n.start_line })),
      });
    }
    throw new UserInputError(`Symbol not found: ${arg}`, ranked.length ? 'Did you mean one of the candidates?' : 'Use find_symbol to search by name.', {
      code: 'symbol_not_found',
      candidates: ranked.slice(0, 5).map((t) => ({ id: t.n.id, kind: t.n.kind, file: t.n.file_path, startLine: t.n.start_line })),
    });
  }

  // -------------------------------------------------------------------------
  // Traversal

  private edgesFrom(id: string, dir: 'out' | 'in', kinds: EdgeKind[]): EdgeRow[] {
    if (!kinds.length) return [];
    const ph = kinds.map(() => '?').join(',');
    const col = dir === 'out' ? 'source_id' : 'target_id';
    return this.q(`SELECT * FROM edges WHERE ${col} = ? AND kind IN (${ph}) ORDER BY source_id, target_id, start_line, id`).all(id, ...kinds) as EdgeRow[];
  }

  private edgeResult(e: EdgeRow, depth: number, via: string, detail: Detail) {
    const attrs = JSON.parse(e.attributes_json) as Record<string, unknown>;
    const out: Record<string, unknown> = {
      sourceId: e.source_id,
      targetId: e.target_id,
      relation: e.kind,
      resolution: e.resolution,
      confidence: e.confidence,
      depth,
      via,
    };
    if (e.evidence_file) {
      out.evidence = { file: e.evidence_file, startLine: e.start_line, startCol: e.start_col, endLine: e.end_line, endCol: e.end_col, expression: e.expression };
    }
    const kept = detail === 'full' ? attrs : Object.fromEntries(Object.entries(attrs).filter(([k]) => ESSENTIAL_ATTRS.includes(k)));
    if (Object.keys(kept).length) out.attributes = kept;
    return out;
  }

  private excluded(id: string, patterns: string[] | undefined): boolean {
    if (!patterns?.length) return false;
    const n = this.node(id);
    if (!n?.file_path) return false;
    return patterns.some((p) => globMatch(p, n.file_path!));
  }

  /**
   * Bounded BFS. `free` relations (IMPLEMENTED_BY) do not consume depth: they move between a
   * framework entity and its implementing function. `leaf` relations are reported but not expanded.
   */
  traverse(
    starts: string[],
    dir: 'out' | 'in',
    follow: EdgeKind[],
    opts: { depth: number; free?: EdgeKind[]; leaf?: EdgeKind[]; excludePaths?: string[]; detail?: Detail; maxVisited?: number },
  ) {
    const free = new Set<EdgeKind>(opts.free ?? ['IMPLEMENTED_BY']);
    const leaf = new Set(opts.leaf ?? []);
    const kinds = [...new Set([...follow, ...free, ...leaf])];
    const dist = new Map<string, number>();
    const parent = new Map<string, { from: string; relation: string }>();
    const deque: string[] = [];
    for (const s of starts) {
      dist.set(s, 0);
      deque.push(s);
    }
    const results: Record<string, unknown>[] = [];
    const seenEdges = new Set<string>();
    let cycle = false;
    const maxVisited = opts.maxVisited ?? 20_000;
    while (deque.length) {
      const cur = deque.shift()!;
      const d = dist.get(cur)!;
      for (const e of this.edgesFrom(cur, dir, kinds)) {
        if (seenEdges.has(e.id)) continue;
        const next = dir === 'out' ? e.target_id : e.source_id;
        const isFree = free.has(e.kind);
        const nd = isFree ? d : d + 1;
        if (nd > opts.depth) continue;
        if (this.excluded(next, opts.excludePaths)) continue;
        seenEdges.add(e.id);
        results.push(this.edgeResult(e, Math.max(1, nd), cur, opts.detail ?? 'summary'));
        const prev = dist.get(next);
        if (prev !== undefined) {
          if (starts.includes(next) || prev <= nd) cycle = cycle || starts.includes(next) || prev < nd;
          if (prev <= nd) continue;
        }
        dist.set(next, nd);
        parent.set(next, { from: cur, relation: e.kind });
        if (leaf.has(e.kind)) continue;
        if (dist.size > maxVisited) break;
        if (isFree) deque.unshift(next);
        else deque.push(next);
      }
    }
    results.sort((a, b) => {
      const ka = [a.depth as number, a.sourceId as string, a.targetId as string, ((a.evidence as { startLine?: number })?.startLine ?? 0)] as const;
      const kb = [b.depth as number, b.sourceId as string, b.targetId as string, ((b.evidence as { startLine?: number })?.startLine ?? 0)] as const;
      for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      return 0;
    });
    return { results, dist, parent, cycle };
  }

  private boundary(visited: Iterable<string>) {
    const ids = [...visited];
    let count = 0;
    const warnings: Record<string, unknown>[] = [];
    const ph = UNRESOLVED_STATUSES.map(() => '?').join(',');
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.q(
        `SELECT id, source_node_id, source_file, expression, resolution_status, unresolved_reason, start_line, start_col FROM raw_references WHERE source_node_id IN (${chunk.map(() => '?').join(',')}) AND resolution_status IN (${ph}) ORDER BY source_file, start_line, start_col, id`,
      ).all(...chunk, ...UNRESOLVED_STATUSES) as { id: string; source_node_id: string; source_file: string; expression: string; resolution_status: string; unresolved_reason: string | null; start_line: number; start_col: number }[];
      count += rows.length;
      for (const r of rows) {
        if (warnings.length >= 5) break;
        warnings.push({ sourceId: r.source_node_id, file: r.source_file, startLine: r.start_line, startCol: r.start_col, expression: r.expression, status: r.resolution_status, reason: r.unresolved_reason });
      }
    }
    return { count, warnings };
  }

  private relationsFor(kind: 'callers' | 'callees', opts: TraversalOptions): { follow: EdgeKind[]; leaf: EdgeKind[] } {
    if (opts.relations?.length) {
      const rel = opts.relations.map((r) => r.toUpperCase() as EdgeKind);
      return { follow: rel.filter((r) => !MODEL_EDGES.includes(r)), leaf: rel.filter((r) => MODEL_EDGES.includes(r)) };
    }
    const follow: EdgeKind[] = ['CALLS'];
    if (opts.includeReferences) follow.push('REFERENCES');
    const leaf: EdgeKind[] = kind === 'callees' && opts.includeModelAccess ? [...MODEL_EDGES] : [];
    return { follow, leaf };
  }

  callers(symbol: string, opts: TraversalOptions = {}) {
    return this.callGraph('get_callers', 'in', symbol, opts);
  }

  callees(symbol: string, opts: TraversalOptions = {}) {
    return this.callGraph('get_callees', 'out', symbol, opts);
  }

  private callGraph(tool: 'get_callers' | 'get_callees', dir: 'in' | 'out', symbol: string, opts: TraversalOptions) {
    return this.read(() => {
      const start = this.resolveSymbol(symbol);
      const depth = this.depthOf(opts.depth);
      const { follow, leaf } = this.relationsFor(tool === 'get_callers' ? 'callers' : 'callees', opts);
      const t = this.traverse([start.id], dir, follow, { depth, leaf, excludePaths: opts.excludePaths, detail: opts.detail });
      const page = this.page(t.results, opts);
      const ids = new Set<string>([start.id]);
      for (const r of page.items) {
        ids.add(r.sourceId as string);
        ids.add(r.targetId as string);
      }
      const b = this.boundary(dir === 'out' ? t.dist.keys() : [start.id, ...t.dist.keys()]);
      return {
        query: { tool, symbolId: start.id, depth, limit: this.limitOf(opts.limit), relations: [...follow, ...leaf, 'IMPLEMENTED_BY'] },
        graph: this.graphMeta(),
        results: page.items,
        nodes: this.nodesMap(ids),
        unresolvedRelatedCount: b.count,
        boundaryWarnings: b.warnings,
        cycleDetected: t.cycle,
        total: page.total,
        truncated: page.truncated,
        nextCursor: page.nextCursor,
        note: 'Static graph relationships only; runtime behavior (dynamic dispatch, blueprints, hooks) may differ.',
      };
    });
  }

  // -------------------------------------------------------------------------
  // Routes

  private allRoutes(): NodeRow[] {
    const rows = this.q("SELECT * FROM nodes WHERE kind = 'ROUTE'").all() as NodeRow[];
    return rows.sort((a, b) => (JSON.parse(a.attributes_json).order as number) - (JSON.parse(b.attributes_json).order as number));
  }

  private routeTargets(routeId: string): { targetId: string | null; resolution?: string; status?: string; reason?: string | null } {
    const e = this.q("SELECT target_id, resolution FROM edges WHERE source_id = ? AND kind = 'ROUTES_TO' ORDER BY target_id LIMIT 1").get(routeId) as { target_id: string; resolution: string } | undefined;
    if (e) return { targetId: e.target_id, resolution: e.resolution };
    const r = this.q('SELECT resolution_status, unresolved_reason FROM raw_references WHERE source_node_id = ? LIMIT 1').get(routeId) as { resolution_status: string; unresolved_reason: string | null } | undefined;
    return { targetId: null, status: r?.resolution_status, reason: r?.unresolved_reason ?? null };
  }

  private guards(actionId: string) {
    const rows = this.q("SELECT * FROM edges WHERE source_id = ? AND kind = 'GUARDED_BY'").all(actionId) as EdgeRow[];
    return rows
      .map((e) => {
        const a = JSON.parse(e.attributes_json);
        return { policyId: e.target_id, order: a.order as number, matchedRule: a.matchedRule as string, evidence: { file: e.evidence_file, startLine: e.start_line, startCol: e.start_col } };
      })
      .sort((a, b) => a.order - b.order);
  }

  private routeSummary(n: NodeRow) {
    const a = JSON.parse(n.attributes_json);
    const t = this.routeTargets(n.id);
    const target = t.targetId ? this.node(t.targetId) : undefined;
    const out: Record<string, unknown> = {
      id: n.id,
      method: a.method,
      path: a.path,
      order: a.order,
      file: n.file_path,
      startLine: n.start_line,
      target: a.target,
      targetId: t.targetId,
    };
    if (!t.targetId && t.status) out.targetStatus = { status: t.status, reason: t.reason };
    if (target?.kind === 'ACTION') {
      const d = this.derivedAttributes(target.id);
      out.policies = this.guards(target.id).map((g) => g.policyId);
      if (d.policies !== undefined && !Array.isArray(d.policies)) out.policyState = d.policies;
      if (d.access) out.access = d.access;
    }
    if (a.metadata) out.metadata = a.metadata;
    return out;
  }

  listRoutes(opts: { method?: string; pathPrefix?: string; action?: string; limit?: number; offset?: number; cursor?: string } = {}) {
    return this.read(() => {
      this.requireIndex();
      let routes = this.allRoutes();
      if (opts.method) {
        const m = opts.method.toUpperCase();
        routes = routes.filter((r) => {
          const rm = JSON.parse(r.attributes_json).method;
          return rm === m || rm === '*';
        });
      }
      if (opts.pathPrefix) routes = routes.filter((r) => String(JSON.parse(r.attributes_json).path).startsWith(opts.pathPrefix!));
      let summaries = routes.map((r) => this.routeSummary(r));
      if (opts.action) {
        const a = opts.action.toLowerCase();
        summaries = summaries.filter((s) => String(s.targetId ?? '').toLowerCase() === a || String(s.targetId ?? '').toLowerCase() === `action:${a}` || String((s.target as { action?: string })?.action ?? '') === a);
      }
      const page = this.page(summaries, opts);
      return {
        query: { tool: 'list_routes', method: opts.method ?? null, pathPrefix: opts.pathPrefix ?? null, action: opts.action ?? null },
        graph: this.graphMeta(),
        routes: page.items,
        total: page.total,
        truncated: page.truncated,
        nextCursor: page.nextCursor,
        note: 'Explicit routes from config/routes.js only, in declaration order; blueprint and hook-injected routes are not analyzed.',
      };
    });
  }

  /** Parse 'POST /api/payments' or (method, path). */
  static splitRoute(method: string | undefined, path: string | undefined): { method: string; path: string } {
    let m = method?.trim();
    let p = path?.trim();
    if (!p && m) {
      p = m;
      m = undefined;
    }
    if (!p) throw new UserInputError('A route path is required (e.g. "POST /api/payments").');
    const sp = /^([A-Za-z]+)\s+(\S.*)$/.exec(p);
    if (sp && !m) {
      m = sp[1];
      p = sp[2];
    }
    if (!p.startsWith('/')) throw new UserInputError(`Route path must start with "/": ${p}`);
    return { method: (m ?? '*').toUpperCase(), path: p };
  }

  matchRoutes(method: string, path: string): { route: NodeRow; matchType: 'pattern' | 'concrete'; params?: Record<string, string> }[] {
    const routes = this.allRoutes();
    const methodOk = (rm: string) => method === '*' || rm === '*' || rm === method;
    const exact = routes.filter((r) => {
      const a = JSON.parse(r.attributes_json);
      return methodOk(a.method) && a.path === path;
    });
    if (exact.length) return exact.map((route) => ({ route, matchType: 'pattern' as const }));
    const out: { route: NodeRow; matchType: 'concrete'; params?: Record<string, string> }[] = [];
    for (const r of routes) {
      const a = JSON.parse(r.attributes_json);
      if (!methodOk(a.method) || a.metadata?.regex) continue;
      const params = routeMatcher(a.path)(path);
      if (params) out.push({ route: r, matchType: 'concrete', params });
    }
    return out;
  }

  traceRoute(method: string | undefined, path: string | undefined, opts: { depth?: number; limit?: number; detail?: Detail } = {}) {
    return this.read(() => {
      this.requireIndex();
      const sp = QueryService.splitRoute(method, path);
      const depth = this.depthOf(opts.depth);
      const matches = this.matchRoutes(sp.method, sp.path);
      const limit = this.limitOf(opts.limit);
      const traced = matches.map((m, i) => {
        const summary = this.routeSummary(m.route);
        const targetId = summary.targetId as string | null;
        let downstream: Record<string, unknown> | null = null;
        if (targetId) {
          const t = this.traverse([targetId], 'out', ['CALLS'], { depth, leaf: MODEL_EDGES, detail: opts.detail });
          const b = this.boundary(t.dist.keys());
          const ids = new Set<string>([m.route.id, targetId]);
          const items = t.results.slice(0, limit);
          for (const r of items) {
            ids.add(r.sourceId as string);
            ids.add(r.targetId as string);
          }
          downstream = { results: items, nodes: this.nodesMap(ids), total: t.results.length, truncated: t.results.length > limit, unresolvedRelatedCount: b.count, boundaryWarnings: b.warnings };
        }
        return {
          primary: i === 0,
          matchType: m.matchType,
          params: m.params,
          route: summary,
          policies: targetId && this.node(targetId)?.kind === 'ACTION' ? this.guards(targetId) : [],
          downstream,
        };
      });
      const hint = matches.length ? undefined : this.routeHint(sp.path);
      return {
        query: { tool: 'trace_route', method: sp.method, path: sp.path, depth },
        graph: this.graphMeta(),
        matches: traced,
        truncated: traced.some((t) => (t.downstream as { truncated?: boolean } | null)?.truncated),
        ...(hint ? { hint } : {}),
        note: 'Matched against explicit routes in declaration order (first match is primary, as in Sails). Blueprint and hook-injected routes are not considered; policy order is from config, not observed execution.',
      };
    });
  }

  private routeHint(path: string): string {
    const prefix = path.split('/').slice(0, 2).join('/');
    const near = this.allRoutes()
      .map((r) => JSON.parse(r.attributes_json))
      .filter((a) => String(a.path).startsWith(prefix))
      .slice(0, 5)
      .map((a) => `${a.method} ${a.path}`);
    return near.length ? `No explicit route matched. Nearby routes: ${near.join(', ')}` : 'No explicit route matched. Use list_routes to see all explicit routes.';
  }

  // -------------------------------------------------------------------------
  // Impact

  private impactFrom(seeds: string[], depth: number, opts: { excludePaths?: string[]; limit?: number; offset?: number; cursor?: string; detail?: Detail }) {
    const follow: EdgeKind[] = ['CALLS', 'REFERENCES', 'ROUTES_TO', 'GUARDED_BY', 'READS_MODEL', 'WRITES_MODEL', 'USES_MODEL', 'ASSOCIATES_WITH', 'IMPORTS'];
    const t = this.traverse(seeds, 'in', follow, { depth, excludePaths: opts.excludePaths, detail: opts.detail });
    const seedSet = new Set(seeds);
    const affected: Record<string, unknown>[] = [];
    for (const [id, distance] of t.dist) {
      if (seedSet.has(id)) continue;
      const n = this.node(id);
      if (!n || n.kind === 'FILE' || n.kind === 'MODULE') continue;
      const reasonPath: { id: string; relation: string }[] = [];
      let cur = id;
      for (let guard = 0; guard < 50 && t.parent.has(cur); guard++) {
        const p = t.parent.get(cur)!;
        reasonPath.unshift({ id: cur, relation: p.relation });
        cur = p.from;
      }
      reasonPath.unshift({ id: cur, relation: 'SEED' });
      affected.push({ id, ...this.summarize(n), distance: Math.max(1, distance), reasonPath });
    }
    // Module importers (IMPORTS targets modules); include them for file-level seeds only.
    affected.sort((a, b) => (a.distance as number) - (b.distance as number) || ((a.id as string) < (b.id as string) ? -1 : 1));
    const page = this.page(affected, opts);
    const grouped: Record<string, unknown[]> = {};
    for (const a of page.items) {
      const k = a.kind as string;
      (grouped[k] ??= []).push(a);
    }
    const entryIds = [...t.dist.keys()].filter((id) => {
      const n = this.node(id);
      return n && ENTRY_KINDS.has(n.kind);
    });
    const entryPoints = entryIds.sort().map((id) => {
      const n = this.node(id)!;
      const e: Record<string, unknown> = { id, kind: n.kind, name: n.name, file: n.file_path, startLine: n.start_line, distance: t.dist.get(id) };
      if (n.kind === 'ACTION') {
        e.policies = this.guards(id).map((g) => g.policyId);
        const d = this.derivedAttributes(id);
        if (d.policies !== undefined && !Array.isArray(d.policies)) e.policyState = d.policies;
      }
      if (n.kind === 'ROUTE') {
        const a = JSON.parse(n.attributes_json);
        e.method = a.method;
        e.path = a.path;
      }
      return e;
    });
    const b = this.boundary(t.dist.keys());
    const warnings: string[] = [];
    if (b.count) warnings.push(`${b.count} unresolved/dynamic reference(s) inside the visited region; callers reached only through them are missing.`);
    const dyn = this.q("SELECT count(*) FROM raw_references WHERE resolution_status = 'unresolved_dynamic'").pluck().get() as number;
    if (dyn) warnings.push(`${dyn} dynamic reference(s) exist project-wide (e.g. computed helper names); impact through them is not represented.`);
    warnings.push('Blueprint routes, hooks and runtime dispatch are not analyzed.');
    return { affected: page, grouped, entryPoints, warnings, boundaryWarnings: b.warnings, cycle: t.cycle };
  }

  impact(symbol: string, opts: TraversalOptions = {}) {
    return this.read(() => {
      const start = this.resolveSymbol(symbol);
      const depth = this.depthOf(opts.depth);
      const r = this.impactFrom([start.id], depth, opts);
      return {
        query: { tool: 'analyze_impact', symbolId: start.id, depth },
        graph: this.graphMeta(),
        potentiallyAffected: r.grouped,
        affectedEntryPoints: r.entryPoints,
        missingCoverageWarnings: r.warnings,
        boundaryWarnings: r.boundaryWarnings,
        total: r.affected.total,
        truncated: r.affected.truncated,
        nextCursor: r.affected.nextCursor,
        note: 'Reverse-reachability candidates only; this does not assert that these nodes need edits or tests.',
      };
    });
  }

  normalizeFiles(files: string[]): string[] {
    const out: string[] = [];
    for (const f of files) {
      const n = normalizeRelative(this.loaded.root, f);
      if (n === null || n === '') throw new UserInputError(`Path is outside the project root: ${f}`, 'Use root-relative paths inside the project.', { code: 'path_outside_root' });
      out.push(n);
    }
    return [...new Set(out)].sort();
  }

  gitChangedFiles(): string[] {
    const run = (args: string[]) =>
      execFileSync('git', args, { cwd: this.loaded.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
    try {
      const diff = run(['diff', '--name-only', 'HEAD', '--relative']);
      const untracked = run(['ls-files', '--others', '--exclude-standard']);
      return [...diff.split('\n'), ...untracked.split('\n')].map((s) => s.trim()).filter(Boolean);
    } catch {
      throw new UserInputError('gitDiff requires a Git working tree with at least one commit.', 'Pass explicit files instead.');
    }
  }

  analyzeChanges(opts: TraversalOptions & { files?: string[]; gitDiff?: boolean }) {
    return this.read(() => {
      this.requireIndex();
      let files = opts.files ?? [];
      if (opts.gitDiff) files = [...files, ...this.gitChangedFiles()];
      if (!files.length) throw new UserInputError('Provide at least one file (or gitDiff: true).');
      const norm = this.normalizeFiles(files);
      const depth = this.depthOf(opts.depth);
      const seeds: string[] = [];
      const disappearing: Record<string, unknown>[] = [];
      const unknownFiles: string[] = [];
      for (const f of norm) {
        const rows = this.q('SELECT * FROM nodes WHERE file_path = ? AND owner = ? ORDER BY id').all(f, f) as NodeRow[];
        if (!rows.length) unknownFiles.push(f);
        for (const n of rows) {
          if (n.kind === 'FILE') continue;
          seeds.push(n.id);
          if (!['FUNCTION', 'MODULE'].includes(n.kind)) disappearing.push({ id: n.id, kind: n.kind, file: f });
        }
        // Routes declared in this file are derived but still owned conceptually by it.
        for (const r of this.q("SELECT id FROM nodes WHERE kind = 'ROUTE' AND file_path = ?").pluck().all(f) as string[]) {
          seeds.push(r);
          disappearing.push({ id: r, kind: 'ROUTE', file: f });
        }
      }
      const r = this.impactFrom(seeds, depth, opts);
      return {
        query: { tool: 'analyze_changes', files: norm, depth, gitDiff: !!opts.gitDiff },
        graph: this.graphMeta(),
        seeds: seeds.length,
        entitiesIfDeletedOrRenamed: disappearing,
        unindexedFiles: unknownFiles,
        potentiallyAffected: r.grouped,
        affectedEntryPoints: r.entryPoints,
        missingCoverageWarnings: r.warnings,
        total: r.affected.total,
        truncated: r.affected.truncated,
        nextCursor: r.affected.nextCursor,
        note: 'Reverse-reachability candidates seeded from every node owned by the files; not a guarantee of regression. The graph reflects the last sync, so sync first if the files were just edited.',
      };
    });
  }

  // -------------------------------------------------------------------------
  // Unresolved

  unresolved(opts: { file?: string; kind?: string; reason?: string; status?: string; groupBy?: 'reason' | 'file' | 'key'; limit?: number; offset?: number; cursor?: string } = {}) {
    return this.read(() => {
      this.requireIndex();
      const where: string[] = [`resolution_status IN (${UNRESOLVED_STATUSES.map(() => '?').join(',')})`];
      const params: unknown[] = [...UNRESOLVED_STATUSES];
      if (opts.file) {
        where.push('source_file = ?');
        params.push(this.normalizeFiles([opts.file])[0]);
      }
      if (opts.kind) {
        where.push('ref_kind = ?');
        params.push(opts.kind);
      }
      if (opts.reason) {
        where.push('(unresolved_reason = ? OR resolution_status = ?)');
        params.push(opts.reason, opts.reason);
      }
      if (opts.status) {
        where.push('resolution_status = ?');
        params.push(opts.status);
      }
      const rows = this.q(`SELECT * FROM raw_references WHERE ${where.join(' AND ')} ORDER BY source_file, start_line, start_col, id`).all(...params) as {
        id: string; source_file: string; source_node_id: string; ref_kind: string; expression: string; lookup_key: string | null; resolution_status: string; unresolved_reason: string | null; start_line: number; start_col: number; end_line: number; end_col: number;
      }[];
      const items = rows.map((r) => ({
        id: r.id,
        file: r.source_file,
        startLine: r.start_line,
        startCol: r.start_col,
        expression: r.expression,
        kind: r.ref_kind,
        status: r.resolution_status,
        reason: r.unresolved_reason,
        sourceId: r.source_node_id,
        candidateKeys: (this.q('SELECT lookup_key FROM reference_keys WHERE reference_id = ? ORDER BY lookup_key').pluck().all(r.id) as string[]).filter((k) => !k.startsWith('globals:')),
      }));
      const byStatus: Record<string, number> = {};
      for (const it of items) byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
      const classCounts = this.classCounts();
      let groups: Record<string, number> | undefined;
      if (opts.groupBy) {
        groups = {};
        for (const it of items) {
          const g = opts.groupBy === 'reason' ? `${it.status}:${it.reason ?? ''}` : opts.groupBy === 'file' ? it.file : (it.candidateKeys[0] ?? '(none)');
          groups[g] = (groups[g] ?? 0) + 1;
        }
        groups = Object.fromEntries(Object.entries(groups).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
      }
      const page = this.page(items, opts);
      const diags = this.q("SELECT file_path, severity, code, message, start_line, start_col FROM diagnostics WHERE severity IN ('error','warning') ORDER BY severity, file_path, start_line, code LIMIT 50").all();
      return {
        query: { tool: 'get_unresolved', file: opts.file ?? null, kind: opts.kind ?? null, reason: opts.reason ?? null, groupBy: opts.groupBy ?? null },
        graph: this.graphMeta(),
        counts: { unresolved: items.length, byStatus, filtered: classCounts },
        ...(groups ? { groups } : {}),
        results: page.items,
        diagnostics: diags,
        total: page.total,
        truncated: page.truncated,
        nextCursor: page.nextCursor,
      };
    });
  }

  /** Per-class counts of references filtered before persistence (Section 7.5). */
  classCounts(): Record<string, number> {
    const rows = this.q('SELECT counts_json FROM files').pluck().all() as string[];
    const out: Record<string, number> = { external: 0, plumbing: 0 };
    for (const r of rows) {
      const c = JSON.parse(r) as Record<string, number>;
      for (const [k, v] of Object.entries(c)) out[k] = (out[k] ?? 0) + v;
    }
    out.externalImports = this.q("SELECT count(*) FROM raw_references WHERE resolution_status = 'external'").pluck().get() as number;
    return out;
  }

  // -------------------------------------------------------------------------
  // File outline / symbol detail

  fileOutline(file: string) {
    return this.read(() => {
      this.requireIndex();
      const [p] = this.normalizeFiles([file]);
      const fileRow = this.q('SELECT path, content_hash, size_bytes, status, generation FROM files WHERE path = ?').get(p) as { path: string; content_hash: string; size_bytes: number; status: string; generation: number } | undefined;
      if (!fileRow) {
        const near = (this.q('SELECT path FROM files ORDER BY path').pluck().all() as string[]).filter((x) => x.endsWith(p.split('/').pop()!)).slice(0, 5);
        throw new UserInputError(`File is not indexed: ${p}`, near.length ? `Indexed files with that name: ${near.join(', ')}` : 'Check the path and include/exclude config.', { code: 'file_not_indexed', candidates: near });
      }
      const nodes = this.q("SELECT * FROM nodes WHERE file_path = ? AND kind NOT IN ('FILE','MODULE') ORDER BY start_line, start_col, id").all(p) as NodeRow[];
      const count = (sql: string, id: string) => this.q(sql).pluck().get(id) as number;
      const entries = nodes.map((n) => {
        const owners = this.q("SELECT source_id FROM edges WHERE target_id = ? AND kind = 'IMPLEMENTED_BY' ORDER BY source_id").pluck().all(n.id) as string[];
        const implementedBy = this.q("SELECT target_id FROM edges WHERE source_id = ? AND kind = 'IMPLEMENTED_BY' ORDER BY target_id").pluck().all(n.id) as string[];
        const e: Record<string, unknown> = {
          id: n.id,
          kind: n.kind,
          name: n.name,
          startLine: n.start_line,
          startCol: n.start_col,
          endLine: n.end_line,
          endCol: n.end_col,
          incomingCalls: count("SELECT count(*) FROM edges WHERE target_id = ? AND kind = 'CALLS'", n.id),
          outgoingCalls: count("SELECT count(*) FROM edges WHERE source_id = ? AND kind = 'CALLS'", n.id),
        };
        if (owners.length) e.implements = owners;
        if (implementedBy.length) e.implementedBy = implementedBy;
        return e;
      });
      const unresolved = this.q(`SELECT id, expression, resolution_status AS status, unresolved_reason AS reason, start_line AS startLine, start_col AS startCol, source_node_id AS sourceId FROM raw_references WHERE source_file = ? AND resolution_status IN (${UNRESOLVED_STATUSES.map(() => '?').join(',')}) ORDER BY start_line, start_col`).all(p, ...UNRESOLVED_STATUSES);
      const diagnostics = this.q('SELECT severity, code, message, start_line AS startLine, start_col AS startCol FROM diagnostics WHERE file_path = ? ORDER BY start_line, code').all(p);
      const counts = JSON.parse((this.q('SELECT counts_json FROM files WHERE path = ?').pluck().get(p) as string) ?? '{}');
      return {
        query: { tool: 'get_file_outline', file: p },
        graph: this.graphMeta(),
        file: { path: p, status: fileRow.status, sizeBytes: fileRow.size_bytes, sha256: fileRow.content_hash, parsedGeneration: fileRow.generation, filteredReferenceCounts: counts },
        symbols: entries,
        unresolved,
        diagnostics,
        truncated: false,
      };
    });
  }

  getSymbol(symbol: string, opts: { includeSnippet?: boolean; limit?: number; detail?: Detail; snippetLines?: number } = {}) {
    return this.read(() => {
      const n = this.resolveSymbol(symbol);
      const limit = this.limitOf(opts.limit ?? 25);
      const attributes = this.nodeAttributes(n);
      const out = this.q('SELECT * FROM edges WHERE source_id = ? ORDER BY kind, target_id, start_line, id').all(n.id) as EdgeRow[];
      const inc = this.q('SELECT * FROM edges WHERE target_id = ? ORDER BY kind, source_id, start_line, id').all(n.id) as EdgeRow[];
      const detail = opts.detail ?? 'full';
      const fmt = (e: EdgeRow) => this.edgeResult(e, 1, n.id, detail);
      const ids = new Set<string>([n.id]);
      const outgoing = out.slice(0, limit).map(fmt);
      const incoming = inc.slice(0, limit).map(fmt);
      for (const e of [...outgoing, ...incoming]) {
        ids.add(e.sourceId as string);
        ids.add(e.targetId as string);
      }
      const result: Record<string, unknown> = {
        query: { tool: 'get_symbol', symbolId: n.id },
        graph: this.graphMeta(),
        symbol: { id: n.id, kind: n.kind, name: n.name, file: n.file_path, startLine: n.start_line, startCol: n.start_col, endLine: n.end_line, endCol: n.end_col, attributes },
        outgoing,
        incoming,
        counts: { outgoing: out.length, incoming: inc.length },
        nodes: this.nodesMap(ids),
        truncated: out.length > limit || inc.length > limit,
      };
      if (n.kind === 'ACTION') result.guardedBy = this.guards(n.id);
      if (opts.includeSnippet && n.file_path && n.start_line) result.snippet = this.snippet(n.file_path, n.start_line, n.end_line ?? n.start_line, opts.snippetLines ?? 40);
      return result;
    });
  }

  snippet(file: string, start: number, end: number, maxLines: number) {
    const abs = safeJoin(this.loaded.root, file);
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      return { file, available: false };
    }
    const lines = text.split(/\r?\n/);
    const last = Math.min(end, start + maxLines - 1, lines.length);
    const body = lines.slice(start - 1, last).join('\n');
    const hash = this.q('SELECT content_hash FROM files WHERE path = ?').pluck().get(file) as string | undefined;
    const fresh = hash ? createHash('sha256').update(text).digest('hex') === hash : false;
    return {
      file,
      startLine: start,
      endLine: last,
      truncated: last < end,
      text: body.length > 8000 ? body.slice(0, 8000) : body,
      freshness: fresh ? 'matches_indexed_content' : 'file_changed_since_index',
    };
  }

  // -------------------------------------------------------------------------
  // Model usage

  modelUsage(model: string, opts: { limit?: number; detail?: Detail } = {}) {
    return this.read(() => {
      this.requireIndex();
      let n = this.node(model) ?? this.node(`model:${model.toLowerCase()}`);
      if (!n || n.kind !== 'MODEL') {
        const ids = this.q("SELECT node_id FROM registry_keys WHERE lookup_key = ?").pluck().all(`model-global:${model}`) as string[];
        if (ids.length === 1) n = this.node(ids[0]);
      }
      if (!n || n.kind !== 'MODEL') n = this.resolveSymbol(model, ['MODEL']);
      const limit = this.limitOf(opts.limit);
      const edges = this.q("SELECT * FROM edges WHERE target_id = ? AND kind IN ('READS_MODEL','WRITES_MODEL','USES_MODEL') ORDER BY source_id, start_line, id").all(n.id) as EdgeRow[];
      const groups: Record<string, Record<string, unknown>[]> = { read: [], write: [], uses: [], native: [], populate: [] };
      const accessors = new Set<string>();
      for (const e of edges) {
        const a = JSON.parse(e.attributes_json);
        const g = a.operation === 'native' ? 'native' : a.operation === 'populate' ? 'populate' : e.kind === 'READS_MODEL' ? 'read' : e.kind === 'WRITES_MODEL' ? 'write' : 'uses';
        accessors.add(e.source_id);
        if (groups[g].length < limit) {
          groups[g].push({ sourceId: e.source_id, operation: a.operation, modifiers: a.modifiers, resolution: e.resolution, confidence: e.confidence, evidence: { file: e.evidence_file, startLine: e.start_line, startCol: e.start_col, expression: e.expression } });
        }
      }
      const assocOut = (this.q("SELECT * FROM edges WHERE source_id = ? AND kind = 'ASSOCIATES_WITH' ORDER BY target_id").all(n.id) as EdgeRow[]).map((e) => ({ targetId: e.target_id, ...JSON.parse(e.attributes_json) }));
      const assocIn = (this.q("SELECT * FROM edges WHERE target_id = ? AND kind = 'ASSOCIATES_WITH' ORDER BY source_id").all(n.id) as EdgeRow[]).map((e) => ({ sourceId: e.source_id, ...JSON.parse(e.attributes_json) }));
      const entry: Record<string, string[]> = {};
      let budget = 200;
      for (const acc of [...accessors].sort()) {
        if (budget-- <= 0) break;
        const t = this.traverse([acc], 'in', ['CALLS', 'ROUTES_TO'] as EdgeKind[], { depth: 4, maxVisited: 2000 });
        const routes = [...t.dist.keys()].filter((id) => id.startsWith('route:')).sort().slice(0, 10);
        if (routes.length) entry[acc] = routes;
      }
      const unresolvedNear = this.q("SELECT count(*) FROM raw_references WHERE resolution_status != 'resolved' AND ref_kind IN ('model','populate') AND (lookup_key = ? OR lookup_key = ?)").pluck().get(`model:${JSON.parse(n.attributes_json).identity}`, `model-global:${n.name}`) as number;
      return {
        query: { tool: 'get_model_usage', modelId: n.id },
        graph: this.graphMeta(),
        model: { id: n.id, name: n.name, file: n.file_path, attributes: this.nodeAttributes(n) },
        accessors: groups,
        totals: { accessEdges: edges.length, accessorFunctions: accessors.size },
        associations: { outgoing: assocOut, incoming: assocIn },
        entryPoints: entry,
        unresolvedModelReferences: unresolvedNear,
        truncated: Object.values(groups).some((g) => g.length >= limit) && edges.length > limit,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Paths (optional)

  findPaths(from: string, to: string, opts: { maxDepth?: number; limit?: number } = {}) {
    return this.read(() => {
      const a = this.resolveSymbol(from);
      const b = this.resolveSymbol(to);
      const maxDepth = this.depthOf(opts.maxDepth);
      const maxPaths = Math.min(opts.limit ?? 5, 20);
      const kinds: EdgeKind[] = ['ROUTES_TO', 'IMPLEMENTED_BY', 'CALLS', 'READS_MODEL', 'WRITES_MODEL', 'USES_MODEL', 'GUARDED_BY', 'REFERENCES'];
      const parents = new Map<string, { from: string; relation: string }[]>();
      const dist = new Map<string, number>([[a.id, 0]]);
      let frontier = [a.id];
      for (let d = 0; d < maxDepth * 2 && frontier.length && !dist.has(b.id); d++) {
        const next: string[] = [];
        for (const cur of frontier) {
          for (const e of this.edgesFrom(cur, 'out', kinds)) {
            const t = e.target_id;
            const nd = d + 1;
            if (!dist.has(t)) {
              dist.set(t, nd);
              next.push(t);
            }
            if (dist.get(t) === nd) (parents.get(t) ?? parents.set(t, []).get(t)!).push({ from: cur, relation: e.kind });
          }
        }
        frontier = next;
      }
      const paths: { id: string; relation: string }[][] = [];
      const walk = (id: string, acc: { id: string; relation: string }[]) => {
        if (paths.length >= maxPaths) return;
        if (id === a.id) {
          paths.push([{ id: a.id, relation: 'START' }, ...acc]);
          return;
        }
        for (const p of (parents.get(id) ?? []).slice().sort((x, y) => (x.from < y.from ? -1 : 1))) walk(p.from, [{ id, relation: p.relation }, ...acc]);
      };
      if (dist.has(b.id)) walk(b.id, []);
      const ids = new Set(paths.flat().map((p) => p.id));
      return { query: { tool: 'find_paths', from: a.id, to: b.id, maxDepth }, graph: this.graphMeta(), paths, nodes: this.nodesMap(ids), truncated: paths.length >= maxPaths };
    });
  }

  // -------------------------------------------------------------------------
  // Stats / overview / status

  coverage(): Record<string, string> {
    const r = this.loaded.config.resolution;
    const globals = this.q("SELECT data_json FROM file_records WHERE file_path = 'config/globals.js' AND kind = 'globals'").pluck().get() as string | undefined;
    const g = globals ? JSON.parse(globals) : null;
    return {
      actions2: 'supported',
      classic_controllers: 'supported',
      helpers: 'supported',
      services: 'supported',
      models: 'supported',
      model_associations: r.includeModelAssociations ? 'supported' : 'disabled',
      explicit_routes: r.includeExplicitRoutes ? 'supported' : 'disabled',
      route_file_requires: r.followRouteFileRequires ? 'supported' : 'disabled',
      policies: r.includePolicies ? 'supported' : 'disabled',
      globals_config: !r.honorGlobalsConfig ? 'ignored' : g && g.readable ? 'read' : 'assumed_default',
      implicit_blueprints: 'not_analyzed',
      custom_hooks: 'not_analyzed',
      custom_responses: 'not_analyzed',
      runtime_dispatch: 'not_analyzed',
    };
  }

  stats() {
    return this.read(() => {
      const count = (sql: string) => this.q(sql).all() as { k: string; c: number }[];
      const toObj = (rows: { k: string; c: number }[]) => Object.fromEntries(rows.map((r) => [r.k, r.c]));
      const meta = {
        schemaVersion: getMeta<number>(this.db, 'schemaVersion') ?? null,
        indexerVersion: getMeta<string>(this.db, 'indexerVersion') ?? null,
        generation: getMeta<number>(this.db, 'generation') ?? 0,
        projectRoot: this.loaded.root,
        lastSuccessfulScanAt: getMeta<string>(this.db, 'lastSuccessfulScanAt') ?? null,
        indexStatus: getMeta<string>(this.db, 'indexStatus') ?? 'initializing',
        fileCount: getMeta<number>(this.db, 'fileCount') ?? 0,
      };
      return {
        graph: this.graphMeta(),
        meta,
        nodes: toObj(count('SELECT kind AS k, count(*) AS c FROM nodes GROUP BY kind ORDER BY kind')),
        edges: toObj(count('SELECT kind AS k, count(*) AS c FROM edges GROUP BY kind ORDER BY kind')),
        edgeResolution: toObj(count("SELECT resolution || '/' || confidence AS k, count(*) AS c FROM edges WHERE owner != 'file:' || coalesce(evidence_file,'') GROUP BY k ORDER BY k")),
        references: toObj(count('SELECT resolution_status AS k, count(*) AS c FROM raw_references GROUP BY resolution_status ORDER BY resolution_status')),
        filteredReferences: this.classCounts(),
        files: toObj(count('SELECT status AS k, count(*) AS c FROM files GROUP BY status ORDER BY status')),
        diagnostics: toObj(count('SELECT severity AS k, count(*) AS c FROM diagnostics GROUP BY severity ORDER BY severity')),
        pendingErrors: this.q("SELECT file_path, code, message FROM diagnostics WHERE owner LIKE '#parse:%' ORDER BY file_path LIMIT 20").all(),
        coverage: this.coverage(),
        sailsVersion: detectSailsVersion(this.loaded.root),
      };
    });
  }

  overview() {
    return this.read(() => {
      const s = this.stats();
      const top = (kind: string) => this.q('SELECT id FROM nodes WHERE kind = ? ORDER BY id LIMIT 25').pluck().all(kind) as string[];
      return {
        graph: s.graph,
        health: { status: s.meta.indexStatus, files: s.files, diagnostics: s.diagnostics, unresolved: Object.entries(s.references).filter(([k]) => UNRESOLVED_STATUSES.includes(k as never)).reduce((a, [, v]) => a + (v as number), 0) },
        counts: { nodes: s.nodes, edges: s.edges, references: s.references },
        components: { routes: top('ROUTE'), actions: top('ACTION'), helpers: top('HELPER'), models: top('MODEL'), services: top('SERVICE'), policies: top('POLICY') },
        coverage: s.coverage,
        truncated: false,
        note: 'Static analysis of explicit Sails conventions; runtime behavior may differ.',
      };
    });
  }

  indexStatus(extra: Record<string, unknown> = {}) {
    return this.read(() => ({
      graph: this.graphMeta(),
      projectRoot: this.loaded.root,
      lastSyncSummary: getMeta(this.db, 'lastSyncSummary') ?? null,
      pendingErrors: this.q("SELECT file_path AS file, code, message FROM diagnostics WHERE owner LIKE '#parse:%' ORDER BY file_path LIMIT 20").all(),
      brokenFiles: this.q("SELECT path, status FROM files WHERE status != 'ok' ORDER BY path").all(),
      coverage: this.coverage(),
      lastError: getMeta(this.db, 'lastError') ?? null,
      ...extra,
    }));
  }

  // -------------------------------------------------------------------------
  // Export

  exportGraph() {
    return this.read(() => {
      this.requireIndex();
      const nodes = (this.q('SELECT * FROM nodes ORDER BY id').all() as NodeRow[]).map((n) => ({
        id: n.id,
        kind: n.kind,
        name: n.name,
        file: n.file_path,
        span: n.start_line === null ? null : { startLine: n.start_line, startCol: n.start_col, endLine: n.end_line, endCol: n.end_col },
        attributes: this.nodeAttributes(n),
      }));
      const edges = (this.q('SELECT * FROM edges ORDER BY source_id, kind, target_id, id').all() as EdgeRow[]).map((e) => ({
        id: e.id,
        source: e.source_id,
        target: e.target_id,
        kind: e.kind,
        resolution: e.resolution,
        confidence: e.confidence,
        originReference: e.origin_reference_id,
        attributes: JSON.parse(e.attributes_json),
        evidence: e.evidence_file ? { file: e.evidence_file, startLine: e.start_line, startCol: e.start_col, endLine: e.end_line, endCol: e.end_col, expression: e.expression } : null,
      }));
      const references = (this.q('SELECT * FROM raw_references ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({
        id: r.id,
        file: r.source_file,
        sourceId: r.source_node_id,
        kind: r.ref_kind,
        expression: r.expression,
        status: r.resolution_status,
        reason: r.unresolved_reason,
        targetId: r.target_id,
        primaryKey: r.lookup_key,
        span: { startLine: r.start_line, startCol: r.start_col, endLine: r.end_line, endCol: r.end_col },
      }));
      const diagnostics = this.q('SELECT file_path AS file, severity, code, message, start_line AS startLine, start_col AS startCol FROM diagnostics ORDER BY file_path, code, start_line, start_col, message').all();
      const files = this.q('SELECT path, content_hash AS sha256, size_bytes AS sizeBytes, status FROM files ORDER BY path').all();
      return {
        format: 'sails-codegraph/graph@1',
        meta: { schemaVersion: getMeta(this.db, 'schemaVersion'), indexerVersion: getMeta(this.db, 'indexerVersion'), generation: getMeta(this.db, 'generation'), status: getMeta(this.db, 'indexStatus'), scannedAt: getMeta(this.db, 'lastSuccessfulScanAt') },
        files,
        nodes,
        edges,
        references,
        diagnostics,
      };
    });
  }
}

/** Minimal glob matching (`*`, `**`, `?`) for excludePaths. */
function globMatch(pattern: string, file: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(file);
}

const globCache = new Map<string, RegExp>();
function globToRegExp(pattern: string): RegExp {
  let re = globCache.get(pattern);
  if (re) return re;
  let s = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        s += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else s += '[^/]*';
    } else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${s}$`);
  globCache.set(pattern, re);
  return re;
}
