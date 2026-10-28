# DSH Link verification suite

Integration tests that run the **real edge process**, the **real agent** (through
its public `startAgent()` API) and a **real HTTP/WebSocket mock DSH**. Nothing in
the tunnel is stubbed: the mux, protocol and shared packages are exercised as
shipped, over real loopback sockets.

```
browser (undici/ws) ──▶ edge (child process) ──WSS tunnel──▶ agent (in-process) ──▶ mock DSH
```

## Run

```bash
# This suite only (28 tests, ~5 s wall on an M4 Pro; vitest runs the 4 files in parallel)
npx vitest run tests/integration

# Typecheck tests + bench without touching the app builds
npx tsc -p tests/tsconfig.json

# Whole repository (packages + apps + integration)
npx vitest run

# Benchmarks (JSON + markdown land in tools/bench/results/)
npx tsx tools/bench/bench.ts --quick
npx tsx tools/bench/bench.ts

# Manual smoke against a real DeepSeek Harness web profile (not hermetic, not in CI)
DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js npx tsx tests/smoke/real-dsh.ts
```

Requirements: Node >= 22.13 (the edge uses `node:sqlite`), deps installed
(`npm ci`), and the workspace packages built at least once (`npm run build`) so
the spawned edge can resolve `@dsh-link/*` dist files. The bench and integration
harness fail with `apps/edge/src/main.ts …` / `apps/agent/src/index.ts …` in the
message if a piece is missing.

## Files

| Path | Purpose |
| --- | --- |
| `fixtures/mock-dsh.ts` | Real DSH face: token exchange (`GET /?token=` → 303 + `Set-Cookie`), cookie-gated index/JSON, chunked streaming, slow, abort-watch, redirect, Set-Cookie/HSTS leak probe, POST echo, WS echo at `/api/remote.mux`. Records every request (headers, body, completion, abort) and WS connection. |
| `harness/link.ts` | Spawns the edge CLI on 127.0.0.1:0, performs owner setup, registers/pairs/approves/revokes devices, starts/restarts the agent in-process, provides a cookie jar, raw HTTP (no URL normalisation), polling helpers and WS helpers. |
| `integration/happy-path.test.ts` | HTTP + WS correctness through the tunnel. |
| `integration/auth.test.ts` | Session, CSRF/Origin, pairing paths, pending/revoked device, revocation. |
| `integration/faults.test.ts` | Abort propagation, offline presence/grace/reconnect, latency under bulk load. |
| `integration/agent-lifecycle.test.ts` | Singleton state-dir lock, identity file permissions. |
| `smoke/real-dsh.ts` | Boots an isolated real DSH web profile and loads its index + main JS bundle + `/api/remote.mux` through edge → agent. |

## Coverage matrix

| Requirement | Test | What is asserted |
| --- | --- | --- |
| Index through `/d/<id>/` | happy-path "serves the DSH index HTML" | 200, `text/html`, mock body, `<base href="./">` |
| `/d/<id>` → `/d/<id>/` | happy-path "redirects" | 3xx with trailing-slash Location |
| JSON API | happy-path "proxies the JSON API" | 200 + upstream JSON |
| Chunked streaming | happy-path "streams a 1 MiB+ chunked response" | no invented `Content-Length`, exact 1 MiB+123 bytes |
| 8 MiB integrity | happy-path "preserves an 8 MiB response" | byte-for-byte pattern match |
| Memory sanity | happy-path "keeps memory bounded while streaming 32 MiB" | full bytes received, RSS growth < 128 MiB |
| Request body (client→DSH) | happy-path "streams a 1 MiB request body" | upstream echo length matches |
| WebSocket relay | happy-path "relays a WebSocket echo" | 101/open, subprotocol echoed, text + binary echo |
| Set-Cookie/HSTS hygiene | happy-path "does not leak upstream Set-Cookie" | proxy response has no `Set-Cookie`/HSTS |
| Request header hygiene | happy-path "strips browser Cookie/Authorization/forwarding" | upstream sees DSH cookie only, no `Authorization`, no XFF/X-Real-IP, loopback `Host` |
| Location rewrite | happy-path "rewrites absolute loopback Location" | no upstream port, public `/d/<id>/...` path, follow works |
| Path safety | happy-path "rejects path traversal and authority-looking paths" | `..`, `//host`, absolute URL, encoded traversal: 4xx and no upstream route hit |
| No session / forged session | auth first two tests | 401 HTML |
| Unknown device | auth "unknown device id" | 404 |
| Pending device | auth "registered but pending" | 403 |
| Pairing auth | auth "anonymous without password", "wrong password" | 401, device stays `pending` |
| Pairing by password | auth "anonymous browser with owner password" | 303, device-bound session, approved, `/d/` → 503 (offline but authorised) |
| Wrong pair code | auth "wrong pair code as owner" | 403 |
| CSRF/Origin | auth "cross-site Origin" | 403, code not consumed, device still pending |
| Revocation | auth "after the device is revoked" | owner gets 403; agent state `error` with 4003/revoked; device-bound session invalidated |
| Agent singleton lock | agent-lifecycle "rejects a second agent" | second handle `error` naming the holder PID, live tunnel still 200, rejected stop does not release the owner's lock |
| Identity permissions | agent-lifecycle "persists the device identity" | `device.json` 0600, state dir 0700 |
| Offline + presence grace | faults "503 + Retry-After, then recovers" | 503, `Retry-After: 5`, reconnecting copy, restart with same stateDir → online → 200 |
| Client abort | faults "propagates a browser abort" | mock records aborted request, not completed |
| Priority/responsiveness | faults "keeps small /api requests responsive" | 4 × 32 MiB bulk in flight, 5 small requests, max latency < 750 ms (measured 2–5 ms) |
| Benchmarks | `tools/bench/bench.ts` | connect, TTFB, 1/16 MiB throughput, 200 sequential, 50 concurrent, reconnect after 4004 tunnel replacement, interactive under 4 × 16 MiB bulk |
| Real DSH | `tests/smoke/real-dsh.ts` | index 200 + exact byte count, 941 KB module bundle hash-equal through edge, `/api/remote.mux` upgrade OPEN |

## Measured results

Machine: **Apple M4 Pro, 24 GiB, macOS darwin/arm64** · Node **v24.18.0** ·
measured **2026-10-28 ~14:37 MYT** (loopback, in-process agent, edge child
process — not a WAN measurement).

| Metric | Value |
| --- | ---: |
| TTFB through edge (median / p95) | 2.11 ms / 2.93 ms |
| Throughput 1 MiB / 16 MiB | 156.9 / 298.5 MiB/s |
| 200 sequential requests | 395.7 ms wall (p50 1.96 ms, p95 2.28 ms, 505 req/s) |
| 50 concurrent requests | 16.6 ms wall (p95 14.2 ms) |
| Interactive p95 under 4 × 16 MiB bulk | 3.13 ms |
| Reconnect after forced tunnel replacement (4004) | 49.3 ms (full-jitter 250 ms base) |
| Tunnel connect after agent restart (approved identity) | 2.70 ms |
| Real DSH index / bundle through edge | 37,907 B (identical) / 941,436 B (SHA-256 equal) |
| Real DSH `/api/remote.mux` upgrade | OPEN (no server-initiated frame in 2 s) |

Real-DSH smoke: DSH boot 663 ms, agent tunnel online 2.01 s (dominated by the
edge's 2 s approval poll). Run `tests/smoke/real-dsh.ts` for current numbers.

## Determinism rules

- Every listener binds `127.0.0.1:0`; ports are read back from the OS/handshake.
- Every stack gets a fresh `mkdtemp` directory (edge DB + agent identity), removed
  in `afterAll`.
- Waits poll with deadlines (5–20 s); the only fixed sleep is bounded 5 ms
  inside the bench's transport-backpressure check, never in assertions.
- No external network, no browser, no Playwright in CI.
- The harness kills the edge with SIGTERM→SIGKILL and the agent `stop()` is
  idempotent, so vitest exits with no open handles.

## Known gaps

- **TLS/WSS and `--trust-proxy`** are not covered end-to-end; the suite runs plain
  HTTP on loopback with `--insecure`. TLS termination is exercised only by curl
  smoke-style manual checks, not in CI.
- **Pair-code expiry** (10 min) is not tested end-to-end; the edge stores an
  expiry but the clock is not injectable from the public surface.
- **Rate limiting** (setup/pair/register) is covered by `apps/edge/tests`, not
  here; the integration suite deliberately stays below the limits.
- **Heartbeat/idle timeout** (15 s / 45 s) would exceed the 60 s budget; covered
  by mux/edge unit tests with injected clocks.
- **Scheduler fairness ratio (4:2:1)** is a mux unit-level property. The e2e test
  asserts interactive responsiveness under bulk load (2–5 ms observed), not the
  exact ratio.
- **Memory ceiling** is a coarse process-RSS sanity check, not a per-tunnel
  measurement of the edge child process.
- **Real DSH smoke** requires a local DSH install and is manual/optional; CI uses
  the mock only.
- CI runs Node 22 and 24 on Ubuntu; local numbers above are macOS/arm64 and are
  not comparable to CI runner numbers.
