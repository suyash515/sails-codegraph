# Architecture

Pipeline: **discover → parse to per-file IR → register → resolve → persist** (one SQLite transaction per sync).

## Modules

| Path | Role |
|---|---|
| `src/discovery/` | Root discovery (`--root`, `SAILS_CODEGRAPH_ROOT`, upward walk) and deterministic, symlink-safe file enumeration. |
| `src/config/` | JSON config schema (zod), validation, unknown-key warnings, config hash. |
| `src/parser/parse-file.ts` | One file → `ParsedFile` IR. Two passes over the TypeScript AST: a pre-pass that builds lexical scopes, bindings and stable function names; a main pass that classifies references. Never touches the DB. |
| `src/parser/sails-entities.ts` | Path-based Sails entities: helpers, actions (actions2 / function / classic), models, services, policies, their registry keys and `IMPLEMENTED_BY` edges. |
| `src/parser/sails-config.ts` | `config/routes.js` (and required route files) → route fragments; `config/policies.js` → rules; `config/globals.js` → flags. |
| `src/graph/resolver.ts` | Pure function: reference spec + registry lookups → status, edges, and the set of keys consulted. |
| `src/indexing/indexer.ts` | Change detection, the write transaction, derived passes (routes, policies, collision diagnostics), change summary. |
| `src/indexing/coordinator.ts`, `watcher.ts`, `lock.ts` | Single-writer queue, throttled freshness, chokidar watcher with periodic reconciliation, cross-process lock file. |
| `src/query/service.ts` | All queries; used by both the CLI and the MCP tools. |
| `src/mcp/` | MCP SDK v2 server over stdio; thin wrappers around the query service plus a response byte budget. |

## Node identity

* Framework entities use Sails identities: `helper:<path sans .js>` (lookup key `helper-access:<camelCased.segments>`), `action:<path>` for standalone actions, `action:<dir>/<controller lower>/<method>` for classic controllers (alias key `action-alias:<dir>/<Name>Controller.<method>`), `model:<identity>` (+ `model-global:<globalId>`; literal `identity`/`globalId` override), `service:<Name>`, `policy:<name>`. Case-insensitive lookup keys are stored lower-cased.
* Functions: `function:<file>::<qualified lexical name>`. The name comes from the lexical owner: declaration name, variable name, object-property path (`module.exports.attributes.beforeCreate`), assignment target (`exports.run`), class method (`Service.execute`). Anonymous functions without an owner get `<enclosing>.$anonN` (ordinal within the enclosing function; it can change when earlier anonymous functions are inserted). Duplicate names get `#2`, `#3`. Line numbers are never part of an ID.
* Routes: `route:<METHOD> <path>`, or `route:<path>` for verbless keys (method `*`).

## Raw references and resolution

Every candidate reference is classified at parse time (Section 7.5 of the spec):

* **Persisted** as a raw reference: calls/references of bound functions, module members (`require`, destructuring, ESM), `this.x()` siblings, `module.exports.x()`, helpers, models, services, free unknown identifiers, dynamic forms, imports, route targets, policy names, associations, populate.
* **Counted, not persisted**: calls on JS/Node globals, packages, `_`/`async`, `externalGlobals` (`external`); `exits`/`req`/`res`/`next`/`proceed` when they are parameters of a recognized action/helper/policy function, `this.req`/`this.res`, `sails.log`, `sails.config` (`plumbing`). Method calls on values of unknown origin are not references.

Lexical bindings always win over Sails globals: a local `const User` shadows the model.

Each reference stores a *spec* (`lookup_context_json`) describing how to resolve it. Lookup priority: lexical binding → imported module member (with re-export forwarding, bounded) → same-file `module.exports.x` (static) / `this.x` (inferred, medium) → `sails.helpers.*` / `sails.models.*` → model global (custom static function first, then Waterline operation) → service global (method, else the SERVICE entity at medium confidence) → otherwise `unresolved_missing` (`unknown_global`, or `model_globals_disabled` / `service_globals_disabled`). A key mapping to more than one node is `ambiguous`; nothing is ever resolved by matching a last name segment.

The resolver records **every lookup key it consulted** (including misses and `globals:*` flags) in `reference_keys`. `registry_keys` maps keys to nodes and the file that registered them. This reverse index is what makes incremental resolution correct.

## Incremental sync

1. Enumerate eligible files (plus route files reachable through `require` from `config/routes.js`), stat them, and hash only candidates whose size/mtime changed (or that a watcher flagged). Content hash decides.
2. Parse added/changed files outside the transaction; a file that changes while being parsed is retried, then reported stale.
3. In one `BEGIN IMMEDIATE` transaction:
   * For each changed/deleted file, collect its old registry keys, delete everything it owns (nodes, references, structural edges, derived edges of its references, registry rows, diagnostics, records).
   * Insert the new IR and its registry keys. **affectedKeys** = old keys ∪ new keys.
   * Resolve the new references, then re-resolve every *existing* reference whose consulted keys intersect affectedKeys (one indexed join). This covers previously resolved callers of a deleted/renamed target, previously unresolved references a new target now satisfies, and references a new target makes ambiguous, without reparsing those callers.
   * Derived passes: rebuild routes when any route file changed; rebuild `GUARDED_BY` when `config/policies.js` or any `action:`/`policy:` key changed (conservative, no reparsing); recompute collision diagnostics; garbage-collect unreferenced PACKAGE nodes.
   * Write metadata: generation (bumped only when something changed), status, scan time, change summary.
4. A file with a syntax error keeps its last good representation; it is marked `parse_error` and the graph status is `stale` until it parses again.

Full `index` uses the same transaction after clearing all tables, so readers never see a half-built graph (WAL mode). Changing the config, the indexer version or the project root forces a full index on the next sync.

Concurrency: one writer at a time via `.sails-codegraph/write.lock` (exclusive create, stale-lock takeover by dead pid or age, bounded wait) plus SQLite's busy timeout. Queries run inside a read transaction, so each result reports exactly the generation it read.

## Routes and policies

Route fragments (ordered entries and `require` includes) are stored per file; assembly starts at `config/routes.js`, follows includes inside `config/` (cycle-guarded), and applies JS object semantics for duplicate keys (first position, last value). ROUTE nodes and route-target references are owned by `#routes`, so editing a route file reassembles the table without reparsing other files.

Policies: most specific rule replaces less specific ones: exact action > longest wildcard prefix > controller `'*'` > global `'*'`. `GUARDED_BY` edges keep `order` and `matchedRule` with the rule's span; `true` → `policies: "public"`, `false` → `access: "blocked"` + info diagnostic, no rule → `policies: "none"`.

## Freshness

The CLI reads the committed graph as-is (`sync --check` reports differences). The MCP server syncs at startup and calls `syncIfNeeded()` before every data tool (immediately when the watcher flagged files, otherwise at most every `mcpScanIntervalMs`). Results are consistent as of the last completed reconciliation; a file can change right after.
