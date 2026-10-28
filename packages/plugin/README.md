# Remote Control — DeepSeek Harness plugin

Host plugin + browser half that expose this DeepSeek Harness through a
self-hosted **DSH Link edge**. The plugin starts and supervises the tunnel
agent, hands it the DSH launch URL without putting the token in `argv`, and
adds a **Remote Control** entry to the sidebar with live state, a pair URL, a QR
code, and start/restart/stop controls.

- DSH target: **0.2.1-rc.3** (`engines.dsh: ">=0.2.1-rc.3 <0.3.0"`)
- Node: **>= 22.5**
- No runtime dependencies: both bundles are built from this package only.

## What gets installed

| File | Role |
| --- | --- |
| `dist/index.js` | Host half (ESM bundle). Registers the `dsh-link` service, the authenticated RPC route, and the agent supervisor. |
| `dist/client.js` | Client half (classic script). Calls `window.__ModuleLoader__.load({ id: '@dsh-link/plugin', factory })` and registers a `sidebar.footer.action`. |
| `cordis.patch.yml` | Bundle patch that inserts the `dsh-link` loader entry. |
| `dsh-plugin.json` | Plugin manifest (`manifestVersion` 0.15, host facet `dist/index.js`, `apiVersion` v1alpha1). |
| `locale/{en,zh}.json` | Plugin title/description for the plugin inventory. |

`package.json` carries the DSH metadata:

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-renderer",
      "@deepseek-ai/dsh-client-ui-sidebar"
    ],
    "platform": "web"
  }
}
```

and `exports["./client"]` points at `dist/client.js`, which is how the client
module registry resolves the browser bundle.

## Install into a profile

The plugin is installed like any other DSH plugin; `link:` installs from a
checkout (run from the repository root):

```bash
dsh plugin --profile <profile> add link:/abs/path/dsh-link/packages/plugin
```

This adds `@dsh-link/plugin` to the profile's `package.json` **and** appends
`@dsh-link/plugin` to `dsh.profile.bundles`, so its `cordis.patch.yml` becomes
one of the profile's patch layers. Confirm the entry composed:

```bash
dsh --profile <profile> --dump-config | grep -A8 'dsh-link'
```

Defaults from the bundle patch: `enabled: false`, `edgeUrl:
http://127.0.0.1:8787`, `deviceName: ''` (machine hostname), `autoStart:
true`. Installing the plugin therefore starts nothing and changes no remote
reachability until you enable it in the profile's own patch layer.

### Enable it

Edit `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (the user layer applied
after every bundle layer):

```yaml
- id: dsh-link
  config:
    enabled: true
    autoStart: true
    edgeUrl: 'https://edge.example.com'
    deviceName: 'studio-mac'
    # Optional: explicit agent entry (default: resolve from the package/repo).
    agentEntry: '/Users/me/dsh-link/apps/agent/dist/main.js'
    # insecure: false            # force/disable the agent --insecure flag
    # logLevel: info             # debug | info | warn | error
    # stateDir: '/custom/dsh-home'  # overrides DSH home; final dir is <stateDir>/link
```

or boot once with an overlay instead of editing the profile:

```bash
dsh --profile <profile> --patch ./dsh-link.yml web --port 0 --no-open
```

`enabled: false` keeps the service and sidebar panel available; **Start** /
**Restart** in the panel still run the agent manually.

## How the plugin finds and runs the agent

Launch target resolution order:

1. `agentEntry` config (a `.js`/`.mjs` entry, a directory containing
   `dist/main.js`, or a command such as `dsh-link-agent` on `PATH`).
2. `$DSH_LINK_AGENT`.
3. `apps/agent/dist/main.js` relative to the plugin/repo checkout.
4. `dsh-link` on `PATH`.

The Node runtime for a JavaScript entry is chosen as: `$DSH_LINK_NODE`, then
`$DSH_NODE`, then the DSH desktop runtime wrapper
(`<resources>/runtime/bin/node`), then `process.execPath` with
`ELECTRON_RUN_AS_NODE=1`. The Electron flag matters: in the desktop app
`process.execPath` is the Electron binary, and without the flag spawning it
opens another application instance instead of running the agent.

Spawned argv (exact shape):

```
<node> <agent-entry> --edge <edgeUrl> --dsh-url-file <stateDir>/upstream.json \
  --state-dir <stateDir> --name <deviceName> --status-file <stateDir>/status.json \
  --log-level <level> [--insecure]
```

`--insecure` is added by default when `edgeUrl` is `http://`; override with
the `insecure` config key.

### Credential handoff

The DSH authenticated URL contains the process launch token. The plugin:

1. creates `<stateDir>` with mode `0700`,
2. writes `<stateDir>/upstream.json` atomically with mode `0600`:
   `{"url":"http://127.0.0.1:<port>/?token=…","createdAt":<ms>}`,
3. rewrites it on every (re)start (the token changes per DSH process),
4. deletes it when the agent stops, crashes, or the plugin is disposed.

The URL is never passed in `argv`, never logged, and never returned to the
browser. The agent reads the file once and keeps the exchanged cookie in
memory.

## Status and control

- Source of truth: the agent's atomic `<stateDir>/status.json`
  (`AgentStatus` from `apps/agent`), read once per second. The pair URL comes
  from `pairUrl` in that file; stdout (`DSH_LINK_PAIR_URL=<url>` or JSON
  status lines) is a fallback only.
- Supervision: exit code 1 with an `error` status is terminal (revoked
  device, auth/protocol failure, state-dir lock) and is **not** retried; other
  exits restart with full-jitter backoff 500 ms → 30 s, and restarts are
  counted.
- API (host): the `dsh-link` service exposes `status()`, `pairUrl()`,
  `start()`, `restart()`, `stop()`.
- API (browser): authenticated `POST /dsh-link/<endpoint>` with the DSH
  connection RPC envelope; endpoints `status`, `start`, `restart`, `stop`,
  `pair-url`. Unauthenticated requests get 401/403.

## Sidebar panel

A **Remote Control** row in the sidebar footer shows a state dot and label
(Starting / Pairing / Connecting / Online / Reconnecting / Error / Stopped).
Clicking opens a modal with:

- state, device name, edge URL, device ID, latency, reconnects, restarts,
  up time, agent entry, PID, last error;
- while the agent is **pairing** (or an error keeps a fresh code alive): the
  pair URL with **Copy** and **Open**, plus a locally generated QR code for it
  (byte-mode QR, ECC M, versions 1–9, rendered as inline SVG). The QR opens
  the pairing link in another browser — scanning it on a phone is possible
  with any camera app, but DSH Link ships no mobile client and does not
  support mobile browsers;
- once paired (`online` / `connecting` / `reconnecting`) the panel shows
  **Paired** with the device id instead of the consumed pair code and QR. A
  pair code is single-use, so an actionable-looking dead QR would be a
  support trap; restart the agent to issue a fresh code;
- **Start**, **Restart**, **Stop**.

If the host half is not loaded (or its RPC route failed), the panel says
"Host service unavailable" and disables the actions instead of throwing. The
panel polls every 4 s closed / 1.5 s open.

## Build and test

```bash
npx tsc -b packages/plugin
npx vitest run packages/plugin
node packages/plugin/scripts/build.mjs   # dist/index.js + dist/client.js
```

The QR encoder is verified module-for-module against the independent
`qrcode` npm package in `packages/plugin/tests/qr.test.ts`; the supervisor's
Electron environment construction is covered by
`packages/plugin/tests/env.test.ts`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Sidebar says "Host service unavailable" | `dsh --profile <p> --dump-config` shows the `dsh-link` entry? Look for `plugin-error.json` in `<stateDir>`; boot logs report a failed fiber. |
| State `error`, "Agent entry not found" | Build the agent (`npx tsc -b apps/agent`) or set `agentEntry` / `DSH_LINK_AGENT`; the status row shows the resolved entry. |
| Agent exits immediately in the desktop app | Set `DSH_LINK_NODE` to a real Node binary, or make sure the runtime wrapper exists; the supervisor already sets `ELECTRON_RUN_AS_NODE=1` for `process.execPath`. Check the last exit code and `lastError`. |
| `another agent is already running for this state dir` | One agent per `stateDir`. Stop the other process or give each profile a distinct `stateDir`. |
| Pair code expired or was already used | Codes are single-use and short-lived. **Restart** in the panel (or delete `<stateDir>/device.json` to re-register) to get a fresh pair URL. |
| State stuck at `pairing` | Approve the device on the edge: open the pair URL as the owner (or the edge dashboard) and confirm the code. |
| `error` with a 401 from DSH | The agent could not exchange the launch URL for a cookie. Restart the agent; if it persists, the DSH process token changed and the plugin needs a fresh `authenticatedUrl`. |
| QR does not render | The payload exceeded the encoder's capacity (about 180 bytes). Copy/Open still work. |

## Known limitations

- The sidebar panel is the settings surface; there is no DSH settings-page
  form yet (config lives in `cordis.patch.yml`).
- The client half has no settings page, no push stream, and polls status.
- The QR encoder is byte-mode/ECC M/version ≤ 9; it is intentionally small
  rather than a full ISO implementation.
- `agentEntry` pointing at a TypeScript source file is not supported; build
  the agent first (`dist/main.js`) or use a runtime that accepts TS.
## Creator

**Ts. Dr. Leong Yee Rock** — creator and maintainer.
VYROX International Sdn Bhd (VYROX AI), Malaysia.
