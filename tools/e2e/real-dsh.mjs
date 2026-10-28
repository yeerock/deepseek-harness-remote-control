#!/usr/bin/env node
/**
 * Real-DSH end-to-end proof.
 *
 * Boots three real processes:
 *   1. an isolated `dsh --profile web` instance (its own DSH_HOME),
 *   2. the DSH RC edge,
 *   3. the DSH RC agent pointed at that Harness.
 *
 * Then drives the actual owner-setup + pairing flow over HTTP, loads
 * `/d/<device>/` through the edge with a headless Chromium, and asserts that the
 * unmodified Harness UI renders and its `/api/remote.mux` WebSocket connects.
 *
 * Usage:
 *   node tools/e2e/real-dsh.mjs [--keep] [--no-browser]
 *
 * Env:
 *   DSH_CLI   path to @deepseek-ai/dsh/lib/bin.js
 *   CHROMIUM  path to a Chromium/Chrome-for-Testing binary
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { chmod, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = new Set(process.argv.slice(2));
const KEEP = args.has('--keep');
const NO_BROWSER = args.has('--no-browser');

const DSH_CLI = process.env.DSH_CLI
  ?? '/tmp/asar_tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
const CHROMIUM = process.env.CHROMIUM
  ?? path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshrc-e2e-'));
const children = [];
const results = { steps: [], ok: false };

function log(message, fields = {}) {
  const line = { ts: new Date().toISOString(), msg: message, ...fields };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function step(name, detail) {
  results.steps.push({ name, detail, at: Date.now() });
  log(`step: ${name}`, detail === undefined ? {} : { detail });
}

function spawnLogged(name, command, argv, options = {}) {
  const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  children.push({ name, child });
  return child;
}

async function waitForOutput(child, regex, timeoutMs, name) {
  let buffer = '';
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${name}: timed out after ${String(timeoutMs)}ms waiting for ${String(regex)}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk;
      const match = regex.exec(buffer);
      if (match !== null) {
        cleanup();
        resolve(match);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`${name}: exited with ${String(code)} before matching ${String(regex)}\n${buffer.slice(-2000)}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

class Jar {
  cookies = new Map();

  absorb(response) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0];
      const equals = pair.indexOf('=');
      if (equals <= 0) continue;
      this.cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
  }

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

function makeClient(baseUrl) {
  const jar = new Jar();
  const request = async (pathname, options = {}) => {
    const headers = { ...(options.headers ?? {}) };
    if (jar.cookies.size > 0) headers.cookie = jar.header();
    if (options.origin !== false) headers.origin = baseUrl;
    let body;
    if (options.form !== undefined) {
      body = new URLSearchParams(options.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers['content-type'] = 'application/json';
    }
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      redirect: 'manual',
    });
    jar.absorb(response);
    return response;
  };
  return { request, jar, csrf: () => jar.cookies.get('dshrc_csrf') };
}

async function poll(fn, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (predicate(last)) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label}: timed out; last=${String(last)}`);
}

async function main() {
  log('workspace', { repo, tmp, dshCli: DSH_CLI, chromium: CHROMIUM });

  if (!existsSync(DSH_CLI)) throw new Error(`DSH CLI not found at ${DSH_CLI}; set DSH_CLI`);

  // 1. Isolated, real Harness web server.
  const dshHome = path.join(tmp, 'dsh-home');
  mkdirSync(dshHome, { recursive: true });
  const dsh = spawnLogged('dsh', process.execPath, [DSH_CLI, '--profile', 'web', '--port', '0', '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, NO_COLOR: '1' },
  });
  const dshMatch = await waitForOutput(dsh, /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/, 60_000, 'dsh');
  const dshUrl = dshMatch[1];
  const dshOrigin = new URL(dshUrl).origin;
  step('dsh web booted', { origin: dshOrigin });

  // 2. Edge.
  const setupCode = `e2e-${Math.random().toString(36).slice(2, 10)}-code`;
  const edgeData = path.join(tmp, 'edge-data');
  const edge = spawnLogged('edge', process.execPath, [
    '--import', 'tsx', path.join(repo, 'apps/edge/src/main.ts'),
    '--host', '127.0.0.1', '--port', '0',
    '--data-dir', edgeData, '--insecure', '--setup-code', setupCode,
    '--log-level', 'warn',
  ], { cwd: repo, env: { ...process.env, NO_COLOR: '1' } });
  const edgeMatch = await waitForOutput(edge, /DSH RC edge listening on (http:\/\/127\.0\.0\.1:\d+)/, 30_000, 'edge');
  const edgeUrl = edgeMatch[1];
  step('edge booted', { edgeUrl });

  const client = makeClient(edgeUrl);

  // 3. Owner setup.
  const setupPage = await client.request('/setup');
  if (setupPage.status !== 200) throw new Error(`GET /setup -> ${String(setupPage.status)}`);
  const csrf = client.csrf();
  if (csrf === undefined) throw new Error('setup page did not set a CSRF cookie');
  const setupPost = await client.request('/setup', {
    form: { code: setupCode, password: 'correct-horse-battery', csrf },
  });
  if (setupPost.status !== 303) throw new Error(`POST /setup -> ${String(setupPost.status)}`);
  step('owner configured');

  // 5. Agent, with the token handed over in a 0600 file (never argv).
  const agentState = path.join(tmp, 'agent-state');
  mkdirSync(agentState, { recursive: true, mode: 0o700 });
  const upstreamFile = path.join(agentState, 'upstream.json');
  writeFileSync(upstreamFile, JSON.stringify({ url: dshUrl, createdAt: Date.now() }), { mode: 0o600 });
  await chmod(upstreamFile, 0o600);
  const statusFile = path.join(agentState, 'status.json');
  spawnLogged('agent', process.execPath, [
    '--import', 'tsx', path.join(repo, 'apps/agent/src/main.ts'),
    '--edge', edgeUrl,
    '--dsh-url-file', upstreamFile,
    '--state-dir', agentState,
    '--name', 'E2E desktop',
    '--status-file', statusFile,
    '--log-level', 'warn',
  ], { cwd: repo, env: { ...process.env, NO_COLOR: '1' } });
  step('agent spawned', { stateDir: agentState });

  // 6. The agent registered itself on first run; take its device id + code.
  const agentStatus = await poll(
    async () => {
      try {
        return JSON.parse(await readFile(statusFile, 'utf8'));
      } catch {
        return undefined;
      }
    },
    (status) => typeof status?.pairUrl === 'string' && typeof status?.deviceId === 'string',
    20_000,
    'agent pairing status',
  );
  const pairCode = new URL(agentStatus.pairUrl).searchParams.get('code');
  if (pairCode === null) throw new Error('agent pairUrl has no code');
  step('agent reported pairing', { deviceId: agentStatus.deviceId, pairUrl: agentStatus.pairUrl });

  // 7. Pair the browser with the code, authenticated by the owner session.
  const pair = await client.request('/pair', {
    form: { code: pairCode, csrf: client.csrf() ?? '' },
  });
  if (pair.status !== 303) throw new Error(`POST /pair -> ${String(pair.status)} ${await pair.text()}`);
  step('browser paired', { location: pair.headers.get('location') });

  // 8. Wait for the tunnel.
  await poll(async () => {
    const response = await client.request('/healthz', { origin: false });
    return await response.json();
  }, (body) => body.ok === true, 5_000, 'healthz');
  const devicePath = `/d/${agentStatus.deviceId}/`;
  const page = await poll(
    async () => client.request(devicePath),
    (response) => response.status === 200,
    30_000,
    'device page',
  );
  const html = await page.text();
  const markers = {
    hasTitle: /<title>DeepSeek Harness<\/title>/i.test(html),
    hasBoot: html.includes('__DSH_BOOT_READY__'),
    leaksLoopback: new RegExp(dshOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(html),
  };
  step('index through the edge', { bytes: html.length, ...markers });
  if (!markers.hasTitle || !markers.hasBoot) throw new Error('proxied index is not the Harness shell');
  if (markers.leaksLoopback) throw new Error('proxied index leaks the loopback origin');

  // 9. WebSocket mux.
  const wsStatus = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${new URL(edgeUrl).host}${devicePath}api/remote.mux`, {
      headers: { cookie: client.jar.header(), origin: edgeUrl },
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('remote.mux did not open within 15s'));
    }, 15_000);
    socket.on('open', () => {
      clearTimeout(timer);
      socket.close();
      resolve('open');
    });
    socket.on('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      reject(new Error(`remote.mux upgrade -> ${String(response.statusCode)}`));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  step('remote.mux websocket', { status: wsStatus });

  // 10. Real browser render.
  if (!NO_BROWSER && existsSync(CHROMIUM)) {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const cookies = [...client.jar.cookies].map(([name, value]) => ({
        name, value, domain: '127.0.0.1', path: '/', httpOnly: false, secure: false, sameSite: 'Lax',
      }));
      await context.addCookies(cookies);
      const browserPage = await context.newPage();
      const consoleErrors = [];
      const sockets = [];
      const pending = new Set();
      const finished = new Set();
      browserPage.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      browserPage.on('pageerror', (error) => consoleErrors.push(error.message));
      browserPage.on('websocket', (socket) => sockets.push(socket.url()));
      browserPage.on('request', (request) => pending.add(request.url()));
      browserPage.on('requestfinished', (request) => { pending.delete(request.url()); finished.add(request.url()); });
      browserPage.on('requestfailed', (request) => {
        pending.delete(request.url());
        consoleErrors.push(`requestfailed ${request.url()} ${request.failure()?.errorText ?? ''}`);
      });
      await browserPage.goto(`${edgeUrl}${devicePath}`, { waitUntil: 'commit', timeout: 20_000 });
      await browserPage.waitForTimeout(9000);
      const text = await browserPage.locator('body').innerText();
      const artifacts = path.join(here, 'artifacts');
      mkdirSync(artifacts, { recursive: true });
      const screenshot = path.join(artifacts, 'dsh-through-edge.png');
      await browserPage.screenshot({ path: screenshot, fullPage: false });
      step('browser render', {
        screenshot,
        sockets,
        rendered: /DeepSeek Harness|New Session|Workspaces/i.test(text),
        consoleErrors: consoleErrors.slice(0, 8),
        finishedRequests: finished.size,
        pendingRequests: [...pending].slice(0, 12),
        textSample: text.slice(0, 200),
      });
      if (!/New Session|Workspaces|DeepSeek Harness/i.test(text)) throw new Error('Harness UI did not render through the edge');
    } finally {
      await browser.close().catch(() => {});
    }
  } else {
    step('browser render', { skipped: true, reason: NO_BROWSER ? '--no-browser' : 'chromium not found' });
  }

  results.ok = true;
  log('E2E PASSED', { elapsedMs: Date.now() - results.startedAt });
}

results.startedAt = Date.now();

main()
  .catch((error) => {
    results.ok = false;
    results.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    log('E2E FAILED', { error: results.error });
  })
  .finally(async () => {
    const reportPath = path.join(here, 'artifacts');
    mkdirSync(reportPath, { recursive: true });
    writeFileSync(path.join(reportPath, 'real-dsh-e2e.json'), JSON.stringify(results, null, 2));
    if (KEEP) {
      log('keeping processes alive; press Ctrl-C', { edgeUrl, tmp });
      await new Promise(() => {});
    }
    for (const { name, child } of children.reverse()) {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      void name;
    }
    if (!KEEP) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    process.exitCode = results.ok ? 0 : 1;
    setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
  });