# DSH RC — threat model

**Audience:** security reviewers, operators choosing a deployment shape, and
contributors changing the edge, the agent or the protocol.

**Status:** v1 design, plus guest sharing (v0.2) in §5.5 and §7.12. This
document describes the system as specified in `docs/ARCHITECTURE.md`,
`docs/PROTOCOL.md` and `docs/SHARING.md`, and names the code that enforces each
control. Where a control lives in code that is still landing, the row says
so; it is not a claim that the control exists yet.

**Method:** assets → actors → trust boundaries → STRIDE per boundary →
residual risk. No control is listed without a file reference or an explicit
"design requirement, enforcement pending" note.

## 1. System model

```
 owner browser ──HTTPS/WSS 443──▶ edge ──one multiplexed WSS──▶ agent ──loopback HTTP/WS──▶ DSH web server
 (public internet)               (trusted relay)                (desktop)                    (127.0.0.1:<port>)
 guest browser ──/i/<token>, /d/<device>──┘
 (public internet)
```

| Component | Runs where | Sees | Does not see |
| --- | --- | --- | --- |
| Browser | Anywhere | The DSH UI, its own edge session cookie | Device secret, DSH launch token, DSH cookie |
| Edge | Operator-controlled host | TLS plaintext of every proxied request and response: paths, headers, bodies, WebSocket frames; session and device metadata | Device secret (only its SHA-256), DSH launch token, DSH cookie |
| Agent | The desktop | Device secret, DSH launch token, DSH cookie, all proxied traffic | Owner session cookie |
| Guest browser | Anywhere | The DSH UI for one shared device, its guest session cookie, and whatever that UI shows | Owner session, device secret, other devices, admin routes |
| Host supervisor | macOS launchd (`com.dshrc.edge`, `com.dshrc.tailscaled`) or systemd | Process arguments, environment, stdout/stderr, restart state; plist/unit files | Proxied plaintext, device secret, DSH cookie |
| DSH web server | The desktop, loopback | Its own normal traffic | Edge internals |

The edge terminates TLS. **It therefore sees plaintext HTTP/WS for all proxied
traffic.** This is the central trust assumption of the design, stated in
`docs/ARCHITECTURE.md:59-64` and in ADR-0001. Self-hosting the edge is the
mitigation; there is no end-to-end encryption layer in v1.

On macOS the edge is not launched from the checkout: `scripts/install-macos.sh`
copies a standalone bundle to `~/Library/Application Support/dsh-rc/edge/main.cjs`
because TCC blocks a launchd agent from reading `~/Documents`. The process is
supervised by a GUI-domain LaunchAgent, so it starts at user login, not at boot
before login.

Sharing adds a third browser principal: the **guest**. A guest is not an owner
and not a paired owner browser. A guest is an invite holder the owner explicitly
approved, holds a device-scoped session, and reaches only `/d/<deviceId>/*`.
Guest traffic transits the same edge and is subject to the same plaintext
boundary as owner traffic.

## 2. Assets

| Asset | Where it lives | Lifetime | Required property |
| --- | --- | --- | --- |
| DSH session content (prompts, code, tool output, terminal) | Desktop; in transit through the edge | Session; guest access can persist indefinitely | Confidentiality, integrity |
| DSH launch token | Agent memory; delivered at startup through `{stateDir}/upstream.json` (0600) when launched by the plugin, or `--dsh-url` on a manual run | Process lifetime | Confidentiality, single use |
| DSH loopback auth cookie | Agent memory only | Until the DSH server restarts or rejects it | Confidentiality |
| Device secret (32 random bytes) | Agent state file; SHA-256 at the edge | Until rotated | Confidentiality, integrity |
| Owner session cookie | Owner's browser; HMAC-signed value at the edge | 30 days | Confidentiality, integrity, unforgeability |
| Pair code (8 chars) | Displayed once; hash at the edge | 10 minutes, single use; requires owner session or password | Confidentiality, single use, intent |
| Audit and presence metadata | Edge SQLite and logs | Deployment policy | Integrity, retention control |
| Host filesystem and tools | Desktop, reachable through DSH | Persistent | Confidentiality, integrity |
| Guest session cookie | Guest browser; signed value at the edge | **No expiry**; until explicitly revoked | Confidentiality, integrity, revocability |
| Invite token | Invite link; SHA-256 at the edge | Single use; 15 min / 1 h / 24 h, or never | Confidentiality, single use, intent |
| Guest metadata (label, IP, user-agent, audit) | Edge SQLite and logs | Audit retention | Attribution, integrity |
| Tailscaled node state | `~/.dsh-rc/tailscale/tailscaled.state` (0600) | Until logout/re-auth | Confidentiality, authenticity |
| LaunchAgent plists and `run-edge.sh` | `~/Library/LaunchAgents/`, `~/.dsh-rc/`; user-owned | Persistent | Integrity |

The last row matters: DSH can read files, run tools and open terminals. A
compromised browser session is not "read the chat"; it is "act as the user on
that desktop", bounded only by DSH's own approvals and permissions. DSH RC
does not add a second permission layer inside DSH.

## 3. Actors and capabilities

| Actor | Capability assumed |
| --- | --- |
| Owner | Legitimate operator of the edge and the desktop; may be phished |
| Paired browser user | Holds a valid pair-code-derived session for one device |
| Guest | Holds an owner-approved, device-scoped guest session; has the full DSH UI for that device and may be curious, careless or malicious |
| Invite holder | Possesses an unclaimed invite link; can create a pending request, nothing more |
| Multiple guests | Concurrent controllers of one single-user desktop; no isolation between them |
| Network attacker | On-path (can drop, delay, replay, inject) or off-path (can scan, connect, send requests) |
| Malicious web page | Can make the owner's browser issue cross-site requests; cannot read cross-origin responses |
| Compromised edge | Full control of the edge process, its database, its TLS keys and its plaintext view |
| Compromised desktop | Full control of the agent process, its state dir, and the DSH server |
| Malicious DSH upstream | Controls response headers and bodies returned to the edge |
| Supply-chain attacker | Can publish a malicious version of a dependency or the package itself |
| Internet scanner | Unauthenticated; sends arbitrary paths, headers, frames |
| Tailscale ingress (Funnel) | Terminates client TLS and forwards plaintext to the userspace tailscaled; can read or alter proxied traffic |
| Local OS user | Can edit LaunchAgents/plists, read logs, and signal the edge or tailscaled; equivalent to the edge's user |
| Supervisor supply chain | Node, Tailscale and launchd/systemd binaries are trusted to start the right program |

Explicitly out of scope: a user who deliberately grants a paired browser or a
guest session to an attacker, and a desktop already running hostile software as
the same OS user. A guest whose *cookie* is stolen is in scope (§7.12): the
owner approved a person, and the session that person holds can outlive their
intent.

## 4. Trust boundaries

| ID | Boundary | Protection | What crosses |
| --- | --- | --- | --- |
| B1 | Browser ↔ edge | TLS 1.2+ (TLS 1.3 preferred), HTTPS/WSS on 443 | HTTP requests, WebSocket frames, session cookie |
| B2 | Edge internals | Process boundary only; **plaintext** | Proxied traffic, device records, audit |
| B3 | Edge ↔ agent | TLS WebSocket + `Authorization: Bearer <device secret>` + `HELLO.token` | Tunnel frames, opaque payloads |
| B4 | Agent ↔ DSH | Loopback TCP + DSH cookie | HTTP/WS to `127.0.0.1:<port>` |
| B5 | Plugin ↔ agent | Same OS user; process spawn; state dir 0700 | Launch URL (`upstream.json`, 0600), device secret (file), status JSON |
| B6 | Operator ↔ edge | Owner session cookie + CSRF checks | Dashboard, pairing, revocation |
| B7 | Guest browser ↔ edge | TLS + signed guest session cookie | `/i/*` invite/claim/status, `/d/<deviceId>/*` |
| B8 | Plugin/agent ↔ edge sharing API | `Authorization: Bearer <device secret>` | Sharing toggle, invites, approvals, guest revocation |
| B9 | Guest ↔ guest | **No isolation**; same DSH single-user desktop | Shared workspace, terminal, tools, conversation state |
| B10 | Launchd/systemd ↔ edge | Same OS user; plist/unit file permissions; supervisor restart | Process arguments, environment, logs, restart control |
| B11 | Tailscale ingress ↔ tailscaled ↔ edge | Tailscale TLS at ingress; WireGuard to userspace daemon; loopback HTTP to edge | Public HTTPS; proxied plaintext to `127.0.0.1:8787` |

B2 is the boundary reviewers should focus on. B1 protects the wire; B2 does not
protect anything from the edge operator.

A guest browser runs the same Harness client bundles as an owner, including the
Remote Control client. Guest HTML sets `globalThis.__DSH_RC_GUEST__=true` and
the client returns before registering its sidebar, while the edge rejects
`/d/<device>/dsh-rc` and its subtree with 403. The host plugin RPC is therefore
unreachable from a guest even though it shares the device origin (§7.12.6).

## 5. Authentication and authorization

### 5.1 Owner

The edge prints a setup code on each start until setup completes. Redeeming it creates an owner
session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, 30 days
(`docs/ARCHITECTURE.md:108`). The cookie is an HMAC-signed payload with an
expiry (`packages/shared/src/ids.ts:54-83`), serialized with those flags by
`packages/shared/src/http.ts:40-49`.

Design requirements the edge must enforce:

- The setup code is single-use and expires 24 h after generation; a second
  redemption fails. Before setup completes, a restart generates a new code and
  invalidates the previous one; supply `--setup-code` if you need a stable value
  across restarts (`apps/edge/src/auth.ts:119-135`).
- `Secure` is set whenever the public origin is HTTPS
  (`apps/edge/src/auth.ts:207-221`). A plain-HTTP loopback demo therefore gets a
  non-`Secure` cookie — the browser would discard it otherwise. `--insecure`
  only permits a plain-http public URL on a loopback bind; it is not what makes
  the cookie non-`Secure`.
- Every state-changing dashboard action is a `POST` with an `Origin` allow-list
  check and a double-submit CSRF token (`dshrc_csrf` cookie compared with the
  `csrf` form field or `x-csrf-token` header, constant time). No mutation is
  reachable by `GET`. `SameSite=Lax` blocks cross-site `POST` cookies, but `Lax`
  still sends the cookie on top-level `GET` navigation, so `GET` must never
  mutate (`apps/edge/src/auth.ts:339-370`).

### 5.2 Device

The agent registers once and receives a 32-byte device secret. The edge stores
only `SHA-256(secret)` and compares in constant time
(`packages/shared/src/ids.ts:39-41`, `ids.ts:44-49`). The secret is presented
twice on connect — `Authorization: Bearer` on the upgrade and `HELLO.token` in
the first frame — so a proxy that strips headers still fails closed with a
readable error (`docs/PROTOCOL.md:65-73`).

A device id is `dev_` plus 20 lowercase base32 characters (100 bits,
`packages/shared/src/ids.ts:39-41`) and is validated against
`/^dev_[a-z0-9]{16,64}$/` before any lookup
(`packages/protocol/src/routing.ts:15-20`).

### 5.3 Paired browser

An 8-character pair code, single use, 10-minute TTL
(`docs/ARCHITECTURE.md:108-111`). The code is stored as
`SHA-256("pair:" + normalized)` and never persisted in clear
(`packages/shared/src/ids.ts:86-113`). The alphabet excludes `0/O` and `1/I/L`
because the code is read aloud (`ids.ts:88-90`).

The code is **not a bearer credential**. Redemption requires an owner session,
or the owner password submitted in the same form when a password is configured;
with no password set, only an owner session works. The code proves intent for a
specific device, not identity. On success the pending device is approved. A
password-authenticated redemption also issues a device-scoped session; an owner
session is kept as-is. Redemption never creates or elevates to an owner session
(`apps/edge/src/devices.ts:139-153`, `apps/edge/src/server.ts` `handlePair`).

Note on entropy: the generator maps random bytes modulo a 31-character
alphabet, so the code is approximately 39.6 bits, not a uniform 40. With a
10-minute TTL, single use and edge rate limiting, this is acceptable for a
human-transferred code; it is not a password and must not be reused.

### 5.4 What the browser never receives

- The device secret: it is issued once by the edge at registration, handed to
  the agent over TLS, and thereafter only its SHA-256 exists at the edge
  (`apps/edge/src/devices.ts:68-96`).
- The DSH launch token: the plugin writes it to `{stateDir}/upstream.json`
  (0600) for the agent, which exchanges it for a loopback-bound cookie and
  keeps both in memory (`docs/ARCHITECTURE.md:113-117`,
  `apps/agent/src/dsh-session.ts:22-51`).
- The DSH cookie: upstream `Set-Cookie` is stripped before the response crosses
  back (`packages/protocol/src/routing.ts:86-98`), so the browser's cookie jar
  only ever holds the edge session.
- A guest browser receives none of the above either. It holds only
  `dshrc_guest`, signed and scoped to one device, and can reach only
  `/d/<deviceId>/*`; it never receives an owner session or the device secret
  (`docs/SHARING.md` §2, §6).

### 5.5 Guest sessions and invites

Sharing is **off by default and per device**. The flow uses three separate
artefacts, and only the last one is a session:

| Step | Artefact | Lifetime | What it can do |
| --- | --- | --- | --- |
| Invite | 32 random bytes, base64url; SHA-256 at the edge | Single use by default (`maxUses` 1–10); 15 min / 1 h / 24 h, or never | Open the invite page and request access |
| Claim | Signed claim cookie | Up to 24 h; no DSH access | Wait for the owner's decision; no DSH access |
| Approval | Guest session cookie `dshrc_guest` | **No expiry**; 10-year `Max-Age`; until revoked | `/d/<deviceId>/*` only |

- The host approves on the machine that owns the Harness: from the edge
  dashboard (owner session + CSRF) or the plugin panel (device secret API).
  Label, IP and user-agent are shown before **Approve** / **Deny**; a claim never
  becomes a session on its own (`docs/SHARING.md` §2, §6).
- The guest cookie is signed with the persisted edge secret, `HttpOnly`,
  `Secure` on HTTPS, `SameSite=Lax`, and scoped to one device
  (`docs/SHARING.md` §6).
- **Guest sessions have no server-side expiry** (`expiresAt: null`) and no idle
  timeout. They survive edge restarts, tunnel reconnects and browser restarts.
  They end only on guest **Disconnect**, owner revocation of one/all guests,
  sharing off, device revocation, or deletion of the edge database
  (`docs/SHARING.md` §6.1).
- **Multiple guests may hold sessions at once.** There is no controller lock and
  no `GUEST_BUSY`. They share one single-user desktop and can interfere with each
  other (`docs/SHARING.md` §7).
- Guests may reach only `/d/<deviceId>/*`. `/`, `/v1/*`, `/setup`, `/pair`,
  `/login`, device approve/revoke, invite creation, approval and sharing changes
  return `403`, and `/d/<other-device>/` is `403` (`docs/SHARING.md` §2,
  `apps/edge/src/server.ts:192-216`).
- The sharing API is authenticated by the **device secret** (`Authorization:
  Bearer`), not an owner dashboard session (`apps/edge/src/server.ts:604-628`).
  An approval body may carry `ttlSeconds`; the edge ignores it. Guest sessions
  have no TTL.

The edge implementation lives in `apps/edge/src/sharing.ts`,
`apps/edge/src/guest-connections.ts` and the guest handlers in
`apps/edge/src/server.ts`; the citations below are to the landed code.

## 6. STRIDE pass

### 6.1 Spoofing

| Threat | Mitigation | Where |
| --- | --- | --- |
| Fake edge (phishing, DNS) | TLS certificate validation by browser and agent; `--insecure` is explicit and loud | Agent flag; `docs/DEPLOY.md` |
| Fake agent connecting to the edge | Device secret verified against stored SHA-256 in constant time | `packages/shared/src/ids.ts:44-49` |
| Forged owner cookie | HMAC-SHA256 over the payload with a server secret; expiry checked | `packages/shared/src/ids.ts:54-83` |
| Replayed setup code | Single use, 24 h TTL, hash at rest; a restart before setup rotates it; setup disabled after first owner | `apps/edge/src/auth.ts:119-166` |
| Replayed pair code | Single use, 10-minute TTL, hashed at rest, and redeemable only by an owner session or with the owner password | `ids.ts:86-113`; `apps/edge/src/devices.ts:139-153` |
| Device id confusion | Strict `dev_[a-z0-9]{16,64}` validation before lookup | `packages/protocol/src/routing.ts:15-20` |
| Leaked or guessed invite token | 32 random bytes, single-use by default (`maxUses` up to 10), hashed at rest, TTL or explicit Never; claim creates only a pending request, and the owner must approve | `apps/edge/src/sharing.ts:147-240`, `apps/edge/src/server.ts:192-216` |
| Forged guest cookie | HMAC-signed with the persisted edge secret and backed by a session row; device-scoped; revocation deletes the row | `apps/edge/src/auth.ts:271-295` |
| Guest presents an owner/admin cookie | Separate cookie names and route checks; guest routes only `/d/<deviceId>/*`, admin routes return 403 | `apps/edge/src/server.ts:192-216` |
| Funnel hostname points at another origin | `DSHRC_PUBLIC_URL` is written into `run-edge.sh` and must equal the Funnel hostname; cookies and invite links are origin-bound | `scripts/install-macos.sh:48-58`, `docs/DEPLOY.md` §6.2 |

### 6.2 Tampering

| Threat | Mitigation | Where |
| --- | --- | --- |
| On-path modification | TLS on B1 and B3; no plaintext listener except loopback | Transport |
| Path rewritten to another origin | Origin-form only, no `//`, no `\`, no absolute URL, no `..`, ≤ 8192 bytes, no control chars; **re-validated by the agent** | `packages/protocol/src/routing.ts:45-54` |
| Header injection / response splitting | Control characters stripped from every forwarded value; hop-by-hop and browser-credential headers dropped | `routing.ts:57-132` |
| Cookie injection into the upstream | `cookie`, `authorization`, `origin`, `referer`, `forwarded`, `x-forwarded-*`, `cf-*` stripped before `OPEN`; the agent adds its own DSH cookie | `routing.ts:57-83` |
| Malicious upstream widens browser state | `set-cookie`, HSTS and hop-by-hop headers stripped on the way back | `routing.ts:86-98` |
| Frame smuggling | Fixed 5-byte header, length checked against the frame ceiling, unknown types rejected | `packages/protocol/src/frames.ts:85-116` |
| Oversized control payload | 64 KiB total frame ceiling, 32 KiB JSON ceiling, schema guards | `frames.ts:12-16`, `frames.ts:122-141` |
| Guest mutates the shared desktop | **Inherent**: a guest has the full DSH UI, tools and terminal. There is no read-only mode and no per-guest scoping | `docs/SHARING.md` §7, §9 |
| Guest interferes with another guest | **Inherent**: no isolation between guests; they share one workspace, terminal and tools. Owner can revoke one/all | `docs/SHARING.md` §7 |
| Local user edits a LaunchAgent | Same-user compromise; plists live in `~/Library/LaunchAgents` and run as the user. File permissions and OS account security are the control | `scripts/install-macos.sh:60-98` |
| Funnel exposes the edge beyond the tailnet | Funnel is an explicit public ingress; disable it when not sharing (`funnel --https=443 off`), and keep the edge bound to loopback | `docs/DEPLOY.md` §6.2 |

The agent's re-validation is the important half: a compromised edge must not be
able to make the agent fetch `http://169.254.169.254/` or another origin. The
agent uses a fixed loopback target and treats `OPEN.path` as a path, not a URL
(`docs/PROTOCOL.md:99-103`).

### 6.3 Repudiation

| Threat | Mitigation | Where |
| --- | --- | --- |
| Owner denies pairing/revoking a device | Audit rows for `owner-setup`, `login`, `logout`, `register`, `pair`, `approve`, `revoke`, `tunnel-connect`, `tunnel-disconnect` | `apps/edge/src/db.ts:121-137`, `apps/edge/src/devices.ts` |
| Attacker covers tracks | JSON-line logs can be shipped off-host; if they are, SQLite is not the only copy | `docs/OPERATIONS.md` §7, §10 |
| Guest denies a request or action | Audit `invite-claimed`, `approval-approved`/`approval-denied`, `guest-connected`/`guest-disconnected`, `guest-revoked` with session id and IP; revocation preserves the rows | `apps/edge/src/sharing.ts`, `apps/edge/src/guest-connections.ts` |
| Owner denies revoking a guest | `guest-revoked` per session (including `revoke-all`), plus `sharing-enabled`/`sharing-disabled` | `apps/edge/src/sharing.ts:327-392` |

Audit rows are not signed, the edge operator can alter them, and rows older
than the retention window (default 30 days, `--audit-retention-days`) are
deleted. For a single-operator tool this is accepted; a regulated deployment
should ship logs to an append-only sink and lengthen the window.

### 6.4 Information disclosure

| Threat | Mitigation | Where |
| --- | --- | --- |
| Edge reads session plaintext | **Accepted**: TLS terminates at the edge. Self-host, or do not use DSH RC for data the edge operator must not read | `docs/ARCHITECTURE.md:59-64` |
| Secrets in logs | Central redaction list (`token`, `authorization`, `cookie`, `secret`, `password`, `devicesecret`, `dshtoken`, `set-cookie`) | `packages/shared/src/logger.ts:5`, `logger.ts:16-31` |
| Secrets in error messages | Protocol errors carry a code and a short message; no payload echo in `RESET`/`GOAWAY` | `packages/protocol/src/frames.ts:229-239` |
| Token in argv | The plugin writes `{stateDir}/upstream.json` mode 0600 and passes `--dsh-url-file`; the token is not in argv, logs, status files or the client UI. A manual run can still pass `--dsh-url`, which is the operator's choice. Same-user attackers can read the file or process memory; see §7.3 | `apps/agent/src/dsh-session.ts:22-51`, `packages/plugin/src/agent-supervisor.ts:211` |
| Status file leaks | Atomic JSON contains state, device id, pair URL, edge URL, latency, error text; no token, no cookie. Dir 0700, file 0600 | `apps/agent/src/status.ts` |
| Browser cache/history | Edge pages send `cache-control: no-store`; proxied DSH responses keep DSH's own headers | `packages/shared/src/http.ts:91-125` |
| Referer leakage | `referrer-policy: no-referrer` on edge pages; `referer` stripped before `OPEN` | `http.ts:128-137`, `routing.ts:57-83` |
| Pair URL in clipboard/history | The URL contains a code that is useless without an owner session or the owner password; single use and a 10-minute TTL bound the window | `ids.ts:86-113`, `apps/edge/src/server.ts` (`handlePair`) |
| Guest reads everything the DSH UI shows | **Accepted**: a guest sees the workspace, conversations, terminal and tool output for that device. There is no per-guest scoping | `docs/SHARING.md` §7, §9 |
| Guest reads another guest's work | **Accepted**: guests share one single-user desktop; there is no isolation between guest sessions | `docs/SHARING.md` §7 |
| Invite token in chat history, clipboard or referrer | Single use, hashed at rest, TTL or Never; the owner can revoke an unclaimed invite; claim still requires approval | `docs/SHARING.md` §2, §6 |

### 6.5 Denial of service

| Threat | Mitigation | Where |
| --- | --- | --- |
| Huge frame / memory blow-up | 64 KiB frame ceiling, 32 KiB data chunks | `frames.ts:12-14` |
| Slow consumer balloons desktop memory | Credit-based flow control: 256 KiB/stream, 8 MiB/tunnel, credit returned on consumption | `frames.ts:18-21`, `packages/mux/src/index.ts:609-617` |
| One download starves interaction | Three priority queues served 4:2:1; control frames first | `packages/mux/src/index.ts:739-755` |
| Outbound queue overflow | 2048 queued frames then the tunnel fails rather than growing without bound | `mux/index.ts:82`, `mux/index.ts:691-700` |
| Stream exhaustion | 256 concurrent streams; `STREAM_LIMIT` is retryable | `frames.ts:28`, `docs/PROTOCOL.md:189` |
| Dead peer holds resources | PING every 15 s; no frame for 45 s closes with 4000 | `frames.ts:24-25`, `mux/index.ts:663-679` |
| Auth brute force | Edge rate limits: setup 5/10 min, login 10/5 min, pairing 20/5 min, registration 20/10 min; constant-time comparison | `apps/edge/src/config.ts:64-69`, `ids.ts:44-49` |
| Unauthenticated registration spam | Registration is open by design but rate-limited to 20/10 min per client; devices stay `pending` and unusable until approved; owner can revoke | `apps/edge/src/config.ts:64-69`, `apps/edge/src/devices.ts:68-96` |
| WebSocket frame flood | Per-stream byte budget resets the stream | `frames.ts:29`, `docs/PROTOCOL.md:129-132` |
| Invite or approval brute force | Per-device rate limits on invite creation and approvals; tokens are 32 random bytes; claims are pending until approved | `apps/edge/src/sharing.ts:147-190`, `apps/edge/src/config.ts:76-78` |
| Many guests consume one desktop | The design specifies no guest-count cap; each guest is a browser session and its streams count against per-device limits. Revoke all is the remedy | `docs/SHARING.md` §7; `frames.ts:28` |
| Permanent guest sessions accumulate | **Accepted**: sessions do not expire; the owner must review **Active guests** and revoke. There is no automatic cleanup | `docs/SHARING.md` §6.1, §7 |

### 6.6 Elevation of privilege

| Threat | Mitigation | Where |
| --- | --- | --- |
| Path traversal to another origin | Fixed upstream host; origin-form path; `..`, `//`, `\`, absolute URLs and control chars rejected on both sides | `routing.ts:45-54` |
| SSRF via `Host`/absolute URL | `host` header stripped and rebuilt by the agent; absolute URL in path rejected | `routing.ts:57-83`, `routing.ts:45-54` |
| CSRF on dashboard or pairing | `SameSite=Lax` cookies, `Origin` allow-list, double-submit token, no `GET` mutations | `packages/shared/src/http.ts:40-49`, `apps/edge/src/auth.ts:339-370` |
| XSS on edge-rendered pages | Strict CSP on edge pages, `nosniff`, `frame-ancestors 'none'` | `http.ts:128-137` |
| Clickjacking | `x-frame-options: DENY` + `frame-ancestors 'none'` | `http.ts:128-137` |
| `--insecure` widens exposure | Edge: accepted only on a loopback bind, for a plain-http public URL. Agent: permits plain `http`/`ws` to a non-loopback edge and disables TLS verification. Both are explicit, off by default | `apps/edge/src/config.ts:209-225`, `apps/agent/src/main.ts` |
| Owner session stolen | HttpOnly (no JS access), Secure, SameSite=Lax, 30-day expiry, revocation | `http.ts:40-49` |
| Guest reaches admin routes | Guests are confined to `/d/<deviceId>/*`; `/`, `/v1/*`, `/setup`, `/pair`, `/login` and device admin return 403 | `apps/edge/src/server.ts:192-216` |
| Guest uses DSH tools and terminal | **Granted privilege, not escalation**: the guest session is the full DSH UI for that device. Do not share with someone you would not seat at the desktop | `docs/SHARING.md` §7, §9 |
| Guest opens the Remote Control plugin RPC/UI through the shared Harness | Edge rejects `/d/<device>/dsh-rc` and `/d/<device>/dsh-rc/*` for guest sessions with 403; guest HTML sets `globalThis.__DSH_RC_GUEST__=true` and the client returns before registering its sidebar entry | `apps/edge/src/server.ts:1168,1248`, `apps/edge/src/proxy-http.ts:71`, `packages/plugin/src/client/index.ts:1211-1214` |
| Stolen guest cookie | Signed, HttpOnly, device-scoped; **no expiry**, so it is valid until the owner revokes the guest or disables sharing. There is no shorter TTL to wait out | `apps/edge/src/auth.ts:57`, `auth.ts:271-295` |
| Tailscale or supervisor reads traffic | **Accepted**: Funnel terminates TLS and tailscaled is on the plaintext path; launchd runs the edge as the user. Treat both as part of the trusted host | `docs/DEPLOY.md` §6.5 |

## 7. Specific analyses

### 7.1 The edge sees plaintext — stated plainly

TLS is terminated at the edge so it can authenticate the browser, route by
device, apply policy and audit. After termination it holds a normal HTTP
request: method, path, headers, body; and a normal response body. For a
WebSocket it holds every frame. A compromised edge can read, modify, delay or
drop all of it.

What the edge does **not** get: the DSH launch token, the DSH cookie, the device
secret in clear, or the ability to make the agent connect anywhere except the
configured loopback target.

If that trust is unacceptable, the options are: self-host the edge on hardware
you control, or use a design with application-layer end-to-end encryption. DSH
Link v1 does not offer the latter.

### 7.2 Device secret storage

- 32 random bytes, generated at device registration and returned to the agent
  exactly once; the agent persists it, the edge keeps only its SHA-256.
- Stored at `<state-dir>/device.json`, directory `0700`, file `0600`, written
  with `tmp` + `rename` so a crash cannot leave a partial file. The same
  directory holds `agent.lock` (0600, `{pid,startedAt,host}`) so two agents
  cannot share one identity and fight over the tunnel.
- The edge stores `SHA-256(secret)` only; comparison is constant time
  (`packages/shared/src/ids.ts:39-41`, `ids.ts:44-49`).
- Rotation: revoke the device at the edge, delete `device.json`, restart the
  agent, re-pair. There is no in-place rotation protocol in v1; the old secret
  is dead the moment the edge revokes the device.
- A local attacker with the same OS user can read `device.json`. File
  permissions defend against other users, not against malware running as the
  owner. This is the same trust boundary as the user's SSH keys.

### 7.3 DSH launch token handling

The DSH desktop exposes a launch URL containing a token. The agent exchanges it
once for a loopback-bound cookie and keeps the cookie in memory; the token is
used again only to re-exchange after a `401` from the upstream. Neither value is
written to `device.json`, the status file, or any log.

Residual risks, stated honestly:

1. When the plugin launches the agent it writes `{stateDir}/upstream.json` with
   mode 0600 and passes `--dsh-url-file`; the token never enters argv, logs, the
   status file or the client UI (`apps/agent/src/dsh-session.ts:22-51`). A
   same-user attacker can still read that file or dump the agent's memory, and
   the agent logs a warning if the file mode is looser than 0600. A manual run
   with `--dsh-url` puts the token in argv and shell history; use
   `--dsh-url-file` there too if that matters.
2. The cookie lives in agent memory. A memory dump or debugger attached to the
   agent recovers it. Full-disk encryption and OS user separation are the
   controls.
3. If DSH rotates the launch token, the plugin must restart the agent with a
   fresh URL. The agent never persists a token to survive that.

### 7.4 CSRF and the dashboard

`SameSite=Lax` means a cross-site `POST` does not carry the session cookie, and
a cross-site top-level `GET` does. Every mutation is therefore a `POST`, and the
edge enforces two independent checks on it: an `Origin` allow-list (with
`Sec-Fetch-Site` as a secondary signal) and a double-submit token — the
`dshrc_csrf` cookie must equal the `csrf` field or `x-csrf-token` header,
compared in constant time (`apps/edge/src/auth.ts:339-370`). `Origin: null` is
accepted **only** with `Sec-Fetch-Site: same-origin`, because
`Referrer-Policy: no-referrer` makes Chromium send a null origin on real form
posts; a cross-site null origin is rejected. Pair-code
redemption is a `POST`; `GET /pair?code=…` only renders a confirmation form, so
a link cannot pair a browser by itself (`apps/edge/src/pages.ts:194-208`).

The proxied DSH UI is a different origin path (`/d/<device>/`) but the same
edge origin. Its forms and fetches are DSH's own; DSH RC does not inject
CSRF tokens into proxied HTML. DSH's session here is the agent's upstream
cookie, not the browser's, so a CSRF request from the browser cannot borrow the
owner's DSH identity — the agent attaches it. A paired browser can still act as
the user inside DSH; that is the point of pairing, and it is why pairing itself
requires the owner credential. The pair code is a second factor of intent, not
a key: possession alone is insufficient.

### 7.5 Path escape and SSRF

`assertSafeOriginPath` rejects: non-origin-form paths, length > 8192, control
characters, `//` prefix, any `\`, an absolute URL in the first segment, and any
literal `..` segment (`packages/protocol/src/routing.ts:45-54`). The agent
repeats the check. The upstream authority is fixed by configuration, so even a
path that slips through cannot change the host.

Known subtlety: the validator does not percent-decode. `%2e%2e` passes the
literal `..` check. It cannot change the authority, but it could reach a
different route inside the DSH origin if DSH decodes before routing. Impact is
bounded to the DSH origin the user already controls; it is recorded here rather
than hidden. A future revision should normalize before validating.

### 7.6 Header injection

Request and response header values are filtered through a control-character
check before crossing (`routing.ts:109-139`). Node's HTTP parser already
rejects most malformed names; the filter is defence in depth for values
constructed upstream. Hop-by-hop headers are dropped in both directions
(`routing.ts:57-98`). `Location` headers pointing at the loopback origin are
rewritten into the public `/d/<device>/` prefix
(`routing.ts:163-171`); any other absolute `Location` is passed through, which
is correct for external redirects but means the DSH app can redirect the
browser off-site. That is DSH's behaviour, not an edge escalation.

### 7.7 Replay

- Transport: TLS on both hops; frames have no independent nonce, so replay
  protection is the TLS record layer's.
- Application: **no mutation replay, ever** (`docs/PROTOCOL.md:170-172`). After
  a reconnect, in-flight streams are reset as retryable and the DSH client
  re-establishes its own mux. Replaying a tool call whose outcome is unknown is
  how remote systems corrupt state.
- Credentials: pair codes are single use, expire, and require an owner session
  or password; setup codes are single use; session cookies carry `exp`; device
  secrets are bearer tokens until revoked.
  A captured device secret can open a new tunnel until the device is revoked —
  there is no per-message signature. TLS is the protection.

### 7.8 Revocation

Revoking a device must, atomically from the operator's point of view:

1. Mark the device revoked in SQLite.
2. Close the live tunnel with `4003` (`DEVICE_REVOKED`), which the agent treats
   as terminal and does not retry (`docs/PROTOCOL.md:179`,
   `packages/protocol/src/frames.ts:42`).
3. Drop presence so the dashboard shows offline.
4. Invalidate browser sessions scoped to that device.

Steps 2-4 are implemented together: the device-action handler calls
`tunnels.closeDevice(id, 4003, …)` and `auth.revokeDeviceSessions(id)`, while
`DeviceService.revoke` marks the row and deletes that device's pair codes and
sessions (`apps/edge/src/server.ts` `handleDeviceAction`,
`apps/edge/src/devices.ts:124-136`). The tunnel handshake independently refuses
a revoked device with `4003` (`apps/edge/src/tunnels.ts:221-222`). The device row
itself is kept as a tombstone so audit and re-registration remain legible.

### 7.9 Host compromise

If the desktop is compromised, the attacker has the DSH cookie, the launch
token while it is live, the device secret, and the ability to proxy anything
the agent can. DSH RC cannot contain that: the agent's job is to forward
requests to a server that trusts loopback. The only controls are OS-level
(full-disk encryption, separate user accounts, EDR) and DSH's own approvals.

A compromised *edge* is different: it can read and modify traffic, but it still
cannot reach another origin through the agent, and it cannot mint a DSH cookie
without the launch token.

### 7.10 Supply chain

- Runtime dependencies are `ws` and Node built-ins; no native addons, no
  WebRTC binary (`package.json`). This is the smallest dependency surface of
  the designs compared in `docs/COMPARISON.md`.
- The lockfile (`package-lock.json`) is committed; installs should use
  `npm ci`.
- The edge container should pin a digest, not a floating tag (`docs/DEPLOY.md`).
- No provenance attestation is configured in v1. **TBD** before a public
  release: publish with `npm publish --provenance`, sign container images, and
  document the verification command.

### 7.11 Browser-side risks

The proxied DSH UI runs DSH's own JavaScript with DSH's own CSP. DSH RC does
not rewrite HTML or inject scripts into proxied pages, so it cannot fix an XSS
in DSH, and an XSS in DSH runs with the paired browser's access to that device.
The edge's CSP (`http.ts:128-137`) applies only to edge-rendered pages such as
the dashboard, login and pairing screens. This separation is intentional: the
proxy must not silently change the application it serves.

### 7.12 Guest sharing: permanence, interference and revocation

Sharing is an authorization feature layered on the same proxy. It introduces a
principal the rest of this document did not previously have: a person the owner
invited, not the owner.

#### 7.12.1 The flow is three separate steps

1. The owner enables **Share this Harness** and creates an invite. The token is
   32 random bytes, returned once, stored only as SHA-256, single-use by default
   (`maxUses` can be raised to 10), with a 15-minute / 1-hour / 24-hour TTL or
   **Never** (`docs/SHARING.md` §2, §6).
2. The guest opens `/i/<token>` and requests access. That creates a **pending
   approval** and a short-lived claim cookie — never a DSH session. The owner
   sees the label, IP and user-agent (`docs/SHARING.md` §6).
3. The owner presses **Approve** or **Deny**. Only approval creates the guest
   session cookie `dshrc_guest`, signed and scoped to that one device
   (`docs/SHARING.md` §6).

This separation is the main control: an invite link in the wrong hands allows a
request, not access. The owner's approval is the gate, and it is only as good as
the owner actually reading the label/IP/user-agent.

#### 7.12.2 A guest session never expires

A guest session is deliberately permanent until revoked:

- no server-side expiry (`expiresAt: null`), no idle timeout;
- a 10-year cookie `Max-Age`;
- it survives edge restarts (SQLite + persisted signing secret), tunnel
  reconnects, browser restarts and the guest's machine rebooting;
- it ends only on guest **Disconnect**, owner revocation of that guest or all
  guests, sharing off, device revocation, or deletion of the edge database
  (`docs/SHARING.md` §6.1).

**A stolen guest cookie is therefore permanent access to that device until the
owner revokes it.** There is no TTL to wait out and no automatic cleanup. If the
guest's machine may be compromised, or the owner is unsure, the response is
**Revoke all** and **Share this Harness → Off**. Turning sharing off also revokes
every invite and guest session for that device (`docs/SHARING.md` §2, §7).

Revocation is immediate: the guest's session row is deleted and its browser
WebSockets are closed (`apps/edge/src/sharing.ts:327-360`,
`apps/edge/src/guest-connections.ts:72-108`). Disconnecting from the guest side
(`POST /i/session/disconnect`) clears the cookie and ends the session; it is not
a pause (`apps/edge/src/server.ts:843-869`).

#### 7.12.3 Multiple guests share one single-user desktop

There is no controller lock and no `GUEST_BUSY`. Two or more approved guests can
drive the same Harness at the same time. DSH is a single-user desktop: they
share the same workspace, terminal, tools and conversation state. They can
overwrite each other's files, run commands concurrently, read what another
guest is doing, and change settings the next guest inherits. There is **no
read-only guest mode** and no per-guest file/terminal scoping
(`docs/SHARING.md` §7, §9). The panel lists every guest separately and shows a
standing warning; that is visibility, not isolation.

Treat a guest as someone sitting at the desk, not someone viewing a document.

#### 7.12.4 Leaked invite or stolen cookie runbook

| Situation | Immediate action |
| --- | --- |
| Invite link leaked, not yet claimed | Revoke it under **Outstanding invites** (`DELETE /v1/devices/me/invites/:id`). No approval exists to revoke. |
| Invite claimed, awaiting approval | Press **Deny** in **Waiting for approval**; the claim never becomes a session. |
| Guest approved, cookie may be stolen | **Revoke** that guest, or **Revoke all**; then turn sharing off if the scope is unknown. |
| Sharing must stop entirely | **Share this Harness → Off** revokes every invite and guest session for the device. |
| Device itself is suspect | Revoke the device; the tunnel closes with 4003 and all its guest sessions end. |

Every step above is audited (`invite-created`, `invite-revoked`,
`invite-claimed`, `approval-approved`, `approval-denied`, `guest-revoked`,
`guest-connected`, `guest-disconnected`, `sharing-enabled`,
`sharing-disabled`; `apps/edge/src/sharing.ts`,
`apps/edge/src/guest-connections.ts`). Audit rows are mutable and pruned by the
edge operator (see §6.3), so they are evidence, not proof.

#### 7.12.5 What approval does and does not prove

Approval proves the owner intended to admit *whoever holds that link*. It does
not prove identity: IP and user-agent are attacker-controlled, and there is no
guest account, email verification or OAuth in v0.2 (`docs/SHARING.md` §9). If
the owner sends an invite to the wrong chat, approves without reading the
request, or approves a request they did not expect, the guest gets the desktop.
This is a social control, and should be described as one.

#### 7.12.6 The guest UI loads the same Harness client bundle

A guest is served the real DSH page, so the Remote Control client bundle is also
loaded in the guest browser. Two controls keep the host plugin UI and RPC away
from the guest:

1. The edge rejects `/d/<device>/dsh-rc` and `/d/<device>/dsh-rc/*` for guest
   sessions with `403` (`apps/edge/src/server.ts:1168,1248`). The host plugin RPC
   is unreachable even though it shares the device origin.
2. Guest HTML is injected with `globalThis.__DSH_RC_GUEST__=true`
   (`apps/edge/src/proxy-http.ts:71`); the client plugin returns before
   registering its sidebar entry or control surface
   (`packages/plugin/src/client/index.ts:1211-1214`).

The regression test `tests/upgrade/browser-regressions.test.ts` ("marks guest
HTML and blocks the host plugin RPC for guests") asserts both the marker and the
RPC 403. This is defence in depth: the bundle still executes, but its host RPC is
blocked and its UI does not register. A future client change that ignores the
flag would expose UI chrome, not the RPC; keep the test.

### 7.13 Supervision, Funnel and dashboard sharing

#### 7.13.1 launchd/systemd supervision

On macOS the edge is a GUI-domain LaunchAgent (`com.dshrc.edge`) running
`~/.dsh-rc/run-edge.sh`, which executes a standalone bundle at
`~/Library/Application Support/dsh-rc/edge/main.cjs`. A second agent
(`com.dshrc.tailscaled`) runs `tailscaled --tun=userspace-networking`. Both use
`RunAtLoad` and `KeepAlive`; they start when the user logs in, not at boot before
login (`scripts/install-macos.sh:60-98`).

Security consequences:

- The supervisor provides **restart**, not **privilege separation**. The edge
  runs as the logged-in user and has that user's access to `~/.dsh-rc/edge` and
  the DSH process.
- Plists and `run-edge.sh` are user-writable. A local attacker who can edit them
  already has the user's account; file permissions are not a sandbox.
- The bundle lives outside `~/Documents` because TCC blocks launchd from reading
  a checkout there (`scripts/build-edge-bundle.mjs:4`). This is a reliability
  fix, not a security boundary.
- A sleeping, logged-out or powered-off Mac has no remote path. Durable state
  survives; in-flight requests do not.

On Linux, systemd `Restart=on-failure` has the same properties: process restart,
same user, no privilege boundary. There is no built-in Tailscale supervision.

#### 7.13.2 The public Funnel endpoint

Tailscale Funnel terminates client TLS at Tailscale's ingress, carries the
request over WireGuard to the userspace tailscaled on the Mac, and that daemon
proxies it to `127.0.0.1:8787` (`docs/DEPLOY.md` §6.2). Therefore:

- **Tailscale sees plaintext** for proxied traffic, exactly as the edge does.
  Funnel adds a second party to the trust boundary; it does not remove the edge
  from it.
- The edge still binds loopback and opens no router port. Funnel is the only
  public ingress while enabled.
- `DSHRC_PUBLIC_URL` must equal the Funnel hostname. A mismatch produces invite
  links and cookies on the wrong origin; the installer writes the value into
  `run-edge.sh`, and the edge advertises it as `publicUrl`.
- Funnel can be disabled without stopping the edge:
  `tailscale --socket="$HOME/.dsh-rc/tailscale/tailscaled.sock" funnel --https=443 off`.
  Turning it off does not revoke guest sessions; they resume when the path
  returns, because sessions do not expire.
- The userspace tailscaled state (`~/.dsh-rc/tailscale/tailscaled.state`)
  contains the node identity and should be treated as a credential.

#### 7.13.3 Owner dashboard sharing

The edge dashboard is an owner-only admin surface. Sharing controls use the
owner session plus the same CSRF/Origin checks as the rest of the dashboard;
the one-time invite URL is rendered after the form POST, never placed in a
redirect (`docs/SHARING.md` §5, `apps/edge/src/pages.ts`). A guest session
cannot reach the dashboard (403). Consequences:

- A stolen owner session can create invites, approve guests and revoke devices.
  It is more powerful than any guest session; the 30-day cookie and password
  rotation matter.
- Rotating the owner password with `dsh-rc-edge-passwd` changes the password
  hash in place and does **not** revoke existing owner sessions. To log everyone
  out, rotate the session secret or delete sessions (`docs/OPERATIONS.md` §6).
- Dashboard form posts are ordinary browser requests; the CSRF token and
  `Origin` allow-list are the controls, not a separate API key.

## 8. Mitigations mapped to code

| Control | Enforced in | Reference |
| --- | --- | --- |
| Device id format | protocol | `packages/protocol/src/routing.ts:15-20` |
| Path policy | protocol + agent | `routing.ts:45-54` |
| Request header stripping | protocol + edge | `routing.ts:57-83` |
| Response header stripping | protocol + edge | `routing.ts:86-98` |
| Control-character filter | protocol | `routing.ts:109-139` |
| Priority classification | protocol + edge | `routing.ts:152-160` |
| Loopback `Location` rewrite | protocol + edge | `routing.ts:163-171` |
| Frame size/type checks | protocol | `packages/protocol/src/frames.ts:85-116` |
| JSON schema guards | protocol | `frames.ts:277-348` |
| Close codes | protocol | `frames.ts:32-45` |
| Secret hashing | shared | `packages/shared/src/ids.ts:39-41` |
| Constant-time compare | shared | `ids.ts:44-49` |
| Signed cookies + expiry | shared | `ids.ts:54-83` |
| Pair-code generation/hash | shared | `ids.ts:86-113` |
| Cookie flags | shared | `packages/shared/src/http.ts:40-49` |
| Security headers (edge pages) | shared | `http.ts:128-137` |
| Trusted-proxy address handling | shared | `http.ts:146-156` |
| Loopback address check | shared | `http.ts:163-168` |
| JSON/form body ceilings | shared | `http.ts:4`, `http.ts:52-90` |
| Log redaction | shared | `packages/shared/src/logger.ts:5`, `logger.ts:16-31` |
| Stream credit accounting | mux | `packages/mux/src/index.ts:609-617` |
| Queue overflow bound | mux | `mux/index.ts:691-700` |
| Priority scheduler | mux | `mux/index.ts:739-755` |
| Heartbeat / idle timeout | mux | `mux/index.ts:663-679` |
| Per-stream reset on bad frame | mux | `mux/index.ts:544-556` |
| Setup-code hash, TTL, single use | edge | `apps/edge/src/auth.ts:119-166` |
| Session cookie signing + expiry | edge | `apps/edge/src/auth.ts:239-247` |
| CSRF double-submit + `Origin` | edge | `apps/edge/src/auth.ts:339-370` |
| Rate limits | edge | `apps/edge/src/config.ts:64-69` |
| Device secret issue + hash | edge | `apps/edge/src/devices.ts:68-96` |
| Pair-code redemption | edge | `apps/edge/src/devices.ts:139-153` |
| Revocation cascade | edge | `apps/edge/src/devices.ts:124-136` |
| Revoked device refused at connect | edge | `apps/edge/src/tunnels.ts:221-222` |
| Token exchange + re-exchange | agent | `apps/agent/src/dsh-session.ts` |
| Invite token: 32 B, SHA-256 at rest, single use | edge sharing | `apps/edge/src/sharing.ts:147-190` |
| Claim creates pending approval, not a session | edge sharing | `apps/edge/src/sharing.ts:192-240` |
| Guest cookie signed, device-scoped, HttpOnly, 10-year Max-Age | edge sharing | `apps/edge/src/auth.ts:271-295`, `auth.ts:57` |
| Guest admin routes return 403 | edge sharing | `apps/edge/src/server.ts:192-216` |
| Revoke one/all guests; sharing off revokes all | edge sharing | `apps/edge/src/sharing.ts:327-392` |
| Guest audit events | edge sharing | `apps/edge/src/guest-connections.ts:29-70` |
| macOS LaunchAgent supervision | installer | `scripts/install-macos.sh:60-98` |
| systemd supervision (Linux) | deployment | `docs/DEPLOY.md` §4.3 |
| Standalone bundle outside TCC-protected Documents | installer | `scripts/install-macos.sh:43-44`, `scripts/build-edge-bundle.mjs:4-7` |
| Funnel hostname == public URL | installer | `scripts/install-macos.sh:48-58`, `docs/DEPLOY.md` §6.2 |
| Dashboard sharing: owner session + CSRF + Origin | edge dashboard | `apps/edge/src/server.ts:298-333`, `apps/edge/src/pages.ts:156-315` |
| Guest blocked from host plugin RPC | edge proxy | `apps/edge/src/server.ts:1168,1248` |
| Guest client does not register Remote Control UI | plugin client | `apps/edge/src/proxy-http.ts:71`, `packages/plugin/src/client/index.ts:1211-1214` |
| Password rotation without restart | edge CLI | `apps/edge/src/passwd.ts` |

## 9. Residual risks (accepted)

1. **A compromised edge reads all proxied plaintext.** By design. Mitigate by
   self-hosting or by not using DSH RC for that data.
2. **A compromised desktop is game over.** The agent's whole purpose is to act
   with the desktop's authority.
3. **A paired browser session is a credential.** It can drive DSH within its
   permissions. Pairing requires an owner session or the owner password, so a
   leaked pair code alone is not enough; a leaked owner session is. Revoke the
   device to invalidate its sessions.
4. **Same-user local attackers can read `upstream.json` (0600) and
   `device.json` (0600), or attach to the agent process.** File permissions are
   not a sandbox. The plugin keeps the token out of argv and logs, which narrows
   accidental exposure, not a determined local attacker.
5. **No per-message signing inside TLS.** A stolen device secret opens a tunnel
   until revocation; a stolen owner cookie lasts up to 30 days.
6. **No audit immutability.** The edge operator can rewrite SQLite and logs.
7. **Percent-encoded traversal is not normalized** (§7.5); bounded to the DSH
   origin.
8. **On the agent, `--insecure` disables TLS verification and permits
   non-loopback plaintext.** On the edge it is loopback-only. Either way it
   exists for a lab; using it on a public network is equivalent to publishing
   the session.
9. **A guest session never expires.** A stolen guest cookie is permanent access
   to that device until the owner revokes the guest, revokes all guests, turns
   sharing off, or revokes the device. There is no shorter TTL and no automatic
   cleanup. Review **Active guests**; if in doubt, **Revoke all** and turn
   sharing off.
10. **Multiple guests can interfere with each other.** They share one
    single-user desktop — workspace, terminal, tools and conversation state —
    with no controller lock, no read-only mode and no per-guest scoping.
11. **A guest sees everything the DSH UI shows** for that device: files,
    conversations, terminal output and tool results. Sharing is not a document
    share.
12. **An invite link is a bearer capability until claimed or expired.** The
    owner's approval is the gate, and approval proves intent, not identity; IP
    and user-agent can be spoofed.
13. **Funnel adds Tailscale to the plaintext path.** Tailscale terminates client
    TLS and forwards plaintext to the local tailscaled. A compromised Tailscale
    ingress can read or modify proxied traffic, just as a compromised edge can.
    Do not use Funnel if that trust is unacceptable.
14. **The supervisor is user-level, not a privilege boundary.** launchd/systemd
    restart the edge as the logged-in user; a same-user attacker can edit the
    plist, the bundle or the environment. Reboot recovery starts at user login,
    not at boot; a sleeping Mac has no remote path.
15. **Owner password rotation does not revoke sessions.** `dsh-rc-edge-passwd`
    changes the hash in place; existing owner cookies remain valid until logout
    or session-secret rotation.
16. **The guest browser executes the same Remote Control client bundle.** The
    edge blocks its RPC and sets a guest flag that stops UI registration, but a
    future client change that ignores the flag could expose plugin chrome. The
    RPC remains 403; the browser regression test guards both.

## 10. Out of scope

- Multi-tenant isolation: the edge is single-owner in v1.
- Protecting DSH from a malicious user the owner deliberately paired or approved
  as a guest. The owner's approval is the authorization boundary.
- Per-guest scoping or a read-only guest mode. A guest gets the whole DSH UI for
  one device (`docs/SHARING.md` §9).
- Guest identity verification. v0.2 has no guest accounts, email verification or
  OAuth; IP and user-agent are display metadata, not identity.
- Automatic guest expiry. Sessions persist until revoked by design; this is a
  documented product decision, not an oversight.
- Compromise of the Tailscale account, the Funnel ingress, or the macOS user
  account that owns the LaunchAgents. Funnel is documented as a trusted relay.
- Boot-before-login availability on macOS. The LaunchAgents are GUI-domain user
  agents, not root daemons.
- Hardening the supervisor against a same-user attacker. launchd/systemd provide
  restart, not isolation.
- Denial of service that saturates the edge's uplink; no CDN-level scrubbing.
- Compromise of the DNS or CA used for the edge certificate.
- Legal/compliance controls (data retention, subject access). See
  `docs/SECURITY.md` for disclosure.

## 11. Review

Re-review this document when any of the following changes: the edge gains
end-to-end encryption, the agent accepts a non-loopback upstream, authentication
gains a second factor, the edge becomes multi-tenant, the pair-code format
changes, guest sessions gain an expiry or idle timeout, guest read-only/scoping
lands, a guest-count cap is added, the sharing route/cookie names change, the
edge moves behind a different ingress (Funnel, Cloudflare, VPS), or supervision
moves from a user LaunchAgent/systemd to a privileged daemon.
Security reports follow `docs/SECURITY.md`.