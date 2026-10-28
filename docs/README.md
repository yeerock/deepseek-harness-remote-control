# DSH RC documentation

Start here if you are new; the table maps each document to its audience.

| Document | Read it when |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | You want the component model and the reasoning behind one transport. |
| [PROTOCOL.md](PROTOCOL.md) | You are implementing or reviewing the wire format, flow control or error codes. |
| [adr/0001-no-webrtc.md](adr/0001-no-webrtc.md) | You are questioning the no-WebRTC decision. |
| [THREAT-MODEL.md](THREAT-MODEL.md) | You need assets, actors, trust boundaries, STRIDE and residual risk. |
| [DEPLOY.md](DEPLOY.md) | You are installing an edge: laptop, VPS with Docker + Caddy, or Cloudflare. |
| [OPERATIONS.md](OPERATIONS.md) | You are pairing, revoking, rotating, reading audit rows or diagnosing a failure. |
| [COMPARISON.md](COMPARISON.md) | You are choosing between DSH RC and `liguobao/ds-harness-remote`. |
| [SECURITY.md](SECURITY.md) | You are reporting a vulnerability or reviewing the security design. |
| [FAQ.md](FAQ.md) | You want a short answer before reading a long document. |
| [README.zh.md](README.zh.md) | 你需要简体中文的根 README。 |
| [images/](images/) | 真实截图：Harness 经 edge 渲染、插件侧边栏、edge 仪表盘。 |

## The one thing to understand first

The edge terminates TLS and therefore sees plaintext for proxied traffic. It is
a trusted relay. If that trust is unacceptable, self-host the edge or use a
design with application-layer end-to-end encryption. This is stated in
[THREAT-MODEL.md](THREAT-MODEL.md) §7.1 and is the boundary every other claim in
these documents assumes.

## Conventions

- Commands assume the repository root unless stated otherwise.
- `TBD` means not measured, not implemented, or not decided. It is never a
  placeholder for a number that exists somewhere else.
- Claims about this repository cite a file and, where useful, a line.
- Claims about `liguobao/ds-harness-remote` cite the commit
  `acca8d8f03f964f72f26731c87970012dffbe4a8` (2026-10-28) and a file:line.
- The edge and agent CLIs are new. If `--help` disagrees with a document, the
  code wins; please open an issue against the document.