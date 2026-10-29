/**
 * Remote conversation probe: signs in to the edge as owner, opens this Harness's
 * own UI through the tunnel, opens one of its sessions in the remote
 * conversation panel (same pipeline a peer uses) and screenshots the result.
 *
 *   EDGE=https://… DEVICE=dev_… SESSION=session-… node tools/e2e/remote-chat.mjs
 * Owner password is read from ~/.dsh-rc/owner-password.txt.
 *
 * Since v0.3.0 a browser through the edge may not call `session.*` (onward
 * calls stay with the local window), so against a v0.3.0 host this probe
 * shows the "not available over the edge" error in the panel: that is the
 * expected, secure result. It verified rendering against v0.3.0-pre.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const EDGE = process.env.EDGE, DEVICE = process.env.DEVICE, SESSION = process.env.SESSION;
const OUT = process.env.OUT ?? 'remote-chat.png';
const password = readFileSync(`${homedir()}/.dsh-rc/owner-password.txt`, 'utf8').trim();
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 800) } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${EDGE}/login`);
await page.fill('#password', password);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
await page.goto(`${EDGE}/d/${DEVICE}/`);
await page.waitForFunction(() => typeof globalThis.__DSH_RC_OPEN_REMOTE__ === 'function', null, { timeout: 30000 });
await page.evaluate(([d, s]) => globalThis.__DSH_RC_OPEN_REMOTE__({ deviceId: d, deviceName: 'Office Mac', sessionId: s, title: '' }), [DEVICE, SESSION]);
await page.waitForSelector('[data-dsh-rc-remote-chat] .dsh-rc-chat-assistant, [data-dsh-rc-remote-chat] .dsh-rc-chat-error', { timeout: 40000 });
await page.waitForTimeout(1500);
const result = await page.evaluate(() => {
  const root = document.querySelector('[data-dsh-rc-remote-chat]');
  const body = root?.querySelector('.dsh-rc-chat-body');
  const box = root?.getBoundingClientRect();
  return {
    title: root?.querySelector('.dsh-rc-chat-title')?.textContent,
    users: root?.querySelectorAll('.dsh-rc-chat-user').length,
    assistants: root?.querySelectorAll('.dsh-rc-chat-assistant').length,
    tools: root?.querySelectorAll('.dsh-rc-chat-tool').length,
    error: root?.querySelector('.dsh-rc-chat-error')?.textContent ?? null,
    composer: root?.querySelector('.dsh-rc-chat-input') !== null,
    panelWidth: Math.round(box?.width ?? 0),
    bodyScrolls: body ? body.scrollHeight > body.clientHeight : false,
    pageScrolls: document.scrollingElement.scrollHeight > window.innerHeight + 1,
  };
});
await page.screenshot({ path: OUT });
console.log(JSON.stringify({ ...result, pageErrors: errors.slice(0, 5) }, null, 2));
await browser.close();
