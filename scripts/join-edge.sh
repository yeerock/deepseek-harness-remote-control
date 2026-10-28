#!/bin/sh
# Join this DeepSeek Harness to an existing DSH RC edge as a host.
#
#   scripts/join-edge.sh <edge-url> [device-name]
#
# Installs the plugin into the profile this machine already uses, points the
# agent at the edge, and prints the restart step. No owner password, no invite
# token, no device secret is read or written here. The edge owner still approves
# the device after it registers.
set -eu

EDGE_URL=${1:-${DSHRC_EDGE_URL:-}}
DEVICE_NAME=${2:-${DSHRC_DEVICE_NAME:-$(hostname)}}
[ -n "$EDGE_URL" ] || { printf 'usage: %s <edge-url> [device-name]\n' "$0" >&2; exit 2; }
case "$EDGE_URL" in
  https://*|http://*) : ;;
  *) printf 'join-edge: edge URL must be http(s), got %s\n' "$EDGE_URL" >&2; exit 2 ;;
esac
EDGE_URL=${EDGE_URL%/}

REPO=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR=${HOME:?HOME is not set}
NODE_BIN=${DSHRC_NODE:-$(command -v node || true)}
[ -n "$NODE_BIN" ] || { printf 'join-edge: Node 24 LTS is required\n' >&2; exit 1; }
"$NODE_BIN" -e 'const [a]=process.versions.node.split(".").map(Number); if(a<24) process.exit(1)' \
  || { printf 'join-edge: Node 24+ is required (found %s)\n' "$("$NODE_BIN" -v)" >&2; exit 1; }

printf 'join-edge: building %s\n' "$REPO"
cd "$REPO"
if [ -f package-lock.json ] && [ ! -d node_modules ]; then npm ci; else npm install; fi
npm run build

# Pick the profile the running Harness uses. DSH_PROFILE overrides.
PROFILE=${DSHRC_PROFILE:-}
if [ -z "$PROFILE" ]; then
  if [ -f "$HOME_DIR/.dsh/profiles/desktop/package.json" ] && pgrep -f 'dsh-desktop-host' >/dev/null 2>&1; then
    PROFILE=desktop
  elif [ -f "$HOME_DIR/.dsh/profiles/web/package.json" ]; then
    PROFILE=web
  else
    PROFILE=desktop
  fi
fi
PROFILE_DIR="$HOME_DIR/.dsh/profiles/$PROFILE"
[ -f "$PROFILE_DIR/package.json" ] || { printf 'join-edge: profile %s not found at %s\n' "$PROFILE" "$PROFILE_DIR" >&2; exit 1; }

PLUGIN_PATH="$REPO/packages/plugin"
AGENT_ENTRY="$REPO/apps/agent/dist/main.js"

printf 'join-edge: installing @dsh-rc/plugin into profile %s\n' "$PROFILE"
if [ "$PROFILE" = desktop ] || ! command -v dsh >/dev/null 2>&1; then
  # The Electron desktop profile is managed by the app; edit it directly and
  # make the link resolvable even if pnpm is not on PATH.
  "$NODE_BIN" - "$PROFILE_DIR/package.json" "$PLUGIN_PATH" <<'NODE'
const fs = require('node:fs');
const [file, plugin] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.dependencies = manifest.dependencies ?? {};
manifest.dependencies['@dsh-rc/plugin'] = `link:${plugin}`;
manifest.dsh = manifest.dsh ?? {};
manifest.dsh.profile = manifest.dsh.profile ?? {};
const bundles = manifest.dsh.profile.bundles ?? [];
if (!bundles.includes('@dsh-rc/plugin')) bundles.push('@dsh-rc/plugin');
manifest.dsh.profile.bundles = bundles;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
  PNPM="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
  if [ -f "$PNPM" ]; then
    (cd "$PROFILE_DIR" && "$NODE_BIN" "$PNPM" install >/dev/null 2>&1) || printf 'join-edge: pnpm install failed; using a direct link\n' >&2
  fi
  mkdir -p "$PROFILE_DIR/node_modules/@dsh-rc"
  ln -sfn "$PLUGIN_PATH" "$PROFILE_DIR/node_modules/@dsh-rc/plugin"
else
  dsh plugin --profile "$PROFILE" add "link:$PLUGIN_PATH"
fi

PATCH="$PROFILE_DIR/cordis.patch.yml"
if grep -q '^- id: dsh-rc$' "$PATCH" 2>/dev/null; then
  printf 'join-edge: dsh-rc entry already present; leaving it untouched\n'
else
  # A fresh profile's patch layer is the literal `[]`. Appending a list entry
  # after it would create a second YAML document; drop the empty list first.
  if grep -q '^[[:space:]]*\[\][[:space:]]*$' "$PATCH" 2>/dev/null; then
    grep -v '^[[:space:]]*\[\][[:space:]]*$' "$PATCH" > "$PATCH.tmp"
    mv "$PATCH.tmp" "$PATCH"
  fi
  {
    printf '\n- id: dsh-rc\n  config:\n'
    printf '    enabled: true\n    edgeUrl: "%s"\n    deviceName: "%s"\n' "$EDGE_URL" "$DEVICE_NAME"
    printf '    autoStart: true\n    agentEntry: "%s"\n    logLevel: info\n' "$AGENT_ENTRY"
  } >> "$PATCH"
  printf 'join-edge: appended dsh-rc to %s\n' "$PATCH"
fi

printf '\njoin-edge: installed. Restart DeepSeek Harness, then check:\n'
printf '  cat ~/.dsh/rc/status.json\n'
printf 'The edge auto-approves paired Harnesses; no dashboard approval is needed.\n'