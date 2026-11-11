# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

v0.1.0 is implemented per `sails-codegraph-implementation-spec.md` (the source of truth; section numbers below point into it). See `docs/architecture.md` for how the implementation maps to the spec and `docs/implementation-report.md` for status and known limitations.

Commands (Node 22.13+):

```bash
npm install
npm run build          # tsc -> dist/ (tests run against dist/, so build before running tests directly)
npm run typecheck      # also used as `npm run lint`
npm test               # build + all unit and integration tests (node:test)
npm run test:unit      # unit tests only (needs a prior build)
npm run test:pack      # npm pack + install into a fresh fixture app (T38)
npm run schema         # regenerate sails-codegraph.config.schema.json after changing src/config/schema.ts
npm run bench          # synthetic benchmark (pass a file count: node scripts/bench.mjs 1400)
# single test file / single test:
node --test tests/integration/incremental.test.mjs
node --test --test-name-pattern="T23" tests/integration/incremental.test.mjs
```

Tests are plain ESM (`tests/**/*.test.mjs`) using `node:test` (vitest could not be installed due to an npm arborist bug in this environment). They import from `dist/`, copy fixtures from `tests/fixtures/` into temp dirs, and never mutate the fixtures. `tests/fixtures/expected/sails-app.edges.json` is the hand-validated ground truth for the main fixture; update it deliberately (after reviewing each relationship) when changing resolution behavior.

## What is being built

`sails-codegraph`: a single, standalone, local-first npm package (TypeScript, ESM recommended, Node 22.13+). It statically analyzes a Sails.js 1.x CommonJS app, persists a code graph in SQLite, and exposes it through a CLI (`sails-codegraph <cmd>`) and an MCP stdio server (`sails-codegraph mcp`). Planned stack (§2.2): TypeScript Compiler API for parsing, `better-sqlite3`, `chokidar`, `commander`, `zod`, `@modelcontextprotocol/server` v2 (not the legacy v1 package), `vitest` or the Node test runner, and `fast-glob`.

Implement in milestone order (§16), keeping a working, tested repository after each milestone. Deferred items (§1.4: web UI, blueprints, runtime tracing, TS loaders, and so on) must not become v0.1 prerequisites. Do not create a monorepo.

## Non-negotiable invariants (§1.3, §14, §17)

- **Never execute analyzed project code or config**: no `require`/`import()`/`eval`/`vm` on project files, and never lift Sails. The config file is JSON, never JS.
- **No invented edges.** Dynamic or ambiguous targets stay unresolved with a reason (`unresolved_missing`, `unresolved_dynamic`, `ambiguous`, `unsupported`, `parse_error`). Never resolve by matching only the last name segment.
- **Lexical bindings beat Sails globals**: a local `const User` shadows the `User` model (lookup priority in §9.2).
- **Evidence on everything**: each symbol and non-synthetic edge keeps its file plus 1-based line/column span, `resolution` (`static`/`sails_convention`/`inferred`), and `confidence`.
- **Deterministic output** (excluding timestamps and generation).
- **Never report the graph as `current`** if a changed file failed to parse or the scan didn't complete.
- **MCP stdout carries JSON-RPC only**; all logging goes to stderr.
- Writes are limited to `init`'s config file and the `.sails-codegraph/` storage dir. No network access or telemetry. Enforce path containment within the project root.

## Architecture (big picture)

Pipeline: **discover → parse to per-file IR → register → resolve → persist**.

- **Parser** (§7) produces a `ParsedFile` IR (symbols, entities, raw references, diagnostics) per file and never writes to the DB. Anonymous functions get stable lexical-owner names such as `module.exports.fn` or `module.exports.attributes.beforeCreate`; line numbers are never identity.
- **Sails resolvers** (§8) are simple functions per convention: actions2 and classic controllers, helpers (`api/helpers/user/find-by-email.js` ↔ `sails.helpers.user.findByEmail`; `.with`/`.exec` are invocation style, not targets), services, models (Waterline ops map to `READS_MODEL`/`WRITES_MODEL`/`USES_MODEL`, and chain modifiers like `.fetch()` are not calls), explicit routes, and policies.
- **Two-pass resolution** (§9): pass 1 registers all entities and lookup keys (`helper:payment/process`, `model:user`, `export:<file>#name`, …); pass 2 resolves references. This must work regardless of file order.
- **Raw references are persisted independently of edges** (§6.5, §9.3). This is the core design point for incremental correctness. A reverse index (lookup key → raw references) lets sync re-resolve **unmodified** callers when a target is added, deleted, or renamed, including previously unresolved references that a new target now matches or makes ambiguous. Deleting a target removes its edges but never the callers' raw references.
- **File-owned records vs. derived resolution edges** (§10.4): replacing a file drops its owned nodes, references, and structural edges, then rebuilds the derived edges for the affected keys only.
- **Incremental sync** (§10.2–10.3): enumerate and stat files, use SHA-256 to confirm changes (mtime alone isn't enough), parse outside the transaction, then commit one SQLite transaction that bumps the graph `generation`. A no-op sync must reparse zero files. A rename is delete + add. Use one logical writer with cross-process locking and bounded waits.
- **Freshness** (§10.6): the MCP server syncs at startup and calls `syncIfNeeded()` (coalesced, throttled by `mcpScanIntervalMs`) before queries. Every query result includes `graph.generation/status/scannedAt`. The watcher is an optimization only; periodic reconciliation is still required.
- **CLI and MCP share the same query and indexing services** (§12.1). They must not use separate logic.
- **Worktrees**: each root has its own `.sails-codegraph/graph.sqlite`. In a linked worktree, `.git` may be a file (§10.8).

Node and edge kinds, canonical ID formats, and the minimum SQL schema are in §6. Query traversal semantics (default depth 2/max 5, default limit 100/max 500, cycle-safe, `truncated` flag) are in §11. CLI exit codes are 0 ok, 1 operational error, 2 invalid input/config, and 3 `sync --check` stale (§4.1).

## Testing expectations

§15.2 defines required test cases T01–T38. They span unit, fixture-integration (mini Sails apps under `tests/fixtures/`), incremental tests (copy the fixture to a temp dir, mutate it, and assert **reparse counts** and graph diffs), CLI tests against the built binary, MCP tests over a spawned stdio server, and an `npm pack` tarball smoke test. Supported fixture patterns must match expected output exactly. When Sails behavior is ambiguous, write a fixture encoding it before writing the resolver.
