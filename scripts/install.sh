#!/bin/sh
# DSH RC one-command setup for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/yeerock/deepseek-harness-remote-control/<tag>/scripts/install.sh | sh -s -- <edge-url> <tag>
#   curl -fsSL .../<tag>/scripts/install.sh | sh -s -- host <tag>     (the FIRST computer: runs the edge; macOS or Linux)
#
# Idempotent: safe to run again after any failure. It
#   1. finds Node 24+, or downloads the official Node 24 build into ~/.dsh-rc/node
#      (checksum verified against nodejs.org SHASUMS256.txt);
#   2. clones or updates ~/dsh-rc with git and checks out <tag> (falls back to the
#      release tarball); automatic updates move it forward from there;
#   3. runs scripts/join-edge.mjs: build, install into DeepSeek Harness, connect
#      to the edge (auto-approved) and restart DeepSeek Harness.
# The Node download is checked against nodejs.org's SHASUMS256.txt over HTTPS
# (integrity, not a signature check).
# No password, token or secret is used or stored by this script.
set -eu

REPO_URL=https://github.com/yeerock/deepseek-harness-remote-control
REPO_API=https://api.github.com/repos/yeerock/deepseek-harness-remote-control
EDGE=${1:-${DSHRC_EDGE:-}}
MODE=join
if [ "$EDGE" = host ]; then MODE=host; EDGE=http://127.0.0.1:8787; fi
TAG=${2:-${DSHRC_TAG:-}}
DEST=${DSHRC_HOME:-$HOME/dsh-rc}
STATE=$HOME/.dsh-rc

say() { printf '[dsh-rc setup] %s\n' "$*"; }
die() { printf '[dsh-rc setup] FAILED: %s\n' "$*" >&2; exit 1; }

case "$EDGE" in
  https://*|http://*) ;;
  *) die "usage: sh install.sh <edge-url> [vX.Y.Z]  (from the setup prompt)" ;;
esac
if [ -n "$TAG" ] && ! printf '%s' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then die "not a release tag: $TAG"; fi
command -v curl >/dev/null 2>&1 || die "curl is required"
mkdir -p "$STATE"

# 1. Node 24+
node_ok() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' >/dev/null 2>&1; }
NODE=""
for candidate in "${DSHRC_NODE:-}" "$(command -v node 2>/dev/null || true)" "$STATE/node/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && node_ok "$candidate"; then NODE=$candidate; break; fi
done
if [ -z "$NODE" ]; then
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "unsupported OS $(uname -s)" ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  base=https://nodejs.org/dist/latest-v24.x
  say "downloading Node 24 ($os-$arch)"
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(grep -o "node-v24[0-9.]*-$os-$arch\.tar\.gz" "$tmp/SHASUMS256.txt" | head -1)
  [ -n "$file" ] || die "no Node 24 build listed for $os-$arch"
  curl -fsSL --retry 3 "$base/$file" -o "$tmp/$file"
  want=$(grep " $file\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)
  if command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1); else got=$(sha256sum "$tmp/$file" | cut -d' ' -f1); fi
  [ "$want" = "$got" ] || die "Node download checksum mismatch"
  rm -rf "$STATE/node" && mkdir -p "$STATE/node"
  tar -xzf "$tmp/$file" -C "$STATE/node" --strip-components=1
  rm -rf "$tmp"
  NODE=$STATE/node/bin/node
  node_ok "$NODE" || die "downloaded Node does not run"
fi
PATH="$(dirname "$NODE"):$PATH"; export PATH
say "node $("$NODE" -v) at $NODE"

# 2. Source
if command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; then
  if [ -d "$DEST/.git" ]; then
    say "updating $DEST"
    git -C "$DEST" fetch --tags --force --quiet origin || die "git fetch failed (network?)"
  else
    [ -e "$DEST" ] && mv "$DEST" "$DEST.bak-$(date +%Y%m%d%H%M%S)"
    say "cloning into $DEST"
    git clone --quiet "$REPO_URL" "$DEST" || die "git clone failed (network?)"
  fi
  # Switch to the release first, so its own (current) installer runs below.
  [ -n "$TAG" ] || TAG=$(git -C "$DEST" tag --list 'v*' --sort=-v:refname | head -1)
  [ -n "$TAG" ] || die "no release tag found"
  if [ -n "$(git -C "$DEST" status --porcelain)" ]; then
    say "local changes in $DEST set aside with git stash"
    git -C "$DEST" stash push --include-untracked --quiet -m "dsh-rc setup $(date +%Y%m%d%H%M%S)"
  fi
  git -C "$DEST" checkout --quiet -f "refs/tags/$TAG" || die "release $TAG not found"
elif [ -f "$DEST/scripts/join-edge.mjs" ] && [ -z "$TAG" ]; then
  say "git not found; reusing the copy in $DEST"
else
  tag=$TAG
  [ -n "$tag" ] || tag=$(curl -fsSL --retry 3 "$REPO_API/releases/latest" | sed -n 's/.*"tag_name": *"\(v[0-9.]*\)".*/\1/p' | head -1)
  [ -n "$tag" ] || die "could not read the latest release"
  say "git not found; downloading $tag (install git later for automatic updates)"
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 "$REPO_URL/archive/refs/tags/$tag.tar.gz" -o "$tmp/src.tar.gz" || die "download failed (network?)"
  mkdir -p "$tmp/src" && tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components=1 || die "download is damaged"
  [ -e "$DEST" ] && mv "$DEST" "$DEST.bak-$(date +%Y%m%d%H%M%S)"
  mv "$tmp/src" "$DEST" && rm -rf "$tmp"
fi

# 3. Build, install, connect, restart
if [ -n "$TAG" ]; then set -- --tag "$TAG"; else set --; fi
if [ "$MODE" = host ]; then
  "$NODE" "$DEST/scripts/host-setup.mjs" "$@" || die "host setup stopped (see above); fix the cause and run this command again"
  say "DONE: this computer is the host. Other computers join with the prompt from Remote Control, Build Setup Prompt."
  exit 0
fi
"$NODE" "$DEST/scripts/join-edge.mjs" "$EDGE" "$@" || die "install step failed (see above); fix the cause and run this command again"
say "DONE: DeepSeek Harness restarts now and connects to $EDGE by itself."
