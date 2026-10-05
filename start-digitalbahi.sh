#!/bin/sh
# Starts Digital Bahi on this computer and on phones on the same Wi-Fi (macOS, Linux):
#
#   ./start-digitalbahi.sh          start it, open the app, show the phone address and QR code
#   ./start-digitalbahi.sh stop     stop it
#
# The first time it downloads what is missing (Node.js, PostgreSQL) and builds
# the app: a few minutes. After "git pull" it builds again by itself.
# On a Mac, double-clicking "Start Digital Bahi.command" in Finder does the same.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${1:-start}" = "start" ]; then
  [ $# -gt 0 ] && shift
  exec "$ROOT/installer/unix/digitalbahi.sh" start --phone "$@"
fi
exec "$ROOT/installer/unix/digitalbahi.sh" "$@"
