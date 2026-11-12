import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { McpContext } from './server.js';
import { fitResponse } from '../query/budget.js';
import { UserInputError } from '../util/errors.js';
import { EDGE_KINDS, NODE_KINDS, type EdgeKind } from '../graph/types.js';

const STATIC_NOTE = 'Static graph derived from source (never executed); it does not describe observed runtime behavior.';

const detail = z.enum(['summary', 'full']).optional().describe('summary (default): ids, kinds, names, locations; full: all attributes');
const depth = z.number().int().min(1).max(20).optional().describe('traversal depth (default 2, server max 5)');
const limit = z.number().int().min(1).max(10_000).optional().describe('max results (default 100, server max 500)');
const cursor = z.string().max(500).optional().describe('pagination cursor from a previous response (nextCursor)');
const symbolId = z.string().min(1).max(500).describe('canonical node id (e.g. helper:payment/process) or a name');
const relPath = z.string().min(1).max(1000);

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export function registerTools(server: McpServer, ctx: McpContext): void {
  const q = () => ctx.project.queries;

  const ok = (data: Record<string, unknown>): ToolResult => {
    const fitted = fitResponse(data, ctx.maxResponseBytes, (offset) => q().encodeCursor(offset));
    return { content: [{ type: 'text', text: JSON.stringify(fitted) }], structuredContent: fitted };
  };

  const fail = (err: unknown): ToolResult => {
    const e = err as Error & { hint?: string; details?: unknown };
    const payload: Record<string, unknown> = {
      error: {
        message: e.message,
        hint: e.hint ?? (err instanceof UserInputError ? undefined : 'Internal error; check the server stderr log.'),
        ...(e.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {}),
      },
    };
    try {
      payload.graph = q().graphMeta();
    } catch {
      /* ignore */
    }
    if (!(err instanceof UserInputError)) ctx.logger.error(`tool error: ${e.stack ?? e.message}`);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
  };

  /** Data-reading tools: freshness check first, then query against one committed generation. */
  const reading = <A>(fn: (args: A) => Record<string, unknown>) => async (args: A): Promise<ToolResult> => {
    try {
      await ctx.coordinator.syncIfNeeded();
      const data = fn(args);
      if (ctx.coordinator.lastError) data.syncWarning = `Last sync failed: ${ctx.coordinator.lastError}. Results come from the last committed generation.`;
      return ok(data);
    } catch (err) {
      return fail(err);
    }
  };

  const edgeKinds = z.array(z.enum(EDGE_KINDS as [EdgeKind, ...EdgeKind[]])).max(11).optional();

  server.registerTool(
    'get_overview',
    {
      title: 'Graph overview',
      description: `Counts, major components (routes, actions, helpers, models, services, policies), health and freshness of the Sails code graph. ${STATIC_NOTE}`,
      inputSchema: z.object({ detail }),
      annotations: { readOnlyHint: true },
    },
    reading(() => q().overview()),
  );

  server.registerTool(
    'find_symbol',
    {
      title: 'Find symbol',
      description: 'Find nodes by canonical id, name or partial name. Returns all candidates (with kind and file:line) when ambiguous instead of choosing one.',
      inputSchema: z.object({ query: z.string().min(1).max(500), kinds: z.array(z.enum(NODE_KINDS as [string, ...string[]])).max(10).optional(), limit, detail }),
      annotations: { readOnlyHint: true },
    },
    reading((a: { query: string; kinds?: string[]; limit?: number }) => q().findSymbol(a.query, a)),
  );

  const traversalSchema = z.object({
    symbolId,
    depth,
    limit,
    cursor,
    relations: edgeKinds.describe('edge kinds to follow (default CALLS + IMPLEMENTED_BY)'),
    includeReferences: z.boolean().optional().describe('also follow REFERENCES (functions passed as values)'),
    includeModelAccess: z.boolean().optional().describe('include model access edges as leaf results'),
    excludePaths: z.array(z.string().max(300)).max(20).optional().describe('glob patterns of files to hide'),
    detail,
  });

  server.registerTool(
    'get_callers',
    {
      title: 'Callers',
      description: `Incoming static call relationships (bounded, cycle-safe), including calls to a helper/service entity, with file:line evidence. Unresolved references at the boundary are reported, never guessed. ${STATIC_NOTE}`,
      inputSchema: traversalSchema,
      annotations: { readOnlyHint: true },
    },
    reading((a: z.infer<typeof traversalSchema>) => q().callers(a.symbolId, a)),
  );

  server.registerTool(
    'get_callees',
    {
      title: 'Callees',
      description: `Outgoing static call relationships (bounded, cycle-safe); framework entities expand through IMPLEMENTED_BY to their implementing function. ${STATIC_NOTE}`,
      inputSchema: traversalSchema,
      annotations: { readOnlyHint: true },
    },
    reading((a: z.infer<typeof traversalSchema>) => q().callees(a.symbolId, a)),
  );

  const traceSchema = z.object({
    method: z.string().max(20).optional().describe('HTTP method, e.g. POST (or include it in path: "POST /api/payments")'),
    path: z.string().min(1).max(2000).describe('route pattern (/users/:id) or concrete request path (/users/42)'),
    depth,
    limit,
    detail,
  });
  server.registerTool(
    'trace_route',
    {
      title: 'Trace route',
      description: 'Match an explicit route (pattern or concrete request path, in Sails declaration order) and follow it through guarding policies, the action, helpers, services and model accesses. Blueprint and hook-injected routes are not considered; this is static reachability, not runtime execution order.',
      inputSchema: traceSchema,
      annotations: { readOnlyHint: true },
    },
    reading((a: z.infer<typeof traceSchema>) => q().traceRoute(a.method, a.path, a)),
  );

  const impactSchema = z.object({ symbolId, depth, limit, cursor, excludePaths: z.array(z.string().max(300)).max(20).optional(), detail });
  server.registerTool(
    'analyze_impact',
    {
      title: 'Impact analysis',
      description: 'Bounded reverse reachability: nodes that could be affected by changing the symbol (callers, routes, actions with their policies), each with distance and one shortest reason path. Candidates only, not a guarantee of regression.',
      inputSchema: impactSchema,
      annotations: { readOnlyHint: true },
    },
    reading((a: z.infer<typeof impactSchema>) => q().impact(a.symbolId, a)),
  );

  const unresolvedSchema = z.object({
    file: relPath.optional(),
    kind: z.string().max(50).optional().describe('reference kind: call, reference, model, populate, import, route_target, policy, association'),
    reason: z.string().max(100).optional().describe('reason (e.g. unknown_global, helper_not_found) or status (unresolved_dynamic, ambiguous, ...)'),
    groupBy: z.enum(['reason', 'file', 'key']).optional(),
    limit,
    cursor,
    detail,
  });
  server.registerTool(
    'get_unresolved',
    {
      title: 'Unresolved references',
      description: 'Unresolved, dynamic, ambiguous and unsupported references with evidence, plus counts of filtered external/Sails-plumbing references. These mark where the static graph is incomplete.',
      inputSchema: unresolvedSchema,
      annotations: { readOnlyHint: true },
    },
    reading((a: z.infer<typeof unresolvedSchema>) => q().unresolved(a)),
  );

  server.registerTool(
    'sync_index',
    {
      title: 'Sync index',
      description: 'Reconcile source changes into the graph now (incremental; force=true rebuilds everything). Writes only to the index storage directory. Returns the change summary.',
      inputSchema: z.object({ force: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (a: { force?: boolean }) => {
      try {
        const r = await ctx.coordinator.sync({ full: !!a.force });
        if (!r) throw new Error(ctx.coordinator.lastError ?? 'sync failed');
        return ok({ graph: q().graphMeta(), status: r.status, metrics: r.metrics, files: r.files, summary: r.summary, warnings: r.warnings });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_index_status',
    {
      title: 'Index status',
      description: 'Freshness, generation, pending parse errors, supported coverage, last sync change summary and watcher state.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        await ctx.coordinator.syncIfNeeded();
        return ok(q().indexStatus({ watcher: ctx.coordinator.watcher, lastSyncError: ctx.coordinator.lastError }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const symbolSchema = z.object({ symbolId, includeSnippet: z.boolean().optional().describe('include a bounded source snippet (with freshness caveat)'), limit, detail });
  server.registerTool(
    'get_symbol',
    {
      title: 'Symbol detail',
      description: 'Node attributes (helper inputs/exits, model attributes/associations, route metadata, guarding policies) and immediate incoming/outgoing edges, optionally with a bounded source snippet.',
      inputSchema: symbolSchema,
      annotations: { readOnlyHint: true },
    },
    reading((a: z.infer<typeof symbolSchema>) => q().getSymbol(a.symbolId, { includeSnippet: a.includeSnippet, limit: a.limit, detail: a.detail ?? 'full' })),
  );

  server.registerTool(
    'get_file_outline',
    {
      title: 'File outline',
      description: 'Entities and functions in one root-relative file with spans, IMPLEMENTED_BY owners, call counts, unresolved references and parse status.',
      inputSchema: z.object({ file: relPath, detail }),
      annotations: { readOnlyHint: true },
    },
    reading((a: { file: string }) => q().fileOutline(a.file)),
  );

  const routesSchema = z.object({ method: z.string().max(20).optional(), pathPrefix: z.string().max(1000).optional(), action: z.string().max(500).optional(), limit, cursor, detail });
  server.registerTool(
    'list_routes',
    {
      title: 'List routes',
      description: 'Explicit routes from config/routes.js in declaration order, with targets and guarding policies. Blueprint routes are not included.',
      inputSchema: routesSchema,
      annotations: { readOnlyHint: true },
    },
    reading((a: z.infer<typeof routesSchema>) => q().listRoutes(a)),
  );

  server.registerTool(
    'get_model_usage',
    {
      title: 'Model usage',
      description: 'Functions accessing a model grouped by operation (read, write, uses, native, populate), associations in both directions, and entry-point routes reaching each accessor.',
      inputSchema: z.object({ model: z.string().min(1).max(200).describe('model id (model:user), identity (user) or globalId (User)'), limit, detail }),
      annotations: { readOnlyHint: true },
    },
    reading((a: { model: string; limit?: number }) => q().modelUsage(a.model, a)),
  );

  const changesSchema = z.object({
    files: z.array(relPath).max(500).optional().describe('root-relative file paths'),
    gitDiff: z.boolean().optional().describe('use `git diff --name-only HEAD` plus untracked files'),
    depth,
    limit,
    cursor,
    detail,
  });
  server.registerTool(
    'analyze_changes',
    {
      title: 'Analyze changed files',
      description: 'Impact seeded from every node owned by the given files (or the git working-tree diff): affected entry-point routes/actions and the entity identities that would disappear if the files were deleted or renamed.',
      inputSchema: changesSchema,
      annotations: { readOnlyHint: true },
    },
    reading((a: z.infer<typeof changesSchema>) => q().analyzeChanges(a)),
  );

  const pathsSchema = z.object({ from: symbolId, to: symbolId, maxDepth: depth, limit: z.number().int().min(1).max(20).optional() });
  server.registerTool(
    'find_paths',
    {
      title: 'Find paths',
      description: 'Up to N shortest paths between two nodes over route, call, implementation and model relations (bounded).',
      inputSchema: pathsSchema,
      annotations: { readOnlyHint: true },
    },
    reading((a: z.infer<typeof pathsSchema>) => q().findPaths(a.from, a.to, { maxDepth: a.maxDepth, limit: a.limit })),
  );
}
