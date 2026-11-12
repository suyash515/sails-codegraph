# Changelog

## 0.1.0 (unreleased)

Initial release.

- Static parsing of Sails.js 1.x CommonJS apps with the TypeScript compiler API; project code is never executed.
- Graph of FILE, MODULE, FUNCTION, ACTION, HELPER, MODEL, SERVICE, POLICY, ROUTE and PACKAGE nodes with evidence-backed edges.
- Actions2 and classic controllers (incl. nested), nested helpers with invocation-style metadata, services, models (operations, populate, native queries, associations, custom functions), explicit routes (all target forms, split route files, concrete-path matching), policies (precedence, order, matched rule), `config/globals.js`.
- Reference classification (project / external / Sails plumbing / unknown / dynamic) so `query unresolved` lists genuine gaps.
- SQLite storage with persisted raw references and a reverse key index; incremental `sync` that re-resolves unmodified callers on add/delete/rename; per-sync change summary; `sync --check`; optional watcher.
- CLI queries (symbol, callers, callees, route, routes, impact, unresolved, file, model-usage, path), JSON export, doctor.
- MCP stdio server (SDK v2) with 15 tools, freshness checks, response budget and structured errors.
