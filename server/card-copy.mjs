// Card copy: pure text, no I/O.
//
// Phrasing, truncation, markdown stripping, time formatting — every function
// here is a pure function of its arguments. Anything that needs the filesystem
// belongs in claude-state.mjs instead.

import os from 'node:os'
import path from 'node:path'
import { LINE_MAX } from './server.mjs'

export const TITLE_LIMIT = 32

/** Human-ish name for a session: name -> cwd basename -> pid. */
export const rawName = (s) =>
  (typeof s.name === 'string' && s.name) ||
  (typeof s.cwd === 'string' && s.cwd && path.basename(s.cwd)) ||
  String(s.pid)

/** `cc-` + name sanitized to LANE_RE. The prefix namespaces poller lanes away from
 *  hook lanes so they cannot collide. This is the stable card identity; the
 *  displayed title is separate and must never feed back into the lane. */
export function laneFor(s) {
  const clean = String(rawName(s))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `cc-${clean || s.pid}`.slice(0, 24)
}

/** cwd with $HOME as ~, truncated from the LEFT at a path boundary so the
 *  meaningful tail survives: "…/career-ops/prep/phd". */
export function lineFor(cwd, max = LINE_MAX, home = os.homedir()) {
  let p = typeof cwd === 'string' ? cwd : ''
  if (p === home) p = '~'
  else if (p.startsWith(home + '/')) p = '~' + p.slice(home.length)
  if (p.length <= max) return p
  let tail = p.slice(-(max - 1))
  const cut = tail.indexOf('/')
  if (cut > 0) tail = tail.slice(cut)
  return `…${tail}`
}

// --- titles ----------------------------------------------------------------

/** Segments that identify nothing. A title of "Desktop" helps no one. */
const GENERIC_SEG = new Set([
  '~', 'users', 'home', 'desktop', 'documents', 'downloads', 'playground',
  'code', 'src', 'repos', 'projects', 'dev', 'work', 'tmp',
])

/** The distinctive part of a filesystem path: the deepest segment that is not a
 *  generic container and not a filename. "~/Desktop/Playground/memecoin-edge/
 *  HANDOFF.md" -> "memecoin-edge". Returns "" when there is nothing better. */
export function pathLabel(text) {
  const token = String(text).split(/\s+/).find((t) => t.includes('/') && t.length > 8)
  if (!token) return ''
  const segs = token
    .replace(/[.,;:!?)\]}'"]+$/, '')
    .split('/')
    .filter(
      (x) =>
        x.length > 2 && !GENERIC_SEG.has(x.toLowerCase()) && !/\.[A-Za-z0-9]{1,5}$/.test(x),
    )
  return segs.length ? segs[segs.length - 1] : ''
}

/** Collapse whitespace, cut at a word boundary near `max` (never mid-word),
 *  drop trailing punctuation. */
export function titleTrim(raw, max = TITLE_LIMIT) {
  let s = String(raw).replace(/\s+/g, ' ').trim()
  // A long path eats the whole label. Replace each path with its distinctive
  // segment in place, so the surrounding prose survives:
  //   "Read ~/Desktop/Playground/memecoin-edge/HANDOFF.md and continue"
  //     -> "Read memecoin-edge and continue"
  //   "~/Desktop/Playground/memecoin-edge/PROMPT.md"  -> "memecoin-edge"
  s = s
    .split(' ')
    .map((tok) => (tok.includes('/') && tok.length > 8 ? pathLabel(tok) || tok : tok))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > max) {
    const head = s.slice(0, max + 1)
    const cut = head.lastIndexOf(' ')
    // Prefer a word boundary, but not at any cost. A prompt that opens with a long
    // path ("Read ~/Desktop/.../HANDOFF.md and continue") has its only space at
    // index 4, and cutting there titles the card "Read". When the boundary would
    // throw away more than half the budget, hard-cut instead and mark the elision.
    s = cut > max / 2 ? head.slice(0, cut) : head.slice(0, max - 1) + '…'
  }
  return s.replace(/[\s.,;:!?-]+$/, '')
}

// --- tool phrases ----------------------------------------------------------

const str = (v) => (typeof v === 'string' ? v : '')
const hostOf = (u) => {
  try {
    return new URL(u).hostname
  } catch {
    return ''
  }
}
const baseOf = (p) => path.basename(str(p))

/** Tool name -> phrase. `__proto__: null` so a hostile tool name like
 *  "constructor" cannot reach up the prototype chain. */
const PHRASES = {
  __proto__: null,
  Bash: (i) => `running ${str(i.description) || str(i.command).slice(0, 40)}`,
  Read: (i) => `reading ${baseOf(i.file_path)}`,
  Edit: (i) => `editing ${baseOf(i.file_path)}`,
  Write: (i) => `editing ${baseOf(i.file_path)}`,
  NotebookEdit: (i) => `editing ${baseOf(i.file_path)}`,
  Grep: (i) => readablePattern(i.pattern),
  // A glob reads fine to a human (**/*.mjs); a regex does not.
  Glob: (i) => `searching ${str(i.pattern) || 'files'}`,
  WebSearch: () => 'searching the web',
  WebFetch: (i) => `fetching ${hostOf(i.url)}`,
  Task: (i) => `delegating ${str(i.description)}`,
  Agent: (i) => `delegating ${str(i.description)}`,
  TodoWrite: () => 'planning',
}

/** A search pattern only helps if a human can read it. Raw regex ("^\\s*export
 *  function") is line noise, so anything with metacharacters degrades to a plain
 *  phrase rather than shouting punctuation from the lock screen. */
export function readablePattern(pattern) {
  const p = str(pattern).trim()
  if (!p) return 'searching the code'
  if (/[\\^$*+?{}()[\]|]/.test(p)) return 'searching the code'
  return `searching for ${p}`
}

/** An MCP tool is named mcp__<server>__<tool>. Rendered raw it is a name dump:
 *  "mcp__blender__get_scene_info". Say who and what instead: "blender: get scene info". */
export function defaultPhrase(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name)
  if (m) return `${m[1].replace(/_/g, ' ')}: ${m[2].replace(/_/g, ' ')}`.toLowerCase()
  return name.toLowerCase()
}

/** "editing sessions.mjs", not a tool name dump. "" when there is nothing to say. */
export function toolPhrase(block) {
  const name = str(block?.name)
  const inp = block?.input && typeof block.input === 'object' ? block.input : {}
  let s = (PHRASES[name] ?? (() => defaultPhrase(name)))(inp)
  s = s.replace(/\s+/g, ' ').trim().replace(/\.+$/, '')
  if (s.length > LINE_MAX) {
    const head = s.slice(0, LINE_MAX)
    const cut = head.lastIndexOf(' ')
    s = (cut > LINE_MAX / 2 ? head.slice(0, cut) : head.slice(0, LINE_MAX - 1)) + '…'
  }
  return s
}

/** Markdown -> plain text, enough for a one-line lock screen headline: fenced
 *  code and its contents go (a "?" inside code is not a question), inline
 *  backticks, bold/italic asterisks, heading hashes and list bullets are
 *  unwrapped, links keep their label. Underscores are left alone: snake_case
 *  identifiers are far more common in these transcripts than _italics_. */
export function stripMd(s) {
  return String(s)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*\|.*$/gm, ' ') // table rows: a "?" in a cell is not a question
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^[ \t]*#{1,6}\s+/gm, '')
    .replace(/\*+/g, '')
}

/** 600000 -> "10m", 3900000 -> "1h 5m". Whole minutes; nobody needs seconds. */
export function fmtMins(ms) {
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// --- card body -------------------------------------------------------------

/** `activity` is the current activity for WORKING, the last question for
 *  WAITING. `stuckMs` > 0 flags a WORKING session whose transcript has been
 *  silent past stuckAfterMs: tone warn, "no output for Nm" — but still template
 *  progress, because needs_you means "Claude asked you something" and a wedged
 *  session is not that; conflating them would make the loud state meaningless. */
/** The headline. WORKING leads with what the session is doing right now and falls
 *  back to its directory; WAITING leads with the question Claude asked and falls
 *  back to "your turn". A stuck session says how long it has been silent. */
function lineFrom(s, waiting, activity, stuckMs) {
  if (waiting) return activity || 'your turn'
  if (stuckMs) return `no output for ${fmtMins(stuckMs)}`
  return activity || lineFor(s.cwd)
}

/** A shell session is him poking around, not Claude waiting on him. It shows as a
 *  quiet neutral card so orange keeps meaning "something wants your attention". */
const isShell = (s) => s.status === 'shell'

/** claude://code/<id> opens the session in the Claude app. bridgeSessionId already
 *  carries the session_ prefix, so it is not added again. */
function deepLink(s) {
  const id = s.bridgeSessionId
  return typeof id === 'string' && id ? `claude://code/${encodeURIComponent(id)}` : ''
}

export function activityBody(s, title, activity = '', stuckMs = 0, lane = laneFor(s)) {
  const waiting = s.status !== 'busy' && !isShell(s) // idle or unknown: it wants him
  const url = deepLink(s)
  // Parked on a /loop: not waiting on him, it wakes itself. A countdown to the
  // wake, the loop's own reason as the line, quiet tone.
  if (waiting && s.wake) {
    return {
      lane, title, template: 'countdown', tone: 'neutral',
      line: titleTrim(s.wake.reason || 'on a loop, wakes itself', LINE_MAX),
      startedAt: s.wake.at, deadline: s.wake.wakeAt,
      ...(url ? { url } : {}),
    }
  }
  return {
    // The caller may have disambiguated a name collision; honour its lane.
    lane,
    title,
    template: waiting ? 'needs_you' : 'progress',
    tone: (waiting || stuckMs) && !isShell(s) ? 'warn' : 'neutral',
    line: lineFrom(s, waiting, activity, stuckMs),
    // statusUpdatedAt, not startedAt: WORKING times how long it has been working,
    // WAITING times how long it has been waiting on him.
    startedAt: s.statusUpdatedAt,
    ...(url ? { url } : {}),
  }
}
