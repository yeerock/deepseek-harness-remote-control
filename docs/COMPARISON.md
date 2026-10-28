# DSH RC compared with `liguobao/ds-harness-remote`

**Audience:** engineers deciding whether to deploy DSH RC, and reviewers who
want to know what the reference plugin does that this one does not.

**Method.** Claims about the reference implementation come from a read-only
clone of <https://github.com/liguobao/ds-harness-remote> at commit
`acca8d8f03f964f72f26731c87970012dffbe4a8` (2026-10-28), package version
`0.5.22` (`ref:package.json:3`). Line numbers refer to that commit. Claims about
DSH RC point at files in this repository. Nothing here is a benchmark: every
latency or throughput statement that has not been measured is marked `TBD`.

**Citation convention.** A `ref:` prefix means a path inside the reference clone
at that commit (`ref:packages/webrtc/src/…`). Unprefixed paths such as
`docs/PROTOCOL.md` or `apps/edge/src/main.ts` are files in this repository.
The prefix matters where both trees have a file with the same name, for example
`ref:packages/plugin/src/config.ts` versus our `packages/plugin/src/config.ts`.

## 1. Short version

The two systems solve the same user problem — reach a running DeepSeek Harness
desktop from another machine — with different bets.

| | `ds-harness-remote` | DSH RC |
| --- | --- | --- |
| Bet | Negotiate the best path per connection: LAN, P2P, TURN, then relay | One path, always: outbound TLS WebSocket, multiplexed |
| Client | Purpose-built clients (Android, VS Code, web, browser extension) plus the desktop plugin | The unmodified DSH web UI in any browser |
| Security boundary | End-to-end Noise channel through an untrusted relay | TLS to an edge you trust, which proxies plaintext HTTP/WS |
| Optimised for | Lowest latency when a direct path exists; many client platforms | Predictable connection setup on hostile networks; one code path |

Neither is strictly better. If you need an Android app, end-to-end encryption
against the relay operator, or the existing Codex/ACP integration, the reference
plugin is the right tool today. If you want the real desktop UI in a browser,
no UDP, no negotiation stall, and a relay small enough to audit and self-host,
DSH RC is the narrower and more predictable system.

## 2. Topology

**Reference.** Client and Host both connect outbound to a Remote Server that
handles accounts, presence, WebRTC signalling, TURN credentials and an opaque
WebSocket relay. The data plane is negotiated per connection; the server is in
the path for signalling and may also carry the data (`ref:docs/network.md:14-38`).

**DSH RC.** Browser → edge (HTTPS/WSS 443) → one multiplexed WSS → agent →
`127.0.0.1:<port>` DSH web server. The agent always dials out. There is no
signalling plane, no TURN, no UDP, and no inbound port
(`docs/ARCHITECTURE.md:39-47`, `docs/PROTOCOL.md:18-25`).

Consequences:

- The reference system's first connection includes ICE gathering, a Noise
  handshake over a control channel, and a transport selection step. DSH RC's
  first connection is TCP + TLS + one WebSocket upgrade + `HELLO`/`HELLO_ACK`
  (`docs/PROTOCOL.md:63-83`).
- The reference system can avoid the relay entirely when a direct path works.
  DSH RC always pays one extra hop. On the same LAN that is a real regression
  in path length; across a bad WAN it is usually not the dominant term.
- The reference server is a larger piece of software with accounts, OAuth,
  signalling and TURN credentials. The DSH RC edge is a reverse proxy with
  sessions, pairing, presence, routing and audit.

## 3. Transport order and connection cost

| Fact | Reference implementation | DSH RC |
| --- | --- | --- |
| Declared path order | `LAN -> P2P -> TURN -> Relay` (`ref:README.md:258`, `ref:docs/network.md:12`) | Single path: WSS relay (`docs/PROTOCOL.md:18-25`) |
| Code default order | `['lan', 'p2p', 'turn', 'relay']` (`ref:packages/webrtc/src/adaptive-transport.ts:71`) | N/A |
| WebRTC attempted first | Yes, unless `forceRelay` is set or no RTC backend exists (`ref:packages/webrtc/src/adaptive-transport.ts:78-80`) | No WebRTC at all (`docs/adr/0001-no-webrtc.md`) |
| Negotiation timeout | `DEFAULT_NEGOTIATE_TIMEOUT_MS = 8_000` (`ref:packages/webrtc/src/rtc-data-channel.ts:137`) | No negotiation step |
| Control handshake timeout | `handshakeTimeoutMs ?? 15_000` (`ref:packages/webrtc/src/adaptive-transport.ts:137`) | `HELLO` → `HELLO_ACK`, one round trip (`docs/PROTOCOL.md:63-83`) |
| Relay opt-in | `forceRelay` defaults to `false` (`ref:packages/plugin/src/config.ts:211`); `ref:packages/plugin/src/client-runtime.ts:228` maps it to `['relay']` | Relay is the only mode |
| UDP | STUN/TURN, so UDP is required for the preferred paths | None |
| Native dependency | `@roamhq/wrtc` 0.10.0 as an optional dependency (`ref:package.json:163-165`) | `ws` only (`package.json`) |

On a network that filters UDP — corporate Wi-Fi, many hotels, some CGNATs — the
reference implementation spends up to eight seconds before abandoning the
direct attempt, and up to fifteen seconds on the control handshake. That is the
behaviour users describe as "hangs". DSH RC does not attempt the path that
cannot work.

The trade-off is stated in ADR-0001: on a LAN, a direct WebRTC path would be
shorter. DSH RC accepts one extra hop in exchange for removing the
negotiation subsystem and its failure modes (`docs/adr/0001-no-webrtc.md:103-111`).

## 4. Client surface

| | Reference | DSH RC |
| --- | --- | --- |
| Desktop plugin | Yes (`ref:README.md:82`) | Yes — hosts the agent and opens the browser |
| Web | Hosted page at `https://dsh.r2049.cn` by default (`ref:README.md:165`) | Any browser pointed at the edge; the real DSH UI |
| Android | Native app, supported (`ref:README.md:84`, `ref:apps/android/`) | None. The browser is the client |
| iOS | TestFlight beta (`ref:README.md:85`) | None |
| VS Code | Client under `ref:apps/vscode/` | None |
| Browser extension | Chrome entry point (`ref:README.md:86`) | Not needed |
| dsh-TUI host | Supported (`ref:README.md:87`) | Not supported in v1; the agent targets the desktop web server |
| Guest sharing | Account membership only: every client signs in to the same account (`ref:README.md:162`, `ref:README.md:248`); no link-based guest invite/approval flow in the cited tree | Per-device invite link, single-use by default, owner **Approve/Deny** with label/IP/UA; guest session is device-scoped and permanent until revoked (`docs/SHARING.md`) |
| Separate client code | `ref:packages/client-core` (12 files, 5,133 lines at the cited commit) projects Harness RPC into each shell | No client code: the UI already exists |

This is the largest real difference. The reference implementation supports
platforms DSH RC does not, and it supports them with native UI rather than a
browser tab. DSH RC's counter-claim is narrower: the browser client cannot
drift from the desktop UI, because it *is* the desktop UI
(`docs/ARCHITECTURE.md:27-37`).

## 5. Reconnection and state

**Reference.** `ClientReconnect` retries carrier establishment with exponential
backoff and jitter, and explicitly does not retry RPC calls or outgoing user
actions (`ref:packages/plugin/src/client-reconnect.ts:3-45`). A reconnect re-runs
membership, the Noise handshake and transport selection, because the data plane
may land on a different path.

**DSH RC.** Full-jitter exponential backoff from 250 ms to 20 s
(`docs/PROTOCOL.md:163-172`). Presence is kept for 30 s so the browser shows a
reconnecting state rather than a hard offline page. In-flight streams are reset
as retryable. DSH RC never replays application messages; the DSH client
reconnects its own `/api/remote.mux` stream (`docs/PROTOCOL.md:170-172`).

Both systems make the same correct choice about mutation replay: neither
replays an action whose outcome is unknown. DSH RC relies on DSH's own client
for stream resumption instead of building a second recovery layer.

A true packet-loss blip remains **TBD**. The published loopback measurement for
a forced tunnel replacement (close 4004) is 49 ms, and tunnel connect after an
agent restart is 2.7 ms (root README, `tools/bench/results`). The design target
for a 100 % packet-loss blip is < 2 s median (`docs/ARCHITECTURE.md:157-166`),
not a claim.

## 6. Security model

| | Reference | DSH RC |
| --- | --- | --- |
| Relay sees payload | Ciphertext only; Noise IK between Client and Host (`ref:README.md:246`, `ref:docs/end-to-end-encryption.md:25`) | Plaintext HTTP/WS after TLS termination (`docs/ARCHITECTURE.md:59-64`, `docs/THREAT-MODEL.md`) |
| Relay sees metadata | Account/device ownership, presence, connection times, `connectionId`, approximate traffic size (`ref:docs/end-to-end-encryption.md:95-105`) | Device id, session, request paths/headers/status, sizes, timings |
| Host credential at relay | Device public key and membership; private keys stay local (`ref:docs/end-to-end-encryption.md:35-45`) | SHA-256 of the 32-byte device secret; the secret stays on the desktop |
| DSH launch token | Host-side concern; the client never receives Harness credentials | Exchanged by the agent for a loopback-bound cookie held in memory; never sent to the browser (`docs/ARCHITECTURE.md:113-117`) |
| Revocation | Removing a device revokes credentials, membership and active connections (`ref:README.md:276`) | `DEVICE_REVOKED`, terminal close 4003, agent stops retrying (`docs/PROTOCOL.md:179`, `packages/protocol/src/frames.ts:42`) |
| Trusted computing base | Client + Host + relay + signalling + TURN; native WebRTC addon | Edge + agent + protocol/mux packages; no native addon |

The reference implementation has the stronger cryptographic property: a
compromised relay cannot read session content. DSH RC deliberately gives that
up in exchange for serving the unmodified UI over plain HTTPS, and says so in
the architecture and threat model. Self-hosting the edge is the mitigation, and
it is a first-class deployment, not an afterthought
(`docs/ARCHITECTURE.md:61-64`).

This is the single most important difference for a security reviewer. If the
edge operator must be untrusted, DSH RC is the wrong design; use the
reference plugin or put the edge inside your own trust boundary.

## 7. Hosting and operations

| | Reference | DSH RC |
| --- | --- | --- |
| Default service | Hosted `https://dsh.r2049.cn` (`ref:README.md:165`) | Self-hosted edge; one Node process on a laptop or one VPS |
| Self-hosting | Minimal server under `ref:apps/server/` (14 files, 1,090 lines) | Edge binary/container; `docs/DEPLOY.md` |
| TLS | Terminated by the server; WebRTC paths carry Noise ciphertext | Terminated by the edge (Caddy or your proxy) |
| Persistence | Server-side account/device database | SQLite at the edge (`--data-dir`) |
| Multi-region | TURN nodes worldwide; relay region chosen by the server | One edge per region on the roadmap; no automatic selection in v1 (`docs/ARCHITECTURE.md:150-155`) |
| Ports | Outbound only on the Host; TURN needs UDP reachability | Outbound only on the agent; edge needs 443/tcp |

Operationally, DSH RC has fewer moving parts: one process, one SQLite file,
one outbound WebSocket per device. The reference system has more: accounts,
OAuth providers, signalling, TURN credentials, and a relay fleet if you do not
use the hosted service.

## 8. Measured and declared numbers

Everything in this table is either a constant in code or a measurement with a
stated source. Nothing is extrapolated.

| Number | Value | Source |
| --- | --- | --- |
| Reference WebRTC negotiation timeout | 8,000 ms | `ref:packages/webrtc/src/rtc-data-channel.ts:137` |
| Reference control handshake timeout | 15,000 ms | `ref:packages/webrtc/src/adaptive-transport.ts:137` |
| Reference path order | `lan, p2p, turn, relay` | `ref:packages/webrtc/src/adaptive-transport.ts:71` |
| Reference `forceRelay` default | `false` | `ref:packages/plugin/src/config.ts:211` |
| Reference package version | 0.5.22 | `ref:package.json:3` |
| Reference DSH baseline | `dsh-v0.2.1-rc.1` | `ref:README.md:299` |
| Reference TypeScript size | 447 files, 107,273 lines (75,161 non-test) | measured with `git ls-files` at the cited commit |
| DSH RC protocol + mux + shared | 1,870 lines across 10 files | measured with `find`/`wc -l`, `src/` only, at the time of writing |
| DSH RC edge + agent | 7,874 lines across 30 files | same measurement, after guest sharing landed |
| DSH RC plugin | 3,818 lines across 8 files | same measurement |
| DSH RC total, all `src/` | 13,562 lines across 48 files | same measurement, rounded down |
| DSH RC first paint through edge | 2.1 ms TTFB median (loopback edge, M4 Pro, 2026-10-28) | `tools/bench/results` |
| DSH RC reconnect after forced tunnel replacement | 49 ms (loopback; packet-loss blip still unmeasured) | `tools/bench/results` |
| DSH RC memory per tunnel | TBD; target < 24 MiB excluding payload buffers | `docs/ARCHITECTURE.md:163` |

The code-size comparison is not a quality claim. It is evidence for the
narrower surface: the reference plugin carries four client shells and a WebRTC
stack; DSH RC carries a frame codec, a multiplexer, and two Node processes.

## 9. What the reference plugin does better

This section is deliberately not balanced with a matching list of wins; the
wins are in §1-§7 and do not need repeating.

1. **Broader platform support.** Android is a shipped native app
   (`ref:README.md:84`, `ref:apps/android/`), iOS is in beta (`ref:README.md:85`), VS Code
   has a client (`ref:apps/vscode/`), and the dsh-TUI can act as a host
   (`ref:README.md:87`). DSH RC is desktop-only by design. A phone browser can
   use it, but there is no app, no offline shell, and no mobile-specific UI.
2. **End-to-end encryption against the relay.** Noise IK
   (`Noise_IK_25519_ChaChaPoly_SHA256`, `ref:docs/end-to-end-encryption.md:25`)
   means the relay operator cannot read session content. DSH RC's edge can,
   by construction. For a user who does not control the edge, this is a
   material difference, not a footnote.
3. **Mature Codex and ACP integration.** The reference plugin has documented
   Codex Remote and Agent ACP adapters (`ref:docs/codex-remote.md`,
   `ref:docs/acp-remote.md`, `ref:packages/plugin/src/acp/`,
   `ref:packages/plugin/src/codex/`). DSH RC serves the DSH UI and nothing else;
   it has no Codex or ACP surface.
4. **Multi-device and account semantics.** The reference server has accounts,
   membership, OAuth providers and multiple clients per host
   (`ref:README.md:165-170`). DSH RC has one owner, devices, pair codes and
   guest invites. Its guest model is deliberately link-plus-approval, not
   account membership: a guest needs no account, but has no identity beyond the
   owner's approval. It is a personal tool with sharing, not a team product.
5. **A hosted service that works today.** `https://dsh.r2049.cn` exists. DSH
   Link requires you to run an edge before the first connection.

## 10. What DSH RC does better

1. **No negotiation stall.** There is no ICE, no TURN, no transport selection,
   and no eight-second timeout on a UDP-blocked network
   (`docs/adr/0001-no-webrtc.md:49-60`).
2. **The client is the real UI.** No second client to keep in sync, no RPC
   projection, no feature lag when DSH ships
   (`docs/ARCHITECTURE.md:27-37`).
3. **One transport to supervise.** Heartbeats, backoff, flow control and
   priority live in one place (`docs/PROTOCOL.md:134-157`).
4. **Smaller trusted computing base.** No native WebRTC addon, no separate
   client, no signalling protocol. The edge is a reverse proxy with policy.
5. **Self-hosting is the default, not a fallback.** One container and one
   SQLite file; `docs/DEPLOY.md` has the three supported shapes.
6. **Flow control that protects the desktop.** 256 KiB per stream, 8 MiB per
   tunnel, credit returned on consumption, priority queues
   (`docs/PROTOCOL.md:134-149`, `packages/protocol/src/frames.ts:18-21`).

## 11. Choosing

- Choose **`ds-harness-remote`** if you need Android/iOS/VS Code, end-to-end
  encryption against the relay, Codex/ACP, or a hosted service you do not have
  to operate.
- Choose **DSH RC** if your client is a browser, your network blocks UDP, you
  want the desktop UI unchanged, and you are willing to run (or trust) one
  small edge.
- Do not choose DSH RC if the edge operator is outside your trust boundary
  and the session content is sensitive. That is the honest boundary of this
  design, and no amount of documentation changes it.

## 12. Open items

- Cross-system performance on the same network: **TBD**. DSH RC's loopback
  results are published in the root README (`tools/bench/results`); the
  reference plugin publishes no latency benchmark in the cited tree, and nobody
  has run both on identical hardware.
- The reference implementation's exact behaviour when a relay is reachable but
  slow (as opposed to unreachable) is **TBD**; the cited code shows timeouts,
  not a latency-based switch.
- Multi-region edge selection is on the DSH RC roadmap, not implemented
  (`docs/ARCHITECTURE.md:154`).