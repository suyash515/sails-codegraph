/** Logger that only ever writes to stderr (stdout is reserved for data / JSON-RPC). */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export function createLogger(opts: { verbose?: boolean; quiet?: boolean } = {}): Logger {
  const write = (level: string, msg: string) => {
    process.stderr.write(`[sails-codegraph] ${level}: ${msg}\n`);
  };
  return {
    info: (m) => { if (!opts.quiet) write('info', m); },
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    debug: (m) => { if (opts.verbose) write('debug', m); },
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
