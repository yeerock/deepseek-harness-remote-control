# DSH RC — threat model

**Audience:** security reviewers, operators choosing a deployment shape, and
contributors changing the edge, the agent or the protocol.

**Status:** v1 design. This document describes the system as specified in
`docs/ARCHITECTURE.md` and `docs/PROTOCOL.md`, and names the code that enforces
each control. Where a control lives in code that is still landing, the row says
so; it is not a claim that the control exists yet.

**Method:** assets → actors → trust boundaries → STRIDE per boundary →
residual risk. No control is listed without a file reference or an explicit
"design requirement, enforcement pending" note.

## 1. System model

```
 owner browser ──HTTPS/WSS 443──▶ edge ──one multiplexed WSS──▶ agent ──loopback HTTP/WS──▶ DSH web server
 (public internet)               (trusted relay)                (desktop)                    (127.0.0.1:<port>)
```

| Component | Runs where | Sees | Does not see |
| --- | --- | --- | --- |
| Browser | Anywhere | The DSH UI, its own edge session cookie | Device secret, DSH launch token, DSH cookie |
| Edge | Operator-controlled host | TLS plaintext of every proxied request and response: paths, headers, bodies, WebSocket frames; session and device metadata | Device secret (only its SHA-256), DSH launch token, DSH cookie |
| Agent | The desktop | Device secret, DSH launch token, DSH cookie, all proxied traffic | Owner session cookie |
| DSH web server | The desktop, loopback | Its own normal traffic | Edge internals |

The edge terminates TLS. **It therefore sees plaintext HTTP/WS for all proxied
traffic.** This is the central trust assumption of the design, stated in
`docs/ARCHITECTURE.md:59-64` and in ADR-0001. Self-hosting the edge is the
mitigation; there is no end-to-end encryption layer in v1.

## 2. Assets

| Asset | Where it lives | Lifetime | Required property |
| --- | --- | --- | --- |
| DSH session content (prompts, code, tool output, terminal) | Desktop; in transit through the edge | Session | Confidentiality, integrity |
| DSH launch token | Agent memory; delivered at startup through `{stateDir}/upstream.json` (0600) when launched by the plugin, or `--dsh-url` on a manual run | Process lifetime | Confidentiality, single use |
| DSH loopback auth cookie | Agent memory only | Until the DSH server restarts or rejects it | Confidentiality |
| Device secret (32 random bytes) | Agent state file; SHA-256 at the edge | Until rotated | Confidentiality, integrity |
| Owner session cookie | Owner's browser; HMAC-signed value at the edge | 30 days | Confidentiality, integrity, unforgeability |
| Pair code (8 chars) | Displayed once; hash at the edge | 10 minutes, single use; requires owner session or password | Confidentiality, single use, intent |
| Audit and presence metadata | Edge SQLite and logs | Deployment policy | Integrity, retention control |
| Host filesystem and tools | Desktop, reachable through DSH | Persistent | Confidentiality, integrity |

The last row matters: DSH can read files, run tools and open terminals. A
compromised browser session is not "read the chat"; it is "act as the user on
that desktop", bounded only by DSH's own approvals and permissions. DSH RC
does not add a second permission layer inside DSH.

## 3. Actors and capabilities

| Actor | Capability assumed |
| --- | --- |
| Owner | Legitimate operator of the edge and the desktop; may be phished |
| Paired browser user | Holds a valid pair-code-derived session for one device |
| Network attacker | On-path (can drop, delay, replay, inject) or off-path (can scan, connect, send requests) |
| Malicious web page | Can make the owner's browser issue cross-site requests; cannot read cross-origin responses |
| Compromised edge | Full control of the edge process, its database, its TLS keys and its plaintext view |
| Compromised desktop | Full control of the agent process, its state dir, and the DSH server |
| Malicious DSH upstream | Controls response headers and bodies returned to the edge |
| Supply-chain attacker | Can publish a malicious version of a dependency or the package itself |
| Internet scanner | Unauthenticated; sends arbitrary paths, headers, frames |

Explicitly out of scope: a user who grants a paired browser to an attacker, and
a desktop already running hostile software as the same OS user. Neither is
defensible at this layer, and pretending otherwise would weaken the document.

## 4. Trust boundaries

| ID | Boundary | Protection | What crosses |
| --- | --- | --- | --- |
| B1 | Browser ↔ edge | TLS 1.2+ (TLS 1.3 preferred), HTTPS/WSS on 443 | HTTP requests, WebSocket frames, session cookie |
| B2 | Edge internals | Process boundary only; **plaintext** | Proxied traffic, device records, audit |
| B3 | Edge ↔ agent | TLS WebSocket + `Authorization: Bearer <device secret>` + `HELLO.token` | Tunnel frames, opaque payloads |
| B4 | Agent ↔ DSH | Loopback TCP + DSH cookie | HTTP/WS to `127.0.0.1:<port>` |
| B5 | Plugin ↔ agent | Same OS user; process spawn; state dir 0700 | Launch URL (`upstream.json`, 0600), device secret (file), status JSON |
| B6 | Operator ↔ edge | Owner session cookie + CSRF checks | Dashboard, pairing, revocation |

B2 is the boundary reviewers should focus on. B1 protects the wire; B2 does not
protect anything from the edge operator.

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
  across restarts (`apps/edge/src/auth.ts:104-123`).
- `Secure` is set whenever the public origin is HTTPS
  (`apps/edge/src/auth.ts:183-202`). A plain-HTTP loopback demo therefore gets a
  non-`Secure` cookie — the browser would discard it otherwise. `--insecure`
  only permits a plain-http public URL on a loopback bind; it is not what makes
  the cookie non-`Secure`.
- Every state-changing dashboard action is a `POST` with an `Origin` allow-list
  check and a double-submit CSRF token (`dshrc_csrf` cookie compared with the
  `csrf` form field or `x-csrf-token` header, constant time). No mutation is
  reachable by `GET`. `SameSite=Lax` blocks cross-site `POST` cookies, but `Lax`
  still sends the cookie on top-level `GET` navigation, so `GET` must never
  mutate (`apps/edge/src/auth.ts:242-291`).

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

## 6. STRIDE pass

### 6.1 Spoofing

| Threat | Mitigation | Where |
| --- | --- | --- |
| Fake edge (phishing, DNS) | TLS certificate validation by browser and agent; `--insecure` is explicit and loud | Agent flag; `docs/DEPLOY.md` |
| Fake agent connecting to the edge | Device secret verified against stored SHA-256 in constant time | `packages/shared/src/ids.ts:44-49` |
| Forged owner cookie | HMAC-SHA256 over the payload with a server secret; expiry checked | `packages/shared/src/ids.ts:54-83` |
| Replayed setup code | Single use, 24 h TTL, hash at rest; a restart before setup rotates it; setup disabled after first owner | `apps/edge/src/auth.ts:104-160` |
| Replayed pair code | Single use, 10-minute TTL, hashed at rest, and redeemable only by an owner session or with the owner password | `ids.ts:86-113`; `apps/edge/src/devices.ts:139-153` |
| Device id confusion | Strict `dev_[a-z0-9]{16,64}` validation before lookup | `packages/protocol/src/routing.ts:15-20` |

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

The agent's re-validation is the important half: a compromised edge must not be
able to make the agent fetch `http://169.254.169.254/` or another origin. The
agent uses a fixed loopback target and treats `OPEN.path` as a path, not a URL
(`docs/PROTOCOL.md:99-103`).

### 6.3 Repudiation

| Threat | Mitigation | Where |
| --- | --- | --- |
| Owner denies pairing/revoking a device | Audit rows for `owner-setup`, `login`, `logout`, `register`, `pair`, `approve`, `revoke`, `tunnel-connect`, `tunnel-disconnect` | `apps/edge/src/db.ts:121-137`, `apps/edge/src/devices.ts` |
| Attacker covers tracks | JSON-line logs can be shipped off-host; if they are, SQLite is not the only copy | `docs/OPERATIONS.md` §7, §10 |

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

### 6.6 Elevation of privilege

| Threat | Mitigation | Where |
| --- | --- | --- |
| Path traversal to another origin | Fixed upstream host; origin-form path; `..`, `//`, `\`, absolute URLs and control chars rejected on both sides | `routing.ts:45-54` |
| SSRF via `Host`/absolute URL | `host` header stripped and rebuilt by the agent; absolute URL in path rejected | `routing.ts:57-83`, `routing.ts:45-54` |
| CSRF on dashboard or pairing | `SameSite=Lax` cookies, `Origin` allow-list, double-submit token, no `GET` mutations | `packages/shared/src/http.ts:40-49`, `apps/edge/src/auth.ts:242-291` |
| XSS on edge-rendered pages | Strict CSP on edge pages, `nosniff`, `frame-ancestors 'none'` | `http.ts:128-137` |
| Clickjacking | `x-frame-options: DENY` + `frame-ancestors 'none'` | `http.ts:128-137` |
| `--insecure` widens exposure | Edge: accepted only on a loopback bind, for a plain-http public URL. Agent: permits plain `http`/`ws` to a non-loopback edge and disables TLS verification. Both are explicit, off by default | `apps/edge/src/config.ts:209-225`, `apps/agent/src/main.ts` |
| Owner session stolen | HttpOnly (no JS access), Secure, SameSite=Lax, 30-day expiry, revocation | `http.ts:40-49` |

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
compared in constant time (`apps/edge/src/auth.ts:242-291`). Pair-code
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
| Setup-code hash, TTL, single use | edge | `apps/edge/src/auth.ts:104-160` |
| Session cookie signing + expiry | edge | `apps/edge/src/auth.ts:208-240` |
| CSRF double-submit + `Origin` | edge | `apps/edge/src/auth.ts:242-291` |
| Rate limits | edge | `apps/edge/src/config.ts:64-69` |
| Device secret issue + hash | edge | `apps/edge/src/devices.ts:68-96` |
| Pair-code redemption | edge | `apps/edge/src/devices.ts:139-153` |
| Revocation cascade | edge | `apps/edge/src/devices.ts:124-136` |
| Revoked device refused at connect | edge | `apps/edge/src/tunnels.ts:221-222` |
| Token exchange + re-exchange | agent | `apps/agent/src/dsh-session.ts` |

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

## 10. Out of scope

- Multi-tenant isolation: the edge is single-owner in v1.
- Protecting DSH from a malicious user the owner deliberately paired.
- Denial of service that saturates the edge's uplink; no CDN-level scrubbing.
- Compromise of the DNS or CA used for the edge certificate.
- Legal/compliance controls (data retention, subject access). See
  `docs/SECURITY.md` for disclosure.

## 11. Review

Re-review this document when any of the following changes: the edge gains
end-to-end encryption, the agent accepts a non-loopback upstream, authentication
gains a second factor, the edge becomes multi-tenant, or the pair-code format
changes. Security reports follow `docs/SECURITY.md`.