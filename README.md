# DSH Link

**Remote access to your DeepSeek Harness desktop, through one TLS WebSocket and
the browser you already have.**

DSH Link serves the *unmodified* Harness web UI over a single outbound
connection. The desktop agent dials the edge; the edge proxies HTTP and
WebSocket streams to it; your browser opens the real DSH interface. No WebRTC,
no UDP, no inbound port, no port forwarding, and no second client to install on
the machine in front of you.

![The unmodified DeepSeek Harness UI, served through a DSH Link edge from another origin](docs/images/desktop-through-edge.png)

That screenshot is not a mockup: it is the real Harness 0.2.1 session, loaded
from `http://<edge>/d/<device>/` in headless Chromium by
[`tools/e2e/real-dsh.mjs`](tools/e2e/real-dsh.mjs), with owner setup, device
registration and pairing all driven over HTTP first. Reproduction command is in
[Verification](#verification).

> **Status: v0.1.0.** Protocol, mux, edge, agent, plugin, tests and docs are
> implemented. 168 automated tests are green, the real-DSH end-to-end proof
> passes, and the benchmark numbers below are measured. It is pre-release
> software: treat the plugin as beta and read
> [THREAT-MODEL.md](docs/THREAT-MODEL.md) before exposing a desktop.

## Why another remote plugin?

Existing DSH remote plugins are WebRTC-first: ICE, STUN/TURN, a custom client
for every platform, and a relay that may be a continent away. When UDP is
filtered or the relay is far, the experience is "it hangs, then it disconnects".

DSH Link makes the opposite bet:

- **One transport.** Outbound WSS on 443. No UDP, no STUN/TURN, no ICE
  negotiation, no native `wrtc` addon. It works on hotel Wi-Fi, corporate TLS
  inspection, CGNAT and IPv6-only networks.
- **One client.** The browser loads the real DSH app. Chat streaming, tools,
  files, terminal and every future feature arrive with the desktop; there is no
  RPC projection to drift.
- **One thing to supervise.** Heartbeats, backoff, flow control and priority
  live in the tunnel. There is no three-path fallback whose first path costs
  eight seconds before giving up.
- **Real backpressure.** 256 KiB per stream and 8 MiB per tunnel, credit
  returned only as bytes are consumed. A 16 MiB download cannot add latency to a
  keystroke; measured p95 is 3.1 ms under four concurrent 16 MiB transfers.

The trade-off is explicit: the edge terminates TLS and therefore sees plaintext
proxied traffic. It is a **trusted relay**. Self-hosting is a first-class
deployment, and [THREAT-MODEL.md](docs/THREAT-MODEL.md) states exactly what that
trust buys and costs. If you need end-to-end encryption against the relay, this
is the wrong design for you — and [ADR-0001](docs/adr/0001-no-webrtc.md) explains
why we chose it anyway.

## Architecture

```
┌─────────────┐   HTTPS + WSS (443)   ┌──────────────┐   one multiplexed WSS   ┌───────────┐   loopback HTTP/WS   ┌─────────────┐
│   browser   │ ────────────────────▶ │     edge     │ ◀────────────────────── │   agent   │ ───────────────────▶ │ DSH desktop │
│ (anywhere)  │ ◀──────────────────── │  (self-host) │ ──────────────────────▶ │ (desktop) │ ◀─────────────────── │ web server  │
└─────────────┘                       └──────────────┘                         └───────────┘                      └─────────────┘
                                       auth · pairing                          mints the DSH                     unchanged
                                       presence · audit                        cookie, proxies
```

- **Browser → edge:** ordinary HTTPS/WSS on 443. Sub-path mount
  `/d/<deviceId>/`; the app's own relative URLs and `<base href="./">` do the
  rest.
- **Edge → agent:** one WebSocket per device, multiplexed into independent HTTP
  and WebSocket streams, with per-stream flow control and a weighted scheduler
  (high/normal/low) so bulk traffic cannot starve the UI.
- **Agent → DSH:** `127.0.0.1:<port>` only, with a cookie obtained from the DSH
  launch token. The token and cookie never leave the desktop.

Details: [ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[PROTOCOL.md](docs/PROTOCOL.md) ·
[ADR-0001: no WebRTC](docs/adr/0001-no-webrtc.md).

## Requirements

| Component | Requirement |
| --- | --- |
| Desktop | DeepSeek Harness **0.2.1-rc.3** (plugin declares `>=0.2.1-rc.3 <0.3.0`) |
| Edge | Node.js ≥ 22.13 (or the Docker image), a domain for TLS in production |
| Browser | Any current Chromium, Firefox or Safari |
| Network | Outbound 443 from the desktop; no inbound ports, no UDP |

## Quick start

### 1. Edge

On a small VPS (or your laptop for a demo):

```bash
git clone https://github.com/yeerock/dsh-link && cd dsh-link
npm ci && npm run build

node apps/edge/dist/main.js \
  --host 0.0.0.0 --port 8787 \
  --data-dir ~/.dsh-link --public-url https://link.example.com
```

It prints a one-time **setup code** (rotated each boot until setup completes).
Put TLS in front with the included [Caddy + Docker setup](docker/docker-compose.yml),
or terminate TLS at your load balancer and run with `--trust-proxy`.

### 2. Agent (or let the plugin do it)

```bash
node apps/agent/dist/main.js \
  --edge https://link.example.com \
  --dsh-url-file ~/.dsh-link/agent/upstream.json \
  --state-dir ~/.dsh-link/agent \
  --name my-desktop \
  --status-file ~/.dsh-link/agent/status.json
```

`upstream.json` is `{ "url": "http://127.0.0.1:<port>/?token=…" }`, mode 0600.
The token is deliberately **not** accepted on argv. On first run the agent
prints `DSH_LINK_PAIR_URL=…`; open it while signed in as the owner to approve
the device and pair the browser. The DSH UI is then at
`https://link.example.com/d/<deviceId>/`.

### 3. Desktop plugin (recommended)

The plugin appears in Harness as **Remote Control**. It mints the authenticated
URL from the running DSH desktop, writes it to a 0600 file, spawns and
supervises the agent, and shows a status panel in the Harness sidebar: state, device id, latency, reconnects, start/restart/stop
controls, and — while pairing only — the pair link with a QR code. Once online
the panel shows "Paired" instead of a dead QR.

![Remote Control panel in Harness: state, device, latency, QR pairing and controls](docs/images/plugin-panel.png)

```bash
dsh plugin --profile <profile> add link:"$PWD/packages/plugin"
```

Enable the `dsh-link` entry in your profile's user layer,
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: dsh-link
  config:
    enabled: true
    edgeUrl: https://link.example.com
    deviceName: my-desktop
    autoStart: true
```

Then boot that profile with `dsh --profile <profile> --port 0 --no-open`
(`--profile <name>` replaces the `dsh web` shorthand; do not append `web`).

Full install, configuration and troubleshooting:
[packages/plugin/README.md](packages/plugin/README.md). Deployment shapes,
flags and systemd: [DEPLOY.md](docs/DEPLOY.md).

## Security in one paragraph

TLS to the edge; **device secrets are 32 random bytes stored only as SHA-256**;
**pair codes are 8 characters, single-use, 10-minute TTL**, and cannot be
redeemed without an owner session or the owner password. The **DSH launch token
never leaves the desktop**: the agent exchanges it once for a loopback-bound
cookie held in memory. The browser never receives a Harness credential, and the
agent refuses non-loopback upstreams, absolute URLs, `..` segments and encoded
traversal even if the edge is compromised. The edge sees proxied plaintext;
self-host it if that matters. Residual risk and the full STRIDE pass:
[THREAT-MODEL.md](docs/THREAT-MODEL.md). Report issues per
[SECURITY.md](docs/SECURITY.md).

![Edge dashboard: devices, online state and audit tail](docs/images/edge-dashboard.png)

## Verification

```bash
npm run typecheck        # tsc -b across all workspaces
npm test                 # 168 tests: unit + integration
npm run bench:quick      # tools/bench, JSON + markdown to tools/bench/results
npm run e2e              # boots a real DSH web profile, edge and agent, then Chromium
```

`npm run e2e` is the proof behind the screenshot: isolated `DSH_HOME`, real
`dsh --profile web`, real edge, real agent, owner setup, pairing, index fetch,
`/api/remote.mux` upgrade and a Chromium render. It asserts the proxied HTML is
the Harness shell, contains no loopback origin, and that the UI renders.

Measured on an Apple M4 Pro (24 GiB, macOS 26, Node 24.18.0, 2026-10-28),
**loopback edge — these measure tunnel overhead, not internet RTT**:

| Metric | Value |
| --- | ---: |
| TTFB through edge, median / p95 | 2.1 ms / 2.9 ms |
| Throughput, 1 MiB / 16 MiB | 157 / 299 MiB/s |
| 200 sequential requests | 505 req/s (p95 2.1 ms) |
| 50 concurrent requests | 16.6 ms total (p95 ~19 ms) |
| Interactive p95 during 4 × 16 MiB bulk | 3.1 ms |
| Tunnel connect after agent restart | 2.7 ms |
| Reconnect after forced 4004 replacement | 49 ms |

Real-DSH smoke: index 37,907 B byte-identical, main JS bundle 941,436 B
SHA-256-equal through the tunnel, `remote.mux` OPEN.

## What it deliberately does not do

- **No mobile apps.** The browser is the client.
- **No WebRTC data path in v1.** See [ADR-0001](docs/adr/0001-no-webrtc.md) for
  the trade-off and the conditions under which that changes.
- **No replay of Harness mutations** after an unknown outcome.
- **No second chat/files/terminal UI.** That is the point.
- **No multi-tenant SaaS.** Self-host first; hosted accounts and OAuth are
  roadmap, not v1.

## Repository layout

| Path | What |
| --- | --- |
| [`packages/protocol`](packages/protocol) | Wire format, frame guards, path/header policy |
| [`packages/mux`](packages/mux) | Streams, flow control, priority scheduler, heartbeat |
| [`packages/shared`](packages/shared) | WebSocket adapter, tokens, cookies, logging |
| [`apps/edge`](apps/edge) | Public HTTPS/WSS relay, auth, pairing, SQLite, dashboard |
| [`apps/agent`](apps/agent) | Desktop tunnel client and loopback proxy |
| [`packages/plugin`](packages/plugin) | DeepSeek Harness plugin (host + sidebar UI) |
| [`tests`](tests), [`tools/bench`](tools/bench) | Integration, fault injection, benchmarks |
| [`docs`](docs) | Architecture, protocol, ADRs, threat model, deployment, runbook |

## FAQ

**Does my DSH token leave the machine?** No. It is never logged and never placed
in argv: the plugin hands it to the agent in a 0600 file, the agent exchanges it
once for a loopback-bound cookie held in memory, and the browser never sees
either.

**Why not P2P?** Because the reported failure is networks where P2P cannot
work, and because a browser cannot speak WebRTC to an HTTP origin without a
second client. The full argument: [ADR-0001](docs/adr/0001-no-webrtc.md).

**What happens on a flaky network?** Heartbeats every 15 s, a 45 s idle
deadline, full-jitter reconnect from 250 ms to 20 s, 30 s presence grace, and
no message replay. A desktop crash cannot leave two agents fighting: a
per-state-dir lock refuses the second one.

**Can I self-host the edge?** That is the intended deployment. One Docker
Compose file, Caddy for TLS, a SQLite file to back up.

**Where should the edge live?** Near enough to both ends that interactive RTT
stays low. If your desktop is in mainland China and you work from Europe or
North America, put the edge in Hong Kong, Singapore, Tokyo or Seoul — *not* in
mainland China, which is the failure mode this project removes. Measure both
legs; details in [DEPLOY.md §0](docs/DEPLOY.md#0-choosing-a-region-read-this-first).

More: [FAQ.md](docs/FAQ.md) · [OPERATIONS.md](docs/OPERATIONS.md).

## License

MIT. See [LICENSE](LICENSE).