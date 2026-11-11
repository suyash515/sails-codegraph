import ts from 'typescript';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { sha256 } from '../util/hash.js';
import { resolvePosix } from '../util/paths.js';
import {
  KNOWN_GLOBALS,
  SAILS_EXTERNAL_GLOBALS,
  HELPER_INVOCATIONS,
  HELPER_MODIFIERS,
} from './known-globals.js';
import type {
  Diagnostic,
  FileDependency,
  FileRecord,
  HelperInvocation,
  IREdge,
  IRNode,
  ParsedFile,
  RawReference,
  RefSpec,
  RegistryEntry,
  Span,
} from '../graph/types.js';
import { extractSailsEntities } from './sails-entities.js';
import { extractRouteFragment, extractPoliciesConfig, extractGlobalsConfig } from './sails-config.js';

export interface ParseOptions {
  externalGlobals?: string[];
  includeModelAssociations?: boolean;
  followRouteFileRequires?: boolean;
  honorGlobalsConfig?: boolean;
}

export type FileCategory =
  | 'controller'
  | 'helper'
  | 'service'
  | 'model'
  | 'policy'
  | 'response'
  | 'routes'
  | 'policies_config'
  | 'globals'
  | 'config_other'
  | 'other';

export function categorize(relPath: string): FileCategory {
  if (relPath.startsWith('api/controllers/')) return 'controller';
  if (relPath.startsWith('api/helpers/')) return 'helper';
  if (relPath.startsWith('api/services/')) return 'service';
  if (relPath.startsWith('api/models/')) return 'model';
  if (relPath.startsWith('api/policies/')) return 'policy';
  if (relPath.startsWith('api/responses/')) return 'response';
  if (relPath === 'config/routes.js') return 'routes';
  if (relPath === 'config/policies.js') return 'policies_config';
  if (relPath === 'config/globals.js') return 'globals';
  if (relPath.startsWith('config/')) return 'config_other';
  return 'other';
}

// ---------------------------------------------------------------------------
// Bindings / scopes

export type Binding =
  | { kind: 'function'; nodeId: string }
  | { kind: 'module'; modules: string[] }
  | { kind: 'module_member'; modules: string[]; member: string }
  | { kind: 'package'; name: string }
  | { kind: 'helper'; access: string }
  | { kind: 'model'; identity: string }
  | { kind: 'object'; props: Map<string, string>; objectNode: ts.ObjectLiteralExpression }
  | { kind: 'plumbing' }
  | { kind: 'unknown' };

export class Scope {
  readonly bindings = new Map<string, Binding>();
  constructor(readonly parent: Scope | null, readonly isFunction: boolean) {}
  lookup(name: string): Binding | undefined {
    let s: Scope | null = this;
    while (s) {
      const b = s.bindings.get(name);
      if (b) return b;
      s = s.parent;
    }
    return undefined;
  }
}

export interface FunctionInfo {
  node: ts.Node;
  id: string;
  qname: string;
  isCallback: boolean;
  attributedTo: string;
  plumbing: boolean;
  /** `this.x()` inside resolves to export `x` of this file (inferred). */
  thisSibling: boolean;
  /** `this` refers to the actions2 / response context (this.req, this.res). */
  thisPlumbing: boolean;
  isArrow: boolean;
  span: Span;
  isAsync: boolean;
  params: string[];
}

export interface ExportInfo {
  /** export key -> function node id (only function-valued exports). */
  functions: Map<string, { nodeId: string; span: Span }>;
  /** The object literal assigned to module.exports, if any. */
  object: ts.ObjectLiteralExpression | null;
  /** module.exports = <function> */
  defaultFunction: string | null;
  /** All export keys including non-functions (for metadata). */
  keys: Map<string, ts.Expression>;
  /** module.exports = require('./x') */
  reexportModules: string[] | null;
  /** export { a } from './b' -> a: {modules, member} */
  reexportMembers: Map<string, { modules: string[]; member: string }>;
}

export interface ParseContext {
  relPath: string;
  sf: ts.SourceFile;
  category: FileCategory;
  fnInfo: Map<ts.Node, FunctionInfo>;
  scopes: Map<ts.Node, Scope>;
  fileScope: Scope;
  exports: ExportInfo;
  nodes: IRNode[];
  edges: IREdge[];
  references: RawReference[];
  registry: RegistryEntry[];
  diagnostics: Diagnostic[];
  records: FileRecord[];
  dependencies: FileDependency[];
  counts: Record<string, number>;
  fileNodeId: string;
  moduleNodeId: string;
  spanOf(node: ts.Node): Span;
  textOf(node: ts.Node, max?: number): string;
  lookupFunctionId(expr: ts.Expression, scope: Scope): string | null;
  emitReference(sourceNodeId: string, refKind: string, node: ts.Node | null, expression: string, spec: RefSpec, spanOverride?: Span): void;
  parseOptions: ParseOptions;
}

const MAX_DEPTH = 1500;

// ---------------------------------------------------------------------------

export function moduleCandidates(fromFile: string, spec: string): string[] | null {
  const base = resolvePosix(fromFile, spec);
  if (base === null) return null;
  if (/\.(c|m)?js$/.test(base) || base.endsWith('.json')) return [base];
  return [base, `${base}.js`, `${base}/index.js`];
}

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')));

export function packageName(spec: string): string {
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (BUILTINS.has(name) || BUILTINS.has(spec)) return `node:${BUILTINS.has(spec) ? spec : name}`;
  return name;
}

export function isRelativeSpec(spec: string): boolean {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

export function propertyKeyName(name: ts.PropertyName | ts.Expression | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return stringLiteralValue(name.expression);
  return undefined;
}

export function formatKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function joinName(prefix: string, local: string): string {
  if (!prefix) return local.startsWith('.') ? local.slice(1) : local;
  if (local.startsWith('[') || local.startsWith('.')) return prefix + local;
  return `${prefix}.${local}`;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  return e;
}

/** `require('x')` with a literal string -> 'x'; non-literal -> null; not require -> undefined. */
export function requireSpecifier(node: ts.Node, scope: Scope | null): string | null | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') return undefined;
  if (scope && scope.lookup('require')) return undefined; // shadowed require
  if (node.arguments.length !== 1) return null;
  const v = stringLiteralValue(node.arguments[0]);
  return v ?? null;
}

/** Text of a static member chain like module.exports.foo or a.b["c"]; null if not static. */
export function chainText(expr: ts.Expression): string | null {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(e)) {
    const base = chainText(e.expression);
    return base === null ? null : base + formatKey(e.name.text);
  }
  if (ts.isElementAccessExpression(e)) {
    const base = chainText(e.expression);
    const k = stringLiteralValue(e.argumentExpression);
    return base === null || k === undefined ? null : base + formatKey(k);
  }
  return null;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      bindingNames(el.name, out);
    }
  return out;
}

// ---------------------------------------------------------------------------

export function parseFile(relPath: string, content: string, opts: ParseOptions = {}): ParsedFile {
  try {
    return parseFileUnsafe(relPath, content, opts);
  } catch (err) {
    if (!(err instanceof RangeError) && (err as Error)?.message !== 'AST_TOO_DEEP') throw err;
    const fileNodeId = `file:${relPath}`;
    return {
      path: relPath,
      sha256: sha256(content),
      sizeBytes: Buffer.byteLength(content),
      parseOk: false,
      nodes: [{ id: fileNodeId, kind: 'FILE', name: path.posix.basename(relPath), filePath: relPath, span: null, attributes: {} }],
      edges: [],
      references: [],
      registry: [],
      diagnostics: [{ code: 'PARSE_ERROR', severity: 'error', message: 'Source nesting too deep to analyze safely.', filePath: relPath }],
      records: [],
      dependencies: [],
      counts: {},
    };
  }
}

function parseFileUnsafe(relPath: string, content: string, opts: ParseOptions): ParsedFile {
  const hash = sha256(content);
  const sf = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fileNodeId = `file:${relPath}`;
  const moduleNodeId = `module:${relPath}`;
  const category = categorize(relPath);
  const lineCount = sf.getLineStarts().length;

  const result: ParsedFile = {
    path: relPath,
    sha256: hash,
    sizeBytes: Buffer.byteLength(content),
    parseOk: true,
    nodes: [],
    edges: [],
    references: [],
    registry: [],
    diagnostics: [],
    records: [],
    dependencies: [],
    counts: { external: 0, plumbing: 0 },
  };

  const parseDiagnostics: readonly ts.DiagnosticWithLocation[] = (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  const spanOf = (node: ts.Node): Span => {
    const start = node.getStart(sf);
    const end = node.getEnd();
    const s = sf.getLineAndCharacterOfPosition(start);
    const e = sf.getLineAndCharacterOfPosition(end);
    return { startLine: s.line + 1, startCol: s.character + 1, endLine: e.line + 1, endCol: e.character + 1, startOffset: start, endOffset: end };
  };
  const fileSpan: Span = {
    startLine: 1,
    startCol: 1,
    endLine: lineCount,
    endCol: content.length - (sf.getLineStarts()[lineCount - 1] ?? 0) + 1,
    startOffset: 0,
    endOffset: content.length,
  };

  result.nodes.push({ id: fileNodeId, kind: 'FILE', name: path.posix.basename(relPath), filePath: relPath, span: fileSpan, attributes: { category } });
  result.nodes.push({ id: moduleNodeId, kind: 'MODULE', name: relPath, filePath: relPath, span: fileSpan, attributes: {} });
  result.registry.push({ key: `module:${relPath}`, nodeId: moduleNodeId });
  result.registry.push({ key: `node:${fileNodeId}`, nodeId: fileNodeId });
  result.edges.push(structural(fileNodeId, moduleNodeId, 'CONTAINS'));

  if (parseDiagnostics.length > 0) {
    result.parseOk = false;
    for (const d of parseDiagnostics.slice(0, 5)) {
      const pos = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
      result.diagnostics.push({
        code: 'PARSE_ERROR',
        severity: 'error',
        message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
        filePath: relPath,
        span: { startLine: pos.line + 1, startCol: pos.character + 1, endLine: pos.line + 1, endCol: pos.character + 1, startOffset: d.start ?? 0, endOffset: d.start ?? 0 },
      });
    }
    return result;
  }

  const textOf = (node: ts.Node, max = 160): string => {
    const t = node.getText(sf).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 3)}...` : t;
  };

  const refIds = new Map<string, number>();
  const ctx: ParseContext = {
    relPath,
    sf,
    category,
    fnInfo: new Map(),
    scopes: new Map(),
    fileScope: new Scope(null, true),
    exports: {
      functions: new Map(),
      object: null,
      defaultFunction: null,
      keys: new Map(),
      reexportModules: null,
      reexportMembers: new Map(),
    },
    nodes: result.nodes,
    edges: result.edges,
    references: result.references,
    registry: result.registry,
    diagnostics: result.diagnostics,
    records: result.records,
    dependencies: result.dependencies,
    counts: result.counts,
    fileNodeId,
    moduleNodeId,
    spanOf,
    textOf,
    lookupFunctionId: () => null,
    parseOptions: opts,
    emitReference(sourceNodeId, refKind, node, expression, spec, spanOverride) {
      const span = spanOverride ?? spanOf(node!);
      const base = `ref:${relPath}:${span.startLine}:${span.startCol}:${refKind}`;
      const n = (refIds.get(base) ?? 0) + 1;
      refIds.set(base, n);
      const id = n === 1 ? base : `${base}:${n}`;
      result.references.push({ id, sourceNodeId, refKind, expression, span, spec });
    },
  };
  ctx.scopes.set(sf, ctx.fileScope);
  ctx.lookupFunctionId = (expr, scope) => {
    const e = unwrap(expr);
    if (isFunctionLike(e)) return ctx.fnInfo.get(e)?.id ?? null;
    if (ts.isClassExpression(e)) return null;
    if (ts.isIdentifier(e)) {
      const b = scope.lookup(e.text);
      return b && b.kind === 'function' ? b.nodeId : null;
    }
    return null;
  };

  try {
    const pre = new PrePass(ctx);
    pre.run();
    collectExports(ctx);
    const main = new MainPass(ctx, opts);
    main.run();
    // Function nodes
    for (const info of [...ctx.fnInfo.values()].sort((a, b) => a.span.startOffset - b.span.startOffset)) {
      const attrs: Record<string, unknown> = { qualifiedName: info.qname, async: info.isAsync, params: info.params };
      if (info.isCallback) {
        attrs.inlineCallback = true;
        if (info.attributedTo !== info.id) attrs.callsAttributedTo = info.attributedTo;
      }
      if (info.qname.includes('$anon')) attrs.anonymous = true;
      result.nodes.push({ id: info.id, kind: 'FUNCTION', name: info.qname, filePath: relPath, span: info.span, attributes: attrs });
      result.registry.push({ key: `node:${info.id}`, nodeId: info.id });
      result.edges.push(structural(fileNodeId, info.id, 'CONTAINS'));
    }
    // Exports
    for (const [key, fn] of [...ctx.exports.functions.entries()].sort()) {
      result.registry.push({ key: `export:${relPath}#${key}`, nodeId: fn.nodeId });
    }
    if (ctx.exports.reexportModules) {
      result.registry.push({ key: `reexport-from:${relPath}`, nodeId: moduleNodeId });
      result.records.push({ kind: 'reexport', data: { modules: ctx.exports.reexportModules } });
    }
    if (ctx.exports.reexportMembers.size) {
      const members: Record<string, { modules: string[]; member: string }> = {};
      for (const [k, v] of ctx.exports.reexportMembers) {
        members[k] = v;
        result.registry.push({ key: `reexport-member:${relPath}#${k}`, nodeId: moduleNodeId });
      }
      result.records.push({ kind: 'reexport_members', data: members });
    }
    extractSailsEntities(ctx);
    if (category === 'routes' || category === 'config_other') extractRouteFragment(ctx);
    if (category === 'policies_config') extractPoliciesConfig(ctx);
    if (category === 'globals') extractGlobalsConfig(ctx);
  } catch (err) {
    if (err instanceof RangeError || (err as Error)?.message === 'AST_TOO_DEEP') {
      result.parseOk = false;
      result.diagnostics.push({ code: 'PARSE_ERROR', severity: 'error', message: 'Source nesting too deep to analyze safely.', filePath: relPath });
      return result;
    }
    throw err;
  }

  dedupeRegistry(result);
  return result;
}

function dedupeRegistry(result: ParsedFile): void {
  const seen = new Set<string>();
  result.registry = result.registry.filter((r) => {
    const k = `${r.key}\u0000${r.nodeId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function structural(source: string, target: string, kind: IREdge['kind'], attributes: Record<string, unknown> = {}): IREdge {
  return { source, target, kind, resolution: 'static', confidence: 'high', attributes, evidence: null };
}

// ---------------------------------------------------------------------------
// Pre-pass: scopes, bindings, function naming

class PrePass {
  private scopeStack: Scope[];
  private fnStack: (FunctionInfo | null)[] = [null];
  private usedNames = new Set<string>();
  private anonCounters = new Map<string, number>();
  private objectOwners = new Map<ts.Node, string>();
  private depth = 0;

  constructor(private ctx: ParseContext) {
    this.scopeStack = [ctx.fileScope];
  }

  run(): void {
    this.hoist(this.ctx.sf.statements, this.ctx.fileScope);
    for (const st of this.ctx.sf.statements) this.visit(st);
  }

  private get scope(): Scope {
    return this.scopeStack[this.scopeStack.length - 1];
  }

  private nearestFunctionScope(): Scope {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) if (this.scopeStack[i].isFunction) return this.scopeStack[i];
    return this.ctx.fileScope;
  }

  private get enclosingFn(): FunctionInfo | null {
    return this.fnStack[this.fnStack.length - 1];
  }

  private anonName(): string {
    const key = this.enclosingFn?.id ?? '';
    const n = (this.anonCounters.get(key) ?? 0) + 1;
    this.anonCounters.set(key, n);
    return `$anon${n}`;
  }

  private objectOwner(obj: ts.ObjectLiteralExpression): string {
    const cached = this.objectOwners.get(obj);
    if (cached !== undefined) return cached;
    let owner: string | null = null;
    let p: ts.Node = obj.parent;
    let child: ts.Node = obj;
    while (ts.isParenthesizedExpression(p)) {
      child = p;
      p = p.parent;
    }
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer === child) owner = p.name.text;
    else if ((ts.isPropertyAssignment(p)) && ts.isObjectLiteralExpression(p.parent)) {
      const k = propertyKeyName(p.name);
      owner = k === undefined ? null : joinName(this.objectOwner(p.parent), formatKey(k));
    } else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === child) {
      owner = chainText(p.left);
    } else if (ts.isExportAssignment(p)) owner = 'default';
    if (owner === null) owner = `$obj${this.anonName().slice(5)}`;
    this.objectOwners.set(obj, owner);
    return owner;
  }

  private localFunctionName(fn: ts.Node): { local: string; isCallback: boolean } {
    if (ts.isFunctionDeclaration(fn)) {
      if (fn.name) return { local: fn.name.text, isCallback: false };
      return { local: 'default', isCallback: false };
    }
    if ((ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) && ts.isObjectLiteralExpression(fn.parent)) {
      const k = propertyKeyName(fn.name);
      return { local: joinName(this.objectOwner(fn.parent), formatKey(k ?? this.anonName())), isCallback: false };
    }
    if (ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
      const cls = fn.parent;
      const className = (ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name ? cls.name.text : classOwnerName(cls) ?? 'class';
      const m = ts.isConstructorDeclaration(fn) ? 'constructor' : propertyKeyName(fn.name) ?? this.anonName();
      const isStatic = ts.canHaveModifiers(fn) && (ts.getModifiers(fn) ?? []).some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
      return { local: joinName(className, formatKey(isStatic ? m : m)), isCallback: false };
    }
    let p: ts.Node = fn.parent;
    let child: ts.Node = fn;
    while (ts.isParenthesizedExpression(p)) {
      child = p;
      p = p.parent;
    }
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return { local: p.name.text, isCallback: false };
    if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.parent)) {
      const k = propertyKeyName(p.name);
      return { local: joinName(this.objectOwner(p.parent), formatKey(k ?? this.anonName())), isCallback: false };
    }
    if (ts.isPropertyDeclaration(p) && (ts.isClassDeclaration(p.parent) || ts.isClassExpression(p.parent))) {
      const cls = p.parent;
      const className = cls.name ? cls.name.text : classOwnerName(cls) ?? 'class';
      return { local: joinName(className, formatKey(propertyKeyName(p.name) ?? this.anonName())), isCallback: false };
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === child) {
      const t = chainText(p.left);
      if (t) return { local: t, isCallback: false };
    }
    if (ts.isExportAssignment(p)) return { local: 'default', isCallback: false };
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.some((a) => a === child)) {
      if ((ts.isFunctionExpression(fn)) && fn.name) return { local: fn.name.text, isCallback: true };
      return { local: this.anonName(), isCallback: true };
    }
    if (ts.isFunctionExpression(fn) && fn.name) return { local: fn.name.text, isCallback: false };
    return { local: this.anonName(), isCallback: false };
  }

  ensureFnInfo(fn: ts.FunctionLikeDeclaration): FunctionInfo {
    const existing = this.ctx.fnInfo.get(fn);
    if (existing) return existing;
    const enclosing = this.enclosingFn;
    const { local, isCallback } = this.localFunctionName(fn);
    let qname = enclosing ? joinName(enclosing.qname, local) : local;
    if (this.usedNames.has(qname)) {
      let i = 2;
      while (this.usedNames.has(`${qname}#${i}`)) i++;
      qname = `${qname}#${i}`;
    }
    this.usedNames.add(qname);
    const id = `function:${this.ctx.relPath}::${qname}`;
    const isArrow = ts.isArrowFunction(fn);
    const { plumbing, thisPlumbing } = frameworkRole(this.ctx, qname, fn, enclosing);
    const thisSibling =
      !isArrow &&
      !thisPlumbing &&
      /^(module\.)?exports\.[A-Za-z_$][\w$]*$/.test(qname) &&
      this.ctx.category !== 'helper' &&
      !(this.ctx.category === 'controller' && qname === 'module.exports.fn');
    const info: FunctionInfo = {
      node: fn,
      id,
      qname,
      isCallback,
      attributedTo: isCallback && enclosing ? enclosing.attributedTo : id,
      plumbing,
      thisSibling,
      thisPlumbing,
      isArrow,
      span: this.ctx.spanOf(fn),
      isAsync: (ts.getModifiers(fn as ts.HasModifiers) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      params: fn.parameters.flatMap((p) => bindingNames(p.name)),
    };
    this.ctx.fnInfo.set(fn, info);
    return info;
  }

  /** Declare hoisted function declarations and var names of a statement list into scope. */
  private hoist(statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[], scope: Scope): void {
    for (const st of statements) {
      if (ts.isFunctionDeclaration(st) && st.name) {
        const info = this.ensureFnInfo(st);
        scope.bindings.set(st.name.text, { kind: 'function', nodeId: info.id });
      } else if (ts.isClassDeclaration(st) && st.name) {
        scope.bindings.set(st.name.text, { kind: 'unknown' });
      } else if (ts.isImportDeclaration(st)) {
        this.declareImport(st, scope);
      }
    }
  }

  private declareImport(st: ts.ImportDeclaration, scope: Scope): void {
    const spec = stringLiteralValue(st.moduleSpecifier);
    const clause = st.importClause;
    if (spec === undefined || !clause) return;
    const rel = isRelativeSpec(spec);
    const modules = rel ? moduleCandidates(this.ctx.relPath, spec) : null;
    const mk = (member: string | null): Binding => {
      if (!rel) return { kind: 'package', name: packageName(spec) };
      if (!modules) return { kind: 'unknown' };
      return member === null ? { kind: 'module', modules } : { kind: 'module_member', modules, member };
    };
    if (clause.name) scope.bindings.set(clause.name.text, mk(null));
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) scope.bindings.set(nb.name.text, mk(null));
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) scope.bindings.set(el.name.text, mk(el.propertyName ? el.propertyName.text : el.name.text));
    }
  }

  private bindingFromInitializer(init: ts.Expression | undefined, scope: Scope): Binding {
    if (!init) return { kind: 'unknown' };
    const e = unwrap(init);
    if (isFunctionLike(e)) return { kind: 'function', nodeId: this.ensureFnInfo(e).id };
    const req = requireSpecifier(e, scope);
    if (typeof req === 'string') return this.requireBinding(req, null);
    if (ts.isPropertyAccessExpression(e)) {
      const inner = requireSpecifier(unwrap(e.expression), scope);
      if (typeof inner === 'string') return this.requireBinding(inner, e.name.text);
    }
    // sails.helpers.a.b / sails.models.x aliases
    const segs = staticSegments(e);
    if (segs && segs[0] === 'sails' && !scope.lookup('sails')) {
      if (segs[1] === 'helpers' && segs.length >= 3 && !segs.slice(2).some((s) => HELPER_INVOCATIONS.has(s))) {
        return { kind: 'helper', access: segs.slice(2).join('.') };
      }
      if (segs[1] === 'models' && segs.length === 3) return { kind: 'model', identity: segs[2].toLowerCase() };
    }
    if (ts.isIdentifier(e)) {
      const b = scope.lookup(e.text);
      if (b && (b.kind === 'function' || b.kind === 'module' || b.kind === 'module_member' || b.kind === 'helper' || b.kind === 'package')) return b;
    }
    return { kind: 'unknown' };
  }

  private requireBinding(spec: string, member: string | null): Binding {
    if (!isRelativeSpec(spec)) return { kind: 'package', name: packageName(spec) };
    const modules = moduleCandidates(this.ctx.relPath, spec);
    if (!modules) return { kind: 'unknown' };
    return member === null ? { kind: 'module', modules } : { kind: 'module_member', modules, member };
  }

  private declareVariable(decl: ts.VariableDeclaration, scope: Scope): void {
    if (ts.isIdentifier(decl.name)) {
      const init = decl.initializer ? unwrap(decl.initializer) : undefined;
      if (init && ts.isObjectLiteralExpression(init)) {
        scope.bindings.set(decl.name.text, { kind: 'object', props: new Map(), objectNode: init });
      } else {
        scope.bindings.set(decl.name.text, this.bindingFromInitializer(decl.initializer, scope));
      }
      return;
    }
    // Destructuring
    const init = decl.initializer ? unwrap(decl.initializer) : undefined;
    const req = init ? requireSpecifier(init, scope) : undefined;
    if (ts.isObjectBindingPattern(decl.name) && typeof req === 'string') {
      for (const el of decl.name.elements) {
        if (el.dotDotDotToken) {
          for (const n of bindingNames(el.name)) scope.bindings.set(n, { kind: 'unknown' });
          continue;
        }
        const prop = el.propertyName ? propertyKeyName(el.propertyName) : ts.isIdentifier(el.name) ? el.name.text : undefined;
        if (ts.isIdentifier(el.name) && prop) scope.bindings.set(el.name.text, this.requireBinding(req, prop));
        else for (const n of bindingNames(el.name)) scope.bindings.set(n, { kind: 'unknown' });
      }
      return;
    }
    for (const n of bindingNames(decl.name)) scope.bindings.set(n, { kind: 'unknown' });
  }

  private visit(node: ts.Node): void {
    if (++this.depth > MAX_DEPTH) throw new Error('AST_TOO_DEEP');
    try {
      this.visitInner(node);
    } finally {
      this.depth--;
    }
  }

  private visitInner(node: ts.Node): void {
    if (isFunctionLike(node)) {
      const info = this.ensureFnInfo(node);
      const fnScope = new Scope(this.scope, true);
      this.ctx.scopes.set(node, fnScope);
      if (ts.isFunctionExpression(node) && node.name) fnScope.bindings.set(node.name.text, { kind: 'function', nodeId: info.id });
      for (const p of node.parameters) {
        for (const n of bindingNames(p.name)) fnScope.bindings.set(n, info.plumbing ? { kind: 'plumbing' } : { kind: 'unknown' });
      }
      this.scopeStack.push(fnScope);
      this.fnStack.push(info);
      for (const p of node.parameters) if (p.initializer) this.visit(p.initializer);
      if (node.body) {
        if (ts.isBlock(node.body)) {
          this.hoist(node.body.statements, fnScope);
          this.ctx.scopes.set(node.body, fnScope);
          for (const st of node.body.statements) this.visit(st);
        } else this.visit(node.body);
      }
      this.fnStack.pop();
      this.scopeStack.pop();
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      ts.forEachChild(node, (c) => this.visit(c));
      return;
    }
    if (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCatchClause(node)) {
      const s = new Scope(this.scope, false);
      this.ctx.scopes.set(node, s);
      this.scopeStack.push(s);
      if (ts.isBlock(node)) this.hoist(node.statements, s);
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        for (const n of bindingNames(node.variableDeclaration.name)) s.bindings.set(n, { kind: 'unknown' });
      }
      ts.forEachChild(node, (c) => this.visit(c));
      this.scopeStack.pop();
      return;
    }
    if (ts.isVariableDeclarationList(node)) {
      const isVar = (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
      const target = isVar ? this.nearestFunctionScope() : this.scope;
      for (const d of node.declarations) {
        this.declareVariable(d, target);
      }
      for (const d of node.declarations) {
        if (d.initializer) this.visit(d.initializer);
        // Fill object-literal bindings now that property functions are named.
        if (ts.isIdentifier(d.name)) {
          const b = target.bindings.get(d.name.text);
          if (b && b.kind === 'object') fillObjectProps(this.ctx, b, target);
        }
      }
      return;
    }
    ts.forEachChild(node, (c) => this.visit(c));
  }
}

function classOwnerName(cls: ts.Node): string | null {
  const p = cls.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isBinaryExpression(p)) return chainText(p.left);
  return null;
}

function fillObjectProps(ctx: ParseContext, b: Extract<Binding, { kind: 'object' }>, scope: Scope): void {
  for (const prop of b.objectNode.properties) {
    const key = propertyKeyName(prop.name);
    if (key === undefined) continue;
    if (ts.isMethodDeclaration(prop)) {
      const id = ctx.fnInfo.get(prop)?.id;
      if (id) b.props.set(key, id);
    } else if (ts.isPropertyAssignment(prop)) {
      const id = ctx.lookupFunctionId(prop.initializer, scope);
      if (id) b.props.set(key, id);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      const bb = scope.lookup(prop.name.text);
      if (bb && bb.kind === 'function') b.props.set(key, bb.nodeId);
    }
  }
}

/** Determine whether a function's params are Sails plumbing (req/res/exits...). */
function frameworkRole(ctx: ParseContext, qname: string, fn: ts.Node, enclosing: FunctionInfo | null): { plumbing: boolean; thisPlumbing: boolean } {
  if (enclosing) return { plumbing: false, thisPlumbing: false };
  const c = ctx.category;
  const isClassicFile = c === 'controller' && /Controller\.js$/.test(ctx.relPath);
  if ((c === 'helper' || c === 'controller' || c === 'policy') && qname === 'module.exports.fn') return { plumbing: true, thisPlumbing: true };
  if ((c === 'controller' || c === 'policy' || c === 'response') && (qname === 'module.exports' || qname === 'default')) {
    return { plumbing: true, thisPlumbing: c === 'response' };
  }
  if (isClassicFile && /^(module\.)?exports\.[A-Za-z_$][\w$]*$/.test(qname)) return { plumbing: true, thisPlumbing: false };
  if ((c === 'routes' || c === 'config_other') && (qname.startsWith('module.exports.routes[') || qname.startsWith('module.exports['))) {
    return { plumbing: true, thisPlumbing: false };
  }
  void fn;
  return { plumbing: false, thisPlumbing: false };
}

/** Static identifier/member segments of an expression (a.b['c'].d) or null. */
export function staticSegments(expr: ts.Expression): string[] | null {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return [e.text];
  if (ts.isPropertyAccessExpression(e)) {
    const b = staticSegments(e.expression);
    return b ? [...b, e.name.text] : null;
  }
  if (ts.isElementAccessExpression(e)) {
    const b = staticSegments(e.expression);
    const k = stringLiteralValue(e.argumentExpression);
    return b && k !== undefined ? [...b, k] : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exports

function collectExports(ctx: ParseContext): void {
  const ex = ctx.exports;
  const scope = ctx.fileScope;
  const setObject = (obj: ts.ObjectLiteralExpression) => {
    ex.object = obj;
    for (const prop of obj.properties) {
      const key = propertyKeyName(prop.name);
      if (key === undefined) continue;
      if (ts.isPropertyAssignment(prop)) {
        ex.keys.set(key, prop.initializer);
        const id = ctx.lookupFunctionId(prop.initializer, scope);
        if (id) ex.functions.set(key, { nodeId: id, span: ctx.spanOf(prop) });
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        ex.keys.set(key, prop.name);
        const b = scope.lookup(prop.name.text);
        if (b && b.kind === 'function') ex.functions.set(key, { nodeId: b.nodeId, span: ctx.spanOf(prop) });
      } else if (ts.isMethodDeclaration(prop)) {
        const id = ctx.fnInfo.get(prop)?.id;
        if (id) ex.functions.set(key, { nodeId: id, span: ctx.spanOf(prop) });
      }
    }
  };
  for (const st of ctx.sf.statements) {
    if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      handleAssignment(st.expression);
    }
    // ESM
    if (ts.isFunctionDeclaration(st) && st.name && hasExport(st)) {
      const id = ctx.fnInfo.get(st)?.id;
      const isDefault = hasDefault(st);
      if (id) ex.functions.set(isDefault ? 'default' : st.name.text, { nodeId: id, span: ctx.spanOf(st) });
      if (id && isDefault) ex.defaultFunction = id;
    } else if (ts.isFunctionDeclaration(st) && !st.name && hasDefault(st)) {
      const id = ctx.fnInfo.get(st)?.id;
      if (id) {
        ex.functions.set('default', { nodeId: id, span: ctx.spanOf(st) });
        ex.defaultFunction = id;
      }
    } else if (ts.isVariableStatement(st) && hasExport(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) {
          const id = ctx.lookupFunctionId(d.initializer, scope);
          if (id) ex.functions.set(d.name.text, { nodeId: id, span: ctx.spanOf(d) });
        }
      }
    } else if (ts.isExportAssignment(st)) {
      const e = unwrap(st.expression);
      const id = ctx.lookupFunctionId(e, scope);
      if (id) {
        ex.functions.set('default', { nodeId: id, span: ctx.spanOf(st) });
        ex.defaultFunction = id;
      } else if (ts.isObjectLiteralExpression(e)) setObject(e);
    } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      const from = st.moduleSpecifier ? stringLiteralValue(st.moduleSpecifier) : undefined;
      for (const el of st.exportClause.elements) {
        const exported = el.name.text;
        const localName = el.propertyName ? el.propertyName.text : el.name.text;
        if (from !== undefined) {
          const modules = isRelativeSpec(from) ? moduleCandidates(ctx.relPath, from) : null;
          if (modules) ex.reexportMembers.set(exported, { modules, member: localName });
        } else {
          const b = scope.lookup(localName);
          if (b && b.kind === 'function') ex.functions.set(exported, { nodeId: b.nodeId, span: ctx.spanOf(el) });
          else if (b && b.kind === 'module_member') ex.reexportMembers.set(exported, { modules: b.modules, member: b.member });
        }
      }
    }
  }

  function handleAssignment(bin: ts.BinaryExpression) {
    const left = chainText(bin.left);
    if (!left) return;
    const right = unwrap(bin.right);
    if (left === 'module.exports') {
      if (ts.isObjectLiteralExpression(right)) {
        setObject(right);
        return;
      }
      const fnId = ctx.lookupFunctionId(right, scope);
      if (fnId) {
        ex.functions.set('default', { nodeId: fnId, span: ctx.spanOf(bin) });
        ex.defaultFunction = fnId;
        return;
      }
      if (ts.isIdentifier(right)) {
        const b = scope.lookup(right.text);
        if (b && b.kind === 'object') {
          setObject(b.objectNode);
          return;
        }
        if (b && b.kind === 'module') {
          ex.reexportModules = b.modules;
          return;
        }
      }
      const req = requireSpecifier(right, scope);
      if (typeof req === 'string' && isRelativeSpec(req)) {
        const m = moduleCandidates(ctx.relPath, req);
        if (m) ex.reexportModules = m;
      }
      return;
    }
    const m = /^(?:module\.exports|exports)(\.[A-Za-z_$][\w$]*|\[".*"\])$/.exec(left);
    if (m) {
      const key = m[1].startsWith('.') ? m[1].slice(1) : JSON.parse(m[1].slice(1, -1));
      ex.keys.set(key, right);
      const fnId = ctx.lookupFunctionId(right, scope);
      if (fnId) ex.functions.set(key, { nodeId: fnId, span: ctx.spanOf(bin) });
      else {
        // module.exports.x = require('./y').x
        if (ts.isPropertyAccessExpression(right)) {
          const req = requireSpecifier(unwrap(right.expression), scope);
          if (typeof req === 'string' && isRelativeSpec(req)) {
            const mods = moduleCandidates(ctx.relPath, req);
            if (mods) ex.reexportMembers.set(key, { modules: mods, member: right.name.text });
          }
        } else if (ts.isIdentifier(right)) {
          const b = scope.lookup(right.text);
          if (b && b.kind === 'module_member') ex.reexportMembers.set(key, { modules: b.modules, member: b.member });
        }
      }
    }
  }
}

function hasExport(n: ts.Node): boolean {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}
function hasDefault(n: ts.Node): boolean {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

// ---------------------------------------------------------------------------
// Main pass: references

type Link =
  | { t: 'prop'; name: string; node: ts.Node }
  | { t: 'elem'; literal?: string; node: ts.ElementAccessExpression }
  | { t: 'call'; node: ts.CallExpression };

type Root =
  | { t: 'ident'; name: string; node: ts.Identifier }
  | { t: 'this'; node: ts.Node }
  | { t: 'require'; spec: string; node: ts.CallExpression };

class MainPass {
  private scopeStack: Scope[];
  private fnStack: (FunctionInfo | null)[] = [null];
  private externalGlobals: Set<string>;
  private depth = 0;

  constructor(private ctx: ParseContext, opts: ParseOptions) {
    this.scopeStack = [ctx.fileScope];
    this.externalGlobals = new Set(opts.externalGlobals ?? []);
  }

  run(): void {
    for (const st of this.ctx.sf.statements) this.visit(st);
  }

  private get scope(): Scope {
    return this.scopeStack[this.scopeStack.length - 1];
  }

  /** The function a reference made here is attributed to. */
  private get source(): string {
    const fn = this.fnStack[this.fnStack.length - 1];
    return fn ? fn.attributedTo : this.ctx.moduleNodeId;
  }

  /** Nearest non-arrow function (for `this`). */
  private get thisFn(): FunctionInfo | null {
    for (let i = this.fnStack.length - 1; i >= 0; i--) {
      const f = this.fnStack[i];
      if (!f) return null;
      if (!f.isArrow) return f;
    }
    return null;
  }

  private count(cls: string, n = 1): void {
    this.ctx.counts[cls] = (this.ctx.counts[cls] ?? 0) + n;
  }

  private visit(node: ts.Node): void {
    if (++this.depth > MAX_DEPTH) throw new Error('AST_TOO_DEEP');
    try {
      this.visitInner(node);
    } finally {
      this.depth--;
    }
  }

  private visitInner(node: ts.Node): void {
    const scope = this.ctx.scopes.get(node);
    const fn = isFunctionLike(node) ? this.ctx.fnInfo.get(node) ?? null : undefined;
    const pushedScope = !!scope && scope !== this.scope;
    if (pushedScope) this.scopeStack.push(scope!);
    if (fn !== undefined) this.fnStack.push(fn);
    try {
      if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        if (this.isOutermostChain(node)) {
          this.handleChain(node as ts.Expression);
          return;
        }
      }
      if (ts.isIdentifier(node)) {
        this.handleIdentifierValue(node);
        return;
      }
      if (ts.isImportDeclaration(node)) {
        const spec = stringLiteralValue(node.moduleSpecifier);
        if (spec !== undefined) this.emitImport(spec, node, node.moduleSpecifier);
        return;
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const spec = stringLiteralValue(node.moduleSpecifier);
        if (spec !== undefined) this.emitImport(spec, node, node.moduleSpecifier);
        return;
      }
      if (ts.isPropertyAssignment(node)) {
        // Do not treat property names as identifier values.
        if (ts.isComputedPropertyName(node.name)) this.visit(node.name.expression);
        this.visit(node.initializer);
        return;
      }
      if (ts.isShorthandPropertyAssignment(node)) {
        this.handleIdentifierValue(node.name, true);
        return;
      }
      if (ts.isVariableDeclaration(node)) {
        if (node.initializer) this.visit(node.initializer);
        return;
      }
      if (isFunctionLike(node)) {
        for (const p of node.parameters) if (p.initializer) this.visit(p.initializer);
        if (node.body) this.visit(node.body);
        return;
      }
      ts.forEachChild(node, (c) => this.visit(c));
    } finally {
      if (fn !== undefined) this.fnStack.pop();
      if (pushedScope) this.scopeStack.pop();
    }
  }

  private isOutermostChain(node: ts.Node): boolean {
    const p = node.parent;
    if (!p) return true;
    if (ts.isPropertyAccessExpression(p) && p.expression === node) return false;
    if (ts.isElementAccessExpression(p) && p.expression === node) return false;
    if (ts.isCallExpression(p) && p.expression === node) return false;
    return true;
  }

  private flatten(expr: ts.Expression): { root: Root | null; rootExpr: ts.Expression; links: Link[] } {
    const links: Link[] = [];
    let e: ts.Expression = expr;
    for (;;) {
      if (ts.isPropertyAccessExpression(e)) {
        links.unshift({ t: 'prop', name: e.name.text, node: e });
        e = e.expression;
      } else if (ts.isElementAccessExpression(e)) {
        links.unshift({ t: 'elem', literal: stringLiteralValue(e.argumentExpression), node: e });
        e = e.expression;
      } else if (ts.isCallExpression(e)) {
        const req = requireSpecifier(e, this.scope);
        if (typeof req === 'string') return { root: { t: 'require', spec: req, node: e }, rootExpr: e, links };
        if (req === null) return { root: null, rootExpr: e, links };
        links.unshift({ t: 'call', node: e });
        e = e.expression;
      } else if (ts.isNonNullExpression(e)) {
        e = e.expression;
      } else break;
    }
    if (ts.isIdentifier(e)) return { root: { t: 'ident', name: e.text, node: e }, rootExpr: e, links };
    if (e.kind === ts.SyntaxKind.ThisKeyword) return { root: { t: 'this', node: e }, rootExpr: e, links };
    return { root: null, rootExpr: e, links };
  }

  /** Visit nested expressions inside a chain (call args, computed keys). */
  private visitChainChildren(links: Link[]): void {
    for (const l of links) {
      if (l.t === 'call') for (const a of l.node.arguments) this.visit(a);
      if (l.t === 'elem') this.visit(l.node.argumentExpression);
    }
  }

  private exprText(rootText: string, links: Link[], upto = links.length): string {
    let s = rootText;
    for (let i = 0; i < upto; i++) {
      const l = links[i];
      if (l.t === 'prop') s += `.${l.name}`;
      else if (l.t === 'elem') s += l.literal !== undefined ? `[${JSON.stringify(l.literal).replace(/"/g, "'")}]` : `[${this.ctx.textOf(l.node.argumentExpression, 40)}]`;
      else s += '(...)';
    }
    return s.length > 200 ? `${s.slice(0, 197)}...` : s;
  }

  private nodeForSpan(links: Link[], idx: number, fallback: ts.Node): ts.Node {
    // The span of a reference covers the chain up to and including link idx.
    if (idx >= 0 && idx < links.length) return links[idx].node;
    return fallback;
  }

  private handleChain(expr: ts.Expression): void {
    const { root, rootExpr, links } = this.flatten(expr);
    if (!root) {
      // Unknown-origin base, e.g. (await x).foo() or result.items.map(...)
      if (rootExpr !== expr) this.visit(rootExpr);
      else ts.forEachChild(expr, (c) => this.visit(c));
      this.visitChainChildren(links);
      // dynamic require(x)
      if (ts.isCallExpression(rootExpr) && ts.isIdentifier(rootExpr.expression) && rootExpr.expression.text === 'require' && !this.scope.lookup('require')) {
        this.ctx.emitReference(this.ctx.moduleNodeId, 'import', rootExpr, this.ctx.textOf(rootExpr, 80), {
          type: 'preset',
          status: 'unresolved_dynamic',
          reason: 'computed_require',
        });
      }
      return;
    }
    try {
      if (root.t === 'require') {
        this.emitImport(root.spec, root.node, root.node.arguments[0]);
        if (links.length) this.handleModuleChain({ kind: 'module', modules: [] }, root, links, root.spec);
        return;
      }
      if (root.t === 'this') {
        this.handleThis(root, links);
        return;
      }
      this.handleIdentChain(root, links);
    } finally {
      this.visitChainChildren(links);
    }
  }

  private isValueContext(node: ts.Node): boolean {
    const p = node.parent;
    if (!p) return false;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.some((a) => a === node)) return true;
    if (ts.isPropertyAssignment(p) && p.initializer === node) return !this.isModuleExportsObject(p.parent);
    if (ts.isShorthandPropertyAssignment(p)) return !this.isModuleExportsObject(p.parent);
    if (ts.isArrayLiteralExpression(p)) return true;
    if (ts.isVariableDeclaration(p) && p.initializer === node) return true;
    return false;
  }

  private isModuleExportsObject(obj: ts.Node): boolean {
    return this.ctx.exports.object === obj;
  }

  private handleIdentifierValue(id: ts.Identifier, shorthand = false): void {
    // Only identifiers used as values (passed / stored) matter here.
    const p = id.parent;
    if (!shorthand) {
      if (!p) return;
      if (ts.isPropertyAccessExpression(p) && p.name === id) return;
      if (!this.isValueContext(id)) return;
    } else if (this.isModuleExportsObject(p.parent)) return;
    const b = this.scope.lookup(id.text);
    if (!b) return;
    const expr = id.text;
    const target = shorthand ? p : id;
    if (b.kind === 'function') {
      if (b.nodeId === this.source) return;
      this.ctx.emitReference(this.source, 'reference', target, expr, { type: 'node', nodeId: b.nodeId, edge: 'REFERENCES' });
    } else if (b.kind === 'module_member') {
      this.ctx.emitReference(this.source, 'reference', target, expr, {
        type: 'module_member', modules: b.modules, member: b.member, edge: 'REFERENCES', resolution: 'static', confidence: 'high',
      });
    } else if (b.kind === 'helper') {
      // Alias declaration (const h = sails.helpers.x) already yields REFERENCES at the declaration.
      if (ts.isVariableDeclaration(p)) return;
      this.ctx.emitReference(this.source, 'reference', target, expr, {
        type: 'helper', access: b.access, edge: 'REFERENCES', call: { invocation: 'none', modifiers: [] },
      });
    }
  }

  private emitImport(spec: string, node: ts.Node, specNode: ts.Node): void {
    const expr = `require(${JSON.stringify(spec).replace(/"/g, "'")})`;
    void specNode;
    if (isRelativeSpec(spec)) {
      const mods = moduleCandidates(this.ctx.relPath, spec);
      if (!mods) {
        this.ctx.emitReference(this.ctx.moduleNodeId, 'import', node, expr, { type: 'preset', status: 'unresolved_missing', reason: 'outside_root' });
        return;
      }
      if (mods.length === 1 && mods[0].endsWith('.json')) {
        this.ctx.emitReference(this.ctx.moduleNodeId, 'import', node, expr, { type: 'json', path: mods[0] });
        return;
      }
      this.ctx.emitReference(this.ctx.moduleNodeId, 'import', node, expr, { type: 'import', modules: mods });
      return;
    }
    if (spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) {
      this.ctx.emitReference(this.ctx.moduleNodeId, 'import', node, expr, { type: 'preset', status: 'unresolved_missing', reason: 'outside_root' });
      return;
    }
    this.ctx.emitReference(this.ctx.moduleNodeId, 'import', node, expr, { type: 'package', name: packageName(spec) });
  }

  private handleThis(root: Extract<Root, { t: 'this' }>, links: Link[]): void {
    const tf = this.thisFn;
    if (!tf) return;
    if (tf.thisPlumbing) {
      this.count('plumbing');
      return;
    }
    if (!tf.thisSibling) return;
    const first = links[0];
    if (!first || first.t === 'call') return;
    if (first.t === 'elem' && first.literal === undefined) {
      if (links[1]?.t === 'call') {
        this.ctx.emitReference(this.source, 'call', links[1].node, this.exprText('this', links, 2), {
          type: 'preset', status: 'unresolved_dynamic', reason: 'computed_member',
        });
      }
      return;
    }
    const member = first.t === 'prop' ? first.name : first.literal!;
    const called = links[1]?.t === 'call';
    if (!called && !(links.length === 1 && this.isValueContext(first.node))) return;
    const spanNode = called ? links[1].node : first.node;
    this.ctx.emitReference(this.source, called ? 'call' : 'reference', spanNode, this.exprText('this', links, called ? 2 : 1), {
      type: 'module_member', modules: [this.ctx.relPath], member, edge: called ? 'CALLS' : 'REFERENCES', resolution: 'inferred', confidence: 'medium', self: true,
    });
    void root;
  }

  private handleIdentChain(root: Extract<Root, { t: 'ident' }>, links: Link[]): void {
    const name = root.name;
    const b = this.scope.lookup(name);
    if (b) {
      this.handleBoundChain(b, root, links);
      return;
    }
    // Free identifiers
    if (links.length === 0) return;
    if (name === 'sails') {
      this.handleSails(root, links);
      return;
    }
    if (name === 'module' || name === 'exports') {
      // module.exports.x() / exports.x()
      const off = name === 'module' ? 1 : 0;
      if (name === 'module' && !(links[0]?.t === 'prop' && links[0].name === 'exports')) return;
      const l = links[off];
      const call = links[off + 1];
      if (l && l.t === 'prop' && call && call.t === 'call') {
        this.ctx.emitReference(this.source, 'call', call.node, this.exprText(name, links, off + 2), {
          type: 'module_member', modules: [this.ctx.relPath], member: l.name, edge: 'CALLS', resolution: 'static', confidence: 'high', self: true,
        });
      }
      return;
    }
    if (name === 'require') return;
    if (KNOWN_GLOBALS.has(name) || SAILS_EXTERNAL_GLOBALS.has(name) || this.externalGlobals.has(name)) {
      if (links.some((l) => l.t === 'call')) this.count('external');
      return;
    }
    const first = links[0];
    if (first.t === 'call') {
      this.ctx.emitReference(this.source, 'call', first.node, this.exprText(name, links, 1), {
        type: 'preset', status: 'unresolved_missing', reason: 'unknown_global', keys: [`global-fn:${name}`],
      });
      return;
    }
    if (first.t === 'elem' && first.literal === undefined) {
      if (links[1]?.t === 'call') {
        this.ctx.emitReference(this.source, 'call', links[1].node, this.exprText(name, links, 2), {
          type: 'preset', status: 'unresolved_dynamic', reason: 'computed_member',
        });
      }
      return;
    }
    const member = first.t === 'prop' ? first.name : first.literal!;
    this.handleModelLikeChain({ global: name }, links, 1, name, member);
  }

  /**
   * Handle `X.member(...)...` where X is a model/service global (free identifier) or
   * an explicit sails.models.<identity>. `start` is the index of the link after the member.
   */
  private handleModelLikeChain(base: { global?: string; identity?: string }, links: Link[], start: number, rootText: string, member: string): void {
    const callLink = links[start];
    const memberLink = links[start - 1];
    // X.getDatastore().sendNativeQuery() / .manager
    if (member === 'getDatastore') {
      const native = true;
      const spec: RefSpec = base.global
        ? { type: 'global_member', name: base.global, member: 'getDatastore', modifiers: [], native, edge: 'CALLS' }
        : { type: 'model_member', identity: base.identity!, member: 'getDatastore', modifiers: [], native, edge: 'CALLS' };
      const spanNode = callLink?.t === 'call' ? callLink.node : memberLink.node;
      this.ctx.emitReference(this.source, 'model', spanNode, this.exprText(rootText, links, Math.min(links.length, start + 2)), spec);
      return;
    }
    if (!callLink || callLink.t !== 'call') {
      // Accessed but not called; only matters when passed as a value.
      if (links.length === start && this.isValueContext(memberLink.node)) {
        const spec: RefSpec = base.global
          ? { type: 'global_member', name: base.global, member, modifiers: [], edge: 'REFERENCES' }
          : { type: 'model_member', identity: base.identity!, member, modifiers: [], edge: 'REFERENCES' };
        this.ctx.emitReference(this.source, 'reference', memberLink.node, this.exprText(rootText, links, start), spec);
      }
      return;
    }
    // modifiers after the call: .fetch(), .populate('x'), .set()...
    const modifiers: string[] = [];
    const populates: { via: string; node: ts.Node }[] = [];
    for (let i = start + 1; i < links.length; i++) {
      const l = links[i];
      if (l.t === 'prop') {
        modifiers.push(l.name);
        const next = links[i + 1];
        if (l.name === 'populate' && next && next.t === 'call') {
          const via = stringLiteralValue(next.node.arguments[0]);
          if (via !== undefined) populates.push({ via, node: next.node });
        }
      }
    }
    const spec: RefSpec = base.global
      ? { type: 'global_member', name: base.global, member, modifiers, edge: 'CALLS' }
      : { type: 'model_member', identity: base.identity!, member, modifiers, edge: 'CALLS' };
    this.ctx.emitReference(this.source, 'model', callLink.node, this.exprText(rootText, links, start + 1), spec);
    for (const p of populates) {
      this.ctx.emitReference(this.source, 'populate', p.node, `${this.exprText(rootText, links, start + 1)}.populate('${p.via}')`, {
        type: 'populate', base: base.global ? { global: base.global } : { identity: base.identity }, via: p.via,
      });
    }
  }

  private handleSails(root: Extract<Root, { t: 'ident' }>, links: Link[]): void {
    const first = links[0];
    if (first.t !== 'prop') {
      this.count('plumbing');
      return;
    }
    if (first.name === 'helpers') {
      this.handleHelperPath(links, 1, 'sails', root.node);
      return;
    }
    if (first.name === 'models') {
      const idl = links[1];
      if (!idl) return;
      if (idl.t === 'elem' && idl.literal === undefined) {
        const callIdx = links.findIndex((l) => l.t === 'call');
        this.ctx.emitReference(this.source, 'model', callIdx >= 0 ? links[callIdx].node : idl.node, this.exprText('sails', links, callIdx >= 0 ? callIdx + 1 : 2), {
          type: 'preset', status: 'unresolved_dynamic', reason: 'computed_model_identity',
        });
        return;
      }
      if (idl.t === 'call') return;
      const identity = (idl.t === 'prop' ? idl.name : idl.literal!).toLowerCase();
      const ml = links[2];
      if (!ml) return;
      if (ml.t === 'elem' && ml.literal === undefined) return;
      if (ml.t === 'call') return;
      const member = ml.t === 'prop' ? ml.name : ml.literal!;
      this.handleModelLikeChain({ identity }, links, 3, 'sails', member);
      return;
    }
    if (first.name === 'sendNativeQuery' || first.name === 'getDatastore') {
      const callIdx = links.findIndex((l) => l.t === 'call');
      this.ctx.emitReference(this.source, 'model', callIdx >= 0 ? links[callIdx].node : first.node, this.exprText('sails', links, callIdx >= 0 ? callIdx + 1 : 1), {
        type: 'preset', status: 'unsupported', reason: 'native_query_no_model',
      });
      return;
    }
    this.count('plumbing');
  }

  /** links[start..] are the helper path after `sails.helpers` (or a helper alias). */
  private handleHelperPath(links: Link[], start: number, rootText: string, rootNode: ts.Node, prefix: string[] = []): void {
    const segs = [...prefix];
    let i = start;
    for (; i < links.length; i++) {
      const l = links[i];
      if (l.t === 'prop') {
        if (segs.length > 0 && (HELPER_INVOCATIONS.has(l.name) || HELPER_MODIFIERS.has(l.name))) break;
        segs.push(l.name);
      } else if (l.t === 'elem') {
        if (l.literal === undefined) {
          const callIdx = links.findIndex((x, j) => j > i && x.t === 'call');
          const spanNode = callIdx >= 0 ? links[callIdx].node : l.node;
          this.ctx.emitReference(this.source, 'call', spanNode, this.exprText(rootText, links, callIdx >= 0 ? callIdx + 1 : i + 1), {
            type: 'preset', status: 'unresolved_dynamic', reason: 'computed_helper_name',
          });
          return;
        }
        segs.push(l.literal);
      } else break;
    }
    if (segs.length === 0) return;
    const access = segs.join('.');
    // Invocation style
    const call: HelperInvocation = { invocation: 'none', modifiers: [] };
    let firstCall: ts.CallExpression | null = null;
    let exprUpto = i;
    if (i < links.length) {
      const l = links[i];
      if (l.t === 'call') {
        call.invocation = 'direct';
        firstCall = l.node;
        call.argCount = l.node.arguments.length;
        exprUpto = i + 1;
      } else if (l.t === 'prop' && HELPER_INVOCATIONS.has(l.name) && links[i + 1]?.t === 'call') {
        call.invocation = l.name as HelperInvocation['invocation'];
        firstCall = (links[i + 1] as Extract<Link, { t: 'call' }>).node;
        exprUpto = i + 2;
        const arg0 = firstCall.arguments[0];
        if (l.name === 'with' && arg0 && ts.isObjectLiteralExpression(arg0)) {
          call.argKeys = arg0.properties.map((p) => propertyKeyName(p.name) ?? '?').filter((k) => k !== '?');
        } else call.argCount = firstCall.arguments.length;
      } else if (l.t === 'prop' && HELPER_MODIFIERS.has(l.name)) {
        // modifiers before the invocation: sails.helpers.x.tolerate(...).with()? uncommon; treat as call
        call.invocation = 'direct';
        firstCall = links.find((x, j) => j > i && x.t === 'call')?.node as ts.CallExpression ?? null;
      }
      for (let j = exprUpto; j < links.length; j++) {
        const m = links[j];
        if (m.t === 'prop') call.modifiers.push(m.name);
      }
    }
    if (call.invocation === 'none') {
      const last = links[i - 1];
      const node = last ? last.node : rootNode;
      // Accessed but not invoked -> REFERENCES (only if used as a value or alias).
      this.ctx.emitReference(this.source, 'reference', node, this.exprText(rootText, links, i), {
        type: 'helper', access, edge: 'REFERENCES', call,
      });
      return;
    }
    this.ctx.emitReference(this.source, 'call', firstCall ?? rootNode, this.exprText(rootText, links, exprUpto), {
      type: 'helper', access, edge: 'CALLS', call,
    });
  }

  private handleModuleChain(b: { kind: 'module'; modules: string[] }, root: Root, links: Link[], spec?: string): void {
    // root is a module (require binding or require('x') call)
    let modules = b.modules;
    if (root.t === 'require') {
      if (!isRelativeSpec(root.spec)) {
        if (links.some((l) => l.t === 'call')) this.count('external');
        return;
      }
      modules = moduleCandidates(this.ctx.relPath, root.spec) ?? [];
      if (!modules.length) return;
    }
    const rootText = root.t === 'require' ? `require('${spec}')` : (root as { name: string }).name;
    const first = links[0];
    if (!first) return;
    if (first.t === 'call') {
      this.ctx.emitReference(this.source, 'call', first.node, this.exprText(rootText, links, 1), {
        type: 'module_member', modules, member: 'default', edge: 'CALLS', resolution: 'static', confidence: 'high',
      });
      return;
    }
    if (first.t === 'elem' && first.literal === undefined) {
      if (links[1]?.t === 'call') {
        this.ctx.emitReference(this.source, 'call', links[1].node, this.exprText(rootText, links, 2), {
          type: 'preset', status: 'unresolved_dynamic', reason: 'computed_member',
        });
      }
      return;
    }
    const member = first.t === 'prop' ? first.name : first.literal!;
    const second = links[1];
    if (second && second.t === 'call') {
      this.ctx.emitReference(this.source, 'call', second.node, this.exprText(rootText, links, 2), {
        type: 'module_member', modules, member, edge: 'CALLS', resolution: 'static', confidence: 'high',
      });
    } else if (!second && this.isValueContext(first.node)) {
      this.ctx.emitReference(this.source, 'reference', first.node, this.exprText(rootText, links, 1), {
        type: 'module_member', modules, member, edge: 'REFERENCES', resolution: 'static', confidence: 'high',
      });
    }
  }

  private handleBoundChain(b: Binding, root: Extract<Root, { t: 'ident' }>, links: Link[]): void {
    const name = root.name;
    switch (b.kind) {
      case 'plumbing':
        if (links.some((l) => l.t === 'call')) this.count('plumbing');
        return;
      case 'package':
        if (links.some((l) => l.t === 'call')) this.count('external');
        return;
      case 'unknown':
      case 'object': {
        if (b.kind === 'object') {
          const first = links[0];
          if (first && first.t === 'prop' && links[1]?.t === 'call') {
            const fnId = b.props.get(first.name);
            if (fnId) {
              this.ctx.emitReference(this.source, 'call', links[1].node, this.exprText(name, links, 2), { type: 'node', nodeId: fnId, edge: 'CALLS' });
            }
          }
        }
        return;
      }
      case 'function': {
        const first = links[0];
        if (!first) return;
        if (first.t === 'call') {
          this.ctx.emitReference(this.source, 'call', first.node, this.exprText(name, links, 1), { type: 'node', nodeId: b.nodeId, edge: 'CALLS' });
        } else if (first.t === 'prop' && (first.name === 'call' || first.name === 'apply') && links[1]?.t === 'call') {
          this.ctx.emitReference(this.source, 'call', links[1].node, this.exprText(name, links, 2), { type: 'node', nodeId: b.nodeId, edge: 'CALLS' });
        } else if (first.t === 'prop' && first.name === 'bind' && links[1]?.t === 'call') {
          this.ctx.emitReference(this.source, 'reference', links[1].node, this.exprText(name, links, 2), { type: 'node', nodeId: b.nodeId, edge: 'REFERENCES' });
        }
        return;
      }
      case 'module':
        this.handleModuleChain(b, root, links);
        return;
      case 'module_member': {
        const first = links[0];
        if (first && first.t === 'call') {
          this.ctx.emitReference(this.source, 'call', first.node, this.exprText(name, links, 1), {
            type: 'module_member', modules: b.modules, member: b.member, edge: 'CALLS', resolution: 'static', confidence: 'high',
          });
        }
        return;
      }
      case 'helper':
        this.handleHelperPath(links, 0, name, root.node, b.access.split('.'));
        return;
      case 'model': {
        const ml = links[0];
        if (!ml || ml.t === 'call' || (ml.t === 'elem' && ml.literal === undefined)) return;
        const member = ml.t === 'prop' ? ml.name : ml.literal!;
        this.handleModelLikeChain({ identity: b.identity }, links, 1, name, member);
        return;
      }
    }
  }
}
