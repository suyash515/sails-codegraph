/**
 * lodash `_.words`/`_.camelCase` semantics for ASCII identifiers, as used by Sails
 * when deriving helper access names from file paths.
 */
const WORD_RE = /[A-Z]?[a-z]+(?=[^a-zA-Z0-9]|[A-Z]|$)|[A-Z]+(?=[^a-zA-Z0-9]|[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|[A-Z]+|\d+/g;

export function words(input: string): string[] {
  return input.match(WORD_RE) ?? [];
}

export function camelCase(input: string): string {
  return words(input)
    .map((w, i) => {
      const lower = w.toLowerCase();
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

/** Strip a trailing `.js` (or other extension) from a POSIX path. */
export function stripExt(p: string): string {
  return p.replace(/\.[cm]?[jt]s$/i, '');
}
