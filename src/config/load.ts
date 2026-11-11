import fs from 'node:fs';
import path from 'node:path';
import { configSchema, CONFIG_FILE_NAME, KNOWN_KEYS, type CodegraphConfig } from './schema.js';
import { UserInputError } from '../util/errors.js';
import { sha256 } from '../util/hash.js';

export interface LoadedConfig {
  config: CodegraphConfig;
  /** Absolute project root. */
  root: string;
  /** Absolute config path if a file was read. */
  configPath: string | null;
  warnings: string[];
  /** Stable hash of the effective config; a change forces a full re-index on sync. */
  hash: string;
  storageDir: string;
  dbPath: string;
}

/**
 * Load and validate the JSON config. Never executes JavaScript.
 * @param baseRoot candidate project root (already discovered)
 * @param explicitConfig optional --config path
 */
export function loadConfig(baseRoot: string, explicitConfig?: string): LoadedConfig {
  let configPath: string | null = null;
  let raw: unknown = {};
  if (explicitConfig) {
    configPath = path.resolve(explicitConfig);
    if (!fs.existsSync(configPath)) throw new UserInputError(`Config file not found: ${explicitConfig}`);
  } else {
    const candidate = path.join(baseRoot, CONFIG_FILE_NAME);
    if (fs.existsSync(candidate)) configPath = candidate;
  }
  if (configPath) {
    if (!configPath.endsWith('.json')) {
      throw new UserInputError('Config must be a .json file; JavaScript config files are never executed.');
    }
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new UserInputError(`Invalid JSON in config ${configPath}: ${(err as Error).message}`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new UserInputError(`Config ${configPath} must contain a JSON object.`);
    }
  }
  const warnings = unknownKeyWarnings(raw as Record<string, unknown>);
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new UserInputError(`Invalid configuration: ${issues}`);
  }
  const config = parsed.data;
  const overlap = config.resolution.extraModelReadMethods.filter((m) =>
    config.resolution.extraModelWriteMethods.includes(m),
  );
  if (overlap.length) {
    throw new UserInputError(
      `Invalid configuration: method(s) listed as both read and write: ${overlap.join(', ')}`,
    );
  }
  if (config.query.defaultDepth > config.query.maxDepth || config.query.defaultLimit > config.query.maxLimit) {
    throw new UserInputError('Invalid configuration: query defaults must not exceed maxima.');
  }
  const configDir = configPath ? path.dirname(configPath) : baseRoot;
  const root = path.resolve(configDir, config.root);
  for (const [label, value] of [
    ['storage.directory', config.storage.directory],
    ['storage.database', config.storage.database],
  ] as const) {
    if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
      throw new UserInputError(`Invalid configuration: ${label} must be a relative path inside the project root.`);
    }
  }
  if (config.storage.directory === '.' || config.storage.directory === '') {
    throw new UserInputError('Invalid configuration: storage.directory must be a dedicated sub-directory.');
  }
  if (config.storage.database.includes('/') || config.storage.database.includes('\\')) {
    throw new UserInputError('Invalid configuration: storage.database must be a file name.');
  }
  const storageDir = path.join(root, config.storage.directory);
  const dbPath = path.join(storageDir, config.storage.database);
  const hashInput = JSON.stringify({ ...config, $schema: undefined, mcp: undefined, query: undefined });
  return { config, root, configPath, warnings, hash: sha256(hashInput), storageDir, dbPath };
}

function unknownKeyWarnings(raw: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS[''].includes(key)) warnings.push(`Unknown config key "${key}" is ignored.`);
  }
  for (const section of Object.keys(KNOWN_KEYS)) {
    if (!section) continue;
    const value = raw[section];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!KNOWN_KEYS[section].includes(key)) warnings.push(`Unknown config key "${section}.${key}" is ignored.`);
      }
    }
  }
  return warnings;
}
