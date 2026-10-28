# Changelog

All notable changes to DSH Link. The project follows a `0.y.z` scheme until the
plugin and protocol are declared stable.

## v0.1.0 — 2026-10-28

First end-to-end release. Desktop-only remote access for DeepSeek Harness
0.2.1-rc.3.

### Added

- **Protocol v1** (`packages/protocol`): binary frames, JSON payload guards,
  device-path parsing, header allow/deny policy, request priority classification.
- **Multiplexer** (`packages/mux`): HTTP and WebSocket streams over one socket,
  credit-based flow control (256 KiB/stream, 8 MiB/tunnel), high/normal/low
  scheduling, heartbeat and idle timeout, stream cap, reset-release semantics.
- **Edge** (`apps/edge`): owner setup/login, HMAC session cookies, CSRF
  double-submit, rate limits, device registration, owner-gated pairing,
  approval/revocation, audit log with retention, SQLite storage, dashboard, and
  the `/d/<device>/` HTTP + WebSocket proxy with header hygiene and backpressure.
- **Agent** (`apps/agent`): outbound tunnel, DSH launch-token exchange (0600
  file, never argv/logs), loopback-only proxy, full-jitter reconnect
  (250 ms–20 s), terminal close-code handling, and a per-state-dir singleton
  lock.
- **Harness plugin** (`packages/plugin`): host service that mints the
  authenticated URL, supervises the agent (Electron-safe runtime selection), and
  a sidebar status panel with state, latency, reconnects, uptime, pairing QR and
  start/restart/stop.
- **Operations**: Dockerfile + Caddy Compose, systemd guidance, threat model,
  deployment and runbook docs, English and Simplified Chinese README.
- **Verification**: 196 automated tests, fault injection, benchmarks, and a
  real-DSH end-to-end test that renders the unmodified UI in Chromium through
  the tunnel.

### Security

- The browser never receives a DSH credential; the launch token is exchanged
  in-process for a loopback-bound cookie held in memory.
- Device secrets are random 32 bytes stored as SHA-256; pair codes are
  single-use, 10-minute, and require an owner session or owner password.
- The edge terminates TLS and sees proxied plaintext. Self-hosting is supported
  and documented; this is the central trust decision (ADR-0001).

### Known limits

- No WebRTC/P2P fast path; see `docs/adr/0001-no-webrtc.md` for revisit
  criteria.
- No mobile app and no supported mobile browser; the browser is the client.
- No replay of Harness mutations after an unknown outcome.
- Multi-region routing, hosted accounts/OAuth, and native TLS in the edge
  process are roadmap; put a TLS terminator in front for now.
- Measured numbers are loopback and measure tunnel overhead, not internet RTT.

### Upgrade notes

None; first release.