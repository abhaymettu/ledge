// Claude Code's internal state, read defensively.
//
// Everything that opens ~/.claude/sessions/<pid>.json or a transcript under
// ~/.claude/projects lives here, so the entire blast radius of an upstream
// format change is this one file. The files are undocumented internal state
// from another program: every read is defensive, and anything shaped wrong is
// skipped rather than guessed at.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { LINE_MAX } from './server.mjs'
import { rawName, titleTrim, toolPhrase, stripMd } from './card-copy.mjs'

export const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions')
export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
export const TRANSCRIPT_HEAD_BYTES = 256 * 1024

const tryParse = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // alive, just not ours
  }
}

/** A session file we are willing to reason about at all. */
export function validShape(s) {
  if (!s || typeof s !== 'object' || s.kind !== 'interactive') return false
  if (!Number.isInteger(s.pid) || s.pid <= 0) return false
  return typeof s.statusUpdatedAt === 'number' && Number.isFinite(s.statusUpdatedAt)
}

/** null means the directory itself is unreadable; a bad file is just skipped:
 *  one malformed or half-written file must not hide the others. */
export function readSessions(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const out = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    let raw
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    const s = tryParse(raw)
    if (s) out.push(s)
  }
  return out
}

/** Text of a transcript user message: a plain string, or joined text blocks
 *  (tool_result blocks yield nothing, which is correct: they are not prompts). */
function messageText(m) {
  const c = m?.content
  if (typeof c === 'string') return c.trim()
  if (!Array.isArray(c)) return ''
  return c
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .trim()
}

/** ~/.claude/projects/<cwd with "/" as "-">/<sessionId>.jsonl */
export function transcriptPathFor(cwd, sessionId, projectsDir = PROJECTS_DIR) {
  return path.join(projectsDir, String(cwd).replaceAll('/', '-'), `${sessionId}.jsonl`)
}

/** First real user prompt from the session transcript, or null. Reads only the
 *  first TRANSCRIPT_HEAD_BYTES — these files reach tens of megabytes. Silent on
 *  any failure: a missing transcript is normal, not an error. */
export function transcriptTitle(cwd, sessionId, projectsDir = PROJECTS_DIR) {
  const file = transcriptPathFor(cwd, sessionId, projectsDir)
  let text, truncated
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(TRANSCRIPT_HEAD_BYTES)
    const n = fs.readSync(fd, buf, 0, TRANSCRIPT_HEAD_BYTES, 0)
    fs.closeSync(fd)
    text = buf.subarray(0, n).toString('utf8')
    truncated = n === TRANSCRIPT_HEAD_BYTES
  } catch {
    return null
  }
  const lines = text.split('\n')
  if (truncated) lines.pop() // the last line was cut mid-record
  for (const line of lines) {
    const o = tryParse(line)
    const t = o?.type === 'user' ? messageText(o.message) : ''
    // Leading "<" means a system reminder or command wrapper, not the real prompt.
    if (t && !t.startsWith('<')) return t
  }
  return null
}

/** Card title: transcript first prompt -> name -> cwd basename -> pid. Cached —
 *  a session's first prompt never changes, so the transcript is read at most once
 *  per session, never again on later ticks. `onFirstPrompt(key, prompt, title)`
 *  fires once, on the cache miss that found a real transcript prompt — the hook
 *  the title summariser hangs off. */
export function titleFor(s, cache = new Map(), projectsDir = PROJECTS_DIR, onFirstPrompt) {
  const key = String(s.sessionId ?? s.pid)
  const hit = cache.get(key)
  if (hit) return hit
  const prompt = transcriptTitle(s.cwd, s.sessionId, projectsDir)
  const title = titleTrim(prompt ?? rawName(s)) || String(s.pid)
  cache.set(key, title)
  if (prompt) onFirstPrompt?.(key, prompt, title)
  return title
}

// --- summarised titles -----------------------------------------------------
// titleTrim of a raw first prompt reads like "someone gave bots free reign on";
// the Claude app titles the same session "iOS lock screen agent webhook". One
// haiku CLI call per NEW session buys that quality, and a long session that
// drifts topic (started on memecoin, now doing Kalshi) is RE-summarised from
// its recent transcript on a bounded schedule, so the label tracks what the
// session is doing now. The calls are async and off the tick path: the card
// shows the trimmed fallback immediately and the better title lands on a later
// tick. Outcomes persist to ~/.ledge/titles.json as {title, at} per session.
//
// COST GUARANTEE (the CLI is the owner's metered subscription): a session whose
// transcript has not changed since its last summary costs ZERO model calls,
// ever. A refresh fires only when the cached title is older than titleRefreshMs
// AND the transcript mtime is newer than that summary — roughly one cheap call
// per active, changing session per 20 minutes, and none for a quiet one.

export const TITLES_PATH = path.join(os.homedir(), '.ledge', 'titles.json')
const SUMMARISE_TIMEOUT_MS = 20_000

// Under launchd PATH is nearly empty, and the owner's interactive `claude` is a
// shell function besides, so a bare execFile('claude') finds nothing. Resolve the
// real binary across its usual homes once at module load.
const claudeBin =
  [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].find((c) => { try { fs.accessSync(c, fs.constants.X_OK); return true } catch { return false } }) ?? 'claude'

function claudeRun(instruction) {
  return new Promise((resolve, reject) => {
    // Argument list, never a shell string: the prompt is untrusted text.
    // cwd is tmpdir so the call picks up no project CLAUDE.md context.
    execFile(
      claudeBin,
      ['-p', '--model', 'haiku', instruction],
      { timeout: SUMMARISE_TIMEOUT_MS, cwd: os.tmpdir() },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })
}

/**
 * Ask the CLI for a short title. Resolves to the title, or null for any answer
 * that fails the rules — empty, multi-line, quoted, under 2 or over 5 words,
 * 32+ chars (a refusal is a sentence, so the word cap rejects it too) — or any
 * error or timeout. Never throws. Callers must not retry a null: one shot per
 * session, ever.
 */
/** A first prompt that is mostly a path ("~/x/memecoin-edge/HANDOFF.md") cannot be
 *  summarised — the model tries to read the file and refuses — and its path-based
 *  fallback ("memecoin-edge") is already the label we want. Detect that so the
 *  metered call is not wasted. */
export function isPathPrompt(text) {
  const prose = String(text).replace(/\S*\/\S*/g, ' ').replace(/\s+/g, ' ').trim()
  return prose.split(/\s+/).filter(Boolean).length < 3
}

export function summariseTitle(context, run = claudeRun, onError = () => {}) {
  const instruction =
    'Give a 2-4 word title for what this coding session is currently working on, ' +
    'based on this recent activity; answer with the title only.\n\n' +
    String(context).slice(0, 600)
  return run(instruction).then(
    (out) => {
      const t = String(out ?? '').trim()
      if (!t || t.includes('\n')) return null
      if (/^["'`“”‘’]|["'`“”‘’]$/.test(t)) return null
      const words = t.split(/\s+/).length
      return words >= 2 && words <= 5 && t.length < 32 ? t : null
    },
    (err) => {
      onError(err)
      return null
    },
  )
}

/** ~/.ledge/titles.json: sessionId -> {title, at}. Legacy entries were bare
 *  strings; they load with at 0, so an active legacy session refreshes once and
 *  then follows the schedule. Anything else shaped wrong is dropped. */
function readTitles(cachePath) {
  const out = Object.create(null)
  let o
  try {
    o = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  } catch {
    return out // no cache yet is normal
  }
  for (const [k, v] of Object.entries(o ?? {})) {
    if (typeof v === 'string') out[k] = { title: v, at: 0 }
    else if (typeof v?.title === 'string' && typeof v.at === 'number') out[k] = v
  }
  return out
}

function writeTitles(cachePath, done, log) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath + '.tmp', JSON.stringify(done))
    fs.renameSync(cachePath + '.tmp', cachePath)
  } catch (e) {
    log(`[sessions] titles cache write failed: ${e.message}`)
  }
}

/**
 * Whether a session's title is due a refresh. THE ZERO-COST GUARANTEE lives
 * here: a refresh fires only when the last summary (or attempt) is older than
 * titleRefreshMs AND the transcript mtime is NEWER than that summary. A
 * transcript unchanged since its last summary keeps mtimeMs <= lastAt forever,
 * so a quiet session costs zero model calls, ever, however stale its title.
 * lastAt undefined means never summarised or attempted: that is the first-
 * summary path's job (request), never a refresh.
 */
export function needsRefresh(lastAt, mtimeMs, titleRefreshMs, now) {
  return lastAt !== undefined && now - lastAt >= titleRefreshMs && mtimeMs > lastAt
}

/** One CLI call in flight, the rest queued; each queued job launches as the
 *  worker frees, so simultaneous new sessions are summarised one at a time and
 *  a refresh queues behind a first summary. `perform` must never reject. */
function singleWorker(perform) {
  const pending = new Map() // sessionId -> text, awaiting the one worker
  let inFlight = false
  function pump() {
    if (inFlight || pending.size === 0) return
    const [sessionId, text] = pending.entries().next().value
    pending.delete(sessionId)
    inFlight = true
    perform(sessionId, text).finally(() => {
      inFlight = false
      pump()
    })
  }
  return {
    pending,
    push(sessionId, text) {
      pending.set(sessionId, text) // idempotent; deferred until the worker frees
      pump()
    },
  }
}

/**
 * The bounded-schedule machinery around summariseTitle. `request` gives a NEW
 * session its first summary (once, whatever the outcome — the trimmed fallback
 * stands if the call fails); `refresh` re-summarises a session from its recent
 * transcript when needsRefresh says the title is stale AND the transcript has
 * changed. A success lands in `onTitle` and persists to disk as {title, at},
 * so a restart never re-summarises ahead of schedule. When `run` is not
 * injected the real CLI is used and probed for once at startup; a missing
 * binary makes the whole feature inert.
 */
export function createTitleSummariser({
  enabled = true,
  run,
  cachePath = TITLES_PATH,
  titleRefreshMs = 1_200_000,
  onTitle = () => {},
  log = console.log,
  now = Date.now,
} = {}) {
  const done = readTitles(cachePath) // sessionId -> {title, at} (persisted)
  // sessionId -> when its last model call (or deliberate skip) happened, seeded
  // from disk so restarts keep the schedule. This is `lastAt` for needsRefresh.
  const attemptedAt = new Map(Object.entries(done).map(([k, v]) => [k, v.at]))
  const fallbacks = Object.create(null) // sessionId -> trimmed fallback shown until summarised
  let ok = enabled
  if (ok && !run) {
    run = claudeRun
    const probe = claudeBin === 'claude' ? ['which', ['claude']] : ['test', ['-x', claudeBin]]
    execFile(probe[0], probe[1], (err) => {
      if (err) {
        ok = false
        log('[sessions] claude not found; title summarisation off')
      }
    })
  }
  async function perform(sessionId, text) {
    const at = now()
    attemptedAt.set(sessionId, at) // one call per schedule slot, whatever the result
    const title = await summariseTitle(text, run, (err) => {
      // A metered call that fails should say why once, not vanish. stderr from
      // the CLI is the useful part (auth, rate limit); the message is the rest.
      const why = String(err?.stderr || err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 120)
      log(`[sessions] title summarise failed: ${why}`)
    })
    if (!title) return // the fallback, or the previous title, stands until the next slot
    done[sessionId] = { title, at }
    delete fallbacks[sessionId]
    writeTitles(cachePath, done, log)
    onTitle(sessionId, title)
  }
  const worker = singleWorker(perform)
  /** A path-only or empty text cannot be summarised; marking it attempted
   *  re-arms the refresh clock instead of burning a metered call on it. */
  function submit(sessionId, text) {
    if (isPathPrompt(text)) attemptedAt.set(sessionId, now())
    else worker.push(sessionId, text)
  }
  return {
    /** The summarised title for this session, if it has one yet. */
    known: (sessionId) => done[sessionId]?.title,
    /** The best label we have now: the summary if ready, else the fallback. */
    label: (sessionId) => done[sessionId]?.title ?? fallbacks[sessionId],
    /** Fire-and-forget first summary. One call per new session, but a session
     *  not yet summarised is retried when the single worker frees, rather than
     *  dropped: three sessions at once must not strand one on its fallback. */
    request(sessionId, prompt, fallback) {
      if (!ok || attemptedAt.has(sessionId)) return
      fallbacks[sessionId] ??= fallback
      submit(sessionId, prompt)
    },
    /** Fire-and-forget refresh. `getContext` is a thunk (recentContext is a
     *  file read) evaluated only once needsRefresh says a call is due. */
    refresh(sessionId, mtimeMs, getContext) {
      if (!ok || worker.pending.has(sessionId)) return
      if (needsRefresh(attemptedAt.get(sessionId), mtimeMs, titleRefreshMs, now())) {
        submit(sessionId, getContext())
      }
    },
  }
}

// --- recent context --------------------------------------------------------

export const RECENT_CONTEXT_BYTES = 24 * 1024
export const RECENT_CONTEXT_CHARS = 600

/**
 * A compact plain-text digest of what the session is CURRENTLY doing, for the
 * title summariser: the last few user prompts and assistant text blocks from
 * the transcript tail (last RECENT_CONTEXT_BYTES), markdown stripped, newest
 * last, capped at RECENT_CONTEXT_CHARS with the OLDEST material trimmed first
 * — the newest is the topic. tool_use/tool_result carry no prose (messageText
 * yields nothing for them) and "<"/"["-prefixed texts are reminders and
 * command wrappers; all are skipped. Never throws; "" when nothing usable.
 */
export function recentContext(file) {
  let text
  try {
    const st = fs.statSync(file)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(st.size, RECENT_CONTEXT_BYTES))
    const n = fs.readSync(fd, buf, 0, buf.length, Math.max(0, st.size - RECENT_CONTEXT_BYTES))
    fs.closeSync(fd)
    text = buf.subarray(0, n).toString('utf8')
    // Window starts mid-line: the partial first line is discarded.
    if (st.size > RECENT_CONTEXT_BYTES) text = text.slice(text.indexOf('\n') + 1)
  } catch {
    return ''
  }
  const parts = [] // collected newest first
  const lines = text.split('\n')
  let len = 0
  for (let i = lines.length - 1; i >= 0 && len < RECENT_CONTEXT_CHARS; i--) {
    const o = tryParse(lines[i]) ?? {}
    // Only user/assistant entries carry prose; "<"/"[" lead reminders, command
    // wrappers, and hook noise, not the topic.
    const t = /^(user|assistant)$/.test(o.type) ? messageText(o.message) : ''
    if (!t || /^[<[]/.test(t)) continue
    const clean = stripMd(t).replace(/\s+/g, ' ').trim()
    if (!clean) continue
    parts.push(clean)
    len += clean.length + 1
  }
  // Oldest -> newest; the char cap trims the front so the newest survives whole.
  return parts.reverse().join('\n').slice(-RECENT_CONTEXT_CHARS)
}

/**
 * Read the last TRANSCRIPT_HEAD_BYTES of `file` and hand its lines to `extract`.
 * Never throws — the transcript is another program's internal state; missing or
 * unreadable returns "" and drops any stale cache entry (so a vanished file
 * leaves no stale mtime behind). A single line can exceed 96KB (large tool
 * results), so when the file is bigger than the window the partial first line
 * is discarded. Cached by mtimeMs + size: this runs every pollMs per session,
 * and an unchanged file costs one stat(), not a 256KB read. The cache entry
 * keeps mtimeMs so the poller's stuck check reuses this stat, never adding one.
 */
function scanTail(file, cache, extract) {
  let text, key, mtimeMs
  try {
    const st = fs.statSync(file)
    key = `${st.mtimeMs}:${st.size}`
    mtimeMs = st.mtimeMs
    const hit = cache.get(file)
    if (hit?.key === key) return hit.value
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(st.size, TRANSCRIPT_HEAD_BYTES))
    const n = fs.readSync(fd, buf, 0, buf.length, Math.max(0, st.size - TRANSCRIPT_HEAD_BYTES))
    fs.closeSync(fd)
    text = buf.subarray(0, n).toString('utf8')
    // Window starts mid-line: the partial first line is discarded. A single
    // transcript line can exceed 96KB, so this cannot be a smaller window.
    if (st.size > TRANSCRIPT_HEAD_BYTES) text = text.slice(text.indexOf('\n') + 1)
  } catch {
    cache.delete(file) // no file, no evidence: a stale mtime must not linger
    return ''
  }
  const value = extract(text.split('\n'))
  cache.set(file, { key, mtimeMs, value })
  return value
}

// --- current activity ------------------------------------------------------
// The WORKING card's line says what the session is doing right now, read from
// the newest tool_use in the transcript tail. The cwd is the fallback, not the
// headline: "running npm test" beats "~/chief".

/**
 * What the session is doing right now: the LAST tool_use block of the NEWEST
 * transcript entry that has one, phrased for a human. "" when there is nothing.
 */
export function currentActivity(file, cache = new Map()) {
  return scanTail(file, cache, (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const blocks = tryParse(lines[i])?.message?.content
      // Last tool_use within the entry wins.
      const b = Array.isArray(blocks) && blocks.findLast((x) => x?.type === 'tool_use')
      if (b) return toolPhrase(b)
    }
    return ''
  })
}

// --- last question ---------------------------------------------------------
// The WAITING card's line shows what Claude actually asked, not "your turn".
// When a session goes idle, the newest assistant text is usually a question
// aimed at the owner; showing it saves him opening the terminal to find out.

/**
 * The question the session just asked, or "". Scans backwards for the newest
 * assistant entry with a text block, strips markdown, and takes the LAST
 * sentence ending in "?". Deliberately strict about what it shows: no question
 * means the session probably just finished, not asked ("" -> "your turn");
 * a question longer than LINE_MAX is rejected whole rather than truncated
 * ("should I also update the" tells him nothing and looks broken); a one-word
 * question ("Thoughts?") is noise. Same tail window + stat cache as
 * currentActivity, own cache map. Never throws.
 */
export function lastQuestion(file, cache = new Map()) {
  return scanTail(file, cache, (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = tryParse(lines[i])
      if (o?.type !== 'assistant') continue
      const text = messageText(o.message)
      if (!text) continue
      // Colons and newlines also end a sentence here: "Quick question:" and a
      // heading line above the question are lead-in, not part of it.
      const qs = stripMd(text).match(/[^.!?:\n]*\?/g)
      const q = qs ? qs[qs.length - 1].replace(/\s+/g, ' ').trim() : ''
      // A double quote means Claude was quoting or drafting a message ("Can I
      // send you my resume?" aimed at a recruiter) — not asking the owner.
      return q.length <= LINE_MAX && q.includes(' ') && !/["“”]/.test(q) ? q : ''
    }
    return ''
  })
}

// --- inferred status ---------------------------------------------------------
// Sessions the Claude app drives over the bridge (entrypoint "sdk-cli": the ones
// he actually works in from the phone) never write `status` to their session
// file. The transcript says it instead. The newest message entry is either
// Claude mid-turn (a tool_use, or a user entry: a prompt or a tool_result Claude
// is about to continue from) = busy, or Claude's closing text = idle.
// Attachment, system and bridge entries carry no signal and are skipped.

/**
 * {status, statusUpdatedAt} read from the transcript tail, or null when the
 * tail holds no message entry. Busy counts from the prompt that started the
 * turn (the newest user entry that is not a tool_result), so the WORKING timer
 * does not reset on every tool call. Same window and cache as currentActivity,
 * own cache map. Never throws.
 */
export function inferredStatus(file, cache = new Map()) {
  return scanTail(file, cache, (lines) => {
    let status = null
    let oldest = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = tryParse(lines[i])
      if (o?.type !== 'assistant' && o?.type !== 'user') continue
      const blocks = o.message?.content
      const has = (t) => Array.isArray(blocks) && blocks.some((x) => x?.type === t)
      oldest = Date.parse(o.timestamp) || Date.now()
      if (!status) {
        status = o.type === 'user' || has('tool_use') ? 'busy' : 'idle'
        // A turn that ends by parking on ScheduleWakeup leaves its tool_result
        // as the newest entry; that is idle, not mid-turn.
        if (o.type === 'user' && has('tool_result')) {
          const prev = lines.slice(0, i).reverse().map(tryParse).find((p) => p?.type === 'assistant')
          const c = prev?.message?.content
          if (Array.isArray(c) && c.some((x) => x?.type === 'tool_use' && x.name === 'ScheduleWakeup')) status = 'idle'
        }
        if (status === 'idle') return { status, statusUpdatedAt: oldest }
      }
      if (o.type === 'user' && !has('tool_result')) return { status, statusUpdatedAt: oldest }
    }
    // A long turn outruns the window: no prompt in it, so the oldest entry seen
    // stands in for the start (withInferredStatus pins it so it cannot creep).
    return status ? { status, statusUpdatedAt: oldest } : null
  }) || null
}

/** A session with no `status` gets one read from its transcript; any other
 *  session is returned as is. */
export function withInferredStatus(s, cache = new Map(), projectsDir = PROJECTS_DIR) {
  if (typeof s.status === 'string') return s
  const file = transcriptPathFor(s.cwd, s.sessionId, projectsDir)
  const inferred = inferredStatus(file, cache)
  if (!inferred) return s
  // While busy, the start never moves later: a turn longer than the tail window
  // would otherwise report a start that creeps forward every tick, and the card
  // would repost every tick. Idle clears the pin.
  const pinKey = `pin:${file}`
  let { status, statusUpdatedAt } = inferred
  if (status === 'busy') {
    statusUpdatedAt = Math.min(statusUpdatedAt, cache.get(pinKey) ?? Infinity)
    cache.set(pinKey, statusUpdatedAt)
  } else cache.delete(pinKey)
  return { ...s, status, statusUpdatedAt }
}

// --- pending wake-up ---------------------------------------------------------
// A session parked on a /loop (ScheduleWakeup) is idle to Claude Code, but it is
// not waiting on him: it will resume by itself. Carding it "your turn" was the
// complaint of 2026-08-29. The transcript shows the park: the newest
// ScheduleWakeup tool_use, with no real prompt after it.

/** A wake-up is still pending this long past its due time; a loop that has not
 *  fired by then is treated as idle for real. */
export const WAKE_GRACE_MS = 120_000

/** True for a user entry that is a prompt, not a tool_result. */
const isPrompt = (o) => o?.type === 'user' &&
  (typeof o.message?.content === 'string' || (Array.isArray(o.message?.content) && !o.message.content.some((x) => x?.type === 'tool_result')))

/**
 * The newest ScheduleWakeup not followed by a real prompt and not a stop:
 * {at, wakeAt, reason} in ms, or null. Same window and cache as currentActivity,
 * own cache map. Never throws.
 */
export function pendingWakeup(file, cache = new Map()) {
  return scanTail(file, cache, (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = tryParse(lines[i])
      if (isPrompt(o)) return null
      if (o?.type !== 'assistant') continue
      const blocks = o.message?.content
      const w = Array.isArray(blocks) && blocks.findLast((x) => x?.type === 'tool_use' && x.name === 'ScheduleWakeup')
      if (!w) continue
      if (w.input?.stop === true) return null
      const at = Date.parse(o.timestamp) || Date.now()
      const delay = Number(w.input?.delaySeconds)
      const reason = typeof w.input?.reason === 'string' ? w.input.reason.replace(/\s+/g, ' ').trim() : ''
      return { at, wakeAt: at + (Number.isFinite(delay) ? delay : 0) * 1000, reason }
    }
    return null
  }) || null
}

/** An idle session with a wake-up still pending gets `wake` attached, so the
 *  poller ranks it with the working sessions and the card shows the countdown. */
export function withPendingWakeup(s, cache = new Map(), projectsDir = PROJECTS_DIR, now = Date.now()) {
  if (s.status === 'busy') return s
  const wake = pendingWakeup(transcriptPathFor(s.cwd, s.sessionId, projectsDir), cache)
  return wake && now < wake.wakeAt + WAKE_GRACE_MS ? { ...s, wake } : s
}
