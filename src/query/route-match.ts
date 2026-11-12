/**
 * Sails-style explicit route path matching: `:param`, optional `:param?`, trailing `*`.
 * Matching is case-insensitive and tolerates a trailing slash, like Sails' default router.
 */
const cache = new Map<string, (path: string) => Record<string, string> | null>();

export function routeMatcher(pattern: string): (path: string) => Record<string, string> | null {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const names: string[] = [];
  let re = '';
  const segs = pattern.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (i === 0 && seg === '') continue;
    const opt = /^:(\w+)\?$/.exec(seg);
    const param = /^:(\w+)$/.exec(seg);
    if (opt) {
      names.push(opt[1]);
      re += '(?:/([^/]+))?';
    } else if (param) {
      names.push(param[1]);
      re += '/([^/]+)';
    } else if (seg === '*') {
      names.push('0');
      re += '(?:/(.*))?';
    } else {
      let part = '';
      for (const piece of seg.split(/(:\w+\??|\*)/)) {
        if (!piece) continue;
        if (piece === '*') {
          names.push('0');
          part += '(.*)';
        } else if (/^:\w+\?$/.test(piece)) {
          names.push(piece.slice(1, -1));
          part += '([^/]*)';
        } else if (/^:\w+$/.test(piece)) {
          names.push(piece.slice(1));
          part += '([^/]+)';
        } else part += piece.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
      }
      re += `/${part}`;
    }
  }
  if (re === '') re = '';
  const rx = new RegExp(`^${re}/?$`, 'i');
  const fn = (path: string) => {
    const m = rx.exec(path.split('?')[0]);
    if (!m) return null;
    const params: Record<string, string> = {};
    names.forEach((n, i) => {
      if (m[i + 1] !== undefined) params[n] = decodeURIComponentSafe(m[i + 1]);
    });
    return params;
  };
  cache.set(pattern, fn);
  return fn;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
