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
