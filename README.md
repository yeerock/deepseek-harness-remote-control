# DSH Link

**Reliable remote access for the DeepSeek Harness desktop app — from any browser,
through any network, with no second client to install.**

DSH Link serves your existing Harness web UI over one authenticated
HTTPS/WebSocket tunnel. There is no mobile app, no WebRTC negotiation, no
protocol re-implementation. Your desktop stays the source of truth; the browser
in front of you is a window into it.

> **Status: pre-release.** The protocol, multiplexer, edge and agent are being
> built in the open. Expect the API and flags to move until `v0.1.0`.

## Why another remote plugin?

The WebRTC-first approach that existing DSH remote plugins take has three
structural costs: ICE negotiation on networks that filter UDP, a relay that is
often on the wrong continent, and a separate client that re-implements the
Harness UI. In practice that reads as *"it hangs, then it disconnects."*

DSH Link makes the opposite bet:

- **One transport.** Outbound WSS on 443. No inbound ports, no UDP, no STUN/TURN.
- **One client.** The browser loads the real DSH web app. Feature parity is
  automatic, including tools, files, terminal and streaming.
- **One place to supervise.** Heartbeats, backoff, flow control and priority
  scheduling live in the tunnel, not in three fallback paths.
- **Real backpressure.** 256 KiB per stream, 8 MiB per tunnel, credit returned
  only as bytes are consumed; interactive traffic outranks bulk downloads.

Read the reasoning in [ADR-0001](docs/adr/0001-no-webrtc.md) and the design in
[ARCHITECTURE.md](docs/ARCHITECTURE.md).

```

browser (anywhere) ──HTTPS/WSS──▶ edge ──one multiplexed WSS──▶ agent ──HTTP/WS──▶ DSH desktop
                                  │                              │
                                  auth · pairing                 mints the DSH cookie,
                                  presence · audit               proxies loopback only
```

## Quick start

Three pieces: an **edge** (public relay), an **agent** (on the desktop), and the
**DSH plugin** (starts the agent and shows pairing in the Harness UI).

```bash
# 1. Edge — on a VPS or your laptop
npm ci && npm run build
node apps/edge/dist/main.js --host 0.0.0.0 --port 8787 \
  --data-dir ~/.dsh-link --public-url https://link.example.com

# 2. Agent — on the desktop, pointed at your local Harness
node apps/agent/dist/main.js --edge https://link.example.com \
  --dsh-url "http://127.0.0.1:49295/?token=…" --state-dir ~/.dsh-link/agent

# 3. Or let the plugin do (2) for you: install it into your DSH profile and
#    enable it in settings. The plugin mints the authenticated URL itself.
```

Full instructions: [docs/DEPLOY.md](docs/DEPLOY.md). First-run setup and
pairing: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Security in one paragraph

TLS 1.3 to the edge; device secrets are random 32 bytes stored only as SHA-256;
pairing codes are single-use and expire in 10 minutes; the Harness launch token
never leaves the desktop — the agent exchanges it once for a loopback-bound
cookie and holds it in memory; the browser never receives a Harness credential.
The edge terminates TLS and therefore sees proxied plaintext: treat it as a
trusted relay, self-host it if that matters. Details and residual risk:
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## What it deliberately does not do

- No mobile apps. The browser is the client.
- No WebRTC data path in v1 (see [ADR-0001](docs/adr/0001-no-webrtc.md)).
- No replay of Harness mutations after an unknown outcome.
- No second chat/files/terminal UI.

## Repository layout

| Path | What |
| --- | --- |
| `packages/protocol` | Wire format, frame guards, path/header policy |
| `packages/mux` | Streams, flow control, priority scheduler, heartbeat |
| `packages/shared` | WebSocket adapter, tokens, cookies, logging |
| `apps/edge` | Public HTTPS/WSS relay, auth, pairing, dashboard |
| `apps/agent` | Desktop tunnel client and loopback proxy |
| `packages/plugin` | DeepSeek Harness plugin (host + sidebar UI) |
| `tests`, `tools/bench` | Integration, fault injection, benchmarks |
| `docs` | Architecture, protocol, ADRs, threat model, runbooks |

## License

MIT.