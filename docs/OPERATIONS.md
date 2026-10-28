# DSH RC — operations runbook

**Audience:** whoever is on call for an edge, or a desktop user debugging their
own connection.

Commands assume a systemd install under `/opt/dsh-rc` with the edge service
`dsh-rc-edge` and data directory `/var/lib/dsh-rc`. Docker equivalents are
in `docs/DEPLOY.md` §6-7. Replace `link.example.com` with your origin.

## 1. First-run setup

1. Start the edge. On first boot it creates the SQLite database, generates the
   HMAC secret for session cookies, and prints a setup code (a new one on every
   start until setup completes):

   ```bash
   sudo systemctl start dsh-rc-edge
   sudo journalctl -u dsh-rc-edge -n 20 --no-pager
   ```

   Expected lines (values differ):

   ```
   DSH RC edge listening on http://127.0.0.1:8787
   DSH RC setup code: 7f3k-9q2m-8xda
   DSH RC setup url: https://link.example.com/setup
   ```

2. Open `/setup` and redeem the code. The code is single use, expires 24 hours
   after it was generated, and only its SHA-256 is stored. `--setup-code` (or
   `DSHRC_SETUP_CODE`) is used verbatim instead of a generated code; treat
   whatever holds it as a secret.

3. Set an owner password on the setup form if you want to be able to log in
   again later. **If you skip it, there is no password login**: recovering
   access means deleting the owner row and re-running setup (see §1.2).

4. Verify:

   ```bash
   curl -fsS https://link.example.com/healthz
   curl -fsS https://link.example.com/v1/edge | jq .
   ```

   `setupComplete` must be `true`; the same response reports the device counts. `/setup` now returns `403`.

### 1.1 If setup is interrupted

Before setup completes, every boot generates a new setup code and invalidates
the previous one; only a SHA-256 of the current code is stored, so an old
plaintext cannot be recovered. The fix is simply to restart and read the new
line:

```bash
sudo systemctl restart dsh-rc-edge
sudo journalctl -u dsh-rc-edge -n 20 --no-pager   # fresh setup code
```

If you need a code that is stable across restarts, start the edge with
`--setup-code <8-128 chars>` (or `DSHRC_SETUP_CODE`); that value is used
verbatim. Do this promptly: while there is no owner row, anyone who can reach
`/setup` and has the current code can become the owner.

### 1.2 Recovering owner access (no password set)

This destroys the owner account and logs every browser out. Devices, their
secrets and audit rows are separate tables and survive; agents reconnect on
their own, and browser access resumes after the new owner is set up.

```bash
sudo systemctl stop dsh-rc-edge
sudo -u dshrc sqlite3 /var/lib/dsh-rc/dshrc.sqlite "delete from sessions; delete from owner;"
sudo systemctl start dsh-rc-edge
sudo journalctl -u dsh-rc-edge -n 20 --no-pager   # new setup code
```

The `owner` table is a single row (`id = 1`), so `delete from owner;` is exact.
Deleting `sessions` is deliberate: owner sessions are not cascaded when the
owner row is removed, and a signed cookie would otherwise remain valid until
its expiry. To log everyone out without touching the owner, delete `sessions`
only, or delete the `session_secret` setting to invalidate every signature at
once:

```bash
sudo -u dshrc sqlite3 /var/lib/dsh-rc/dshrc.sqlite \
  "delete from settings where key = 'session_secret';"
```

## 2. Pairing a device

Registration does two things at once: it returns the device secret to the agent
and a single-use pair code to the owner (the agent writes `pairUrl` into its
status file). The device starts **pending**, and its tunnel is refused with
`DEVICE_PENDING` until it is approved.

The pair code is not a bearer credential. Redeeming it requires an owner
session — or the owner password entered on the pair page in the same
submission. It proves intent for a specific device; it never creates an owner
session on its own.

There are two ways to approve:

| Method | Approves device | Creates browser session | Leaves pair code usable |
| --- | --- | --- | --- |
| Redeem the pair URL | Yes | Yes (device session if password; owner session kept) | No — consumed |
| Dashboard/API approve | Yes | No | Yes, until it expires |

### 2.1 Redeem the pair URL (normal path)

Open the `pairUrl` from the status file:

```
https://link.example.com/pair?code=abcd-efgh
```

`GET /pair` renders a confirmation form. If the browser is not signed in as the
owner, the form asks for the owner password when one is configured; with no
password set it tells the visitor to sign in. An anonymous visitor never gets a
session from the code alone. `POST /pair` then consumes the code and approves the device. If the browser
authenticated with the owner password, it receives a session scoped to that
device; if it was already an owner session, that session is kept and no second
session is issued. The code is 8 characters, single use, 10-minute TTL, stored
hashed. After redemption the browser can open `/d/<deviceId>/`.

### 2.2 Approve without pairing

Dashboard: open `/`, find the pending device, choose **Approve**.

API — a state-changing request needs both cookies and the double-submit token:

```bash
export DSHRC_SESSION='<dshrc_session cookie value>'
export DSHRC_CSRF='<dshrc_csrf cookie value>'
curl -fsS \
  -b "dshrc_session=$DSHRC_SESSION; dshrc_csrf=$DSHRC_CSRF" \
  -H "x-csrf-token: $DSHRC_CSRF" \
  -d "csrf=$DSHRC_CSRF" \
  -X POST https://link.example.com/v1/devices/dev_xxxxxxxxxxxxxxxxxxxx/approve
```

While pending, the agent polls `GET /v1/devices/me` every 2 s
(`apps/agent/src/runtime.ts:30`, `runtime.ts:350`), so approval takes effect
within seconds without restarting it. The status file flips to `connecting`
then `online`; audit records `approve` and `tunnel-connect`.

### 2.3 If the pair code expired

There is no re-issue endpoint in v1: the code is created at registration. If it
expired before first use, re-register the agent (revoke the old device, delete
`device.json`, start it again). That creates a new device id and a fresh code;
pair promptly, because the window is 10 minutes.

## 3. Guest sharing

Sharing lets one invited person use one device's Harness from a browser. It is
**off by default**; the contract is `docs/SHARING.md`. The host approves every
guest, and guest sessions are device-scoped but **never expire on their own**.

### 3.1 Turn sharing on and create an invite

In the sidebar panel: **Share this Harness → On**, choose **Invite expires**
(**15 minutes**, **1 hour**, **24 hours**, or **Never**), press **Create
invite**. The link is shown once, with **Copy** and a QR code.

API equivalent, using the device secret from the agent's state dir. A
plugin-launched agent uses `<DSH home>/rc/device.json`; a manual agent uses
`~/.dsh-rc/agent/device.json`.

```bash
EDGE=https://link.example.com
STATE_DIR="${DSH_HOME:-$HOME/.dsh}/rc"     # manual agent: ~/.dsh-rc/agent
SECRET=$(jq -r .deviceSecret "$STATE_DIR/device.json")

# enable sharing for this device
curl -fsS -H "authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"enabled":true}' -X PUT "$EDGE/v1/devices/me/sharing"

# ttlSeconds: 0 = never, otherwise 60..86400; maxUses 1..10; label <= 64 chars
curl -fsS -H "authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"label":"Support","ttlSeconds":3600,"maxUses":1}' \
  -X POST "$EDGE/v1/devices/me/invites"
```

The invite response is `{id,url,token,expiresAt}`. `token` and `url` are shown
**once**; `expiresAt: 0` means never. Do not log or paste the URL into a public
channel.

Inspect everything the panel sees:

```bash
curl -fsS -H "authorization: Bearer $SECRET" "$EDGE/v1/devices/me/sharing" | jq
```

It returns `{enabled, publicUrl, invites, pendingApprovals, activeGuests}`.
`activeGuests[].expiresAt` is always `null`. These routes accept **only the
device secret** as `Authorization: Bearer`; an owner dashboard session cannot
call them in v0.2.

### 3.2 Approve or deny a guest

The guest opens `/i/<token>`, sees the device name and invite label, and presses
**Request access**. The request appears under **Waiting for approval** with the
guest's label, IP and user-agent. That is a request, not a session. `/i/:token/status`
always returns JSON, so a stuck guest page can be checked with:

```bash
curl -s -b guest-cookies.txt -H 'accept: application/json' \
  "$EDGE/i/<token>/status" | jq
```

```bash
# APPROVAL_ID comes from pendingApprovals[].id
curl -fsS -H "authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"decision":"approve"}' \
  -X POST "$EDGE/v1/devices/me/approvals/$APPROVAL_ID"
```

Use `"decision":"deny"` to reject it; the guest's status page shows the denial
and no session is created. On approval the guest page polls
`/i/<token>/status`, receives a device-scoped `dshrc_guest` cookie and lands on
`/d/<deviceId>/`.

The approval body accepts `ttlSeconds` for contract compatibility but **ignores
it**: guest sessions have no expiry. Do not send it expecting a shorter session.

### 3.3 What a guest can and cannot do

- Can: use the full Harness UI for that one device — conversations, workspace,
  terminal, tools — exactly as the owner can within DSH's own permissions.
- Cannot: reach the dashboard, `/v1/*`, `/setup`, `/pair`, `/login`, `/logout`,
  device approve/revoke, invites, approvals or sharing settings; those return
  `403` for a guest session. `/d/<other-device>/` is also `403`.
- There is **no read-only mode** and no per-guest file/terminal scoping. A guest
  can change the workspace and run tools.
- **Multiple guests can hold sessions at once.** There is no controller lock and
  no `GUEST_BUSY`. They share one single-user desktop and **can interfere with
  each other**. The panel lists every guest separately.

### 3.4 Revoke a guest, revoke all, or stop sharing

```bash
# revoke one guest (SESSION_ID from activeGuests[].sessionId)
curl -fsS -H "authorization: Bearer $SECRET" \
  -X DELETE "$EDGE/v1/devices/me/guests/$SESSION_ID"

# revoke every guest for this device
curl -fsS -H "authorization: Bearer $SECRET" \
  -X DELETE "$EDGE/v1/devices/me/guests"

# revoke an unclaimed invite
curl -fsS -H "authorization: Bearer $SECRET" \
  -X DELETE "$EDGE/v1/devices/me/invites/$INVITE_ID"

# stop sharing: revokes every invite and guest session for the device
curl -fsS -H "authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"enabled":false}' -X PUT "$EDGE/v1/devices/me/sharing"
```

Guest HTML responses also carry a fixed **Remote session · Disconnect** pill
that links to `/i/session`; if injection is skipped (compressed or large
responses), `/i/session` remains the canonical control.

Revocation is immediate: the session row is deleted and its browser WebSockets
are closed. A revoked guest gets `401`/`403` on the next request. To
**disconnect** a guest from the owner side, revoke that guest; there is no
separate pause. The guest can also end their own session with **Disconnect** on
`/i/session` (`POST /i/session/disconnect`); that records `guest-disconnected`
and `guest-revoked`, then clears the cookie.

**Guest sessions never expire.** Closing the browser, rebooting, restarting the
edge or a tunnel reconnect does not end one. Only revocation, sharing off,
device revocation or edge-database deletion do. A stolen guest cookie is
permanent access to that device until you revoke it.

### 3.5 Leaked invite or stolen cookie

| Situation | Do this |
| --- | --- |
| Invite link leaked, not claimed | `DELETE /v1/devices/me/invites/:id`; pending approvals for it are expired. |
| Claimed, waiting for approval | **Deny** the approval, then revoke the invite. |
| Approved, cookie may be stolen | Revoke that guest, or **Revoke all**; then turn sharing off if unsure. |
| Sharing must stop entirely | `PUT /v1/devices/me/sharing {"enabled":false}`; this revokes every invite and guest. |
| Device is suspect | Revoke the device; the tunnel closes with `4003` and its guests end. |

There is no TTL to wait out and no automatic cleanup. If a guest's machine may
be compromised, **Revoke all** and turn sharing off.

### 3.6 Audit and prerequisites

Guest actions are audited as flat events: `sharing-enabled`,
`sharing-disabled`, `invite-created`, `invite-revoked`, `invite-claimed`,
`approval-approved`, `approval-denied`, `guest-revoked`, `guest-connected`,
`guest-disconnected`. See §7 for queries.

The guest must be able to reach the edge. A loopback-only edge can share only
with a browser on the same machine. Use a VPS edge or a public HTTPS URL such as
Tailscale Funnel; Tailscale Serve only reaches guests who joined your tailnet
(`docs/DEPLOY.md` §3.1).

## 4. Revoking a lost laptop

Assume the laptop is gone and the agent may still be running.

1. **Revoke the device** in the dashboard. API equivalent:

   ```bash
   curl -fsS \
     -b "dshrc_session=$DSHRC_SESSION; dshrc_csrf=$DSHRC_CSRF" \
     -H "x-csrf-token: $DSHRC_CSRF" \
     -d "csrf=$DSHRC_CSRF" \
     -X POST https://link.example.com/v1/devices/dev_xxxxxxxxxxxxxxxxxxxx/revoke
   ```

   Effect: the device row is marked revoked; the live tunnel is closed with
   `4003 DEVICE_REVOKED`; the agent treats that as terminal and stops retrying;
   presence is dropped; sessions scoped to the device are invalidated. Audit
   records `revoke` and `tunnel-disconnect`.

2. **Verify the tunnel is gone**:

   ```bash
   curl -fsS https://link.example.com/v1/edge | jq .
   sudo -u dshrc sqlite3 -header -column /var/lib/dsh-rc/dshrc.sqlite \
     "select id, name, revoked_at, last_seen_at from devices order by last_seen_at desc;"
   ```

   A revoked device must not be `online`. If it is, the edge did not close the
   tunnel — treat that as a security bug and stop the edge.

3. **On the desktop side** (if you still have it): stop the agent, delete
   `~/.dsh-rc/agent/device.json`, and restart DSH so the loopback cookie is
   invalidated. Revocation kills the remote path, not the local session.

4. If the lost laptop held the only owner session and you cannot log in,
   recover on the edge host with §1.2 (stop the service, delete the owner and
   sessions rows, restart, complete setup again).

5. Rotate anything else the laptop held: OS account password, DSH launch token
   (restart DSH), and any secrets reachable through the DSH workspace.

Revocation is not a remote wipe. Full-disk encryption is what protects the data
on the stolen machine.

## 5. Rotating a device secret

There is no in-place rotation in v1. The procedure is revoke → re-register:

```bash
# on the edge
curl -fsS \
  -b "dshrc_session=$DSHRC_SESSION; dshrc_csrf=$DSHRC_CSRF" \
  -H "x-csrf-token: $DSHRC_CSRF" \
  -d "csrf=$DSHRC_CSRF" \
  -X POST https://link.example.com/v1/devices/dev_xxxxxxxxxxxxxxxxxxxx/revoke

# on the desktop — stop the agent first (plugin supervisor, or Ctrl-C);
# a graceful stop releases agent.lock. A killed process leaves a stale lock
# that the next start takes over automatically.
rm -f ~/.dsh-rc/agent/device.json

# plugin-launched agent: the plugin rewrites upstream.json and restarts it.
# manual run:
node apps/agent/dist/main.js \
  --edge https://link.example.com \
  --dsh-url "$DSH_LAUNCH_URL" \
  --state-dir ~/.dsh-rc/agent \
  --name "$(hostname)"
```

Approve the new device, pair browsers again. The new device gets a new id and a
new 32-byte secret; the old hash remains in the revoked row and cannot
authenticate.

Rotate on a schedule (90 days is reasonable), after any suspected exposure, and
whenever a laptop changes hands.

## 6. Rotating the owner session and cookie secret

- **Log out one browser**: `POST /logout` from that browser.
- **Invalidate every session**: delete/rotate the `session_secret` setting and
  restart the edge. Every `dshrc_session` cookie becomes unverifiable.
- **Change the owner password**: re-run setup is not available once an owner
  exists in v1; rotate by deleting the owner row (§1.2) and setting a new
  password. This is a known limitation, recorded in `docs/FAQ.md`.

## 7. Reading audit rows

The edge keeps a flat `audit` table: `id`, `ts`, `event`, `device_id`, `actor`,
`ip`, `detail`. Rows older than the retention window are deleted on boot and
then once every 24 h; the default is 30 days, `--audit-retention-days` accepts
`0`–`36500`, and `0` disables pruning (`apps/edge/src/server.ts:133-141`). The effective value is returned as
`auditRetentionDays` by `/v1/edge`. If audit rows are evidence, set the window
longer than your backup cycle and ship rows off-host. Events emitted by the edge:

`owner-setup`, `login`, `logout`, `register`, `pair`, `approve`, `revoke`,
`tunnel-connect`, `tunnel-disconnect`, plus the sharing events
`sharing-enabled`, `sharing-disabled`, `invite-created`, `invite-revoked`,
`invite-claimed`, `approval-approved`, `approval-denied`, `guest-revoked`,
`guest-connected`, `guest-disconnected` (`apps/edge/src/server.ts`,
`apps/edge/src/sharing.ts`, `apps/edge/src/guest-connections.ts`; the login
event is `login`, not `owner-login`).

`ts` is an integer of epoch **milliseconds** (`apps/edge/src/db.ts:200-209`);
convert it in SQL rather than eyeballing it.

```bash
sudo -u dshrc sqlite3 -header -column /var/lib/dsh-rc/dshrc.sqlite \
  "select id, datetime(ts/1000,'unixepoch') as time, event, device_id, actor, ip
   from audit order by id desc limit 25;"
```

Useful queries:

```sql
-- auth-adjacent activity, newest first
select datetime(ts/1000,'unixepoch') as time, event, actor, ip, detail
from audit where event in ('login','pair','register')
order by id desc limit 100;

-- tunnel churn for one device
select datetime(ts/1000,'unixepoch') as time, event, ip, detail
from audit where device_id = 'dev_xxxxxxxxxxxxxxxxxxxx'
  and event like 'tunnel-%' order by id desc;

-- all revocations
select datetime(ts/1000,'unixepoch') as time, device_id, actor, detail
from audit where event = 'revoke' order by id desc;

-- guest and invite activity
select datetime(ts/1000,'unixepoch') as time, event, device_id, actor, ip, detail
from audit
where event like 'guest-%' or event like 'invite-%' or event like 'approval-%'
   or event like 'sharing-%'
order by id desc limit 100;

-- activity in the last 24 hours
select datetime(ts/1000,'unixepoch') as time, event, device_id, ip
from audit where ts > (strftime('%s','now') - 86400) * 1000 order by id desc;
```

`detail` is a short string, not JSON, in the events that set it (for example
`register` stores `"<platform> · agent <version>"`). Inspect one row before
writing a parser. Audit rows are append-only by convention, not by
database trigger. Ship them off-host if they matter (`docs/THREAT-MODEL.md`
§6.3).

## 8. Log fields

Both binaries emit JSON lines through `@dsh-rc/shared`'s logger
(`packages/shared/src/logger.ts`). Every line has:

| Field | Meaning |
| --- | --- |
| `ts` | ISO-8601 timestamp |
| `level` | `debug`, `info`, `warn`, `error` |
| `logger` | Component name (`edge`, `agent`, …) |
| `msg` | Human-readable message |
| extra fields | Structured context: device/stream/request ids, status, error code |

Values whose key is in the redaction list (`token`, `authorization`, `cookie`,
`secret`, `password`, `devicesecret`, `dshtoken`, `set-cookie`) are replaced
with `[redacted]` before the line is written. The list is centralised; do not
add ad-hoc logging of credentials.

```bash
# errors only
sudo journalctl -u dsh-rc-edge -o cat | jq -c 'select(.level=="error" or .level=="warn")'

# one device's tunnel lifecycle
sudo journalctl -u dsh-rc-edge -o cat | jq -c 'select(.deviceId=="dev_xxx")'

# agent logs when run under the plugin: captured by the plugin's log, not journald
```

The agent's status file is the machine-readable source of truth:

```json
{
  "state": "online",
  "deviceId": "dev_…",
  "pairUrl": "https://link.example.com/pair?code=…",
  "edgeUrl": "https://link.example.com",
  "latencyMs": 42,
  "reconnects": 0,
  "since": 1793000000000,
  "upstream": "http://127.0.0.1:49321"
}
```

`since` is epoch **milliseconds**. Optional keys are omitted when unset.
`pairUrl` is the registration code and stays in the identity file (and therefore
in the status file) until the agent re-registers; it still expires server-side
after 10 minutes, so presence is not validity. `latencyMs` appears after the
first mux PING/PONG, normally within 30 s. `lastError` appears only after a
failure. The file is written atomically (tmp + rename) with mode
0600 (`apps/agent/src/status.ts`).

States: `starting`, `pairing`, `connecting`, `online`, `reconnecting`, `error`,
`stopped`. `upstream` is an origin only; it never contains the launch token.

### 8.1 State directory and the single-instance lock

One state directory per DSH host/profile. A manually started agent defaults to
`~/.dsh-rc/agent`; a plugin-launched agent uses `<DSH home>/rc` (or
`<stateDir>/rc` when the plugin overrides the DSH home). The directory
contains:

| File | Mode | Purpose |
| --- | --- | --- |
| `device.json` | `0600` | Device identity: id, secret, edge URL, name, pair URL, timestamps |
| `agent.lock` | `0600` | Single-instance lock: `{pid, startedAt, host}` |

The lock is created `O_EXCL` and held for the agent's lifetime. A second agent
pointed at the same state dir refuses to start: it opens no tunnel, writes
`state: "error"` with `lastError` `another agent is already running for this
state dir (pid N on HOST)`, and exits `1` (`apps/agent/src/lock.ts:156-165`).
A lock is treated as stale — and taken over once — when its PID is dead on the
same host, the file is corrupt, or it is older than 24 h
(`apps/agent/src/lock.ts:150-166`).

If you see that error: find the PID in the message and decide whether it is a
real agent. Kill it and restart; do not delete `agent.lock` first, or two agents
can race for the same device identity and the edge will replace one tunnel with
`4004`. Deleting the lock is safe only when no agent for that state dir is
alive.

## 9. Diagnosing HTTP failures

| Status | Meaning | Check |
| --- | --- | --- |
| `401` | No or invalid session | Cookie present? Expired? `session_secret` rotated? |
| `403` | Authenticated but refused | `/setup` after setup; CSRF `Origin` mismatch; device not approved; session not scoped to this device |
| `404` | Unknown device/path | Device id format; `/d/<id>/` needs the trailing slash |
| `502` | Upstream unreachable | Agent cannot reach `--dsh-url`; DSH web server down or port changed |
| `503` + `Retry-After: 5` | Device offline or outside presence grace. HTML navigation gets a reconnecting page; `/api/*` or `Accept: application/json` gets `{"error":"DEVICE_OFFLINE","retryable":true,"reconnecting":…,"retryAfterSeconds":5}` | Agent running? Tunnel connected? Device revoked? |
| `504` on WebSocket upgrade | `WS_OPEN_TIMEOUT_MS` (10 s) expired; agent did not open the upstream socket | Check agent/upstream, not the browser |

### 9.1 A 503 that will not clear

1. Read the agent status file. `state: "error"` with `lastError` naming
   `DEVICE_REVOKED`, `AUTH_FAILED` or `PROTOCOL_MISMATCH` is terminal: the
   tunnel loop ends and the CLI exits `1`; fix the cause and restart.
   A `lastError` about the DSH launch token / upstream `401` is different: the
   agent keeps running and may recover, but if DSH now requires a new launch
   token, restart it through the plugin with a fresh `upstream.json`.
2. `state: "reconnecting"` for more than a minute: the edge is unreachable or
   rejecting. From the desktop:

   ```bash
   curl -fsS https://link.example.com/healthz
   curl -fsS https://link.example.com/v1/edge | jq .
   ```

3. `state: "online"` but browser still 503: the browser's session may be scoped
   to a different device, or the device id in the URL is stale after
   re-registration. Re-pair.

### 9.2 A 401/403 loop on the dashboard

- `Secure` cookie on a plain-HTTP origin: the browser silently drops it. Use
  HTTPS, or `--insecure` on loopback only.
- Reverse proxy not forwarding `X-Forwarded-Proto` while `--trust-proxy` is set,
  or forwarding it while the flag is unset: the cookie's `Secure` attribute and
  the redirect origin disagree.
- CSRF: a `POST` without the double-submit token is rejected, and so is one
  with a cross-site `Origin`. Send both cookies and the token (see §2.2):
  `-b "dshrc_session=…; dshrc_csrf=…" -H "x-csrf-token: …" -d "csrf=…"`.

## 10. Diagnosing WebSocket and tunnel failures

| Close code | Name | Meaning | Action |
| --- | --- | --- | --- |
| `4000` | Heartbeat timeout | No frame for 45 s | Network path dead; agent reconnects automatically |
| `4001` | Protocol mismatch | Version disagreement | Upgrade both sides |
| `4002` | Auth failed | Bad/unknown device secret | Re-register the device |
| `4003` | Device revoked | Owner revoked it | Expected after revocation; agent stops |
| `4004` | Tunnel replaced | A newer tunnel for the same device won | Check for a second agent instance |
| `4005` | Server draining | Edge shutting down | Reconnect is expected |

Browser WebSocket upgrades fail with `504` if the agent does not acknowledge
within 10 s. A `1002` close means a malformed frame; the edge resets that stream
and logs `PROTOCOL_BAD_FRAME`.

Common causes of repeated `4004`: two agents with **different** state
directories (the lock cannot see the other one), or a process started before the
lock existed. Two agents sharing one state dir are refused at startup, so the
error message is different (`another agent is already running`). Find and kill
the duplicate; the newest connection wins by design.

## 11. Health checks and monitoring

| Check | Command | Healthy |
| --- | --- | --- |
| Edge process | `systemctl is-active dsh-rc-edge` | `active` |
| Edge HTTP | `curl -fsS https://link.example.com/healthz` | `200`, `ok:true` |
| Edge metadata | `curl -fsS https://link.example.com/v1/edge` | `setupComplete:true`, expected `version`, `auditRetentionDays` matching policy |
| Live tunnels | `curl -fsS https://link.example.com/v1/edge \| jq .tunnels` | as many as expected online devices |
| Disk | `df -h /var/lib/dsh-rc` | SQLite + WAL have headroom |
| Backups | newest file in `/var/backups/dsh-rc` | within 24 h |
| Certificate | `curl -vI https://link.example.com` | valid, correct hostname |

Alert on: `/healthz` failing twice in a row, error-level log rate, disk > 80 %,
no successful backup in 36 h, and any `revoke` event you did not initiate.

## 12. Capacity notes

| Resource | Limit | Source |
| --- | --- | --- |
| Concurrent streams per device | 256 | `packages/protocol/src/frames.ts:28` |
| Stream window | 256 KiB | `frames.ts:18` |
| Tunnel window | 8 MiB | `frames.ts:19` |
| Frame ceiling | 64 KiB (32 KiB data chunks) | `frames.ts:12-14` |
| WebSocket stream budget | 64 MiB before reset | `frames.ts:29`, `docs/PROTOCOL.md:129-132` |
| Presence grace | 30 s | `docs/PROTOCOL.md:163-169` |
| Heartbeat / idle timeout | 15 s / 45 s | `frames.ts:24-25` |
| Rate limits (per client IP) | setup 5/10 min, login 10/5 min, pair 20/5 min, register 20/10 min; fixed constants, not CLI-configurable | `apps/edge/src/config.ts:64-69` |
| Per-tunnel memory | design target < 24 MiB excluding payload buffers; **TBD measured** | `docs/ARCHITECTURE.md:163` |

Practical sizing:

- **Bandwidth** is the real cost: every proxied byte crosses the edge twice
  (in and out). Provision egress for the largest expected file transfer and
  remember that a 2 GiB download is deprioritised but still relayed.
- **CPU** is TLS termination and framing. One small VPS handles many idle
  tunnels; interactive traffic is latency-bound, not CPU-bound.
- **SQLite** is fine for one owner and tens of devices. WAL allows concurrent
  reads while writing. It is not a multi-region database; the multi-region
  shape is roadmap (`docs/ARCHITECTURE.md:154`).
- **File descriptors**: each stream is a socket pair plus buffers. The systemd
  unit sets `LimitNOFILE=65535`.
- **Region**: the edge is in the path for every keystroke. Put it near the
  desktop, not near the browser, if you must choose — the agent-to-edge hop
  carries interactive frames; the browser can tolerate more RTT than the
  desktop's tool loop.

Measured on an Apple M4 Pro with a loopback edge (2026-10-28): TTFB 2.1 ms
median / 2.9 ms p95, 1 MiB 157 MiB/s, 16 MiB 299 MiB/s, 200 sequential
requests at 505 req/s, 50 concurrent in 16.6 ms, interactive p95 3.1 ms under
four concurrent 16 MiB transfers, reconnect after forced 4004 replacement
49 ms. These measure tunnel overhead, not internet RTT. Per-tunnel memory is
still **TBD** (`tools/bench`).

## 13. Emergency procedures

**Stop all remote access now**

```bash
sudo systemctl stop dsh-rc-edge
```

or revoke every device. Stop the edge first: SQL does not close a live tunnel,
and the `devices` table is STRICT, so timestamps must be integer epoch millis.

```bash
sudo systemctl stop dsh-rc-edge
sudo -u dshrc sqlite3 /var/lib/dsh-rc/dshrc.sqlite \
  "update devices set status = 'revoked', revoked_at = cast(strftime('%s','now') as integer) * 1000 where status != 'revoked';
   delete from sessions where kind = 'device';
   delete from pair_codes where used_at is null;"
sudo systemctl start dsh-rc-edge
```

Prefer the dashboard/API path so audit rows exist and tunnels are closed with
`4003`; direct SQL leaves no audit record.

**Suspect a compromised edge**

Treat all proxied content, device hashes and session values as exposed. Revoke
all devices, rotate the owner password (§1.2), rotate `session_secret`, rebuild
the host from a known image, and rotate the DSH launch token on every desktop.

**Suspect a compromised desktop**

Revoke its device, stop the agent, restart DSH, rotate the OS account password
and any credentials in the workspace. The edge cannot inspect what the agent
did before revocation; DSH's own logs are the record.

## 14. Maintenance calendar

| Interval | Task |
| --- | --- |
| Daily | Backup succeeded; error logs reviewed; certificate valid |
| Weekly | Audit rows for unexpected `pair`/`register`/`revoke`; disk headroom |
| Monthly | Restore a backup to a scratch path and verify it opens; review device list |
| Quarterly | Rotate device secrets (§5); upgrade to the latest tag (§7 of `docs/DEPLOY.md`) |
| On change | Re-read `docs/THREAT-MODEL.md` §11 triggers |