# Sails CodeGraph: Implementation Specification

**Status:** Implementation-ready specification  
**Working npm package name:** `sails-codegraph` (verify npm availability before publishing)  
**Working CLI binary:** `sails-codegraph`  
**Target release:** v0.1.0  
**Updated:** 2026-11-11  
**Revision:** 2 — functional improvements; see Section 20 for the change log  
**Primary audience:** An autonomous coding agent implementing the package, plus human reviewers

> **Implementation instruction:** Build a working, tested standalone npm package according to this document. Prioritize correctness, maintainability, and a usable end-to-end vertical slice over extra features. Where a minor detail is unspecified, make a conventional choice, document it, and proceed. Do not turn deferred functionality into a prerequisite for the first release.

---

## 1. Product definition

### 1.1 Summary

Sails CodeGraph is a **standalone, local-first npm package** that statically analyzes an existing Sails.js application, builds a persistent and queryable graph of application components and code relationships, and exposes that graph through a command-line interface (CLI) and an MCP server for coding agents such as Claude Code and Codex.

Unlike generic JavaScript code-graph utilities, it recognizes Sails.js conventions including actions2 controllers, classic controllers, nested helpers, model globals, services, explicit routes, and selected policies. It must recognize anonymous functions such as `module.exports.fn` rather than omitting them.

The graph is **incrementally maintained**. When source files are created, modified, deleted, or renamed, affected nodes and relationships are updated without a complete reparse of unchanged files. The tool also catches changes that occurred while no watcher was running.

Sails CodeGraph must have **no runtime, API, licensing, or operational dependency on CodeAura or any other commercial platform**.

### 1.2 Primary user stories

1. As a developer, I can run `npm install --save-dev sails-codegraph` in a Sails.js repository and create a graph with one command.
2. As a developer, I can locate a controller, helper, model, service, function, or route and inspect incoming and outgoing relationships.
3. As a developer, I can change a single file and update the graph without re-indexing every file.
4. As a developer, I can rename or delete a helper and see previously resolved references become unresolved, even when their callers have not changed.
5. As a coding agent, I can call MCP tools to find symbols, follow calls, trace routes, and inspect potential change impact.
6. As a coding agent, I receive explicit warnings when relationships are unresolved, the graph is stale, or results are truncated.
7. As a developer working in parallel Git worktrees, each worktree can have its own accurate graph of its checked-out code and uncommitted edits.
8. As a maintainer, I can use the tool without bootstrapping Sails, starting an application server, connecting to a database, or providing credentials.

### 1.3 Design principles / invariants

- **Static and side-effect-free:** Never `require()`, dynamically `import()`, `eval()`, or execute analyzed project code, configuration files, or plugins. Never call `sails.lift()` or connect to the application's services.
- **No invented edges:** A relationship requiring dynamic information must remain unresolved or explicitly marked as an inference, not silently treated as certain.
- **Evidence-backed:** Every extracted symbol and non-synthetic relationship must retain the responsible file and source location.
- **Deterministic:** Given the same files, configuration, and indexer version, graph contents and exported ordering must be reproducible (excluding timestamps).
- **Incremental by construction:** Raw references must be persisted independently of successfully resolved edges; otherwise target deletion/renaming cannot be handled correctly.
- **Agent-friendly:** MCP outputs must be bounded, navigable, JSON-structured, and clear about uncertainty.
- **Local by default:** No network calls, telemetry, remote index service, or cloud storage.
- **Read-only toward the target:** The only project modifications allowed are explicit config creation by `init` and index files within the configured storage directory.
- **Single npm package initially:** Do not create a monorepo or multiple publishable packages for v0.1.

### 1.4 Scope of v0.1.0

**Required:**

- CommonJS JavaScript Sails.js applications, especially Sails 1.x conventions.
- Source discovery for `api/controllers`, `api/helpers`, `api/services`, `api/models`, `api/policies`, `config/routes.js`, and `config/policies.js`.
- Explicit route-to-action mapping where statically knowable.
- Both actions2 and classic controller functions.
- Generic JavaScript named and anonymous function extraction.
- Statically resolvable calls between local functions, modules, Sails helpers, services, and models.
- Basic model associations and model access operations.
- Configured policy mappings for statically understood patterns.
- Persistent local SQLite graph, source locations, unresolved references, and diagnostics.
- Full index, incremental sync, optional watcher, CLI queries, JSON export, and MCP stdio server.
- Separation by Git worktree and automatic startup/sync recovery.
- Tests, sample fixtures, documentation, and npm packaging.
- Reference classification that separates real project gaps from external packages, built-ins, and Sails plumbing, so `get_unresolved` stays actionable (Section 7.5).
- Common real-world shapes: destructured requires, shorthand exports, `this.` sibling calls in services, routes split across required files, nested classic controllers, and `config/globals.js` (Sections 7.4, 8.2, 8.6, 8.9).
- Agent-oriented queries: file outline, symbol detail, route listing with concrete-path matching, model usage, and changed-files impact (Section 11.4).

**Explicitly deferred, and not blockers for v0.1:**

- Web UI / interactive graphical visualization.
- Runtime instrumentation, HTTP tracing, and Sails application bootstrap.
- Full control-flow graph, full interprocedural data-flow, taint analysis, complete type inference, and dynamic dispatch resolution.
- Automatically reconstructing all blueprint routes or merged runtime configuration.
- Complete support for nonstandard Sails loaders, custom hooks that mutate routes at runtime, generated source, or arbitrary configuration functions.
- Historical per-commit graph snapshots and a cross-commit diff UI.
- Remote MCP transport, remote indexing, external vector database, AI inference, embeddings, hosted API, or telemetry.
- Full TypeScript Sails-loader support and non-JavaScript transpiler ecosystems. The parser may understand TS syntax internally, but this is not an acceptance requirement.

### 1.5 Terminology

- **Entity:** Framework-level object such as a helper, controller action, model, service, or route.
- **Symbol:** Concrete source-code construct such as an anonymous function assigned to `fn`, a method, or a local function.
- **Reference:** Source expression that may refer to an entity/symbol. References persist even when unresolved.
- **Edge:** Resolved (or explicitly inferred) relationship between graph nodes, derived from a reference or a known structural rule.
- **Resolution key:** Canonical lookup key used to match references with discovered targets.
- **Index generation:** Monotonically increasing number assigned to a committed graph update batch.
- **Freshness:** Whether source changes have been reconciled as of a documented scan time.

---

## 2. Supported environment and dependencies

### 2.1 Runtime

- Node.js: **22.13+**, with CI coverage on currently supported LTS lines where possible (at least Node 22 and 24).
- Platforms: Linux, macOS, and Windows.
- Package implementation: TypeScript, compiled for Node.js. Choose one module format (ESM recommended) and test the published CLI, not only direct `tsx` execution.
- Project input: `.js` CommonJS Sails application source; recognize ESM imports/exports in generic analysis where straightforward, but prioritize CommonJS Sails patterns.

### 2.2 Dependency recommendations

| Responsibility | Recommended choice | Notes |
|---|---|---|
| JavaScript AST and source positions | TypeScript Compiler API (`typescript`) | Parse JS without running it; preserve UTF-16 offsets and line/column mappings. |
| Graph persistence | SQLite via `better-sqlite3` | Pin a compatible version; verify native binary installation on supported platforms. Hide behind a small adapter to permit replacement. |
| File monitoring | `chokidar` | Watcher is an optimization, not the only freshness mechanism. |
| CLI | `commander` or equivalent | Human output and `--json` machine output. |
| MCP server | **`@modelcontextprotocol/server` v2**, stdio | Current official split-package SDK; do not start new work using the legacy v1 package by default. |
| Schema validation | `zod` | Validate config and tool inputs. |
| Testing | `vitest` or Node test runner | Unit + fixture + CLI + MCP integration tests. |
| Globbing | `fast-glob` or equivalent | Deterministic file enumeration. |

All versions must be locked via a committed lockfile. Avoid installing a graph database server. If `better-sqlite3` native builds prove too fragile, document and implement a different SQLite adapter **without changing the graph/query contract**. Do not introduce a second storage backend in v0.1 solely as an abstraction exercise.

### 2.3 External conventions used by this specification

- Sails helpers conventionally export a dictionary with `fn`, and `api/helpers/user/find-by-email.js` is addressed as `sails.helpers.user.findByEmail`.
- Actions2 are usually stand-alone action files with `fn`; classic controllers can export functions from named properties.
- Sails explicit routes are defined via `config/routes.js` and can refer to `user/create` or `UserController.create`.
- Sails policies map actions/controllers in `config/policies.js` and may use wildcard/default rules.
- The official MCP TypeScript SDK v2 publishes `@modelcontextprotocol/server` for implementing servers.

The source links supporting these conventions appear in **Section 19**. Do not hardcode assumptions unsupported by test fixtures; where the framework allows customization, represent uncertainty.

---

## 3. Expected developer experience

### 3.1 Install

```bash
cd /path/to/sails-project
npm install --save-dev sails-codegraph
npx sails-codegraph init
npx sails-codegraph index
npx sails-codegraph stats
```

The package must be usable without a global installation, container, background service, or network account. Running `index` without `init` should use sensible defaults and should not require creating a config file.

### 3.2 Incremental updates

```bash
npx sails-codegraph sync            # reconcile changes since last successful scan
npx sails-codegraph watch           # optional long-running file watcher
npx sails-codegraph sync --check    # check if graph is current; do not change it
```

`sync` must work reliably after the CLI or MCP process was stopped. `watch` must handle add/change/unlink events and periodically reconcile missed events.

### 3.3 Queries

```bash
npx sails-codegraph query symbol 'helper:payment/process'
npx sails-codegraph query callers 'helper:payment/process' --depth 2 --json
npx sails-codegraph query callees 'action:payment/create' --depth 2 --json
npx sails-codegraph query route 'POST /api/payments' --json
npx sails-codegraph query impact 'helper:payment/process' --depth 3 --json
npx sails-codegraph query unresolved --json
npx sails-codegraph query unresolved --group-by reason --json
npx sails-codegraph query file api/controllers/payment/create.js --json
npx sails-codegraph query routes --method POST --prefix /api --json
npx sails-codegraph query route 'POST /api/payments/42' --json   # concrete path matched against route patterns
npx sails-codegraph query model-usage 'model:payment' --json
npx sails-codegraph query impact --files api/helpers/payment/process.js --depth 3 --json
npx sails-codegraph export --format json --output graph.json
npx sails-codegraph doctor
```

These command shapes are the required public interface unless there is a documented, strongly justified change.

### 3.4 MCP server

```bash
npx sails-codegraph mcp --root /absolute/path/to/sails-project
```

The same npm package runs the MCP server. This command must not start an HTTP listener. It communicates over stdio and uses **stdout exclusively for JSON-RPC messages**; diagnostics go to stderr or the configured log sink.

### 3.5 Project-scoped Claude Code example

From a Sails project root, after installing the dev dependency:

```bash
claude mcp add --scope project --transport stdio sails-codegraph -- npx --no-install sails-codegraph mcp
```

This is intended to produce a `.mcp.json` equivalent to:

```json
{
  "mcpServers": {
    "sails-codegraph": {
      "type": "stdio",
      "command": "npx",
      "args": ["--no-install", "sails-codegraph", "mcp"]
    }
  }
}
```

For an agent launched in the project root, the root can be discovered. For an agent launched elsewhere, use the explicit `--root /absolute/path/...` argument. Document that MCP server configurations should be trusted before enabling them.

Include Codex CLI instructions in the README using the currently documented project-scoped MCP configuration format for Codex. Verify the syntax at implementation time rather than assuming it is identical to Claude Code's `.mcp.json`.

---

## 4. CLI and configuration contract

### 4.1 Commands

| Command | Required behavior |
|---|---|
| `init` | Create `sails-codegraph.config.json` if absent; do not overwrite unless `--force`. |
| `index` | Full discovery, parsing, resolution and graph replacement as one consistent generation. |
| `sync` | Reconcile adds, edits, deletes and renames using persisted metadata. |
| `sync --check` | Exit nonzero if changed files, known stale state, or dirty diagnostics; never mutate DB. |
| `watch` | Initial sync, then watch and incrementally update until terminated. |
| `stats` | Return entity/edge counts, resolution breakdown, latest scan status and pending diagnostics. |
| `query symbol` | Lookup by canonical ID or fuzzy name; return disambiguation on multiple matches. |
| `query callers` / `callees` | Bounded graph traversal with source evidence. |
| `query route` | Trace explicit route through policies, actions, helpers, services and model accesses. Accepts a route key or a concrete request path (Section 8.6). |
| `query impact` | Reverse-reachability candidates, not a guarantee of regression. `--files <paths...>` seeds from all nodes owned by those files. |
| `query unresolved` | List unresolved references and their evidence; `--group-by reason\|file\|key`. |
| `query file <path>` | Outline of entities/functions in one file with spans, edge counts and unresolved references. |
| `query routes` | List explicit routes in declaration order; filter by `--method`, `--prefix`, `--action`. |
| `query model-usage <model>` | Accessors of a model grouped by operation, plus associations. |
| `query path <from> <to>` | *Optional:* bounded shortest path(s) between two nodes. |
| `export` | Deterministic JSON graph export; no image or visualizer required. |
| `doctor` | Validate project detection, config, file permissions, DB schema, MCP prerequisites. |
| `mcp` | Start stdio MCP server; query operations perform freshness checks. `--watch` optionally runs the embedded watcher (Section 10.5). |

Shared options: `--root <path>`, `--config <file>`, `--json`, `--verbose`, `--no-color` where applicable. Unknown options are errors. Queries support `--depth`, `--limit`, `--offset`/cursor where meaningful.

Exit codes:

- `0`: successful operation / `sync --check` is current.
- `1`: operational or indexing error.
- `2`: invalid user input or configuration.
- `3`: `sync --check` found differences or stale state.

Do not leak stack traces to normal stdout; enable detailed traces with `--verbose` and stderr.

### 4.2 Root discovery

Priority:

1. Explicit `--root`.
2. `SAILS_CODEGRAPH_ROOT` environment variable.
3. Walk upward from `process.cwd()` until a plausible project root (`package.json` plus `api/`, or `api/controllers` plus `config/`).
4. Otherwise report an actionable error; do not silently analyze the wrong directory.

All internal paths are normalized as forward-slash, root-relative paths. Real filesystem access must use safely joined absolute paths.

### 4.3 Configuration schema

Default config file: `sails-codegraph.config.json`. **The config is JSON and must not be executed as JavaScript.**

```json
{
  "root": ".",
  "include": ["api/**/*.js", "config/routes.js", "config/policies.js", "config/globals.js"],
  "exclude": [
    "**/node_modules/**",
    "**/.git/**",
    "**/.tmp/**",
    "**/assets/**",
    "**/.sails-codegraph/**"
  ],
  "storage": {
    "directory": ".sails-codegraph",
    "database": "graph.sqlite"
  },
  "indexing": {
    "debounceMs": 300,
    "reconcileIntervalMs": 30000,
    "mcpScanIntervalMs": 2000,
    "maxFileBytes": 2000000,
    "followSymlinks": false
  },
  "resolution": {
    "framework": "sails",
    "includeExplicitRoutes": true,
    "includePolicies": true,
    "includeModelAssociations": true,
    "honorGlobalsConfig": true,
    "followRouteFileRequires": true,
    "extraModelReadMethods": [],
    "extraModelWriteMethods": [],
    "externalGlobals": []
  },
  "query": {
    "defaultDepth": 2,
    "maxDepth": 5,
    "defaultLimit": 100,
    "maxLimit": 500
  },
  "mcp": {
    "watch": false,
    "maxResponseBytes": 200000
  }
}
```

The package should ship its JSON Schema in the npm tarball. An optional `$schema` property may reference that schema through a real published URL or local package path; do not invent a placeholder URL.

Validation rules:

- Unknown config keys: warning (not silent); invalid types and dangerous paths: error.
- `root` is relative to the config file location when not absolute.
- Exclusion patterns apply consistently to initial enumeration, sync, and watch.
- Storage directory must not be re-indexed.
- `maxFileBytes` over-limit files become explicit skipped-file diagnostics.
- Ignore symlinks by default; if following is enabled later, enforce root containment and cycle protection.
- The package should add `.sails-codegraph/` to `.gitignore` only when explicitly requested by `init --update-gitignore`; otherwise print a recommendation.
- `extraModelReadMethods` / `extraModelWriteMethods` extend the built-in lists in Section 8.5 and never replace them. Listing a method in both is a config error.
- `externalGlobals` lists extra free identifiers (for example `moment` exposed by a custom hook) that are classified as `external` rather than `unresolved_missing` (Section 7.5).
- `mcp.maxResponseBytes` caps serialized tool output (Section 12.2).

### 4.4 State files

Default storage:

```text
<project-root>/.sails-codegraph/
  graph.sqlite
  graph.sqlite-wal      # may be created by SQLite
  graph.sqlite-shm      # may be created by SQLite
  logs/                 # optional
```

Do not write per-file metadata into each analyzed directory. The SQLite database is the source of truth.

---

## 5. Package layout

A recommended starting structure:

```text
sails-codegraph/
├── src/
│   ├── cli/
│   │   ├── main.ts
│   │   └── commands/
│   ├── config/
│   │   ├── load.ts
│   │   └── schema.ts
│   ├── discovery/
│   │   ├── project-root.ts
│   │   └── enumerate-files.ts
│   ├── parser/
│   │   ├── parse-file.ts
│   │   ├── symbols.ts
│   │   ├── expressions.ts
│   │   └── references.ts
│   ├── resolvers/
│   │   ├── javascript.ts
│   │   ├── sails-controllers.ts
│   │   ├── sails-helpers.ts
│   │   ├── sails-models.ts
│   │   ├── sails-services.ts
│   │   ├── sails-routes.ts
│   │   └── sails-policies.ts
│   ├── graph/
│   │   ├── schema.ts
│   │   ├── identities.ts
│   │   ├── graph-builder.ts
│   │   ├── resolver-registry.ts
│   │   └── queries.ts
│   ├── indexing/
│   │   ├── full-index.ts
│   │   ├── incremental-sync.ts
│   │   ├── watcher.ts
│   │   └── coordinator.ts
│   ├── storage/
│   │   ├── sqlite.ts
│   │   └── migrations.ts
│   ├── mcp/
│   │   ├── server.ts
│   │   └── tools.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── sails-actions2/
│   │   ├── sails-classic/
│   │   ├── sails-nested-helpers/
│   │   ├── sails-config/
│   │   └── incremental/
│   ├── unit/
│   ├── integration/
│   └── packaging/
├── docs/
├── package.json
├── tsconfig.json
├── README.md
├── CHANGELOG.md
├── LICENSE
└── sails-codegraph.config.schema.json
```

Do not over-abstract: resolvers can remain simple functions and are not required to become third-party plugins in v0.1. Keep the core parser and graph model framework-neutral enough for future extensions.

---

## 6. Graph data model

### 6.1 Node kinds

| Kind | Example canonical ID | Meaning |
|---|---|---|
| `FILE` | `file:api/helpers/payment/process.js` | Indexed source file. |
| `ROUTE` | `route:POST /api/payments` | Explicit HTTP route (include host/variants in metadata if needed). |
| `ACTION` | `action:payment/create` | Sails controller action identity. |
| `HELPER` | `helper:payment/process` | Sails helper identity derived from the relative helper file path. |
| `MODEL` | `model:user` | Canonical Sails model identity. |
| `SERVICE` | `service:PaymentService` | Conventionally loaded Sails service. |
| `POLICY` | `policy:isLoggedIn` | Policy from `api/policies`. |
| `FUNCTION` | `function:api/helpers/payment/process.js::module.exports.fn` | Concrete named or anonymous function. |
| `MODULE` | `module:api/services/PaymentService.js` | File module for generic import/export analysis. |
| `PACKAGE` | `package:stripe`, `package:node:fs` | External npm package or Node built-in referenced by `require`/`import`. Synthetic and created only when referenced; evidence lives on its `IMPORTS` edges. Lets impact answer "who uses stripe?". |
| `RESPONSE` | `response:notFound` | *Optional for v0.1.* Custom response from `api/responses`. |
| `UNRESOLVED_TARGET` | Not required | Prefer persistent unresolved references over synthetic target nodes. |

The exact ID grammar is internal but should be stable and documented. The examples above are the recommended public representation.

### 6.2 Edge kinds

| Kind | Source → Target | Notes |
|---|---|---|
| `CONTAINS` | FILE → FUNCTION / entity | File ownership. |
| `IMPLEMENTED_BY` | ACTION / HELPER / POLICY / SERVICE → FUNCTION | Framework entity implementation. |
| `ROUTES_TO` | ROUTE → ACTION / FUNCTION | Explicit config mapping. FUNCTION is used only for inline route handlers (Section 8.6). |
| `CALLS` | FUNCTION → FUNCTION / HELPER / SERVICE / ACTION | Direct call or resolved Sails invocation. |
| `READS_MODEL` | FUNCTION → MODEL | E.g., `User.findOne`, `User.find`. |
| `WRITES_MODEL` | FUNCTION → MODEL | E.g., `User.create`, `User.update`, `User.destroy`. |
| `USES_MODEL` | FUNCTION → MODEL | Access known but not classifiable as read/write. |
| `ASSOCIATES_WITH` | MODEL → MODEL | Waterline `model` / `collection` / `through` association. |
| `GUARDED_BY` | ACTION → POLICY | Statically resolved configuration. |
| `IMPORTS` | MODULE / FILE → MODULE / FILE / PACKAGE | Resolved file/module/package dependency. |
| `REFERENCES` | FUNCTION → FUNCTION / HELPER / SERVICE | A function passed or stored as a value without being called at that site, e.g. `items.map(formatUser)` or `{ handler: validate }`. It is not an executable call, so callers/callees exclude it by default; impact analysis includes it. |

Do not present a model method call as a direct call to the model's source definition of `findOne`; it is a Waterline runtime operation. Use the model-operation edge and retain `operation` metadata.

### 6.3 Source identity rules

- Framework entities use their canonical Sails identity and stay stable across implementation edits that do not change their exposed name.
- Named functions use root-relative file path + lexical qualified symbol path.
- Anonymous exported/property-assigned functions get **synthetic, stable names based on lexical ownership** such as `module.exports.fn`, `module.exports.create`, `module.exports.attributes.beforeCreate`.
- For anonymous functions without a stable property owner, use a deterministic lexical owner plus ordinal/AST path; document that such an ID may change if neighboring anonymous functions are inserted.
- Do not use a line number alone as identity.
- Renaming a helper file deliberately changes its framework entity identity. Treat it as old identity removed/new identity added in v0.1.
- Track source span separately (start/end line, column, offsets) so an agent can open code precisely.

#### 6.3.1 Framework identity derivation

| Entity | Source | Canonical ID | Lookup keys registered |
|---|---|---|---|
| Helper | `api/helpers/user/find-by-email.js` | `helper:user/find-by-email` | `helper-access:user.findByEmail`. Each path segment is camelCased with lodash `_.camelCase` semantics, as Sails does. |
| Standalone action | `api/controllers/user/view-profile.js` | `action:user/view-profile` | `action:user/view-profile` (lower-cased for matching) |
| Classic action | `api/controllers/admin/UserController.js` → `create` | `action:admin/user/create` | `action:admin/user/create`, `action-alias:admin/UserController.create` |
| Model | `api/models/User.js` | `model:user` | `model:user`, `model-global:User`. A literal `identity`/`globalId` property in the model file overrides these. |
| Service | `api/services/PaymentService.js` | `service:PaymentService` | `service-global:PaymentService` |
| Policy | `api/policies/isLoggedIn.js` | `policy:isLoggedIn` | `policy:isloggedin` (lower-cased for matching) |

Notes:

- Helper canonical IDs are based on the file path, which keeps them readable and stable. References match by the camelCased access key. If two files in one folder map to the same access key (`find-by-email.js` and `findByEmail.js`), that key is `ambiguous` and the indexer emits a `HELPER_NAME_COLLISION` diagnostic.
- Lookup keys for case-insensitive identities are stored lower-cased; canonical IDs keep the spelling derived from the file.
- Pin each of these behaviors with a fixture checked against the Sails 1.x loaders before a resolver relies on it: action and policy case-insensitivity, nested-folder naming, and how services in subdirectories load. Where loader behavior is unverified, register the entity with `confidence: low` and a diagnostic instead of guessing.

### 6.4 Resolution status

Every resolved relationship must include:

- `resolution`: `static`, `sails_convention`, or `inferred`.
- `confidence`: `high`, `medium`, or `low`.
- `evidence`: file, start/end positions, source expression, and optional resolver identifier.

For unresolved references, store `status = 'unresolved'`, source expression, candidate lookup keys, and reason. Avoid artificial precision (e.g., unsupported probability percentages).

Examples:

- Direct same-file function call with lexical binding: `static`, `high`.
- `sails.helpers.payment.process.with(...)` matched to a unique helper file: `sails_convention`, `high`.
- Global `User.findOne()` when a `User` model and a shadowing local variable both exist: do **not** resolve to the Sails model; follow lexical bindings and mark unresolved/ambiguous if necessary.
- Computed `sails.helpers[name]`: unresolved dynamic reference unless statically evaluable to a string literal.

### 6.5 Persisted tables (minimum logical schema)

An implementation may adapt SQL column naming, but must preserve these logical records:

```sql
CREATE TABLE index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE files (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  parsed_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  file_path TEXT,
  start_line INTEGER,
  start_col INTEGER,
  end_line INTEGER,
  end_col INTEGER,
  attributes_json TEXT NOT NULL
);

CREATE TABLE raw_references (
  id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_node_id TEXT,
  ref_kind TEXT NOT NULL,
  expression TEXT NOT NULL,
  lookup_key TEXT,
  lookup_context_json TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  resolution_status TEXT NOT NULL,
  unresolved_reason TEXT
);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin_reference_id TEXT,
  resolution TEXT NOT NULL,
  confidence TEXT NOT NULL,
  attributes_json TEXT NOT NULL
);

CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  file_path TEXT,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  start_line INTEGER,
  start_col INTEGER
);

-- Reverse index: every lookup key a reference may match (primary key plus aliases/candidates)
CREATE TABLE reference_keys (
  reference_id TEXT NOT NULL,
  lookup_key TEXT NOT NULL,
  PRIMARY KEY (lookup_key, reference_id)
);

-- Forward registry: which nodes currently answer a lookup key, and which file owns the registration
CREATE TABLE registry_keys (
  lookup_key TEXT NOT NULL,
  node_id TEXT NOT NULL,
  owner_file TEXT NOT NULL,
  PRIMARY KEY (lookup_key, node_id)
);

-- Non-call file dependencies, e.g. config/routes.js depends on config/routes/admin.js
CREATE TABLE file_dependencies (
  dependent_file TEXT NOT NULL,
  dependency_file TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (dependent_file, dependency_file, kind)
);
```

`raw_references.lookup_key` holds the primary key for convenience. The complete set lives in `reference_keys`. A key is ambiguous when `registry_keys` maps it to more than one node. With this layout, the "affected keys → references to re-resolve" step in Section 10.3 is a single indexed join, not a JSON scan.

Additional columns/tables needed for consistent transactions, schema versioning, and ownership are allowed. Important indexes include:

- `nodes(kind, name)`, `nodes(file_path)`.
- `edges(source_id, kind)` and `edges(target_id, kind)`.
- `raw_references(source_file)`, `raw_references(lookup_key)`, `raw_references(source_node_id)`.
- `diagnostics(file_path)`.
- `reference_keys(reference_id)`, `registry_keys(owner_file)`, `file_dependencies(dependency_file)`.

**Critical:** `raw_references` must survive a target's deletion if the referencing source file still exists. Edges referencing deleted targets must be removed; the raw reference becomes unresolved. Implement referential integrity deliberately rather than relying on accidental cascades.

### 6.6 Graph generation metadata

Persist at least:

```json
{
  "schemaVersion": 1,
  "indexerVersion": "0.1.0",
  "generation": 17,
  "projectRoot": "/absolute/worktree/path",
  "lastSuccessfulScanAt": "2026-11-11T18:00:00.000Z",
  "indexStatus": "current",
  "fileCount": 1234
}
```

Valid status values: `current`, `stale`, `partial`, `initializing`, `error`. Do not call a graph `current` when one or more changed, relevant source files failed to reparse.

---

## 7. Static discovery and parsing

### 7.1 Project discovery

Index selected files from:

- `api/controllers/**/*.js`
- `api/helpers/**/*.js`
- `api/services/**/*.js`
- `api/models/**/*.js`
- `api/policies/**/*.js`
- `config/routes.js`
- `config/policies.js`
- Other `.js` files included by explicit configuration, for generic cross-file calls/imports.

Do not assume all files reside under `api`: module imports can refer to utility files outside it. It is acceptable to discover these transitively (within project root) if the referenced paths are local and permitted by include/exclude policy. Make this behavior documented and bounded.

Ignore `.sails-codegraph`, `node_modules`, `.git`, generated artifacts and excluded directories; avoid symlink traversal by default.

### 7.2 Parsing contract

For each indexed source file:

1. Create a JS AST using the TypeScript compiler API.
2. Extract relevant functions, lexical symbols, CommonJS/ESM imports, exports, and call expressions.
3. Detect assignments to `module.exports`, `module.exports.foo`, and `exports.foo` where statically identifiable.
4. Record source spans and lexical scopes for shadowing-safe resolution.
5. Extract framework-agnostic raw references **even when the target is currently missing**.
6. Apply framework-specific classification rules.
7. Return a file-level IR; do not write to the database from individual AST visitors.

Proposed interface:

```ts
interface ParsedFile {
  path: string; // root-relative POSIX path
  sha256: string;
  symbols: ExtractedSymbol[];
  entities: ExtractedEntity[];
  references: RawReference[];
  diagnostics: Diagnostic[];
}
```

Never run a source file to discover exported values. Statically interpret only literals, object-property keys, simple constant aliases, and safely understood expressions.

### 7.3 Function shapes to recognize

All of the following must produce concrete FUNCTION nodes:

```js
function named() {}
const expression = function () {};
const arrow = async () => {};
module.exports = function (req, res) {};
module.exports = async (req, res) => {};
module.exports = {
  fn: async function (inputs, exits) {},
  other: () => {},
  method() {}
};
exports.run = async function () {};
class Service { async execute() {} }
```

Function expressions assigned to object properties cannot be silently discarded merely because the AST function node has no explicit identifier. Their owner expression is their derived name.

### 7.4 Generic JS module references

Minimum required:

- Relative `require('./module')` with a literal string.
- Static ESM `import` and `export` declarations (when present).
- Lexical direct calls such as `validate()` when unambiguously bound.
- Literal property/member method calls when declarations are statically discoverable.
- Destructured requires: `const { charge, refund: doRefund } = require('../services/PaymentService')` binds each local name to `export:<file>#<prop>`.
- Shorthand and reference exports: `module.exports = { charge, refund }` and `module.exports.charge = charge` link the export key to the FUNCTION node of the local declaration, so callers reach the real implementation.
- Re-exports: `module.exports = require('./impl')` and `export { x } from './y'` forward export lookups to the target module. Bound the chain length and guard against cycles.
- Self calls: inside the same file, `module.exports.charge()` and `exports.charge()` resolve `static`/`high`. Inside a method of an object literal assigned to `module.exports` (typical for Sails services and classic controllers), `this.charge()` resolves to the sibling property with `resolution: inferred` and `confidence: medium`, because the runtime receiver can be rebound.
- Function references: a bound function identifier passed as an argument or stored in a property yields a `REFERENCES` edge, so impact analysis doesn't miss callback-style usage.
- Static Node-style resolution of relative requires: exact path, `<path>.js`, then `<path>/index.js`. `.json` targets are recorded as `IMPORTS` but not parsed. Bare specifiers (`stripe`, `node:fs`, `@sailshq/lodash`) become `PACKAGE` targets with status `external`. A relative path that escapes the root stays unresolved with reason `outside_root`.

Must avoid false resolution when variables shadow Sails model/service globals or when target module paths are ambiguous. Dynamic imports and computed require paths remain unresolved with a clear reason.

### 7.5 Reference classification and noise policy

A naive extractor records every call. `get_unresolved` then fills up with `console.log`, `res.json`, `_.map` and `exits.success`, which makes the list useless and hides the real gaps. Classify each candidate reference before persisting it:

| Class | Examples | Persisted | Counted as unresolved |
|---|---|---|---|
| Project reference | `validate()`, `svc.charge()`, `sails.helpers.x.y()`, `User.find()`, `PaymentService.charge()` | Yes, as a raw reference | Only if resolution fails |
| External | `require('stripe')`, `stripe.charges.create()`, `console.log`, `JSON.parse`, `Promise.all`, `setTimeout`, configured `externalGlobals` | `require`/`import` sites yes (`IMPORTS` → `PACKAGE`); member calls on external bindings only as per-file counts | No (`external`) |
| Sails plumbing | `exits.success()`, `exits.notFound()`, `res.ok()`, `res.json()`, `req.param()`, `this.req`, `sails.log.*`, `sails.config.*` reads, helper/query chain modifiers | No (optional per-file counts) | No |
| Free unknown identifier | `Paymnet.create()` (typo), `UnknownService.run()` | Yes | Yes (`unresolved_missing`) |
| Dynamic | `sails.helpers[name]`, `require(path)`, `svc[method]()` on a project-bound base | Yes | Yes (`unresolved_dynamic`) |

Rules:

- Lexical binding comes first. `exits`, `res`, `req` and `next` count as plumbing only when they are parameters of a recognized action, helper or policy function (`fn(inputs, exits)`, `(req, res, next)`) or the actions2 equivalents (`this.req`, `this.res`). A locally declared `res` object is not plumbing.
- Method calls on values of unknown origin (`result.items.map(...)`, `record.save()`) are not references. Only these are candidates: direct calls of bound or free identifiers, and member calls whose base is a module binding, a Sails namespace/global, or a free identifier.
- Free identifiers that are not bound, not known JS/Node globals, and not models or services are `unresolved_missing`, with reason `unknown_global`. This is usually a typo or a missing file, which is exactly what users need to see.
- `stats` and `get_unresolved` report counts per class, so users can see what was filtered out and why.

---

## 8. Sails.js-specific resolution

### 8.1 Actions2 controllers

Example:

```js
// api/controllers/payment/create.js
module.exports = {
  friendlyName: 'Create payment',
  inputs: {},
  exits: {},
  fn: async function (inputs, exits) {
    await sails.helpers.payment.process.with({ amount: inputs.amount });
    return exits.success();
  }
};
```

Expected nodes:

- `action:payment/create`
- `function:api/controllers/payment/create.js::module.exports.fn`

Expected edges:

- `action:payment/create` `IMPLEMENTED_BY` its `fn` function.
- The `fn` `CALLS` `helper:payment/process` when that helper exists.

Handle `fn: async (...) => {}` and equivalent static property assignment when possible. Do not confuse `fn` with a named export in unrelated objects: Sails classification is based on the file location and export shape.

### 8.2 Classic controllers

```js
// api/controllers/UserController.js
module.exports = {
  create: async function (req, res) {},
  find: function (req, res) {}
};
```

Create separate ACTION nodes for `UserController.create` and `UserController.find`, each mapping to its corresponding FUNCTION. Support legacy `module.exports.create = ...` and `exports.create = ...` when unambiguous.

Route identifiers may be written as `UserController.create` or a path-based action identity. Preserve recognized aliases in an entity alias registry; if several actions collide, return ambiguity instead of arbitrarily selecting one.

Additional rules (identity derivation is in Section 6.3.1):

- Nested controller folders: method `create` in `api/controllers/admin/UserController.js` becomes `action:admin/user/create` with alias `admin/UserController.create`.
- Sails refuses to lift when a standalone action file and a classic controller method produce the same identity (for example `api/controllers/user/create.js` and `UserController.create`). Emit an `ACTION_IDENTITY_CONFLICT` error diagnostic and mark references to that identity `ambiguous`.
- Non-function properties of a classic controller are not actions. Record `_config` as controller metadata only.

### 8.3 Helpers and nested namespaces

Examples:

```text
api/helpers/format-welcome-message.js
    -> sails.helpers.formatWelcomeMessage
api/helpers/user/find-by-email.js
    -> sails.helpers.user.findByEmail
api/helpers/payment/process-payment.js
    -> sails.helpers.payment.processPayment
```

Required invocations:

```js
await sails.helpers.formatWelcomeMessage('Ada');
await sails.helpers.user.findByEmail.with({ email });
await sails.helpers.payment.processPayment.with({ amount });
sails.helpers.payment.processPayment.with({ amount }).exec(callback);
await sails.helpers['user']['findByEmail'].with({ email });
```

In each case the called target is the helper entity, **not** the `.with` or `.exec` method. Store invocation style metadata (`direct`, `with`, `exec`) where ascertainable. Match literal computed property names and simple aliases; mark nonliteral computed paths as dynamic/unresolved.

Treat all of these chain members as invocation style, never as targets: `.with()`, `.exec()`, `.now()` (synchronous helpers), `.tolerate()`, `.intercept()`, `.retry()`, `.meta()` and `.switch()`. Record the sequence in edge metadata, for example `{"invocation": "with", "modifiers": ["intercept", "tolerate"]}`. Agents use `tolerate`/`intercept` to understand error handling. A helper that is accessed but not invoked (`const h = sails.helpers.user.findByEmail;`) yields a `REFERENCES` edge. A later call through the alias (`h.with(...)`) yields `CALLS`.

A helper conventionally exposes an `fn` property and may be sync or async. The package should extract that implementation function as well as the HELPER entity. Metadata such as friendly name, inputs, and exits may be extracted when statically represented, but is not a prerequisite for correct relationships.

When `inputs` and `exits` are object literals on a helper or actions2 action, extract input names, `type`, `required`, and exit names into entity attributes, and return them from `get_symbol`. Agents use this as the call contract. The keys passed at a call site (`.with({ amount })`) or the positional argument count may be stored on the `CALLS` edge. Flagging mismatches is optional; if implemented, it must be a `warning` diagnostic and never change an edge.

### 8.4 Services

Recognize `api/services/PaymentService.js` and references to statically identifiable global `PaymentService`, plus local `require(...)` imports. Examples:

```js
await PaymentService.charge(card);
const svc = require('../services/PaymentService');
await svc.charge(card);
```

Prefer lexical/import bindings over conventional global lookup. Recognize exported object properties/methods and direct exported functions when statically determinable. Calls may point to a concrete FUNCTION implementation, or the SERVICE entity if the exact method is not resolved. Retain the exact expression and resolution explanation.

### 8.5 Models and Waterline operations

Given `api/models/User.js`:

```js
await User.findOne({ id });
await User.create(values).fetch();
await sails.models.user.updateOne({ id }).set(values);
await User.destroy({ id });
```

Recognize the model through global name / `sails.models.<identity>` if not shadowed. Store edge operation metadata and classify:

- Reads: `find`, `findOne`, `count`, `sum`, `avg`, etc.
- Writes: `create`, `createEach`, `update`, `updateOne`, `destroy`, `destroyOne`, `archive`, `archiveOne`, `addToCollection`, `removeFromCollection`, `replaceCollection`.
- Unknown/custom methods: `USES_MODEL` rather than guessing.

The method lists are extendable. Chained query modifiers `.fetch()`, `.populate()`, `.sort()`, etc., should not hide the underlying model access; don't generate a fake helper call to `fetch`.

Additional model rules:

- `.populate('pets')` on a model query, where the association `pets` is statically declared, adds a READS_MODEL edge to the associated model with `resolution: inferred`, `confidence: medium` and metadata `{"operation": "populate", "via": "pets"}`.
- `sails.models['user']` resolves like `sails.models.user`. A nonliteral key is `unresolved_dynamic`.
- `User.getDatastore().sendNativeQuery(...)` and `User.getDatastore().manager` produce USES_MODEL with `operation: "native"`. `sails.sendNativeQuery(...)` and `sails.getDatastore()` without a model produce an `unsupported` reference with reason `native_query_no_model`, so raw SQL access stays visible.
- `.meta()`, `.usingConnection()`, `.decrypt()`, `.intercept()`, `.tolerate()` and similar are query modifiers, recorded only as metadata.
- Custom static functions declared in the model definition become FUNCTION nodes. A call such as `User.fullName()` that matches one resolves to that FUNCTION (`static`, `high`), not to USES_MODEL.
- Bare global model access depends on `config/globals.js` (Section 8.9).

For model definitions, extract statically declared `attributes` associations using `model`, `collection`, `via`, and optionally `through`. Unknown referenced models remain unresolved references, not invented entities.

For lifecycle hooks (`beforeCreate`, `beforeUpdate`, etc.), extract their functions as FUNCTION nodes; calling relationships inside them should be parsed. Their runtime triggering relationships are optional for v0.1 and, if emitted, must be labeled as framework-inferred rather than an observed call.

### 8.6 Explicit routes

```js
// config/routes.js
module.exports.routes = {
  'POST /api/payments': 'payment/create',
  'GET /users/:id': { action: 'user/find' },
  'POST /legacy-user': 'UserController.create',
  'GET /signup': { view: 'signup' }
};
```

Required:

- Parse static route keys with method and path.
- Resolve string and `{ action: '...' }` targets to ACTION nodes.
- Preserve unresolved action targets in raw references.
- Do not create a ROUTES_TO action edge for view-only routes.
- Ignore or diagnose runtime-built route definitions that cannot be statically interpreted.

Support `module.exports.routes = {}`, plus other unambiguous CommonJS object assignment shapes. Explicit routes are in scope; implicit blueprint routing is not required for v0.1.

Route target forms (each needs a fixture):

| Route value | Interpretation |
|---|---|
| `'user/find'`, `'UserController.find'`, `{ action: 'user/find' }` | ROUTES_TO ACTION (rules above). |
| `{ controller: 'UserController', action: 'find' }` | Legacy controller/action pair → ACTION. |
| `{ action: ..., skipAssets, cors, csrf, locals, ... }` | ACTION plus route metadata. Unknown keys are preserved in attributes. |
| `function (req, res) {}` or `{ fn: ... }` | Inline handler: FUNCTION `function:config/routes.js::module.exports.routes["GET /x"]`, plus ROUTES_TO that FUNCTION. |
| `'/old': '/new'` or `{ redirect: '/new' }` | Redirect. No action edge; record `redirect` metadata. |
| `{ view: 'signup' }`, `{ response: 'notFound' }` | No action edge; metadata only. An edge to RESPONSE is optional. |
| Key without a verb, e.g. `'/x': 'user/find'` | Matches all methods; store `method: "*"`. |

**Split route files.** Larger apps often build routes from several files: `module.exports.routes = { ...require('./routes/admin'), 'GET /': 'home' }` or `Object.assign({}, require('./routes/api'))`. When `resolution.followRouteFileRequires` is true, follow literal relative requires that stay inside `config/`, statically read each file's exported object literal (never execute it), and merge it into the route table. Duplicate keys follow JS spread/assign precedence. Record these files in `file_dependencies`: editing one re-evaluates the route table without reparsing unrelated files, and they are indexed even when they are not listed in `include` (subject to `exclude` and root containment). Any other construct (loops, function calls, environment conditionals) produces a `ROUTE_DYNAMIC` diagnostic with its location. Static entries in the same object are still indexed.

**Concrete-path matching.** `query route` and `trace_route` accept either a route key (`POST /api/payments/:id`) or a concrete request (`POST /api/payments/42`). Match concrete requests against explicit route patterns using Sails-style path syntax (`:param`, optional `:param?`, trailing `*`) in declaration order, because Sails matches explicit routes in order. Return all matches in order with the first marked `primary`, and state in the result that blueprint and hook-injected routes are not considered.

### 8.7 Policies

```js
// config/policies.js
module.exports.policies = {
  '*': 'isLoggedIn',
  'user/login': true,
  'user/delete': ['isLoggedIn', 'isAdmin']
};
```

Implement static policy mapping for global `*`, stand-alone actions, and controller-level mappings, applying documented Sails precedence where unambiguous. A `true` mapping signifies no policy edge; `false` signifies explicitly blocked access and should be represented as action metadata/diagnostic, not as a fake policy. For mappings that depend on dynamic config or unsupported blueprint behavior, report `partial`/unresolved rather than asserting comprehensive coverage.

Supported mapping shapes (pin each with a fixture against the Sails 1.x docs):

```js
module.exports.policies = {
  '*': 'isLoggedIn',                 // global default
  'user/*': 'isLoggedIn',            // standalone-action prefix wildcard
  'user/login': true,                // exact action
  UserController: {                  // classic controller mapping
    '*': 'isLoggedIn',
    delete: ['isLoggedIn', 'isAdmin']
  }
};
```

- The most specific rule wins and **replaces** less specific rules; Sails policies do not cascade or merge. Precedence: exact action > longest matching wildcard prefix > controller-level `'*'` > global `'*'`. Confirm this order with the fixture before encoding it.
- Preserve array order as the `order` attribute of each `GUARDED_BY` edge, since Sails runs policies in that order.
- Each `GUARDED_BY` edge stores `matchedRule` (the config key) and that rule's source span in `config/policies.js`, so an agent can explain *why* an action is guarded.
- A `false` mapping sets the action attribute `access: "blocked"` and emits an info diagnostic.
- A policy name with no matching file in `api/policies` becomes an `unresolved_missing` raw reference.
- An action with no matching rule and no global `'*'` gets the attribute `policies: "none"`. Explicitly unguarded actions are valuable to an agent reviewing security.
- A change to the policy config re-evaluates mappings for all actions (conservative invalidation, Section 10.4). Adding or removing an action evaluates only that action.

Policies themselves can be `module.exports = function (...) {}` and must be extracted as functions. Include source locations for `GUARDED_BY` edges.

### 8.8 Framework version and customizations

- Detect Sails dependency version from `package.json` if present, without running it.
- Target Sails 1.x conventions first; classic patterns should work where statically understandable.
- A custom model `globalId`, `identity`, custom helper loader, or transformed route source may change runtime names. Use statically declared literal overrides when supported, and report unresolved/uncertain cases otherwise.
- Record capability coverage in `doctor`/`stats`, e.g. `explicit_routes: supported`, `implicit_blueprints: not_analyzed`.

### 8.9 Globals configuration

`config/globals.js` controls whether models, services, `_`, `async` and `sails` are exposed as globals. When `resolution.honorGlobalsConfig` is true and the file contains a statically readable `module.exports.globals` object:

- `models: false`: bare `User.find()` is not a model access at runtime. Record it as `unresolved_missing` with reason `model_globals_disabled` and emit no READS_MODEL edge. `sails.models.user.find()` still resolves.
- `services: false`: the same treatment for bare service globals.
- `_: require('@sailshq/lodash')`, `async: ...`: those names are classified `external`.
- If the file is absent or not statically readable, assume the defaults of a generated Sails 1.x app (models and services exposed) and report `globals_config: assumed_default` in capability coverage.

A change to `config/globals.js` invalidates every global model and service reference. Re-resolve them without reparsing their files.

---

## 9. Resolution engine

### 9.1 Two-pass minimum

**Pass 1: registration**

- Parse changed files into file-level IRs.
- Register all discovered entities, symbols, aliases, exports, and canonical lookup keys.

**Pass 2: resolution**

- Resolve each raw reference using lexical scopes, import aliases, registered Sails conventions, and the target registry.
- Emit relationship edges only when supported by a rule.
- Persist unresolved or ambiguous references with reasons and candidate keys.

Implement resolution in a way that works when a caller file is indexed before the referenced helper or model.

### 9.2 Lookup priority

1. Locally bound symbol / lexical alias.
2. Explicit imported/required module symbol, including destructured requires and re-exports.
3. Same-file self references: `module.exports.x()` / `exports.x()` (`static`), then `this.x()` sibling methods (`inferred`, `medium`).
4. Explicit `sails.helpers.*` / `sails.models.*` reference.
5. Recognized Sails global model or service, only if there is no lexical shadowing and `config/globals.js` doesn't disable it (Section 8.9).
6. Other framework conventions supported by a dedicated resolver.
7. Known JS/Node globals, packages, and `externalGlobals` → `external` (Section 7.5).
8. Otherwise unresolved.

Never resolve by matching only the last string segment if multiple targets exist.

### 9.3 Resolution keys and reverse lookup

Each reference stores at least one canonical lookup key (or a JSON list of keys if aliases/candidates are possible), for example:

```text
helper-access:payment.process
helper-access:user.findByEmail
model:user
model-global:User
service-global:PaymentService
module:api/services/PaymentService.js
export:api/services/PaymentService.js#charge
action:payment/create
action-alias:UserController.create
policy:isloggedin
package:stripe
```

The engine needs a reverse index from **lookup key → raw references**. It must be possible to re-resolve unmodified callers when a target with that key is added, renamed, or deleted. Edges alone are insufficient because deleted targets would leave no incoming edge to revisit.

### 9.4 Unknown versus incorrect

Resolution status distinctions:

- `resolved`: unique, supported target.
- `unresolved_missing`: target not indexed or does not exist.
- `unresolved_dynamic`: computed/runtime target.
- `ambiguous`: multiple eligible targets.
- `unsupported`: construct is valid code but not implemented by this indexer.
- `parse_error`: source cannot be reliably interpreted.
- `external`: target is outside the project (npm package, Node built-in, JS/Node global, or configured `externalGlobals`). It is kept for `IMPORTS`/impact purposes and is never counted as unresolved. Sails plumbing is filtered before persistence (Section 7.5), so it has no status.

Queries must not conceal these categories. Include summary counts and retrieval of detailed diagnostics.

---

## 10. Incremental indexing: required architecture

### 10.1 Supported change types

| Event | Required outcome |
|---|---|
| File edited, no exported-name change | Replace file-owned parsed data and outgoing references; leave unrelated file IRs untouched. |
| File added | Register new symbols/entities, then resolve both its own references and existing unresolved references now matching it. |
| File deleted | Remove owned nodes/edges; re-resolve surviving incoming raw references as missing/ambiguous if needed. |
| File renamed | Correct result by delete-old + add-new even if native watcher emits no rename event. |
| Helper/entity renamed without caller edits | Existing caller raw references must be revisited. |
| Config route/policy changed | Update relevant route/policy entities and mapping edges; re-evaluate impacted action/policy matches. |
| Source parse fails after an edit | Do not misreport the old graph as current; maintain last good generation or partial state with diagnostics. |
| Changes while watcher is stopped | Next `sync` and MCP startup detect and reconcile them. |
| Several files saved in one burst | Coalesce events; commit a consistent generation. |
| File edited during parsing | Detect mismatched bytes/stat/hash and retry or mark stale; do not commit a fictitious fresh result. |

### 10.2 Change detection

Persist for each file: normalized path, SHA-256 content hash, size, mtime, and successful parse generation. Use a lightweight file enumeration/stat comparison to identify candidates, then content-hash candidates before reparse. The **content hash**, not mtime alone, determines whether file content changed.

Full `index` computes all hashes and reparses everything. Incremental `sync` must enumerate files to catch missed add/delete events. A watcher can make detection faster but cannot replace periodic reconciliation.

For a repository with no changes, `sync` must not reparse all source files. It may enumerate/stat them. `sync --check` must be read-only, report changed paths and known stale state, and return exit code 3 if not current.

### 10.3 Required algorithm (conceptual)

```text
synchronize(root):
    acquire per-index writer coordination
    current = enumerate eligible files (normalized, deterministic)
    previous = read persisted file manifest
    added   = current paths missing in previous
    deleted = previous paths missing in current
    candidates = paths with changed size/mtime or watcher-dirty flag
    changed = candidates whose SHA-256 differs from previous hash

    parsed = parse each added/changed file into temporary IR
    if any file changed again while being parsed:
        retry that file a bounded number of times
        otherwise record stale/parse diagnostic

    compute old registry keys from added/changed/deleted file definitions
    compute new registry keys from parsed added/changed definitions
    affectedKeys = union(old keys, new keys)

    begin SQLite write transaction:
        remove old file-owned nodes, raw references and derived edges
        remove deleted files
        insert new parsed file-owned IRs
        update registry and file metadata
        re-resolve new raw references
        find unmodified raw references matching affectedKeys
        re-resolve those existing references (even when old target is gone)
        update affected derived edges and resolution statuses
        update graph generation, diagnostics and scan metadata
    commit transaction

    release coordination
    return summary and freshness status
```

A real implementation may use a staging table or alternate transaction strategy to avoid deleting valid data before confirming parsing success. The transaction must not publish a partially updated graph as `current`.

**Important subtlety:** re-resolution on registry changes is not limited to previously successful incoming edges. It must also revisit previously **unresolved** references whose matching target has just appeared, and references where an added entity introduces ambiguity.

**Change summary.** Every committed sync returns a bounded change summary, through `sync --json` and `sync_index`. It lists added, removed and changed node IDs; added and removed edges as `(source, kind, target)` triples; and references whose resolution status changed (for example `resolved → unresolved_missing`). Cap each category (default 50) and include totals and a `truncated` flag. Persist the latest summary in `index_meta` so `get_index_status` can answer "what changed in the last sync" afterwards. This lets an agent check that its own edit had the intended graph effect, e.g. "my rename left 3 callers unresolved".

### 10.4 Ownership and invalidation

Distinguish:

- **File-owned records:** nodes, raw references, and structural edges extracted from a source file.
- **Derived resolution edges:** edges computed using source references and registry state.

When replacing a file:

1. Determine all target lookup keys owned by the old file.
2. Stage and register new file-owned definitions.
3. Replace outgoing raw references originating in that file.
4. Invalidate and rebuild derived edges for new references and any persisted references that depended on old/new registry keys.
5. Preserve all unaffected parsed file IRs and their raw references.

For policy wildcard/alias changes, invalidation may cover a broader set of actions. A conservative **re-resolution of relevant references without reparsing unrelated source files** is acceptable for v0.1.

### 10.5 Filesystem watcher

Use `chokidar` for `watch` mode:

- Listen for add/change/unlink (and directory changes as relevant).
- Debounce bursts, default 300 ms.
- Process changes through a serialized update queue.
- Periodically run a manifest reconciliation, default 30 seconds, to recover from dropped events.
- On unexpected watcher failure, emit a diagnostic and retain manual `sync` functionality.
- Properly close watcher, database, and process resources on SIGINT/SIGTERM.
- Never follow excluded or external symlinks.

`watch` is optional; the npm package must still function perfectly through `index`, `sync`, and MCP without it.

`mcp --watch` (or `mcp.watch: true`) runs the same watcher inside the MCP process, so dirty flags are consumed before queries (Section 10.6). It must use the MCP process's single writer queue and never write to stdout. If the watcher fails to start (for example, the inotify limit is reached), it falls back to stat-based reconciliation and reports the fallback in `get_index_status`.

### 10.6 MCP freshness behavior

At MCP startup: open/migrate the index and run `sync` (or perform initial indexing if none exists). Do not rely solely on a watcher being active.

Before graph-query tools:

- Call `syncIfNeeded()`.
- Coalesce concurrent sync requests into one update.
- Consume watcher dirty flags immediately when available.
- Run filesystem stat reconciliation when the configured `mcpScanIntervalMs` has elapsed (default 2000 ms).
- Allow explicit force-sync via a dedicated MCP tool.
- Return generation, last successful scan timestamp, and freshness status with query results.

Do not claim instantaneous freshness. A query is consistent **as of the last completed reconciliation**. A file may change immediately afterward; this is a documented concurrency limitation. If an indexing error occurred, return `stale`/`partial` metadata rather than silently returning old data as current.

### 10.7 Transactionality, errors, and recovery

- SQLite WAL mode recommended; enforce schema migrations by version.
- One logical writer at a time per graph database. Combine process-local serialization with safe cross-process coordination (e.g., advisory lock/lease plus SQLite transaction) so separate CLI/MCP processes cannot corrupt logical generations.
- Use bounded lock waits and clear error messages; do not spin indefinitely.
- Roll back the batch on structural DB errors.
- A parse error in a changed file must yield an explicit stale/partial state. Preferred policy: preserve last known-good representation for that file but annotate it as stale; alternatively, use a documented partial-graph policy that never looks current. Pick one and test it.
- Detect indexer/schema-version incompatibility and rebuild or migrate safely.
- `index` can rebuild into a temporary DB and atomically replace the prior DB when feasible, subject to WAL-safe handling.
- If a watched file is deleted while it is being read, treat it as a retryable change, not an uncaught crash.
- Persist and report diagnostics independently of stderr.

### 10.8 Git worktree isolation

Every worktree gets an independent index by default:

```text
worktree-A/.sails-codegraph/graph.sqlite
worktree-B/.sails-codegraph/graph.sqlite
```

Resolve the project root from the current working directory or explicit `--root`; never assume `.git` is always a directory because it is often a file in a linked worktree. Use `git rev-parse --show-toplevel` only as a non-executing auxiliary process if needed; root detection must also work outside Git.

Never mix source paths or graph edges from different worktrees. Uncommitted changes belong in the corresponding worktree's graph. No cross-branch graph sharing is required in v0.1.

### 10.9 Performance targets (engineering goals, not guarantees)

For a representative warm repository on an SSD:

- No-op sync: zero reparsed files.
- One changed source file: normally one reparsed file plus targeted reference re-resolution.
- Direct caller/callee queries: target under 100 ms for a moderately sized graph (excluding optional sync).
- Incremental single-file update: target under 1 second for an ordinary file and moderate affected set.
- A full repository should complete without external infrastructure; benchmark on at least a 1,000-file fixture or real repository before claiming scalability.

Benchmarks must record environment, file count, nodes, edges, raw references, elapsed time, memory, and reparse counts. Avoid hard-coding release gates around arbitrary latency numbers without reproducible hardware.

---

## 11. Query engine and traversal semantics

### 11.1 Core query behavior

`find_symbol(query)` supports exact canonical ID, normalized name, and ranked partial match. Return multiple candidates with location information if ambiguous rather than choosing one silently.

`get_callers(id, depth)` returns functions/entities whose resolved call edges reach the target, including calls to a helper entity. `get_callees(id, depth)` follows outgoing calls and may traverse `IMPLEMENTED_BY` edges to continue from framework entities into implementation functions.

Define the traversal behavior unambiguously:

- An ACTION/HELPER can expand through `IMPLEMENTED_BY` to its implementing FUNCTION.
- A FUNCTION follows `CALLS` to FUNCTION/HELPER/SERVICE/ACTION nodes.
- Model operation edges and policy edges appear as related dependencies but do not count as executable calls unless explicitly requested.
- Maintain visited IDs to avoid cycles; return a cycle indicator or truncate safely.
- Default depth 2, maximum depth 5.
- Default result limit 100, maximum 500. Include `truncated` and stable pagination/cursor where appropriate.

`trace_route(method, path)` starts from an explicitly mapped route and follows route/action/call relationships; do not infer live routing, middleware sequencing, or runtime execution order from graph reachability alone.

`analyze_impact(id)` performs bounded **reverse reachability** across relevant callers and dependency edges. Return `potentiallyAffected`, `reasonPath`, and missing-coverage warnings; do **not** assert these files definitely need edits or tests.

`get_unresolved()` can filter by file, kind, and reason. This is essential for users to understand the graph's limitations.

Traversal options shared by the CLI and MCP:

- `relations`: subset of edge kinds to follow. By default, callers/callees follow `CALLS` and `IMPLEMENTED_BY`. `includeReferences: true` adds `REFERENCES`; `includeModelAccess: true` adds model edges as leaf results.
- `excludePaths`: glob list that hides results (for example tests or scripts) without changing the graph.
- Ordering: results are sorted by `(depth, sourceId, targetId, startLine)`, so cursors are stable within one generation. A cursor from another generation returns a `cursor_stale` error instead of silently shifting.

Impact refinements: `analyze_impact` also returns `affectedEntryPoints`, meaning the routes and actions (with their policies) that can reach the target, because "which endpoints could this change break?" is the most common agent question. Each potentially affected node carries `distance` and one shortest `reasonPath`. Results are grouped by kind (ROUTE, ACTION, HELPER, SERVICE, FUNCTION).

### 11.2 Output shape

Example for callers:

```json
{
  "query": { "tool": "get_callers", "symbolId": "helper:payment/process", "depth": 2 },
  "graph": {
    "generation": 17,
    "status": "current",
    "scannedAt": "2026-11-11T18:00:00.000Z"
  },
  "results": [
    {
      "sourceId": "function:api/controllers/payment/create.js::module.exports.fn",
      "targetId": "helper:payment/process",
      "relation": "CALLS",
      "resolution": "sails_convention",
      "confidence": "high",
      "evidence": {
        "file": "api/controllers/payment/create.js",
        "startLine": 14,
        "startCol": 11,
        "expression": "sails.helpers.payment.process.with(...)"
      }
    }
  ],
  "unresolvedRelatedCount": 0,
  "truncated": false
}
```

The line values above are illustrative; real outputs must use exact parsed source locations. The `generation` must refer to a committed consistent graph snapshot.

For multi-hop results, each result also includes `depth` (1 = direct) and `via` (the preceding node ID on the shortest path). The response carries a `nodes` map, `{id → {kind, name, file, startLine, endLine}}`, so node details are not repeated on every edge. Traversal never invents edges past an unresolved or ambiguous reference. Instead, `unresolvedRelatedCount` counts unresolved references that originate in visited nodes, and `boundaryWarnings` lists the first few (expression + reason), because they mark where the static graph may be incomplete.

### 11.3 File and source evidence

- Return root-relative paths and one-based line/column locations.
- Avoid including large source bodies by default.
- Optional source snippet length must be bounded and taken directly from local source with a freshness caveat.
- Never return arbitrary filesystem content outside the configured root.

### 11.4 Agent-oriented queries

| CLI / MCP | Input | Output |
|---|---|---|
| `query file` / `get_file_outline` | root-relative file path | The file's entities and functions with spans and `IMPLEMENTED_BY` owners, incoming/outgoing call counts, unresolved references in the file, and the file's parse status. |
| `query symbol --detail` / `get_symbol` | node ID | Node attributes (helper inputs/exits, model attributes/associations, route metadata, guarding policies), bounded immediate incoming/outgoing edges, and an optional bounded source snippet with a freshness caveat. |
| `query routes` / `list_routes` | optional `method`, `pathPrefix`, `action` | Explicit routes in declaration order, with targets and guarding policies. |
| `query model-usage` / `get_model_usage` | model ID or name | Accessors grouped by operation (`read`, `write`, `uses`, `native`, `populate`), associations in both directions, and the entry-point routes that reach each accessor (bounded). |
| `query impact --files` / `analyze_changes` | root-relative file list. Optional `gitDiff: true` uses `git diff --name-only HEAD` plus untracked files, run as a non-executing auxiliary process. | Impact seeded from every node owned by those files, plus the entity identities that would disappear if the files were deleted or renamed. |
| `query path` / `find_paths` *(optional)* | `from`, `to`, `maxDepth` | Up to N shortest paths over call, route and model relations. |

All of these use the shared query service and the common response envelope (graph metadata, `truncated`, bounds). Path inputs go through the containment checks in Section 14.

---

## 12. MCP interface specification

### 12.1 Server requirements

Use MCP TypeScript SDK v2 and stdio transport. The MCP tool layer must call the **same query/indexing services as the CLI**; there must not be independent logic producing different results.

Required tools:

| Tool name | Input | Output |
|---|---|---|
| `get_overview` | optional filters | Counts, major components, health and freshness. |
| `find_symbol` | `query`, optional `kinds`, `limit` | Matches with IDs, kind, file, location. |
| `get_callers` | `symbolId`, optional `depth`, `limit` | Incoming call relationships and evidence. |
| `get_callees` | `symbolId`, optional `depth`, `limit` | Outgoing call relationships and evidence. |
| `trace_route` | `method`, `path` (pattern or concrete request path), optional `depth` | Matched route(s), guarding policies, and downstream graph traversal. |
| `analyze_impact` | `symbolId`, optional `depth`, `limit` | Potentially affected nodes and paths. |
| `get_unresolved` | optional `file`, `kind`, `reason`, `groupBy`, `limit` | Unresolved raw references and diagnostics, plus per-class filtered counts (Section 7.5). |
| `sync_index` | optional `force` | Update summary; scanner errors and freshness. |
| `get_index_status` | none | Freshness, pending errors, generation, supported coverage, last sync change summary, watcher state. |
| `get_symbol` | `symbolId`, optional `includeSnippet` | Node detail and immediate neighbors (Section 11.4). |
| `get_file_outline` | `file` | File outline (Section 11.4). |
| `list_routes` | optional `method`, `pathPrefix`, `action`, `limit` | Explicit routes in declaration order. |
| `get_model_usage` | `model`, optional `limit` | Model accessors by operation. |
| `analyze_changes` | `files` or `gitDiff`, optional `depth`, `limit` | Impact seeded from changed files. |
| `find_paths` | `from`, `to`, optional `maxDepth` | *Optional for v0.1.* |

Each MCP input must have a validated schema, with bounds enforced server-side. Query errors should be structured MCP tool errors, not process crashes.

### 12.2 Protocol output

- Return structured JSON in MCP tool content (text JSON is acceptable; use structured content when supported by SDK/client).
- Include `graph.generation`, `graph.status`, `graph.scannedAt` for data-reading tools.
- Keep stdout free of log lines and banners.
- Use stderr for logging; no secrets or project source snippets in logs by default.
- Tool descriptions must distinguish static graph relationships from actual runtime behavior.
- MCP queries should be read-only except `sync_index`, which only writes index storage.
- Never allow a tool argument to request arbitrary shell execution or access to unrelated directories.
- Response budget: every data-reading tool accepts `detail: "summary" | "full"`. The default, `summary`, returns IDs, kinds, names and locations, with attributes only where essential. If the serialized output would exceed `mcp.maxResponseBytes`, truncate results deterministically, set `truncated: true`, and return a `nextCursor` or a hint to narrow the query. Never send an oversized payload.
- Errors carry an actionable `hint`. For example, when a symbol is not found, return up to 5 nearest `find_symbol` candidates.

### 12.3 Concurrency

Multiple graph-query requests may run concurrently against one committed generation. A sync uses a single writer and must not expose half-updated graph content. If using SQLite snapshot isolation, queries should read a stable generation and report that exact generation in their result.

---

## 13. Worked example and required graph behavior

Given:

```js
// api/helpers/payment/process.js
module.exports = {
  friendlyName: 'Process payment',
  fn: async function (inputs, exits) {
    const record = await Payment.create({ amount: inputs.amount }).fetch();
    return exits.success(record);
  }
};
```

```js
// api/controllers/payment/create.js
module.exports = {
  fn: async function (inputs, exits) {
    const result = await sails.helpers.payment.process.with({ amount: inputs.amount });
    return exits.success(result);
  }
};
```

```js
// config/routes.js
module.exports.routes = {
  'POST /api/payments': 'payment/create'
};
```

Expected logical graph:

```text
route:POST /api/payments
  --ROUTES_TO--> action:payment/create
  --(through action IMPLEMENTED_BY)--> function:...create.js::module.exports.fn
  --CALLS--> helper:payment/process
  --(through helper IMPLEMENTED_BY)--> function:...process.js::module.exports.fn
  --WRITES_MODEL[operation=create]--> model:payment
```

Now change only the controller to call `sails.helpers.payment.validate.with(...)`:

1. `sync` reparses controller, not helper or model.
2. The old call edge to `helper:payment/process` disappears.
3. A new edge resolves to `helper:payment/validate` if that helper exists; otherwise persist unresolved reference with `unresolved_missing`.
4. `get_callers('helper:payment/process')` no longer lists the controller.

Now rename `api/helpers/payment/process.js` to `api/helpers/payment/execute.js` while leaving the controller unchanged:

1. Old helper is removed and new helper is registered.
2. Any surviving references to the old helper are reconsidered and marked unresolved.
3. References to the new helper become resolvable if present.
4. No unrelated source file must be reparsed merely because its previously resolved target was renamed.
5. The graph status is current only after the transaction has completed and the scan has reconciled this change.

---

## 14. Security and robustness

**Threat model:** The analyzed repository is untrusted source. Static analysis must not execute the repository, its hooks, its build scripts, or its config. The MCP process operates with the developer's filesystem permissions, so paths and input sizes must be constrained.

Requirements:

- No evaluation of project source: no `require(projectFile)`, `import(projectFile)`, `vm`, `eval`, shelling out to user-defined build scripts, or starting Sails.
- No unintended network access, telemetry, or uploading code.
- Reject path traversal and access outside configured project root; normalize paths and verify containment before opening files.
- Ignore symlinks by default; handle symlink loops if enabled in future.
- Bound source-file size, query depth, result count, and returned snippets.
- Handle invalid Unicode, malformed JS, missing files, permission errors, circular imports, and extremely deep ASTs without unbounded recursion/process crashes.
- Use parameterized SQL and safe prepared statements.
- Do not log complete source files or environment-variable values.
- Ensure `.sails-codegraph` is ignored by the indexer to prevent self-triggered re-index loops.
- MCP server must not provide general-purpose filesystem modification or command execution endpoints.
- Published npm package must ship only necessary compiled files, types, schema and docs. Verify `npm pack --dry-run` output.

---

## 15. Tests and validation

### 15.1 Test layers

- **Unit:** AST extraction, identity creation, naming conversions, model method classification, alias and shadowing behavior, config validation.
- **Fixture integration:** Index miniature Sails apps and assert exact nodes/edges/references.
- **Incremental integration:** Copy fixture to temp directory, index, edit/add/delete/rename, sync, assert reparse counts and graph changes.
- **CLI integration:** Execute the published CLI binary against fixtures, verify exit codes and JSON shape.
- **MCP integration:** Spawn stdio server using SDK client/transport; call each tool and validate response; assert stdout contains only protocol messages.
- **Packaging smoke test:** `npm pack`, install resulting tarball into a fresh fixture project, run `index`, `sync`, and MCP startup.
- **Cross-platform CI:** Linux, macOS, Windows at least for smoke tests, subject to native dependency compatibility.

### 15.2 Required coverage matrix

| ID | Test case | Expected outcome |
|---|---|---|
| T01 | actions2 `module.exports.fn` anonymous async function | ACTION + FUNCTION + IMPLEMENTED_BY. |
| T02 | actions2 arrow `fn: async () => {}` | Function discovered. |
| T03 | classic object controller with two action functions | Two distinct ACTIONs with functions. |
| T04 | `module.exports = function (...) {}` | Exported anonymous FUNCTION. |
| T05 | helper file `foo-bar.js` | `sails.helpers.fooBar` resolves. |
| T06 | nested helper `user/find-by-email.js` | `sails.helpers.user.findByEmail` resolves. |
| T07 | direct helper call | CALLS helper entity. |
| T08 | `.with(...).exec(...)` helper call | One helper CALLS edge, not to `with` or `exec`. |
| T09 | literal computed helper access | Resolves to helper. |
| T10 | variable computed helper access | Explicit `unresolved_dynamic`. |
| T11 | global service method call | Resolves to service/concrete function when possible. |
| T12 | `require(...)` service alias | Resolves without relying on global names. |
| T13 | model global `User.findOne` | READS_MODEL with operation. |
| T14 | model chain `User.create(...).fetch()` | WRITES_MODEL to User, no bogus `fetch` call. |
| T15 | lexical `const User = ...` shadows model | No false model access. |
| T16 | model `collection`/`model` association | ASSOCIATES_WITH target model. |
| T17 | explicit route to action | ROUTES_TO. |
| T18 | route string `UserController.create` | Resolves classic action. |
| T19 | view-only route | No invented action edge. |
| T20 | policy global + action override | Correct guarded action mapping. |
| T21 | full index twice unchanged | Same deterministic nodes/edges ignoring generation/timestamps. |
| T22 | no-op sync | Zero reparsed source files. |
| T23 | controller changed to call another helper | Old edge removed, new edge added. |
| T24 | helper deleted, caller untouched | Caller raw reference becomes unresolved; old edge removed. |
| T25 | helper added after unresolved reference | Existing caller becomes resolved without reparsing. |
| T26 | helper renamed | Old key invalidated, new key registered. |
| T27 | service/model export identity changed | All relevant references re-resolved. |
| T28 | route config changed | Correct route edge replacement. |
| T29 | watcher receives rapid save events | Coalesced consistent graph, no duplicate edges. |
| T30 | source changed while watcher stopped | `sync` catches it. |
| T31 | modified file has syntax error | Stale/partial reported; old content not asserted current. |
| T32 | multiple Git worktrees, different code | Different independent graphs. |
| T33 | circular calls | Traversal bounded; no infinite loop. |
| T34 | multiple matching symbols | Ambiguity returned instead of arbitrarily selecting. |
| T35 | file outside root / `../` query path | Denied. |
| T36 | project module with top-level side effect | Indexing does not execute it. |
| T37 | MCP tool invocation | Correct schema/output; no stdout logging. |
| T38 | packaging tarball installed into fresh app | CLI and MCP work without source checkout. |
| T39 | `console.log`, `res.json`, `exits.success`, `_.map` inside actions | Not reported as unresolved; counted as external/plumbing. |
| T40 | typo `Paymnet.create()` | `unresolved_missing`, visible in `get_unresolved`. |
| T41 | destructured `require` of a service | CALLS to the concrete FUNCTION. |
| T42 | `module.exports = { charge }` shorthand export | Callers reach the FUNCTION of the local declaration. |
| T43 | `this.validate()` inside a service object method | CALLS sibling, `inferred`/`medium`. |
| T44 | function passed as a callback | REFERENCES edge; included in impact, excluded from default callers. |
| T45 | helper `.with().intercept().tolerate()` chain | One CALLS edge; modifiers in metadata. |
| T46 | nested classic controller `admin/UserController` | `action:admin/user/create` and its alias resolve. |
| T47 | standalone and classic action identity collision | `ACTION_IDENTITY_CONFLICT` and ambiguous references. |
| T48 | helper collision `find-by-email.js` + `findByEmail.js` | `ambiguous` plus `HELPER_NAME_COLLISION`. |
| T49 | route forms: no verb, inline function, redirect, `{controller, action}` | Edges/metadata as in the Section 8.6 table. |
| T50 | routes spread from `require('./routes/admin')`; edit only that file | Route table updated; only that file reparsed. |
| T51 | concrete path `GET /users/42` | Matches `GET /users/:id`, respecting declaration order. |
| T52 | policy precedence and ordered arrays | Correct GUARDED_BY with `matchedRule` and `order`. |
| T53 | `config/globals.js` with `models: false` | Bare `User.find()` not a model access; `sails.models.user.find()` resolves. |
| T54 | `.populate('pets')` with a declared association | Inferred READS_MODEL to the associated model. |
| T55 | `require('stripe')`, `require('node:fs')` | IMPORTS → PACKAGE; not unresolved. |
| T56 | `analyze_changes` with two files | Seeds from owned nodes; returns affected entry-point routes. |
| T57 | MCP result larger than `maxResponseBytes` | Deterministically truncated, `truncated: true`, valid cursor/hint. |
| T58 | sync change summary after a helper rename | Lists removed/added helper and the callers' status changes. |

### 15.3 Ground-truth evaluation

Construct a small hand-validated fixture dataset with at least **50 relationships** spanning actions2, classic controllers, helpers, services, models, routes, and policies. Evaluate:

- Relationship precision = correct produced relationships / all produced relationships.
- Relationship recall = correct produced relationships / all ground-truth relationships **within documented supported scope**.
- Unresolved-reference coverage: dynamic/unsupported references are surfaced, not silently omitted.

Release gate for supported fixture patterns: **100% exact matches on deterministic expected fixtures**. For realistic external projects, report precision/recall empirically and do not promise unrealistic universal coverage.

### 15.4 Benchmarks and instrumentation

`index`/`sync` should optionally emit metrics in machine-readable form:

```json
{
  "filesEnumerated": 600,
  "filesParsed": 1,
  "filesUnchanged": 599,
  "referencesReresolved": 8,
  "nodesAdded": 2,
  "nodesRemoved": 1,
  "edgesAdded": 3,
  "edgesRemoved": 2,
  "durationMs": 145,
  "generation": 18
}
```

These numbers are illustrative. Tests must assert the meaningful counters (especially that a one-file edit does **not** cause all files to be reparsed).

---

## 16. Implementation plan / delivery order

**Keep work in a single repository and publishable package.** Implement vertical slices in this order; every milestone must run tests and leave the repository in a working state.

### Milestone 1: Package scaffold + full source discovery

- TypeScript npm package, CLI binary, tests, formatting/linting, CI basics.
- Root detection, config loading, safe file enumeration.
- AST parser recognizes named and property-assigned anonymous functions.
- `index` writes a persistent SQLite node/reference/edge-ready schema.
- `stats`, `doctor`, and JSON export function.

**Done when:** A fixture app indexes through `npx` and `module.exports.fn` is represented as a FUNCTION with correct source locations. No project code is executed.

### Milestone 2: Sails resolution + graph queries

- Framework entities and aliases.
- Actions2/classic controllers, nested helpers, service and model calls.
- Explicit routes, initial policy/model association support.
- Raw-reference persistence, lookup-key registry, resolved edges and diagnostics.
- Callers/callees/route/impact CLI query layer.
- Identity derivation (Section 6.3.1), reference classification (Section 7.5), extended JS shapes (Section 7.4), route/policy forms (Sections 8.6–8.7), and globals config (Section 8.9).

**Done when:** Fixtures T01–T20 and T39–T55 (supported subsets) pass, missing/dynamic references are visible, and `get_unresolved` on the fixtures contains no plumbing or external noise.

### Milestone 3: Incremental engine

- Manifest, hashing, added/modified/deleted/renamed handling.
- Reverse lookup invalidation and selective re-resolution.
- Atomic commits, generation/status metadata, error recovery.
- `sync`, `sync --check`, and stats counters.
- Optional watcher with debounce, periodic reconciliation, shutdown handling.
- Per-sync change summary (Section 10.3).

**Done when:** Incremental tests T21–T31 and T58 pass, including unmodified caller re-resolution after helper deletion/addition. No-op sync reparses zero files.

### Milestone 4: MCP, worktrees, packaging

- MCP v2 stdio integration, validated tools, bounded results.
- Query-time freshness + explicit sync tool.
- Worktree-separated root/index behavior.
- README install/setup for Claude Code and Codex, usage examples, limitations.
- Packaging smoke test using npm tarball; cross-platform CI.
- Agent-oriented queries and MCP tools (Section 11.4), response budget (Section 12.2), optional `mcp --watch`.

**Done when:** An external coding agent can call `find_symbol`, `get_callers`, `trace_route`, `analyze_impact`, `analyze_changes`, and `sync_index` on a fixture app; all T32–T38, T56 and T57 tests pass.

### Milestone 5: Hardening and v0.1 release

- Run against at least one representative non-fixture Sails.js application.
- Measure actual uncovered Sails conventions, performance, index size, and false relationships.
- Fix high-confidence correctness defects, document unsupported patterns.
- Prepare package metadata, LICENSE, CHANGELOG, npm provenance/CI publishing as appropriate.

**Done when:** Release checklist in Section 17 is satisfied. Avoid adding visualization or distributed architecture before this checkpoint.

---

## 17. Definition of done / acceptance criteria

v0.1 is accepted only when all applicable items below are true:

- [ ] `npm install --save-dev sails-codegraph` works from a clean consuming Sails project.
- [ ] `npx sails-codegraph index` runs without requiring Sails to start, a database connection, or CodeAura.
- [ ] Controllers, actions2, classic actions, nested helpers, model/service accesses, explicit routes, and covered policies are represented.
- [ ] Anonymous `module.exports.fn` functions appear in the graph with source locations.
- [ ] CLI can query exact symbols, callers, callees, explicit routes, impact candidates, and unresolved references.
- [ ] The MCP server starts over stdio and registers the documented tools.
- [ ] A one-file edit changes its affected graph relationships without reparsing unchanged files.
- [ ] Add/delete/rename events re-resolve **unmodified** callers when their targets change.
- [ ] Previously unresolved callers can become resolved when a matching target is added.
- [ ] Parsing errors, unsupported constructs, and stale graph states are not silently hidden.
- [ ] `get_unresolved` on fixture apps lists only genuine project gaps, with no `console`/`res`/`exits`/package noise.
- [ ] Through both CLI and MCP, agents can get a file outline, symbol detail, a route list with concrete-path matching, model usage, and changed-files impact.
- [ ] Graph updates are atomic and withstand watcher/CLI overlap without corruption.
- [ ] Two Git worktrees can maintain independent indexes.
- [ ] Source is never executed during indexing; path traversal and excluded files are blocked.
- [ ] Fixture, incremental, CLI, MCP, and tarball packaging tests pass.
- [ ] README contains accurate installation, MCP setup, limitations, and troubleshooting.
- [ ] No telemetry, external account, hosted infrastructure, or hidden runtime dependency.

**If a nonessential feature threatens the release, cut it and document the limitation. Never cut graph correctness, missing-reference retention, index consistency, or non-execution of project source.**

Suggested cut order for Revision 2 additions: `find_paths`, RESPONSE nodes, call-site input checks, `gitDiff` mode of `analyze_changes`, `mcp --watch`, populate inference. Reference classification (Section 7.5) and identity derivation (Section 6.3.1) are correctness features and must not be cut.

---

## 18. Deliverables required from the implementing agent

1. Complete source code in a single npm-package repository.
2. Compiled distributable CLI binary and published API/types as needed.
3. SQL migrations/schema and persistent index functionality.
4. Fixture suite covering representative Sails.js patterns and incremental changes.
5. Automated tests and packaging smoke test.
6. README with installation and commands, example graph queries, Claude Code and Codex MCP setup, and troubleshooting.
7. An architecture note explaining node IDs, raw references, resolver precedence, invalidation rules, and freshness semantics.
8. `CHANGELOG.md`, license file, npm package metadata, `.gitignore`, and sample config.
9. A short implementation report: features completed, tests run/results, known limitations, performance sample, and unimplemented deferred items.

### Final instruction to the agent

Implement and test the package end-to-end. Prefer making working code and running tests over writing a second planning document. If a framework behavior is ambiguous, inspect official Sails documentation and encode a fixture for the behavior before implementing a resolver. Do not claim that a graph is complete or current when its coverage or freshness is uncertain.

---

## 19. Reference documentation

These are implementation references, not dependencies on external services:

- Sails.js Helpers: https://sailsjs.com/documentation/concepts/helpers
- Sails.js Actions and Controllers: https://sailsjs.com/documentation/concepts/actions-and-controllers
- Sails.js Routing to Actions: https://sailsjs.com/documentation/concepts/actions-and-controllers/routing-to-actions
- Sails.js Routes: https://sailsjs.com/documentation/concepts/routes
- Sails.js Policies: https://sailsjs.com/documentation/concepts/policies
- Sails.js Models: https://sailsjs.com/documentation/concepts/models-and-orm/models
- Sails.js Associations: https://sailsjs.com/documentation/concepts/models-and-orm/associations
- Official MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/
- Official MCP SDK repository: https://github.com/modelcontextprotocol/typescript-sdk
- Claude Code MCP documentation: https://code.claude.com/docs/en/mcp

**Note:** MCP SDK packaging and client configuration conventions can evolve. Verify current package import paths and client setup commands while implementing. All core requirements in this specification remain independent of those incidental syntax details.

---

## 20. Revision log

### Revision 2 (2026-11-11): functional improvements

Correctness and signal quality:

- **Reference classification and noise policy** (Section 7.5, new `external` status in Section 9.4). Without it, `get_unresolved` would be dominated by `console`, `res`, `exits`, lodash and package calls.
- **Explicit identity derivation table** (Section 6.3.1): helper camelCase access keys, nested and classic action identities, case-insensitive matching, collision diagnostics. Previously the helper ID versus lookup-key relationship and classic action IDs were underspecified.
- **Reverse-index tables** `reference_keys`, `registry_keys`, `file_dependencies` (Section 6.5), so multi-key references and re-resolution work as indexed joins.
- **Common real-world JS shapes** (Section 7.4): destructured requires, shorthand exports, re-exports, `this.` sibling calls, function references (new `REFERENCES` edge), package imports (new `PACKAGE` node).
- **Sails coverage**: nested classic controllers and identity conflicts (Section 8.2), helper chain modifiers and input/exit contracts (Section 8.3), populate/native-query/custom model methods (Section 8.5), full route target forms, split route files and concrete-path matching (Section 8.6), policy precedence with `matchedRule`/`order`/unguarded detection (Section 8.7), `config/globals.js` (Section 8.9).

Agent usefulness:

- New queries/tools (Section 11.4, Section 12.1): `get_symbol`, `get_file_outline`, `list_routes`, `get_model_usage`, `analyze_changes`, optional `find_paths`.
- Impact returns affected entry-point routes, with distance and reason paths (Section 11.1). Traversal results include `depth`/`via`, a deduplicated `nodes` map, and `boundaryWarnings` (Section 11.2).
- Per-sync change summary (Section 10.3), response byte budget with `detail` levels, actionable error hints (Section 12.2), optional embedded watcher `mcp --watch` (Section 10.5).

Tests T39–T58 cover the additions. The milestone placement and the cut order appear in Sections 16–17.
