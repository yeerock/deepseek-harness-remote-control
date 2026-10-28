/**
 * Test harness: temp state dir + AgentRuntime with fast timers, plus helpers
 * for reading a mux stream from the edge side.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type Logger } from '@dsh-rc/shared';
import type { Stream } from '@dsh-rc/mux';
import { AgentRuntime, type RuntimeInternals } from '../../src/runtime.js';
import type { AgentOptions, AgentStatus } from '../../src/types.js';

export interface TestAgent {
  agent: AgentRuntime;
  stateDir: string;
  statuses: AgentStatus[];
  cleanup(): Promise<void>;
}

export interface TestAgentOptions {
  edgeUrl: string;
  dshUrl: string;
  name?: string;
  insecure?: boolean;
  dshToken?: string;
  dshUrlFile?: string;
  logger?: Logger;
  internals?: RuntimeInternals;
}

/** Logger that records JSON-stringified message + fields for leak assertions. */
export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (message, fields) => { lines.push(JSON.stringify({ message, fields })); },
    info: (message, fields) => { lines.push(JSON.stringify({ message, fields })); },
    warn: (message, fields) => { lines.push(JSON.stringify({ message, fields })); },
    error: (message, fields) => { lines.push(JSON.stringify({ message, fields })); },
    child: () => logger,
  };
  return { logger, lines };
}

export async function startTestAgent(options: TestAgentOptions): Promise<TestAgent> {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-rc-agent-'));
  const statuses: AgentStatus[] = [];
  const agentOptions: AgentOptions = {
    edgeUrl: options.edgeUrl,
    dshUrl: options.dshUrl,
    stateDir,
    name: options.name ?? 'test-agent',
    logger: options.logger ?? createLogger('test-agent', 'silent'),
    onStatus: (status) => statuses.push(status),
    ...(options.insecure === true ? { insecure: true } : {}),
    ...(options.dshToken === undefined ? {} : { dshToken: options.dshToken }),
    ...(options.dshUrlFile === undefined ? {} : { dshUrlFile: options.dshUrlFile }),
  };
  const agent = await AgentRuntime.start(agentOptions, {
    pairPollMs: 50,
    connectTimeoutMs: 3_000,
    backoff: { baseMs: 5, capMs: 40, random: () => 0.5 },
    ...options.internals,
  });
  return {
    agent,
    stateDir,
    statuses,
    async cleanup() {
      await agent.stop();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

export async function readBody(stream: Stream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream.body()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Collect the first WS frame matching an opcode, with a deadline. */
export function nextFrame(stream: Stream, timeoutMs = 5_000): Promise<{ opcode: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for a websocket frame'));
    }, timeoutMs);
    timer.unref?.();
    const unsubscribe = stream.onFrame((opcode, data) => {
      clearTimeout(timer);
      unsubscribe();
      resolve({ opcode, data: Buffer.from(data) });
    });
  });
}

export function states(statuses: AgentStatus[]): string[] {
  return statuses.map((status) => status.state);
}