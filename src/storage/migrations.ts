export const SCHEMA_VERSION = 1;

/** MIGRATIONS[n] upgrades schema version n -> n+1. */
export const MIGRATIONS: string[] = [
  `
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE files (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  parsed_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,              -- ok | parse_error | stale
  generation INTEGER NOT NULL,       -- generation of the last successful parse
  pending_hash TEXT,                 -- hash of current (unparseable) content when status != ok
  counts_json TEXT NOT NULL DEFAULT '{}'
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
  attributes_json TEXT NOT NULL,
  owner TEXT NOT NULL
);
CREATE INDEX idx_nodes_kind_name ON nodes(kind, name);
CREATE INDEX idx_nodes_file ON nodes(file_path);
CREATE INDEX idx_nodes_owner ON nodes(owner);

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
  unresolved_reason TEXT,
  target_id TEXT,
  owner TEXT NOT NULL
);
CREATE INDEX idx_refs_source_file ON raw_references(source_file);
CREATE INDEX idx_refs_lookup_key ON raw_references(lookup_key);
CREATE INDEX idx_refs_source_node ON raw_references(source_node_id);
CREATE INDEX idx_refs_owner ON raw_references(owner);
CREATE INDEX idx_refs_status ON raw_references(resolution_status);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin_reference_id TEXT,
  resolution TEXT NOT NULL,
  confidence TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  owner TEXT NOT NULL,
  evidence_file TEXT,
  start_line INTEGER,
  start_col INTEGER,
  end_line INTEGER,
  end_col INTEGER,
  expression TEXT
);
CREATE INDEX idx_edges_source ON edges(source_id, kind);
CREATE INDEX idx_edges_target ON edges(target_id, kind);
CREATE INDEX idx_edges_origin ON edges(origin_reference_id);
CREATE INDEX idx_edges_owner ON edges(owner);

CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  file_path TEXT,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  start_line INTEGER,
  start_col INTEGER,
  owner TEXT NOT NULL
);
CREATE INDEX idx_diag_file ON diagnostics(file_path);
CREATE INDEX idx_diag_owner ON diagnostics(owner);

CREATE TABLE reference_keys (
  reference_id TEXT NOT NULL,
  lookup_key TEXT NOT NULL,
  PRIMARY KEY (lookup_key, reference_id)
);
CREATE INDEX idx_refkeys_ref ON reference_keys(reference_id);

CREATE TABLE registry_keys (
  lookup_key TEXT NOT NULL,
  node_id TEXT NOT NULL,
  owner_file TEXT NOT NULL,
  PRIMARY KEY (lookup_key, node_id)
);
CREATE INDEX idx_registry_owner ON registry_keys(owner_file);

CREATE TABLE file_dependencies (
  dependent_file TEXT NOT NULL,
  dependency_file TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (dependent_file, dependency_file, kind)
);
CREATE INDEX idx_filedeps_dep ON file_dependencies(dependency_file);

CREATE TABLE file_records (
  file_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (file_path, kind)
);

CREATE TABLE derived_attributes (
  node_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  owner TEXT NOT NULL,
  PRIMARY KEY (node_id, key)
);
CREATE INDEX idx_derived_owner ON derived_attributes(owner);
`,
];
