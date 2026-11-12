/**
 * Response budget: keep serialized tool output under maxBytes by deterministically trimming
 * result arrays (largest first, from the end). Sets truncated: true, a hint, and a nextCursor
 * when the primary `results` list was cut.
 */
const SKIP_KEYS = new Set(['query', 'graph', 'nodes']);
const HINT = (max: number) =>
  `Response exceeded ${max} bytes and was truncated deterministically; narrow the query (lower depth/limit, filters, detail: "summary") or page with nextCursor.`;

export function fitResponse<T extends Record<string, unknown>>(obj: T, maxBytes: number, cursorFor?: (offset: number) => string | null): T {
  if (Buffer.byteLength(JSON.stringify(obj)) <= maxBytes) return obj;
  const out: Record<string, unknown> = structuredClone(obj);
  out.truncated = true;
  out.hint = HINT(maxBytes);
  const arrays: { holder: Record<string, unknown>; key: string }[] = [];
  const collect = (o: Record<string, unknown>, depth: number) => {
    if (depth > 4) return;
    for (const [k, v] of Object.entries(o)) {
      if (depth === 0 && SKIP_KEYS.has(k)) continue;
      if (Array.isArray(v)) arrays.push({ holder: o, key: k });
      else if (v && typeof v === 'object') collect(v as Record<string, unknown>, depth + 1);
    }
  };
  collect(out, 0);
  const resultsBefore = Array.isArray(out.results) ? (out.results as unknown[]).length : null;
  const size = () => Buffer.byteLength(JSON.stringify(out));
  for (let iter = 0; iter < 200 && size() > maxBytes; iter++) {
    let best: { holder: Record<string, unknown>; key: string; bytes: number } | null = null;
    for (const a of arrays) {
      const arr = a.holder[a.key] as unknown[];
      if (!arr.length) continue;
      const bytes = Buffer.byteLength(JSON.stringify(arr));
      if (!best || bytes > best.bytes || (bytes === best.bytes && a.key < best.key)) best = { ...a, bytes };
    }
    if (!best) break;
    const arr = best.holder[best.key] as unknown[];
    arr.length = arr.length === 1 ? 0 : Math.floor(arr.length / 2);
    if (out.nodes && typeof out.nodes === 'object') pruneNodes(out);
  }
  if (resultsBefore !== null && cursorFor && (out.results as unknown[]).length < resultsBefore) {
    const prior = Number((out.query as Record<string, unknown> | undefined)?.offset ?? 0) || 0;
    out.nextCursor = cursorFor(prior + (out.results as unknown[]).length);
  }
  if (size() > maxBytes) {
    for (const k of Object.keys(out)) if (!['query', 'graph', 'truncated', 'hint'].includes(k)) delete out[k];
  }
  return out as T;
}

function pruneNodes(out: Record<string, unknown>): void {
  const referenced = new Set<string>();
  const visit = (o: unknown) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(visit);
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === 'nodes') continue;
      if (typeof v === 'string' && /^(sourceId|targetId|via|id|symbolId)$/.test(k)) referenced.add(v);
      else visit(v);
    }
  };
  visit(out);
  const nodes = out.nodes as Record<string, unknown>;
  for (const k of Object.keys(nodes)) if (!referenced.has(k)) delete nodes[k];
}
