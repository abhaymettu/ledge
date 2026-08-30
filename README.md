# ledge

Push agent status onto an iPhone lock screen and Dynamic Island over a local webhook.
Any agent that can run `curl` gets a Live Activity. Self-hosted end to end: your Mac,
your Apple developer account, your APNs key. Nothing leaves the tailnet except the
Apple push itself.

    agent (curl) --> ledge server (Mac, node) --> APNs --> iPhone

Zero dependencies on both sides. The server is node built-ins only, with no
`package.json` and nothing to install. See [SPEC.md](SPEC.md) for the design and the
non-goals.

**What you need**

- A Mac with Xcode and node on `PATH`. Developed and run on node 26.
- An iPhone on iOS 18 or newer, and a cable or wireless pairing to run a build on it.
- A **paid** Apple Developer account. Live Activities need a real push key; a free
  personal team cannot create one.
- Tailscale, if you want the phone to reach the server from outside the house. Loopback
  alone is enough while you are testing on the same machine.

Budget about 20 minutes for the Apple side, and 5 for everything else.

---

## Install, one command

Do the Apple step below first (it is the only part nobody can script for you: an App
ID, an APNs key, and your Team ID). Then, on the Mac, with the iPhone plugged in:

    curl -fsSL https://raw.githubusercontent.com/abhaymettu/ledge/main/install.sh | sh

It asks for the Team ID, the Key ID and the path to the `.p8`, and then does the rest:
clones the repo to `~/.ledge/ledge`, writes `~/.ledge/config.json`, puts `ledge` on
PATH, merges the Claude Code hooks, starts the server under launchd, builds the app to
the phone, and prints the address and token to type into it. Re-running it is safe.

**Handing it to a coding agent.** The script cannot ask questions without a terminal,
so give the agent the three values and it runs non-interactively:

    LEDGE_TEAM_ID=ABCDE12345 LEDGE_KEY_ID=ABC1234567 LEDGE_P8=~/Downloads/AuthKey_ABC1234567.p8 \
      sh -c "$(curl -fsSL https://raw.githubusercontent.com/abhaymettu/ledge/main/install.sh)"

A prompt that works: *"Set up ledge from https://github.com/abhaymettu/ledge. Read
its README, ask me for my Apple Team ID, APNs Key ID and the .p8 path, then run
install.sh with those as environment variables and tell me what it printed."*

Then in the app: **1. On your Mac** run `ledge pair`, **2.** type the address and
token it prints, **3.** tap Pair. Everything below is what the script does, by hand.

---

## Setup

### 1. Apple, once (about 15 minutes)

You only ever do this block once.

1. **App ID.** developer.apple.com → Certificates, Identifiers & Profiles → Identifiers →
   `+` → App IDs → App. Pick your own explicit bundle ID, e.g. `com.yourname.ledge`.
   Tick **Push Notifications**. Register.
2. **APNs Auth Key.** Same site → Keys → `+`. Name it `ledge`, tick **Apple Push
   Notifications service (APNs)**, Continue, Register, **Download**. The `.p8`
   downloads exactly once and cannot be re-downloaded. Note the **Key ID** on that page.
3. **Team ID.** Top right of the developer portal, or Membership details. Ten characters.
4. **Park the key.**

       mkdir -p ~/.ledge
       mv ~/Downloads/AuthKey_ABC1234567.p8 ~/.ledge/
       chmod 600 ~/.ledge/AuthKey_ABC1234567.p8

   Never move it into this repo. `.gitignore` blocks `*.p8`, but the safe copy is the
   one that was never there.
5. **Point Xcode at your identity.** Open `ios/Ledge.xcodeproj`, select each target
   (Ledge and LedgeWidget) → Signing & Capabilities → pick your Team, and set the
   bundle identifiers to yours (`com.yourname.ledge` and `com.yourname.ledge.widget`).
   The repo ships with the team blank and the author's bundle ID; nothing signs until
   you do this.

### 2. Config

`~/.ledge/config.json`, mode 600, gitignored, never committed:

```json
{
  "teamId": "YOURTEAMID",
  "keyId": "ABC1234567",
  "keyPath": "~/.ledge/AuthKey_ABC1234567.p8",
  "bundleId": "com.yourname.ledge",
  "token": "a long random string",
  "port": 8787,
  "env": "production"
}
```

- `token` is the shared bearer token. Generate one: `openssl rand -hex 32`.
- `env` is `production` for a device build (`api.push.apple.com`) or `sandbox` for a
  debug build run from Xcode (`api.sandbox.push.apple.com`). Wrong value here is the
  most common cause of a silent `BadDeviceToken`.
- Optional `url` overrides what the hooks talk to; it defaults to
  `http://127.0.0.1:<port>`.

      chmod 600 ~/.ledge/config.json

### 3. Run the server

    node server/server.mjs

It binds `127.0.0.1` and your Tailscale address (auto-detected: any interface IPv4 in
the CGNAT range `100.64.0.0/10`), both on `port`, and nothing else. An optional
`"bindHosts": ["127.0.0.1", "..."]` in the config overrides the detection. There is no
TLS and no public ingress on purpose: the only path in is loopback or Tailscale. If
Tailscale is down, the tailnet bind logs a line and the loopback listener keeps
working. The `[listen]` lines at startup print the exact URLs; the tailnet one is what
goes in the app's server field.

State lives in `server/state.json` (gitignored) and is rewritten on every change. Delete
it to forget every token and lane; the phone re-registers on next launch.

It has no daemon mode of its own. Once it works, hand it to launchd so it starts at
login and restarts on crash: see [Keeping it running](#keeping-it-running) below.

### 4. Pair the phone

Build the app to the device, open it once, tap **Pair**. That POSTs the push-to-start
token and the device token to `/register`. Then:

    curl -s localhost:8787/health

`"paired": true` means the server can push.

**A session parked on a `/loop`** (it ended its turn on `ScheduleWakeup`) is not
waiting on you, so its card is a neutral countdown to the next wake with the loop's own
reason as the line, instead of "your turn".

**Tapping a card** opens the session in the Claude app when the server gave it a
link (Claude Code sessions with a bridge ID, or `ledge send --url`). A card with no
link opens Ledge itself on that session's row, which says why it has nowhere to go.
The app lists every live card; swipe one left to take it off the phone.

**Reinstalling or rebuilding the app invalidates every token.** Open the app once after
any rebuild. Nothing else recovers it.

### 5. Prove it works

    ./server/test.sh

Seven steps, run with the phone in front of you. It asks you to confirm each visual
step, because a green run that never lit up the lock screen is worse than a red one.

---

## The `ledge` CLI

`bin/ledge` is the hand-operated front for the API below. POSIX `sh`, no dependencies.
Put it on `PATH`:

    ln -s "$PWD/bin/ledge" /usr/local/bin/ledge

It reads the server URL and the bearer token from `~/.ledge/config.json` on every call.
The token is handed to `curl` through a config on stdin, so it never appears in a
process listing, and it is never written anywhere.

| Command | What it does |
| --- | --- |
| `ledge status` | Is the phone paired, and which lanes are live |
| `ledge send <lane> <line> [opts]` | Start or update a lane's activity |
| `ledge end <lane> [line] [--tone T]` | End one lane |
| `ledge clear [-y]` | End every live lane. Confirms first unless `-y` |
| `ledge logs [-n N] [-f]` | Tail the server log |
| `ledge -h` | Usage |

`send` options: `--template` (`progress`, `needs_you`, `result`, `countdown`), `--tone`
(`neutral`, `warn`, `ok`, `fail`), `--progress 0..1`, `--url` for a tappable card.

    ledge status
    ledge send build "compiling" --progress 0.4
    ledge send build "needs your approval" --template needs_you --tone warn
    ledge send build "6 tests failed" --template result --tone fail
    ledge end build "done"
    ledge clear -y

    $ ledge status
    server  http://127.0.0.1:8787
    paired  yes
    lanes   networking, build

Every failure exits non-zero with one line: a missing config, an unreachable server, a
token that does not match, a lane the server rejected. Never a stack trace.

Set `LEDGE_CONFIG` to point at a different config file, `LEDGE_LOG` at a different log.

---

## Keeping it running

    scripts/install-launchd.sh

That fills in `scripts/com.ledge.server.plist`, writes it to
`~/Library/LaunchAgents/com.ledge.server.plist`, and loads it. The agent starts at login
(`RunAtLoad`), restarts if it ever exits (`KeepAlive`), and appends stdout and stderr to
`~/.ledge/server.log`, which is what `ledge logs` reads.

The plist in `scripts/` is a template: node's path, the repo's path, and the log path are
placeholders filled in at install time, so nothing machine-specific is committed. Run
`scripts/install-launchd.sh --print` to see the filled-in result without installing
anything.

The script is idempotent. Re-run it after you move the repo or upgrade node.

    launchctl print gui/$(id -u)/com.ledge.server | head -20   # check
    launchctl kickstart -k gui/$(id -u)/com.ledge.server       # restart
    launchctl bootout gui/$(id -u)/com.ledge.server && \
      rm ~/Library/LaunchAgents/com.ledge.server.plist         # uninstall

Kill any server you were running by hand first. Two of them fight over the port, and
over the APNs JWT, which shows up as `403 TooManyProviderTokenUpdates`.

---

## API

Every endpoint needs `Authorization: Bearer <token>` except `GET /health`. A bad or
missing token is `401` with no body.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/health` | — | `{ok, lanes, paired}` |
| `POST` | `/register` | `{pushToStartToken, deviceToken}` | `204` |
| `POST` | `/token` | `{lane, updateToken}` | `204` |
| `POST` | `/activity` | `{lane, template, title?, line?, progress?, deadline?, tone?}` | `200` |
| `POST` | `/activity/end` | `{lane, line?, tone?}` | `200` |
| `GET` | `/lanes` | — | `{lanes: {lane: contentState}}` |

**Boundary rules**, enforced before anything reaches Apple:

- `lane` must match `^[a-z0-9-]{1,24}$`. Anything else is `400`.
- `template` is one of `progress`, `needs_you`, `result`, `countdown`.
- `tone` is one of `neutral`, `warn`, `ok`, `fail`. Defaults to `neutral`.
- `title` truncates to 32 characters, `line` to 60. Past 256 characters it is a `400`
  instead, because that is a caller sending the wrong thing, not overflow.
- `progress` clamps to `0...1`.
- `deadline` is epoch seconds or an ISO 8601 string.
- The serialized APNs payload is asserted under 4000 bytes; over it is a `400`.

**Routing.** No entry for the lane, or an entry whose update token the phone never
reported, gets a push-to-start. An entry with an update token gets an update. A
`404` from `/activity/end` means that lane was not active.

**Coalescing.** At most one push per lane per 30 seconds. A newer update inside that
window replaces the pending one and answers `{"coalesced": true}` rather than
queueing. `needs_you`, the initial start, and `/activity/end` bypass the window.

**Restore.** A card swiped off the lock screen is gone from the phone but not from
the server, so later updates land on nothing. The app's **Restore missing cards**
button reads `/lanes` and starts the missing activities on the device itself, then
hands their new tokens to `/token`. It does not use push-to-start: iOS throttles
ActivityKit pushes past an hourly budget, and a restore has to work precisely when
that budget is spent.

**Rollover.** ActivityKit kills an activity at 8 hours. At 7h50m the server ends it and
immediately push-to-starts a replacement for the same lane carrying the last content
state. If the replacement fails it logs once and drops the lane rather than retrying.

**Logging.** Every APNs response is logged with its status and `apns-id`:

    [apns] 200 apns-id=8B5E4F1A-... event=update bytes=284

A rejection logs Apple's `reason` string on the same line. Nothing is swallowed.

---

## curl, one per template

Set these first:

    T=$(node -e 'console.log(require(require("os").homedir()+"/.ledge/config.json").token)')
    U=http://127.0.0.1:8787
    post() { curl -sS -X POST "$U$1" -H "authorization: Bearer $T" -H 'content-type: application/json' -d "$2"; echo; }

**progress** — a spinner, an elapsed timer, and an optional bar. iOS ticks the timer
itself; never push just to advance a clock.

    post /activity '{"lane":"networking","template":"progress","title":"networking",
      "line":"drafting 3 outreach emails","progress":0.4,"tone":"neutral"}'

**needs_you** — blocked on you. Bypasses the coalescer, lands immediately.

    post /activity '{"lane":"networking","template":"needs_you",
      "line":"approve the Bash call","tone":"warn"}'

**result** — terminal state. `tone` picks the checkmark or the cross.

    post /activity '{"lane":"networking","template":"result",
      "line":"6 emails sent","tone":"ok"}'
    post /activity '{"lane":"networking","template":"result",
      "line":"build failed at step 3","tone":"fail"}'

**countdown** — a ticking deadline. Epoch seconds or ISO 8601.

    post /activity '{"lane":"phd","template":"countdown",
      "line":"NSF GRFP closes","deadline":"2026-10-20T22:00:00Z","tone":"warn"}'

**end** — final state, then dismisses after 60 seconds.

    post /activity/end '{"lane":"networking","line":"done","tone":"ok"}'

---

## Claude Code hooks

Every lane gets its own activity, keyed by the basename of `$CLAUDE_PROJECT_DIR`
lowercased. Six lanes means six concurrent activities. That is intended.

- `SessionStart` → `progress`, line `started`
- `Notification` → `needs_you`, tone `warn`, line carries the notification message
- `Stop` → `result`, tone `ok`, then `/activity/end` 30 seconds later

### Install

1. Put the wrapper on PATH (any directory on PATH works; `/usr/local/bin` may need
   `sudo`):

       ln -s "$PWD/hooks/ledge-notify" /usr/local/bin/ledge-notify

2. Merge `hooks/hooks.json` into `~/.claude/settings.json`. If you have no hooks yet,
   copy the `"hooks"` block in verbatim. If you do, append to each matching event array
   rather than replacing it:

       node -e '
       const fs = require("node:fs"), os = require("node:os"), p = require("node:path");
       const f = p.join(os.homedir(), ".claude", "settings.json");
       const s = JSON.parse(fs.readFileSync(f, "utf8"));
       const add = JSON.parse(fs.readFileSync("hooks/hooks.json", "utf8")).hooks;
       s.hooks ??= {};
       for (const [evt, list] of Object.entries(add)) (s.hooks[evt] ??= []).push(...list);
       fs.writeFileSync(f, JSON.stringify(s, null, 2));
       console.log("merged:", Object.keys(add).join(", "));
       '

   Run that from the repo root. Back up `settings.json` first if you care about it.

3. Check it: `/hooks` inside Claude Code lists what is registered.

### ledge-notify

    ledge-notify <template> [line] [--tone T] [--progress N] [--end-after SECS]
    ledge-notify --end [line] [--tone T]

POSIX `sh`, no bashisms. It reads the token from `~/.ledge/config.json` at call time and
never hardcodes it. With no `line` argument it reads the hook's stdin JSON and uses
`.message`, which is how the `Notification` hook carries its text. Every path exits `0`:
a dead ledge server must never fail a hook or block a session.

---

## Other agents

Today the session poller reads Claude Code's own state. Everything that knows the
shape of Claude Code's files lives in `server/claude-state.mjs`; `server/poller.mjs`
only asks it for a list of sessions. That is the seam for a second agent: a
`codex-state.mjs` that returns the same shape, and the poller unions the lists.

What is known about Codex CLI (checked against a real `~/.codex` on 2026-08-29,
cli 0.81): it writes one rollout per session to
`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (first line
`session_meta` with `id`, `cwd`, `cli_version`), and a `session_index.jsonl` with
a `thread_name` per id. It has **no** live status registry like Claude Code's
`sessions/<pid>.json`, so "working / waiting" has to be inferred from the rollout's
mtime and last entry. That inference would be less reliable than the Claude card, and
it is why Codex is not shipped yet. Contributions that keep the poller's tests green
are welcome.

Any agent at all can already use the lock screen with no adapter: `ledge send` and
the [API](#api) are the whole contract.

## Tests

    node --test server/*.test.mjs     # validator and coalescer, APNs stubbed
    ./server/test.sh                  # live, against a paired phone

`node --test server/` does not work on node 26; the positional is loaded as a module,
not globbed. Pass the glob.

---

## Publishing a public snapshot

`scripts/publish.sh` pushes a sanitized copy of the working tree to a **separate** public
repo as a single fresh commit. It is not a mirror, and `git push public` by hand is never
the right move: a private history can hold a tailnet address or a Team ID in an old
commit even when the current tree is clean, and a mirror carries all of it.

    scripts/publish.sh --dry-run                  build the snapshot, run the guard, stop
    scripts/publish.sh                            the same, then force-push
    scripts/publish.sh --remote git@github.com:you/ledge-public.git
    scripts/publish.sh -y                         skip the confirmation prompt

The remote comes from a git remote named `public`, or from `--remote`. With neither, it
is a dry run.

Before anything is pushed, the guard scans the snapshot and refuses on any of:

- a `.p8` key, a `config.json`, a `state.json`, an `asc.json`, a `.mobileprovision`
- a Tailscale address in `100.64.0.0/10`
- a 10-character uppercase Apple Team ID
- a 64-hex-character bearer token

It prints every hit as `file:line:match` and exits non-zero. Nothing is pushed. It fails
closed on purpose: documentation placeholders are listed explicitly in the script, and
anything not on that list stops the publish rather than being waved through.

    $ scripts/publish.sh --dry-run
    REFUSING TO PUBLISH - Apple Team ID:
      ios/Ledge.xcodeproj/project.pbxproj:271:ABCDE12345

    Nothing was pushed.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `403 InvalidProviderToken` | Wrong `teamId` or `keyId`, or the `.p8` does not match the Key ID |
| `400 BadDeviceToken` | `env` is `production` against a debug build, or vice versa |
| `403 TooManyProviderTokenUpdates` | The JWT was regenerated faster than every 20 minutes. The server caches for 45; this means two servers are running |
| `400 TopicDisallowed` | `bundleId` mismatch, or Push Notifications is not enabled on the App ID |
| `409 not paired` | No push-to-start token. Open the app and tap Pair |
| Nothing on the lock screen, APNs said `200` | Live Activities off for the app in Settings, or the app was rebuilt since pairing |
| Server unreachable from the phone | Tailscale down, or the tailnet bind failed at startup. Check the `[listen]` lines |

## License

MIT. See [LICENSE](LICENSE).
