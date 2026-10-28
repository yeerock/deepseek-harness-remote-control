/**
 * DSH bootstrap: exchange the one-time launch token for the loopback-bound
 * session cookie, keep it in memory, and refresh it on upstream 401.
 *
 * The token and cookie are process-local. They are never written to disk,
 * never logged, and never placed on a tunnel frame — the browser only ever
 * talks to the edge.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import type { Logger } from '@dsh-link/shared';
import { AUTHENTICATION_HINT, AgentError, DshAuthError, TerminalAgentError, messageOf } from './errors.js';

export const DEFAULT_TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * Read the plugin-owned launch-URL file: 0600 JSON `{ "url": "..." }`.
 *
 * The file contents (and therefore the token) never reach a log line or an
 * error message; only the path appears. A looser mode is reported but not
 * fatal — the plugin owns the file and may still be mid-write.
 */
export function readDshUrlFile(filePath: string, logger?: Logger): string {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new TerminalAgentError('AGENT_CONFIG', `could not read dshUrlFile ${filePath}: ${messageOf(error)}`);
  }
  try {
    const mode = statSync(filePath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      logger?.warn('dshUrlFile is readable by other users; the launch token may be exposed', { path: filePath, mode: mode.toString(8) });
    }
  } catch {
    /* permission inspection is best effort */
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TerminalAgentError('AGENT_CONFIG', `dshUrlFile ${filePath} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TerminalAgentError('AGENT_CONFIG', `dshUrlFile ${filePath} must contain a JSON object`);
  }
  const url = (parsed as Record<string, unknown>)['url'];
  if (typeof url !== 'string' || url === '') {
    throw new TerminalAgentError('AGENT_CONFIG', `dshUrlFile ${filePath} must contain a non-empty "url" string`);
  }
  return url;
}

export interface DshTarget {
  /** Origin as configured (`http://127.0.0.1:4567`); never contains the token. */
  origin: string;
  protocol: 'http:' | 'https:';
  /** Always a loopback literal. */
  host: string;
  port: number;
  /** Value for the upstream `Host` header, e.g. `127.0.0.1:4567`. */
  hostHeader: string;
}

export interface ParsedDshUrl {
  target: DshTarget;
  token?: string;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/**
 * Parse and validate `dshUrl`. The fixed loopback target is the whole point:
 * an edge (or a bug) can never point the proxy at another origin.
 */
export function parseDshUrl(dshUrl: string, tokenOverride?: string): ParsedDshUrl {
  let url: URL;
  try {
    url = new URL(dshUrl);
  } catch {
    // Never echo the raw input: an unparseable dshUrl may still contain the
    // launch token in its query string.
    throw new TerminalAgentError('AGENT_CONFIG', 'invalid dshUrl (redacted)');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TerminalAgentError('AGENT_CONFIG', `dshUrl must be http(s), got ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new TerminalAgentError('AGENT_CONFIG', 'dshUrl must not contain embedded credentials');
  }
  if (!isLoopback(url.hostname)) {
    throw new TerminalAgentError(
      'AGENT_CONFIG',
      `dshUrl must point at the local DSH server (127.0.0.1, localhost or ::1); got ${url.hostname}`,
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const connectHost = hostname === '::1' ? '::1' : '127.0.0.1';
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const hostHeader = connectHost.includes(':') ? `[${connectHost}]:${String(port)}` : `${connectHost}:${String(port)}`;
  const tokenFromUrl = url.searchParams.get('token') ?? undefined;
  const token = tokenOverride !== undefined && tokenOverride !== '' ? tokenOverride : tokenFromUrl;
  if (token !== undefined && token.length > 8192) {
    throw new TerminalAgentError('AGENT_CONFIG', 'dshUrl token is unreasonably long');
  }
  return {
    target: {
      origin: url.origin,
      protocol: url.protocol,
      host: connectHost,
      port,
      hostHeader,
    },
    ...(token === undefined ? {} : { token }),
  };
}

/** Turn one or more Set-Cookie headers into a single Cookie request header. */
export function cookieHeaderFromSetCookie(setCookie: string[] | undefined): string | undefined {
  if (setCookie === undefined || setCookie.length === 0) return undefined;
  const pairs: string[] = [];
  for (const header of setCookie) {
    const pair = header.split(';', 1)[0]?.trim();
    if (pair === undefined || pair === '' || !pair.includes('=')) continue;
    pairs.push(pair);
  }
  return pairs.length === 0 ? undefined : pairs.join('; ');
}

interface ExchangeResult {
  status: number;
  setCookie: string[] | undefined;
}

function exchangeRequest(target: DshTarget, token: string, timeoutMs: number): Promise<ExchangeResult> {
  return new Promise<ExchangeResult>((resolve, reject) => {
    const url = new URL(`${target.origin}/`);
    url.searchParams.set('token', token);
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: target.protocol,
        hostname: target.host,
        port: target.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          'user-agent': 'dsh-link-agent/0.1.0',
          connection: 'close',
        },
      },
      (response) => {
        // Deliberately do not follow the 303: the cookie on the redirect
        // response is the credential we want, and following it would replay
        // the token to another path.
        resolve({ status: response.statusCode ?? 0, setCookie: response.headers['set-cookie'] });
        response.resume();
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('token exchange timed out'));
    });
    request.on('error', reject);
    request.end();
  });
}

export interface DshSessionOptions {
  dshUrl: string;
  dshToken?: string;
  logger?: Logger;
  tokenExchangeTimeoutMs?: number;
}

export class DshSession {
  readonly target: DshTarget;
  private readonly token: string | undefined;
  private readonly logger: Logger | undefined;
  private readonly timeoutMs: number;
  private cookieHeader: string | undefined;
  private bootstrap: Promise<void> | undefined;
  private refreshing: Promise<boolean> | undefined;
  private lastAuthError: string | undefined;

  constructor(options: DshSessionOptions) {
    const parsed = parseDshUrl(options.dshUrl, options.dshToken);
    this.target = parsed.target;
    this.token = parsed.token;
    this.logger = options.logger;
    this.timeoutMs = options.tokenExchangeTimeoutMs ?? DEFAULT_TOKEN_EXCHANGE_TIMEOUT_MS;
  }

  /** Whether a launch token is available to exchange (and re-exchange). */
  get canAuthenticate(): boolean {
    return this.token !== undefined;
  }

  get hasCookie(): boolean {
    return this.cookieHeader !== undefined;
  }

  get authError(): string | undefined {
    return this.lastAuthError;
  }

  /**
   * Cookie header for an upstream request; performs the one-time exchange on
   * first use. Returns undefined when the agent was started without a token.
   */
  async cookie(): Promise<string | undefined> {
    if (this.token === undefined) return undefined;
    if (this.cookieHeader !== undefined) return this.cookieHeader;
    this.bootstrap ??= this.exchange();
    try {
      await this.bootstrap;
    } catch (error) {
      // Allow a later request to retry the exchange after a transient failure.
      this.bootstrap = undefined;
      throw error;
    }
    return this.cookieHeader;
  }

  /**
   * Re-exchange the launch token for a fresh cookie. Deduplicated so a burst
   * of 401s produces exactly one exchange. Resolves false when there is no
   * token or the exchange failed.
   */
  async refresh(): Promise<boolean> {
    if (this.token === undefined) return false;
    if (this.refreshing !== undefined) return this.refreshing;
    this.refreshing = this.exchange()
      .then(() => {
        this.lastAuthError = undefined;
        this.logger?.info('dsh session cookie refreshed');
        return true;
      })
      .catch((error: unknown) => {
        this.lastAuthError = messageOf(error);
        this.logger?.warn('dsh session cookie refresh failed', { error });
        return false;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  /** Record that the upstream demanded auth and we have nothing to offer. */
  markAuthRequired(detail?: string): string {
    const message = detail === undefined ? AUTHENTICATION_HINT : `${AUTHENTICATION_HINT} (${detail})`;
    this.lastAuthError = message;
    return message;
  }

  markHealthy(): void {
    this.lastAuthError = undefined;
  }

  private async exchange(): Promise<void> {
    const token = this.token;
    if (token === undefined) throw new DshAuthError(AUTHENTICATION_HINT);
    let result: ExchangeResult;
    try {
      result = await exchangeRequest(this.target, token, this.timeoutMs);
    } catch (error) {
      throw new AgentError('UPSTREAM_UNREACHABLE', `could not exchange the DSH launch token: ${messageOf(error)}`, true);
    }
    if (result.status === 401 || result.status === 403) {
      throw new DshAuthError(`${AUTHENTICATION_HINT} (the DSH server rejected the launch token, HTTP ${String(result.status)})`);
    }
    const cookie = cookieHeaderFromSetCookie(result.setCookie);
    if (cookie === undefined) {
      throw new DshAuthError(
        `${AUTHENTICATION_HINT} (the DSH token exchange returned HTTP ${String(result.status)} without a session cookie)`,
      );
    }
    this.cookieHeader = cookie;
    this.lastAuthError = undefined;
  }
}