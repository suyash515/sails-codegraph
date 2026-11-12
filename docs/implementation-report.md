# Implementation report (v0.1.0)

## Features completed

All milestones of Section 16 are implemented in a single npm package (TypeScript, ESM, Node 22.13+):

- **M1** scaffold, root discovery, JSON config (+ shipped JSON Schema), safe enumeration (excludes, symlinks off, size limit), TypeScript-API parser for all Section 7.3 function shapes, SQLite schema, `index`/`stats`/`doctor`/`export`.
- **M2** Sails identity derivation (6.3.1), actions2/function/classic (nested) controllers, helpers with invocation style + modifiers + input/exit contracts, services (global, require, destructured, shorthand exports, re-exports, `this.` siblings), models (read/write/uses, custom functions, populate, native queries, associations), all route target forms incl. split route files, policy precedence/order/matchedRule/blocked/unguarded, `config/globals.js`, reference classification (7.5), REFERENCES and PACKAGE nodes, collision diagnostics.
- **M3** SHA-256 manifest, add/edit/delete/rename, reverse key index re-resolution of unmodified callers, atomic generations, parse-error stale policy (keep last good, report `stale`), `sync --check` (exit 3, read-only), watcher with debounce + periodic reconciliation, per-sync change summary, cross-process write lock.
- **M4** MCP SDK v2 stdio server with 15 tools (incl. optional `find_paths`), query-time freshness, response budget + cursors, structured errors with hints, `mcp --watch`, worktree separation, README for Claude Code and Codex, packaging smoke test, CI matrix (Linux/macOS/Windows × Node 22/24).

Not implemented (optional / cut per Section 17): RESPONSE nodes, call-site input mismatch warnings, lifecycle-hook triggering edges.

## Tests run

`npm test`: 97 unit + integration tests, all passing; `npm run test:pack`: passing. Coverage of the required matrix:

| IDs | Where |
|---|---|
| T01–T04, T15, T39 (parser level) | `tests/unit/parser.test.mjs` |
| T05–T20, T36, T39–T46, T49, T50 (static), T52, T54, T55, T21 | `tests/integration/fixture.test.mjs` |
| T47, T48, T53 | `tests/integration/collisions-globals.test.mjs` |
| §13 worked example, T22–T28, T30, T31, T50, T58 | `tests/integration/incremental.test.mjs` |
| T33, T34, T35, T44, T51, T56, T57 | `tests/integration/queries.test.mjs` |
| CLI exit codes / JSON shapes | `tests/integration/cli.test.mjs` |
| T37, T57 over MCP | `tests/integration/mcp.test.mjs` |
| T29, T32, concurrent writers | `tests/integration/watch-worktree.test.mjs` |
| T38 | `tests/packaging/pack.test.mjs` |

Ground truth (15.3): `tests/fixtures/expected/sails-app.edges.json` lists 68 hand-validated relationships across actions2, classic controllers, helpers, services, models, routes and policies. Measured precision 1.0 and recall 1.0; the fixture's 4 unresolved references (typo global, dynamic helper name, missing route action, missing policy) are all surfaced. An additional test asserts that an incremental sequence of edits yields exactly the same graph as a fresh full index.

## Performance sample

`node scripts/bench.mjs 1400` (synthetic app; Linux x64, 4 vCPU Xeon 2.1 GHz, Node 22.23):

| Metric | Value |
|---|---|
| Indexed files | 1,103 |
| Nodes / edges / raw references | 4,658 / 6,855 / 2,350 |
| Full index | 653 ms |
| No-op sync | 18 ms, 0 files parsed |
| Single-file edit | 17 ms, 1 file parsed, 1 reference re-resolved |
| Callers query (depth 2) | 2 ms |
| RSS / DB size | 189 MB / 11 MB |

These are indicative, not guarantees.

## Known limitations

See the README "Limitations" section. Notable design choices: calls inside inline callbacks are attributed to the enclosing named function; `IMPLEMENTED_BY` hops do not consume traversal depth; a sync that changes nothing keeps the same generation (so pagination cursors stay valid); colliding canonical entity IDs from two files are stored as `<id>@<file>` with a `NODE_ID_CONFLICT` diagnostic.

## Deferred / not yet done

- Milestone 5 validation against a real, non-fixture Sails application has not been performed in this environment; precision/recall on real projects is not yet measured.
- Sails loader behaviors registered with low confidence pending fixture confirmation against the real loaders: services and models in sub-directories.
- Windows/macOS were not exercised locally; CI is configured for them.
- Deferred by the spec: web UI, blueprints, runtime tracing, TypeScript Sails apps, historical snapshots.
