export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const REDACTED = new Set(['token', 'authorization', 'cookie', 'secret', 'password', 'devicesecret', 'dshtoken', 'set-cookie']);

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function redact(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (fields === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED.has(key.toLowerCase())) {
      out[key] = '[redacted]';
      continue;
    }
    if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message, stack: value.stack };
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * JSON-line logger. One object per line keeps `jq` and log shippers useful, and
 * the redaction list is enforced centrally rather than at each call site.
 */
export function createLogger(name: string, level: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVELS[level];
  const write = (entryLevel: Exclude<LogLevel, 'silent'>, message: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[entryLevel] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: entryLevel,
      logger: name,
      msg: message,
      ...bindings,
      ...redact(fields),
    };
    const target = entryLevel === 'error' || entryLevel === 'warn' ? process.stderr : process.stdout;
    target.write(`${JSON.stringify(line)}\n`);
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (extra) => createLogger(name, level, { ...bindings, ...extra }),
  };
}