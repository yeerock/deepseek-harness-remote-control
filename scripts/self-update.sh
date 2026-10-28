#!/bin/sh
# Apply the latest tagged DSH RC release to this checkout.
#
# Called by the host plugin (detached) when GitHub reports a newer release.
# Safe to run by hand: scripts/self-update.sh [vX.Y.Z]
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
HOME_DIR=${HOME:?HOME is not set}
NODE_BIN=${DSHRC_NODE:-$(command -v node || true)}
[ -n "$NODE_BIN" ] || { printf 'self-update: node not found\n' >&2; exit 1; }
"$NODE_BIN" -e 'const [a]=process.versions.node.split(".").map(Number); if(a<24) process.exit(1)' \
  || { printf 'self-update: Node 24+ required\n' >&2; exit 1; }

TAG=${1:-${DSHRC_UPDATE_TAG:-}}
git fetch --tags --force origin
if [ -z "$TAG" ]; then
  TAG=$(git tag --list 'v*' --sort=-v:refname | head -1)
fi
[ -n "$TAG" ] || { printf 'self-update: no release tag found\n' >&2; exit 1; }
CURRENT=$("$NODE_BIN" -p "require('./package.json').version")
if [ "$TAG" = "v$CURRENT" ]; then
  printf 'self-update: already at %s\n' "$TAG"
  exit 0
fi
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { printf 'self-update: tag %s missing\n' "$TAG" >&2; exit 1; }

printf 'self-update: %s -> %s\n' "$CURRENT" "$TAG"
git checkout -f "$TAG"
PATH="$(dirname "$NODE_BIN"):$PATH" npm ci
PATH="$(dirname "$NODE_BIN"):$PATH" npm run build
PATH="$(dirname "$NODE_BIN"):$PATH" npm run build:bundle

if [ -d "$HOME_DIR/Library/Application Support/dsh-rc/edge" ]; then
  cp "$REPO/build/edge/main.cjs" "$HOME_DIR/Library/Application Support/dsh-rc/edge/main.cjs"
  if command -v launchctl >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/com.dshrc.edge" 2>/dev/null || true
  fi
fi

mkdir -p "$HOME_DIR/.dsh-rc"
printf '{"updatedAt":%s,"tag":"%s","ok":true}\n' "$(date +%s000)" "$TAG" > "$HOME_DIR/.dsh-rc/update-status.json"
printf 'self-update: installed %s; restart DeepSeek Harness\n' "$TAG"