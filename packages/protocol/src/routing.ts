/**
 * Shared routing helpers: how a public request is mapped onto a device path,
 * and which headers may cross the trust boundary.
 *
 * The rules are deliberately boring and total: the edge strips its own prefix,
 * refuses anything that could be read as an absolute URL or a path escape, and
 * rebuilds the upstream authority. Both peers run the same functions so a
 * mismatch cannot silently widen what the agent will fetch.
 */
import { ProtocolError } from './frames.js';

/** Public mount for a device: `/d/<deviceId>/...`. */
export const DEVICE_MOUNT_PREFIX = '/d/';

const DEVICE_ID_RE = /^dev_[a-z0-9]{16,64}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

export function isValidDeviceId(value: string): boolean {
  return DEVICE_ID_RE.test(value);
}

/**
 * Split `/d/<deviceId>/rest` into its device id and origin-form remainder.
 * `/d/<id>` (no trailing slash) is reported with `needsSlash` so callers can
 * redirect rather than serve a page whose relative URLs resolve one level up.
 */
export function parseDevicePath(pathname: string): { deviceId: string; rest: string; needsSlash: boolean } | null {
  if (!pathname.startsWith(DEVICE_MOUNT_PREFIX)) return null;
  const remainder = pathname.slice(DEVICE_MOUNT_PREFIX.length);
  const slash = remainder.indexOf('/');
  const deviceId = slash === -1 ? remainder : remainder.slice(0, slash);
  if (!isValidDeviceId(deviceId)) return null;
  if (slash === -1) return { deviceId, rest: '/', needsSlash: true };
  return { deviceId, rest: remainder.slice(slash), needsSlash: false };
}

/**
 * Validate the origin-form path the edge hands to the agent.
 *
 * Rejected on purpose: control characters (response splitting), `//` and `\\`
 * authority confusion, absolute URLs, and any `..` segment. The agent repeats
 * this validation; a compromised edge still cannot make the agent fetch an
 * arbitrary origin.
 */
export function assertSafeOriginPath(path: string): void {
  if (!path.startsWith('/')) throw new ProtocolError('PROTOCOL_BAD_FRAME', 'path must be origin-form');
  if (path.length > 8192) throw new ProtocolError('PROTOCOL_BAD_FRAME', 'path too long');
  if (CONTROL_CHAR_RE.test(path)) throw new ProtocolError('PROTOCOL_BAD_FRAME', 'path contains control characters');
  if (path.startsWith('//') || path.includes('\\')) throw new ProtocolError('PROTOCOL_BAD_FRAME', 'path looks like an authority');
  if (/^\/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) throw new ProtocolError('PROTOCOL_BAD_FRAME', 'absolute URL in path');
  for (const segment of path.split('/')) {
    if (segment === '..') throw new ProtocolError('PROTOCOL_BAD_FRAME', 'path traversal segment');
  }
}

/** Hop-by-hop plus browser-credential headers that must never be forwarded. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'true-client-ip',
  'authorization', // public authorization is the edge session, never a DSH credential
]);

/** Response headers that must not cross back to a remote browser. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
  'content-security-policy-report-only',
  'strict-transport-security', // the edge owns HSTS for its own host
]);

export function filterRequestHeaders(
  headers: Iterable<[string, string | string[] | undefined]>,
  options: { upgrade?: boolean } = {},
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [rawName, value] of headers) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(name)) continue;
    if (name.startsWith('x-dsh-link-')) continue;
    // WebSocket handshake headers survive only on a ws stream.
    if (!options.upgrade && (name.startsWith('sec-websocket-') || name === 'sec-websocket-key' || name === 'sec-websocket-version' || name === 'sec-websocket-protocol' || name === 'sec-websocket-extensions')) continue;
    const text = Array.isArray(value) ? value.join(', ') : value;
    if (CONTROL_CHAR_RE.test(text)) continue;
    out.push([name, text]);
  }
  return out;
}

export function filterResponseHeaders(
  headers: Iterable<[string, string | string[] | undefined]>,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [rawName, value] of headers) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
    const text = Array.isArray(value) ? value.join(', ') : value;
    if (CONTROL_CHAR_RE.test(text)) continue;
    out.push([name, text]);
  }
  return out;
}

export function headerValue(headers: Array<[string, string]>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of headers) if (key.toLowerCase() === lower) return value;
  return undefined;
}

/**
 * Classify a request for the scheduler. Documents, API calls and WebSocket
 * upgrades are interactive; large static assets are not. This is what keeps a
 * 200 MB download from adding latency to a keystroke.
 */
export function classifyPriority(path: string, headers: Array<[string, string]>, kind: 'http' | 'ws'): 'high' | 'normal' | 'low' {
  if (kind === 'ws') return 'high';
  if (path.startsWith('/api/')) return 'high';
  const accept = headerValue(headers, 'accept') ?? '';
  const dest = headerValue(headers, 'sec-fetch-dest') ?? '';
  if (!accept.includes('text/html') && /\.(js|css|woff2?|png|jpe?g|webp|svg|map|mp4|wasm|zip|pdf)(\?|$)/i.test(path)) return 'low';
  if (dest === 'document' || accept.startsWith('text/html')) return 'high';
  return 'normal';
}

/** Rewrite an upstream absolute loopback Location into the public device path. */
export function rewriteLocation(location: string, origin: string, publicBase: string): string {
  try {
    const url = new URL(location);
    if (`${url.protocol}//${url.host}` !== origin) return location;
    return `${publicBase}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return location;
  }
}