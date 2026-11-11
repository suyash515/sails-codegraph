export type NodeKind =
  | 'FILE'
  | 'ROUTE'
  | 'ACTION'
  | 'HELPER'
  | 'MODEL'
  | 'SERVICE'
  | 'POLICY'
  | 'FUNCTION'
  | 'MODULE'
  | 'PACKAGE';

export const NODE_KINDS: NodeKind[] = ['FILE', 'ROUTE', 'ACTION', 'HELPER', 'MODEL', 'SERVICE', 'POLICY', 'FUNCTION', 'MODULE', 'PACKAGE'];

export type EdgeKind =
  | 'CONTAINS'
  | 'IMPLEMENTED_BY'
  | 'ROUTES_TO'
  | 'CALLS'
  | 'READS_MODEL'
  | 'WRITES_MODEL'
  | 'USES_MODEL'
  | 'ASSOCIATES_WITH'
  | 'GUARDED_BY'
  | 'IMPORTS'
  | 'REFERENCES';

export const EDGE_KINDS: EdgeKind[] = [
  'CONTAINS',
  'IMPLEMENTED_BY',
  'ROUTES_TO',
  'CALLS',
  'READS_MODEL',
  'WRITES_MODEL',
  'USES_MODEL',
  'ASSOCIATES_WITH',
  'GUARDED_BY',
  'IMPORTS',
  'REFERENCES',
];

export type Resolution = 'static' | 'sails_convention' | 'inferred';
export type Confidence = 'high' | 'medium' | 'low';

export type ReferenceStatus =
  | 'resolved'
  | 'unresolved_missing'
  | 'unresolved_dynamic'
  | 'ambiguous'
  | 'unsupported'
  | 'parse_error'
  | 'external'
  | 'pending';

export const UNRESOLVED_STATUSES: ReferenceStatus[] = [
  'unresolved_missing',
  'unresolved_dynamic',
  'ambiguous',
  'unsupported',
  'parse_error',
];

export interface Span {
  startLine: number; // 1-based
  startCol: number; // 1-based
  endLine: number;
  endCol: number;
  startOffset: number;
  endOffset: number;
}

export interface IRNode {
  id: string;
  kind: NodeKind;
  name: string;
  filePath: string | null;
  span: Span | null;
  attributes: Record<string, unknown>;
}

export interface IREdge {
  source: string;
  target: string;
  kind: EdgeKind;
  resolution: Resolution;
  confidence: Confidence;
  attributes: Record<string, unknown>;
  evidence: Evidence | null;
}

export interface Evidence {
  file: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  expression?: string;
}

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  filePath: string | null;
  span?: Span | null;
}

/** Edge kind requested by a reference once resolved. */
export type RefEdgeKind = 'CALLS' | 'REFERENCES' | 'IMPORTS' | 'MODEL_OP' | 'ASSOCIATES_WITH' | 'ROUTES_TO' | 'POLICY';

export interface HelperInvocation {
  invocation: 'direct' | 'with' | 'exec' | 'now' | 'none';
  modifiers: string[];
  argKeys?: string[];
  argCount?: number;
}

/**
 * Resolution instructions for a raw reference (persisted as lookup_context_json).
 * The resolver evaluates these against the registry; it never re-reads source.
 */
export type RefSpec =
  | { type: 'node'; nodeId: string; edge: 'CALLS' | 'REFERENCES' }
  | { type: 'helper'; access: string; edge: 'CALLS' | 'REFERENCES'; call: HelperInvocation }
  | {
      type: 'module_member';
      modules: string[]; // candidate root-relative paths (exact, .js, /index.js)
      member: string; // 'default' when the module itself is called
      edge: 'CALLS' | 'REFERENCES';
      resolution: Resolution;
      confidence: Confidence;
      self?: boolean;
    }
  | {
      type: 'global_member';
      name: string;
      member: string;
      modifiers: string[];
      native?: boolean;
      edge: 'CALLS' | 'REFERENCES';
    }
  | { type: 'model_member'; identity: string; member: string; modifiers: string[]; native?: boolean; edge: 'CALLS' | 'REFERENCES' }
  | { type: 'populate'; base: { identity?: string; global?: string }; via: string }
  | { type: 'import'; modules: string[] }
  | { type: 'package'; name: string }
  | { type: 'json'; path: string }
  | { type: 'association'; target: string; attribute: string; assocType: 'model' | 'collection' | 'through'; via?: string }
  | { type: 'action'; key: string; alias?: string }
  | { type: 'policy'; key: string }
  | { type: 'preset'; status: ReferenceStatus; reason: string; keys?: string[] };

export interface RawReference {
  id: string;
  sourceNodeId: string;
  refKind: string;
  expression: string;
  span: Span;
  spec: RefSpec;
}

export interface RegistryEntry {
  key: string;
  nodeId: string;
}

export interface FileRecord {
  kind: string;
  data: unknown;
}

export interface FileDependency {
  dependencyFile: string;
  kind: string;
}

export interface ParsedFile {
  path: string;
  sha256: string;
  sizeBytes: number;
  parseOk: boolean;
  nodes: IRNode[];
  edges: IREdge[]; // structural edges (CONTAINS, IMPLEMENTED_BY, ...)
  references: RawReference[];
  registry: RegistryEntry[];
  diagnostics: Diagnostic[];
  records: FileRecord[];
  dependencies: FileDependency[];
  counts: Record<string, number>;
}
