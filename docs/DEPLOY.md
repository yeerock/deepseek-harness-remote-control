# DSH RC — deployment guide

**Audience:** the person who will run the edge and connect a desktop to it.

Three supported shapes:

1. **Laptop demo** — edge on `127.0.0.1`, plain HTTP, one desktop.
2. **Single VPS with Docker + Caddy** — automatic TLS, one region. The default
   production shape.
3. **Cloudflare in front** — Cloudflare terminates client TLS, origin
   certificate to Caddy. Adds a second party that sees plaintext; read §5.4.

Everything below assumes the repository is checked out and Node.js ≥ 22.13 is
installed (`package.json` `engines`).

> **Flag names are authoritative in code, not in this document.** The edge and
> agent CLIs are new; if `--help` disagrees with a table here, the code wins and
> this file has a bug.

## 0. Choosing a region (read this first)

The edge sits in the path of every keystroke, so its location is a product
decision, not an ops detail.

- **If both ends are in one country:** put the edge there. A 5 ms edge beats any
  amount of protocol tuning.
- **If the desktop is in mainland China and you work from Europe or North
  America:** do **not** put the edge inside mainland China. That is the failure
  mode this project exists to remove — the browser leg becomes transcontinental
  and every interactive request pays it. Prefer Hong Kong, Singapore, Tokyo or
  Seoul; measure both legs before settling:
  ```bash
  # from the desktop
  ping -c 20 edge.example.com
  # from the browser machine
  ping -c 20 edge.example.com
  ```
  A balanced choice (e.g. Singapore for China ↔ Europe) usually feels better
  than optimising either leg alone, because model output is streamed while you
  type.
- **If you work from the same continent as the desktop:** a single edge in that
  continent is enough. One edge serves one desktop; multi-region routing is
  roadmap (`docs/ARCHITECTURE.md` §8), not a v1 feature.
- **Legal/policy:** you are operating a relay that carries your own traffic.
  Check the hosting jurisdiction you are comfortable with; self-hosting is the
  point.

The numbers in the README are loopback measurements of tunnel overhead. Add the
RTT of both legs to estimate the interactive floor; no protocol can beat
physics, but DSH RC pays it once, not once per WebRTC fallback.

## 1. Build once

```bash
git clone https://github.com/<your-org>/dsh-rc.git
cd dsh-rc
npm ci
npm run build
```

`npm run build` runs `tsc -b` for every workspace package. The edge entry point
is `apps/edge/dist/main.js`; the agent entry point is
`apps/agent/dist/main.js`.

For development you can skip the build and run from source with
`npm run dev:edge` / `npm run dev:agent` (they use `tsx`).

## 2. Configuration reference

Precedence for both binaries: **CLI flag > environment variable > default**.
Note that the two binaries use different prefixes — the edge uses `DSHRC_`,
the agent uses `DSHRC_`. This is the current code, not a typo in the docs.

### 2.1 Edge

| Flag | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `--host` | `DSHRC_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` only behind a proxy or firewall. |
| `--port` | `DSHRC_PORT` | `8787` | Listen port. `0` picks an ephemeral port. |
| `--data-dir` | `DSHRC_DATA_DIR` | `./dshrc-data` | Directory for `dshrc.sqlite` (WAL mode). Created if absent. |
| `--public-url` | `DSHRC_PUBLIC_URL` | empty | Absolute public origin, e.g. `https://link.example.com`. Empty derives it per request from `Host`/`X-Forwarded-Proto`; set it in production. Trailing slash is stripped. |
| `--trust-proxy` | `DSHRC_TRUST_PROXY` | off | Honour `X-Forwarded-Proto` and `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For`. Required behind Caddy or Cloudflare, never on a directly exposed listener. |
| `--insecure` | `DSHRC_INSECURE` | off | Accepted **only** on a loopback bind. Allows a plain-http `--public-url` for a local proxy demo and leaves `Secure` off cookies. Loopback HTTP works without it; never use it behind Caddy or Cloudflare. |
| `--setup-code` | `DSHRC_SETUP_CODE` | generated | Deterministic first-run setup code, 8–128 chars. Without it a 12-character code (three groups of four) is generated and printed on each start until setup completes. |
| `--audit-retention-days` | `DSHRC_AUDIT_RETENTION_DAYS` | `30` | Delete audit rows older than this many days, on boot and then every 24 h. Integer 0–36500; `0` disables pruning. |
| `--log-level` | `DSHRC_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. JSON lines on stdout/stderr. |

### 2.2 Agent

| Flag | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `--edge` | `DSHRC_EDGE` | `http://127.0.0.1:8787` | Edge origin. `https://` in production. |
| `--dsh-url` | `DSHRC_DSH_URL` | one of these | Authenticated DSH URL, typically `http://127.0.0.1:<port>/?token=…`. Puts the token in argv; prefer the file form. |
| `--dsh-url-file` | `DSHRC_DSH_URL_FILE` | one of these | Path to a 0600 JSON file `{"url":"http://127.0.0.1:<port>/?token=…"}`. Takes precedence over `--dsh-url`. The plugin writes this file. |
| `--state-dir` | `DSHRC_STATE_DIR` | `~/.dsh-rc/agent` | Holds `device.json` (identity) and `agent.lock` (single-instance lock). Dir `0700`, files `0600`. |
| `--name` | `DSHRC_NAME` | `os.hostname()` | Human-readable device name shown in the dashboard. |
| `--insecure` | `DSHRC_INSECURE` | off | Allow plain `http`/`ws` to a non-loopback edge **and** skip TLS certificate verification. Loopback HTTP is always allowed without it. |
| `--status-file` | `DSHRC_STATUS_FILE` | unset | If set, write an atomic JSON status document for supervisors (the plugin uses this). |
| `--log-level` | `DSHRC_LOG_LEVEL` | `info` | Same levels as the edge. |

The agent requires exactly one of `--dsh-url` / `--dsh-url-file`; it cannot
discover the DSH port itself. A plugin-launched agent does not use the manual
default above: its state dir is `<DSH home>/link`, or `<stateDir>/link` when the
plugin's optional `stateDir` config overrides the DSH home
(`packages/plugin/README.md`). Exit codes are `0` clean stop, `1` terminal error
(device revoked, tunnel auth failed, protocol mismatch, state-dir lock
held, crash), `2` usage or configuration error. A DSH upstream `401` with no usable token is **not** a
terminal exit: the agent stays alive in `state: error` with an actionable
`lastError` (`docs/OPERATIONS.md` §8.1).

## 3. Shape 1 — laptop demo

Two terminals, no TLS, no container. Useful to validate the build and to try
the UI before committing to a server.

```bash
# terminal 1 — edge on loopback
node apps/edge/dist/main.js \
  --host 127.0.0.1 \
  --port 8787 \
  --data-dir ./.dshrc-demo \
  --log-level debug
```

The first start prints the bind URL, a setup code and a setup URL, for
example:

```
DSH RC edge listening on http://127.0.0.1:8787
DSH RC setup code: 7f3k-9q2m-8xda
DSH RC setup url: http://127.0.0.1:8787/setup
```

Loopback HTTP is allowed without `--insecure`; that flag exists for a
plain-http `--public-url` behind a local proxy and is rejected on any
non-loopback bind.

Complete `/setup` in the browser. This creates the owner and stores an
HMAC-signed `dshrc_session` cookie (HttpOnly, SameSite=Lax, 30 days; `Secure`
only when the origin is HTTPS).

Before setup completes, every edge start generates a fresh setup code and
invalidates the previous one (only a hash is stored, so the old plaintext is
unrecoverable). If you restart before redeeming it, use the newly printed code.
For a code that survives restarts, supply `--setup-code <known-code>`
(8–128 characters).

Start the agent with the authenticated DSH URL. This is the loopback URL DSH
opens with a `token` query parameter; the plugin obtains it from the running
app (`ctx.connection.authenticatedUrl()`), and obtaining it by hand is the one
step the plugin automates. If you cannot get it, use the "Desktop plugin"
section of the root README instead of a manual agent. Do not paste it into a shell
history on a shared machine.

```bash
# terminal 2 — agent on the same laptop
node apps/agent/dist/main.js \
  --edge http://127.0.0.1:8787 \
  --dsh-url "http://127.0.0.1:49321/?token=REPLACE_ME" \
  --state-dir ~/.dsh-rc/agent \
  --name "$(hostname)" \
  --status-file ~/.dsh-rc/agent/status.json \
  --log-level debug
```

First run registers the device with `POST /v1/devices/register` and writes
`device.json`. The device starts **pending**, and the agent's status file
already contains a `pairUrl`. Open that URL while signed in as the owner (or
enter the owner password on the pair page): redemption approves the device and
pairs the browser in one step. If you approve from the dashboard at
`http://127.0.0.1:8787/` first, the code stays usable until it expires. Pair
codes are single use and expire after 10 minutes.

Open `http://127.0.0.1:8787/d/<deviceId>/` to use the DSH UI.

To reset the demo completely: stop both processes, `rm -rf .dshrc-demo
~/.dsh-rc/agent`, and start again. That destroys the owner, devices and
sessions; it is the correct move for a demo and the wrong move in production.

## 4. Shape 2 — single VPS with Docker + Caddy

Caddy obtains and renews a Let's Encrypt certificate automatically and proxies
HTTP and WebSocket to the edge. Only Caddy publishes ports.

### 4.1 Files

`Dockerfile` (repository root):

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
# Production dependencies only; the workspaces are linked by npm ci.
RUN npm ci --omit=dev \
 && addgroup -S dshrc && adduser -S dshrc -G dshrc \
 && mkdir -p /data && chown -R dshrc:dshrc /app /data
USER dshrc
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "apps/edge/dist/main.js"]
CMD ["--host", "0.0.0.0", "--port", "8787", "--data-dir", "/data", "--log-level", "info"]
```

`docker-compose.yml`:

```yaml
services:
  edge:
    build: .
    image: dsh-rc-edge:0.1.0
    restart: unless-stopped
    environment:
      DSHRC_PUBLIC_URL: https://link.example.com
      DSHRC_TRUST_PROXY: "1"
      DSHRC_LOG_LEVEL: info
    volumes:
      - dshrc-data:/data
    expose:
      - "8787"

  caddy:
    image: caddy:2.8-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - edge

volumes:
  dshrc-data:
  caddy-data:
  caddy-config:
```

`Caddyfile`:

```caddyfile
link.example.com {
    reverse_proxy edge:8787
}
```

### 4.2 Bring it up

```bash
docker compose up -d --build
docker compose logs edge | grep -i "setup code"
```

Then open `https://link.example.com/setup` and redeem the code. The device then
appears as pending. Sign in as the owner, then open the agent's `pairUrl` and
confirm with the owner password if prompted; redemption approves the device and
pairs the browser (`docs/OPERATIONS.md` §2). If the log line is missed and the
edge has restarted, restart it again to print a fresh code — the previous one is
invalid — or start it with an explicit `--setup-code` (`docs/OPERATIONS.md` §1.1).

Firewall: allow `80/tcp` and `443/tcp` (and `443/udp` if your Caddy build has
HTTP/3 enabled). Do **not** publish `8787`.

Why `DSHRC_TRUST_PROXY=1`: Caddy terminates TLS and forwards
`X-Forwarded-Proto`. Without the flag the edge thinks it is serving HTTP, emits
non-`Secure` cookies, and logs Caddy's address as the client. With the flag and
`--public-url https://…`, cookies are `Secure` and rate limits key on the real
client.

`--insecure` is not used here and must not be: it is rejected unless the bind
address is loopback, and it would drop `Secure` from cookies.

### 4.3 systemd alternative (no Docker)

Install the build under `/opt/dsh-rc`, create a system user, and run the edge
behind Caddy or nginx on the same host:

```bash
sudo useradd --system --home /var/lib/dsh-rc --shell /usr/sbin/nologin dshrc
sudo install -d -o dshrc -g dshrc -m 700 /var/lib/dsh-rc
sudo install -d -o dshrc -g dshrc -m 755 /opt/dsh-rc
```

`/etc/systemd/system/dsh-rc-edge.service`:

```ini
[Unit]
Description=DSH RC edge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dshrc
Group=dshrc
WorkingDirectory=/opt/dsh-rc
ExecStart=/usr/bin/node /opt/dsh-rc/apps/edge/dist/main.js \
  --host 127.0.0.1 --port 8787 \
  --data-dir /var/lib/dsh-rc \
  --public-url https://link.example.com \
  --trust-proxy \
  --log-level info
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/dsh-rc
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-rc-edge
journalctl -u dsh-rc-edge -f
```

The edge binds `127.0.0.1:8787`, so Caddy (or nginx) on the same host is the
only thing that can reach it. `--trust-proxy` is safe because the listener is
loopback-only.

## 5. Shape 3 — Cloudflare in front

Use this if you want Cloudflare's anycast and HTTP/3 without operating PoPs.

### 5.1 DNS and TLS mode

1. Create a proxied `A`/`AAAA` record for `link.example.com` pointing at the
   origin.
2. In **SSL/TLS → Overview**, set **Full (strict)**.
3. In **SSL/TLS → Origin Server**, create an origin certificate for
   `link.example.com` and install it on the origin.
4. Keep WebSockets enabled (default).

### 5.2 Origin

Caddy with the origin certificate (mount the certificate and key into the
Caddy container, key mode 0600 on the host):

```caddyfile
link.example.com {
    tls /etc/caddy/origin.pem /etc/caddy/origin-key.pem
    reverse_proxy edge:8787
}
```

`docker-compose.override.yml` (Compose applies it automatically):

```yaml
services:
  caddy:
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./certs/origin.pem:/etc/caddy/origin.pem:ro
      - ./certs/origin-key.pem:/etc/caddy/origin-key.pem:ro
```

Edge environment:

```yaml
environment:
  DSHRC_PUBLIC_URL: https://link.example.com
  DSHRC_TRUST_PROXY: "1"
```

Restrict the origin firewall to Cloudflare's published IP ranges; the origin
certificate is not a secret, but there is no reason to serve the world directly.

### 5.3 WebSocket and timeouts

Cloudflare proxies WebSocket upgrades. The tunnel sends a `PING` every 15 s
(`docs/PROTOCOL.md:161`), which is well under Cloudflare's idle timeout, so a
healthy tunnel stays open. Long-lived streaming responses are subject to
Cloudflare's origin response timeout before the first byte (100 s on many
plans); data already flowing keeps the connection alive. If you see `524`
errors on very slow upstream work, test with the Cloudflare proxy disabled
before blaming the edge. Measured behaviour: **TBD**.

### 5.4 Trust statement

Cloudflare terminates client TLS. It therefore sees the same plaintext the edge
sees, and adds a second company to the trust boundary. If you self-host because
you do not want a relay reading traffic, do not put Cloudflare in front — or
accept that "self-hosted" now means two operators, not one.

## 6. Backup and restore

The edge stores everything in one SQLite database, `dshrc.sqlite`, in WAL
mode. Back up the database, not the directory copy of a running process.

### 6.1 systemd / bare metal

Online backup (safe while running):

```bash
sudo install -d -o dshrc -g dshrc -m 700 /var/backups/dsh-rc
sudo -u dshrc sqlite3 /var/lib/dsh-rc/dshrc.sqlite \
  ".backup '/var/backups/dsh-rc/dshrc-$(date +%F-%H%M).sqlite'"
```

Nightly cron with 14-day retention:

```cron
17 3 * * * dshrc sqlite3 /var/lib/dsh-rc/dshrc.sqlite ".backup '/var/backups/dsh-rc/dshrc-$(date +\%F).sqlite'" && find /var/backups/dsh-rc -name 'dshrc-*.sqlite' -mtime +14 -delete
```

Restore:

```bash
sudo systemctl stop dsh-rc-edge
sudo -u dshrc cp /var/backups/dsh-rc/dshrc-2026-10-27.sqlite /var/lib/dsh-rc/dshrc.sqlite
sudo rm -f /var/lib/dsh-rc/dshrc.sqlite-wal /var/lib/dsh-rc/dshrc.sqlite-shm
sudo systemctl start dsh-rc-edge
curl -fsS https://link.example.com/healthz
```

Restoring rolls back devices, sessions, audit and the owner row together. A
browser session created after the backup will be invalid; devices will need to
reconnect, but their secrets are in the restored rows.

### 6.2 Docker

Cold backup, a few seconds of downtime:

```bash
mkdir -p backups
docker compose stop edge
docker compose cp edge:/data/dshrc.sqlite "./backups/dshrc-$(date +%F-%H%M).sqlite"
docker compose start edge
```

Restore:

```bash
docker compose stop edge
docker compose cp "./backups/dshrc-2026-10-27-0317.sqlite" edge:/data/dshrc.sqlite
# A restored database must not be paired with the previous WAL/SHM files.
docker compose run --rm --entrypoint sh edge \
  -c 'rm -f /data/dshrc.sqlite-wal /data/dshrc.sqlite-shm'
docker compose start edge
curl -fsS https://link.example.com/healthz
```

The container's `/data` also holds `dshrc.sqlite-wal` and `-shm` while
running; `docker compose cp` of the main file after a clean stop is consistent.
Do not copy the live file without stopping, or use SQLite's `.backup`.

## 7. Upgrade and rollback

### 7.1 Bare metal / systemd

```bash
cd /opt/dsh-rc
sudo -u dshrc git fetch --tags
sudo -u dshrc git checkout v0.1.1        # tag you intend to run
sudo -u dshrc npm ci
sudo -u dshrc npm run build
sudo systemctl restart dsh-rc-edge
curl -fsS https://link.example.com/healthz
```

Rollback is the same sequence with the previous tag. If the new version
migrated the schema, restore the pre-upgrade backup first; migrations are
forward-only unless a release note says otherwise.

### 7.2 Docker

```bash
docker compose build --pull
docker compose up -d
docker compose ps
curl -fsS https://link.example.com/healthz
```

Pin the image by tag and, for a stricter deploy, by digest
(`image: dsh-rc-edge@sha256:…`). Roll back by checking out the previous tag
and rebuilding; keep the previous `data/` backup until the new version has
served traffic for a day.

### 7.3 What an upgrade does to live sessions

- The edge restarts; agents reconnect on their own with full-jitter backoff
  (250 ms → 20 s). In-flight streams are reset as retryable.
- Browser WebSocket streams drop and the DSH client reconnects its own mux.
- No application-level mutation is replayed (`docs/PROTOCOL.md:170-172`).
- Sessions and device rows survive in SQLite.

## 8. Moving a device to a new edge

A device identity is bound to the edge it registered with: `device.json` stores
the `edgeUrl`, device id and secret. There is no migration protocol. The
supported procedure is re-registration:

```bash
# 1. On the OLD edge, revoke the device (dashboard, or:)
curl -fsS \
  -b "dshrc_session=<owner-session>; dshrc_csrf=<csrf-token>" \
  -H "x-csrf-token: <csrf-token>" -d "csrf=<csrf-token>" \
  -X POST https://old.example.com/v1/devices/dev_xxxxxxxxxxxxxxxxxxxx/revoke

# 2. On the desktop, stop the agent (the plugin supervises it; or Ctrl-C).
#    No file editing is needed: the stored edgeUrl differs, so the agent
#    registers a new device on the new edge automatically.

# 3. Start against the new edge with the same DSH launch URL:
node apps/agent/dist/main.js \
  --edge https://new.example.com \
  --dsh-url "$DSH_LAUNCH_URL" \
  --state-dir ~/.dsh-rc/agent \
  --name "$(hostname)"
```

The agent notices the edge change at startup (`apps/agent/src/runtime.ts:180-186`),
discards the old identity and registers a new device — a new device id and
secret. You can also delete `device.json` first; the effect is the same. Then
approve the new device on the new edge and pair browsers again. Old pair URLs
and browser sessions do not follow the device; pair codes are per edge.
Keep the old edge running until the new one is verified, then decommission it.

If you skip step 1, the old edge keeps a revoked-looking but live device row;
it cannot connect because the agent no longer has that secret, but the row and
its audit history remain. Revoke for cleanliness.

## 9. Health checks and readiness

| Endpoint | Auth | Use |
| --- | --- | --- |
| `GET /healthz` | none | Liveness/readiness: `200` JSON `{ok,status,version,uptimeMs}`. Point the container healthcheck and your monitor here. |
| `GET /v1/edge` | none | Public metadata: `edgeId`, `version`, `uptimeMs`, `protocol`, `presenceGraceMs`, device counts, `setupComplete`, `auditRetentionDays`. Useful to confirm the edge is reachable and set up. |

Do not expose the dashboard or `/v1/tunnel` through a separate hostname; the
session cookie and the public URL are origin-bound.

## 10. Troubleshooting index

| Symptom | First check |
| --- | --- |
| `502` from Caddy | Edge container down or bound to the wrong interface; `docker compose logs edge`. |
| `503` from the edge with `Retry-After` | Device offline or outside the 30 s presence grace; check the agent status file. |
| Browser redirects to `http://` behind a proxy | `DSHRC_TRUST_PROXY` and `DSHRC_PUBLIC_URL` are not set. |
| Login loop | Cookie is `Secure` but the browser is on plain HTTP; use HTTPS or `--insecure` on loopback only. |
| WebSocket fails but HTTP works | Proxy is not forwarding `Upgrade`/`Connection`; Caddy does this by default, nginx needs explicit headers. |

Full runbook: `docs/OPERATIONS.md`.

## 11. Security checklist before going live

- [ ] Edge is reachable only through the TLS proxy; port `8787` is firewalled.
- [ ] `--public-url` is the exact HTTPS origin and `--trust-proxy` is set.
- [ ] `--insecure` is absent.
- [ ] `--data-dir` is on a persistent disk, owned by the service user, mode `0700`.
      The edge creates the directory `0700` and the SQLite file `0600`
      (`apps/edge/src/db.ts:217-225`);
      do not loosen that to make backups easier.
- [ ] Backups run daily and a restore has been tested once.
- [ ] Setup code has been redeemed and `/setup` returns 403.
- [ ] Owner password set, or the "delete owner row to re-auth" limitation is
      understood (`docs/OPERATIONS.md` §1).
- [ ] Audit retention matches your policy; logs ship off-host.
- [ ] The trust boundary in `docs/THREAT-MODEL.md` §7.1 is acceptable to you.