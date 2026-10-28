/**
 * Manual end-to-end smoke test against a *real* DeepSeek Harness web profile.
 *
 * Not part of `vitest run`: it needs a DSH install and boots it, which makes the
 * suite non-hermetic. It answers the question a mock cannot: does the unmodified
 * DSH UI load through edge -> agent -> loopback, including a >256 KiB JS bundle
 * and the /api/remote.mux WebSocket upgrade?
 *
 * Usage:
 *   DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js npx tsx tests/smoke/real-dsh.ts
 *
 * Defaults to /tmp/asar_tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js.
 * Uses an isolated DSH_HOME under os.tmpdir() and never opens a browser.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import {
  CookieJar,
  OWNER_PASSWORD,
  approveDevice,
  closeWebSocket,
  devicePath,
  loadAgentModule,
  nextWsMessage,
  ownerSetup,
  startEdge,
  waitFor,
  wsOpen,
  type AgentHandleLike,
} from '../harness/link.js';

const DSH_BIN = process.env['DSH_BIN'] ?? '/tmp/asar_tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return noopLogger;
  },
};

interface SmokeReport {
  ok: boolean;
  dsh: { origin: string; indexStatus: number; indexBytes: number; assetPath?: string; assetBytes?: number; assetShaEqual?: boolean };
  edge: { url: string; indexStatus?: number; indexBytes?: number; assetStatus?: number; assetBytes?: number; assetShaEqual?: boolean; muxUpgrade?: boolean; muxError?: string };
  timings: { bootMs?: number; tunnelOnlineMs?: number };
  error?: string;
}

function sha(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function bootDsh(): Promise<{ child: ChildProcessWithoutNullStreams; authUrl: string; home: string; bootMs: number }> {
  await access(DSH_BIN);
  const home = await mkdtemp(join(tmpdir(), 'dsh-smoke-home-'));
  const startedAt = performance.now();
  const child = spawn(process.execPath, [DSH_BIN, '--profile', 'web', '--port', '0', '--no-open'], {
    cwd: tmpdir(),
    env: { ...process.env, DSH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.on('data', (chunk: string) => { output += chunk; });
  try {
    const authUrl = (await waitFor(() => /^dsh web: (\S+)$/m.exec(output)?.[1], {
      timeoutMs: 45_000,
      intervalMs: 50,
      label: `DSH web profile to print an authenticated URL (${DSH_BIN})`,
    })) as string;
    return { child, authUrl, home, bootMs: performance.now() - startedAt };
  } catch (error) {
    child.kill('SIGTERM');
    await rm(home, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nDSH output:\n${output.slice(-4000)}`);
  }
}

async function main(): Promise<void> {
  const report: SmokeReport = {
    ok: false,
    dsh: { origin: '', indexStatus: 0, indexBytes: 0 },
    edge: { url: '' },
    timings: {},
  };
  let dsh: Awaited<ReturnType<typeof bootDsh>> | undefined;
  let edge: Awaited<ReturnType<typeof startEdge>> | undefined;
  let agent: AgentHandleLike | undefined;
  let edgeTemp: string | undefined;
  try {
    dsh = await bootDsh();
    report.timings.bootMs = Math.round(dsh.bootMs);
    const origin = new URL(dsh.authUrl).origin;
    report.dsh.origin = origin;

    // Prove the real DSH directly, and fetch the main bundle for comparison.
    const directJar = new CookieJar();
    const exchange = await fetch(dsh.authUrl, { redirect: 'manual' });
    directJar.absorb(exchange.headers.getSetCookie());
    const directIndex = await fetch(`${origin}/`, { headers: { cookie: directJar.header() ?? '' } });
    const indexHtml = await directIndex.text();
    report.dsh.indexStatus = directIndex.status;
    report.dsh.indexBytes = Buffer.byteLength(indexHtml);

    const assetSrc = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(indexHtml)?.[1];
    let directAsset: Buffer | undefined;
    if (assetSrc !== undefined) {
      const assetPath = new URL(assetSrc, `${origin}/`).pathname;
      report.dsh.assetPath = assetPath;
      const response = await fetch(`${origin}${assetPath}`, { headers: { cookie: directJar.header() ?? '' } });
      directAsset = Buffer.from(await response.arrayBuffer());
      report.dsh.assetBytes = directAsset.byteLength;
    }

    // Edge + agent against the real DSH.
    edgeTemp = await mkdtemp(join(tmpdir(), 'dsh-smoke-edge-'));
    edge = await startEdge({ dataDir: join(edgeTemp, 'edge'), setupCode: 'setup-smoke-1' });
    report.edge.url = edge.url;
    const owner = await ownerSetup(edge.url, 'setup-smoke-1', OWNER_PASSWORD);
    agent = await (await loadAgentModule()).startAgent({
      edgeUrl: edge.url,
      dshUrl: dsh.authUrl,
      name: 'real-dsh-smoke',
      stateDir: join(edgeTemp, 'agent'),
      insecure: true,
      logger: noopLogger,
    });
    const deviceId = String(await waitFor(() => agent?.status().deviceId, { timeoutMs: 10_000, intervalMs: 10, label: 'agent device id' }));
    const approval = await approveDevice(edge.url, owner, deviceId);
    if (approval.status >= 400 && approval.status !== 404) throw new Error(`approval failed: HTTP ${String(approval.status)}`);
    const onlineAt = performance.now();
    await agent.waitForOnline(20_000);
    report.timings.tunnelOnlineMs = Math.round(performance.now() - onlineAt);
    const device = { deviceId };
    const cookie = owner.cookieHeader ?? '';

    const throughIndex = await fetch(`${edge.url}${devicePath(device, '/')}`, { headers: { cookie }, redirect: 'manual' });
    const throughHtml = await throughIndex.text();
    report.edge.indexStatus = throughIndex.status;
    report.edge.indexBytes = Buffer.byteLength(throughHtml);
    if (report.dsh.assetPath !== undefined && directAsset !== undefined) {
      const throughAsset = await fetch(`${edge.url}${devicePath(device, report.dsh.assetPath)}`, { headers: { cookie }, redirect: 'manual' });
      const bytes = Buffer.from(await throughAsset.arrayBuffer());
      report.edge.assetStatus = throughAsset.status;
      report.edge.assetBytes = bytes.byteLength;
      report.edge.assetShaEqual = sha(bytes) === sha(directAsset);
    }

    const socket = new WebSocket(`${edge.url.replace(/^http/, 'ws')}${devicePath(device, '/api/remote.mux')}`, {
      headers: { cookie },
    });
    try {
      await wsOpen(socket, 15_000);
      report.edge.muxUpgrade = true;
      try {
        await nextWsMessage(socket, 2000);
      } catch {
        /* DSH sends no unsolicited frame until the client speaks; upgrade is what matters */
      }
    } catch (error) {
      report.edge.muxUpgrade = false;
      report.edge.muxError = error instanceof Error ? error.message : String(error);
    } finally {
      await closeWebSocket(socket);
    }

    report.ok =
      report.dsh.indexStatus === 200
      && report.edge.indexStatus === 200
      && report.edge.indexBytes === report.dsh.indexBytes
      && throughHtml.includes('<base href="./">')
      && (report.dsh.assetPath === undefined || (report.edge.assetStatus === 200 && report.edge.assetShaEqual === true))
      && report.edge.muxUpgrade === true;
  } catch (error) {
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await agent?.stop().catch(() => undefined);
    await edge?.stop().catch(() => undefined);
    if (edgeTemp !== undefined) await rm(edgeTemp, { recursive: true, force: true }).catch(() => undefined);
    if (dsh !== undefined) {
      dsh.child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        dsh?.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      await rm(dsh.home, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`smoke failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
