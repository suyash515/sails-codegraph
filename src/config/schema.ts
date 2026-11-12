import { z } from 'zod';

export const DEFAULT_INCLUDE = ['api/**/*.js', 'config/routes.js', 'config/policies.js', 'config/globals.js'];
export const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.tmp/**',
  '**/assets/**',
  '**/.sails-codegraph/**',
];

const relPath = z
  .string()
  .min(1)
  .refine((s) => !s.includes('\0'), 'must not contain NUL');

export const configSchema = z.object({
  $schema: z.string().optional(),
  root: z.string().default('.'),
  include: z.array(z.string().min(1)).default(DEFAULT_INCLUDE),
  exclude: z.array(z.string().min(1)).default(DEFAULT_EXCLUDE),
  storage: z
    .object({
      directory: relPath.default('.sails-codegraph'),
      database: relPath.default('graph.sqlite'),
    })
    .default({ directory: '.sails-codegraph', database: 'graph.sqlite' }),
  indexing: z
    .object({
      debounceMs: z.number().int().min(0).max(60_000).default(300),
      reconcileIntervalMs: z.number().int().min(1000).max(3_600_000).default(30_000),
      mcpScanIntervalMs: z.number().int().min(0).max(3_600_000).default(2000),
      maxFileBytes: z.number().int().min(1).max(100_000_000).default(2_000_000),
      followSymlinks: z.boolean().default(false),
    })
    .default({ debounceMs: 300, reconcileIntervalMs: 30_000, mcpScanIntervalMs: 2000, maxFileBytes: 2_000_000, followSymlinks: false }),
  resolution: z
    .object({
      framework: z.literal('sails').default('sails'),
      includeExplicitRoutes: z.boolean().default(true),
      includePolicies: z.boolean().default(true),
      includeModelAssociations: z.boolean().default(true),
      honorGlobalsConfig: z.boolean().default(true),
      followRouteFileRequires: z.boolean().default(true),
      extraModelReadMethods: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).default([]),
      extraModelWriteMethods: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).default([]),
      externalGlobals: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).default([]),
    })
    .default({
      framework: 'sails',
      includeExplicitRoutes: true,
      includePolicies: true,
      includeModelAssociations: true,
      honorGlobalsConfig: true,
      followRouteFileRequires: true,
      extraModelReadMethods: [],
      extraModelWriteMethods: [],
      externalGlobals: [],
    }),
  query: z
    .object({
      defaultDepth: z.number().int().min(1).max(20).default(2),
      maxDepth: z.number().int().min(1).max(20).default(5),
      defaultLimit: z.number().int().min(1).max(10_000).default(100),
      maxLimit: z.number().int().min(1).max(10_000).default(500),
    })
    .default({ defaultDepth: 2, maxDepth: 5, defaultLimit: 100, maxLimit: 500 }),
  mcp: z
    .object({
      watch: z.boolean().default(false),
      maxResponseBytes: z.number().int().min(1000).max(50_000_000).default(200_000),
    })
    .default({ watch: false, maxResponseBytes: 200_000 }),
});

export type CodegraphConfig = z.infer<typeof configSchema>;

/** Known keys per section, used to warn (not fail) on unknown keys. */
export const KNOWN_KEYS: Record<string, string[]> = {
  '': ['$schema', 'root', 'include', 'exclude', 'storage', 'indexing', 'resolution', 'query', 'mcp'],
  storage: ['directory', 'database'],
  indexing: ['debounceMs', 'reconcileIntervalMs', 'mcpScanIntervalMs', 'maxFileBytes', 'followSymlinks'],
  resolution: [
    'framework',
    'includeExplicitRoutes',
    'includePolicies',
    'includeModelAssociations',
    'honorGlobalsConfig',
    'followRouteFileRequires',
    'extraModelReadMethods',
    'extraModelWriteMethods',
    'externalGlobals',
  ],
  query: ['defaultDepth', 'maxDepth', 'defaultLimit', 'maxLimit'],
  mcp: ['watch', 'maxResponseBytes'],
};

export const CONFIG_FILE_NAME = 'sails-codegraph.config.json';

export function defaultConfigObject(): Record<string, unknown> {
  return {
    $schema: './node_modules/sails-codegraph/sails-codegraph.config.schema.json',
    root: '.',
    include: DEFAULT_INCLUDE,
    exclude: DEFAULT_EXCLUDE,
    storage: { directory: '.sails-codegraph', database: 'graph.sqlite' },
    indexing: { debounceMs: 300, reconcileIntervalMs: 30000, mcpScanIntervalMs: 2000, maxFileBytes: 2000000, followSymlinks: false },
    resolution: {
      framework: 'sails',
      includeExplicitRoutes: true,
      includePolicies: true,
      includeModelAssociations: true,
      honorGlobalsConfig: true,
      followRouteFileRequires: true,
      extraModelReadMethods: [],
      extraModelWriteMethods: [],
      externalGlobals: [],
    },
    query: { defaultDepth: 2, maxDepth: 5, defaultLimit: 100, maxLimit: 500 },
    mcp: { watch: false, maxResponseBytes: 200000 },
  };
}
