import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/** Package version; also the indexer version recorded in graph metadata. */
export const PACKAGE_VERSION: string = pkg.version;
export const INDEXER_VERSION: string = pkg.version;
