# Sharing a Harness with guests

Status: **v0.2 design**. Normative for the implementation in `apps/edge` and
`packages/plugin`.

## 1. Goal

Every user who installs DSH RC can flip one switch — **Share this Harness** —
and let another person remote-control *their* DSH from a browser. The guest
installs nothing. The host never shares the owner password.

## 1.1 Harness pairing vs guest sharing

Two different things share this edge:

| | Pair a Harness (host) | Share with a guest (browser) |
| --- | --- | --- |
| What joins | Another computer running DSH + DSH RC | A browser with no install |
| Authorization | Owner approves the pending device | Owner approves each invite claim |
| Lifetime | Device stays until revoked | Guest session stays until disconnected/revoked |
| Access | `/d/<deviceId>/` for the owner; the host can then share it | `/d/<deviceId>/` only, device-scoped |
| Secret in the setup text | None: public edge URL + pinned version only | Single-use invite token |

Harness pairing is the primary multi-computer flow: the prompt is generated in
**Remote Control → Harnesses** and executed by the other Harness's agent, then
approved in the edge dashboard.

## 2. Model

```
Host (plugin panel)                      Guest (any browser)
───────────────────                      ───────────────────
[ Share this Harness  ● ]                
  Create invite (15m/1h/24h)  ─────────▶ opens https://edge/i/<token>
  link + QR                              clicks "Request access"
                                         sees "Waiting for approval"
  Approve / Deny  ◀────────────────────  request appears in the panel
  "Guest is controlling" banner
  Revoke at any time          ─────────▶ session closes immediately
```

- Sharing is **off by default** and per device.
- An invite is **single-use by default** (`maxUses` 1–10), hashed at rest, and can be time-limited
  (15 min / 1 h / 24 h) or **never expire**.
- A claim creates a **pending approval**, never a session.
- The host approves on the machine that owns the Harness. The guest's IP,
  user-agent and label are shown before approval.
- On approval the guest gets a **guest session**: signed cookie, scoped to one
  device, and **it does not expire on its own**. It stays valid until the owner
  revokes it, disables sharing, or revokes the device.
- **Multiple guests may control at the same time.** There is no controller
  lock. The panel lists every connected guest with its IP and since-time, and
  the owner can revoke one guest or all of them.
- Guests can only reach `/d/<deviceId>/*`. Every admin route (`/`, `/v1/*`,
  `/setup`, `/pair`, `/login`, device approve/revoke) returns 403 for a guest.
- Disabling sharing revokes every invite and guest session for that device.

## 3. Why not a shared password

The owner password is admin over every device and never expires. A guest
session is least-privilege, time-boxed, attributable and revocable. This is the
TeamViewer / Chrome Remote Desktop model, which is what users already expect
from "share my computer".

## 4. Networking prerequisite

The edge must be reachable by the guest. A loopback-only edge can share only
with browsers on the same machine. The plugin surfaces the edge's advertised
`publicUrl` and warns when it is loopback:

- **Tailscale Funnel** — free public HTTPS URL, no guest install.
- **VPS edge** — production shape; no Tailscale anywhere.
- **Tailscale Serve** — works only for guests who joined the tailnet.

Sharing is an **authorization** feature; the front door is deployment.

## 5. Device-scoped sharing API (Bearer device secret)

The host plugin talks to the edge with the device secret in `<stateDir>/device.json`.
The owner dashboard exposes the same operations as server-rendered form routes (`/v1/devices/:id/sharing`, `/invites`, `/approvals/:id`, `/guests/...`) guarded by the owner session and CSRF; the device API remains the plugin path.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/v1/devices/me/sharing` | — | `{enabled, publicUrl, invites, pendingApprovals, activeGuests}` |
| PUT | `/v1/devices/me/sharing` | `{enabled: boolean}` | `{enabled}` |
| POST | `/v1/devices/me/invites` | `{label?, ttlSeconds?, maxUses?}` (`ttlSeconds: 0` = never) | `{id, url, token, expiresAt}` (token shown once) |
| DELETE | `/v1/devices/me/invites/:id` | — | `{ok}` |
| POST | `/v1/devices/me/approvals/:id` | `{decision: "approve" \| "deny"}` (`ttlSeconds` accepted but ignored: sessions never expire) | `{ok}` |
| DELETE | `/v1/devices/me/guests/:sessionId` | — | `{ok}` |
| DELETE | `/v1/devices/me/guests` | — | `{revoked: number}` |

Validation: `ttlSeconds` 0 (never) or 60..86400, `maxUses` 1..10,
`label` ≤ 64 chars. Rate-limit invite creation and approvals per device.

`GET /v1/devices/me/sharing` shape:

```json
{
  "enabled": true,
  "publicUrl": "https://dsh-rc-leong.tailnet.ts.net",
  "invites": [{ "id": "inv_…", "label": "Support", "expiresAt": 0, "maxUses": 1, "uses": 0 }],
  "pendingApprovals": [{ "id": "apr_…", "label": "Support", "ip": "203.0.113.9", "createdAt": 0 }],
  "activeGuests": [{ "sessionId": "sess_…", "label": "Support", "ip": "203.0.113.9", "since": 0, "expiresAt": null }]
}
```

## 6. Guest public routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/i/:token` | Invite page: device name, label, TTL, "Request access" |
| POST | `/i/:token/claim` | Creates a pending approval; sets a short-lived signed claim cookie |
| GET | `/i/:token/status` | `pending` / `approved` / `denied` / `expired`; on approval sets the guest session cookie and returns the device path |

Invite tokens are 32 random bytes, base64url, hashed with SHA-256 at rest.
Claim cookies and guest sessions are signed with the edge secret, `HttpOnly`,
`Secure`, `SameSite=Lax`. **Guest sessions have no expiry** (`expiresAt: null`);
the owner revokes them explicitly.

## 6.1 Permanence and disconnect

A guest session is meant to behave like a permanent remote seat, not a demo:

- **No server-side expiry.** `sessions.expires_at` is `null` for guests and the
  cookie is minted with a 10-year `Max-Age`. A guest can close the browser,
  reboot the laptop, or come back next week and land back in the same Harness.
- **Survives edge restarts.** Guest sessions live in SQLite and are signed with
  the persisted edge secret; restarting the edge does not log guests out.
- **Survives tunnel reconnects.** If the agent's tunnel drops, the guest's
  browser reconnects through the normal DSH client recovery; the session is not
  invalidated and no re-approval is needed.
- **No idle timeout for guest sessions.** The mux heartbeat still closes a
  *dead* socket after 45 s of silence, but the session remains valid and the
  browser reconnects automatically. There is no "inactive for N minutes" rule.
- **Only these end a guest session:**
  1. the guest clicks **Disconnect** (`POST /i/session/disconnect`),
  2. the owner revokes that guest or all guests,
  3. the owner turns sharing off,
  4. the owner revokes the device,
  5. the edge database is deleted.
- **Disconnect UI.** `/i/session` is a small edge-owned page showing the device,
  label, since-time and a **Disconnect** button. The edge also injects a
  minimal fixed pill ("Remote session · Disconnect") into guest HTML responses
  so the control is always one click away; owner and device sessions are not
  modified. If injection is unavailable, `/i/session` remains the canonical
  control.

Honest limits: nothing can keep a session alive while the Mac is asleep, the
edge process is stopped, or the network is down. In those cases the session
stays valid and reconnects when the path returns; it is not destroyed.

## 7. Concurrency and safety

- Multiple guests may hold sessions at once; there is no controller lock and no
  `GUEST_BUSY`.
- DSH is a single-user desktop: simultaneous guests share the same workspace,
  terminal and tools. The panel shows a standing warning ("Multiple guests can
  interfere with each other") and lists every guest separately.
- Guests never expire automatically. The owner can revoke one guest
  (`DELETE /v1/devices/me/guests/:sessionId`) or all guests
  (`DELETE /v1/devices/me/guests`), disable sharing, or revoke the device.
- Lifecycle events are audited: invite created/claimed, approval
  approved/denied, guest connected/disconnected, revoked, sharing toggled.
  Per-request sampled logging is **not** part of v0.2.
- Guest sessions cannot create invites, approve guests, change sharing, or
  manage devices. The edge also rejects `/d/<device>/dsh-rc/*` (the host
  plugin RPC) for guest sessions, and guest HTML carries
  `globalThis.__DSH_RC_GUEST__ = true` so the Remote Control client never
  registers its sidebar entry in a guest view.

## 8. UI (plugin panel)

When `sharing.enabled` is false:

- Toggle **Share this Harness** + one line: "Off — nobody else can connect."

When enabled:

- **Invite** button (TTL select: 15 min / 1 h / 24 h / **Never**), then the link
  + QR + Copy.
- **Waiting for approval** list: label, IP, Approve / Deny.
- **Active guests** list: each label, IP, since, Revoke; plus **Revoke all**.
- Standing warning that multiple guests share one desktop and can interfere.
- Warning if `publicUrl` is loopback: "Guests need a public edge URL."

The panel polls `GET /v1/devices/me/sharing` every 2 s while open.

## 9. Out of scope for v0.2

- Guest accounts / email magic links / OAuth.
- Read-only guest mode.
- Per-guest file or terminal scoping (the whole DSH UI is the unit).
- Automatic guest expiry (sessions persist until revoked).
- Hosted shared edge service.
## 10. Invariants and failure modes

These are the properties the implementation is expected to hold, and where to
look when it does not:

| Invariant | Enforcement |
| --- | --- |
| An invite token is opaque and stored only as SHA-256 | `apps/edge/src/db.ts` `insertInvite`, `getInviteByTokenHash` |
| An invite cannot be over-used under concurrency | conditional `UPDATE … WHERE uses < max_uses` inside `consumeInviteUse` |
| An approval is decided once | `decideApproval` checks `status = 'pending'` inside a transaction |
| A guest session is scoped to one device | `checkDeviceAccess` + `guestAccessAllowed`; admin routes 403 |
| Revocation takes effect immediately | guest rows deleted, live sockets closed with 1008 |
| Guest sessions never expire | `sessions.expires_at NULL`, 10-year cookie, no idle sweep |
| Sharing off invalidates invites and guests | `SharingService.setEnabled` transaction |
| Browser forms pass CSRF | `Origin`/Fetch-Metadata + double-submit cookie; `Origin: null` accepted only with `Sec-Fetch-Site: same-origin` |
| Guest HTML carries a Disconnect control | `proxy-http` injects the pill for uncompressed guest `text/html`; `/i/session` is the fallback |

| Failure | Behaviour |
| --- | --- |
| Edge restarts | Sessions and invites are in SQLite; guests reconnect without re-approval |
| Agent tunnel drops | Browser shows the reconnecting page; the DSH client reconnects; session survives |
| Guest laptop sleeps / reboots | Cookie has a 10-year Max-Age; reopening the device URL resumes the same session |
| Guest cookie stolen | **Permanent access until revoked.** Revoke that guest or Revoke all, then turn sharing off |
| Owner turns sharing off | All invites revoked, pending approvals expired, guest sessions deleted, live WS closed |
| Device revoked | Guest sessions for that device deleted, sockets closed |
| Edge database deleted | Every session, invite and owner row is gone; `setup` starts over |
| Mac asleep or edge process stopped | The connection drops; the session stays valid and resumes when the edge returns |
| Compressed/large guest HTML | The Disconnect pill is skipped; `/i/session` remains available |

The permanence rule is deliberate: a guest is a remote seat, not a demo. It is
also the largest residual risk in the product — see `docs/THREAT-MODEL.md` §7.12.
