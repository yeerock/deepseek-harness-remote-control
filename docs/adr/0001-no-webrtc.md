# ADR-0001 — WebRTC is an optional fast path, not the transport

- Status: **Accepted**
- Date: 2026-10-28
- Supersedes: the transport-first assumption in `ds-harness-remote`
- Deciders: DSH Link maintainers

## Context

The reference plugin uses WebRTC as its preferred data plane
(`LAN → P2P → TURN → Relay`). Users outside China report that remote sessions
"always hang and disconnect easily". The question is whether a better remote
access system should double down on WebRTC, or choose a different foundation.

Constraints that matter for this product:

1. **The client must be a browser.** The requirement is desktop DeepSeek Harness
   only, no mobile apps. The cheapest correct client is the Harness web UI that
   already exists.
2. **The user may be behind anything.** Hotel Wi-Fi, corporate TLS inspection,
   CGNAT, IPv6-only, a captive portal, a 300 ms intercontinental link.
3. **The agent runs in Node.** Any WebRTC implementation there is a native
   addon (`@roamhq/wrtc`, `werift`) — a second binary that can fail to load.
4. **Interactive latency matters more than peak throughput.** Keystrokes,
   token streaming and tool output are small messages; a 200 MB artifact
   download is rare and can be deprioritised.

## Decision

**Do not use WebRTC for the control or default data path.** Ship one
outbound TLS WebSocket between agent and edge, multiplexed into HTTP and
WebSocket streams, and serve the unmodified Harness UI over HTTPS.

Keep a documented door open for a **direct fast path**: after the tunnel is
established, an optional LAN/P2P link may be negotiated for bulk transfer,
selected per request, always subordinate to the authenticated tunnel. That is a
v2 optimization, not a v1 dependency.

## Why

### 1. WebRTC optimizes the wrong segment

WebRTC's value is bypassing a server between two peers. Here, one peer is a
public edge that must terminate TLS, authenticate the browser, route by device,
and apply policy anyway. The edge is not optional. Once it is in the path, P2P
saves one hop of RTT for users who are near each other, and adds an entire
negotiation subsystem for users who are not — which is the reported case.

### 2. The failure mode is the complaint

From the reference implementation:

- `DEFAULT_NEGOTIATE_TIMEOUT_MS = 8_000` — a blocked UDP path is only abandoned
  after eight seconds.
- The adaptive transport waits up to 15 s for the control handshake.
- WebRTC is attempted **first**, before relay, by design (`forceRelay` is opt-in).

So on a network where UDP is filtered — the norm in many corporate and public
networks — every new connection begins with a multi-second stall. Users read
that as "hung".

### 3. Browsers make WebRTC tunnels expensive

A browser cannot speak WebRTC to an HTTP origin without a JavaScript client and
a service-worker shim to proxy `fetch`/WebSocket through a DataChannel. That is
a second application to build, secure and debug — exactly the surface the
reference implementation had to maintain for Android and VS Code. Serving the
real origin over HTTPS needs none of it.

### 4. Node-side WebRTC is an install hazard

The reference package carries `@roamhq/wrtc` as an optional dependency and a
`werift` fallback plus a verification script. That complexity exists because
native WebRTC is not dependable across Node versions and platforms. A remote
access tool that fails at install time, or silently degrades to relay, is worse
than one that never promised P2P.

### 5. Congestion control is not on our side

SCTP over DTLS has a shared congestion window across streams. A bulk transfer
on one DataChannel can delay an interactive one; there is no browser API to
prioritise streams. In our mux we control the scheduler: weighted queues and
per-stream credit keep interactive traffic ahead of bulk traffic. That is a
real, testable property (`packages/mux/tests`).

### 6. Security is easier to reason about

TLS 1.3 to an edge we operate, a device secret hashed at rest, loopback-bound
DSH credentials that never leave the desktop, and an edge that never sees a DSH
token. WebRTC would add DTLS/SCTP and a second identity handshake without
removing the need for any of the above.

## Consequences

**Positive**

- One transport to supervise; no ICE/TURN state machine.
- Works through UDP-blocking networks and proxies.
- Feature parity with the desktop because the client *is* the desktop UI.
- Smaller trusted computing base (no native addon, no separate client).
- Predictable memory: flow control is ours.

**Negative**

- Traffic transits the edge in plaintext after TLS termination. Self-hosting is
  therefore a first-class option, and the threat model is explicit.
- Same-LAN users pay one extra hop instead of a direct link. Acceptable for v1;
  the direct fast path is the remedy.
- TCP head-of-line blocking remains at the transport layer. Mitigated by
  multiplexing and small frames, not eliminated.
- The edge is a bandwidth cost. Documented; TURN would have been one too.

## Revisit triggers

Revisit this decision if **all** of the following hold:

1. A measured workload shows ≥ 30 % of bytes are bulk transfers where edge
   bandwidth cost dominates.
2. A trustworthy Node WebRTC runtime ships prebuilt binaries for all supported
   platforms and passes a conformance suite.
3. The browser-side shim can be eliminated (e.g. a standardized way to route
   origin requests over a DataChannel), or the product accepts a JS client.
4. Direct-path success rate on the target networks is measured above 70 %.

Until then, WebRTC is a lab experiment behind a flag — never the default.

## References

- Reference implementation: `packages/webrtc/src/rtc-data-channel.ts`
  (`DEFAULT_NEGOTIATE_TIMEOUT_MS`), `adaptive-transport.ts` (transport order,
  15 s handshake), `packages/plugin/src/config.ts` (`forceRelay`).
- WebRTC DataChannel/SCTP congestion control: RFC 8831 §6.6, RFC 4960 §7.
- Our mux scheduler and credit scheme: `packages/mux/src/index.ts`,
  `docs/PROTOCOL.md` §4.4–4.5.