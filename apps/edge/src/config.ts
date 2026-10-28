/**
 * Edge configuration: CLI flags, env fallbacks, defaults and safety checks.
 *
 * Precedence is flag > env > default. The edge refuses to serve plain HTTP on a
 * public interface unless the operator either declared an https public URL
 * (TLS terminated in front) or explicitly asked for loopback demo mode.
 */
import path from 'node:path';
import process from 'node:process';
import { isLoopbackAddress, type LogLevel } from '@dsh-rc/shared';

export interface RateLimitRule {
  /** Requests allowed in one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface EdgeRateLimits {
  setup: RateLimitRule;
  login: RateLimitRule;
  pair: RateLimitRule;
  register: RateLimitRule;
}

export interface EdgeConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Absolute public origin, e.g. https://link.example.com. Empty means derive per request. */
  publicUrl: string;
  trustProxy: boolean;
  insecure: boolean;
  setupCode: string | undefined;
  logLevel: LogLevel;
  /** How long a disconnected device is still presented as "reconnecting". */
  presenceGraceMs: number;
  /** Owner session lifetime. */
  sessionTtlMs: number;
  /** Pair code lifetime. */
  pairCodeTtlMs: number;
  /** First-run setup code lifetime. */
  setupCodeTtlMs: number;
  /** Audit rows older than this are pruned; 0 disables pruning. */
  auditRetentionDays: number;
  /** How long a browser waits for the agent to answer an upgrade. */
  wsOpenTimeoutMs: number;
  rateLimits: EdgeRateLimits;
}

export const DEFAULT_PRESENCE_GRACE_MS = 30_000;
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_PAIR_CODE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_SETUP_CODE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_WS_OPEN_TIMEOUT_MS = 10_000;
export const DEFAULT_AUDIT_RETENTION_DAYS = 30;
export const MAX_AUDIT_RETENTION_DAYS = 36_500;
export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  dataDir: 'dshrc-data',
  publicUrl: '',
  trustProxy: false,
  insecure: false,
  logLevel: 'info' as LogLevel,
} as const;

export const DEFAULT_RATE_LIMITS: EdgeRateLimits = {
  setup: { limit: 5, windowMs: 10 * 60 * 1000 },
  login: { limit: 10, windowMs: 5 * 60 * 1000 },
  pair: { limit: 20, windowMs: 5 * 60 * 1000 },
  register: { limit: 20, windowMs: 10 * 60 * 1000 },
};

const LOG_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error', 'silent']);

const FLAG_TO_KEY: Record<string, keyof RawOptions> = {
  '--host': 'host',
  '--port': 'port',
  '--data-dir': 'dataDir',
  '--public-url': 'publicUrl',
  '--trust-proxy': 'trustProxy',
  '--insecure': 'insecure',
  '--setup-code': 'setupCode',
  '--log-level': 'logLevel',
  '--audit-retention-days': 'auditRetentionDays',
};

interface RawOptions {
  host?: string;
  port?: string;
  dataDir?: string;
  publicUrl?: string;
  trustProxy?: boolean;
  insecure?: boolean;
  setupCode?: string;
  logLevel?: string;
  auditRetentionDays?: string;
}

export interface ParsedArgv {
  options: RawOptions;
  help: boolean;
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function envBoolean(value: string | undefined): boolean | undefined {
  return value === undefined ? undefined : parseBoolean(value);
}

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const options: RawOptions = {};
  let help = false;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    if (token === '--help' || token === '-h') {
      help = true;
      index += 1;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
    const key = FLAG_TO_KEY[flag];
    if (key === undefined) throw new Error(`unknown flag: ${flag}`);
    if (key === 'trustProxy' || key === 'insecure') {
      if (inlineValue !== undefined) {
        const parsed = parseBoolean(inlineValue);
        if (parsed === undefined) throw new Error(`${flag} expects true or false, got ${inlineValue}`);
        options[key] = parsed;
      } else {
        options[key] = true;
      }
      index += 1;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    options[key] = value;
    index += inlineValue === undefined ? 2 : 1;
  }
  return { options, help };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  return isLoopbackAddress(normalized);
}

function parsePublicUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') throw new Error('--public-url cannot be empty when provided');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`--public-url is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--public-url must be http(s)');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('--public-url must be an origin without a path');
  }
  return url.origin;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer between 0 and 65535, got ${value}`);
  }
  return port;
}

export interface LoadConfigOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Test-only overrides for timings/rate limits. Never exposed on the CLI. */
  overrides?: Partial<EdgeConfig>;
}

export function loadConfig(options: LoadConfigOptions = {}): EdgeConfig {
  const env = options.env ?? process.env;
  const { options: cli, help } = parseArgv(options.argv ?? []);
  if (help) throw new HelpRequested();

  const host = cli.host ?? env['DSHRC_HOST'] ?? DEFAULTS.host;
  const port = parsePort(cli.port ?? env['DSHRC_PORT'] ?? String(DEFAULTS.port));
  const dataDir = path.resolve(cli.dataDir ?? env['DSHRC_DATA_DIR'] ?? DEFAULTS.dataDir);
  const publicUrlRaw = cli.publicUrl ?? env['DSHRC_PUBLIC_URL'] ?? DEFAULTS.publicUrl;
  const publicUrl = publicUrlRaw.trim() === '' ? '' : parsePublicUrl(publicUrlRaw);
  const trustProxy = cli.trustProxy ?? envBoolean(env['DSHRC_TRUST_PROXY']) ?? DEFAULTS.trustProxy;
  const insecure = cli.insecure ?? envBoolean(env['DSHRC_INSECURE']) ?? DEFAULTS.insecure;
  const logLevelRaw = cli.logLevel ?? env['DSHRC_LOG_LEVEL'] ?? DEFAULTS.logLevel;
  if (!LOG_LEVELS.has(logLevelRaw)) throw new Error(`invalid log level: ${logLevelRaw}`);
  const logLevel = logLevelRaw as LogLevel;

  const setupCodeRaw = cli.setupCode ?? env['DSHRC_SETUP_CODE'];
  if (setupCodeRaw !== undefined && (setupCodeRaw.length < 8 || setupCodeRaw.length > 128)) {
    throw new Error('--setup-code must be 8-128 characters');
  }

  const auditRetentionRaw =
    cli.auditRetentionDays ?? env['DSHRC_AUDIT_RETENTION_DAYS'] ?? String(DEFAULT_AUDIT_RETENTION_DAYS);
  const auditRetentionDays = Number(auditRetentionRaw);
  if (!Number.isInteger(auditRetentionDays) || auditRetentionDays < 0 || auditRetentionDays > MAX_AUDIT_RETENTION_DAYS) {
    throw new Error(`--audit-retention-days must be an integer between 0 and ${String(MAX_AUDIT_RETENTION_DAYS)} (0 disables pruning)`);
  }

  const loopback = isLoopbackHost(host);
  if (insecure) {
    if (!loopback) {
      throw new Error('--insecure is only allowed when --host is a loopback address (127.0.0.1, localhost, ::1)');
    }
    if (publicUrl.startsWith('https://')) {
      throw new Error('--insecure cannot be combined with an https --public-url');
    }
  }
  if (!insecure && publicUrl === '' && !loopback) {
    throw new Error(
      'refusing to serve plain HTTP on a public interface: set --public-url https://… behind TLS, or --insecure for a loopback demo',
    );
  }
  if (publicUrl !== '' && !publicUrl.startsWith('https://') && !insecure) {
    throw new Error('a plain http --public-url requires --insecure (loopback demo only)');
  }

  const config: EdgeConfig = {
    host,
    port,
    dataDir,
    publicUrl,
    trustProxy,
    insecure,
    setupCode: setupCodeRaw,
    logLevel,
    presenceGraceMs: DEFAULT_PRESENCE_GRACE_MS,
    sessionTtlMs: DEFAULT_SESSION_TTL_MS,
    pairCodeTtlMs: DEFAULT_PAIR_CODE_TTL_MS,
    setupCodeTtlMs: DEFAULT_SETUP_CODE_TTL_MS,
    auditRetentionDays,
    wsOpenTimeoutMs: DEFAULT_WS_OPEN_TIMEOUT_MS,
    rateLimits: DEFAULT_RATE_LIMITS,
  };
  return { ...config, ...options.overrides };
}

export class HelpRequested extends Error {
  constructor() {
    super('help requested');
    this.name = 'HelpRequested';
  }
}

export const USAGE = `DSH RC edge

Usage: node --import tsx apps/edge/src/main.ts [flags]

  --host <addr>          Bind address (default ${DEFAULTS.host})
  --port <port>          TCP port, 0 for ephemeral (default ${String(DEFAULTS.port)})
  --data-dir <dir>       Directory for dshrc.sqlite (default ./${DEFAULTS.dataDir})
  --public-url <origin>  Public https origin when TLS terminates in front
  --trust-proxy          Honour X-Forwarded-Proto and forwarding headers
  --insecure             Plain HTTP demo mode, loopback bind only
  --setup-code <code>    8-128 char first-run code instead of a generated one
  --audit-retention-days <n>  Prune audit rows older than n days (default 30, 0 disables)
  --log-level <level>    debug|info|warn|error|silent (default info)

Environment: DSHRC_HOST, DSHRC_PORT, DSHRC_DATA_DIR, DSHRC_PUBLIC_URL,
DSHRC_TRUST_PROXY, DSHRC_INSECURE, DSHRC_SETUP_CODE, DSHRC_LOG_LEVEL,
DSHRC_AUDIT_RETENTION_DAYS.
Flags win over environment variables.
`;