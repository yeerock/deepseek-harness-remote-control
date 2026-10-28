/**
 * Server-rendered edge pages. Every page is deliberately self-contained: no
 * external assets, no framework, inline CSS only. These are the only responses
 * that receive `applySecurityHeaders()`; proxied DSH responses never do.
 */
import type { AuditRow, DeviceRow } from './db.js';
import type { SharingSummary } from './sharing.js';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · DSH RC</title>
<style>
:root { color-scheme: dark; --bg:#0b1020; --panel:#131a2e; --line:#26314d; --text:#e6ecff; --muted:#94a3c4; --accent:#6aa7ff; --ok:#39d98a; --warn:#ffb454; --bad:#ff6b7a; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 40px 20px 80px; }
h1 { font-size: 24px; margin: 0 0 6px; letter-spacing:-0.01em; }
h2 { font-size: 16px; margin: 32px 0 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
p.lede { color: var(--muted); margin: 0 0 24px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
label { display:block; font-size:13px; color:var(--muted); margin: 14px 0 6px; }
input, select { width:100%; padding:11px 12px; border-radius:8px; border:1px solid var(--line); background:#0e1526; color:var(--text); font:inherit; }
select { appearance:auto; }
input:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
button, .button { display:inline-block; margin-top:18px; padding:11px 18px; border-radius:8px; border:0; background:var(--accent); color:#06122b; font:inherit; font-weight:650; cursor:pointer; text-decoration:none; }
button.secondary, .button.secondary { background:transparent; color:var(--text); border:1px solid var(--line); }
button.danger { background:var(--bad); color:#2a070b; }
form.inline { display:inline; }
.error { background:#2a1119; border:1px solid #5c2333; color:#ffb9c2; padding:10px 12px; border-radius:8px; margin-bottom:16px; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
tr:last-child td { border-bottom:0; }
.badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:650; }
.badge.online { background:#0f2e22; color:var(--ok); }
.badge.offline { background:#2a1d12; color:var(--warn); }
.badge.revoked { background:#2a1119; color:var(--bad); }
.badge.pending { background:#201a34; color:#b9a7ff; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; color:var(--muted); }
.muted { color: var(--muted); }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.spacer { flex:1; }
.topbar { display:flex; align-items:center; gap:14px; margin-bottom: 28px; }
.topbar .brand { font-weight:700; letter-spacing:-0.01em; }
.topbar a { color:var(--muted); text-decoration:none; }
.topbar a:hover { color:var(--text); }
code { background:#0e1526; border:1px solid var(--line); padding:1px 6px; border-radius:5px; font-size:13px; }
h3 { font-size:17px; margin:0 0 4px; }
h4 { font-size:14px; margin:20px 0 8px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
.warning { background:#2a1d12; border:1px solid #5c4223; color:#ffd9a3; padding:12px 14px; border-radius:10px; margin:0 0 16px; font-size:14px; }
.share-panel { margin-top:18px; }
.formgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; align-items:end; }
.formgrid label { margin-top:0; }
.table-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.table-actions button { margin-top:0; padding:7px 12px; font-size:13px; }
.input-url { width:100%; margin-top:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
.small { font-size:13px; }
</style>
</head>
<body>
<main>${body}</main>
</body>
</html>`;
}

function topbar(links: string): string {
  return `<div class="topbar"><span class="brand">DSH RC</span><span class="spacer"></span>${links}</div>`;
}

export function setupPage(options: { csrf: string; code?: string; error?: string }): string {
  const error = options.error === undefined ? '' : `<div class="error">${escapeHtml(options.error)}</div>`;
  return layout(
    'Set up this edge',
    `${topbar('')}
<h1>Set up this edge</h1>
<p class="lede">Enter the one-time setup code printed by the edge process. This creates the owner session for this browser.</p>
${error}
<div class="panel">
<form method="post" action="/setup">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <label for="code">Setup code</label>
  <input id="code" name="code" value="${escapeHtml(options.code ?? '')}" autocomplete="one-time-code" required autofocus>
  <label for="password">Owner password <span class="muted">(optional, at least 8 characters; enables /login later)</span></label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="8">
  <button type="submit">Create owner session</button>
</form>
</div>`,
  );
}

export function loginPage(options: { csrf: string; error?: string; hasPassword: boolean; next?: string }): string {
  const error = options.error === undefined ? '' : `<div class="error">${escapeHtml(options.error)}</div>`;
  const body = options.hasPassword
    ? `<form method="post" action="/login">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <input type="hidden" name="next" value="${escapeHtml(options.next ?? '/')}">
  <label for="password">Owner password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>`
    : `<p class="muted">No owner password was configured at setup. A session can only be recovered by restarting setup with a fresh database, or by using a paired device session.</p>`;
  return layout(
    'Sign in',
    `${topbar('')}
<h1>Sign in</h1>
<p class="lede">Owner access to the DSH RC edge.</p>
${error}
<div class="panel">${body}</div>`,
  );
}

export interface DashboardDevice {
  device: DeviceRow;
  online: boolean;
  reconnecting: boolean;
  sharing: SharingSummary;
}

function formatAge(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
}

function isLoopbackUrl(publicUrl: string): boolean {
  try {
    const host = new URL(publicUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
  } catch {
    return true;
  }
}

export function dashboardPage(options: {
  ownerName: string;
  csrf: string;
  devices: DashboardDevice[];
  audit: AuditRow[];
  edgeId: string;
  publicOrigin: string;
}): string {
  const rows = options.devices.length === 0
    ? `<tr><td colspan="5" class="muted">No Harnesses yet. Start the agent on a computer and it will register itself here.</td></tr>`
    : options.devices
        .map(({ device, online, reconnecting }) => {
          const state = device.status === 'revoked'
            ? '<span class="badge revoked">revoked</span>'
            : online
              ? '<span class="badge online">online</span>'
              : reconnecting
                ? '<span class="badge offline">reconnecting</span>'
                : '<span class="badge pending">offline</span>';
          const actions: string[] = [];
          if (device.status === 'pending') {
            actions.push(`<form class="inline" method="post" action="/v1/devices/${escapeHtml(device.id)}/approve"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button type="submit">Approve</button></form>`);
          }
          if (device.status === 'approved') {
            actions.push(`<a class="button secondary" href="/d/${escapeHtml(device.id)}/">Open</a>`);
            actions.push(`<form class="inline" method="post" action="/v1/devices/${escapeHtml(device.id)}/revoke"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button class="danger" type="submit">Revoke</button></form>`);
          }
          if (device.status === 'revoked') actions.push('<span class="muted">—</span>');
          return `<tr>
  <td><strong>${escapeHtml(device.name)}</strong><br><span class="mono">${escapeHtml(device.id)}</span><br><span class="mono">${escapeHtml(device.platform)} · agent ${escapeHtml(device.agentVersion)}</span></td>
  <td>${state}</td>
  <td class="muted">${escapeHtml(formatTime(device.lastSeenAt ?? device.lastConnectedAt ?? device.createdAt))}</td>
  <td class="muted">${escapeHtml(formatTime(device.createdAt))}</td>
  <td><div class="row">${actions.join('')}</div></td>
</tr>`;
        })
        .join('\n');

  const approvedDevices = options.devices.filter(({ device }) => device.status === 'approved');
  const sharingSections = approvedDevices.length === 0
    ? '<p class="muted">Approve a device before sharing it.</p>'
    : approvedDevices.map(({ device, sharing }) => {
        const state = sharing.enabled
          ? '<span class="badge online">sharing on</span>'
          : '<span class="badge pending">sharing off</span>';
        const loopback = isLoopbackUrl(sharing.publicUrl)
          ? '<p class="warning">Guests need a public edge URL. This edge advertises a loopback address, so only browsers on this machine can open invites.</p>'
          : '';
        const toggle = `<form method="post" action="/v1/devices/${escapeHtml(device.id)}/sharing">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <input type="hidden" name="enabled" value="${sharing.enabled ? '0' : '1'}">
  <button type="submit"${sharing.enabled ? ' class="danger"' : ''}>${sharing.enabled ? 'Stop sharing' : 'Share this Harness'}</button>
</form>`;

        if (!sharing.enabled) {
          return `<section class="panel share-panel" id="share-${escapeHtml(device.id)}">
  <div class="row"><h3>${escapeHtml(device.name)}</h3>${state}<span class="spacer"></span><span class="mono">${escapeHtml(device.id)}</span></div>
  <p class="muted small">Off — nobody else can connect.</p>
  ${loopback}
  ${toggle}
</section>`;
        }

        const inviteRows = sharing.invites.length === 0
          ? '<tr><td colspan="4" class="muted">No outstanding invites.</td></tr>'
          : sharing.invites.map((invite) => `<tr>
  <td>${escapeHtml(invite.label)}</td>
  <td class="muted">${invite.expiresAt === 0 ? 'Never' : escapeHtml(formatTime(invite.expiresAt))}</td>
  <td class="muted">${String(invite.uses)} / ${String(invite.maxUses)}</td>
  <td><form class="inline" method="post" action="/v1/devices/${escapeHtml(device.id)}/invites/${escapeHtml(invite.id)}/revoke"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button class="danger" type="submit">Revoke</button></form></td>
</tr>`).join('\n');

        const approvalRows = sharing.pendingApprovals.length === 0
          ? '<tr><td colspan="4" class="muted">No guests waiting.</td></tr>'
          : sharing.pendingApprovals.map((approval) => `<tr>
  <td>${escapeHtml(approval.label)}</td>
  <td class="mono">${escapeHtml(approval.ip ?? '—')}</td>
  <td class="muted">${escapeHtml(formatAge(approval.createdAt))} ago</td>
  <td><div class="table-actions">
    <form class="inline" method="post" action="/v1/devices/${escapeHtml(device.id)}/approvals/${escapeHtml(approval.id)}"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><input type="hidden" name="decision" value="approve"><button type="submit">Approve</button></form>
    <form class="inline" method="post" action="/v1/devices/${escapeHtml(device.id)}/approvals/${escapeHtml(approval.id)}"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><input type="hidden" name="decision" value="deny"><button class="danger" type="submit">Deny</button></form>
  </div></td>
</tr>`).join('\n');

        const guestRows = sharing.activeGuests.length === 0
          ? '<tr><td colspan="4" class="muted">No active guests.</td></tr>'
          : sharing.activeGuests.map((guest) => `<tr>
  <td>${escapeHtml(guest.label)}</td>
  <td class="mono">${escapeHtml(guest.ip ?? '—')}</td>
  <td class="muted">${escapeHtml(formatTime(guest.since))}</td>
  <td><form class="inline" method="post" action="/v1/devices/${escapeHtml(device.id)}/guests/${escapeHtml(guest.sessionId)}/revoke"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button class="danger" type="submit">Revoke</button></form></td>
</tr>`).join('\n');

        const revokeAll = sharing.activeGuests.length > 0
          ? `<form method="post" action="/v1/devices/${escapeHtml(device.id)}/guests/revoke-all"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button class="danger" type="submit">Revoke all guests</button></form>`
          : '';

        return `<section class="panel share-panel" id="share-${escapeHtml(device.id)}">
  <div class="row"><h3>${escapeHtml(device.name)}</h3>${state}<span class="spacer"></span><span class="mono">${escapeHtml(device.id)}</span></div>
  <p class="muted small">Public URL: <code>${escapeHtml(sharing.publicUrl)}</code></p>
  ${loopback}
  ${toggle}
  <h4>Create invite</h4>
  <form method="post" action="/v1/devices/${escapeHtml(device.id)}/invites">
    <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
    <div class="formgrid">
      <div><label for="label-${escapeHtml(device.id)}">Label</label><input id="label-${escapeHtml(device.id)}" name="label" maxlength="64" placeholder="Support"></div>
      <div><label for="ttl-${escapeHtml(device.id)}">Expires</label><select id="ttl-${escapeHtml(device.id)}" name="ttlSeconds"><option value="900">15 minutes</option><option value="3600" selected>1 hour</option><option value="86400">24 hours</option><option value="0">Never</option></select></div>
      <div><label for="uses-${escapeHtml(device.id)}">Max uses</label><input id="uses-${escapeHtml(device.id)}" name="maxUses" type="number" min="1" max="10" value="1"></div>
      <div><button type="submit">Create invite</button></div>
    </div>
  </form>
  <h4>Outstanding invites</h4>
  <table><thead><tr><th>Label</th><th>Expires</th><th>Uses</th><th></th></tr></thead><tbody>${inviteRows}</tbody></table>
  <h4>Waiting for approval</h4>
  <table><thead><tr><th>Label</th><th>IP</th><th>Age</th><th></th></tr></thead><tbody>${approvalRows}</tbody></table>
  <h4>Active guests</h4>
  <table><thead><tr><th>Label</th><th>IP</th><th>Since</th><th></th></tr></thead><tbody>${guestRows}</tbody></table>
  ${revokeAll}
</section>`;
      }).join('\n');

  const auditRows = options.audit.length === 0
    ? '<tr><td colspan="5" class="muted">No audit rows yet.</td></tr>'
    : options.audit
        .map(
          (row) => `<tr>
  <td class="muted">${escapeHtml(formatTime(row.ts))}</td>
  <td><code>${escapeHtml(row.event)}</code></td>
  <td class="mono">${escapeHtml(row.deviceId ?? '—')}</td>
  <td class="muted">${escapeHtml(row.actor ?? '—')}</td>
  <td class="muted">${escapeHtml(row.detail ?? '—')}</td>
</tr>`,
        )
        .join('\n');

  return layout(
    'Dashboard',
    `${topbar(`<span class="mono">${escapeHtml(options.edgeId)}</span>
<form class="inline" method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button class="secondary" type="submit">Sign out</button></form>`)}
<h1>Dashboard</h1>
<p class="lede">Signed in as ${escapeHtml(options.ownerName)}. Public origin <code>${escapeHtml(options.publicOrigin)}</code>.</p>
<h2>Harnesses</h2>
<p class="muted">Pair another DeepSeek Harness from <strong>Remote Control → Harnesses → Build setup prompt</strong>, paste the prompt into that Harness, then approve it here when it registers. A Harness is a host computer; guest browsers are managed under Sharing.</p>
<div class="panel"><table>
<thead><tr><th>Harness</th><th>State</th><th>Last seen</th><th>Added</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<h2>Sharing</h2>
<div class="warning"><strong>Guest sessions never expire.</strong> Revoke each guest when they are done. Multiple guests can control this desktop at the same time and can interfere with each other.</div>
${sharingSections}
<h2>Audit tail</h2>
<div class="panel"><table>
<thead><tr><th>When</th><th>Event</th><th>Harness</th><th>Actor</th><th>Detail</th></tr></thead>
<tbody>${auditRows}</tbody>
</table></div>`,
  );
}

export function pairPage(options: {
  csrf: string;
  code?: string;
  error?: string;
  /** Anonymous visitors must prove they are the owner with the password. */
  requiresPassword: boolean;
}): string {
  const error = options.error === undefined ? '' : `<div class="error">${escapeHtml(options.error)}</div>`;
  const passwordField = options.requiresPassword
    ? `<label for="password">Owner password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <p class="muted">The pair code is not a login credential. Sign in as the owner, or enter the owner password here, to approve this device. <a href="/login?next=${escapeHtml(encodeURIComponent(`/pair?code=${options.code ?? ''}`))}">Sign in instead</a>.</p>`
    : `<p class="muted">You are signed in as the owner. Redeeming this code approves the device and grants this browser a device-scoped session.</p>`;
  return layout(
    'Pair a device',
    `${topbar('<a href="/">Dashboard</a>')}
<h1>Pair a device</h1>
<p class="lede">Enter the code shown by the agent.</p>
${error}
<div class="panel">
<form method="post" action="/pair">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <label for="code">Pair code</label>
  <input id="code" name="code" value="${escapeHtml(options.code ?? '')}" placeholder="abcd-efgh" autocomplete="one-time-code" required autofocus>
  ${passwordField}
  <button type="submit">Pair</button>
</form>
</div>`,
  );
}

export function reconnectingPage(options: { deviceName: string; reason: 'reconnecting' | 'offline' }): string {
  const reconnecting = options.reason === 'reconnecting';
  return layout(
    reconnecting ? 'Reconnecting' : 'Device offline',
    `${topbar('')}
<h1>${reconnecting ? 'Reconnecting…' : 'Device offline'}</h1>
<p class="lede">${escapeHtml(options.deviceName)} is ${reconnecting ? 'reconnecting to the edge. This page retries automatically.' : 'not connected to the edge right now.'}</p>
<div class="panel"><p class="muted">${reconnecting ? 'The desktop agent lost its tunnel. Presence is held for 30 seconds, then this becomes a hard offline page.' : 'Start the agent on the desktop, then reload this page.'}</p>
<p><button class="secondary" type="button" onclick="location.reload()">Retry now</button></p></div>`,
  );
}

export function invitePage(options: {
  csrf: string;
  token: string;
  deviceName: string;
  label: string;
  expiresAt: number;
  pending: boolean;
  error?: string;
}): string {
  const error = options.error === undefined ? '' : `<div class="error">${escapeHtml(options.error)}</div>`;
  const expiry = options.expiresAt === 0 ? 'Never expires' : `Expires ${formatTime(options.expiresAt)}`;
  const tokenJson = JSON.stringify(options.token);
  const body = options.pending
    ? `<div class="panel">
  <h1>Waiting for approval</h1>
  <p class="lede">The host must approve this browser before it can control <strong>${escapeHtml(options.deviceName)}</strong>.</p>
  <p id="guest-status" class="muted">Pending…</p>
  <p class="muted">Keep this page open. It checks every two seconds.</p>
</div>
<script>
(function () {
  var token = ${tokenJson};
  var statusEl = document.getElementById('guest-status');
  function poll() {
    fetch('/i/' + encodeURIComponent(token) + '/status', { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        if (body.status === 'approved' && body.devicePath) { location.href = body.devicePath; return; }
        if (body.status === 'denied') { statusEl.textContent = 'The host denied this request.'; return; }
        if (body.status === 'expired') { statusEl.textContent = 'This invite has expired.'; return; }
        statusEl.textContent = 'Pending approval…';
        setTimeout(poll, 2000);
      })
      .catch(function () { setTimeout(poll, 3000); });
  }
  poll();
})();
</script>`
    : `<div class="panel">
  <h1>Request access</h1>
  <p class="lede">You are about to ask the host of <strong>${escapeHtml(options.deviceName)}</strong> for remote control of their Harness.</p>
  <p class="muted">Invite label: <strong>${escapeHtml(options.label)}</strong> · ${escapeHtml(expiry)}</p>
  <p class="muted">The host sees your IP address and browser before approving. You will only be able to reach this one device.</p>
  ${error}
  <form method="post" action="/i/${escapeHtml(options.token)}/claim">
    <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
    <button type="submit">Request access</button>
  </form>
</div>`;
  return layout(`Guest invite · ${options.deviceName}`, `${topbar('')}${body}`);
}

export function guestSessionPage(options: {
  csrf: string;
  deviceId: string;
  deviceName: string;
  label: string;
  since: number;
}): string {
  return layout(
    'Remote session',
    `${topbar('')}
<h1>Remote session</h1>
<p class="lede">You are controlling <strong>${escapeHtml(options.deviceName)}</strong> as a guest.</p>
<div class="panel">
  <p><span class="badge online">connected</span></p>
  <table>
    <tbody>
      <tr><th>Harness</th><td>${escapeHtml(options.deviceName)} <span class="mono">${escapeHtml(options.deviceId)}</span></td></tr>
      <tr><th>Label</th><td>${escapeHtml(options.label)}</td></tr>
      <tr><th>Since</th><td>${escapeHtml(formatTime(options.since))}</td></tr>
      <tr><th>Expires</th><td>Never — the host revokes this session explicitly.</td></tr>
    </tbody>
  </table>
  <p class="row"><a class="button secondary" href="/d/${escapeHtml(options.deviceId)}/">Open Harness</a></p>
  <form method="post" action="/i/session/disconnect">
    <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
    <button class="danger" type="submit">Disconnect</button>
  </form>
</div>`,
  );
}

export function inviteCreatedPage(options: {
  deviceName: string;
  label: string;
  url: string;
  expiresAt: number;
}): string {
  const expiry = options.expiresAt === 0 ? 'Never expires' : `Expires ${formatTime(options.expiresAt)}`;
  return layout(
    'Invite created',
    `${topbar('<a href="/">Dashboard</a>')}
<h1>Invite created</h1>
<p class="lede">Send this one-time link to the guest. It is shown only on this page and is not available again from the dashboard.</p>
<div class="panel">
  <p><strong>${escapeHtml(options.deviceName)}</strong> · ${escapeHtml(options.label)} · ${escapeHtml(expiry)}</p>
  <input class="input-url" readonly value="${escapeHtml(options.url)}" onclick="this.select()" aria-label="Invite URL">
  <p class="muted small">The guest opens the link, requests access, and waits for you to approve them below.</p>
  <p><a class="button secondary" href="/">Back to dashboard</a></p>
</div>`,
  );
}

export function errorPage(options: { status: number; title: string; message: string }): string {
  return layout(
    options.title,
    `${topbar('<a href="/">Home</a>')}
<h1>${escapeHtml(options.title)}</h1>
<p class="lede">${escapeHtml(options.message)}</p>
<div class="panel"><p class="mono">HTTP ${String(options.status)}</p></div>`,
  );
}