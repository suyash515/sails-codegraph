import ts from 'typescript';
import type { Span } from '../graph/types.js';
import { chainText, isRelativeSpec, moduleCandidates, propertyKeyName, requireSpecifier, type ParseContext } from './parse-file.js';
import { literalValue, objectLiteralOf, clean } from './sails-entities.js';

// ---------------------------------------------------------------------------
// Routes

export type RouteValue =
  | { kind: 'action'; action: string; raw: string; meta: Record<string, unknown> }
  | { kind: 'function'; fnId: string; meta: Record<string, unknown> }
  | { kind: 'redirect'; to: string; meta: Record<string, unknown> }
  | { kind: 'view'; view: string; meta: Record<string, unknown> }
  | { kind: 'response'; response: string; meta: Record<string, unknown> }
  | { kind: 'unsupported'; text: string; meta: Record<string, unknown> };

export type RouteItem =
  | { t: 'entry'; key: string; method: string; path: string; value: RouteValue; span: Span }
  | { t: 'include'; modules: string[]; span: Span }
  | { t: 'dynamic'; text: string; span: Span };

const VERBS = /^\s*(get|post|put|patch|delete|del|head|options|all|connect|trace)\s+(\S.*)$/i;

export function parseRouteKey(key: string): { method: string; path: string } {
  const m = VERBS.exec(key);
  if (!m) return { method: '*', path: key.trim() };
  let method = m[1].toUpperCase();
  if (method === 'ALL') method = '*';
  if (method === 'DEL') method = 'DELETE';
  return { method, path: m[2].trim() };
}

export function routeId(method: string, p: string): string {
  return method === '*' ? `route:${p}` : `route:${method} ${p}`;
}

/** Normalize a route action target ('user/find', 'UserController.find', 'admin/UserController.find'). */
export function normalizeActionTarget(target: string): string {
  const t = target.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const m = /^((?:[\w-]+\/)*)([\w-]+)Controller\.([\w$-]+)$/.exec(t);
  if (m) return `${m[1]}${m[2]}/${m[3]}`.toLowerCase();
  const m2 = /^((?:[\w-]+\/)*)([\w-]+)\.([\w$-]+)$/.exec(t);
  if (m2) return `${m2[1]}${m2[2]}/${m2[3]}`.toLowerCase();
  return t.toLowerCase();
}

function findExportedProperty(ctx: ParseContext, prop: string, allowWhole: boolean): ts.Expression | null {
  let found: ts.Expression | null = null;
  for (const st of ctx.sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) continue;
    const bin = st.expression;
    if (bin.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const left = chainText(bin.left);
    if (left === `module.exports.${prop}` || left === `exports.${prop}`) found = bin.right;
    else if (left === 'module.exports') {
      const obj = objectLiteralOf(bin.right);
      if (obj) {
        const p = obj.properties.find((x) => propertyKeyName(x.name) === prop);
        if (p && ts.isPropertyAssignment(p)) found = p.initializer;
        else if (allowWhole) found = bin.right;
      } else if (allowWhole) found = bin.right;
    }
  }
  return found;
}

export function extractRouteFragment(ctx: ParseContext): void {
  const isMain = ctx.category === 'routes';
  const expr = findExportedProperty(ctx, 'routes', !isMain);
  if (!expr) {
    if (isMain) ctx.diagnostics.push({ code: 'ROUTES_NOT_FOUND', severity: 'warning', message: 'config/routes.js has no statically readable module.exports.routes.', filePath: ctx.relPath });
    return;
  }
  const items: RouteItem[] = [];
  const follow = ctx.parseOptions.followRouteFileRequires !== false;
  const collect = (node: ts.Expression, depth: number): void => {
    let e = node;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (depth > 8) {
      dynamic(e);
      return;
    }
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) {
          collect(p.expression, depth + 1);
          continue;
        }
        const key = propertyKeyName(p.name);
        if (key === undefined) {
          dynamic(p);
          continue;
        }
        const { method, path } = parseRouteKey(key);
        let value: RouteValue;
        if (ts.isPropertyAssignment(p)) value = routeValue(ctx, p.initializer);
        else if (ts.isMethodDeclaration(p)) {
          const id = ctx.fnInfo.get(p)?.id;
          value = id ? { kind: 'function', fnId: id, meta: {} } : { kind: 'unsupported', text: ctx.textOf(p, 60), meta: {} };
        } else if (ts.isShorthandPropertyAssignment(p)) value = routeValue(ctx, p.name);
        else value = { kind: 'unsupported', text: ctx.textOf(p, 60), meta: {} };
        if (key.startsWith('r|')) value.meta.regex = true;
        items.push({ t: 'entry', key, method, path, value, span: ctx.spanOf(p) });
      }
      return;
    }
    if (ts.isIdentifier(e)) {
      const b = ctx.fileScope.lookup(e.text);
      if (b && b.kind === 'object') return collect(b.objectNode, depth + 1);
      if (b && b.kind === 'module') return include(b.modules, e);
      return dynamic(e);
    }
    const req = requireSpecifier(e, null);
    if (typeof req === 'string') {
      if (!isRelativeSpec(req)) return dynamic(e);
      const mods = moduleCandidates(ctx.relPath, req);
      if (!mods) return dynamic(e);
      return include(mods, e);
    }
    if (ts.isCallExpression(e) && chainText(e.expression) === 'Object.assign') {
      for (const a of e.arguments) collect(a, depth + 1);
      return;
    }
    dynamic(e);
  };
  const include = (mods: string[], node: ts.Node) => {
    if (!mods.every((m) => m.startsWith('config/'))) {
      ctx.diagnostics.push({ code: 'ROUTE_DYNAMIC', severity: 'warning', message: `Route file require outside config/ is not followed: ${ctx.textOf(node, 80)}`, filePath: ctx.relPath, span: ctx.spanOf(node) });
      items.push({ t: 'dynamic', text: ctx.textOf(node, 80), span: ctx.spanOf(node) });
      return;
    }
    if (!follow) {
      ctx.diagnostics.push({ code: 'ROUTE_REQUIRE_NOT_FOLLOWED', severity: 'info', message: `resolution.followRouteFileRequires is false; ${ctx.textOf(node, 80)} not merged.`, filePath: ctx.relPath, span: ctx.spanOf(node) });
      return;
    }
    items.push({ t: 'include', modules: mods, span: ctx.spanOf(node) });
    for (const m of mods) ctx.dependencies.push({ dependencyFile: m, kind: 'route_include' });
  };
  const dynamic = (node: ts.Node) => {
    ctx.diagnostics.push({ code: 'ROUTE_DYNAMIC', severity: 'warning', message: `Route definition cannot be statically interpreted: ${ctx.textOf(node, 80)}`, filePath: ctx.relPath, span: ctx.spanOf(node) });
    items.push({ t: 'dynamic', text: ctx.textOf(node, 80), span: ctx.spanOf(node) });
  };
  collect(expr, 0);
  ctx.records.push({ kind: 'route_fragment', data: { items } });
}

function routeValue(ctx: ParseContext, init: ts.Expression): RouteValue {
  let e = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    const s = e.text;
    if (s.startsWith('/') || /^https?:\/\//.test(s)) return { kind: 'redirect', to: s, meta: {} };
    return { kind: 'action', action: normalizeActionTarget(s), raw: s, meta: {} };
  }
  const fnId = ctx.lookupFunctionId(e, ctx.fileScope);
  if (fnId) return { kind: 'function', fnId, meta: {} };
  if (ts.isObjectLiteralExpression(e)) {
    const meta: Record<string, unknown> = {};
    let fn: string | null = null;
    const raw: Record<string, unknown> = {};
    for (const p of e.properties) {
      const k = propertyKeyName(p.name);
      if (k === undefined) continue;
      if (ts.isPropertyAssignment(p)) {
        if (k === 'fn') {
          fn = ctx.lookupFunctionId(p.initializer, ctx.fileScope);
          continue;
        }
        const v = literalValue(p.initializer);
        raw[k] = v === undefined ? { $expr: ctx.textOf(p.initializer, 60) } : v;
      } else if (ts.isMethodDeclaration(p) && k === 'fn') {
        fn = ctx.fnInfo.get(p)?.id ?? null;
      }
    }
    const { action, controller, view, response, redirect, ...rest } = raw;
    Object.assign(meta, rest);
    if (fn) return { kind: 'function', fnId: fn, meta };
    if (typeof action === 'string') {
      if (typeof controller === 'string') {
        const ctrl = controller.replace(/Controller$/, '');
        const dirm = /^(.*\/)?([^/]+)$/.exec(ctrl)!;
        const target = `${dirm[1] ?? ''}${dirm[2]}/${action}`.toLowerCase();
        return { kind: 'action', action: target, raw: `${controller}.${action}`, meta };
      }
      return { kind: 'action', action: normalizeActionTarget(action), raw: action, meta };
    }
    if (typeof redirect === 'string') return { kind: 'redirect', to: redirect, meta };
    if (typeof view === 'string') return { kind: 'view', view, meta };
    if (typeof response === 'string') return { kind: 'response', response, meta };
    return { kind: 'unsupported', text: ctx.textOf(e, 60), meta: clean({ ...meta, action, controller }) };
  }
  return { kind: 'unsupported', text: ctx.textOf(e, 60), meta: {} };
}

// ---------------------------------------------------------------------------
// Policies

export interface PolicyRule {
  matchedRule: string;
  kind: 'exact' | 'prefix' | 'controller' | 'global';
  /** Lower-cased action identity (exact) or prefix ending in '/' (prefix, controller). */
  pattern: string;
  value: { names: { name: string; span: Span }[] } | boolean | null;
  span: Span;
}

export function extractPoliciesConfig(ctx: ParseContext): void {
  const expr = findExportedProperty(ctx, 'policies', false);
  const obj = objectLiteralOf(expr ?? undefined);
  if (!obj) {
    ctx.diagnostics.push({ code: 'POLICIES_NOT_FOUND', severity: 'warning', message: 'config/policies.js has no statically readable module.exports.policies object.', filePath: ctx.relPath });
    ctx.records.push({ kind: 'policy_rules', data: { rules: [], readable: false } });
    return;
  }
  const rules: PolicyRule[] = [];
  const valueOf = (init: ts.Expression): PolicyRule['value'] => {
    let e = init;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { names: [{ name: e.text, span: ctx.spanOf(e) }] };
    if (ts.isArrayLiteralExpression(e)) {
      const names: { name: string; span: Span }[] = [];
      for (const el of e.elements) {
        if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) names.push({ name: el.text, span: ctx.spanOf(el) });
        else {
          ctx.diagnostics.push({ code: 'POLICY_DYNAMIC', severity: 'warning', message: `Policy list element is not a string literal: ${ctx.textOf(el, 60)}`, filePath: ctx.relPath, span: ctx.spanOf(el) });
          return null;
        }
      }
      return { names };
    }
    ctx.diagnostics.push({ code: 'POLICY_DYNAMIC', severity: 'warning', message: `Policy mapping is not statically readable: ${ctx.textOf(e, 60)}`, filePath: ctx.relPath, span: ctx.spanOf(e) });
    return null;
  };
  for (const p of obj.properties) {
    const key = propertyKeyName(p.name);
    if (key === undefined || !ts.isPropertyAssignment(p)) {
      ctx.diagnostics.push({ code: 'POLICY_DYNAMIC', severity: 'warning', message: `Policy entry is not statically readable: ${ctx.textOf(p, 60)}`, filePath: ctx.relPath, span: ctx.spanOf(p) });
      continue;
    }
    const inner = objectLiteralOf(p.initializer);
    if (/Controller$/.test(key) && inner) {
      const base = key.replace(/Controller$/, '');
      const m = /^(.*\/)?([^/]+)$/.exec(base)!;
      const ctrlPath = `${m[1] ?? ''}${m[2]}`.toLowerCase();
      for (const ip of inner.properties) {
        const ik = propertyKeyName(ip.name);
        if (ik === undefined || !ts.isPropertyAssignment(ip)) continue;
        if (ik === '*') rules.push({ matchedRule: `${key}.*`, kind: 'controller', pattern: `${ctrlPath}/`, value: valueOf(ip.initializer), span: ctx.spanOf(ip) });
        else rules.push({ matchedRule: `${key}.${ik}`, kind: 'exact', pattern: `${ctrlPath}/${ik}`.toLowerCase(), value: valueOf(ip.initializer), span: ctx.spanOf(ip) });
      }
      continue;
    }
    if (key === '*') rules.push({ matchedRule: key, kind: 'global', pattern: '', value: valueOf(p.initializer), span: ctx.spanOf(p) });
    else if (key.endsWith('/*')) rules.push({ matchedRule: key, kind: 'prefix', pattern: key.slice(0, -1).toLowerCase().replace(/^\/+/, ''), value: valueOf(p.initializer), span: ctx.spanOf(p) });
    else rules.push({ matchedRule: key, kind: 'exact', pattern: normalizeActionTarget(key), value: valueOf(p.initializer), span: ctx.spanOf(p) });
  }
  for (const r of rules) {
    if (r.value && typeof r.value === 'object') {
      for (const n of r.value.names) {
        ctx.emitReference(ctx.moduleNodeId, 'policy', null, `'${n.name}' (${r.matchedRule})`, { type: 'policy', key: `policy:${n.name.toLowerCase()}` }, n.span);
      }
    }
  }
  ctx.records.push({ kind: 'policy_rules', data: { rules, readable: true } });
}

// ---------------------------------------------------------------------------
// Globals

export function extractGlobalsConfig(ctx: ParseContext): void {
  const expr = findExportedProperty(ctx, 'globals', false);
  const obj = objectLiteralOf(expr ?? undefined);
  if (!obj) {
    ctx.records.push({ kind: 'globals', data: { readable: false } });
    ctx.diagnostics.push({ code: 'GLOBALS_NOT_READABLE', severity: 'info', message: 'config/globals.js is not statically readable; assuming Sails 1.x defaults (models and services exposed).', filePath: ctx.relPath });
    return;
  }
  const data: Record<string, unknown> = { readable: true };
  for (const p of obj.properties) {
    const k = propertyKeyName(p.name);
    if (k === undefined || !ts.isPropertyAssignment(p)) continue;
    const v = literalValue(p.initializer);
    if (typeof v === 'boolean') data[k] = v;
    else if (requireSpecifier(p.initializer, null)) data[k] = `require(${requireSpecifier(p.initializer, null)})`;
    else data[k] = { $expr: ctx.textOf(p.initializer, 60) };
  }
  ctx.records.push({ kind: 'globals', data });
  if (ctx.parseOptions.honorGlobalsConfig !== false) {
    if (data.models === false) ctx.registry.push({ key: 'globals:models-disabled', nodeId: ctx.fileNodeId });
    if (data.services === false) ctx.registry.push({ key: 'globals:services-disabled', nodeId: ctx.fileNodeId });
  }
}
