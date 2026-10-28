# DSH Link — FAQ

Answers are short; the linked documents carry the evidence.

## Is WebRTC used?

No. There is no ICE, no STUN, no TURN, no SDP, and no DataChannel in the data
path. One outbound TLS WebSocket carries every stream
(`docs/PROTOCOL.md:18-25`). The decision and its trade-offs are in
`docs/adr/0001-no-webrtc.md`.

A WebRTC fast path is explicitly a *future option*, not a hidden default: it
would be negotiated only after the tunnel is up, selected per request, and
always subordinate to the authenticated tunnel (`docs/adr/0001-no-webrtc.md:34-37`).
Nothing in v1 turns it on.

## Why not P2P?

Because the edge is not optional. It terminates TLS, authenticates the browser,
routes by device, enforces pairing, applies rate limits and writes audit rows.
Once it is in the path, peer-to-peer saves one hop of RTT for users who happen
to be near each other, and adds a negotiation subsystem for everyone else —
which is the reported failure case (`docs/adr/0001-no-webrtc.md:41-47`).

On the same LAN, a direct path would be shorter. DSH Link accepts that
regression in exchange for predictable setup on networks that block UDP. If you
need the shortest LAN path, the reference plugin's WebRTC mode is the better
tool (`docs/COMPARISON.md`).

## What happens on a flaky network?

- The agent reconnects with full-jitter exponential backoff, 250 ms to 20 s
  (`docs/PROTOCOL.md:163-169`).
- The edge keeps device presence for 30 s, so the browser sees a reconnecting
  state instead of a hard offline page.
- In-flight streams are reset with `retryable: true`; the browser shows the
  edge's 503 page with `Retry-After: 5` while the device is offline.
- DSH's own client reconnects its `/api/remote.mux` stream. DSH Link does not
  replay application messages, ever (`docs/PROTOCOL.md:170-172`).
- A half-open TCP connection is detected by the 15 s heartbeat and closed after
  45 s of silence.

Measured reconnect after a forced tunnel replacement (close 4004, loopback edge,
Apple M4 Pro, 2026-10-28) is **49 ms**. A true packet-loss blip is still
unmeasured; the design target remains under 2 s median
(`docs/ARCHITECTURE.md:157-166`).

## Can I self-host?

Yes — it is the primary deployment. The edge is one Node process with one
SQLite file, and the agent only dials out. `docs/DEPLOY.md` covers three shapes:
laptop demo, single VPS with Docker + Caddy (automatic TLS), and Cloudflare in
front.

There is no hosted service in v1. If you do not run an edge, nothing connects.

## Does my DSH token leave the machine?

No. The launch token is exchanged once by the agent for a loopback-bound DSH
cookie, which is held in memory. Neither the token nor the cookie is sent to
the edge or the browser (`docs/ARCHITECTURE.md:113-117`,
`docs/THREAT-MODEL.md` §7.3).

Two honest caveats:

1. When the plugin launches the agent, the URL is written to
   `{stateDir}/upstream.json` with mode 0600 and read with `--dsh-url-file`; it
   is not in argv, logs, the status file or the client UI. A process running as
   the same OS user can still read that file or the agent's memory. A manual
   run with `--dsh-url` does put the token in argv — use `--dsh-url-file` if
   that matters.
2. The browser never receives a DSH credential, but a paired browser can still
   *act* as you inside DSH. The pair code is only a single-use proof of intent:
   redeeming it requires your owner session or owner password, so the code
   alone cannot pair a browser. Treat the owner session as the credential.

## What DSH versions are supported?

The target is **DeepSeek Harness 0.2.1-rc.3**, the installed desktop app this
repository is developed against. The plugin declares the range
`>=0.2.1-rc.3 <0.3.0` in `packages/plugin/package.json` (`engines.dsh`) and uses
the DSH plugin manifest format (`packages/plugin/dsh-plugin.json`).

Builds inside that range are untested unless they are 0.2.1-rc.3; builds
outside it are unsupported. A compatibility matrix is **TBD**.
If you run a different build and the UI loads but its WebSocket does not, check
`/api/remote.mux` first — DSH Link proxies it opaquely and cannot compensate for
a changed app protocol.

## Why desktop-only?

Because the browser is the client. The requirement was remote access to the
DeepSeek Harness *desktop* app, and the cheapest correct client is the UI that
already exists (`docs/ARCHITECTURE.md:17-23`). A native mobile app would be a
second client to build, secure and keep in sync — the surface the reference
implementation had to maintain for Android, iOS and VS Code.

Consequences, stated plainly:

- There are no mobile apps, no push notifications, no offline shell.
- A phone browser can usually open the UI, but the layout is a desktop layout
  and mobile use is **untested/TBD**. It is not a supported client.
- A future native client would speak the same HTTPS surface, not a new
  protocol (`docs/PROTOCOL.md:197-198`).

## Does the edge see my traffic?

Yes. The edge terminates TLS, so it sees plaintext HTTP requests and responses
and every WebSocket frame (`docs/THREAT-MODEL.md` §7.1). It is a trusted relay.

What it does not see: the DSH launch token, the DSH cookie, or the device
secret in clear (it stores only a SHA-256). It cannot make the agent connect to
an origin other than the configured loopback target.

If that trust is unacceptable, self-host the edge on hardware you control, or
use a design with application-layer end-to-end encryption. DSH Link v1 has no
E2EE layer; `docs/COMPARISON.md` §6 explains the trade-off.

## Is the traffic encrypted?

Between browser and edge: yes, TLS (HTTPS/WSS on 443). Between edge and agent:
yes, TLS WebSocket. Between agent and DSH: loopback HTTP, on the same machine.
Inside the edge: no — that is the plaintext boundary above.

## How many browsers can pair with one device?

Each browser pairs separately with its own single-use code, redeemed while
signed in as the owner (or with the owner password); sessions are scoped to the
device. Multiple browsers can hold sessions for the same device. The
exact session limit is not a documented product feature in v1; use the dashboard
to review and revoke sessions if your build exposes that view.

## What happens if the edge goes down?

Existing tunnels drop. The agent retries with backoff; browsers show an error
until the edge returns. The DSH desktop itself keeps working locally — the edge
is only the remote path.

There is no fallback to a second edge in v1. If you need high availability, run
a second edge and move devices deliberately (`docs/DEPLOY.md` §8); automatic
multi-region selection is roadmap (`docs/ARCHITECTURE.md:154`).

## Can I use it behind a corporate proxy or TLS inspection?

Usually. The agent dials out on 443/TCP, which is the traffic most networks
allow. Two caveats:

- If the proxy intercepts TLS, Node does not use the system trust store by
  default. Point the agent at your corporate CA with
  `NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem`.
- `--insecure` disables certificate verification. It exists for a lab. Using it
  on a network you do not control is equivalent to publishing the session.

## Do I need a public IP or port forwarding?

No. The agent only makes outbound connections. The edge needs a public HTTPS
listener (or a tunnel to one); the desktop does not.

## Can I run more than one desktop on one edge?

Yes. One edge has one owner and multiple devices; each device appears separately
in the dashboard and has its own tunnel, secret and audit history. The v1 edge
is single-owner, not multi-tenant.

## How do I revoke a lost laptop?

Dashboard → revoke the device, or `POST /v1/devices/:id/revoke`. The tunnel is
closed with `4003`, the agent stops retrying, presence is dropped and sessions
scoped to the device are invalidated. Then rotate anything else the laptop held.
Full procedure: `docs/OPERATIONS.md` §3.

Revocation is not a remote wipe; full-disk encryption is what protects the data
on a stolen machine.

## What is not implemented in v1?

- Mobile apps, iOS/Android clients.
- End-to-end encryption against the edge.
- Multi-region edges and automatic nearest-edge selection.
- OAuth, hosted accounts, teams, billing.
- Application-level replay of in-flight mutations (deliberately absent, not a
  gap).
- Owner password reset without deleting the owner row.
- Prometheus metrics; the health endpoints are JSON only.

## Is it production-ready?

The protocol, mux and shared security primitives are written and tested; the
edge, agent and plugin are landing in parallel, and the performance numbers are
not published yet. Treat v0.1.x as fit for personal and small-team use after you
have tested your own deployment, not as a hardened multi-tenant service. The
threat model lists exactly what it does and does not protect.

## What license?

MIT (`package.json`).