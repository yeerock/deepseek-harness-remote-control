#!/usr/bin/env node
/**
 * DSH Link benchmark harness.
 *
 * Boots a mock DSH, the real edge and the real agent on loopback ephemeral
 * ports, then measures the numbers the architecture targets: tunnel connect
 * time, TTFB, throughput, sequential/concurrent request cost, reconnect after a
 * forced tunnel replacement, and interactive latency while bulk downloads run.
 *
 * Output: JSON + a markdown table in tools/bench/results/, plus the table on
 * stdout. `--quick` shrinks payloads and iteration counts for CI.
 *
 * Run: npx tsx tools/bench/bench.ts [--quick]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform as osPlatform, release as osRelease, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import WebSocket from 'ws';
import {
  FrameType,
  decodeFrame,
  encodeFrame,
  encodeJson,
  type Hello,
} from '../../packages/protocol/src/frames.js';
import {
  browserFetch,
  closeWebSocket,
  nextWsMessage,
  startStack,
  waitFor,
  wsOpen,
  type LinkStack,
} from '../../tests/harness/link.js';

const MB = 1024 * 1024;
const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const RESULTS_DIR = join(REPO_ROOT, 'tools', 'bench', 'results');

interface Metric {
  name: string;
  value: number;
  unit: string;
  notes?: string;
}

interface BenchReport {
  meta: {
    date: string;
    node: string;
    platform: string;
    arch: string;
    cpu: string;
    totalMemGiB: number;
    quick: boolean;
    repo: string;
  };
  metrics: Metric[];
  latencies: Record<string, { p50: number; p95: number; max: number; count: number }>;
  errors: string[];
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function summarize(values: number[]): { p50: number; p95: number; max: number; count: number } {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
    count: sorted.length,
  };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const sha = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

async function main(): Promise<void> {
  const quick = process.argv.includes('--quick');
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('usage: npx tsx tools/bench/bench.ts [--quick]');
    return;
  }
  const startedAt = new Date();
  const metrics: Metric[] = [];
  const latencies: BenchReport['latencies'] = {};
  const errors: string[] = [];
  const report = (name: string, value: number, unit: string, notes?: string): void => {
    metrics.push({ name, value: round(value), unit, ...(notes === undefined ? {} : { notes }) });
    console.log(`  ${name.padEnd(42)} ${String(round(value)).padStart(10)} ${unit}`);
  };

  console.log(`DSH Link bench — ${startedAt.toISOString()}${quick ? ' (quick)' : ''}`);
  const stack = await startStack();
  try {
    // ---------------------------------------------------------------- warmup
    const warmup = await browserFetch(stack, '/api/status');
    await warmup.arrayBuffer();

    // ------------------------------------------------------------ TTFB
    const ttfbSamples: number[] = [];
    for (let i = 0; i < (quick ? 5 : 20); i += 1) {
      const t0 = performance.now();
      const response = await browserFetch(stack, '/api/status');
      ttfbSamples.push(performance.now() - t0);
      await response.arrayBuffer();
    }
    latencies['ttfb'] = summarize(ttfbSamples);
    report('TTFB through edge (median)', latencies['ttfb']!.p50, 'ms', 'GET /api/status');
    report('TTFB p95', latencies['ttfb']!.p95, 'ms');

    // -------------------------------------------------------- throughput
    for (const size of quick ? [MB] : [MB, 16 * MB]) {
      const t0 = performance.now();
      const response = await browserFetch(stack, `/api/large?bytes=${String(size)}`);
      const body = Buffer.from(await response.arrayBuffer());
      const elapsed = performance.now() - t0;
      if (body.byteLength !== size) errors.push(`throughput ${String(size)}: got ${String(body.byteLength)} bytes`);
      report(`throughput ${size / MB} MiB`, (size / MB) / (elapsed / 1000), 'MiB/s', `sha256=${sha(body).slice(0, 12)}`);
    }

    // ------------------------------------------------- sequential requests
    const sequentialCount = quick ? 50 : 200;
    const sequential: number[] = [];
    const seqStart = performance.now();
    for (let i = 0; i < sequentialCount; i += 1) {
      const t0 = performance.now();
      const response = await browserFetch(stack, '/api/status');
      await response.arrayBuffer();
      sequential.push(performance.now() - t0);
    }
    const seqWall = performance.now() - seqStart;
    latencies['sequential'] = summarize(sequential);
    report(`${String(sequentialCount)} sequential requests (wall)`, seqWall, 'ms');
    report('sequential p50', latencies['sequential']!.p50, 'ms');
    report('sequential p95', latencies['sequential']!.p95, 'ms');
    report('sequential req/s', (sequentialCount / seqWall) * 1000, 'req/s');

    // --------------------------------------------------- concurrent requests
    const concurrentCount = quick ? 20 : 50;
    const concurrent: number[] = [];
    const conStart = performance.now();
    await Promise.all(Array.from({ length: concurrentCount }, async () => {
      const t0 = performance.now();
      const response = await browserFetch(stack, '/api/status');
      await response.arrayBuffer();
      concurrent.push(performance.now() - t0);
    }));
    const conWall = performance.now() - conStart;
    latencies['concurrent'] = summarize(concurrent);
    report(`${String(concurrentCount)} concurrent requests (wall)`, conWall, 'ms');
    report('concurrent p95', latencies['concurrent']!.p95, 'ms');

    // ------------------------------- interactive latency under bulk load
    const bulkStreams = 4;
    const bulkBytes = (quick ? 8 : 16) * MB;
    const drains = Array.from({ length: bulkStreams }, async () => {
      const response = await browserFetch(stack, `/assets/bulk.js?bytes=${String(bulkBytes)}&delayMs=1`);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('bulk response has no body');
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    });
    await waitFor(() => stack.mock.requestsTo('/assets/bulk.js').length >= bulkStreams, {
      timeoutMs: 5000,
      intervalMs: 5,
      label: 'bulk downloads started',
    });
    const interactive: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const t0 = performance.now();
      const response = await browserFetch(stack, '/api/status');
      await response.arrayBuffer();
      interactive.push(performance.now() - t0);
    }
    latencies['interactiveUnderBulk'] = summarize(interactive);
    report('interactive p95 under bulk', latencies['interactiveUnderBulk']!.p95, 'ms', `${String(bulkStreams)} x ${String(bulkBytes / MB)} MiB`);
    report('interactive max under bulk', latencies['interactiveUnderBulk']!.max, 'ms');
    await Promise.all(drains);

    // ------------------------- reconnect after forced tunnel replacement
    try {
      const reconnect = await measureReconnect(stack);
      report('reconnect after tunnel replacement', reconnect, 'ms', 'old tunnel closed with 4004');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`reconnect measurement failed: ${message}`);
      console.error(`  reconnect measurement failed: ${message}`);
    }

    // --------------------------------------- stop -> start tunnel connect
    await stack.agent.stop();
    const connectStart = performance.now();
    await stack.restartAgent();
    report('tunnel connect after agent restart', performance.now() - connectStart, 'ms', 'approved identity, no re-pair');
  } finally {
    await stack.stop();
  }

  const meta: BenchReport['meta'] = {
    date: startedAt.toISOString(),
    node: process.version,
    platform: osPlatform(),
    arch: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    totalMemGiB: round(totalmem() / 1024 ** 3, 1),
    quick,
    repo: REPO_ROOT,
  };
  const result: BenchReport = { meta, metrics, latencies, errors };
  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(RESULTS_DIR, `bench-${stamp}.json`);
  const mdPath = join(RESULTS_DIR, `bench-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const markdown = renderMarkdown(result);
  await writeFile(mdPath, markdown, 'utf8');
  console.log(`\n${markdown}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}`);
  if (errors.length > 0) {
    console.error(`\n${String(errors.length)} benchmark error(s):`);
    for (const error of errors) console.error(` - ${error}`);
    process.exitCode = 1;
  }
}

/**
 * Force the edge to close the agent's live tunnel by connecting a second
 * tunnel with the same device secret (the edge replaces the old one with close
 * code 4004, exactly as it does for a stale desktop tab). Then measure until a
 * proxied request succeeds again.
 */
async function measureReconnect(stack: LinkStack): Promise<number> {
  const identityPath = join(stack.agentStateDir, 'device.json');
  const identity = JSON.parse(await readFile(identityPath, 'utf8')) as { deviceId: string; deviceSecret: string };
  const wsUrl = `${stack.edgeUrl.replace(/^http/, 'ws')}/v1/tunnel`;
  const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${identity.deviceSecret}` } });
  try {
    await wsOpen(socket);
    const ackPromise = nextWsMessage(socket);
    const hello: Hello = {
      protocol: 1,
      deviceId: identity.deviceId,
      token: identity.deviceSecret,
      agentVersion: 'bench',
      platform: `${osPlatform()}-${process.arch}`,
      maxFrameBytes: 65_536,
    };
    socket.send(encodeFrame(FrameType.Hello, 0, encodeJson(hello)));
    const ack = decodeFrame((await ackPromise).data);
    if (ack.type !== FrameType.HelloAck) throw new Error(`expected HELLO_ACK, got frame ${String(ack.type)}`);
    const acknowledgedAt = performance.now();
    await closeWebSocket(socket);

    // Wait for the edge to actually lose the tunnel (503) before timing the
    // recovery; otherwise the request could still be answered by the old
    // socket and the reconnect number would be meaningless.
    await waitFor(async () => {
      try {
        const response = await browserFetch(stack, '/api/status');
        await response.arrayBuffer();
        return response.status === 503 || response.status === 403;
      } catch {
        return false;
      }
    }, { timeoutMs: 5000, intervalMs: 5, label: 'edge observes tunnel replacement (503)' });

    await waitFor(async () => {
      try {
        const response = await browserFetch(stack, '/api/status');
        if (response.status !== 200) {
          await response.arrayBuffer();
          return false;
        }
        await response.arrayBuffer();
        return true;
      } catch {
        return false;
      }
    }, { timeoutMs: 20_000, intervalMs: 10, label: 'agent reconnects after tunnel replacement' });
    return performance.now() - acknowledgedAt;
  } finally {
    await closeWebSocket(socket).catch(() => undefined);
  }
}

function renderMarkdown(report: BenchReport): string {
  const lines = [
    `# DSH Link benchmark — ${report.meta.quick ? 'quick' : 'full'}`,
    '',
    `- Date: ${report.meta.date}`,
    `- Machine: ${report.meta.cpu} · ${report.meta.platform}/${report.meta.arch} · ${String(report.meta.totalMemGiB)} GiB`,
    `- Runtime: Node ${report.meta.node}`,
    '',
    '| Metric | Value | Unit | Notes |',
    '| --- | ---: | --- | --- |',
  ];
  for (const metric of report.metrics) {
    lines.push(`| ${metric.name} | ${String(metric.value)} | ${metric.unit} | ${metric.notes ?? ''} |`);
  }
  if (report.errors.length > 0) {
    lines.push('', '## Errors', '');
    for (const error of report.errors) lines.push(`- ${error}`);
  }
  lines.push('', '<!-- generated by tools/bench/bench.ts -->', '');
  return lines.join('\n');
}

main().catch((error: unknown) => {
  console.error(`bench failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});