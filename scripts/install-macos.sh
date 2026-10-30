#!/bin/sh
# Install a macOS host for DSH RC: edge bundle + launchd user agents for the
# edge and Tailscale userspace daemon. Does not touch the DSH profile; install
# the plugin separately with `dsh plugin add`.
#
#   DSHRC_PUBLIC_URL=https://your-name.tailnet.ts.net ./scripts/install-macos.sh
#
# Requirements: Node >= 24.0, Tailscale CLI (`brew install tailscale`), and a
# tailnet with Funnel enabled. Runs entirely as the current user; no sudo.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR=${HOME:?HOME is not set}
NODE_BIN=${DSHRC_NODE:-$(command -v node || true)}
TS_BIN=${DSHRC_TAILSCALE:-$(command -v tailscale || true)}
TS_DAEMON=${DSHRC_TAILSCALED:-$(command -v tailscaled || true)}
PUBLIC_URL=${DSHRC_PUBLIC_URL:-}
DATA_DIR=${DSHRC_DATA_DIR:-$HOME_DIR/.dsh-rc/edge}
TS_DIR=${DSHRC_TS_DIR:-$HOME_DIR/.dsh-rc/tailscale}
APP_DIR="$HOME_DIR/Library/Application Support/dsh-rc/edge"
AGENTS="$HOME_DIR/Library/LaunchAgents"

say() { printf '%s\n' "$*"; }
die() { printf 'dsh-rc install: %s\n' "$*" >&2; exit 1; }

[ -n "$NODE_BIN" ] || die "node not found; install Node 24 LTS and retry"
case "$HOME_DIR$NODE_BIN" in *[\"\$\`]*) die "home folder or node path contains a quote, \$ or backtick; use a plain path" ;; esac
NODE_VERSION=$("$NODE_BIN" -p 'process.versions.node')
say "node $NODE_VERSION ($NODE_BIN)"
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<24) process.exit(1)' \
  || die "Node >= 24.0 is required (24 LTS recommended)"

[ -n "$PUBLIC_URL" ] || die "set DSHRC_PUBLIC_URL, e.g. https://machine.tailnet.ts.net"
case "$PUBLIC_URL" in
  https://*) : ;;
  *) die "DSHRC_PUBLIC_URL must be an https:// URL" ;;
esac
command -v lsof >/dev/null 2>&1 || true

say "building workspace and standalone edge bundle"
cd "$REPO"
npm run build
"$NODE_BIN" scripts/build-edge-bundle.mjs
mkdir -p "$APP_DIR" "$DATA_DIR" "$TS_DIR" "$AGENTS"
cp "$REPO/build/edge/main.cjs" "$APP_DIR/main.cjs"

cat > "$HOME_DIR/.dsh-rc/run-edge.sh" <<RUN
#!/bin/sh
set -eu
export HOME=$HOME_DIR
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd "$APP_DIR"
exec "$NODE_BIN" main.cjs \\
  --host 127.0.0.1 --port 8787 \\
  --data-dir "$DATA_DIR" \\
  --public-url "$PUBLIC_URL" \\
  --trust-proxy --auto-approve-devices --log-level info >> "$DATA_DIR/edge.log" 2>&1
RUN
chmod +x "$HOME_DIR/.dsh-rc/run-edge.sh"

cat > "$AGENTS/com.dshrc.edge.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dshrc.edge</string>
  <key>ProgramArguments</key><array><string>$HOME_DIR/.dsh-rc/run-edge.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA_DIR/edge.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/edge.log</string>
</dict></plist>
PLIST

launchctl bootout "gui/$(id -u)" "$AGENTS/com.dshrc.edge.plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.dshrc.edge.plist"
say "edge agent loaded (com.dshrc.edge)"

if [ "${DSHRC_SKIP_TAILSCALED:-}" = 1 ]; then
  say "tailscaled agent left as is (managed by host-setup)"
elif [ -n "$TS_BIN" ] && [ -n "$TS_DAEMON" ]; then
  cat > "$AGENTS/com.dshrc.tailscaled.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dshrc.tailscaled</string>
  <key>ProgramArguments</key><array>
    <string>$TS_DAEMON</string>
    <string>--tun=userspace-networking</string>
    <string>--state=$TS_DIR/tailscaled.state</string>
    <string>--socket=$TS_DIR/tailscaled.sock</string>
    <string>--port=41641</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$TS_DIR/tailscaled.log</string>
  <key>StandardErrorPath</key><string>$TS_DIR/tailscaled.log</string>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)" "$AGENTS/com.dshrc.tailscaled.plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.dshrc.tailscaled.plist"
  say "tailscaled agent loaded (com.dshrc.tailscaled)"
  say "next: $TS_BIN --socket=$TS_DIR/tailscaled.sock up --hostname=<name>"
  say "      $TS_BIN --socket=$TS_DIR/tailscaled.sock funnel --bg 8787"
else
  say "Tailscale CLI not found; skipping the tailscaled agent"
fi

say ""
say "Edge data:     $DATA_DIR"
say "Edge bundle:   $APP_DIR/main.cjs"
say "Setup:         http://127.0.0.1:8787/setup"
say "Public URL:    $PUBLIC_URL"
say "Plugin:        dsh plugin --profile <profile> add link:$REPO/packages/plugin"
say "Then enable the dsh-rc entry with edgeUrl http://127.0.0.1:8787."
# Watchdog: relaunch DeepSeek Harness at login / if it is not running, so the
# remote host comes back by itself after a reboot or a quit.
cp "$(dirname "$0")/dsh-watchdog.sh" "$HOME/.dsh-rc/dsh-watchdog.sh"
chmod 755 "$HOME/.dsh-rc/dsh-watchdog.sh"
cat > "$AGENTS/com.dshrc.watchdog.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dshrc.watchdog</string>
  <key>ProgramArguments</key><array><string>$HOME/.dsh-rc/dsh-watchdog.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>120</integer>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)" "$AGENTS/com.dshrc.watchdog.plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.dshrc.watchdog.plist"
