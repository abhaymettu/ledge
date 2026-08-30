#!/bin/sh
# Push a sanitized snapshot of the working tree to a SEPARATE public repo.
#
# This repo's history contains a Tailscale address and an Apple Team ID in older
# commits. The public repo therefore gets snapshots of the tree, one commit per
# publish on top of its own history (changed from a force-pushed single commit on
# 2026-08-29, the day it went public: a force-push breaks every clone). It is never
# a mirror of this one, and `git push public` by hand is never the right move.
#
#   scripts/publish.sh --dry-run           build the snapshot, run the guard, stop
#   scripts/publish.sh                     the same, then push one commit to the `public` remote
#   scripts/publish.sh --remote URL        override the remote
#   scripts/publish.sh -y                  skip the confirmation prompt
#
# With no `public` remote and no --remote, this is a dry run.
#
# The guard below is the entire point of this script. It fails closed: any hit and
# nothing is pushed.
#
# POSIX sh, no bashisms.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BRANCH=main
REMOTE=""
DRY=0
YES=0

# A real Apple Team ID is 10 uppercase alphanumerics mixing letters and digits, so
# all-letters (English words in the LICENSE) and all-digits (Xcode constants) are not
# one. The rest are the placeholders this repo's docs use on purpose. Everything else
# that fits the shape stops the publish.
NOT_A_TEAM_ID='[A-Z]{10}|[0-9]{10}|ABC1234567|ABCDE12345|TEAMID1234'

while [ $# -gt 0 ]; do
  case $1 in
    --dry-run|-n) DRY=1 ;;
    --remote) REMOTE=${2:-}; shift ;;
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "publish.sh: unknown argument $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$REMOTE" ]; then
  REMOTE=$(git -C "$ROOT" remote get-url public 2>/dev/null || true)
fi
if [ -z "$REMOTE" ]; then
  echo "publish.sh: no 'public' remote and no --remote given, so this is a dry run."
  echo "            add one with: git remote add public git@github.com:you/ledge.git"
  echo
  DRY=1
fi

# --- snapshot ---------------------------------------------------------------

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ledge-publish.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM
SNAP="$TMP/snap"
mkdir -p "$SNAP"

# Tracked files plus untracked ones git would let you commit. Anything .gitignore
# blocks (the .p8, config.json, state.json) never makes it into the copy at all.
# The guard below assumes nothing about that and checks anyway.
(cd "$ROOT" && git ls-files -z --cached --others --exclude-standard | tar -cf - --null -T -) |
  (cd "$SNAP" && tar -xf -)

COUNT=$(find "$SNAP" -type f | wc -l | tr -d ' ')

# --- the guard --------------------------------------------------------------

FOUND=0

# scan LABEL EXTENDED_REGEX [DROP_REGEX]
# Reports file:line:match for every whole-word hit. DROP_REGEX, anchored to the whole
# match, throws out known-benign matches (documentation placeholders and the like).
scan() {
  _label=$1
  _re=$2
  _drop=${3:-}
  _hits=$( (cd "$SNAP" && grep -rInowI -E -- "$_re" . || true) )
  if [ -n "$_drop" ]; then
    _hits=$(printf '%s\n' "$_hits" | awk -F: -v d="^($_drop)\$" 'NF >= 3 && $NF !~ d')
  fi
  _hits=$(printf '%s' "$_hits" | sed '/^$/d')
  if [ -n "$_hits" ]; then
    echo "REFUSING TO PUBLISH - $_label:"
    printf '%s\n' "$_hits" | sed 's|^\./|  |'
    echo
    FOUND=1
  fi
}

# 1. secret files, by name. These should already be gitignored; belt and braces.
BADFILES=$(find "$SNAP" -type f \( \
  -name '*.p8' -o -name 'config.json' -o -name 'state.json' -o \
  -name 'state.json.*' -o -name 'asc.json' -o -name '*.mobileprovision' \
  \) | sed "s|^$SNAP/|  |")
if [ -n "$BADFILES" ]; then
  echo "REFUSING TO PUBLISH - secret file in the snapshot:"
  printf '%s\n' "$BADFILES"
  echo
  FOUND=1
fi

# 2. a tailnet address (100.64.0.0/10). The network base address itself is only ever
#    documentation, never an assigned host, so it is allowed through.
scan "Tailscale address (100.64.0.0/10)" \
  '100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}' \
  '100\.64\.0\.0'

# 3. an Apple Team ID: 10 uppercase alphanumerics with at least one digit.
#    Placeholders in the docs are allowed through; nothing else is.
scan "Apple Team ID" '[A-Z0-9]{10}' "$NOT_A_TEAM_ID"

# 4. a bearer token: 64 hex characters.
scan "64-hex bearer token" '[0-9a-fA-F]{64}'

if [ "$FOUND" -ne 0 ]; then
  echo "Nothing was pushed. Fix the files above, or widen NOT_A_TEAM_ID in this script" >&2
  echo "if the hit is genuinely a placeholder." >&2
  exit 1
fi

echo "guard: clean ($COUNT files)"

# --- push -------------------------------------------------------------------

if [ "$DRY" -eq 1 ]; then
  echo "dry run, nothing pushed. Would push these to ${REMOTE:-<no remote>} $BRANCH:"
  (cd "$SNAP" && find . -type f | sed 's|^\./|  |' | sort)
  exit 0
fi

echo "target: $REMOTE  $BRANCH"
if [ "$YES" -eq 0 ]; then
  printf 'push %s files as one commit on top of the public history? [y/N] ' "$COUNT"
  read -r ans || ans=""
  case $ans in
    y|Y|yes|YES|Yes) ;;
    *) echo "cancelled" >&2; exit 1 ;;
  esac
fi

# Clone the public history, replace its tree with the snapshot, commit the diff.
# The commit subject is the private HEAD's, which is prose, not a file, and the
# guard has already passed the files it describes.
PUB="$TMP/pub"
if git clone -q --branch "$BRANCH" "$REMOTE" "$PUB" 2>/dev/null; then
  (cd "$PUB" && git ls-files -z | xargs -0 rm -f)
else
  mkdir -p "$PUB" && git -C "$PUB" init -q -b "$BRANCH"
fi
(cd "$SNAP" && tar -cf - .) | (cd "$PUB" && tar -xf -)
cd "$PUB"
git add -A
if git diff --cached --quiet; then
  echo "public repo already matches the snapshot, nothing to push"
  exit 0
fi
git commit -q -m "$(git -C "$ROOT" log -1 --format=%s)" -m "Snapshot of the working tree, $(date +%Y-%m-%d)."
git push -q "$REMOTE" "$BRANCH:$BRANCH"
echo "pushed 1 commit ($COUNT files) to $REMOTE $BRANCH"
