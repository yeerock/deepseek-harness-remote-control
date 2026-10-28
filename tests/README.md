# DSH RC verification suite

Integration tests that run the **real edge process**, the **real agent** (through
its public `startAgent()` API) and a **real HTTP/WebSocket mock DSH**. Nothing in
the tunnel is stubbed: the mux, protocol and shared packages are exercised as
shipped, over real loopback sockets.

```
browser (undici/ws) ──▶ edge (child process) ──WSS tunnel──▶ agent (in-process) ──▶ mock DSH
```

## Run

```bash
# Tunnel suite only (28 tests, ~5 s wall on an M4 Pro; vitest runs the 4 files in parallel)
npx vitest run tests/integration

# Sharing suite (22 tests; ~64 s wall because one test proves the absence of an
# idle timeout by waiting 61 s; the other three files run in parallel with it)
npx vitest run tests/sharing

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
the spawned edge can resolve `@dsh-rc/*` dist files. The bench and integration
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
| `sharing/sharing-api.test.ts` | Sharing toggle, invite TTL/uses/one-time token/hash at rest/deletion. |
| `sharing/guest-flow.test.ts` | Claim → approval → guest cookie, admin isolation, disconnect, revoke one/all, sharing off, device revoke, WS across agent restart. |
| `sharing/multiple-guests.test.ts` | Concurrent claims/approvals and simultaneous guest HTTP + WS with no 409. |
| `sharing/permanence.test.ts` | `expiresAt: null`, 10-year cookie, edge-restart survival, >60 s idle survival. |
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

## Sharing coverage matrix (`tests/sharing`, docs/SHARING.md v0.2)

| Requirement | Test | What is asserted |
| --- | --- | --- |
| Toggle + public URL | sharing-api "off by default and toggles" | GET false by default, PUT `{enabled:true}` → 200, `publicUrl` matches edge origin |
| Invite not allowed while off | sharing-api "refuses invite creation" | 409 `SHARING_DISABLED` |
| Never-expiring invite | sharing-api "never-expiring invite" | `ttlSeconds:0` → `expiresAt:0`, DB `expires_at=0` |
| Token shown once, hashed at rest | sharing-api "never-expiring invite" | 43-char base64url token; sharing JSON excludes token + hash; DB `token_hash = sha256hex(token)` |
| Time-limited / multi-use | sharing-api "time-limited invite", "honours maxUses" | `expiresAt≈now+ttl`; two claims accepted, third → 410; `uses=2` |
| Validation | sharing-api "validates ttlSeconds, maxUses and label" | ttl ∉ {0,60..86400}, maxUses ∉ 1..10, label>64 → 400 |
| Invite delete | sharing-api "DELETE invite" | summary hides it, DB `revoked_at` set, invite page 410 |
| Claim → pending → approve | guest-flow "claim -> pending -> approve" | claim JSON `{status:"pending",approvalId,deviceId}`, `dshrc_claim`; pending row label/IP; approve `{ok:true,sessionId}`; status JSON approved + `dshrc_guest`; `/d/` 200; claim cookie cleared |
| Guest cookie permanence | permanence "expiresAt null" | `activeGuests[].expiresAt=null`, `Max-Age=315360000`, DB `sessions.expires_at IS NULL`, `approval_id` set |
| Admin isolation | guest-flow "limits a guest to its own /d/ mount" | `/`, `/setup`, `/pair`, `/login`, `/v1/*`, `/logout`, approve/revoke → 403; other device `/d/` → 403; own `/d/` + `/i/session` → 200 |
| Explicit disconnect | guest-flow "POST /i/session/disconnect" | 303 `/`, guest cookie cleared, next `/d/` 401, WS closes 1008 |
| Revoke one | guest-flow "revoking one guest" | A 401 + WS 1008; B 200 + WS still echoes |
| Revoke all | guest-flow "DELETE /v1/devices/me/guests" | `{revoked≥2}`, both 401, both WS 1008, `activeGuests=[]` |
| Sharing off | guest-flow "disabling sharing" | guests/invites/pending cleared, guest 401, WS 1008, invite page 410; re-enable does not resurrect |
| Device revoke | guest-flow "device revoke invalidates" | guest 401/403, WS closes promptly, agent terminal |
| Multiple guests, no 409 | multiple-guests "two guests concurrently", "third guest", "interleaved WS" | concurrent claims/approvals both 200, distinct session ids, both `/d/` 200, both WS echo, `activeGuests=2→3`; no `GUEST_BUSY` |
| Edge restart | permanence "survives an edge restart" | same data dir + port, guest cookie still valid, page 200 after agent reconnect, session still active |
| No idle timeout | permanence "no idle timeout" | after 61 s of silence, `/d/` still 200 and session still listed |
| WS across tunnel restart | guest-flow "agent tunnel restart" | session unchanged, no new approval, WS works before and after agent restart |

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
- Waits poll with deadlines (5–20 s). The only fixed sleeps are the intentional
  61 s idle-period test in `sharing/permanence.test.ts` (it must prove the
  absence of an idle timeout) and a bounded 5 ms transport-backpressure sleep in
  the bench; assertions never sleep.
- No external network, no browser, no Playwright in CI.
- The harness kills the edge with SIGTERM→SIGKILL and the agent `stop()` is
  idempotent, so vitest exits with no open handles.

## Contract notes

- `docs/SHARING.md` v0.2 supersedes the earlier task-6 draft wording that
  mentioned a single-controller `409 GUEST_BUSY`. The implementation and these
  tests follow the normative document: **multiple simultaneous guests, no
  controller lock, no 409**.
- Approval accepts an optional `ttlSeconds` but mints a no-expiry guest session
  (`expires_at NULL`) per SHARING.md §6.1; the tests assert permanence.
- Guest cookies are `Secure` only when the edge's public URL is https (loopback
  test runs are plain http, matching the existing owner-session behaviour).

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
- **Invite/claim expiry** (minimum 60 s) is not waited out end-to-end; expiry
  paths are covered by `apps/edge/tests/sharing.test.ts`. The 61 s guest-idle
  test does not consume an invite TTL.
- **Sharing rate limits** (20 invites/min, 60 approvals/min, 20 claims/5 min)
  are covered by edge unit tests; the integration suite stays below them.
- **Plugin share panel** (toggle, QR, approvals UI) is out of scope for this
  suite and covered by `packages/plugin/tests/sharing.test.ts`.
- **Real DSH smoke** requires a local DSH install and is manual/optional; CI uses
  the mock only.
- CI runs Node 22 and 24 on Ubuntu; local numbers above are macOS/arm64 and are
  not comparable to CI runner numbers.
