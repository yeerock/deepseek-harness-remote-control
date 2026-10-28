import { describe, expect, it } from 'vitest';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, fullJitterDelay } from '../src/backoff.js';
import { classifyTunnelClose } from '../src/tunnel.js';
import { isTerminalHelloCode } from '../src/errors.js';
import { CloseCode } from '@dsh-rc/protocol';

describe('full-jitter backoff', () => {
  it('stays below base on the first attempt and doubles the ceiling', () => {
    const almostOne = () => 0.999_999;
    expect(fullJitterDelay(0, { random: almostOne })).toBeLessThan(BACKOFF_BASE_MS);
    expect(fullJitterDelay(1, { random: almostOne })).toBeLessThan(BACKOFF_BASE_MS * 2);
    expect(fullJitterDelay(2, { random: almostOne })).toBeLessThan(BACKOFF_BASE_MS * 4);
    expect(fullJitterDelay(0, { random: () => 0 })).toBe(0);
  });

  it('never exceeds the 20 s cap', () => {
    expect(BACKOFF_CAP_MS).toBe(20_000);
    for (const attempt of [0, 1, 2, 5, 10, 50]) {
      const delay = fullJitterDelay(attempt, { random: () => 0.999_999 });
      expect(delay).toBeLessThanOrEqual(BACKOFF_CAP_MS);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
    expect(fullJitterDelay(10, { random: () => 0.999_999, capMs: 1_000 })).toBeLessThan(1_000);
  });
});

describe('tunnel close classification', () => {
  it('treats protocol mismatch, auth failure and revocation as terminal', () => {
    for (const code of [CloseCode.ProtocolMismatch, CloseCode.AuthFailed, CloseCode.DeviceRevoked]) {
      const classification = classifyTunnelClose({ code, reason: 'because', at: Date.now() });
      expect(classification.retryable).toBe(false);
    }
    expect(classifyTunnelClose({ code: CloseCode.DeviceRevoked, reason: '', at: 0 }).message).toContain('revoked');
    expect(classifyTunnelClose({ code: CloseCode.AuthFailed, reason: '', at: 0 }).message).toContain('AUTH_FAILED');
    expect(classifyTunnelClose({ code: CloseCode.ProtocolMismatch, reason: '', at: 0 }).message).toContain('PROTOCOL_MISMATCH');
  });

  it('retries network drops, heartbeat timeouts, replacement and draining', () => {
    for (const code of [1006, 1001, CloseCode.HeartbeatTimeout, CloseCode.TunnelReplaced, CloseCode.ServerDraining, 4004]) {
      expect(classifyTunnelClose({ code, reason: 'transient', at: 0 }).retryable).toBe(true);
    }
  });

  it('classifies HELLO_ACK failures', () => {
    expect(isTerminalHelloCode('AUTH_FAILED')).toBe(true);
    expect(isTerminalHelloCode('DEVICE_REVOKED')).toBe(true);
    expect(isTerminalHelloCode('PROTOCOL_MISMATCH')).toBe(true);
    expect(isTerminalHelloCode('DEVICE_PENDING')).toBe(false);
    expect(isTerminalHelloCode('TUNNEL_BUSY')).toBe(false);
  });
});