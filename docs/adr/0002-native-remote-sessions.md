# ADR-0002: Native remote sessions, not embedded UI

Status: proposed, v0.2.10 ships the interim native window.
Date: 2026-10-29

## Context

The remote UI is the unmodified Harness SPA. Two embedding attempts failed for
structural reasons:

- **iframe**: the shell loads, assets return 200, but DSH's client never finishes
  plugin activation (`Loading plugins…`).
- **Electron `<webview>`**: DSH's main process enforces a lease policy in
  `will-attach-webview`; arbitrary webviews are prevented.

v0.2.10 therefore opens the authenticated loopback proxy in a native child
`BrowserWindow`. It works and needs no login, but it is still a separate window.

The reference plugin (`liguobao/ds-harness-remote`) takes the other route: it
projects remote work into native workspace/session/composer objects through an
ACP gateway. We studied that boundary; this ADR defines our own equivalent for
DSH-to-DSH remote control. No reference code is copied.

## Decision

Remote sessions become **first-class DSH session projections**, not iframes or
proxy pages:

```
local DSH UI                local host plugin             edge/agent                remote DSH
────────────                ─────────────────             ──────────                ──────────
virtual workspace  ───────▶ remote.workspace.list  ─────▶ edge proxy  ───────▶ host DSH API
virtual session    ───────▶ remote.session.list    ─────▶             ───────▶ session store
composer prompt    ───────▶ remote.prompt.send     ─────▶             ───────▶ agent run
assistant stream   ◀──────  remote.stream.*        ◀─────             ◀──────  events
files/terminal     ───────▶ existing /d/<id>/ proxy ─────▶            ───────▶ host tools
```

### Host RPC (new, device-authenticated)

| Method | Purpose |
| --- | --- |
| `remote.workspace.list` | host workspaces, IDs and labels |
| `remote.session.list` | sessions per workspace, titles, timestamps |
| `remote.session.open` | bounded history + live subscription |
| `remote.prompt.send` | user message, model/workspace selection |
| `remote.session.cancel` | interrupt |
| `remote.approval.decide` | tool approvals |
| `remote.stream.*` | ordered text/reasoning/tool/usage events |

All methods are device-scoped and rate-limited; no owner password, no edge
owner cookie, no device secret leaves the host.

### Virtual IDs

`remote:<deviceId>:<sessionId>` and `remote:<deviceId>:ws:<workspaceId>`.
They never enter the host's SessionStore; the client projection is in memory.
A missing device renders offline, not an empty conversation.

### Files and terminal

Files, uploads, downloads and terminal keep using the existing `/d/<id>/`
proxy path, but the session's file references carry the virtual workspace ID so
the UI resolves them against the host. No second storage model.

### Security

- Edge embed tickets are one-time and device-targeted.
- The local projection never receives another host's device secret.
- Host prompts and tool calls are authorized by the approved host session.
- Projection data is discarded when the remote window/session closes.

## Phases

1. **Read-only**: workspace/session list and history in a native panel.
2. **Chat**: prompt send + streaming responses + cancel.
3. **Tools**: approvals, files, terminal, uploads.
4. **Polish**: auto-reconnect, offline state, search, archive.

Until phase 2 lands, v0.2.10's native child window is the supported remote
view; the broken iframe/webview paths are removed.