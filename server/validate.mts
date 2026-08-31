import { appleDate, isState, stateOf, STATES, TEMPLATES, TONES, type Card } from './card-state.mts'
export { TEMPLATES, TONES }

export const LANE_MAX = 24
export const LANE_RE = new RegExp('^[a-z0-9-]{1,' + LANE_MAX + '}$')
export const TITLE_MAX = 32
export const LINE_MAX = 60
export const TEXT_HARD_CAP = 256
export const URL_MAX = 256
export const APPROVAL_ID_RE = /^[0-9a-f-]{1,64}$/
export const URL_HOSTS = ['claude.ai']
export const CLAUDE_DEEP_LINK = /^claude:\/\/code\/[A-Za-z0-9_-]{1,64}$/
export const DEADLINE_PAST_MS = 24 * 3600_000
export const DEADLINE_FUTURE_MS = 365 * 24 * 3600_000

const truncate = (s: string, n: number) => {
  const cp = Array.from(s)
  return cp.length <= n ? s : cp.slice(0, n).join('')
}

export type Result<T> = { error: string; value?: undefined } | { error?: undefined; value: T }
const bad = (reason: string): { error: string; value?: undefined } => ({ error: reason })

function checkText(name: string, raw: unknown, max: number, out: any) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return bad(`${name} must be a string`)
  if (raw.length > TEXT_HARD_CAP) return bad(`${name} too long (${raw.length} > ${TEXT_HARD_CAP})`)
  out[name] = truncate(raw, max)
  return null
}

const epochMs = (n: unknown) => (typeof n === 'number' ? (n > 1e11 ? n : n * 1000) : Date.parse(String(n)))

function laneField(body: any, v: any) {
  if (typeof body.lane !== 'string' || !LANE_RE.test(body.lane)) {
    return bad('lane must match ^[a-z0-9-]{1,24}$')
  }
  v.lane = body.lane
  return null
}

function templateField(body: any, v: any) {
  if (!(TEMPLATES as readonly string[]).includes(body.template)) {
    return bad(`template must be one of ${TEMPLATES.join(' | ')}`)
  }
  v.template = body.template
  return null
}

function titleField(body: any, v: any) {
  if (body.title === undefined || body.title === null) return null
  if (typeof body.title !== 'string') return bad('title must be a string')
  if (body.title.length > TEXT_HARD_CAP) {
    return bad(`title too long (${body.title.length} > ${TEXT_HARD_CAP})`)
  }
  const trimmed = body.title.trim()
  if (trimmed) v.title = truncate(trimmed, TITLE_MAX)
  return null
}

function lineField(body: any, v: any) {
  v.line = ''
  return checkText('line', body.line, LINE_MAX, v)
}

/** The act, and the detail under it. Both optional: an older sender posts
 *  neither and the card falls back to `line`, which is why `line` still ships. */
function headlineField(body: any, v: any) {
  return checkText('headline', body.headline, LINE_MAX, v)
}

function sublineField(body: any, v: any) {
  return checkText('subline', body.subline, LINE_MAX, v)
}

function progressField(body: any, v: any) {
  if (body.progress === undefined || body.progress === null) return null
  const n = Number(body.progress)
  if (!Number.isFinite(n)) return bad('progress must be a number 0...1')
  v.progress = Math.min(1, Math.max(0, n))
  return null
}

function deadlineField(body: any, v: any) {
  if (body.deadline === undefined || body.deadline === null) return null
  const ms = epochMs(body.deadline)
  if (!Number.isFinite(ms)) return bad('deadline must be epoch seconds or an ISO 8601 string')
  if (ms < Date.now() - DEADLINE_PAST_MS || ms > Date.now() + DEADLINE_FUTURE_MS) {
    return bad('deadline must be within the last day or the next year')
  }
  v.deadline = ms
  return null
}

function urlField(body: any, v: any) {
  if (body.url === undefined || body.url === null) return null
  if (typeof body.url !== 'string' || body.url.length > URL_MAX) {
    return bad(`url must be a string under ${URL_MAX} chars`)
  }
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

function startedAtField(body: any, v: any) {
  if (body.startedAt === undefined || body.startedAt === null) return null
  const ms = epochMs(body.startedAt)
  if (!Number.isFinite(ms)) return bad('startedAt must be epoch seconds or an ISO 8601 string')
  v.startedAt = ms
  return null
}

function toneField(body: any, v: any) {
  v.tone = body.tone ?? 'neutral'
  if (!(TONES as readonly string[]).includes(v.tone)) return bad(`tone must be one of ${TONES.join(' | ')}`)
  return null
}

function stateField(body: any, v: any) {
  if (body.state === undefined || body.state === null) return null
  if (!isState(body.state)) return bad(`state must be one of ${STATES.join(' | ')}`)
  v.state = body.state
  return null
}

function approvalIdField(body: any, v: any) {
  if (body.approvalId === undefined || body.approvalId === null) return null
  if (typeof body.approvalId !== 'string' || !APPROVAL_ID_RE.test(body.approvalId)) return bad('approvalId must be an id')
  v.approvalId = body.approvalId
  return null
}

const ACTIVITY_FIELDS = [
  laneField,
  templateField,
  titleField,
  lineField,
  headlineField,
  sublineField,
  progressField,
  deadlineField,
  urlField,
  startedAtField,
  toneField,
  stateField,
  approvalIdField,
]

export function validateActivity(body: any): Result<any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be a JSON object')
  const v: any = {}
  for (const field of ACTIVITY_FIELDS) {
    const e = field(body, v)
    if (e) return e
  }
  return { value: v }
}

export function validateEnd(body: any): Result<any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be a JSON object')
  const v: any = {}
  const laneErr = laneField(body, v)
  if (laneErr) return laneErr
  v.line = 'done'
  for (const f of [
    (b: any, o: any) => checkText('line', b.line, LINE_MAX, o),
    headlineField,
    sublineField,
  ]) {
    const e = f(body, v)
    if (e) return e
  }
  v.tone = body.tone ?? 'ok'
  if (!(TONES as readonly string[]).includes(v.tone)) return bad(`tone must be one of ${TONES.join(' | ')}`)
  return { value: v }
}

export function contentStateFor(v: any, { startedAt, prevTitle }: { startedAt?: number; prevTitle?: string } = {}): Card {
  const cs: Card = { state: v.state ?? stateOf(v.template, v.tone), title: v.title ?? prevTitle ?? v.lane, line: v.line }
  if (v.headline !== undefined) cs.headline = v.headline
  if (v.subline !== undefined) cs.subline = v.subline
  if (v.progress !== undefined) cs.progress = v.progress
  if (startedAt) cs.startedAt = appleDate(startedAt)
  if (v.deadline !== undefined) cs.deadline = appleDate(v.deadline)
  if (v.url !== undefined) cs.url = v.url
  if (v.approvalId !== undefined) cs.approvalId = v.approvalId
  return cs
}
