import { describe, expect, it } from 'vitest';
import { assertProxyPath } from '../src/proxy-http.js';

function rejects(path: string): void {
  expect(() => assertProxyPath(path), path).toThrow();
}

describe('assertProxyPath encoded traversal hardening', () => {
  it('rejects literal and single-encoded dot segments', () => {
    rejects('/../etc/passwd');
    rejects('/a/../../b');
    rejects('/%2e./x');
    rejects('/.%2e/x');
    rejects('/%2e%2e/x');
    rejects('/%2E%2E/x');
    rejects('/a/%2e%2e/b');
  });

  it('rejects double encoding outright', () => {
    rejects('/%252e%252e/x');
    rejects('/%2525');
    rejects('/a%25b');
  });

  it('rejects encoded separators, backslashes and control characters', () => {
    rejects('/a%2Fb');
    rejects('/a%2fb');
    rejects('/%2f%2fhost');
    rejects('/a%5Cb');
    rejects('/a%5cb');
    rejects('/a%00b');
    rejects('/a%0ab');
    rejects('/a%7fb');
    rejects('/bad%zz');
  });

  it('allows safe origin-form paths including ordinary percent-encoding', () => {
    const allowed = [
      '/',
      '/assets/app.js?v=2',
      '/api/remote.mux',
      '/search?q=hello%20world',
      '/files/%E2%9C%93.png',
      '/./index.html',
      '/a/b//c',
    ];
    for (const path of allowed) expect(() => assertProxyPath(path), path).not.toThrow();
  });
});

import { buildUpstreamHeaders, VIA_EDGE_HEADER } from '../src/proxy-http.js';

describe('edge marker header', () => {
  it('always sets the via-edge marker and drops a client-supplied copy', () => {
    const headers = buildUpstreamHeaders(
      { headers: [['x-dsh-rc-via', 'local'], ['accept', 'text/html']] } as never,
      { hostHeader: '127.0.0.1:1' } as never,
      undefined,
    );
    expect(headers[VIA_EDGE_HEADER]).toBe('edge');
    expect(headers['accept']).toBe('text/html');
  });
});

import { buildWsHeaders } from '../src/proxy-ws.js';

describe('edge marker on websocket upgrades', () => {
  it('sets the marker and drops a client-supplied copy', () => {
    const headers = buildWsHeaders(
      { headers: [['x-dsh-rc-via', 'local'], ['user-agent', 'ua']] } as never,
      { hostHeader: '127.0.0.1:1' } as never,
      undefined,
    );
    expect(headers['x-dsh-rc-via']).toBe('edge');
    expect(headers['user-agent']).toBe('ua');
  });
});
