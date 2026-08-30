#!/bin/sh
# Install the ledge server as a launchd user agent: starts at login, restarts on crash.
# Idempotent - run it again after moving the repo or upgrading node.
#
#   scripts/install-launchd.sh            fill the template in, install, load
#   scripts/install-launchd.sh --print    print the filled-in plist and stop
#
# POSIX sh, no bashisms.

set -eu

LABEL=com.ledge.server
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TEMPLATE="$ROOT/scripts/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/.ledge/server.log"
UID_=$(id -u)

PRINT=0
[ "${1:-}" = "--print" ] && PRINT=1

NODE=$(command -v node || true)
[ -n "$NODE" ] || {
  echo "install-launchd.sh: node is not on PATH. launchd needs an absolute path to it." >&2
  exit 1
}
[ -f "$TEMPLATE" ] || {
  echo "install-launchd.sh: missing $TEMPLATE" >&2
  exit 1
}

fill() {
  sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$ROOT|g" -e "s|__LOG__|$LOG|g" "$TEMPLATE"
}

if [ "$PRINT" -eq 1 ]; then
  fill
  exit 0
fi

[ -f "$HOME/.ledge/config.json" ] ||
  echo "warning: no ~/.ledge/config.json yet. The agent will crash-loop until you make one (see the README)." >&2

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.ledge"
TMP=$(mktemp "${TMPDIR:-/tmp}/ledge-plist.XXXXXX")
trap 'rm -f "$TMP"' EXIT INT TERM
fill >"$TMP"
plutil -lint "$TMP" >/dev/null || {
  echo "install-launchd.sh: generated plist is malformed, not installing" >&2
  exit 1
}
cp "$TMP" "$DEST"

# Idempotent load: tear down whatever is there, then bring it up.
launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
launchctl enable "gui/$UID_/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_" "$DEST"

echo "installed $DEST"
echo "  node   $NODE"
echo "  repo   $ROOT"
echo "  log    $LOG"
echo
echo "check:      launchctl print gui/$UID_/$LABEL | head -20"
echo "            ledge status"
echo "restart:    launchctl kickstart -k gui/$UID_/$LABEL"
echo "uninstall:  launchctl bootout gui/$UID_/$LABEL && rm $DEST"
echo
echo "If you already had a server running by hand, kill it. Two of them fight over the"
echo "port and over the APNs JWT (403 TooManyProviderTokenUpdates)."
