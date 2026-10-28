/**
 * Plugin configuration: defaults, normalisation, and a dependency-free
 * Standard Schema implementation so cordis validates `cordis.patch.yml`
 * entries without the plugin importing `@deepseek-ai/schemastery`.
 */

import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PluginConfig {
  /** Whether the plugin may act at all. Default false: installing it does nothing. */
  enabled: boolean;
  /** Edge origin the agent dials out to. */
  edgeUrl: string;
  /** Device name shown on the edge and in the UI. Empty means `os.hostname()`. */
  deviceName: string;
  /** Start the agent when the plugin applies (only when `enabled` is true). */
  autoStart: boolean;
  /** Explicit agent entry: a `.js`/`.mjs` file run with `node`, or a command on PATH. */
  agentEntry?: string;
  /** Force the agent's `--insecure` flag; defaults to true for `http://` edges. */
  insecure?: boolean;
  /** Agent log level; also the plugin's own child-process verbosity. */
  logLevel: PluginLogLevel;
  /** Override the DSH home used for the state directory (tests / odd installs). */
  stateDir?: string;
}

export const DEFAULT_EDGE_URL = 'http://127.0.0.1:8787';

export const DEFAULT_CONFIG: PluginConfig = Object.freeze({
  enabled: false,
  edgeUrl: DEFAULT_EDGE_URL,
  deviceName: '',
  autoStart: true,
  logLevel: 'info',
});

export interface ConfigIssue {
  message: string;
  path: (string | number)[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoolean(input: Record<string, unknown>, key: string, fallback: boolean, issues: ConfigIssue[]): boolean {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    issues.push({ message: `${key} must be a boolean`, path: [key] });
    return fallback;
  }
  return value;
}

function readString(input: Record<string, unknown>, key: string, fallback: string, issues: ConfigIssue[]): string {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    issues.push({ message: `${key} must be a string`, path: [key] });
    return fallback;
  }
  return value.trim();
}

const LOG_LEVELS: readonly PluginLogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Normalise arbitrary config (a `cordis.patch.yml` entry, `dsh --patch`
 * overlay, or a hand-edited profile) into {@link PluginConfig}.
 *
 * @returns the config and any validation issues. Invalid values fall back to
 * their defaults so a typo never prevents the host from booting.
 */
export function normalizeConfig(value: unknown): { config: PluginConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  if (value !== undefined && !isRecord(value)) {
    return {
      config: { ...DEFAULT_CONFIG },
      issues: [{ message: 'config must be an object', path: [] }],
    };
  }
  const input = isRecord(value) ? value : {};

  const edgeUrl = readString(input, 'edgeUrl', DEFAULT_CONFIG.edgeUrl, issues);
  let resolvedEdgeUrl = edgeUrl;
  if (edgeUrl !== '') {
    try {
      const url = new URL(edgeUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        issues.push({ message: 'edgeUrl must use http: or https:', path: ['edgeUrl'] });
        resolvedEdgeUrl = DEFAULT_CONFIG.edgeUrl;
      }
    } catch {
      issues.push({ message: 'edgeUrl must be an absolute URL', path: ['edgeUrl'] });
      resolvedEdgeUrl = DEFAULT_CONFIG.edgeUrl;
    }
  } else {
    resolvedEdgeUrl = DEFAULT_CONFIG.edgeUrl;
  }

  const logLevelRaw = readString(input, 'logLevel', DEFAULT_CONFIG.logLevel, issues);
  const logLevel = LOG_LEVELS.includes(logLevelRaw as PluginLogLevel) ? (logLevelRaw as PluginLogLevel) : DEFAULT_CONFIG.logLevel;
  if (logLevelRaw !== '' && logLevel !== logLevelRaw) {
    issues.push({ message: `logLevel must be one of ${LOG_LEVELS.join(', ')}`, path: ['logLevel'] });
  }

  const config: PluginConfig = {
    enabled: readBoolean(input, 'enabled', DEFAULT_CONFIG.enabled, issues),
    edgeUrl: resolvedEdgeUrl,
    deviceName: readString(input, 'deviceName', DEFAULT_CONFIG.deviceName, issues),
    autoStart: readBoolean(input, 'autoStart', DEFAULT_CONFIG.autoStart, issues),
    logLevel,
  };

  const agentEntry = readString(input, 'agentEntry', '', issues);
  if (agentEntry !== '') config.agentEntry = agentEntry;

  const insecure = input['insecure'];
  if (insecure !== undefined) {
    if (typeof insecure === 'boolean') config.insecure = insecure;
    else issues.push({ message: 'insecure must be a boolean', path: ['insecure'] });
  }

  const stateDir = readString(input, 'stateDir', '', issues);
  if (stateDir !== '') config.stateDir = stateDir;

  return { config, issues };
}

/** Device name presented to the edge: config, else the machine's hostname. */
export function resolveDeviceName(config: PluginConfig): string {
  if (config.deviceName !== '') return config.deviceName;
  try {
    const name = hostname().trim();
    if (name !== '') return name;
  } catch {
    /* fall through */
  }
  return 'dsh-desktop';
}

/**
 * The DSH home owning this process: `$DSH_HOME`, else `~/.dsh`. Mirrors
 * `@deepseek-ai/dsh-home-paths` precedence without depending on it.
 */
export function resolveDshHome(configured?: string): string {
  if (configured !== undefined && configured.trim() !== '') return configured.trim();
  const fromEnv = process.env['DSH_HOME']?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * Agent state directory: `<DSH home>/rc`, with a compatibility fallback to the
 * pre-rename `<DSH home>/link` when that is where the approved identity lives.
 * Without this, upgrading a working install would register a new device and
 * orphan the owner's share invites.
 */
export function resolveStateDir(config: PluginConfig): string {
  const home = resolveDshHome(config.stateDir);
  const modern = join(home, 'rc');
  if (existsSync(join(modern, 'device.json'))) return modern;
  const legacy = join(home, 'link');
  if (existsSync(join(legacy, 'device.json'))) return legacy;
  return modern;
}

/**
 * Standard Schema (`~standard`) config schema for cordis. Cordis calls
 * `Config["~standard"].validate(raw)` before `apply`; returning issues makes
 * a bad patch a loud boot error instead of a silent misconfiguration.
 */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-rc',
    validate(value: unknown): { value: PluginConfig } | { issues: ConfigIssue[] } {
      const { config, issues } = normalizeConfig(value);
      if (issues.length > 0) return { issues };
      return { value: config };
    },
  },
} as const;