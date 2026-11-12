import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../helpers/util.mjs';

test('shipped JSON Schema matches the zod config schema (run `node scripts/gen-schema.mjs` to update)', async () => {
  const { buildSchema } = await import(path.join(repoRoot, 'scripts/gen-schema.mjs'));
  const shipped = JSON.parse(fs.readFileSync(path.join(repoRoot, 'sails-codegraph.config.schema.json'), 'utf8'));
  assert.deepEqual(shipped, buildSchema());
});
