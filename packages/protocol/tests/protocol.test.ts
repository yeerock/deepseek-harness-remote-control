import { describe, expect, it } from 'vitest';
import {
  FrameType,
  MAX_FRAME_BYTES,
  ProtocolError,
  assertSafeOriginPath,
  classifyPriority,
  decodeFrame,
  encodeFrame,
  encodeJson,
  decodeJson,
  filterRequestHeaders,
  filterResponseHeaders,
  isHello,
  parseDevicePath,
} from '../src/index.js';

describe('frame codec', () => {
  it('round-trips type, stream id and payload', () => {
    const payload = new TextEncoder().encode('hello');
    const frame = decodeFrame(encodeFrame(FrameType.Data, 42, payload));
    expect(frame.type).toBe(FrameType.Data);
    expect(frame.streamId).toBe(42);
    expect(new TextDecoder().decode(frame.payload)).toBe('hello');
  });

  it('rejects a frame above the ceiling', () => {
    expect(() => encodeFrame(FrameType.Data, 1, new Uint8Array(MAX_FRAME_BYTES))).toThrow(ProtocolError);
  });

  it('rejects a truncated frame', () => {
    expect(() => decodeFrame(new Uint8Array([FrameType.Data, 0, 0]))).toThrow(ProtocolError);
  });

  it('rejects unknown frame types', () => {
    const bad = new Uint8Array(8);
    bad[0] = 200;
    expect(() => decodeFrame(bad)).toThrow(/unknown frame type/);
  });

  it('validates HELLO payloads', () => {
    const hello = {
      protocol: 1,
      deviceId: 'dev_abcdefabcdefabcd',
      token: 'secret',
      agentVersion: '0.1.0',
      platform: 'darwin-arm64',
      maxFrameBytes: 65536,
    };
    expect(isHello(hello)).toBe(true);
    expect(isHello({ ...hello, protocol: 2 })).toBe(false);
    expect(isHello({ ...hello, deviceId: 7 })).toBe(false);
  });

  it('round-trips JSON payloads', () => {
    const value = { code: 'CLIENT_ABORTED', message: 'gone' };
    expect(decodeJson(encodeJson(value), (input): input is typeof value => typeof input === 'object')).toEqual(value);
  });
});

describe('device paths', () => {
  const id = 'dev_0123456789abcdef';

  it('splits the mount prefix', () => {
    expect(parseDevicePath(`/d/${id}/api/session`)).toEqual({ deviceId: id, rest: '/api/session', needsSlash: false });
    expect(parseDevicePath(`/d/${id}`)).toEqual({ deviceId: id, rest: '/', needsSlash: true });
    expect(parseDevicePath('/d/nope/')).toBeNull();
    expect(parseDevicePath('/other')).toBeNull();
  });
});

describe('origin path safety', () => {
  it('accepts ordinary paths', () => {
    expect(() => assertSafeOriginPath('/assets/app.js?v=1')).not.toThrow();
    expect(() => assertSafeOriginPath('/api/remote.mux')).not.toThrow();
  });

  it('rejects escapes and authority confusion', () => {
    for (const bad of ['/../etc/passwd', '/a/../../b', '//evil.com/x', 'https://evil.com/', '/a\\b', '/a\u0000b']) {
      expect(() => assertSafeOriginPath(bad), bad).toThrow(ProtocolError);
    }
  });
});

describe('header filtering', () => {
  it('strips browser credentials and hop-by-hop headers', () => {
    const filtered = filterRequestHeaders(Object.entries({
      host: 'edge.example',
      cookie: 'secret',
      origin: 'https://edge.example',
      'sec-fetch-site': 'same-origin',
      authorization: 'Bearer edge',
      'x-dsh-rc-trace': 'abc',
      accept: 'text/html',
      'accept-language': 'en',
    }));
    expect(filtered).toEqual([['accept', 'text/html'], ['accept-language', 'en']]);
  });

  it('keeps websocket handshake headers only for upgrade streams', () => {
    const headers = Object.entries({
      'sec-websocket-key': 'abc',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'dsh',
      accept: '*/*',
    });
    expect(filterRequestHeaders(headers, { upgrade: true }).map(([name]) => name)).toEqual([
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-protocol',
      'accept',
    ]);
    expect(filterRequestHeaders(headers).map(([name]) => name)).toEqual(['accept']);
  });

  it('never leaks upstream cookies or transport headers', () => {
    const filtered = filterResponseHeaders(Object.entries({
      'set-cookie': 'dsh-auth=secret',
      'transfer-encoding': 'chunked',
      'content-type': 'text/html',
      'strict-transport-security': 'max-age=1',
    }));
    expect(filtered).toEqual([['content-type', 'text/html']]);
  });
});

describe('priority classification', () => {
  it('keeps documents and api interactive', () => {
    expect(classifyPriority('/', [['accept', 'text/html']], 'http')).toBe('high');
    expect(classifyPriority('/api/remote.mux', [], 'ws')).toBe('high');
    expect(classifyPriority('/api/session', [['accept', 'application/json']], 'http')).toBe('high');
  });

  it('deprioritises large static assets', () => {
    expect(classifyPriority('/assets/index-abc.js', [['accept', '*/*']], 'http')).toBe('low');
    expect(classifyPriority('/files/big.zip', [['accept', '*/*']], 'http')).toBe('low');
  });
});