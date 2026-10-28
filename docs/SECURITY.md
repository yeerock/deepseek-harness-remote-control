# Security policy

**Audience:** security researchers, reviewers and operators who need the
security design in one place.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting:
`https://github.com/<your-org>/dsh-link/security/advisories/new`. If that is not
available, open a minimal issue asking for a private channel and do not include
exploit details.

Include: affected component (`edge`, `agent`, `protocol`, `mux`, `shared`,
`plugin`), version or commit, reproduction steps, impact, and whether the issue
requires a malicious edge, a paired browser, local access, or only the network.

**Do not** test against someone else's edge, open a public issue with a working
exploit, or exfiltrate data that is not yours.

### Response targets

| Stage | Target |
| --- | --- |
| Acknowledgement | 3 business days |
| Initial triage and severity | 7 business days |
| Fix or mitigation for critical/high | 30 days |
| Public disclosure | coordinated, after a fix ships |

These are targets, not contractual SLAs. There is no bug bounty in v1.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.1.x` (current development line) | Yes, best effort |
| Anything older | No |

Security fixes land on the current line. There are no backports yet.

## Scope

**In scope**

- The tunnel protocol (`packages/protocol`) and multiplexer (`packages/mux`).
- The edge (`apps/edge`): authentication, pairing, sessions, proxy, SQLite,
  audit, rate limits.
- The agent (`apps/agent`): token exchange, cookie handling, upstream proxy,
  reconnect.
- The plugin (`packages/plugin`) and its host/client boundary.
- Deployment guidance that would cause a vulnerability if followed
  (`docs/DEPLOY.md`).

**Out of scope**

- DeepSeek Harness itself and its web UI. Report those upstream.
- A compromised edge reading proxied plaintext. This is the documented design
  (`docs/THREAT-MODEL.md` §7.1); it is not a vulnerability.
- A compromised desktop or a same-user local attacker
  (`docs/THREAT-MODEL.md` §7.9).
- Social engineering, physical access, or a user who hands over an owner
  session, the owner password, or a device secret.
- Denial of service by saturating the operator's uplink, or by an authenticated
  owner using the product as intended.
- `--insecure` deployments. The flag is documented as unsafe on a public
  network; a finding that requires it is a documentation issue at most.

## Security design summary

### Topology and trust

```
browser ──TLS──▶ edge ──TLS + device secret──▶ agent ──loopback──▶ DSH
```

The edge terminates TLS and is trusted with plaintext. There is no
application-layer end-to-end encryption in v1. The agent only dials out; there
are no inbound ports and no UDP.

### Secrets and cryptography

| Item | Construction | Storage |
| --- | --- | --- |
| Device secret | 32 random bytes, issued once at registration | Agent `device.json` (0600); edge stores SHA-256 only; `agent.lock` (0600) holds only pid/host |
| Device id | `dev_` + 20 base32 chars (100 bits) | Edge SQLite |
| Owner session | HMAC-SHA256 signed payload with expiry | Browser cookie `dshlink_session`, HttpOnly, SameSite=Lax, Secure on HTTPS, 30 days |
| Session HMAC key | Generated on first boot | Edge SQLite settings |
| Pair code | 8 chars from a 31-char alphabet, single use, 10-minute TTL | Edge stores `SHA-256("pair:" + code)` |
| Setup code | Generated 12 chars (or operator-supplied), single use, 24-hour TTL, rotated on each start until setup completes | Edge stores SHA-256 |
| DSH launch token | One-time DSH-issued token, exchanged for a loopback cookie | Agent memory; `{stateDir}/upstream.json` (0600) when plugin-launched |
| Transport | TLS for browser↔edge and edge↔agent | — |

Comparison is constant time (`packages/shared/src/ids.ts:44-49`). Randomness
comes from `node:crypto.randomBytes`.

### Authentication and authorization

- Owner: setup code → session cookie. Optional password for later login.
- Device: secret in `Authorization: Bearer` **and** `HELLO.token`, so a proxy
  that strips headers fails closed (`docs/PROTOCOL.md:65-73`).
- Browser: owner session or owner password + single-use pair code → device
  access (a device-scoped session when authenticated by password). The code
  alone is not sufficient.
- There is no anonymous access to `/d/:deviceId/`, `/v1/devices/*`, or the
  dashboard. `/healthz` and `/v1/edge` are intentionally public and must not
  contain secrets.

### Request policy

The edge and agent share one routing module. It enforces:

- Device ids match `^dev_[a-z0-9]{16,64}$` (`packages/protocol/src/routing.ts:15-20`).
- Paths are origin-form, ≤ 8192 bytes, no control characters, no `//`, no `\`,
  no absolute URL, no `..` segment (`routing.ts:45-54`). The agent re-validates.
- Request headers strip `cookie`, `authorization`, `origin`, `referer`,
  `host`, `forwarded`, `x-forwarded-*`, `cf-*`, `true-client-ip`, hop-by-hop and
  `sec-fetch-*`; the agent attaches its own DSH cookie (`routing.ts:57-83`).
- Response headers strip `set-cookie`, HSTS, `content-security-policy-report-only`
  and hop-by-hop headers (`routing.ts:86-98`).
- Header values with control characters are dropped (`routing.ts:109-139`).
- Loopback `Location` values are rewritten under `/d/<device>/`
  (`routing.ts:163-171`).

### Resource limits

64 KiB frames, 32 KiB data chunks, 256 KiB per-stream window, 8 MiB per-tunnel
window, 256 concurrent streams, 2048 queued frames before the tunnel fails,
64 MiB per-WebSocket-stream budget, 15 s heartbeat, 45 s idle timeout. See
`packages/protocol/src/frames.ts` and `packages/mux/src/index.ts`.

### Logging

JSON lines with a central redaction list for `token`, `authorization`, `cookie`,
`secret`, `password`, `devicesecret`, `dshtoken`, `set-cookie`
(`packages/shared/src/logger.ts:5`, `logger.ts:16-31`). The status file written
by the agent contains state and ids, never a token or cookie.

## Known limitations

These are documented, accepted, and not vulnerabilities by themselves. A report
that demonstrates a *new* impact from one of them is still welcome.

1. **The edge reads proxied plaintext.** By design.
2. **No end-to-end encryption.** TLS protects the wire, not the relay.
3. **The launch token is readable by same-user processes** through
   `{stateDir}/upstream.json` (0600) or the agent's memory. The plugin keeps it
   out of argv, logs and status files; a manual `--dsh-url` run does not.
4. **The pair-code space is ~39.6 bits** because of modulo mapping over a
   31-character alphabet. Single use, a 10-minute TTL, rate limiting and the
   owner credential requirement bound the window; it is not a password.
5. **Percent-encoded `..` is not normalized** by the path validator. Impact is
   bounded to the DSH origin because the upstream authority is fixed
   (`docs/THREAT-MODEL.md` §7.5).
6. **Owner password reset requires deleting the owner row.** Documented in
   `docs/OPERATIONS.md` §1.2.
7. **No provenance attestation or image signing yet.** TBD before a public
   release.
8. **Audit rows are mutable by the edge operator.** Ship logs off-host if that
   matters.

## Hardening checklist for operators

- Terminate TLS at a proxy you control; never expose the edge's plain port.
- Set `--public-url` to the exact HTTPS origin and enable `--trust-proxy` only
  behind that proxy.
- Never use `--insecure` outside loopback.
- Keep the data directory `0700` (as created) and owned by the service user.
- Set an owner password; otherwise recovery means deleting the owner.
- Back up SQLite daily and test a restore.
- Revoke devices you no longer use; rotate secrets quarterly.
- Ship audit/log lines to an append-only sink if they are evidence.
- Pin container images by digest; install with `npm ci`.

## Safe harbor

We will not pursue legal action against researchers who: test only their own
deployments, avoid privacy violations and data destruction, report promptly,
and give us reasonable time to fix before disclosure. If in doubt, ask first
through the private advisory.

## Related documents

- `docs/THREAT-MODEL.md` — assets, actors, STRIDE, residual risk.
- `docs/ARCHITECTURE.md` — topology and authentication model.
- `docs/PROTOCOL.md` — wire format and error codes.
- `docs/DEPLOY.md` — secure deployment shapes.
- `docs/OPERATIONS.md` — revocation, rotation, audit.