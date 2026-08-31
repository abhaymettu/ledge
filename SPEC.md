# ledge

Push agent status onto an iPhone lock screen and Dynamic Island over a local webhook.
Any agent that can run `curl` gets a Live Activity. Self-hosted end to end: your Mac,
your Apple developer account, your APNs key. Nothing leaves the tailnet except the
Apple push itself.

Status: spec approved 2026-08-29, since built. The README is the operator doc;
this file records the design and the reasoning.

## Why

Claude Code lanes run for minutes in the background. Right now the only way to know a
lane is running, blocked, or done is to look at the terminal. This puts it on the lock
screen: which lane, how long, and whether it needs you.

Closed-source equivalents exist (PushWard, ActivitySmith, ~$24/yr, their servers, their
APNs key). This is the same capability, open, with no third party in the path.

## Non-goals for v1

Do not build these. They are named here so nobody "helpfully" adds them.

- Buttons on the lock screen (App Intents + a device-to-server return path)
- Location requests, alarms, or any capability beyond Live Activities
- App Store distribution, hosted relay, multi-user accounts
- Android, macOS, or watchOS
- A database. State is one JSON file.
- Any npm or SwiftPM dependency. Zero deps, both sides.

## Distribution, decided 2026-08-29

Repo-only. Everyone builds the app themselves with their own Apple account and their own
APNs key, which is the only arrangement where nobody else is in the push path. The
alternatives were costed: a hosted relay would be about $5/month and 10-25 hours, and
would put the author in custody of other people's push tokens and, unless end-to-end
encrypted, their card text. An App Store or TestFlight build can only be pushed to by the
key of the team that signed it, so any binary distribution implies that relay. Declined.
`install.sh` is the one command; the three Apple steps it cannot do are the whole
manual part. Bundle ID and team come from `ios/Local.xcconfig` (gitignored, generated)
through the `LEDGE_BUNDLE_ID` build setting, so the project file stays untouched.

## The island and the banner mean "act now" (2026-08-29)

An update whose state is `asking` or `approval` carries an APNs `alert` (title, line,
default sound); Apple's docs: it "lights up the device and displays the expanded
presentation in the Dynamic Island". No other state alerts. The compact and minimal
island presentations render nothing for any state that does not need him, so an occupied
island is a decision waiting; long-press still expands any card. A per-card opt-out of
the island does not exist in ActivityKit: the island shows the highest relevance card,
which is why asking is 90 to 100 and approval 100. Push-to-start must carry an alert, so
a brand-new working card still lights the screen once; that is Apple's rule, not ours.

## Approvals: decide from the phone (2026-08-29)

The product redesign's core loop: an agent needs a decision, he makes it from the
phone, the agent continues. Claude Code's `PermissionRequest` hook runs
`hooks/ledge-approve`, which POSTs `/approvals` `{sessionId, tool, input, cwd}` and
long-polls `GET /approvals/<id>?wait=<ms>` (default 120 s, `LEDGE_APPROVE_WAIT_MS`).
The poller sees the pending approval for that session and its card becomes state
`approval`: line `allow: <what the tool wants>` ("force-push the branch", "edit
poller.mts"), relevance 100, the ask accent, and, only on this state, Allow and Deny
buttons on the lock screen card and in the expanded island. The buttons are a
`LiveActivityIntent` (`DecideIntent`), which iOS runs in the app's process, so it reads
the app's server URL and token and POSTs `/approvals/<id> {decision}`; the app's inbox
does the same. The hook then prints the `hookSpecificOutput` decision Claude Code
expects.

**Nothing is ever allowed without a human.** No answer within the wait, or ledge
unreachable, prints nothing, and the normal terminal prompt proceeds. A deny is a
deny with the reason "denied from the phone". Approvals live in memory: a server
restart drops them and the hooks fall through to the terminal.

**Replies to a session from the phone are bridge-only.** The spike (2 hours, budgeted):
every session listens on `/tmp/cc-socks/<pid>.sock`, the transport behind Claude
Code's own session-to-session `SendMessage`. It accepts a connection and answers
nothing to a JSON hello; the protocol is minified and undocumented and the CLI exposes
no send command. Tapping a card still opens the session in the Claude app, which is
where a free-text reply happens.

**The inbox.** The paired app is one screen: *Needs you* (approvals with Allow/Deny,
then sessions asking a question), *Running*, *Done today* (from `GET /history`: the
server keeps the last 50 ended lanes with their final card and outcome in
`state.json`). Settings, Pair again and Restore sit behind a gear.

## The code has no comments

Decided 2026-08-29, with the redesign. Every constraint that was a comment is now a test
named for it, a type that forbids the bug, or a constant that feeds the other constant
it had to agree with; the story of why lives here. What a reader needs to know that the
code cannot say on its own:

- **APNs transport.** One HTTP/2 session is reused for every push. Apple sends GOAWAY
  periodically; the session is dropped and the next push reconnects. The provider JWT
  is minted with the JOSE raw r||s signature (`ieee-p1363`); DER is rejected. It is
  cached for 45 minutes because Apple refuses a refresh under 20 minutes apart
  (`TooManyProviderTokenUpdates`).
- **Auth** compares the bearer token with `crypto.timingSafeEqual`. Request bodies over
  1 MB are refused with 413 before parsing.
- **Ends dismiss at once** (`END_DISMISS_MS = 0`; the 60 s grace named earlier in this
  file is gone): three green "done" cards sat on the lock screen for hours otherwise.
- **The claude binary** is resolved at startup across `~/.local/bin`, `/opt/homebrew/bin`
  and `/usr/local/bin`: under launchd PATH is nearly empty and the owner's interactive
  `claude` is a shell function. Titles are summarised with an argument list, never a
  shell string, and with cwd in tmpdir so no project CLAUDE.md leaks into the call.
- **The poller adopts cards** left by a previous run with `pid: null`, never 0 or -1:
  `process.kill(0, 0)` signals the process group and would report the card alive forever.
  A 4xx from the server is remembered by body signature, not by lane, so a lane recovers
  as soon as its content changes.
- **Transcript tails** are read as the last 256 KB with the partial first line dropped
  (a single line can exceed 96 KB), cached by mtime and size so an unchanged file costs
  one stat per tick.
- **Tool phrases** are looked up in a table with a null prototype, so a tool named
  `constructor` cannot reach up the chain.

## Architecture

Three pieces.

    agent (curl) --> ledge server (Mac, node) --> APNs --> iPhone

The phone never needs to reach the server except once, at pairing, to hand over its
push tokens. It does that over Tailscale. There is no public ingress. The server binds
to 127.0.0.1 and the tailnet IP (auto-detected from the 100.64.0.0/10 range) only.

### 1. iOS app + widget extension

Swift 6, SwiftUI, iOS 18 minimum (push-to-start needs 17.2+; 18 keeps it simple).
Xcode 26.1. Two targets: `Ledge` (app) and `LedgeWidget` (widget extension).

**App.** Rewritten 2026-08-29 from a one-screen utility form into two screens keyed
on whether `/register` has ever succeeded (`paired`, persisted in UserDefaults and
corrected on every launch): a three-step setup (run `ledge pair` on the Mac, type the
address and token, tap Pair, with the install command at the bottom for anyone with no
server yet) and a status screen (connected, send a test card, the activities live right
now, server settings behind a disclosure). Errors are rephrased for a stranger: a 401
says the token does not match, an unreachable host asks about Tailscale. A banner with
an Open Settings button appears when Live Activities are off. The status screen lists every live activity (title, line, state word, elapsed
timer, tone as a 3pt capsule), tap opens the link, swipe dismisses the card locally.
Tapping a card always opens the owning app, so a card with no Claude link used to land
on a blank Ledge screen ("sometimes tapping opens the app itself", 2026-08-29: four of
eight sessions on the Mac had `bridgeSessionId: null`). Now the widget's `widgetURL`
falls back to `ledge://lane/<lane>` (scheme registered in Info.plist) and the app
highlights that row and says why it cannot be opened. The card in the widget is
otherwise untouched. The original screen, kept for the record:
- Text field for server URL (the Mac’s tailnet address, `http://100.x.y.z:8787`)
- Text field for the shared token
- "Pair" button: requests Live Activity authorization, obtains the push-to-start token
  and the APNs device token, POSTs both to `/register`
- A status line: paired / not paired / last error, verbatim
- A "Send test activity" button that hits `/activity` with a canned progress payload
- Persist URL and token in `UserDefaults`. Do not build a keychain wrapper.

**Token lifecycle, the part that breaks if you get it wrong:**
- Push-to-start tokens rotate. Observe `Activity<AgentActivity>.pushToStartTokenUpdates`
  and POST to `/register` every time it fires, not just on the Pair button.
- Every started activity yields its own update token. Observe
  `activity.pushTokenUpdates` and POST it to `/token` with the lane name.
- Rebuilding the app invalidates all of them. The app must re-register on every launch.

**Widget extension.** One `ActivityAttributes`, not four:

```swift
enum CardState: String, Codable { case working, asking, stuck, resting, done, failed }

struct AgentActivity: ActivityAttributes {
    var lane: String                  // fixed at start, never changes
    struct ContentState: Codable, Hashable {
        var state: CardState          // the one thing a card is
        var title: String             // <= 32 chars, the session title
        var line: String              // <= 60 chars
        var progress: Double?         // 0...1, working or stuck only
        var startedAt: Date?          // elapsed timer (asking: how long it has waited)
        var deadline: Date?           // resting: counts down to the next wake
        var url: String?              // claude://code/<id> or https://claude.ai/...
    }
}
```

**One `CardState`** (redesign of 2026-08-29). The card used to be `template × tone`,
and "what state is this" was re-derived in four places: the server's card copy, its
relevance score, the widget's colour logic and the app's session rows, each with its
own if-chain. `server/card-state.mts` owns the union now; the API still accepts
`template` + `tone` for callers that speak that vocabulary and maps them at the
boundary (`stateOf`), the poller sends `state` directly, and the phone decodes
`state` alone. The widget and the app switch on it exhaustively, so a seventh state
next year fails the Swift compiler instead of rendering grey. A state this build does
not know decodes as `working`, never blank. Relevance: asking 90 to 100 (longer
ignored is higher), failed 85, stuck 70, done 60, resting 40, working 20.

### 2. Server

One file, `server.mjs`, node 26, zero dependencies. `node:http` for the listener,
`node:http2` for APNs (APNs requires HTTP/2), `node:crypto` for the ES256 JWT.
State in `state.json` next to it.

Config from `~/.ledge/config.json`, gitignored, never committed:

```json
{
  "teamId": "...",
  "keyId": "...",
  "keyPath": "~/.ledge/AuthKey_XXXX.p8",
  "bundleId": "com.abhay.ledge",
  "token": "<shared bearer token>",
  "port": 8787,
  "env": "production"
}
```

`state.json` shape:

```json
{
  "pushToStartToken": "...",
  "deviceToken": "...",
  "lanes": {
    "networking": { "updateToken": "...", "startedAt": 1756400000, "last": { } }
  }
}
```

**Endpoints.** All require `Authorization: Bearer <token>` except nothing. All of them
require it. Reject with 401 and no body.

- `POST /register` `{pushToStartToken, deviceToken}` -> 204
- `POST /token` `{lane, updateToken}` -> 204. A token for a lane the server does not
  hold (added 2026-08-29) ends that activity rather than creating the lane: it is a
  ghost the phone still shows for a lane already ended, and storing it would leave a
  card nothing could ever remove. The app reports every card's token each time it
  comes to the foreground (`reconcile`), which is how ghosts get found.
- `POST /activity` `{lane, template, title, line, progress?, deadline?, tone?, state?}` -> 200
  - no entry for `lane`: push-to-start (`event: "start"`) to the push-to-start token
  - entry exists: `event: "update"` to that lane's update token
  - unknown lane on update because the phone never reported a token: fall back to
    push-to-start, do not 500
- `POST /activity/end` `{lane, line?, tone?}` -> 200. Sends `event: "end"` with a final
  content-state and `dismissal-date` set to now + 60s, then drops the lane from state.
- `GET /lanes` -> `{lanes: {lane: last content state}}`. Authed. Added 2026-08-29 for
  the app's "Restore missing cards" button: a card swiped off the lock screen leaves
  the server holding a lane whose update token addresses nothing. The app reads this,
  starts each missing activity locally with `Activity.request(pushType: .token)`, and
  the new token arrives through `/token`. A first version pushed-to-start from the
  server instead; every push was accepted by APNs and the phone created none, which
  is Apple's documented hourly ActivityKit budget. Local starts need no budget.
- `POST /approvals` `{sessionId, tool, input, cwd}` -> 201 `{id}`; `GET /approvals` -> the
  pending list; `GET /approvals/<id>?wait=<ms>` -> `{decision: allow | deny | null}`
  after the decision or the wait; `POST /approvals/<id>` `{decision}` -> 204.
- `GET /history` -> `{history: [{lane, card, endedAt, outcome}]}`, newest last.
- `GET /health` -> `{ok: true, lanes: [...]}`. No auth needed on this one.

**Validation at the boundary.** `lane` must match `^[a-z0-9-]{1,24}$`. `template` must
be one of the four. `title` and `line` are truncated server-side to 32 and 60 chars
(title raised from 24 on 2026-08-29 so session-poller titles survive validation).
`progress` clamped to 0...1. Reject anything else with 400 and a one-line reason. The
4KB APNs payload cap is not something to discover in production.

**APNs request.** `https://api.push.apple.com/3/device/<token>` (or
`api.sandbox.push.apple.com`). Headers:

- `authorization: bearer <ES256 JWT>` — cache the JWT, regenerate every 45 minutes.
  Apple rejects tokens refreshed more than once every 20 minutes.
- `apns-topic: <bundleId>.push-type.liveactivity`
- `apns-push-type: liveactivity`
- `apns-priority: 10`
- `apns-expiration: 0`

Body:

```json
{ "aps": {
    "timestamp": 1756400000,
    "event": "start",
    "content-state": { },
    "attributes-type": "AgentActivity",
    "attributes": { "lane": "networking" },
    "alert": { "title": "networking", "body": "started" }
} }
```

`attributes-type` and `attributes` are required on `start` and must be omitted on
`update` and `end`. `alert` is required on `start` for push-to-start to be permitted.

Log every APNs response status and `apns-id` to stdout. A rejected push must be visible,
not swallowed.

### 3. Claude Code hooks

`hooks.json` in the repo, with a README section on merging it into
`~/.claude/settings.json`. Plus `ledge-notify` a small shell wrapper on PATH so the hook
lines stay readable.

- `SessionStart` -> `progress`, line "started"
- `Notification` -> `needs_you`, tone `warn`, line carries the notification message
- `Stop` -> `result`, tone `ok`, then `/activity/end` after 30s
- Lane name comes from the basename of `$CLAUDE_PROJECT_DIR`, lowercased

Six lanes means up to six concurrent activities, keyed by lane name. That is the
intended behavior, not a bug.

### 4. Session poller

`server/poller.mts`, started from `main()` alongside the HTTP listener. Everything
that reads Claude Code's internal files and knows their shape is `server/claude.mts`
(the whole blast radius of an upstream format change is that one file; it returns typed
`Session`s with the status settled), `server/card.mts` is pure text plus `cardFor`
(Session -> card, the one place the CardState is decided), `server/titles.mts` is the
summariser. Claude Code
already tracks what every session is doing in `~/.claude/sessions/<pid>.json`
(`kind`, `status`, `statusUpdatedAt`, `name`, `cwd`, `bridgeSessionId`). The poller
reads that directory every `pollMs` and puts a card up for each session that is
actively working, with no hook needed in that session.

One card per live session, moving between two states, never flapping. Between turns
a session flips busy->idle->busy constantly; ending the card on every dip out of
busy flapped cards up and down (and ended Live Activities linger on the lock screen
for hours, so he saw stale cards). Decided 2026-08-29:

- **WORKING** (`status === "busy"`): template `progress`, tone `neutral`, `line` =
  what the session is doing right now, read from the transcript ("running npm
  test", "editing sessions.mjs" — see below); when the transcript yields nothing,
  the cwd with `$HOME` as `~` truncated from the left so the tail survives. No
  progress value (a fake bar is worse than none). Decided 2026-08-29: the cwd is
  the least interesting fact about a working session and does not earn the
  headline he stares at longest. A busy session whose transcript mtime is older
  than `stuckAfterMs` (default 10 min) is probably wedged — a hung command, a
  dead network call — not working: tone flips to `warn` and the line becomes
  `no output for Nm` (`Nh Nm` past an hour), still template `progress`, because
  `needs_you` means "Claude asked you something" and conflating the two would
  make the loud state meaningless. The check reuses the stat the activity cache
  already takes; a missing transcript is never called stuck (no evidence either
  way).
- **IDLE** (decided 2026-08-30, replacing "idle means your turn"): a session that
  ended its turn without asking anything is `idle`: quiet white, `line` = the last
  sentence it said ("Build 21 is in TestFlight"), relevance 10 so it never takes the
  island, ranked last under the cap, and its card leaves the lock screen after
  `IDLE_CARD_MS` (30 min) while the session stays alive; going busy again earns a
  fresh card. "Needs you" is exactly: an approval, or an `asking` card, which requires a
  real question (a "?" sentence in the last text, or an AskUserQuestion). The app shows
  needs you / running / idle / done today.
- **ASKING** (formerly WAITING; any non-busy status — `idle`, `shell`, anything
  unknown — while the pid lives, with a question): template `needs_you`, tone `warn`,
  `line` = the question Claude just
  asked, read from the transcript tail (the newest `assistant` entry with a text
  block; markdown stripped — fences and their contents, backticks, bold/italic
  asterisks, link syntax keeping the label, bullets, heading hashes, and table
  rows — a "?" in a cell is not a question; the LAST sentence ending in "?",
  where a colon or newline also ends a sentence). Shown only when it fits the 60-char line whole and is
  more than one word — a truncated question ("should I also update the") reads
  broken, a one-word question is noise, and a double-quoted question is Claude
  drafting a message, not asking him — so anything else falls back to exactly
  `"your turn"`. This is the
  signal that a session wants him; it must be visually loud.

**Sessions driven from the Claude app** (`entrypoint: "sdk-cli"`, the bridge
sessions he actually works in from the phone) never write `status` at all; found
2026-08-29 when the one session he was typing into had no card while a stale
terminal did. `withInferredStatus` fills it from the transcript tail: the newest
`user` or `assistant` entry is Claude mid-turn (a `tool_use`, or a user prompt or
tool_result it is about to continue from) = busy, or Claude's closing text = idle;
attachment, system and bridge entries are skipped. Busy counts from the prompt that
started the turn so the timer does not reset on every tool call. Same tail window and
stat cache as the activity read. A session file that carries a `status` is never
second-guessed.

**Watching, decided 2026-08-30.** A busy session whose newest tool call is a waiting
tool (`Monitor`, `ScheduleWakeup`) is `resting`, not working: it is the loop between its
checks, blocked until a condition or a timer. Line = the tool's own description or reason;
no stuck check (silence is the point); a Monitor has no known wake time so the trailing
slot shows elapsed, a ScheduleWakeup counts down. A loop iteration that is editing or
running commands is `working` like anything else. That is how "looping and coding" and
"looping and idle" tell apart.

**Parked on a /loop** (decided 2026-08-29): a session that ended its turn on a
`ScheduleWakeup` is idle to Claude Code but is not waiting on him; it wakes itself.
Carding it `needs_you` "your turn" was wrong. `pendingWakeup` reads the newest
`ScheduleWakeup` tool_use from the transcript tail (ignored if `stop: true`; a reply
he types after it does NOT cancel it, the wake keeps its appointment, corrected
2026-08-29 after "cool ty" flipped a loop to "your turn"); while the wake is still due, or overdue by under
`WAKE_GRACE_MS` (2 min), the card is template `countdown`, tone neutral, `line` =
the loop's own `reason` ("watching CI run"), `deadline` = the wake time so the
trailing slot counts down to it, `startedAt` = when it was scheduled. It ranks
with the working sessions under the cap, never ahead of a session that asked
something. For sdk-cli sessions the same tool_result marks the turn as over (idle),
so the stuck check does not fire on a sleeping loop.

In both states `startedAt` = `statusUpdatedAt`: the timer counts how long it has
been working, or how long it has been waiting on him.

A card is CREATED only when a session is `kind === "interactive"`, its pid is alive
(`process.kill(pid, 0)`), and it has been busy for at least `minBusyMs` (default
8s), so a three-second shell command never flashes one up. Once the card exists,
dropping out of busy transitions it to WAITING — never removes it. Going busy again
returns it to WORKING, even under `minBusyMs`. The card ENDS only when the pid dies
or the `maxCards` cap evicts it; it does not auto-expire on a timer ("stays until I
interact with that session" was the explicit choice). A session that was never busy
long enough gets no card, however long it idles. Posts happen only on genuine
content changes, never re-posting identical state every tick.

Lane: `cc-` + the session name sanitized to the lane charset (the prefix keeps
poller lanes from ever colliding with hook lanes; fallback name -> cwd basename ->
pid). The lane is the stable card identity; the displayed `title` is separate and
says what the session is ABOUT: the first real user prompt from the transcript at
`~/.claude/projects/<cwd with "/" as "-">/<sessionId>.jsonl` (only the first 256KB
is read — these files reach tens of megabytes and this runs every 3s; the first
`type: "user"` line whose text does not start with `<`, since those are system
reminders and command wrappers; whitespace collapsed, cut at a word boundary near
32 chars, no trailing punctuation). Titles are cached per sessionId — a first
prompt never changes, so the transcript is read at most once per session.
Fallbacks: transcript -> session `name` -> cwd basename -> pid; a missing or
unreadable transcript is silent, not an error. `url` =
`https://claude.ai/code/<bridgeSessionId>` when present.

**Summarised titles** (decided 2026-08-29, made refreshable 2026-08-29): the
trimmed raw prompt reads like "someone gave bots free reign on"; the Claude app
titles the same session "iOS lock screen agent webhook". So when a session is
first titled from a real transcript prompt, the poller fires ONE
`claude -p --model haiku` call (execFile with an argument list, never a shell —
the text is untrusted; truncated to 600 chars; 20s timeout then killed; cwd =
tmpdir so no project context leaks in) asking for a 2-4 word title for what the
session is currently working on. The trimmed prompt is the immediate
placeholder and the permanent fallback if calls fail. The answer is accepted
only if it is a single line of 2-5 words, unquoted, under 32 chars after trim;
anything else — refusal, error, timeout, empty, multi-line — keeps the current
label, silently. Calls are async and off the tick path; when one resolves, the
cached title changes and the NEXT tick reposts the card in place. Concurrency
is one worker: one call in flight, the rest queued and launched as it frees, so
simultaneous new sessions are summarised one at a time and none stranded.

A long session drifts (one began on memecoin-edge and moved to Kalshi work, and
the card kept saying "memecoin"), so the title is RE-summarised from recent
activity on a bounded schedule: `recentContext()` digests the last 24KB of the
transcript — the last few user prompts and assistant text blocks, tool
noise and `<`/`[`-prefixed lines skipped, markdown stripped, newest last,
capped at 600 chars with the oldest trimmed first — and that digest is what
gets summarised. A refresh fires only when the cached title is older than
`sessions.titleRefreshMs` (default 1200000, 20 min) AND the transcript mtime is
newer than the last summary (or attempt). THE ZERO-COST GUARANTEE: a session
whose transcript has not changed since its last summary costs zero model calls,
ever — the CLI is the owner's metered subscription, and the bound is roughly
one haiku call per active, CHANGING session per 20 min. A first prompt that is
just a file path skips its call (the path-based fallback is already the right
label), but once real activity accrues a later refresh can summarise it.
Outcomes persist to `~/.ledge/titles.json` (`{sessionId: {title, at}}`, legacy
bare-string entries load as refreshable-at-once, loaded at startup, written
tmp+rename), so a restart never re-summarises ahead of schedule.
`sessions.summariseTitles: false` in config, or `claude` missing from PATH
(probed once at startup, logged once), makes the whole feature inert: titles
behave exactly as above minus every model call.

The WORKING `line` is the session's **current activity**, from the same
transcript: the LAST `tool_use` block of the NEWEST entry whose
`message.content` carries one, phrased for a human (`Bash` -> "running " +
description or the first ~40 chars of the command; `Read` -> "reading " +
basename; `Edit`/`Write`/`NotebookEdit` -> "editing " + basename;
`Grep`/`Glob` -> "searching " + pattern; `WebSearch` -> "searching the web";
`WebFetch` -> "fetching " + hostname; `Task`/`Agent` -> "delegating " +
description; `TodoWrite` -> "planning"; anything else -> the tool name
lowercased; whitespace collapsed, trailing period stripped, word-boundary cut
to the line limit). Only the last 256KB of the transcript is read, scanned
backwards; a single line can exceed 96KB, so when the file is larger than the
window the partial first line of the window is discarded. Cached by transcript
path + mtimeMs + size, so an unchanged file costs one `stat()` per tick, never
a re-read; the read itself measured ~1ms. Nothing found, or any read error,
yields "" and the cwd fallback — never a throw. The WAITING line reads the same
tail the same way (own cache map) for the last question; "" falls back to "your
turn".

The poller does not talk to APNs. It POSTs to the server's own `/activity` and
`/activity/end` over loopback with the shared token, so validation, coalescing, the
start-race hold, and the 7h50m rollover apply unchanged. To carry the honest start
time through that path, `/activity` accepts an optional `startedAt` (same units as
`deadline`); when present it pins the lane's elapsed timer.

Config, under `"sessions"` in `~/.ledge/config.json`, all optional:

```json
{ "sessions": { "enabled": true, "pollMs": 3000, "minBusyMs": 8000, "maxCards": 4, "stuckAfterMs": 600000, "summariseTitles": true, "titleRefreshMs": 1200000 } }
```

When more than `maxCards` sessions qualify, WAITING sessions idle for under
`WAITING_FRESH_MS` (30 min) beat WORKING ones (a session that just asked for him
matters more than one happily working), then longest in its current state first;
WAITING sessions older than that rank last (decided 2026-08-29: they are abandoned,
not waiting, and four of them hid the bridge session he was typing in). A card that is
already up ranks above any working newcomer (later on 2026-08-29: with five sessions and
a cap of four, evict-and-readmit churn ended and restarted the same lane every few ticks
and left two activities on the phone for one lane); only a session that needs him can
take a slot from a working card; the rest are ended or ignored, so the lock screen cannot be
flooded.

This reads undocumented internal state from another program, so it trusts nothing:
every file read and parse is individually caught, a malformed file never hides the
others, an unrecognized shape is skipped silently rather than guessed into a card,
a missing directory logs once and disables the poller, the tick never lets an
exception escape, and the timer is unref'd so it cannot hold the process open.

## UI direction

Approved 2026-08-29: **variant m1**, ported verbatim from an `ImageRenderer` mock built to
iterate on the look off-device. Three earlier passes were rejected — a notification clone,
an accent-rail version that was the same clone in a nicer skin, and a tone-dot version.
What follows is the shipped design. The numbers are signed off; do not re-derive them.

### The card

A pure black slab with a lit top edge, floating on the lock screen. Nothing else.

- Ground is **`.black`**, not a material and not a grey, plus
  `.activityBackgroundTint(.black)` on the container so the system's own material does not
  ring the card. On OLED those pixels switch off and the card reads as a hole in the
  screen rather than a panel on it.
- Shape: `RoundedRectangle(cornerRadius: 22, style: .continuous)`.
- **Sheen** falling off the top edge, a `LinearGradient` top to bottom:
  white 0.078 at 0.00, white 0.024 at 0.13, white 0.0072 at 0.34, clear at 0.62.
- **Tone bloom** hugging the top edge, a `RadialGradient` from `hue` to clear,
  center `(0.5, -0.08)`, startRadius 1, endRadius 150, opacity **0.18 loud / 0.06 quiet**.
- **Rim**, `strokeBorder` lineWidth 0.8, a `LinearGradient` top to bottom:
  `hue` at **0.6555 loud / 0.3588 quiet** at 0.00, white 0.05 at 0.26, white 0.035 at 1.00.
- `hue` is the tone color when the card is loud or the tone is anything but neutral;
  a quiet neutral card blooms **white**, not blue-grey.
- Padding `.horizontal` 15, `.vertical` 13.

Every opacity above is the reference value already multiplied by **k = 0.60**, which is
what m1 means. The constants are inlined so there is no scaling factor left to fiddle with.

**Loud** is `needs_you` and nothing else. It brightens the rim and the bloom. It does not
change the layout, the height, or the line count.

**needs_you wears its own accent** (changed 2026-08-29): periwinkle, RGB (0.62, 0.68,
1.00), applied by the widget whatever tone the server sent. It used to borrow warn's
orange, so "your turn" looked like a fault and was indistinguishable from a stuck
session. Periwinkle is the only cool hue on the card; it reads as a message light. The
rim, bloom, lane label and island capsule all take it. warn stays orange for stuck.

**A working card wears teal** (changed 2026-08-29): RGB (0.40, 0.86, 0.82) for
`progress` with tone `neutral`, at quiet strength like any tone. It used to glow the
dim white that a parked loop's `countdown` still uses, so a session thinking and a
session asleep until its next check were indistinguishable. Teal is alive without
being ok's green. The palette is now: teal working, dim white resting (countdown),
periwinkle asking, orange stuck, green done, red failed.

**Colour-blind safe palette** (supersedes the hues above, 2026-08-29, he is
colour-blind): Okabe-Ito hues lifted for OLED black. Yellow (0.96, 0.86, 0.28)
working; sky blue (0.40, 0.72, 0.96) asking; vermilion (0.92, 0.42, 0.05) stuck;
bluish green (0.10, 0.78, 0.58) done; reddish purple (0.88, 0.48, 0.75) failed; dim
white resting. Every pair differs in lightness as well as hue, so the usual
red/green and blue/yellow confusions still leave the states apart, and the text
carries the meaning on its own ("done"/"failed" in the trailing slot, "no output for
Nm" when stuck, the question when asking).

### The row

```
VStack(alignment: .leading, spacing: 7) {
  HStack(spacing: 0) { lane; Spacer(); trailing value }
  Text(line)
  progress bar, only when progress is non-nil
}
```

- **lane** — `.system(size: 9, weight: .medium, design: .monospaced)`,
  `lineLimit(1)`, `.truncationMode(.tail)`
- **message** — `.system(size: 15, weight: .regular, design: .serif)`, which is New York,
  white, `lineLimit(1)`, `.truncationMode(.tail)`
- **trailing value** — `.system(size: 9.5, weight: .medium, design: .monospaced)`,
  `Color.white.opacity(0.42)`
- **progress bar** — 2pt tall, track `.white.opacity(0.07)`, fill tone at 0.85, capsules,
  `.padding(.top, 3)`. Only when `progress` is non-nil.

All three faces ship with iOS. Nothing is bundled.

**Lane color** carries the tone, so nothing else has to: neutral is
`Color.white.opacity(0.50)`; any other tone is that tone at **1.0 when loud, 0.85
otherwise**.

Every card is **one line**. The two-line `needs_you` exception from an earlier round is
gone.

### Two things that were deliberately removed

**The tone dot is gone.** A colored dot next to text is the notification idiom the design
kept accidentally reproducing. Tone now lives in the card rim, the bloom above the top
edge, and the lane label color — properties of the card itself rather than an object
sitting on it. There are no SF Symbols anywhere for the same reason.

**The percent is gone from the trailing slot.** The bar already says how far along it is,
and printing the same fact twice in two notations wasted the one slot that could carry
something new. The trailing slot now carries **duration**.

### Trailing value — one rule, exactly one thing, ever

1. `countdown` → time remaining to `deadline`
2. `result` → the word `done` or `failed`
3. everything else → elapsed since `startedAt`
4. nothing, if there is no date to show

Never a percent. Every clock is `Text(date, style: .timer)`, which counts down to a future
date and up from a past one, so **no push is ever needed to move a timer**.

### Dynamic Island

The dot is gone here too; the same edge motif replaces it.

- **compact leading:** a tone-colored `Capsule`, **3pt wide by 11pt tall**. Not a dot, not
  a symbol.
- **compact trailing:** trailing value,
  `.system(size: 12, weight: .medium, design: .monospaced)`
- **minimal:** the same 3×11 tone capsule. Apple says do not revert to a bare logo; the
  tone color is the information.
- **expanded** (reworked 2026-08-29): the bottom region alone, laid out exactly like the
  card. Row one: lane, mono 10pt, in the lane color; spacer; trailing value, mono 10pt.
  Row two: message in New York serif 16pt, `lineLimit(1)`, left-aligned, full width.
  Then the progress bar when present. Spacing 6, padding 6 horizontal, 4 top, 2 bottom.
  The earlier version put lane and clock in the wings beside the sensor and the message
  floated centered beneath them; the wings are too narrow for either. Leading, trailing
  and center regions are unused.
- **Tapping** any presentation, compact (either side), minimal, or expanded, opens the
  card's link: `claude://code/<id>` when the session has a bridge ID, otherwise
  `ledge://lane/<lane>`. The expanded island had no `widgetURL` at all before
  2026-08-29 and a tap there opened Ledge bare.

Island trailing text sits at white 0.55 rather than the card's 0.42. The mock had no
island, so there was no approved value to copy, and Apple's guidance for the island is
heavier and easier to read.

### Hard constraints

SwiftUI only. No UIKit. `List` is unsupported and throws. Max four levels of stack nesting
anywhere — the shipped card uses two. **No third-party dependency.**

All four templates ship. Unknown template strings fall back to `progress` rather than
rendering blank.

### Banned

Gradients other than the two named above, shadows, blur, custom animations, bundled fonts,
emoji, a wordmark anywhere, an SF Symbol per template, a tone dot, a percent in the
trailing slot, a progress bar when `progress` is nil, text wrapping to two lines.

The tone colors are literal RGB rather than semantic colors. That is deliberate and it
supersedes the earlier "semantic colors only" rule: the ground is pinned to black, so
there is no light appearance to adapt to, and a semantic substitute would only drift away
from what was signed off.

## Ceilings, and how each is handled

- **8 hour maximum per activity.** At 7h50m the server ends the activity and immediately
  push-to-starts a replacement for the same lane, carrying the last content-state
  forward. One `setTimeout` per lane. If the replacement fails, log it and drop the lane
  rather than retrying forever.
- **4KB payload cap.** Enforced by the server-side truncation above. Also assert the
  serialized body is under 4000 bytes before sending, and 400 if not.
- **ActivityKit update budget.** iOS throttles frequent pushes. Coalesce: at most one
  push per lane per 30 seconds. A newer update inside the window replaces the pending
  one rather than queueing. A `needs_you` or an `end` bypasses the coalescer, because
  those are the ones he actually needs immediately.
- **Token invalidation on rebuild.** The app re-registers on launch and on every token
  update event. Document in the README that reinstalling means opening the app once.

## Test

`test.sh` in the repo, run against a live paired phone:

1. `/health` returns ok
2. `/activity` with `progress` starts an activity, phone shows it
3. three `/activity` updates 2s apart, only the first and last land (coalescer works)
4. `/activity` with `needs_you` bypasses the coalescer and lands immediately
5. `/activity/end` dismisses it
6. a payload with `lane: "../../etc"` returns 400
7. a payload with a 5KB `line` returns 400, not a silent APNs rejection

Any non-2xx from APNs fails the script loudly with the `apns-id` and Apple's reason
string. A green run that never actually reached the phone is worse than a red one.

Server-side, one `node --test` file covering the validator and the coalescer. No
framework beyond node's built-in test runner. The Swift side gets no unit tests; the
phone is the test.

## Setup Abhay does once

1. Xcode: create App ID `com.abhay.ledge`, enable Push Notifications
2. developer.apple.com: create an APNs Auth Key (.p8), note Key ID and Team ID
3. Save the .p8 to `~/.ledge/`, `chmod 600`, never into the repo
4. Build to the device, open the app once, tap Pair
5. `node server.mjs`, then `./test.sh`

## Repo layout

    ledge/
      README.md
      SPEC.md
      LICENSE            MIT
      .gitignore         *.p8, state.json, config.json, xcuserdata
      server/            TypeScript, run by node directly; no comments, see above
        server.mts       routing, auth, APNs I/O, main
        lanes.mts        the lane lifecycle: Lane union, transitions, state file
        coalescer.mts    one push per lane per 30 s
        validate.mts     the API boundary: raw body -> request, request -> Card
        card-state.mts   CardState, Card, relevance
        apns.mts         HTTP/2 + ES256 JWT transport
        claude.mts       Claude Code's files: readSessions -> Session, transcript reads
        titles.mts       the haiku title summariser and its schedule
        card.mts         pure text, and cardFor: Session -> the card
        poller.mts       the poll loop
        verify.mts       ledge verify
        *.test.mts
      tsconfig.json
      scripts/check.sh
      hooks/
        hooks.json
        ledge-notify
      ios/
        Ledge.xcodeproj
        Ledge/            app target
        LedgeWidget/      widget extension
        Shared/AgentActivity.swift
