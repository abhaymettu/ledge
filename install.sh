#!/bin/sh
# ledge installer. One command from nothing to a paired phone, on a Mac.
#
#   curl -fsSL https://raw.githubusercontent.com/abhaymettu/ledge/main/install.sh | sh
#
# Interactive: asks for the three Apple values it cannot get for you (Team ID, APNs
# Key ID, the .p8 file). Non-interactive, e.g. run by a coding agent: set them first.
#
#   LEDGE_TEAM_ID=ABCDE12345 LEDGE_KEY_ID=ABC1234567 LEDGE_P8=~/Downloads/AuthKey_ABC1234567.p8 sh install.sh
#
# Optional: LEDGE_BUNDLE_ID (default com.<user>.ledge), LEDGE_HOME (default ~/.ledge/ledge,
# where the repo is cloned), LEDGE_SKIP_BUILD=1 (do not build the app to the phone).
# Re-running is safe: an existing ~/.ledge/config.json is kept and the questions skipped.
#
# What it does, in order: clone or update the repo, write ~/.ledge/config.json, write
# ios/Local.xcconfig with your team and bundle ID, link `ledge` and `ledge-notify` onto
# PATH, merge the Claude Code hooks, install the server under launchd, build the app to
# a connected iPhone, print what to type into the app, run `ledge doctor`.
#
# POSIX sh, no bashisms. macOS only.

set -eu

REPO=https://github.com/abhaymettu/ledge.git
LEDGE=$HOME/.ledge
CFG=$LEDGE/config.json

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# ask VAR "question" [default]: env var wins, then /dev/tty, else a clear failure.
ask() {
  _v=$1; _q=$2; _d=${3:-}
  eval "_cur=\${$_v:-}"
  [ -n "$_cur" ] && return 0
  if (exec </dev/tty) 2>/dev/null; then
    if [ -n "$_d" ]; then printf '%s [%s]: ' "$_q" "$_d"; else printf '%s: ' "$_q"; fi
    read -r _in </dev/tty || _in=""
    [ -n "$_in" ] || _in=$_d
    eval "$_v=\$_in"
  elif [ -n "$_d" ]; then
    eval "$_v=\$_d"
  else
    die "no terminal to ask for $_v. Set LEDGE_TEAM_ID, LEDGE_KEY_ID and LEDGE_P8 and run again (see the header of this script)."
  fi
}

# --- preflight ---------------------------------------------------------------

[ "$(uname -s)" = Darwin ] || die "ledge runs on macOS (it needs Xcode and launchd)."
for t in git node curl; do
  command -v "$t" >/dev/null 2>&1 || die "$t is not installed. brew install $t"
done
xcode-select -p >/dev/null 2>&1 || die "Xcode is not installed. Install it from the App Store, open it once, then run this again."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "node $NODE_MAJOR is too old; ledge needs 22 or newer."

mkdir -p "$LEDGE"
chmod 700 "$LEDGE"

# --- repo ----------------------------------------------------------------------

if [ -f ./server/server.mts ] && [ -f ./install.sh ]; then
  ROOT=$(pwd)
else
  ROOT=${LEDGE_HOME:-$LEDGE/ledge}
  if [ -d "$ROOT/.git" ]; then
    say "updating $ROOT"
    git -C "$ROOT" pull -q --ff-only || warn "could not fast-forward $ROOT, using it as is"
  else
    say "cloning into $ROOT"
    git clone -q "$REPO" "$ROOT"
  fi
fi

# --- config --------------------------------------------------------------------

if [ -f "$CFG" ]; then
  say "using existing $CFG"
  eval "$(node -e '
    const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    for (const [k, v] of [["TEAM_ID", c.teamId], ["BUNDLE_ID", c.bundleId], ["PORT", c.port || 8787]])
      console.log(k + "=" + JSON.stringify(String(v ?? "")));
  ' "$CFG")"
  [ -n "$TEAM_ID" ] && [ -n "$BUNDLE_ID" ] || die "$CFG has no teamId or bundleId"
else
  say "Apple details (once). See README 'Apple, once' for where each lives."
  ask LEDGE_TEAM_ID "Apple Team ID (10 characters)"
  ask LEDGE_KEY_ID "APNs Key ID (10 characters)"
  P8_DEFAULT=$(ls -t "$LEDGE"/AuthKey_*.p8 "$HOME"/Downloads/AuthKey_*.p8 2>/dev/null | head -1 || true)
  ask LEDGE_P8 "Path to the APNs .p8 key" "$P8_DEFAULT"
  ask LEDGE_BUNDLE_ID "Bundle ID for the app" "com.$(id -un | tr -cd 'a-z0-9').ledge"

  TEAM_ID=$(printf '%s' "$LEDGE_TEAM_ID" | tr -d ' ')
  KEY_ID=$(printf '%s' "$LEDGE_KEY_ID" | tr -d ' ')
  BUNDLE_ID=$(printf '%s' "$LEDGE_BUNDLE_ID" | tr -d ' ')
  PORT=8787
  case $TEAM_ID in *[!A-Z0-9]*|??????????) ;; esac
  [ "${#TEAM_ID}" -eq 10 ] || die "Team ID should be 10 characters, got '$TEAM_ID'"
  [ "${#KEY_ID}" -eq 10 ] || die "Key ID should be 10 characters, got '$KEY_ID'"
  P8=$(printf '%s' "$LEDGE_P8" | sed "s|^~|$HOME|")
  [ -f "$P8" ] || die "no .p8 at $P8"
  case $P8 in
    "$LEDGE"/*) ;;
    *) mv "$P8" "$LEDGE/" && P8="$LEDGE/$(basename "$P8")" && say "moved the key to $P8" ;;
  esac
  chmod 600 "$P8"

  TOKEN=$(openssl rand -hex 32 2>/dev/null || node -p 'require("node:crypto").randomBytes(32).toString("hex")')
  # A build installed from Xcode or this script is development-signed, and development
  # builds talk to Apple's sandbox APNs. TestFlight builds want "production".
  node -e '
    const [teamId, keyId, keyPath, bundleId, token, port] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ teamId, keyId, keyPath, bundleId, token, port: Number(port), env: "sandbox" }, null, 2) + "\n");
  ' "$TEAM_ID" "$KEY_ID" "$P8" "$BUNDLE_ID" "$TOKEN" "$PORT" >"$CFG"
  chmod 600 "$CFG"
  say "wrote $CFG"
fi

# --- xcode identity ------------------------------------------------------------

cat >"$ROOT/ios/Local.xcconfig" <<EOF
// Generated by install.sh, gitignored. Passed to xcodebuild with -xcconfig.
DEVELOPMENT_TEAM = $TEAM_ID
LEDGE_BUNDLE_ID = $BUNDLE_ID
EOF

# --- PATH ---------------------------------------------------------------------

if [ -w /usr/local/bin ]; then BIN=/usr/local/bin; else BIN=$HOME/.local/bin; mkdir -p "$BIN"; fi
ln -sf "$ROOT/bin/ledge" "$BIN/ledge"
ln -sf "$ROOT/hooks/ledge-notify" "$BIN/ledge-notify"
ln -sf "$ROOT/hooks/ledge-approve" "$BIN/ledge-approve"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) warn "$BIN is not on your PATH. Add it to your shell profile: export PATH=\"$BIN:\$PATH\"" ;;
esac
say "linked ledge and ledge-notify into $BIN"

# --- claude code hooks ----------------------------------------------------------

if [ -d "$HOME/.claude" ]; then
  node -e '
    const fs = require("node:fs"), p = require("node:path");
    const f = p.join(process.env.HOME, ".claude", "settings.json");
    const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    const add = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).hooks;
    s.hooks ??= {};
    let n = 0;
    for (const [evt, list] of Object.entries(add)) {
      const have = JSON.stringify(s.hooks[evt] ?? []);
      if (have.includes("ledge-notify")) continue;
      (s.hooks[evt] ??= []).push(...list); n++;
    }
    if (n) fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
    console.log(n ? `merged ${n} hook event(s) into ${f}` : "hooks already present in " + f);
  ' "$ROOT/hooks/hooks.json"
else
  warn "no ~/.claude directory, skipping the Claude Code hooks (the session poller works without them)"
fi

# --- server -------------------------------------------------------------------

sh "$ROOT/scripts/install-launchd.sh" >/dev/null
i=0
while [ $i -lt 20 ]; do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 0.5
done
if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  say "server running under launchd on port $PORT"
else
  warn "server did not answer on port $PORT yet. Check: ledge logs"
fi

# --- the app, onto the phone ------------------------------------------------------

if [ "${LEDGE_SKIP_BUILD:-0}" != 1 ]; then
  UDID=$(xcrun devicectl list devices --json-output /tmp/ledge-devices.json >/dev/null 2>&1 && node -e '
    const d = require("/tmp/ledge-devices.json").result.devices
      .filter(x => x.hardwareProperties?.platform === "iOS" && x.connectionProperties?.pairingState === "paired");
    const on = d.find(x => x.connectionProperties?.tunnelState === "connected") || d[0];
    if (on) process.stdout.write(on.hardwareProperties.udid);
  ' || true)
  if [ -n "$UDID" ]; then
    say "building the app to iPhone $UDID (first time takes a few minutes)"
    DD=$(mktemp -d "${TMPDIR:-/tmp}/ledge-build.XXXXXX")
    if (cd "$ROOT/ios" && xcodebuild -project Ledge.xcodeproj -scheme Ledge -configuration Release \
          -destination "id=$UDID" -xcconfig Local.xcconfig -derivedDataPath "$DD" \
          -allowProvisioningUpdates build >"$DD/xcodebuild.log" 2>&1) \
       && xcrun devicectl device install app --device "$UDID" "$DD/Build/Products/Release-iphoneos/Ledge.app" >/dev/null 2>&1 \
       && xcrun devicectl device process launch --device "$UDID" "$BUNDLE_ID" >/dev/null 2>&1; then
      say "installed and opened Ledge on the phone"
    else
      warn "could not build or install to the phone (log: $DD/xcodebuild.log)."
      warn "Fallback: open $ROOT/ios/Ledge.xcodeproj in Xcode, sign in under Settings > Accounts, pick your team on both targets, and Run."
    fi
  else
    warn "no iPhone connected. Plug one in and run again, or open $ROOT/ios/Ledge.xcodeproj in Xcode and Run."
  fi
fi

# --- pair ---------------------------------------------------------------------

echo
say "In the Ledge app, enter these and tap Pair:"
"$BIN/ledge" pair || true
echo
"$BIN/ledge" doctor || true
