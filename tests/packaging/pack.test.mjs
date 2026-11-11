import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { repoRoot, copyFixture } from '../helpers/util.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('T38 npm pack tarball installs into a fresh app; CLI and MCP work without the source checkout', { timeout: 300_000 }, async () => {
  const dry = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: repoRoot, encoding: 'utf8' }));
  const files = dry[0].files.map((f) => f.path);
  assert.ok(files.includes('dist/cli/main.js'));
  assert.ok(files.includes('sails-codegraph.config.schema.json'));
  assert.ok(files.includes('README.md'));
  assert.ok(!files.some((f) => f.startsWith('src/') || f.startsWith('tests/') || f.startsWith('node_modules/')), 'only compiled output, schema and docs are shipped');

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-pack-'));
  const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', outDir], { cwd: repoRoot, encoding: 'utf8' }));
  const tarball = path.join(outDir, packed[0].filename);
  const app = copyFixture('sails-app');
  const install = spawnSync(npm, ['install', '--save-dev', '--no-audit', '--no-fund', '--prefer-offline', tarball], { cwd: app, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const bin = (args) => spawnSync(npm, ['exec', '--no', '--', 'sails-codegraph', ...args], { cwd: app, encoding: 'utf8' });
  let r = bin(['index', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'current');
  r = bin(['sync', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).metrics.filesParsed, 0);
  r = bin(['query', 'callers', 'helper:payment/process', '--json']);
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).results.length > 0);

  // MCP startup from the installed package
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const installedCli = path.join(app, 'node_modules', 'sails-codegraph', 'dist', 'cli', 'main.js');
  const client = new Client({ name: 'pack-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [installedCli, 'mcp'], cwd: app, stderr: 'ignore' }));
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 14);
    const res = await client.callTool({ name: 'find_symbol', arguments: { query: 'helper:payment/process' } });
    assert.equal(JSON.parse(res.content[0].text).results[0].id, 'helper:payment/process');
  } finally {
    await client.close();
  }
});
