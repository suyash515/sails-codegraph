import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { openProject, type Project } from '../project.js';
import { SyncCoordinator } from '../indexing/coordinator.js';
import { startWatcher, type WatchHandle } from '../indexing/watcher.js';
import { createLogger, type Logger } from '../util/log.js';
import { PACKAGE_VERSION } from '../version.js';
import { registerTools } from './tools.js';

export interface McpOptions {
  root?: string;
  config?: string;
  watch?: boolean;
  verbose?: boolean;
}

export interface McpContext {
  project: Project;
  coordinator: SyncCoordinator;
  logger: Logger;
  maxResponseBytes: number;
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: 'sails-codegraph', version: PACKAGE_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Static code graph of a Sails.js app (controllers/actions, helpers, services, models, explicit routes, policies). ' +
        'Relationships are derived from source without executing it; they describe static structure, not observed runtime behavior. ' +
        'Every result reports graph.generation/status/scannedAt; treat status other than "current" as possibly stale.',
    },
  );
  registerTools(server, ctx);
  return server;
}

/** Start the stdio MCP server. stdout carries JSON-RPC only; all logs go to stderr. */
export async function runMcpServer(opts: McpOptions): Promise<void> {
  const logger = createLogger({ verbose: opts.verbose });
  const project = openProject({ root: opts.root, config: opts.config, logger });
  const coordinator = new SyncCoordinator(project.indexer, project.loaded.config.indexing.mcpScanIntervalMs, logger);
  // Startup reconciliation (initial index if none exists). Never rely on a watcher alone.
  const first = await coordinator.sync();
  if (first) logger.info(`graph ready: generation ${first.generation} (${first.status}), ${first.metrics.filesParsed} file(s) parsed at startup`);
  else logger.warn(`startup sync failed: ${coordinator.lastError}; serving last committed graph as stale`);

  let watch: WatchHandle | null = null;
  if (opts.watch || project.loaded.config.mcp.watch) watch = startWatcher(project.loaded, coordinator, logger);

  const ctx: McpContext = { project, coordinator, logger, maxResponseBytes: project.loaded.config.mcp.maxResponseBytes };
  const handle = serveStdio(() => createMcpServer(ctx), { onerror: (e) => logger.error(`mcp transport: ${e.message}`) });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await watch?.close();
      await handle.close();
    } finally {
      project.close();
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.stdin.once('end', () => void shutdown());
  process.stdin.once('close', () => void shutdown());
}
