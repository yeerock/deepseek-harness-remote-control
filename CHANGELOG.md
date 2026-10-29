# Changelog

All notable changes to DSH RC. The project follows a `0.y.z` scheme until the
plugin and protocol are declared stable.

## v0.3.0 — 2026-10-29

Remote sessions open like local ones.

### Added

- **Remote conversation panel.** Clicking a remote session opens its
  conversation in DSH's main area (the `main` slot), where local conversations
  open: messages, collapsible reasoning, tool calls, a composer, **Stop** while
  the remote agent works, and **+** to start a session in a remote workspace.
  The session keeps running on the computer that owns it.
- **Host picker.** Remote Workspaces asks you to **Select a Computer** first and
  lists only that computer's sessions, grouped by workspace. The computer you
  are on is not listed.
- **Share This Computer** switch in the Remote Control panel (persisted).
- **Rename** computers and sessions by double-clicking them. New edge endpoint
  `POST /v1/devices/:id/rename` (device-authenticated, validated, audited).
- Host RPCs `remote.list`, `remote.history`, `remote.prompt`, `remote.cancel`,
  `remote.create`, `remote.renameSession`; the owning computer reduces history
  to a compact transcript, so raw request headers never cross the edge.
- macOS: the Mac is kept from idle-sleeping while sharing (`caffeinate`);
  `scripts/dsh-watchdog.sh` relaunches DeepSeek Harness at login or if it quits.

### Fixed

- A plugin reload no longer leaves the agent stopped: the new instance waits
  for the old one to finish tearing down, and agent-lock contention is retried.
- Offline computers are refused with a message instead of opening a
  "Device offline" page.
- The non-working native-window path was removed; Open Full View uses DSH's
  own Browser tab.

### Upgrade

Both computers need v0.3.0 for remote sessions to list and open.

## v0.2.10 — 2026-10-29

Native remote window; embedding experiments removed.

### Fixed

- DSH blocks arbitrary iframes (client stalls at “Loading plugins…”) and
  arbitrary `<webview>` tags (main-process lease policy). Both remote-view
  embedding paths were removed.
- A remote host now opens in a **native Electron child `BrowserWindow`**
  parented to DSH, loading the authenticated loopback proxy. The full Harness
  UI boots: sessions, chat, files, uploads, terminal and WebSocket. No edge
  login page, no Safari/browser tab.
- The child window falls back to a normal window only when Electron itself is
  unavailable.

### Added

- [ADR-0002](docs/adr/0002-native-remote-sessions.md): the design for true
  in-sidebar remote sessions via a host RPC projection, with virtual workspace
  and session IDs, streaming prompts, approvals and file/terminal routing.

### Verification

- 290 automated tests; CI green.
- The proxy URL boots the complete remote UI top-level; the native window is
  the supported v0.2.10 path.

## v0.2.9 — 2026-10-29

Attempted Electron webview remote view (superseded by v0.2.10).

## v0.2.8 — 2026-10-29

Remote Workspaces header control and modal redesign.

- Replaced the `via edge` badge with a borderless DSH-style **gear** button that
  opens Remote Control and carries the agent status as a dot.
- Removed the footer “Remote Control · Online” row.
- Remote Control modal widened to 600 px with a two-column status grid; error
  spans both columns.
- Installer now stashes a dirty checkout instead of discarding it.

## v0.2.7 — 2026-10-29

Plugin-load regression fix.

- The host bundle had `ws` bundled into ESM, crashing at import with
  `Dynamic require of "events" is not supported`. `ws` is external now and
  resolved from the installed dependency.
- Removed the leftover old `ds-harness-remote` plugin from the reference
  profile so it cannot conflict with `dsh-rc`.

## v0.2.6 — 2026-10-29

Click-to-use remote view attempt; zero-touch pairing.

- Added a loopback HTTP/WebSocket proxy with one-time edge embed tickets.
- Added `scripts/join-edge.mjs`, a cross-platform zero-touch installer that
  finds/installs Node 24, handles missing Git, rewrites the profile/patch
  idempotently, links the plugin and schedules a Harness restart.
- Iframe embedding was introduced here; it is superseded by v0.2.10.

## v0.2.5 — 2026-10-29

Remote Workspaces design and host-side new session.

- Remote Workspaces aligned with native Workspaces typography and row metrics.
- `+` opens `/d/<deviceId>/?dsh-rc-new=1`; the host plugin creates a session.

## v0.2.4 — 2026-10-29

Sidebar host switcher.

- Remote Control section lists approved Harnesses with online/offline state.
- Edge `GET /v1/devices/me/peers` returns metadata only; no secrets.

## v0.2.3 — 2026-10-29

Auto-approval cleanup.

- Removed the Manage/approve button and pending hint from the panel.
- Edge startup auto-approves pending Harnesses when
  `--auto-approve-devices` is enabled.

## v0.2.2 — 2026-10-29

Auto-approve, version display, auto-update.

- Harness registrations can be approved immediately
  (`--auto-approve-devices`).
- Plugin version shown in the modal; update state reported.
- Host checks GitHub releases on start and every six hours; `self-update.sh`
  updates the checkout, plugin and edge bundle.

## v0.2.1 — 2026-10-29

Prompt-only pairing and identifier cleanup.

- Removed pair URL, Copy/Open pair buttons, QR code, guest-sharing panel,
  invite link/QR and the failing sharing poll.
- Public edge renamed to `dsh-rc`; device label `DSH Desktop`.
- Join prompt uses `/v1/edge`, independent of sharing auth.

## v0.2.0 — 2026-10-28

Guest sharing and operations completion.

- Share toggle, invites, approval, multiple permanent guest sessions,
  Disconnect pill, revoke one/all, guest-scoped isolation.
- Edge dashboard sharing controls.
- `dsh-rc-edge-passwd`; legacy state-dir fallback.
- macOS launchd supervision and standalone edge bundle.

## v0.1.0 — 2026-10-28

First end-to-end release: protocol, mux, edge, agent, plugin, tests and docs.