#!/usr/bin/env node
/**
 * DSH Link agent CLI.
 *
 * Prints one JSON status object per line, plus `DSH_LINK_PAIR_URL=<url>` the
 * first time pairing starts, and writes an atomic status file when
 * `--status-file` is set. The launch token is read from a 0600 JSON file
 * (`--dsh-url-file`) so it never appears in `ps` output, or from an inline
 * `?token=` on `--dsh-url` for manual runs.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createLogger, type LogLevel } from '@dsh-link/shared';
import { AgentRuntime } from './runtime.js';
import { writeStatusFileAtomic } from './status.js';
import { AgentError, messageOf } from './errors.js';
import type { AgentOptions, AgentStatus } from './types.js';

const FLAGS = {
  edge: { type: 'string' },
  'dsh-url': { type: 'string' },
  'dsh-url-file': { type: 'string' },
  'state-dir': { type: 'string' },
  name: { type: 'string' },
  insecure: { type: 'boolean' },
  'status-file': { type: 'string' },
  'log-level': { type: 'string' },
  help: { type: 'boolean' },
} as const;

const USAGE = `Usage: dsh-link-agent --edge <url> (--dsh-url <url> | --dsh-url-file <path>) [options]

Options:
  --edge <url>          Edge origin (default: http://127.0.0.1:8787)
  --dsh-url <url>       Loopback DSH URL; may include ?token=... for manual runs
  --dsh-url-file <path> Read the launch URL from a 0600 JSON file {"url":"..."}
                        (takes precedence over --dsh-url; preferred for secrets)
  --state-dir <path>    Device identity directory (default: ~/.dsh-link/agent)
  --name <name>         Device name in the dashboard (default: hostname)
  --insecure            Allow plain http/ws to a non-loopback edge; skip TLS verify
  --status-file <path>  Atomically write AgentStatus JSON on every transition
  --log-level <level>   debug | info | warn | error | silent (default: info)
  --help                Show this help

Environment: DSH_LINK_EDGE, DSH_LINK_DSH_URL, DSH_LINK_DSH_URL_FILE,
DSH_LINK_STATE_DIR, DSH_LINK_NAME, DSH_LINK_INSECURE, DSH_LINK_STATUS_FILE,
DSH_LINK_LOG_LEVEL. CLI flags win over environment variables.
`;

const LOG_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error', 'silent']);

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function envFlag(name: string): boolean | undefined {
  const value = env(name);
  if (value === undefined) return undefined;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

interface CliConfig {
  options: AgentOptions;
  statusFile?: string;
}

export function parseCli(argv: string[]): CliConfig | 'help' {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: FLAGS, strict: true, allowPositionals: false });
  } catch (error) {
    throw new AgentError('AGENT_USAGE', `${messageOf(error)}\n\n${USAGE}`, false);
  }
  const values = parsed.values;
  if (values.help === true) return 'help';

  const logLevel = values['log-level'] ?? env('DSH_LINK_LOG_LEVEL') ?? 'info';
  if (!LOG_LEVELS.has(logLevel)) {
    throw new AgentError('AGENT_USAGE', `invalid --log-level: ${logLevel}`, false);
  }

  const edgeUrl = values.edge ?? env('DSH_LINK_EDGE') ?? 'http://127.0.0.1:8787';
  const dshUrlFile = values['dsh-url-file'] ?? env('DSH_LINK_DSH_URL_FILE');
  const dshUrl = values['dsh-url'] ?? env('DSH_LINK_DSH_URL');
  if (dshUrlFile === undefined && (dshUrl === undefined || dshUrl === '')) {
    throw new AgentError('AGENT_USAGE', `either --dsh-url or --dsh-url-file is required\n\n${USAGE}`, false);
  }
  const stateDir = values['state-dir'] ?? env('DSH_LINK_STATE_DIR') ?? join(homedir(), '.dsh-link', 'agent');
  const name = values.name ?? env('DSH_LINK_NAME');
  const statusFile = values['status-file'] ?? env('DSH_LINK_STATUS_FILE');
  const insecure = values.insecure === true || envFlag('DSH_LINK_INSECURE') === true;

  const options: AgentOptions = {
    edgeUrl,
    dshUrl: dshUrl ?? '',
    stateDir,
    ...(dshUrlFile === undefined ? {} : { dshUrlFile }),
    ...(name === undefined ? {} : { name }),
    ...(insecure ? { insecure: true } : {}),
    logger: createLogger('dsh-link-agent', logLevel as LogLevel),
  };
  return { options, ...(statusFile === undefined ? {} : { statusFile }) };
}

async function main(argv: string[]): Promise<number> {
  let config: CliConfig | 'help';
  try {
    config = parseCli(argv);
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    return 2;
  }
  if (config === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const { options, statusFile } = config;
  const logger = options.logger ?? createLogger('dsh-link-agent');
  let lastPairUrl: string | undefined;
  let stopped = false;

  const emitStatus = (status: AgentStatus): void => {
    if (status.pairUrl !== undefined && status.pairUrl !== lastPairUrl) {
      lastPairUrl = status.pairUrl;
      process.stdout.write(`DSH_LINK_PAIR_URL=${status.pairUrl}\n`);
    }
    process.stdout.write(`${JSON.stringify({ type: 'status', ...status })}\n`);
    if (statusFile !== undefined) {
      try {
        writeStatusFileAtomic(statusFile, status);
      } catch (error) {
        logger.warn('could not write status file', { statusFile, error });
      }
    }
  };

  options.onStatus = emitStatus;

  // Unref'd timers keep the library test-friendly; the CLI needs a ref'd
  // handle so the process stays alive while pairing or reconnecting.
  const keepAlive = setInterval(() => undefined, 1 << 30);
  const stop = async (signal: string): Promise<void> => {
    stopped = true;
    logger.info('stopping on signal', { signal });
    await runtime.stop();
    clearInterval(keepAlive);
  };

  let runtime: AgentRuntime;
  try {
    runtime = await AgentRuntime.start(options);
  } catch (error) {
    clearInterval(keepAlive);
    logger.error('agent failed to start', { error });
    return error instanceof AgentError && error.code === 'AGENT_CONFIG' ? 2 : 1;
  }

  emitStatus(runtime.status());
  process.once('SIGINT', () => {
    void stop('SIGINT').then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void stop('SIGTERM').then(() => process.exit(0));
  });

  void runtime.done.then(() => {
    clearInterval(keepAlive);
    if (stopped) return;
    const status = runtime.status();
    if (status.state === 'error') {
      logger.error('agent stopped permanently', { lastError: status.lastError });
      process.exitCode = 1;
    }
  });

  return -1; // still running
}

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && pathToFileURL(entry).href === import.meta.url;
if (invokedDirectly || process.env['DSH_LINK_AGENT_CLI'] === '1') {
  void main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code);
  });
}