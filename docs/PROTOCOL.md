# DSH Link Tunnel Protocol v1

Status: **normative for this repository**. Every number here is a constant in
`packages/protocol/src/frames.ts`; both peers import that file, so drift is a
compile error rather than a field bug.

## 1. Why this protocol exists

DSH Link moves *whole HTTP requests and WebSocket sessions* — not DSH RPC
calls — between a public edge and a desktop agent. The edge never understands
Harness semantics. That is the central design rule: **one transport, opaque
payloads, no second client**.

```
browser ──HTTPS/WSS──▶ edge ──one multiplexed WSS──▶ agent ──HTTP/WS──▶ DSH
```

## 2. Transport

- One WebSocket (RFC 6455) per device: `wss://<edge>/v1/tunnel`.
- `permessage-deflate` disabled. Compression is wasteful for already-compressed
  assets and adds a serialization point in front of interactive frames.
- `maxPayload` 1 MiB; the protocol never emits a frame above 64 KiB.
- The agent always dials out. No inbound port, no port forwarding, no UDP.
- Binary messages only. Text frames are a protocol error (`PROTOCOL_TEXT_FRAME`).

## 3. Frame layout

```
 0        1        2        3        4        5
 +--------+-----------------------------------+----------------+
 | type   |            streamId (u32 BE)      |     payload    |
 +--------+-----------------------------------+----------------+
```

- `type` — one byte, see §4.
- `streamId` — unsigned 32-bit big-endian. `0` is reserved for connection
  frames. Stream ids are allocated by the **edge** from `1` upward; the agent
  never allocates an id. Ids are never reused within one tunnel.
- `payload` — type-specific, at most `MAX_FRAME_BYTES - 5` bytes.

JSON payloads are UTF-8, schema-checked on receipt, and rejected with
`PROTOCOL_BAD_FRAME` on any unknown field type or missing required field.

## 4. Frame types

| id | name | direction | stream | payload |
| --- | --- | --- | --- | --- |
| 1 | `HELLO` | agent → edge | 0 | JSON `Hello` |
| 2 | `HELLO_ACK` | edge → agent | 0 | JSON `HelloAck` |
| 3 | `PING` | both | 0 | 8-byte BE epoch millis |
| 4 | `PONG` | both | 0 | echo of the PING bytes |
| 5 | `OPEN` | edge → agent | n | JSON `Open` |
| 6 | `HEAD` | agent → edge | n | JSON `Head` |
| 7 | `DATA` | both | n | raw bytes, ≤ 32 KiB |
| 8 | `END` | both | n | JSON `End` (may be empty) |
| 9 | `RESET` | both | n | JSON `Reset` |
| 10 | `WINDOW` | both | n | u32 BE credit |
| 11 | `WS_FRAME` | both | n | 1-byte opcode + payload |
| 12 | `GOAWAY` | both | 0 | JSON `GoAway` |
| 13 | `OPEN_ACK` | agent → edge | n | JSON `OpenAck` |

### 4.1 Handshake

The handshake happens **before** the multiplexer is attached: `HELLO` and
`HELLO_ACK` are single binary frames on the raw WebSocket, not mux frames.
Only after `HELLO_ACK.ok` does either side construct a `Mux` over the socket
(buffered bytes are replayed into it, so no frame is lost in between).

1. Agent opens the socket and immediately sends `HELLO`:
   ```json
   { "protocol": 1, "deviceId": "dev_…", "token": "<device secret>",
     "agentVersion": "0.1.0", "platform": "darwin-arm64",
     "maxFrameBytes": 65536 }
   ```
   The token is also sent in the `Authorization: Bearer` header of the upgrade
   request. The body copy exists so a proxy that strips headers still fails
   closed with a readable error.
2. Edge validates the device, then replies `HELLO_ACK`:
   ```json
   { "ok": true, "protocol": 1, "edgeId": "edge_…", "serverTime": 1793,
     "heartbeatMs": 15000, "idleTimeoutMs": 45000,
     "initialStreamWindow": 262144, "initialConnectionWindow": 8388608,
     "maxFrameBytes": 65536 }
   ```
   On failure: `{"ok":false,"code":"DEVICE_REVOKED","message":"…"}` followed by
   close code `4003`. The agent must not retry non-retryable codes.
3. Only after `HELLO_ACK.ok` may the edge send `OPEN`.

### 4.2 HTTP streams

```
edge                                   agent
 │ OPEN {kind:"http", method, path, headers, priority}
 │ ─────────────────────────────────────▶
 │                                        http.request() to 127.0.0.1:port
 │ DATA (request body) …  END             │
 │ ─────────────────────────────────────▶
 │                          HEAD {status,statusText,headers}
 │ ◀─────────────────────────────────────
 │ ◀──────────────────────── DATA … END   (response body)
```

- `OPEN.path` is origin-form (`/assets/app.js?v=2`) with the public `/d/:id`
  prefix already removed. The agent never sees the edge hostname.
- The agent connects to a **fixed loopback target**; `path` is not a URL and
  cannot escape it (`..`, `//host`, absolute URLs are rejected).
- If the upstream cannot be reached: `OPEN_ACK {ok:false,status:502,…}` then
  `RESET`. If the request was already accepted: `HEAD 502` + `END`.
- The response is streamed. `HEAD` carries the status and headers exactly once;
  `END` terminates the body. A `HEAD` with `bodyless:true` (204/304/HEAD
  requests) is followed by `END` with no `DATA`.
- Client abort → `RESET {code:"CLIENT_ABORTED",retryable:true}`. The agent must
  destroy the upstream request and stop sending.

### 4.3 WebSocket streams

```
browser ──upgrade──▶ edge ──OPEN{kind:"ws"}──▶ agent ──new WebSocket──▶ DSH
                     edge holds the socket open while the agent connects
                     ◀── OPEN_ACK {ok:true, protocol?} ──
browser ◀── 101 ───── edge
                     ◀── WS_FRAME ──▶ (opcode 1/2/8/9/10)
```

- The edge defers completing the browser upgrade until `OPEN_ACK.ok`.
  Timeout `WS_OPEN_TIMEOUT_MS` (10 s) → HTTP 504 on the upgrade socket.
- `WS_FRAME.opcode`: `1` text, `2` binary, `8` close, `9` ping, `10` pong.
  Payload for `8` is 2-byte BE close code + UTF-8 reason.
- The edge answers protocol-level pings from the browser itself; `9`/`10` are
  only relayed when the browser sends application-level frames (it cannot —
  browsers do not expose ping), so relayed pings come from DSH only.
- Either side closing sends `WS_FRAME opcode 8` then `END`.
- A WS stream carries no flow-control credit: WebSocket is already
  message-oriented and is latency-critical. The edge applies a byte budget and
  resets a stream that exceeds it (`WS_STREAM_BUDGET`), a guard against a
  misbehaving peer, not a normal path.

### 4.4 Flow control

Credit-based, per stream and per connection, with consumption-based updates:

- `INITIAL_STREAM_WINDOW = 256 KiB`, `INITIAL_CONNECTION_WINDOW = 8 MiB`.
- A sender may transmit `DATA` only while it holds credit. Credit is consumed
  by payload bytes, not frame overhead.
- A receiver grants credit after the bytes are **consumed by its sink** (written
  and drained to the socket, or read from the queue), not on arrival. This is
  what stops a fast WAN edge from buffering an entire file in the agent.
- `WINDOW` carries the delta (u32). A receiver sends an update once ≥ 50 % of
  the window has been consumed, or on stream end.
- A sender that still has bytes when credit is zero parks the stream. No
  polling, no timer.
- The connection window prevents one stream from starving the tunnel; stream
  windows prevent one request from starving another.

### 4.5 Priority

`OPEN.priority` is `high` (documents, `/api/*`, WebSocket), `normal` (other
requests), or `low` (responses larger than `LARGE_RESPONSE_BYTES` or paths the
edge classifies as assets). The sender keeps three queues and serves them
roughly 4:2:1 (high:normal:low), always draining control frames first. A 2 GiB
file download therefore cannot add latency to a keystroke.

### 4.6 Heartbeat and failure

- Both peers send `PING` every `heartbeatMs` (15 s) when idle.
- A peer that receives no frame for `idleTimeoutMs` (45 s) closes with `4000`.
- The agent reconnects with full-jitter exponential backoff: base 250 ms, cap
  20 s, multiplier 2. `DEVICE_REVOKED`, `PROTOCOL_MISMATCH` and `AUTH_FAILED`
  are terminal.
- On reconnect the agent keeps its device identity; every in-flight stream is
  reset with `retryable:true`. The edge keeps device presence for
  `PRESENCE_GRACE_MS` (30 s) so the browser sees a reconnecting state instead
  of a hard offline page.
- The browser-side DSH client already reconnects its own `remote.mux` stream;
  DSH Link therefore does **not** replay application messages. Replaying
  mutations whose outcome is unknown is how remote tools corrupt state.

## 5. Error codes

| code | retryable | meaning |
| --- | --- | --- |
| `AUTH_FAILED` | no | unknown device or bad secret |
| `DEVICE_REVOKED` | no | owner revoked the device |
| `DEVICE_PENDING` | yes (after approval) | device not yet approved |
| `PROTOCOL_MISMATCH` | no | unsupported version |
| `PROTOCOL_BAD_FRAME` | no | malformed frame |
| `PROTOCOL_TEXT_FRAME` | no | text frame received |
| `TUNNEL_BUSY` | yes | a newer tunnel replaced this one |
| `UPSTREAM_UNREACHABLE` | yes | DSH web server not listening |
| `UPSTREAM_TIMEOUT` | yes | DSH did not answer in time |
| `CLIENT_ABORTED` | yes | browser went away |
| `STREAM_LIMIT` | yes | too many concurrent streams |
| `PAYLOAD_TOO_LARGE` | no | request body over the configured cap |

## 6. What is deliberately absent

- **No application message replay.** See §4.6.
- **No RPC understanding.** The edge cannot construct, inspect, or mutate a
  Harness message; it only frames bytes.
- **No WebRTC.** See `docs/adr/0001-no-webrtc.md` for the decision record.
- **No mobile client.** The transport is browser-native; a future native client
  would speak the same HTTPS surface, not a new protocol.