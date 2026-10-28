# DSH RC — architecture

> Remote access to a DeepSeek Harness desktop that does not hang when the
> network is bad, does not need a second client, and does not need WebRTC.

## 1. The problem, stated precisely

The reference implementation (`liguobao/ds-harness-remote`) is a large, careful
system. Its weakness is not craft; it is **topology and surface area**:

| Property | Reference implementation | Consequence for a user outside China |
| --- | --- | --- |
| Data plane | WebRTC first, TURN, then WSS relay | Every attempt pays ICE gathering; the code waits up to 8 s before falling back (`DEFAULT_NEGOTIATE_TIMEOUT_MS`) and 15 s for the control handshake |
| Signaling / TURN / relay | One self-hosted server (`dsh.r2049.cn` in the shipped default) | The relay is also the far side of the world; RTT alone makes keystrokes feel stuck |
| NAT traversal | STUN/TURN on UDP | Hotel, corporate, campus and CGNAT networks drop UDP; TURN then costs a second round trip |
| Client | Separate `client-core` projecting Harness RPC into Android/VS Code/desktop shells | Two protobuf-ish surfaces to keep in sync; a stalled projection looks like a frozen app |
| Recovery | Tear down the connection, re-run membership + Noise + transport selection | A transient Wi-Fi blip costs seconds and loses in-flight UI state |
| Node WebRTC | Optional native `@roamhq/wrtc` | Install-time and ABI fragility that is invisible until a user's machine differs |

None of these are bugs in isolation. Together they explain "always hang and
disconnected easily": the system spends its first seconds trying a transport
that usually cannot work, through a server that is far away, and after a blip
it starts over.

## 2. The bet

**Serve the real DSH web UI through one reliable HTTP/WebSocket tunnel.**

The Harness desktop already runs a complete browser surface on
`127.0.0.1:<port>`: the same React app, the same `/api/remote.mux` stream, the
same tools, files and terminal. If a remote browser can reach that origin, it
gets *feature parity for free* — there is no second client to build, no RPC
projection to drift, and no protocol to reverse-engineer.

This was verified before any code was written: the unmodified UI was loaded
through a 120-line reverse proxy on a different origin, its WebSocket connected,
and the full shell rendered. The architecture is not a guess.

```
┌─────────────┐   HTTPS + WSS (443)   ┌──────────────┐   one multiplexed WSS   ┌───────────┐   loopback HTTP/WS   ┌─────────────┐
│   browser   │ ────────────────────▶ │     edge     │ ◀────────────────────── │   agent   │ ───────────────────▶ │ DSH desktop │
│ (anywhere)  │ ◀──────────────────── │ (anycast-ish)│ ──────────────────────▶ │ (desktop) │ ◀─────────────────── │ web server  │
└─────────────┘                       └──────────────┘                         └───────────┘                      └─────────────┘
                                       auth, pairing,                          mints the DSH                     unchanged
                                       presence, routing,                      auth cookie, proxies
                                       audit, rate limits                      HTTP + WebSocket
```

### Why one transport wins

- **443/TCP passes everywhere.** Corporate proxies, TLS inspection, captive
  portals, IPv6-only, CGNAT. No UDP, no STUN, no TURN credentials.
- **One connection to supervise.** Heartbeats, backoff and backpressure live in
  one place instead of three fallback paths.
- **No second protocol to keep in sync.** Upgrading DSH upgrades the remote UI.
- **Sub-path mounting works.** The app already uses `<base href="./">` and
  relative asset URLs, so `/d/<device>/` behaves like its own origin root.

### What we give up, honestly

- The edge sees **ciphertext over TLS but plaintext after termination**. It is a
  trusted relay. That is the same trust the reference implementation places in
  its relay server, but with far less code to audit. Self-hosting the edge is a
  first-class deployment, and the threat model states the boundary plainly.
- A single TCP connection has head-of-line blocking at the transport level.
  Mitigated by app-level multiplexing, per-stream flow control, priority
  scheduling, and small frames; not eliminated. QUIC/HTTP3 at the edge is a
  later optimization, not a prerequisite.
- Direct LAN transfers are slower than a P2P path would be. Bulk transfer is a
  good candidate for the optional direct-link work in ADR-0001.

## 3. Components

| Path | Responsibility | May write |
| --- | --- | --- |
| `packages/protocol` | frame codec, payload guards, path/header policy | Lead |
| `packages/mux` | streams, windows, scheduler, heartbeat | Lead |
| `packages/shared` | WS adapter, ids/tokens, HTTP + cookie helpers, logging | Lead |
| `apps/edge` | public HTTPS/WSS, auth, pairing, presence, proxy, dashboard, SQLite | edge engineer |
| `apps/agent` | tunnel client, DSH cookie bootstrap, HTTP/WS proxy, reconnect | agent engineer |
| `packages/plugin` | DSH host plugin (mint URL, run agent) + client UI | plugin engineer |
| `tests`, `tools/bench` | integration, fault injection, Playwright, benchmarks | verification engineer |
| `docs` | ADRs, threat model, deployment, comparison | docs engineer |

## 4. Request lifecycle

1. Browser asks `GET /d/<device>/` on the edge.
2. Edge validates the session cookie, CSRF origin, device access and rate limit.
3. Edge looks up the device's live tunnel. Offline → `503` with `Retry-After`
   and a reconnecting page (presence grace 30 s).
4. Edge opens stream `n` with `OPEN {kind:"http", method, path: "/", headers}`.
5. Agent validates the path, builds a loopback request with its **server-side
   DSH cookie**, streams the body as `DATA`, ends with `END`.
6. Agent sends `HEAD {status, headers}` then `DATA` frames as the upstream
   produces them; `END` closes the response.
7. Edge writes to the browser with backpressure. Credit returns to the agent
   only as bytes are actually flushed, so a slow phone cannot balloon the
   desktop's memory.
8. Browser aborts → `RESET` → agent destroys the upstream request.

WebSocket follows the same shape with `kind:"ws"`, an `OPEN_ACK` handshake and
`WS_FRAME` messages; the edge holds the browser upgrade until the agent's
upstream socket is open.

## 5. Authentication and trust

```
owner ──setup code (rolled per boot until setup completes)──▶ edge session cookie (HttpOnly, Secure, SameSite=Lax, 30 d)
agent ──device secret (32 B, hashed at rest)──▶ tunnel + device API
browser ──pair code (8 chars, 10 min, single use)──▶ access to that device
```

- The **device secret never leaves the desktop**; the edge stores only its
  SHA-256.
- The **DSH launch token never leaves the agent**: the agent exchanges it once
  for a loopback-bound cookie and holds it in memory. The browser never sees a
  DSH credential.
- The edge strips browser `Cookie`/`Origin`/`Authorization` before `OPEN` and
  rebuilds them; DSH's own loopback-only trust fence is satisfied by the agent,
  not bypassed by the browser.
- Responses drop `Set-Cookie`, HSTS and hop-by-hop headers, so an upstream
  compromise cannot widen browser state.
- The agent refuses non-loopback upstreams, absolute URLs, `..` segments and
  control characters even if the edge is compromised (defence in depth).

## 6. Reliability mechanics

| Failure | Behaviour |
| --- | --- |
| Agent's Wi-Fi blips | Full-jitter reconnect (250 ms → 20 s); presence kept 30 s; streams reset as retryable; DSH's own client reconnects its mux |
| Edge restarts | Agent reconnects on its own; no user action |
| DSH web server restarts | Agent marks tunnel degraded, backs off, recovers; browser gets a clear 503 page |
| One huge download | Low-priority queue + per-stream window; interactive frames keep flowing |
| Slow consumer | Credit stops at 256 KiB per stream / 8 MiB per tunnel |
| Half-open TCP | PING every 15 s; no traffic for 45 s closes the tunnel and reconnects |
| Bad frame | Stream-level reset; connection-level frames close with 1002 |
| Device revoked | Terminal close code 4003; agent stops retrying and says why |

## 7. Non-goals (v1)

- Mobile applications. The browser is the client; a future native client would
  use the same HTTPS surface.
- Peer-to-peer/WebRTC data paths. See ADR-0001 for when that changes.
- Replaying Harness mutations after an unknown outcome. Never.
- Multi-tenant SaaS billing. Self-host first; OAuth and hosted accounts later.
- A second UI for chat, files or terminal. The point is that there isn't one.

## 8. Deployment shapes

| Shape | Edge | Notes |
| --- | --- | --- |
| Laptop demo | `dsh-rc edge` on `127.0.0.1:8787` | Plain HTTP allowed only for loopback |
| Single VPS | Docker + Caddy (automatic TLS) | Simplest production; one region |
| Multi-region | One edge per region, same SQLite snapshot or Postgres (roadmap) | Agent latency-probes and connects to the nearest; hop tokens carry a browser between edges |
| Behind Cloudflare | `TRUST_PROXY=1`, origin certificate | Anycast + HTTP/3 without owning PoPs |

## 9. Service levels the design targets

- Tunnel reconnect after a 100 % packet-loss blip < **2 s** median.
- Interactive request added latency < **1 RTT** (no negotiation, no fallback).
- First paint through the edge < **1.5×** direct loopback on the same LAN.
- Zero idle CPU cost: change-driven, one timer per tunnel.
- Memory ceiling per tunnel: **< 24 MiB** excluding proxied payload buffers.

These are targets to measure, not claims. `tools/bench` reports the numbers and
the README cites them with the machine and date.

## 10. Guest sharing (v0.2)

Sharing is a second authorization path layered on the same proxy. It is **off by
default and per device**; the owner enables it on the device that owns the
Harness. A guest is neither an owner nor a paired browser: it holds a
device-scoped session and reaches only `/d/<deviceId>/*`.

```
sharing off
   │ owner enables (dashboard or device API)
   ▼
enabled ──create invite──▶ invite (single-use default; TTL 15m/1h/24h/Never)
   │                              │ guest opens /i/<token>
   │                              ▼
   │                         claim pending ──owner deny──▶ denied
   │                              │ owner approve
   │                              ▼
   └───────────────────────▶ guest session (expiresAt = null)
                                  │
        guest Disconnect / owner Revoke / Revoke all /
        sharing off / device revoke / DB deleted
                                  ▼
                                ended
```

| State | Stored as | Ends when |
| --- | --- | --- |
| Invite | `invites`, `token_hash` = SHA-256, `expires_at` 0 = never | used up, revoked, TTL reached, sharing off |
| Pending approval | `approvals.status = 'pending'` | approved, denied, invite expired/revoked, sharing off |
| Guest session | `sessions.kind='guest'`, `expires_at = NULL` | guest Disconnect, owner revoke one/all, sharing off, device revoke, DB deletion |

- Claim cookies are signed, HttpOnly, SameSite=Lax, Secure on HTTPS, 24 h; a
  claim is never a session.
- The guest cookie is `dshrc_guest`, signed with the persisted edge secret, with
  a 10-year Max-Age and **no server-side expiry**. It survives edge restarts and
  tunnel reconnects; there is no idle timeout.
- **Multiple guests may hold sessions at once.** No controller lock, no
  `GUEST_BUSY`; they share one single-user desktop and can interfere.
- Admin routes return 403 to a guest; `/d/<other-device>/` is 403. The edge also
  rejects `/d/<device>/dsh-rc/*` (host plugin RPC) for guests, and guest HTML
  sets `globalThis.__DSH_RC_GUEST__` so the Remote Control client does not
  register its sidebar entry in a guest view.
- Revoking a guest deletes the row and closes its WebSockets (1008); disabling
  sharing revokes invites and guest sessions for the device.
- The owner can drive sharing from the edge dashboard (owner session + CSRF) and
  from the device-scoped API (Bearer device secret). Both call the same service.
- Approval `ttlSeconds` is accepted for contract compatibility but ignored;
  guest sessions are permanent by design.

## 11. Supervision and reboot semantics

The edge process is supervised; the DSH plugin supervises the agent separately.

- **macOS:** `com.dshrc.edge` runs `~/.dsh-rc/run-edge.sh`;
  `com.dshrc.tailscaled` runs `tailscaled --tun=userspace-networking` with
  state/socket under `~/.dsh-rc/tailscale/`. Both are `RunAtLoad` + `KeepAlive`
  LaunchAgents in the GUI domain. They start at **user login**, not at boot.
  A sleeping or powered-off Mac has no remote path; sessions remain valid and
  resume when the host returns.
- The macOS edge runs from
  `~/Library/Application Support/dsh-rc/edge/main.cjs`, not the checkout: TCC
  blocks a launchd agent from reading a project under `~/Documents`.
  `scripts/install-macos.sh` builds the standalone CJS bundle, writes the
  launcher, and loads both agents. The data directory is `~/.dsh-rc/edge`.
- **Linux:** a systemd unit with `Restart=on-failure` runs the same edge process;
  Tailscale is supervised separately.
- Supervision gives restart, not privilege separation: the edge runs as the
  invoking user. A compromised edge is a user-level compromise.
- Restarting the edge is safe for durable state: SQLite is reopened, sessions
  survive, agents reconnect with full-jitter backoff. In-flight requests fail;
  there is no mutation replay.

## 12. Tailscale Funnel trust boundary

Funnel terminates client TLS at Tailscale's ingress, carries the request over
WireGuard to the userspace tailscaled on the Mac, and that daemon proxies it to
`127.0.0.1:8787`. The edge sees plaintext after Tailscale's TLS termination, so
Tailscale is a second party that can read proxied traffic in addition to the
edge operator.

`--trust-proxy` is correct because the immediate proxy is local, but it does not
make Tailscale invisible. The public Funnel hostname is the only ingress; the
edge still binds loopback and no router port is opened. If Tailscale must not be
in the trust boundary, use a VPS edge you operate instead.

