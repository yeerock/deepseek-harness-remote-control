import { describe, expect, it } from 'vitest';
import {
  HELLO_HEARTBEAT_MAX_MS,
  PREATTACH_MAX_BYTES,
  PREATTACH_MAX_FRAMES,
  checkPreAttachBuffer,
  validateHelloAckLimits,
} from '../src/tunnel.js';
import { AgentError } from '../src/errors.js';
import { DEFAULT_HEARTBEAT_MS, DEFAULT_IDLE_TIMEOUT_MS, INITIAL_STREAM_WINDOW } from '@dsh-link/protocol';

function ack(overrides: Partial<{ heartbeatMs: number; idleTimeoutMs: number; initialStreamWindow: number }> = {}) {
  return {
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    initialStreamWindow: INITIAL_STREAM_WINDOW,
    ...overrides,
  };
}

describe('HELLO_ACK resource limits', () => {
  it('accepts the protocol defaults', () => {
    expect(validateHelloAckLimits(ack())).toEqual({
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      initialStreamWindow: INITIAL_STREAM_WINDOW,
    });
  });

  it('replaces zero values with defaults so the mux never gets 0', () => {
    expect(validateHelloAckLimits({ heartbeatMs: 0, idleTimeoutMs: 0, initialStreamWindow: 0 })).toEqual({
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      initialStreamWindow: INITIAL_STREAM_WINDOW,
    });
  });

  it('rejects out-of-range heartbeat values', () => {
    for (const heartbeatMs of [500, 999, HELLO_HEARTBEAT_MAX_MS + 1, -1, 1.5]) {
      expect(() => validateHelloAckLimits(ack({ heartbeatMs })), String(heartbeatMs)).toThrow(AgentError);
    }
  });

  it('requires idleTimeoutMs >= 3 * heartbeat and <= 300 s', () => {
    expect(() => validateHelloAckLimits(ack({ heartbeatMs: 60_000, idleTimeoutMs: 120_000 }))).toThrow(/idleTimeoutMs/);
    expect(() => validateHelloAckLimits(ack({ idleTimeoutMs: 300_001 }))).toThrow(/idleTimeoutMs/);
    expect(validateHelloAckLimits(ack({ heartbeatMs: 30_000, idleTimeoutMs: 90_000 })).idleTimeoutMs).toBe(90_000);
  });

  it('bounds the initial stream window to 16 KiB..8 MiB', () => {
    for (const initialStreamWindow of [1, 16_383, 8_388_609, -1]) {
      expect(() => validateHelloAckLimits(ack({ initialStreamWindow })), String(initialStreamWindow)).toThrow(AgentError);
    }
    expect(validateHelloAckLimits(ack({ initialStreamWindow: 16_384 })).initialStreamWindow).toBe(16_384);
    expect(validateHelloAckLimits(ack({ initialStreamWindow: 8_388_608 })).initialStreamWindow).toBe(8_388_608);
  });
});

describe('pre-attach handshake buffer cap', () => {
  it('accepts the limit and rejects one frame/byte over it', () => {
    expect(() => checkPreAttachBuffer(PREATTACH_MAX_FRAMES, PREATTACH_MAX_BYTES)).not.toThrow();
    expect(() => checkPreAttachBuffer(PREATTACH_MAX_FRAMES + 1, 0)).toThrow(AgentError);
    expect(() => checkPreAttachBuffer(1, PREATTACH_MAX_BYTES + 1)).toThrow(AgentError);
  });
});
