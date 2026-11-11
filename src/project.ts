import { discoverProjectRoot } from './discovery/project-root.js';
import { loadConfig, type LoadedConfig } from './config/load.js';
import { GraphIndexer } from './indexing/indexer.js';
import { QueryService } from './query/service.js';
import type { Logger } from './util/log.js';
import { silentLogger } from './util/log.js';

export interface ProjectOptions {
  root?: string;
  config?: string;
  cwd?: string;
  logger?: Logger;
}

export interface Project {
  root: string;
  loaded: LoadedConfig;
  indexer: GraphIndexer;
  queries: QueryService;
  close(): void;
}

/** Discover the project, load config, open (and migrate) the graph database. */
export function openProject(opts: ProjectOptions = {}): Project {
  const logger = opts.logger ?? silentLogger;
  const discovered = discoverProjectRoot(opts.root, opts.cwd);
  const loaded = loadConfig(discovered, opts.config);
  for (const w of loaded.warnings) logger.warn(w);
  const indexer = new GraphIndexer(loaded, { logger });
  const queries = new QueryService(indexer.db, loaded);
  return {
    root: loaded.root,
    loaded,
    indexer,
    queries,
    close: () => indexer.close(),
  };
}
