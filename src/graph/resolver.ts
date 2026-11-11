import type { Confidence, EdgeKind, RefSpec, ReferenceStatus, Resolution } from './types.js';
import { DEFAULT_MODEL_READS, DEFAULT_MODEL_WRITES } from '../parser/known-globals.js';

export interface ResolvedEdge {
  target: string;
  kind: EdgeKind;
  resolution: Resolution;
  confidence: Confidence;
  attributes: Record<string, unknown>;
}

export interface Resolved {
  status: ReferenceStatus;
  reason: string | null;
  edges: ResolvedEdge[];
  /** Every lookup key consulted; persisted in reference_keys so registry changes re-trigger resolution. */
  keys: string[];
  primaryKey: string | null;
}

export interface ResolverEnv {
  /** Node ids registered for a key (sorted). */
  lookup(key: string): string[];
  nodeAttributes(id: string): Record<string, unknown> | null;
  nodeKind(id: string): string | null;
  fileRecord(path: string, kind: string): unknown;
  /** Find the SERVICE entity defined by a module file, if any. */
  serviceOfModule(path: string): string | null;
  ensureSyntheticNode(id: string, kind: 'PACKAGE' | 'MODULE', name: string, attributes: Record<string, unknown>): void;
  modelReads: Set<string>;
  modelWrites: Set<string>;
}

export function modelMethodSets(extraReads: string[], extraWrites: string[]): { reads: Set<string>; writes: Set<string> } {
  return {
    reads: new Set([...DEFAULT_MODEL_READS, ...extraReads]),
    writes: new Set([...DEFAULT_MODEL_WRITES, ...extraWrites]),
  };
}

export function resolveReference(spec: RefSpec, env: ResolverEnv): Resolved {
  const keys = new Set<string>();
  let primaryKey: string | null = null;
  const look = (key: string): string[] => {
    keys.add(key);
    if (primaryKey === null) primaryKey = key;
    return env.lookup(key);
  };
  const done = (status: ReferenceStatus, reason: string | null, edges: ResolvedEdge[] = []): Resolved => ({
    status,
    reason,
    edges,
    keys: [...keys].sort(),
    primaryKey,
  });
  const one = (edge: ResolvedEdge) => done('resolved', null, [edge]);

  const modelOp = (modelId: string, member: string, modifiers: string[], native: boolean | undefined, refEdge: string): Resolved => {
    let kind: EdgeKind = 'USES_MODEL';
    let operation = member;
    if (native) operation = 'native';
    else if (refEdge !== 'REFERENCES') {
      if (env.modelReads.has(member)) kind = 'READS_MODEL';
      else if (env.modelWrites.has(member)) kind = 'WRITES_MODEL';
    }
    const attrs: Record<string, unknown> = { operation };
    if (native) attrs.method = member;
    if (modifiers.length) attrs.modifiers = modifiers;
    return one({ target: modelId, kind, resolution: 'sails_convention', confidence: 'high', attributes: attrs });
  };

  switch (spec.type) {
    case 'preset':
      for (const k of spec.keys ?? []) look(k);
      return done(spec.status, spec.reason);

    case 'node': {
      const ids = look(`node:${spec.nodeId}`);
      if (ids.length === 1) return one({ target: ids[0], kind: spec.edge, resolution: 'static', confidence: 'high', attributes: {} });
      return done('unresolved_missing', 'target_missing');
    }

    case 'helper': {
      const ids = look(`helper-access:${spec.access}`);
      if (ids.length === 1) {
        const attrs: Record<string, unknown> = {};
        if (spec.call.invocation !== 'none') attrs.invocation = spec.call.invocation;
        if (spec.call.modifiers.length) attrs.modifiers = spec.call.modifiers;
        if (spec.call.argKeys) attrs.argKeys = spec.call.argKeys;
        if (spec.call.argCount !== undefined) attrs.argCount = spec.call.argCount;
        return one({ target: ids[0], kind: spec.edge, resolution: 'sails_convention', confidence: 'high', attributes: attrs });
      }
      if (ids.length > 1) return done('ambiguous', 'helper_name_collision');
      return done('unresolved_missing', 'helper_not_found');
    }

    case 'module_member': {
      const r = resolveModuleMember(spec.modules, spec.member, 0, new Set());
      if (r.kind === 'found') {
        return one({ target: r.target, kind: spec.edge, resolution: spec.resolution, confidence: spec.confidence, attributes: spec.self ? { self: true } : {} });
      }
      if (r.kind === 'ambiguous') return done('ambiguous', 'multiple_exports');
      if (r.kind === 'no_module') return done('unresolved_missing', 'module_not_found');
      // Module exists, member not resolved: fall back to the SERVICE entity when the module is a service.
      const svc = env.serviceOfModule(r.module);
      if (svc && !spec.self) {
        return one({
          target: svc,
          kind: spec.edge,
          resolution: spec.resolution,
          confidence: 'medium',
          attributes: { member: spec.member, note: 'method not statically resolved; points to service entity' },
        });
      }
      return done('unresolved_missing', 'export_not_found');
    }

    case 'global_member': {
      const modelsDisabled = look('globals:models-disabled').length > 0;
      const servicesDisabled = look('globals:services-disabled').length > 0;
      let blocked: string | null = null;
      const mm = look(`model-member-global:${spec.name}#${spec.member}`);
      const mg = look(`model-global:${spec.name}`);
      if (mm.length || mg.length) {
        if (modelsDisabled) blocked = 'model_globals_disabled';
        else {
          if (mm.length === 1 && !spec.native) {
            return one({ target: mm[0], kind: spec.edge, resolution: 'static', confidence: 'high', attributes: { model: spec.name } });
          }
          if (mg.length > 1 || mm.length > 1) return done('ambiguous', 'model_identity_collision');
          if (mg.length === 1) return modelOp(mg[0], spec.member, spec.modifiers, spec.native, spec.edge);
        }
      }
      const sm = look(`service-member:${spec.name}#${spec.member}`);
      const sg = look(`service-global:${spec.name}`);
      if (sm.length || sg.length) {
        if (servicesDisabled) blocked = blocked ?? 'service_globals_disabled';
        else {
          if (sm.length === 1) return one({ target: sm[0], kind: spec.edge, resolution: 'sails_convention', confidence: 'high', attributes: { service: spec.name } });
          if (sm.length > 1 || sg.length > 1) return done('ambiguous', 'service_name_collision');
          if (sg.length === 1) {
            return one({
              target: sg[0],
              kind: spec.edge,
              resolution: 'sails_convention',
              confidence: 'medium',
              attributes: { member: spec.member, note: 'method not statically resolved; points to service entity' },
            });
          }
        }
      }
      if (blocked) return done('unresolved_missing', blocked);
      return done('unresolved_missing', 'unknown_global');
    }

    case 'model_member': {
      const mm = look(`model-member:${spec.identity}#${spec.member}`);
      const m = look(`model:${spec.identity}`);
      if (mm.length === 1 && !spec.native) return one({ target: mm[0], kind: spec.edge, resolution: 'static', confidence: 'high', attributes: { model: spec.identity } });
      if (m.length > 1) return done('ambiguous', 'model_identity_collision');
      if (m.length === 1) return modelOp(m[0], spec.member, spec.modifiers, spec.native, spec.edge);
      return done('unresolved_missing', 'model_not_found');
    }

    case 'populate': {
      let base: string[] = [];
      if (spec.base.global) {
        if (look('globals:models-disabled').length) return done('unresolved_missing', 'model_globals_disabled');
        base = look(`model-global:${spec.base.global}`);
      } else base = look(`model:${spec.base.identity}`);
      if (base.length !== 1) return done(base.length ? 'ambiguous' : 'unresolved_missing', base.length ? 'model_identity_collision' : 'model_not_found');
      const attrs = env.nodeAttributes(base[0]);
      const assoc = ((attrs?.associations as { attribute: string; target: string }[] | undefined) ?? []).find((a) => a.attribute === spec.via);
      if (!assoc) return done('unresolved_missing', 'association_not_found');
      const target = look(`model:${assoc.target}`);
      if (target.length === 1) {
        return one({ target: target[0], kind: 'READS_MODEL', resolution: 'inferred', confidence: 'medium', attributes: { operation: 'populate', via: spec.via } });
      }
      return done(target.length ? 'ambiguous' : 'unresolved_missing', target.length ? 'model_identity_collision' : 'model_not_found');
    }

    case 'import': {
      for (const m of spec.modules) {
        const ids = look(`module:${m}`);
        if (ids.length === 1) return one({ target: ids[0], kind: 'IMPORTS', resolution: 'static', confidence: 'high', attributes: {} });
      }
      return done('unresolved_missing', 'module_not_found');
    }

    case 'package': {
      const id = `package:${spec.name}`;
      env.ensureSyntheticNode(id, 'PACKAGE', spec.name, { builtin: spec.name.startsWith('node:') });
      primaryKey = `package:${spec.name}`;
      keys.add(primaryKey);
      return done('external', null, [{ target: id, kind: 'IMPORTS', resolution: 'static', confidence: 'high', attributes: {} }]);
    }

    case 'json': {
      const id = `module:${spec.path}`;
      env.ensureSyntheticNode(id, 'MODULE', spec.path, { json: true, parsed: false });
      primaryKey = id;
      keys.add(id);
      return one({ target: id, kind: 'IMPORTS', resolution: 'static', confidence: 'medium', attributes: { json: true } });
    }

    case 'association': {
      const ids = look(`model:${spec.target}`);
      if (ids.length === 1) {
        const attrs: Record<string, unknown> = { attribute: spec.attribute, type: spec.assocType };
        if (spec.via) attrs.via = spec.via;
        return one({ target: ids[0], kind: 'ASSOCIATES_WITH', resolution: 'sails_convention', confidence: 'high', attributes: attrs });
      }
      if (ids.length > 1) return done('ambiguous', 'model_identity_collision');
      return done('unresolved_missing', 'model_not_found');
    }

    case 'action': {
      const ids = look(spec.key);
      if (ids.length === 1) return one({ target: ids[0], kind: 'ROUTES_TO', resolution: 'sails_convention', confidence: 'high', attributes: {} });
      if (ids.length > 1) return done('ambiguous', 'action_identity_conflict');
      return done('unresolved_missing', 'action_not_found');
    }

    case 'policy': {
      const ids = look(spec.key);
      if (ids.length === 1) return { ...done('resolved', null), edges: [], primaryKey, keys: [...keys], targetOnly: ids[0] } as Resolved;
      if (ids.length > 1) return done('ambiguous', 'policy_name_collision');
      return done('unresolved_missing', 'policy_not_found');
    }
  }

  function resolveModuleMember(
    modules: string[],
    member: string,
    depth: number,
    visited: Set<string>,
  ): { kind: 'found'; target: string } | { kind: 'ambiguous' } | { kind: 'no_module' } | { kind: 'no_member'; module: string } {
    let mod: string | null = null;
    for (const m of modules) {
      if (look(`module:${m}`).length) {
        mod = m;
        break;
      }
    }
    if (!mod) return { kind: 'no_module' };
    if (visited.has(mod) || depth > 5) return { kind: 'no_member', module: mod };
    visited.add(mod);
    const ids = look(`export:${mod}#${member}`);
    if (ids.length === 1) return { kind: 'found', target: ids[0] };
    if (ids.length > 1) return { kind: 'ambiguous' };
    if (look(`reexport-member:${mod}#${member}`).length) {
      const rec = env.fileRecord(mod, 'reexport_members') as Record<string, { modules: string[]; member: string }> | null;
      const fwd = rec?.[member];
      if (fwd) {
        const r = resolveModuleMember(fwd.modules, fwd.member, depth + 1, visited);
        if (r.kind !== 'no_module') return r.kind === 'no_member' ? { kind: 'no_member', module: mod } : r;
      }
    }
    if (look(`reexport-from:${mod}`).length) {
      const rec = env.fileRecord(mod, 'reexport') as { modules: string[] } | null;
      if (rec) {
        const r = resolveModuleMember(rec.modules, member, depth + 1, visited);
        if (r.kind === 'found' || r.kind === 'ambiguous') return r;
      }
    }
    return { kind: 'no_member', module: mod };
  }
}

/** Policy references resolve without an edge; expose the matched target id. */
export function targetOf(r: Resolved): string | null {
  const t = (r as Resolved & { targetOnly?: string }).targetOnly;
  if (t) return t;
  return r.edges[0]?.target ?? null;
}
