#!/bin/sh
# Digital Bahi on macOS and Linux:
#
#   ./digitalbahi.sh [start]   set up if needed, start, open the app
#   ./digitalbahi.sh stop | restart | status
#
# Gets Node.js 22 when this computer has none (from nodejs.org, checked
# against its SHA-256, into the data folder), then runs launcher/launcher.mjs,
# which sets up PostgreSQL and the server (see launcher.mjs).
#
# Run from the source checkout (installer/unix/digitalbahi.sh) it first builds
# Digital Bahi for this computer into the data folder (app/), and again with
# "install" after the checkout changed (git pull).
set -eu

NODE_VERSION=22.23.3
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

case "$(uname -s)" in
  Darwin) OS=darwin; DEFAULT_HOME="$HOME/Library/Application Support/DigitalBahi" ;;
  Linux) OS=linux; DEFAULT_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/digitalbahi" ;;
  *) echo "  Digital Bahi runs on macOS, Linux and Windows; this is $(uname -s)." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) echo "  Digital Bahi needs a 64-bit Intel/AMD or ARM computer; this is $(uname -m)." >&2; exit 1 ;;
esac
DIGITALBAHI_HOME="${DIGITALBAHI_HOME:-$DEFAULT_HOME}"
export DIGITALBAHI_HOME
RUNTIME="$DIGITALBAHI_HOME/runtime"
COMMAND="${1:-start}"

case "$OS-$ARCH" in
  linux-x64) NODE_SHA256=1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af ;;
  linux-arm64) NODE_SHA256=5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2 ;;
  darwin-x64) NODE_SHA256=8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8 ;;
  darwin-arm64) NODE_SHA256=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53 ;;
esac

say() { echo "  $*"; }
die() { echo "" >&2; echo "  $*" >&2; exit 1; }

node_ok() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

find_node() {
  NODE="$RUNTIME/node-v$NODE_VERSION-$OS-$ARCH/bin/node"
  [ -x "$NODE" ] && return 0
  if command -v node >/dev/null 2>&1 && node_ok node; then NODE=$(command -v node); return 0; fi
  case "$COMMAND" in start | restart | install) ;; *) say "Digital Bahi has not been set up on this computer yet."; exit 0 ;; esac
  say "Downloading Node.js $NODE_VERSION (about 30 MB, only this once)..."
  mkdir -p "$RUNTIME"
  archive="$RUNTIME/node-v$NODE_VERSION-$OS-$ARCH.tar.gz"
  curl -fL --progress-bar -o "$archive" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$OS-$ARCH.tar.gz" ||
    die "Could not download Node.js. Check the internet connection, then start Digital Bahi again."
  if [ "$(sha256 "$archive")" != "$NODE_SHA256" ]; then
    rm -f "$archive"
    die "The Node.js download is damaged (its checksum does not match). Start Digital Bahi again to download it again."
  fi
  tar -xzf "$archive" -C "$RUNTIME"
  rm -f "$archive"
  NODE="$RUNTIME/node-v$NODE_VERSION-$OS-$ARCH/bin/node"
  [ -x "$NODE" ] || die "Node.js was not unpacked to $NODE"
}

find_node
# pnpm and the build call "node": the one found above.
PATH="$(dirname "$NODE"):$PATH"
export PATH
# Downloads trust the computer's certificates too (antivirus or office proxies that check HTTPS add their own).
NODE_FLAGS=""
if "$NODE" --use-system-ca -e 0 >/dev/null 2>&1; then NODE_FLAGS="--use-system-ca"; fi

# Inside a built Digital Bahi: run it.
if [ -f "$ROOT/launcher/launcher.mjs" ]; then
  exec "$NODE" $NODE_FLAGS "$ROOT/launcher/launcher.mjs" "$@"
fi

# Inside the source checkout: build it for this computer into the data folder first.
REPO=$(CDPATH= cd -- "$ROOT/../.." && pwd)
[ -f "$REPO/installer/build-bundle.mjs" ] || die "Run this from the Digital Bahi folder (installer/unix/digitalbahi.sh) or from a built copy."
APP="$DIGITALBAHI_HOME/app"

build() {
  say "Building Digital Bahi for this computer (a few minutes)..."
  cd "$REPO"
  # corepack and pnpm download too: the same certificates as above.
  if [ -n "$NODE_FLAGS" ]; then NODE_OPTIONS="${NODE_OPTIONS:-} $NODE_FLAGS"; export NODE_OPTIONS; fi
  if command -v corepack >/dev/null 2>&1; then
    PNPM="corepack pnpm"
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    export COREPACK_ENABLE_DOWNLOAD_PROMPT
  else
    PNPM="npx --yes pnpm@10.33.0"
  fi
  # build-bundle.mjs calls "pnpm": a stand-in that runs the one found above.
  shim="$DIGITALBAHI_HOME/build-bin"
  mkdir -p "$shim"
  printf '#!/bin/sh\nexec %s "$@"\n' "$PNPM" >"$shim/pnpm"
  chmod +x "$shim/pnpm"
  PATH="$shim:$PATH" $PNPM install --frozen-lockfile
  PATH="$shim:$PATH" "$NODE" installer/build-bundle.mjs --out "$DIGITALBAHI_HOME/build"
  if [ -f "$APP/launcher/launcher.mjs" ]; then "$NODE" $NODE_FLAGS "$APP/launcher/launcher.mjs" stop; fi
  rm -rf "$APP"
  mv "$DIGITALBAHI_HOME/build/DigitalBahi" "$APP"
  rm -rf "$DIGITALBAHI_HOME/build" "$shim"
  say "Built into $APP. Next time, start it with: \"$APP/digitalbahi.sh\""
}

if [ "$COMMAND" = "install" ]; then
  build
  shift
  exec "$NODE" $NODE_FLAGS "$APP/launcher/launcher.mjs" start "$@"
fi
# The checkout changed since the last build (git pull): build again before starting.
if [ "$COMMAND" = "start" ] && [ -f "$APP/VERSION.txt" ] && command -v git >/dev/null 2>&1; then
  head=$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || true)
  if [ -n "$head" ] && ! grep -q "($head)" "$APP/VERSION.txt"; then
    say "The Digital Bahi code has changed since it was last built."
    build
  fi
fi
if [ ! -f "$APP/launcher/launcher.mjs" ]; then
  case "$COMMAND" in start | restart) build ;; *) say "Digital Bahi has not been set up on this computer yet."; exit 0 ;; esac
fi
exec "$NODE" $NODE_FLAGS "$APP/launcher/launcher.mjs" "$@"
