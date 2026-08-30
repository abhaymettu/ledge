// Session poller: mirrors live Claude Code sessions onto the lock screen.
//
// Claude Code writes ~/.claude/sessions/<pid>.json for every running session. This
// polls that directory and drives POST /activity and /activity/end through the same
// HTTP handler the hooks use, so validation, coalescing, the start-race hold, and
// the 7h50m rollover all apply unchanged. The files are undocumented internal state
// from another program: every read is defensive, and anything shaped wrong is
// skipped rather than guessed at.
//
// Card lifecycle: one card per session, two states, no flapping.
//
//   WORKING  status === "busy"          -> progress / neutral / current activity
//                                          from the transcript, else cwd line
//                                          (tone warn + "no output for Nm" when
//                                          the transcript has been silent past
//                                          stuckAfterMs: probably wedged)
//   WAITING  anything else (idle,       -> needs_you / warn / the question Claude
//            shell) while the pid lives    just asked, else "your turn"
//
// A card is CREATED only when a session has been busy for minBusyMs, so a
// three-second shell command never flashes one up. Once a card exists, dropping out
// of busy transitions it to WAITING; it never removes it. The card ENDS only when
// the pid dies or the cap evicts it. Between turns a session flips busy->idle->busy
// constantly; the old end-on-idle rule flapped cards up and down and left stale
// ended activities lingering on the lock screen.

import fs from 'node:fs'
import { LANE_RE } from './server.mjs'

// Must agree with LANE_RE's {1,24} bound: a suffixed lane still has to validate.
const LANE_CHARS = 24
import {
  SESSIONS_DIR, PROJECTS_DIR, pidAlive, validShape, readSessions, withInferredStatus, withPendingWakeup,
  transcriptPathFor, currentActivity, lastQuestion, titleFor, transcriptTitle, createTitleSummariser,
  recentContext,
} from './claude-state.mjs'
import { laneFor, activityBody } from './card-copy.mjs'

// stuckAfterMs: a busy session whose transcript has not grown for this long is
// flagged as probably wedged (tone warn, "no output for Nm"), still template
// progress — needs_you stays reserved for "Claude asked you something".
// titleRefreshMs: how stale a summarised title may get before a CHANGED
// transcript earns a re-summary from recent activity (20 min).
/** A waiting session this fresh still "wants him"; older than this it was
 *  abandoned, and must not push a working session off the lock screen. */
export const WAITING_FRESH_MS = 30 * 60_000

export const DEFAULTS = { enabled: true, pollMs: 3000, minBusyMs: 8000, maxCards: 4, stuckAfterMs: 600000, summariseTitles: true, titleRefreshMs: 1200000 }

/** True when this session earns a NEW card right now: busy past minBusyMs with a
 *  live pid. This gates creation only; an existing card survives any status. */
export function qualifies(s, minBusyMs, now = Date.now(), alive = pidAlive, hasWork = () => false) {
  if (!validShape(s) || !alive(s.pid)) return false
  if (s.status === 'busy') return now - s.statusUpdatedAt >= minBusyMs
  // Not busy: a waiting or shell session earns a card only if it has real history,
  // so a session he worked in and stepped away from survives a restart, but a fresh
  // untouched shell does not clutter the lock screen.
  return hasWork(s)
}

/**
 * Which lanes deserve a card this tick. `cards` is the set of lanes already up.
 * Returns {want, live}: `want` maps lane -> session for the cards to show,
 * `live` maps lane -> session for every readable interactive session with a live
 * pid (so a card missing from `want` and from `live` can be checked against its
 * own pid before being ended).
 */
export function selectCards(sessions, cards, { minBusyMs, maxCards, now = Date.now(), alive = pidAlive, hasWork = () => false }) {
  const live = new Map()
  // Sort by pid so lane assignment is deterministic. It used to depend on
  // readdirSync order, which meant two sessions sharing a name could swap
  // ownership of a lane between ticks and flap the card's pid, title and link.
  for (const s of [...sessions].sort((a, b) => (a?.pid ?? 0) - (b?.pid ?? 0))) {
    if (!validShape(s) || !alive(s.pid)) continue
    let lane = laneFor(s)
    if (!LANE_RE.test(lane)) continue
    if (live.has(lane)) {
      // Same name, different session: give the later one its own lane rather than
      // dropping it, so a second session in the same directory still gets a card.
      const suffix = `-${String(s.pid).slice(-4)}`
      lane = lane.slice(0, LANE_CHARS - suffix.length) + suffix
      if (!LANE_RE.test(lane) || live.has(lane)) continue
    }
    live.set(lane, s)
  }
  // A card either already exists or is earned by qualifying busy time. A session
  // that has never been busy long enough gets no card, however long it idles.
  const eligible = [...live].filter(([lane, s]) => cards.has(lane) || qualifies(s, minBusyMs, now, alive, hasWork))
  // maxCards: a recently WAITING session beats WORKING — one that just asked for
  // him matters more than one happily working — then longest in its current
  // state first. A session idle past WAITING_FRESH_MS is abandoned, not waiting,
  // and ranks last (2026-08-29: four stale terminals hid the live bridge session).
  const rank = (s) => (s.status === 'busy' || s.wake ? 1 : now - s.statusUpdatedAt < WAITING_FRESH_MS ? 0 : 2)
  eligible.sort(([, a], [, b]) => rank(a) - rank(b) || a.statusUpdatedAt - b.statusUpdatedAt)
  return { want: new Map(eligible.slice(0, maxCards)), live }
}

/**
 * Start polling. `post(pathname, body)` must resolve to {status, body} and is how
 * the poller reaches the server's own /activity handler. Returns a stop function;
 * `stop.tick()` runs one poll, exposed for the tests.
 */
export function startSessionPoller({
  post,
  config = {},
  dir = SESSIONS_DIR,
  projectsDir = PROJECTS_DIR,
  alive = pidAlive,
  existingLanes = [],
  log = console.log,
  titleRun, // injected CLI runner for the tests; undefined means the real claude CLI
  titleCachePath, // undefined means ~/.ledge/titles.json
} = {}) {
  const { pollMs, minBusyMs, maxCards, stuckAfterMs, summariseTitles, titleRefreshMs } = { ...DEFAULTS, ...config }
  const cards = new Map() // lane -> {pid, sig} for cards currently up
  // Adopt cards left on the lock screen by a previous run. Without this, a server
  // restart orphans every WAITING card: creation requires busy-past-minBusyMs, so
  // the poller would never touch them again and they would sit there stale forever.
  // pid null, never 0 or -1: process.kill(0, 0) signals the whole process group and
  // would report the card as alive, blocking cleanup permanently. Empty sig forces
  // one refresh on the first tick.
  for (const lane of existingLanes) {
    if (String(lane).startsWith('cc-')) cards.set(lane, { pid: null, sig: '' })
  }
  const titles = new Map() // sessionId -> resolved title; refreshed titles overwrite in place
  // One haiku call per new session upgrades the trimmed-prompt title to a real
  // one ("iOS lock screen agent webhook"), and a session that drifts topic is
  // re-summarised from its recent transcript once its title is older than
  // titleRefreshMs AND the transcript has changed — an unchanged transcript
  // costs zero calls, ever. Async and off the tick path: the updated `titles`
  // entry changes the card's signature, so the NEXT tick posts the better
  // label. ~/.ledge/titles.json keeps the schedule across restarts.
  const summarise = createTitleSummariser({
    enabled: summariseTitles !== false,
    run: titleRun,
    cachePath: titleCachePath,
    titleRefreshMs,
    onTitle: (key, title) => titles.set(key, title),
    log,
  })
  const activities = new Map() // transcript path -> {key, mtimeMs, value}, re-read only on change
  const questions = new Map() // same, for WAITING cards' last question
  const statuses = new Map() // same, for sessions whose file carries no status (sdk-cli)
  const wakeups = new Map() // same, for idle sessions parked on a /loop
  const refused = new Map() // lane -> the signature that was refused // lanes the server 4xx'd; don't re-spam every tick
  let timer = null
  let inFlight = false

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }

  /** A title decided in a previous boot (summarised or permanent fallback) wins
   *  outright; otherwise titleFor's trimmed prompt shows now and its
   *  onFirstPrompt hook gives the summariser its one shot. */
  function cardTitle(s) {
    const key = String(s.sessionId ?? s.pid)
    if (!titles.has(key)) {
      const known = summarise.known(key)
      if (known) titles.set(key, known)
    }
    return titleFor(s, titles, projectsDir, summarise.request)
  }

  /** WORKING reads the current activity and the stuck check; WAITING reads the
   *  last question instead. The stuck check reuses the stat currentActivity
   *  just took (the cache entry carries mtimeMs); a missing transcript leaves
   *  no entry, which is "no evidence", never "stuck". */
  function bodyFor(s, lane) {
    const file = transcriptPathFor(s.cwd, s.sessionId, projectsDir)
    const busy = s.status === 'busy'
    const activity = busy ? currentActivity(file, activities) : lastQuestion(file, questions)
    // The stat the activity/question cache just took doubles as the title
    // refresh trigger: no extra file open per tick, and recentContext (its own
    // read) runs only when the summariser decides a call is actually due.
    const mtimeMs = (activities.get(file) ?? questions.get(file))?.mtimeMs
    if (mtimeMs) summarise.refresh(String(s.sessionId ?? s.pid), mtimeMs, () => recentContext(file))
    const silentMs = busy ? Date.now() - (activities.get(file)?.mtimeMs || Infinity) : 0
    return activityBody(
      s,
      cardTitle(s),
      activity,
      silentMs >= stuckAfterMs ? silentMs : 0,
      lane,
    )
  }

  /** POST the card for one lane, but only when its content actually changed. */
  async function postCard(lane, s) {
    const body = bodyFor(s, lane)
    const sig = JSON.stringify(body)
    if (refused.get(lane) === sig) return // this exact body was already rejected
    if (cards.get(lane)?.sig === sig) return // no re-posting identical content
    const r = (await post('/activity', body)) ?? {}
    if (r.status >= 200 && r.status < 300) {
      log(`[sessions] card ${cards.has(lane) ? 'now' : 'up'} lane=${lane} pid=${s.pid} ${body.template}`)
      cards.set(lane, { pid: s.pid, sig })
      return
    }
    log(`[sessions] card refused lane=${lane}: ${r.status ?? '?'} ${r.body ?? ''}`)
    // Remember WHAT was refused, not just the lane. A 4xx means this body is
    // invalid; a later body may not be. Keying on the signature lets the lane
    // recover on its own instead of staying suppressed for the session's life.
    if (r.status < 500) refused.set(lane, sig) // 5xx or network: retry next tick
  }

  /** End every card whose session is gone. A card ends when its pid is dead or
   *  the cap evicted it. A lane merely missing from one read (half-written file)
   *  with a live pid is left alone: the card only ends when the session actually
   *  exits. */
  async function endDeadCards(want, live) {
    for (const [lane, card] of [...cards]) {
      if (want.has(lane) || (!live.has(lane) && alive(card.pid))) continue
      cards.delete(lane)
      const r = (await post('/activity/end', { lane })) ?? {}
      log(`[sessions] card down lane=${lane} -> ${r.status}`)
    }
  }

  /** Forgive refused lanes once they drop out of `want`, so a lane can try again
   *  when it next comes back with (presumably) different content. */
  function forgiveRefused(want) {
    for (const lane of [...refused.keys()]) if (!want.has(lane)) refused.delete(lane)
  }

  /** Forget what was posted for every card except `live`, so the next tick reposts
   *  the rest and the server, which has forgotten them too, push-to-starts fresh
   *  cards. Called with the lanes the phone still shows (/restore after a card was
   *  swiped off), or with nothing at all (a re-register wiped every card). */
  stop.forgetExcept = (live) => {
    const keep = new Set(live)
    for (const [lane, card] of cards) if (!keep.has(lane)) cards.set(lane, { ...card, sig: '' })
  }

  async function tick() {
    if (inFlight) return
    inFlight = true
    try {
      const sessions = readSessions(dir)
        ?.map((s) => withPendingWakeup(withInferredStatus(s, statuses, projectsDir), wakeups, projectsDir)) ?? null
      if (sessions === null) {
        log(`[sessions] ${dir} unreadable; poller disabled`)
        stop()
        return
      }
      const hasWork = (s) => Boolean(transcriptTitle(s.cwd, s.sessionId, projectsDir))
      const { want, live } = selectCards(sessions, cards, { minBusyMs, maxCards, alive, hasWork })
      for (const [lane, s] of want) await postCard(lane, s)
      await endDeadCards(want, live)
      forgiveRefused(want)
    } catch (e) {
      log(`[sessions] tick failed: ${e.message}`)
    } finally {
      inFlight = false
    }
  }

  if (!fs.existsSync(dir)) {
    log(`[sessions] ${dir} not found; poller disabled`)
    stop.tick = tick
    return stop
  }
  timer = setInterval(() => {
    tick() // async; its own try/catch means this can never throw or reject
  }, pollMs)
  timer.unref?.()
  log(`[sessions] polling ${dir} every ${pollMs}ms minBusyMs=${minBusyMs} maxCards=${maxCards}`)
  stop.tick = tick
  return stop
}
