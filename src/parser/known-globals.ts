/** JS / Node globals: calls through these are classified `external`, never unresolved. */
export const KNOWN_GLOBALS = new Set([
  'console', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Proxy', 'Reflect', 'Intl', 'ArrayBuffer', 'SharedArrayBuffer',
  'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Atomics', 'globalThis', 'global', 'process',
  'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'AbortController', 'AbortSignal', 'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob',
  'crypto', 'performance', 'EventTarget', 'Event', '__dirname', '__filename', 'undefined', 'NaN', 'Infinity',
  'eval', 'Function', 'arguments', 'module', 'exports', 'require', 'Iterator', 'FinalizationRegistry', 'WebAssembly',
  'atob', 'btoa', 'navigator', 'MessageChannel', 'BroadcastChannel', 'Intl',
]);

/** Free identifiers that Sails apps conventionally expose as external libraries. */
export const SAILS_EXTERNAL_GLOBALS = new Set(['_', 'async']);

/** Helper invocation-style chain members (never targets). */
export const HELPER_INVOCATIONS = new Set(['with', 'exec', 'now']);
export const HELPER_MODIFIERS = new Set(['tolerate', 'intercept', 'retry', 'meta', 'switch']);

export const DEFAULT_MODEL_READS = new Set([
  'find', 'findOne', 'count', 'sum', 'avg', 'stream',
]);
export const DEFAULT_MODEL_WRITES = new Set([
  'create', 'createEach', 'update', 'updateOne', 'destroy', 'destroyOne', 'archive', 'archiveOne',
  'addToCollection', 'removeFromCollection', 'replaceCollection', 'findOrCreate',
]);
/** Query modifiers recorded as metadata only. */
export const MODEL_QUERY_MODIFIERS = new Set([
  'fetch', 'populate', 'sort', 'limit', 'skip', 'where', 'select', 'omit', 'paginate', 'meta', 'usingConnection',
  'decrypt', 'intercept', 'tolerate', 'exec', 'then', 'catch', 'set', 'members', 'eachRecord', 'eachBatch', 'groupBy',
]);
