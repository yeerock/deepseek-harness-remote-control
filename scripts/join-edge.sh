#!/bin/sh
# Backward-compatible wrapper; the real installer is cross-platform Node.
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
NODE_BIN=${DSHRC_NODE:-$(command -v node || true)}
[ -n "$NODE_BIN" ] || { printf 'join-edge: Node 24+ is required\n' >&2; exit 1; }
exec "$NODE_BIN" "$REPO/scripts/join-edge.mjs" "$@"
