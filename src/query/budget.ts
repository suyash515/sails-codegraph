/**
 * Response budget: keep serialized tool output under maxBytes by deterministically trimming
 * the main result arrays from the end. Sets truncated: true and a hint / nextCursor.
 */
const LIST_KEYS = ['results', 'routes', 'matches', 'symbols', 'unresolved', 'outgoing', 'incoming', 'paths', 'entitiesIfDeletedOrRenamed', 'diagnostics', 'boundaryWarnings'];

export function fitResponse<T extends Record<string, unknown>>(obj: T, maxBytes: number, cursorFor?: (keptFromOffset: number) => string | null): T {
  let json = JSON.stringify(obj);
  if (Buffer.byteLength(json) <= maxBytes) return obj;
  const out: Record<string, unknown> = structuredClone(obj);
  out.truncated = true;
  const arrays: { holder: Record<string, unknown>; key: string }[] = [];
  const collect = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (Array.isArray(v) && LIST_KEYS.includes(k)) arrays.push({ holder: o as Record<string, unknown>, key: k });
      else if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'nodes') collect(v, depth + 1);
    }
    // grouped results (impact): every array value counts
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (Array.isArray(v) && !LIST_KEYS.includes(k) && depth > 0) arrays.push({ holder: o as Record<string, unknown>, key: k });
    }
  };
  collect(out, 0);
  const originalTop = Array.isArray(out.results) ? (out.results as unknown[]).length : null;
  for (let iter = 0; iter < 60 && Buffer.byteLength(json) > maxBytes; iter++) {
    const biggest = arrays
      .map((a) => ({ ...a, len: (a.holder[a.key] as unknown[]).length }))
      .filter((a) => a.len > 0)
      .sort((a, b) => b.len - a.len)[0];
    if (!biggest) break;
    const arr = biggest.holder[biggest.key] as unknown[];
    arr.length = Math.floor(arr.length / 2);
    if (out.nodes && typeof out.nodes === 'object') pruneNodes(out);
    json = JSON.stringify(out);
  }
  if (Buffer.byteLength(json) > maxBytes) {
    for (const k of Object.keys(out)) if (!['query', 'graph', 'truncated'].includes(k)) delete out[k];
  }
  if (originalTop !== null && Array.isArray(out.results) && cursorFor) {
    const offset = ((out.query as Record<string, unknown> | undefined)?.offset as number | undefined) ?? 0;
    out.nextCursor = cursorFor(offset + (out.results as unknown[]).length);
  }
  out.hint = `Response exceeded ${maxBytes} bytes and was truncated deterministically; narrow the query (lower depth/limit, filters) or page with nextCursor.`;
  return out as T;
}

function pruneNodes(out: Record<string, unknown>): void {
  const referenced = new Set<string>();
  const visit = (o: unknown) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(visit);
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === 'nodes') continue;
      if (typeof v === 'string' && /^(sourceId|targetId|via|id)$/.test(k)) referenced.add(v);
      else visit(v);
    }
  };
  visit(out);
  const nodes = out.nodes as Record<string, unknown>;
  const q = out.query as Record<string, unknown> | undefined;
  if (q?.symbolId) referenced.add(q.symbolId as string);
  for (const k of Object.keys(nodes)) if (!referenced.has(k)) delete nodes[k];
}
