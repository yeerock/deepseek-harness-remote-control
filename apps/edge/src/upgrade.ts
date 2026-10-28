/**
 * Raw HTTP responses for sockets that never became an HTTP request handler
 * (WebSocket upgrades we reject, tunnels with bad credentials).
 */
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData } from 'ws';

export function toBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data);
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Write a minimal HTTP/1.1 response on a socket that is being closed. */
export function rejectUpgrade(socket: Duplex, status: number, message: string, headers: Record<string, string> = {}): void {
  if (socket.destroyed) return;
  const safeMessage = CONTROL_RE.test(message) ? 'request rejected' : message;
  const body = Buffer.from(`${String(status)} ${STATUS_CODES[status] ?? 'Error'}\n${safeMessage}\n`, 'utf8');
  const lines = [
    `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? 'Error'}`,
    'connection: close',
    'content-type: text/plain; charset=utf-8',
    `content-length: ${String(body.byteLength)}`,
    'cache-control: no-store',
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (CONTROL_RE.test(name) || CONTROL_RE.test(value)) continue;
    lines.push(`${name}: ${value}`);
  }
  try {
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    socket.write(body);
    socket.end();
  } catch {
    socket.destroy();
  }
}