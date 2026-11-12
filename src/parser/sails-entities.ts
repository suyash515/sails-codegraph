import ts from 'typescript';
import path from 'node:path';
import { camelCase, stripExt } from '../util/naming.js';
import type { IRNode, Span } from '../graph/types.js';
import { propertyKeyName, structural, type ParseContext } from './parse-file.js';

const LIFECYCLE = new Set([
  'beforeCreate', 'afterCreate', 'beforeUpdate', 'afterUpdate', 'beforeDestroy', 'afterDestroy', 'beforeValidate',
  'afterValidate', 'customToJSON',
]);

/** Statically evaluate literals; returns undefined for anything non-literal. */
export function literalValue(expr: ts.Node | undefined, depth = 0): unknown {
  if (!expr || depth > 6) return undefined;
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (e.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text);
  if (ts.isArrayLiteralExpression(e)) {
    const out: unknown[] = [];
    for (const el of e.elements) {
      const v = literalValue(el, depth + 1);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(e)) {
    const out: Record<string, unknown> = {};
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const k = propertyKeyName(p.name);
      if (k === undefined) continue;
      const v = literalValue(p.initializer, depth + 1);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (ts.isIdentifier(e) && e.text === 'undefined') return undefined;
  return undefined;
}

export function objectLiteralOf(expr: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!expr) return null;
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isObjectLiteralExpression(e) ? e : null;
}

function propMap(obj: ts.ObjectLiteralExpression): Map<string, ts.ObjectLiteralElementLike> {
  const m = new Map<string, ts.ObjectLiteralElementLike>();
  for (const p of obj.properties) {
    const k = propertyKeyName(p.name);
    if (k !== undefined) m.set(k, p);
  }
  return m;
}

function contractOf(obj: ts.ObjectLiteralExpression | null, kind: 'inputs' | 'exits'): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  const out: Record<string, unknown> = {};
  for (const p of obj.properties) {
    const k = propertyKeyName(p.name);
    if (k === undefined) continue;
    if (ts.isPropertyAssignment(p)) {
      const v = literalValue(p.initializer);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const rec = v as Record<string, unknown>;
        out[k] =
          kind === 'inputs'
            ? pick(rec, ['type', 'required', 'description', 'example', 'defaultsTo', 'isIn'])
            : pick(rec, ['description', 'responseType', 'statusCode', 'outputType', 'viewTemplatePath']);
      } else out[k] = {};
    } else out[k] = {};
  }
  return out;
}

function pick(rec: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (rec[k] !== undefined) o[k] = rec[k];
  return o;
}

export function extractSailsEntities(ctx: ParseContext): void {
  const rel = ctx.relPath;
  const ex = ctx.exports;
  const obj = ex.object;
  const props = obj ? propMap(obj) : new Map<string, ts.ObjectLiteralElementLike>();
  const valueOf = (key: string): ts.Expression | undefined => {
    const v = ex.keys.get(key);
    if (v) return v;
    const p = props.get(key);
    return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
  };
  const entitySpan: Span | null = obj ? ctx.spanOf(obj) : ex.defaultFunction ? ctx.nodes.find((n) => n.id === ex.defaultFunction)?.span ?? null : null;
  const fileSpan = ctx.nodes[0].span;
  const addEntity = (node: IRNode, keys: string[]) => {
    ctx.nodes.push(node);
    ctx.edges.push(structural(ctx.fileNodeId, node.id, 'CONTAINS'));
    for (const k of keys) ctx.registry.push({ key: k, nodeId: node.id });
    ctx.registry.push({ key: `node:${node.id}`, nodeId: node.id });
  };
  const fnSpanOf = (id: string): Span | null => {
    for (const info of ctx.fnInfo.values()) if (info.id === id) return info.span;
    return null;
  };

  switch (ctx.category) {
    case 'helper': {
      const relId = stripExt(rel.slice('api/helpers/'.length));
      const access = relId.split('/').map(camelCase).join('.');
      const id = `helper:${relId}`;
      const fn = ex.functions.get('fn');
      const attributes: Record<string, unknown> = {
        accessName: `sails.helpers.${access}`,
        friendlyName: literalValue(valueOf('friendlyName')),
        description: literalValue(valueOf('description')),
        sync: literalValue(valueOf('sync')) === true ? true : undefined,
        inputs: contractOf(objectLiteralOf(valueOf('inputs')), 'inputs'),
        exits: contractOf(objectLiteralOf(valueOf('exits')), 'exits'),
      };
      addEntity({ id, kind: 'HELPER', name: relId, filePath: rel, span: entitySpan ?? fileSpan, attributes: clean(attributes) }, [`helper-access:${access}`]);
      if (fn) ctx.edges.push(structural(id, fn.nodeId, 'IMPLEMENTED_BY'));
      else ctx.diagnostics.push({ code: 'HELPER_NO_FN', severity: 'warning', message: `Helper ${relId} has no statically identifiable fn.`, filePath: rel, span: entitySpan });
      break;
    }
    case 'controller': {
      const relId = stripExt(rel.slice('api/controllers/'.length));
      const base = path.posix.basename(relId);
      const dir = path.posix.dirname(relId) === '.' ? '' : `${path.posix.dirname(relId)}/`;
      if (/Controller$/.test(base)) {
        const ctrlName = base.replace(/Controller$/, '');
        const ctrlConfig = literalValue(valueOf('_config'));
        let count = 0;
        for (const [key, fn] of [...ex.functions.entries()].sort((a, b) => a[1].span.startOffset - b[1].span.startOffset)) {
          if (key === 'default' || key.startsWith('_')) continue;
          const canonical = `${dir}${ctrlName.toLowerCase()}/${key}`;
          const id = `action:${canonical}`;
          addEntity(
            {
              id,
              kind: 'ACTION',
              name: canonical,
              filePath: rel,
              span: fnSpanOf(fn.nodeId) ?? fn.span,
              attributes: clean({ style: 'classic', controller: `${dir}${base}`, method: key, alias: `${dir}${base}.${key}`, controllerConfig: ctrlConfig, lookupKey: canonical.toLowerCase() }),
            },
            [`action:${canonical.toLowerCase()}`, `action-alias:${`${dir}${base}.${key}`.toLowerCase()}`],
          );
          ctx.edges.push(structural(id, fn.nodeId, 'IMPLEMENTED_BY'));
          count++;
        }
        if (count === 0) ctx.diagnostics.push({ code: 'CONTROLLER_UNRECOGNIZED', severity: 'info', message: `No statically identifiable actions in ${rel}.`, filePath: rel });
      } else {
        const fn = ex.functions.get('fn');
        const canonical = relId;
        const id = `action:${canonical}`;
        if (obj && fn) {
          addEntity(
            {
              id,
              kind: 'ACTION',
              name: canonical,
              filePath: rel,
              span: entitySpan ?? fileSpan,
              attributes: clean({
                style: 'actions2',
                friendlyName: literalValue(valueOf('friendlyName')),
                description: literalValue(valueOf('description')),
                inputs: contractOf(objectLiteralOf(valueOf('inputs')), 'inputs'),
                exits: contractOf(objectLiteralOf(valueOf('exits')), 'exits'),
                lookupKey: canonical.toLowerCase(),
              }),
            },
            [`action:${canonical.toLowerCase()}`],
          );
          ctx.edges.push(structural(id, fn.nodeId, 'IMPLEMENTED_BY'));
        } else if (ex.defaultFunction) {
          addEntity(
            { id, kind: 'ACTION', name: canonical, filePath: rel, span: entitySpan ?? fileSpan, attributes: { style: 'function', lookupKey: canonical.toLowerCase() } },
            [`action:${canonical.toLowerCase()}`],
          );
          ctx.edges.push(structural(id, ex.defaultFunction, 'IMPLEMENTED_BY'));
        } else {
          ctx.diagnostics.push({ code: 'CONTROLLER_UNRECOGNIZED', severity: 'info', message: `${rel} is not a recognized actions2, function or classic controller file.`, filePath: rel });
        }
      }
      break;
    }
    case 'model': {
      const relId = stripExt(rel.slice('api/models/'.length));
      const base = path.posix.basename(relId);
      const identityLit = literalValue(valueOf('identity'));
      const globalIdLit = literalValue(valueOf('globalId'));
      const identity = (typeof identityLit === 'string' ? identityLit : base).toLowerCase();
      const globalId = typeof globalIdLit === 'string' ? globalIdLit : typeof identityLit === 'string' ? identityLit : base;
      const id = `model:${identity}`;
      const attrsObj = objectLiteralOf(valueOf('attributes'));
      const attributes: Record<string, unknown>[] = [];
      const associations: Record<string, unknown>[] = [];
      if (attrsObj) {
        for (const p of attrsObj.properties) {
          const name = propertyKeyName(p.name);
          if (name === undefined || !ts.isPropertyAssignment(p)) continue;
          const def = literalValue(p.initializer);
          const d = def && typeof def === 'object' && !Array.isArray(def) ? (def as Record<string, unknown>) : {};
          const entry = clean({ name, type: d.type, required: d.required, model: d.model, collection: d.collection, via: d.via, through: d.through });
          attributes.push(entry);
          for (const assocType of ['model', 'collection', 'through'] as const) {
            const target = d[assocType];
            if (typeof target !== 'string') continue;
            const assoc = clean({ attribute: name, type: assocType, target: target.toLowerCase(), via: typeof d.via === 'string' ? d.via : undefined });
            if (assocType !== 'through') associations.push(assoc);
            if (ctx.parseOptions.includeModelAssociations !== false) {
              ctx.emitReference(id, 'association', p, `${name}: { ${assocType}: '${target}' }`, {
                type: 'association', target: target.toLowerCase(), attribute: name, assocType, via: typeof d.via === 'string' ? d.via : undefined,
              });
            }
          }
        }
      }
      const customFunctions: string[] = [];
      const lifecycle: string[] = [];
      const memberKeys: string[] = [];
      for (const [key] of ex.functions) {
        if (key === 'default') continue;
        (LIFECYCLE.has(key) ? lifecycle : customFunctions).push(key);
        memberKeys.push(`model-member:${identity}#${key}`, `model-member-global:${globalId}#${key}`);
      }
      const nested = relId.includes('/');
      addEntity(
        {
          id,
          kind: 'MODEL',
          name: globalId,
          filePath: rel,
          span: entitySpan ?? fileSpan,
          attributes: clean({
            identity,
            globalId,
            attributes,
            associations,
            customFunctions: customFunctions.length ? customFunctions.sort() : undefined,
            lifecycle: lifecycle.length ? lifecycle.sort() : undefined,
            datastore: literalValue(valueOf('datastore')),
            tableName: literalValue(valueOf('tableName')),
            confidence: nested ? 'low' : undefined,
          }),
        },
        [`model:${identity}`, `model-global:${globalId}`],
      );
      for (const [key, fn] of ex.functions) {
        if (key === 'default') continue;
        ctx.registry.push({ key: `model-member:${identity}#${key}`, nodeId: fn.nodeId });
        ctx.registry.push({ key: `model-member-global:${globalId}#${key}`, nodeId: fn.nodeId });
      }
      if (nested) ctx.diagnostics.push({ code: 'MODEL_SUBDIRECTORY_UNVERIFIED', severity: 'warning', message: `Model in a sub-directory (${rel}); Sails loader naming is unverified, registered with low confidence.`, filePath: rel });
      if (!obj) ctx.diagnostics.push({ code: 'MODEL_UNRECOGNIZED', severity: 'info', message: `Model file ${rel} does not export a static object literal.`, filePath: rel });
      break;
    }
    case 'service': {
      const relId = stripExt(rel.slice('api/services/'.length));
      const base = path.posix.basename(relId);
      const nested = relId.includes('/');
      const id = `service:${base}`;
      const methods = [...ex.functions.keys()].filter((k) => k !== 'default').sort();
      addEntity(
        { id, kind: 'SERVICE', name: base, filePath: rel, span: entitySpan ?? fileSpan, attributes: clean({ methods, confidence: nested ? 'low' : undefined }) },
        [`service-global:${base}`],
      );
      for (const [key, fn] of [...ex.functions.entries()].sort()) {
        if (key === 'default') continue;
        ctx.registry.push({ key: `service-member:${base}#${key}`, nodeId: fn.nodeId });
        ctx.edges.push(structural(id, fn.nodeId, 'IMPLEMENTED_BY', { method: key }));
      }
      if (nested) ctx.diagnostics.push({ code: 'SERVICE_SUBDIRECTORY_UNVERIFIED', severity: 'warning', message: `Service in a sub-directory (${rel}); Sails may not load it as a global. Registered with low confidence.`, filePath: rel });
      break;
    }
    case 'policy': {
      const relId = stripExt(rel.slice('api/policies/'.length));
      const id = `policy:${relId}`;
      const fnId = ex.defaultFunction ?? ex.functions.get('fn')?.nodeId ?? null;
      addEntity({ id, kind: 'POLICY', name: relId, filePath: rel, span: entitySpan ?? fileSpan, attributes: {} }, [`policy:${relId.toLowerCase()}`]);
      if (fnId) ctx.edges.push(structural(id, fnId, 'IMPLEMENTED_BY'));
      else ctx.diagnostics.push({ code: 'POLICY_NO_FUNCTION', severity: 'warning', message: `Policy ${relId} does not export a statically identifiable function.`, filePath: rel });
      break;
    }
    default:
      break;
  }
}

export function clean<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
