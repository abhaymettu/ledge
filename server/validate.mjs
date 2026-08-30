// Boundary validation for the ledge server. Each field's rule is declared once;
// validateActivity walks them in order. Everything returns {error} or {value},
// never throws.

import { appleDate } from './apns.mjs'

export const TEMPLATES = ['progress', 'needs_you', 'result', 'countdown']
export const TONES = ['neutral', 'warn', 'ok', 'fail']
export const LANE_RE = /^[a-z0-9-]{1,24}$/
export const TITLE_MAX = 32
export const LINE_MAX = 60
// Overflow inside this is truncated; past it the caller is confused, so 400 instead of
// silently throwing away 5KB of text.
export const TEXT_HARD_CAP = 256
export const URL_MAX = 256
// Hosts a lane may make tappable from the lock screen. Deliberately short.
export const URL_HOSTS = ['claude.ai']
// Exactly claude://code/<id>. Not a general claude:// allowance.
export const CLAUDE_DEEP_LINK = /^claude:\/\/code\/[A-Za-z0-9_-]{1,64}$/
export const DEADLINE_PAST_MS = 24 * 3600_000
export const DEADLINE_FUTURE_MS = 365 * 24 * 3600_000

const truncate = (s, n) => {
  const cp = Array.from(s)
  return cp.length <= n ? s : cp.slice(0, n).join('')
}

const bad = (reason) => ({ error: reason })

function checkText(name, raw, max, out) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return bad(`${name} must be a string`)
  if (raw.length > TEXT_HARD_CAP) return bad(`${name} too long (${raw.length} > ${TEXT_HARD_CAP})`)
  out[name] = truncate(raw, max)
  return null
}

// Epoch seconds is the documented unit, but Date.now() hands you milliseconds and
// passing those silently rendered a countdown to the year 58000 on the lock screen.
// Nothing in seconds exceeds 1e11 until the year 5138, so treat that as milliseconds.
const epochMs = (n) => (typeof n === 'number' ? (n > 1e11 ? n : n * 1000) : Date.parse(n))

// --- per-field rules for POST /activity, walked in this order ---------------

function laneField(body, v) {
  if (typeof body.lane !== 'string' || !LANE_RE.test(body.lane)) {
    return bad('lane must match ^[a-z0-9-]{1,24}$')
  }
  v.lane = body.lane
  return null
}

function templateField(body, v) {
  if (!TEMPLATES.includes(body.template)) {
    return bad(`template must be one of ${TEMPLATES.join(' | ')}`)
  }
  v.template = body.template
  return null
}

function titleField(body, v) {
  // No title supplied means "leave the label alone". The poller owns the label;
  // a hook firing on the same lane must not reset it to the routing key, which is
  // what put 'cc-chief-b7' on the lock screen. Blank counts as not supplied: an
  // empty or whitespace title used to slip through checkText and clobber the
  // label anyway, because '' is a present string and ?? treats it as set.
  if (body.title === undefined || body.title === null) return null
  if (typeof body.title !== 'string') return bad('title must be a string')
  if (body.title.length > TEXT_HARD_CAP) {
    return bad(`title too long (${body.title.length} > ${TEXT_HARD_CAP})`)
  }
  const trimmed = body.title.trim()
  if (trimmed) v.title = truncate(trimmed, TITLE_MAX)
  return null
}

function lineField(body, v) {
  v.line = ''
  return checkText('line', body.line, LINE_MAX, v)
}

function progressField(body, v) {
  if (body.progress === undefined || body.progress === null) return null
  const n = Number(body.progress)
  if (!Number.isFinite(n)) return bad('progress must be a number 0...1')
  v.progress = Math.min(1, Math.max(0, n))
  return null
}

function deadlineField(body, v) {
  if (body.deadline === undefined || body.deadline === null) return null
  const ms = epochMs(body.deadline)
  if (!Number.isFinite(ms)) return bad('deadline must be epoch seconds or an ISO 8601 string')
  // A deadline outside this window is a unit mistake, not a real date. Fail loudly.
  if (ms < Date.now() - DEADLINE_PAST_MS || ms > Date.now() + DEADLINE_FUTURE_MS) {
    return bad('deadline must be within the last day or the next year')
  }
  v.deadline = ms
  return null
}

// A tappable deep link. This lands on his lock screen, so it is a trust boundary:
// https only, length capped, and host-restricted so a lane cannot put an arbitrary
// link in front of him.
function urlField(body, v) {
  if (body.url === undefined || body.url === null) return null
  if (typeof body.url !== 'string' || body.url.length > URL_MAX) {
    return bad(`url must be a string under ${URL_MAX} chars`)
  }
  // claude://code/<id> opens the session straight in the Claude app, with no
  // browser in the path. Allowed as an exact shape rather than as a scheme:
  // an agent must not be able to put an arbitrary claude:// URL on the lock screen.
  if (CLAUDE_DEEP_LINK.test(body.url)) {
    v.url = body.url
    return null
  }
  let u
  try { u = new URL(body.url) } catch { return bad('url must be a valid absolute URL') }
  if (u.protocol !== 'https:') return bad('url must be https or claude://code/<id>')
  if (!URL_HOSTS.includes(u.hostname)) {
    return bad(`url host must be one of ${URL_HOSTS.join(' | ')}`)
  }
  v.url = u.toString()
  return null
}

// Optional explicit start time. The session poller sends the moment the session
// went busy so the elapsed timer is honest even when the card starts late (the
// minBusyMs gate) or the server restarts mid-session. Same unit heuristic as
// deadline: > 1e11 is milliseconds.
function startedAtField(body, v) {
  if (body.startedAt === undefined || body.startedAt === null) return null
  const ms = epochMs(body.startedAt)
  if (!Number.isFinite(ms)) return bad('startedAt must be epoch seconds or an ISO 8601 string')
  v.startedAt = ms
  return null
}

function toneField(body, v) {
  v.tone = body.tone ?? 'neutral'
  if (!TONES.includes(v.tone)) return bad(`tone must be one of ${TONES.join(' | ')}`)
  return null
}

const ACTIVITY_FIELDS = [
  laneField,
  templateField,
  titleField,
  lineField,
  progressField,
  deadlineField,
  urlField,
  startedAtField,
  toneField,
]

/**
 * Boundary validation for POST /activity.
 * Returns {error} or {value}. Never throws.
 */
export function validateActivity(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be a JSON object')
  const v = {}
  for (const field of ACTIVITY_FIELDS) {
    const e = field(body, v)
    if (e) return e
  }
  return { value: v }
}

/** POST /activity/end takes lane plus an optional closing line and tone. */
export function validateEnd(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be a JSON object')
  const v = {}
  const laneErr = laneField(body, v)
  if (laneErr) return laneErr
  v.line = 'done'
  const e = checkText('line', body.line, LINE_MAX, v)
  if (e) return e
  v.tone = body.tone ?? 'ok'
  if (!TONES.includes(v.tone)) return bad(`tone must be one of ${TONES.join(' | ')}`)
  return { value: v }
}

/** Content state as the widget's AgentActivity.ContentState decodes it. */
export function contentStateFor(v, { startedAt, prevTitle } = {}) {
  const cs = { template: v.template, title: v.title ?? prevTitle ?? v.lane, line: v.line, tone: v.tone }
  if (v.progress !== undefined) cs.progress = v.progress
  // Every template carries startedAt: "how long has this been blocking me" is the
  // whole question on a needs_you card, and its trailing slot was rendering empty.
  if (startedAt) cs.startedAt = appleDate(startedAt)
  if (v.deadline !== undefined) cs.deadline = appleDate(v.deadline)
  if (v.url !== undefined) cs.url = v.url
  return cs
}
