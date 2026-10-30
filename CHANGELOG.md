# Changelog

All notable changes to DSH RC. The project follows a `0.y.z` scheme until the
plugin and protocol are declared stable.

## v0.4.10 - 2026-10-30

- **Fix: in New Remote Session, the Project Folder, Model and Permissions menus opened behind the dialog.** They now open on top of it.
- **Fix: an empty box stayed under Permissions** after the dialog finished loading. It is gone.

## v0.4.9 - 2026-10-30

- **Fix: the main area could go blank.** Reading DeepSeek Harness's voice service failed on a computer where voice input is off, and that error took the whole remote conversation down. It is now safe, and any failure inside a remote conversation shows "This conversation could not be shown." with Try Again instead of an empty screen.
- **A turn's working steps fold into one row, like a local conversation.** Instead of a long list of edit, bash and Thinking rows, each turn shows one line such as "Edited files and Ran commands" (or "Running commands" with a spinner while it works); open it to see every step. The answer shows below.

## v0.4.8 - 2026-10-30

- **Send files to a remote session, like a local one.** The **+** button (or paste, or drag and drop onto the message box) attaches up to 10 files of up to 20 MB each. They show as chips with a preview or icon and an upload progress bar. Files travel to the other computer in pieces and are attached there the Harness's own way: images inline (their type is read from the file itself, never its name), other files through its upload service. Files stay on that computer only until the message is accepted, so a failed send can be retried; unfinished uploads are freed after a minute.
- **Dictate with the microphone, like a local session.** The microphone records on this computer and DeepSeek Harness's own voice input turns it into text here; only the text goes into the message box, and no audio leaves the computer. It shows a live level, a timer, Cancel and Stop, and stops at the voice input's length limit. It appears when voice input is turned on in Plugins on this computer.
- New peer calls `remote.uploadBegin`, `remote.uploadChunk` and `remote.uploadDiscard` (your own computers only). The other computer needs 0.4.8 or later to receive files; before that, the + button does not appear.

## v0.4.7 - 2026-10-30

- **A spinner while connecting, never a false "nothing here".** Remote Workspaces shows "Connecting to your computers…" or "Connecting to Peter-Portable…" with a spinner while it loads, instead of "None of your other computers can be opened right now" or an empty panel. A computer that keeps failing gets a plain reason after about 40 seconds, and a computer whose list refresh fails once keeps its sessions on screen. Each computer is asked separately, so one slow computer no longer delays the others.
- **Remote conversations look like local ones.** A centred spinner while the conversation connects; messages, thinking, tool calls and code blocks use DeepSeek Harness's own chat styles (bubble, content width, quiet tool and thinking rows with a chevron, indented output, code blocks). A running tool shows a small spinner; a failed one says Failed.

## v0.4.6 - 2026-10-30

- **The remote message box now looks like DeepSeek Harness's own.** One rounded card with the message field on top and a toolbar underneath: Permissions on the left, the model (with its release tag as a small pill, for example DeepSeek-V4.1-Flash **1017**) and effort on the right, and a round send button that turns into a stop button while the agent works. Attach and voice are left out because remote sessions cannot send files or audio.
- Verified against a real Windows host: its models, permissions and a session's current Full Access and Max effort come through.

## v0.4.5 - 2026-10-30

- **Fix: errors now show their real message.** Every failed DSH RC call showed "connection: invalid server-response failure" instead of what went wrong, because the replies lacked a field DeepSeek Harness requires. Now you see, for example, that a session is still working or a computer is offline.
- **Fix: subagent sessions are no longer listed as remote sessions.** Helper sessions started by another session (for example "You are the documentation engineer") appeared as ordinary sessions and could not be opened. They are left out, as in the local sidebar; forked sessions stay listed.

## v0.4.4 - 2026-10-30

- **Fix: a computer could get stuck on an old version for good.** When an automatic restart did not actually happen, the updater stayed in "restarting" forever and skipped every later update check, so the computer never got newer releases (seen on a Windows host stuck on 0.3.9). A restart that has not happened within 3 minutes now counts as failed: it is retried (still at most twice per release), update checks continue, and the panel says why, from the restart helper's own log.
- **Fix (Windows): the restart helper runs outside DeepSeek Harness's process tree**, so closing the app can no longer stop it before it reopens the app. It uses the app's own program as a fallback when the path cannot be read, and writes each step to `~/.dsh-rc/restart-helper.log`.
- **Remote sessions say why model, effort and permissions are missing** instead of hiding them: the other computer's version and its update status, with an **Update That Computer** button. That computer installs the latest release and restarts only when none of its sessions is working. A computer older than this release cannot be updated from afar: quit and reopen DeepSeek Harness on it once.
- New peer call `remote.update` (your own computers only, as for every host call).

## v0.4.3 - 2026-10-30

- **Fix: the message box of a remote conversation was squeezed** to a few characters wide (the placeholder wrapped, typing area unusable). It fills the full width again, with the Permissions and model controls underneath.
- **Tables in remote conversations render as tables**, like in a local session, instead of raw `| --- |` text. Wide tables scroll sideways inside the message.

## v0.4.2 - 2026-10-30

- **Remote sessions are configured like local ones.** New Remote Session is now a dialog with **Project Folder**, **Model and Reasoning Effort** and **Permissions**, starting on that computer's own defaults. In an open remote conversation, the same two controls as the local composer sit under the message box: Permissions on the left, model and effort on the right. Changes apply to the session's next message, the same way switching on that computer does (the model through the Harness's own model selection, permissions through its `/permission` command, so they are recorded in the session).
- Full Access (and Auto Review) asks for confirmation first, with the same warning as the local picker.
- A model change made from another computer also becomes that computer's default for new sessions, exactly as switching in its own composer does.
- Safe by design: new peer calls `remote.config`, `remote.selectModel` and `remote.setPermission` are for your own computers only (guests are refused at the edge, as for every host call). Every model, effort and preset is checked against that computer's own catalog before it reaches the Harness, and a new session is only created after its settings pass that check.
- A computer still on an older version keeps working: the dialog offers the folder only and says it updates by itself.

## v0.4.1 - 2026-10-30

- **Choose the project folder for a new remote session.** The **+** next to the computer picker opens Choose a Project Folder, listing every workspace on that computer in its own sidebar order, including folders with no sessions yet (it used to pick the first session's folder silently). Hover shows the full path. A computer still on an older version falls back to the folders known from its sessions. New peer call `remote.workspaces`; creating a session still only accepts a folder that computer already knows.
- **Any system can be the host.** Step 1 now works on macOS, Windows and Linux: Tailscale is installed if missing (Homebrew; the official static Linux build, checksum-checked, no sudo; winget on Windows), and the edge runs as a per-user background service (launchd; systemd user service with a cron fallback; a Scheduled Task at sign-in on Windows). `install.ps1` gains host mode (`DSHRC_MODE=host`).
- An unexpected failure during host setup ends with one plain line to act on instead of a stack trace.
- README: each step offers one universal prompt for DeepSeek Harness plus a ready-to-copy command for Windows, macOS and Linux.

## v0.4.0 - 2026-10-30

- **One prompt for the first computer.** `install.sh host <tag>` (new `scripts/host-setup.mjs`) sets up the host Mac end to end: Node 24, git and Tailscale (Homebrew) if missing, the Tailscale daemon as a user launchd agent, Tailscale sign-in and Funnel (it relays the approval links as ACTION NEEDED and waits), the edge and watchdog, the owner account with a generated password saved to `~/.dsh-rc/owner-password.txt` (0600, never printed), and the plugin with a DeepSeek Harness restart. Safe to run again.
- **Update pill in Remote Workspaces.** The same pill DeepSeek Harness uses for its own updates (geometry, brand blue, download and loading icons, wording): Update, a live install percentage, Restart to Update, Preparing to Restart…, Retry Update; tooltip with version and details; hidden when up to date. The installer now reports real progress.
- **Fix: restarts no longer cut DeepSeek Harness off mid-shutdown.** The automatic restart and the installer forced the app to quit 8 s after asking (on Windows at once). An app still shutting down could lose its login cookie and then fail to start with "desktop welcome: Web authentication failed". They now ask it to quit and wait up to 60 s for a clean exit, forcing only a truly stuck app (macOS and Windows).
- README front page: **Get started in two prompts** (host prompt, then the join prompt from Build Setup Prompt for every other computer).

## v0.3.9 - 2026-10-30

- **Fix (Windows): DeepSeek Harness could not start after setup.** The installer wrote the agent path into the profile's `cordis.patch.yml` inside YAML double quotes, so `C:\Users\...` turned `\U` into a Unicode escape and DeepSeek Harness stopped with "YAMLException: expected hexadecimal character". Values are now written as escaped strings that always read back exactly (`scripts/lib/patch-entry.mjs`), tested with a real YAML parser.
- **Repair:** run the setup command again (v0.3.9). It rewrites only the DSH RC block and leaves every other entry alone; DeepSeek Harness does not need to be running for it.

## v0.3.8 - 2026-10-30

- **Stays connected.** The agent no longer stops for good on anything except an owner's revocation:
  - a slow handshake is retried (the edge used to answer it with the "bad key" code, which agents treated as fatal);
  - a rejected key (edge reset, device deleted) registers a fresh, auto-approved identity, at most once per 10 minutes;
  - a protocol mismatch retries every minute while automatic updates catch up;
  - a crashed loop restarts itself;
  - the plugin retries every 5 minutes after any stop that used to be final.
- **Fast reconnect.** Sleep/wake and clock jumps are detected and the tunnel reconnects at once; the retry wait never exceeds 10 s (was 20 s).
- Panel copy: Add Another DeepSeek Harness, Setup Prompt (Paste into the Other Harness), and the hint no longer mentions an approval step.
- **One-command setup.** The setup prompt is now one line per OS. `scripts/install.sh` (macOS, Linux) and `scripts/install.ps1` (Windows) install Node 24 if needed (checksum verified), git if needed (winget on Windows) or fall back to the release download, then build, install, connect and restart DeepSeek Harness. Safe to re-run after any failure; pinned to the release tag; the edge URL is reduced to its origin so it cannot inject commands.

## v0.3.7 - 2026-10-30

- Automatic updates now work on every computer, Windows included. The host checks the latest GitHub release two minutes after DeepSeek Harness starts and then every hour, installs a newer release in the background with the new cross-platform `scripts/self-update.mjs` (it replaces `self-update.sh`, which could not run on Windows), and then restarts DeepSeek Harness by itself as soon as no session is running.
- Safe by design: one update at a time (lock file), only plain `vX.Y.Z` release tags, a development copy on a git branch is never touched, local edits are stashed rather than discarded, a failed build rolls back to the previous version, and automatic restarts stop after two tries per release so they can never loop. The update endpoints are local only; another computer cannot trigger them.
- The Remote Control panel shows an Updates row (up to date, installing, ready, restarting, or why it failed, with when it last checked) and **Check for Updates** and **Restart to Update** buttons.
- `DSHRC_AUTO_RESTART=0` keeps installs automatic but leaves the restart to you; `DSHRC_AUTO_UPDATE=0` turns updating off.
- Computers on v0.3.6 or older still need one manual update (paste the setup prompt, or quit and reopen DeepSeek Harness after `git checkout v0.3.7` and a build); from then on they stay current by themselves.

## v0.3.6 - 2026-10-29

- Remote Workspaces now uses the same design as DeepSeek Harness's own Workspaces list: identical row heights, spacing, type, colours and corner radius (from DSH's design tokens), the same folder, chevron and new-session icons, the folder-to-chevron swap on hover, a pin mark on pinned sessions, and the same time format (now, 34min, 5h, 1d).
- Label: New Session on This Computer.
- README screenshots refreshed.

## v0.3.5 - 2026-10-29

- Remote conversations are complete: long sessions load the newest part first and **Load Earlier Messages** pages back to the first prompt (it used to stop at the last 80 events). Context the Harness injects for the model (runtime, time, skill and teammate notes) no longer shows as your messages.
- Remote sessions have the local hover strip: **...** (Pin Session, Rename, Archive Session, Copy Session ID), Archive and Pin. Pinned sessions lead the list; archived ones are hidden. Archiving a session that is still working is refused.
- Button label: Build Setup Prompt.
- README: illustrated guide with new screenshots.

## v0.3.4 - 2026-10-29

- Remote workspaces fold and unfold like local ones: click a workspace (folder icon) to hide or show its sessions. The choice is remembered on that computer.

## v0.3.3 - 2026-10-29

- Remote Workspaces is no longer a fixed card under the sidebar. It is a plain section at the end of the Workspaces list and scrolls with it, like the local workspaces.

## v0.3.2 - 2026-10-29

- Remote Workspaces now says when an update is only half loaded (the sidebar is new but the background host still runs the old plugin) and asks you to quit and reopen DeepSeek Harness, instead of wrongly saying no computers can be opened.

## v0.3.1 - 2026-10-29

### Changed

- Remote Workspaces lists only computers you can open remotely: online, not
  this computer, and answering with their sessions (plugin v0.3.0 or later).
  Offline computers, this computer, and computers on older plugins are hidden.
- The selected computer's name is no longer repeated under the picker; **New
  Session** (+) and **Rename Computer** sit beside it. A single available
  computer is selected automatically.

## v0.3.0 - 2026-10-29

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

## v0.2.10 - 2026-10-29

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

## v0.2.9 - 2026-10-29

Attempted Electron webview remote view (superseded by v0.2.10).

## v0.2.8 - 2026-10-29

Remote Workspaces header control and modal redesign.

- Replaced the `via edge` badge with a borderless DSH-style **gear** button that
  opens Remote Control and carries the agent status as a dot.
- Removed the footer “Remote Control · Online” row.
- Remote Control modal widened to 600 px with a two-column status grid; error
  spans both columns.
- Installer now stashes a dirty checkout instead of discarding it.

## v0.2.7 - 2026-10-29

Plugin-load regression fix.

- The host bundle had `ws` bundled into ESM, crashing at import with
  `Dynamic require of "events" is not supported`. `ws` is external now and
  resolved from the installed dependency.
- Removed the leftover old `ds-harness-remote` plugin from the reference
  profile so it cannot conflict with `dsh-rc`.

## v0.2.6 - 2026-10-29

Click-to-use remote view attempt; zero-touch pairing.

- Added a loopback HTTP/WebSocket proxy with one-time edge embed tickets.
- Added `scripts/join-edge.mjs`, a cross-platform zero-touch installer that
  finds/installs Node 24, handles missing Git, rewrites the profile/patch
  idempotently, links the plugin and schedules a Harness restart.
- Iframe embedding was introduced here; it is superseded by v0.2.10.

## v0.2.5 - 2026-10-29

Remote Workspaces design and host-side new session.

- Remote Workspaces aligned with native Workspaces typography and row metrics.
- `+` opens `/d/<deviceId>/?dsh-rc-new=1`; the host plugin creates a session.

## v0.2.4 - 2026-10-29

Sidebar host switcher.

- Remote Control section lists approved Harnesses with online/offline state.
- Edge `GET /v1/devices/me/peers` returns metadata only; no secrets.

## v0.2.3 - 2026-10-29

Auto-approval cleanup.

- Removed the Manage/approve button and pending hint from the panel.
- Edge startup auto-approves pending Harnesses when
  `--auto-approve-devices` is enabled.

## v0.2.2 - 2026-10-29

Auto-approve, version display, auto-update.

- Harness registrations can be approved immediately
  (`--auto-approve-devices`).
- Plugin version shown in the modal; update state reported.
- Host checks GitHub releases on start and every six hours; `self-update.sh`
  updates the checkout, plugin and edge bundle.

## v0.2.1 - 2026-10-29

Prompt-only pairing and identifier cleanup.

- Removed pair URL, Copy/Open pair buttons, QR code, guest-sharing panel,
  invite link/QR and the failing sharing poll.
- Public edge renamed to `dsh-rc`; device label `DSH Desktop`.
- Join prompt uses `/v1/edge`, independent of sharing auth.

## v0.2.0 - 2026-10-28

Guest sharing and operations completion.

- Share toggle, invites, approval, multiple permanent guest sessions,
  Disconnect pill, revoke one/all, guest-scoped isolation.
- Edge dashboard sharing controls.
- `dsh-rc-edge-passwd`; legacy state-dir fallback.
- macOS launchd supervision and standalone edge bundle.

## v0.1.0 - 2026-10-28

First end-to-end release: protocol, mux, edge, agent, plugin, tests and docs.