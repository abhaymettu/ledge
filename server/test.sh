#!/bin/sh
# Live integration test. Requires: server running, phone paired, phone in front of you.
#
# The whole point of this script is that it cannot pass without a push actually
# reaching the phone, so the visual steps ask you to confirm. A green run that never
# lit up the lock screen is worse than a red one.
#
#   ./test.sh [lane]

set -eu

LANE=${1:-ledgetest}
cfg=$(node -e '
const fs = require("node:fs"), os = require("node:os"), p = require("node:path");
const f = p.join(os.homedir(), ".ledge", "config.json");
const c = JSON.parse(fs.readFileSync(f, "utf8"));
console.log(c.token);
console.log(c.url || ("http://127.0.0.1:" + (c.port || 8787)));
') || { echo "test.sh: cannot read ~/.ledge/config.json" >&2; exit 1; }

TOKEN=$(printf '%s\n' "$cfg" | sed -n 1p)
URL=$(printf '%s\n' "$cfg" | sed -n 2p)
BODY=$(mktemp)
STEP=0
trap 'rm -f "$BODY"' EXIT

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[31mFAIL step %s: %s\033[0m\n' "$STEP" "$1" >&2
  printf 'http %s\nresponse: %s\n' "${2:-?}" "$(cat "$BODY" 2>/dev/null)" >&2
  printf '\nIf the response carries an apns-id and a reason, that is Apple talking.\n' >&2
  printf 'Check the server log for the matching [apns] line.\n' >&2
  exit 1
}

# req METHOD PATH [json] -> echoes status, body in $BODY
req() {
  m=$1; p=$2; d=${3:-}
  if [ -n "$d" ]; then
    curl -sS -o "$BODY" -w '%{http_code}' --max-time 15 -X "$m" "$URL$p" \
      -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$d"
  else
    curl -sS -o "$BODY" -w '%{http_code}' --max-time 15 -X "$m" "$URL$p" \
      -H "authorization: Bearer $TOKEN"
  fi
}

expect() { # expect <got-status> <wanted-status> <label>
  [ "$1" = "$2" ] || fail "$3: expected HTTP $2, got $1" "$1"
}

pushed() { # the response must carry a real apns-id, not a coalesce receipt
  grep -q '"apnsId":"[^"]\{1,\}"' "$BODY" ||
    fail "$1: no apns-id in the response, nothing reached Apple" "200"
  printf '  %s\n' "$(sed -n 's/.*"apnsId":"\([^"]*\)".*/apns-id \1/p' "$BODY")"
}

confirm() { # the honest part: no phone, no pass
  [ -t 0 ] || fail "test.sh needs a terminal; it verifies the phone by eye" "-"
  printf '  \033[33m%s\033[0m [y/N] ' "$1"
  read -r a || a=n
  case "$a" in y|Y|yes) ;; *) fail "operator says the phone did not show it" "-" ;; esac
}

printf 'ledge live test -> %s  lane=%s\n' "$URL" "$LANE"

STEP=1; say "1/9 GET /health"
code=$(curl -sS -o "$BODY" -w '%{http_code}' --max-time 10 "$URL/health") || fail "server unreachable at $URL" "-"
expect "$code" 200 "health"
grep -q '"ok":true' "$BODY" || fail "health did not return ok:true" "$code"
grep -q '"paired":true' "$BODY" || fail "server has no push-to-start token: open the app and tap Pair" "$code"
cat "$BODY"; echo

STEP=2; say "2/9 POST /activity  (progress, starts the activity)"
code=$(req POST /activity "{\"lane\":\"$LANE\",\"template\":\"progress\",\"title\":\"$LANE\",\"line\":\"live test starting\",\"progress\":0.1}")
expect "$code" 200 "start"
pushed "start"
confirm "Is the Live Activity on the lock screen?"

STEP=3; say "3/9 three updates 2s apart  (only the 1st and the last should land)"
i=1
while [ "$i" -le 3 ]; do
  code=$(req POST /activity "{\"lane\":\"$LANE\",\"template\":\"progress\",\"line\":\"update $i of 3\",\"progress\":0.$i}")
  expect "$code" 200 "update $i"
  if [ "$i" = 1 ]; then
    pushed "update 1"
  else
    grep -q '"coalesced":true' "$BODY" || fail "update $i was not coalesced; the 30s window is not holding" "$code"
    printf '  update %s coalesced\n' "$i"
  fi
  i=$((i + 1))
  if [ "$i" -le 3 ]; then sleep 2; fi
done
printf '  waiting out the 30s window for the deferred push...\n'
sleep 31
confirm "Does the lock screen now read 'update 3 of 3' (never 'update 2 of 3')?"

STEP=4; say "4/9 POST /activity  (needs_you bypasses the coalescer)"
code=$(req POST /activity "{\"lane\":\"$LANE\",\"template\":\"needs_you\",\"line\":\"needs you now\",\"tone\":\"warn\"}")
expect "$code" 200 "needs_you"
pushed "needs_you"
confirm "Did it flip to 'needs you now' immediately, without a 30s wait?"

STEP=5; say "5/9 POST /activity/end"
code=$(req POST /activity/end "{\"lane\":\"$LANE\",\"line\":\"live test done\",\"tone\":\"ok\"}")
expect "$code" 200 "end"
pushed "end"
confirm "Did it show 'live test done' and then dismiss (up to 60s)?"

STEP=6; say "6/9 lane traversal must be rejected"
code=$(req POST /activity '{"lane":"../../etc","template":"progress","line":"nope"}')
expect "$code" 400 "traversal"
grep -q 'lane must match' "$BODY" || fail "wrong 400 reason for a traversal lane" "$code"
cat "$BODY"; echo

STEP=7; say "7/9 an approval card must be decidable from the phone"
# The one step that exercises the Allow button itself, end to end: hook -> server
# -> APNs -> card -> tap -> back to the server. It was the absence of this step
# that let a silently-swallowed POST ship, so it asks for the tap and then checks
# the server, rather than asking whether the tap looked like it worked.
code=$(req POST /approvals "{\"sessionId\":\"live-test\",\"tool\":\"Bash\",\"input\":{\"description\":\"the live test asking to be allowed\"},\"cwd\":\"$PWD\"}")
expect "$code" 201 "open approval"
APPROVAL=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$BODY")
[ -n "$APPROVAL" ] || fail "no approval id in the response" "$code"
printf '  approval %s\n' "$APPROVAL"
code=$(req POST /activity "{\"lane\":\"$LANE\",\"template\":\"needs_you\",\"state\":\"approval\",\"title\":\"$LANE\",\"line\":\"allow: the live test asking to be allowed\",\"approvalId\":\"$APPROVAL\"}")
expect "$code" 200 "approval card"
pushed "approval card"
# The card is the whole surface. Tapping it opens the app, which is where the
# approval is answered.
confirm "Does the Ledge card show the approval, with allow and deny pills?"
printf '  \033[33mTap Allow, on the card or in the app. Waiting up to 60s...\033[0m\n'
i=0
while [ "$i" -lt 60 ]; do
  code=$(req GET /approvals)
  expect "$code" 200 "list approvals"
  grep -q "\"$APPROVAL\"" "$BODY" || break
  i=$((i + 1))
  sleep 1
done
if [ "$i" -ge 60 ]; then
  req POST "/approvals/$APPROVAL" '{"decision":"deny"}' >/dev/null
  req POST /activity/end "{\"lane\":\"$LANE\",\"line\":\"live test done\",\"tone\":\"ok\"}" >/dev/null
  fail "the tap never reached the server. The card must now say why, not sit there" "-"
fi
printf '  the tap reached the server after %ss\n' "$i"
confirm "Did the card react to the tap rather than sit unchanged?"
req POST /activity/end "{\"lane\":\"$LANE\",\"line\":\"live test done\",\"tone\":\"ok\"}" >/dev/null

STEP=8; say "8/9 a decision on a gone approval must 404, so the card can say it expired"
code=$(req POST "/approvals/$APPROVAL" '{"decision":"allow"}')
expect "$code" 404 "gone approval"
grep -q 'may have expired' "$BODY" || fail "wrong 404 reason for a decided approval" "$code"
cat "$BODY"; echo

STEP=9; say "9/9 a 5KB line must be rejected, not silently dropped by APNs"
big=$(node -e 'process.stdout.write("x".repeat(5000))')
code=$(req POST /activity "{\"lane\":\"$LANE\",\"template\":\"progress\",\"line\":\"$big\"}")
expect "$code" 400 "oversized line"
grep -q 'line too long' "$BODY" || fail "wrong 400 reason for an oversized line" "$code"
cat "$BODY"; echo

printf '\n\033[32mall 9 steps passed, confirmed on the phone\033[0m\n'
