// Regenerates sails-codegraph.config.schema.json from the zod config schema (run after `npm run build`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { configSchema } = await import(path.join(root, 'dist/config/schema.js'));

export function buildSchema() {
  const schema = z.toJSONSchema(configSchema, { io: 'input', target: 'draft-2020-12' });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'sails-codegraph configuration',
    description: 'Configuration for sails-codegraph (JSON only; never executed). Unknown keys produce warnings.',
    ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$schema')),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.join(root, 'sails-codegraph.config.schema.json');
  fs.writeFileSync(out, `${JSON.stringify(buildSchema(), null, 2)}\n`);
  console.log(`wrote ${out}`);
}
