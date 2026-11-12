# sails-codegraph

Static, local-first code graph for **Sails.js 1.x** applications, with a CLI and an **MCP stdio server** for coding agents (Claude Code, Codex, …).

It parses your app with the TypeScript compiler API (it **never runs** your code, config or Sails), builds a graph of actions, helpers, services, models, explicit routes and policies, stores it in SQLite under `.sails-codegraph/`, and keeps it current incrementally.

- Recognizes actions2 and classic controllers (incl. nested `admin/UserController`), nested helpers (`sails.helpers.user.findByEmail` ↔ `api/helpers/user/find-by-email.js`), model globals and `sails.models.*`, services (global, `require`d, destructured), explicit routes (incl. routes spread from required files), `config/policies.js` precedence and `config/globals.js`.
- Anonymous functions get stable names: `function:api/controllers/payment/create.js::module.exports.fn`.
- No invented edges: dynamic, missing and ambiguous targets are kept as **unresolved references** with a reason.
- Incremental: a one-file edit reparses one file; renaming/deleting a helper re-resolves its **unmodified** callers.
- No network access, telemetry, or accounts.

Requires Node.js **22.13+**.

## Install and first run

```bash
cd /path/to/sails-project
npm install --save-dev sails-codegraph
npx sails-codegraph init                     # optional: writes sails-codegraph.config.json
npx sails-codegraph index
npx sails-codegraph stats
```

`index` works without `init` (defaults are used). Add `.sails-codegraph/` to `.gitignore` (or run `init --update-gitignore`).

### Installing from a local checkout (without publishing to npm)

Build the package first; the `bin` points at `dist/cli/main.js`:

```bash
cd /path/to/sails-codegraph
npm install
npm run build
```

Then pick one of:

**Tarball (closest to a real npm install).** Installs exactly what would be published, so it also catches packaging mistakes. Re-run `npm pack` and reinstall after code changes.

```bash
# in sails-codegraph
npm pack                      # runs the build via prepack; creates sails-codegraph-<version>.tgz

# in the Sails project
npm install --save-dev /path/to/sails-codegraph/sails-codegraph-0.1.0.tgz
npx sails-codegraph index
```

**`npm link` (fastest while iterating).** Symlinks the checkout; after code changes only `npm run build` is needed.

```bash
# in sails-codegraph
npm link                      # exposes a global `sails-codegraph` command

# optionally, in the Sails project, to put it in node_modules
npm link sails-codegraph
```

Undo with `npm unlink -g sails-codegraph`.

**`file:` dependency.** Same symlink behaviour as `npm link`, but recorded in the project's `package.json`. There is no `prepare` script, so run `npm run build` in the checkout yourself.

```bash
npm install --save-dev /path/to/sails-codegraph
```

To use a local checkout as an MCP server without installing it into the project, point the client at the built entry point:

```bash
claude mcp add sails-codegraph -- node /path/to/sails-codegraph/dist/cli/main.js mcp --root /path/to/sails-project
```

`better-sqlite3` is a native module and is built/downloaded for the Node version (22.13+) used by the Sails project. `npm run test:pack` exercises the tarball flow against a fixture app.

## Keeping the graph current

```bash
npx sails-codegraph sync            # reconcile adds/edits/deletes/renames since the last scan
npx sails-codegraph sync --check    # read-only; exit 3 if the graph is not current
npx sails-codegraph watch           # optional watcher (debounced, with periodic reconciliation)
```

Change detection enumerates and stats files and confirms changes by SHA-256, so `sync` also catches edits made while nothing was running. A no-op sync reparses zero files.

## Queries

```bash
npx sails-codegraph query symbol 'helper:payment/process'
npx sails-codegraph query symbol 'helper:payment/process' --detail --snippet
npx sails-codegraph query callers 'helper:payment/process' --depth 2 --json
npx sails-codegraph query callees 'action:payment/create' --depth 2 --include-model-access --json
npx sails-codegraph query route 'POST /api/payments' --json
npx sails-codegraph query route 'GET /users/42' --json          # concrete path, matched in declaration order
npx sails-codegraph query routes --method POST --prefix /api --json
npx sails-codegraph query impact 'helper:payment/process' --depth 3 --json
npx sails-codegraph query impact --files api/helpers/payment/process.js --depth 3 --json
npx sails-codegraph query impact --git-diff --json
npx sails-codegraph query unresolved --group-by reason --json
npx sails-codegraph query file api/controllers/payment/create.js --json
npx sails-codegraph query model-usage User --json
npx sails-codegraph query path 'route:POST /api/payments' 'model:payment' --json
npx sails-codegraph export --format json --output graph.json
npx sails-codegraph doctor
```

Shared options: `--root <path>`, `--config <file>`, `--json`, `--verbose`, `--no-color`. Traversals accept `--depth` (default 2, max 5), `--limit` (default 100, max 500), `--offset`/`--cursor`, `--relations`, `--include-references`, `--exclude-paths`.

Exit codes: `0` ok · `1` operational/indexing error · `2` invalid input or config · `3` `sync --check` found changes or stale state.

Every result includes `graph: { generation, status, scannedAt }`. A graph is reported `current` only when every relevant file parsed and the scan completed; a file with a syntax error keeps its last good representation and the graph is reported `stale` until it is fixed.

### Node IDs

| Kind | Example |
|---|---|
| ROUTE | `route:POST /api/payments`, `route:/legacy` (no verb = all methods) |
| ACTION | `action:payment/create`, `action:admin/user/create` (classic `admin/UserController.create`) |
| HELPER | `helper:user/find-by-email` |
| MODEL | `model:user` |
| SERVICE | `service:PaymentService` |
| POLICY | `policy:isLoggedIn` |
| FUNCTION | `function:<file>::<lexical name>` e.g. `::module.exports.fn`, `::module.exports.routes["GET /health"]` |
| MODULE / FILE | `module:<file>`, `file:<file>` |
| PACKAGE | `package:stripe`, `package:node:fs` |

Edges: `CONTAINS`, `IMPLEMENTED_BY`, `ROUTES_TO`, `CALLS`, `READS_MODEL`, `WRITES_MODEL`, `USES_MODEL`, `ASSOCIATES_WITH`, `GUARDED_BY`, `IMPORTS`, `REFERENCES`. Each carries `resolution` (`static` / `sails_convention` / `inferred`), `confidence` and file:line evidence. See [docs/architecture.md](docs/architecture.md).

## MCP server

```bash
npx sails-codegraph mcp                       # root discovered from cwd
npx sails-codegraph mcp --root /abs/path      # explicit root
npx sails-codegraph mcp --watch               # also run the embedded watcher
```

stdio only (no HTTP listener); stdout carries JSON-RPC only and logs go to stderr. At startup it syncs (or builds the index); before each query it runs a throttled freshness check (`indexing.mcpScanIntervalMs`, default 2000 ms). Results are consistent as of the last completed reconciliation.

Tools: `get_overview`, `find_symbol`, `get_callers`, `get_callees`, `trace_route`, `analyze_impact`, `get_unresolved`, `sync_index`, `get_index_status`, `get_symbol`, `get_file_outline`, `list_routes`, `get_model_usage`, `analyze_changes`, `find_paths`. Data tools accept `detail: "summary" | "full"`; outputs above `mcp.maxResponseBytes` are truncated deterministically with `truncated: true`, a `hint` and a `nextCursor`. Errors are structured tool errors with a hint (e.g. nearest `find_symbol` candidates).

### Claude Code (project scope)

```bash
claude mcp add --scope project --transport stdio sails-codegraph -- npx --no-install sails-codegraph mcp
```

which produces a `.mcp.json` like:

```json
{
  "mcpServers": {
    "sails-codegraph": { "type": "stdio", "command": "npx", "args": ["--no-install", "sails-codegraph", "mcp"] }
  }
}
```

### Codex CLI

Codex reads MCP servers from `config.toml` (`~/.codex/config.toml`, or a project-scoped `.codex/config.toml` for trusted projects). Add:

```toml
[mcp_servers.sails-codegraph]
command = "npx"
args = ["--no-install", "sails-codegraph", "mcp", "--root", "/absolute/path/to/sails-project"]
```

or `codex mcp add sails-codegraph -- npx --no-install sails-codegraph mcp --root /absolute/path/to/sails-project` (writes the user-level config). Check `codex mcp --help` for your Codex version, since the CLI evolves.

Only enable MCP server configurations you trust: a project `.mcp.json` / `.codex/config.toml` runs commands on your machine.

## Configuration

`sails-codegraph.config.json` (JSON only, never executed; schema shipped as `sails-codegraph.config.schema.json`):

```json
{
  "root": ".",
  "include": ["api/**/*.js", "config/routes.js", "config/policies.js", "config/globals.js"],
  "exclude": ["**/node_modules/**", "**/.git/**", "**/.tmp/**", "**/assets/**", "**/.sails-codegraph/**"],
  "storage": { "directory": ".sails-codegraph", "database": "graph.sqlite" },
  "indexing": { "debounceMs": 300, "reconcileIntervalMs": 30000, "mcpScanIntervalMs": 2000, "maxFileBytes": 2000000, "followSymlinks": false },
  "resolution": {
    "framework": "sails", "includeExplicitRoutes": true, "includePolicies": true, "includeModelAssociations": true,
    "honorGlobalsConfig": true, "followRouteFileRequires": true,
    "extraModelReadMethods": [], "extraModelWriteMethods": [], "externalGlobals": []
  },
  "query": { "defaultDepth": 2, "maxDepth": 5, "defaultLimit": 100, "maxLimit": 500 },
  "mcp": { "watch": false, "maxResponseBytes": 200000 }
}
```

Unknown keys warn; invalid types or storage paths outside the root are errors. Changing indexing/resolution settings triggers a full re-index on the next sync. Root discovery order: `--root`, `SAILS_CODEGRAPH_ROOT`, then upward from the cwd (`package.json` + `api/`, or `api/controllers` + `config/`).

## Git worktrees

Each worktree gets its own `.sails-codegraph/graph.sqlite` (linked worktrees, where `.git` is a file, work the same). Uncommitted changes belong to that worktree's graph.

## Limitations

- Static only: blueprint routes, hook-injected routes, custom loaders, runtime config functions and dynamic dispatch are not analyzed (`stats`/`get_index_status` report coverage, e.g. `implicit_blueprints: not_analyzed`).
- Computed helper/model names, `require(variable)` and `svc[method]()` stay `unresolved_dynamic`.
- Calls inside inline callbacks (`items.map(function () { … })`) are attributed to the enclosing named function; the callback still exists as a FUNCTION node.
- Services/models in sub-directories are registered with `confidence: low` and a diagnostic (Sails loader behavior unverified).
- `this.x()` resolves to a sibling only for methods of an object assigned to `module.exports` (`inferred`/`medium`).
- If two files define the same canonical entity ID, the later one is stored as `<id>@<file>` with a `NODE_ID_CONFLICT` diagnostic; references to that identity are `ambiguous`.
- `.json` requires are recorded as `IMPORTS` but not parsed. TypeScript Sails apps are not a supported target.
- Impact analysis lists candidates by reverse reachability; it does not prove a change breaks anything.

## Troubleshooting

- **"Could not find a Sails project root"**: run inside the app, or pass `--root` / set `SAILS_CODEGRAPH_ROOT`.
- **Status `stale`**: `sails-codegraph stats` lists pending parse errors; fix the file and `sync`.
- **Lock timeout**: another sails-codegraph process is writing. A lock left by a dead process is taken over automatically.
- **better-sqlite3 install fails**: it needs a prebuilt binary for your platform/Node version or a C++ toolchain; run `npx sails-codegraph doctor`.
- **MCP client shows no tools**: run the configured command manually; anything printed on stdout besides JSON-RPC would come from a wrapper script, not from sails-codegraph.
- **Watcher errors (e.g. inotify limits)**: the watcher falls back to periodic reconciliation; `get_index_status` reports it. `sync` always works.

## Development

```bash
npm install
npm run build
npm test                    # unit + integration (builds first)
npm run test:pack           # npm pack + install into a fresh fixture app
node --test --test-name-pattern="T23" tests/integration/incremental.test.mjs   # a single test
```

## License

MIT
