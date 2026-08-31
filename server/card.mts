import os from 'node:os'
import path from 'node:path'
import { LINE_MAX } from './validate.mts'
import type { CardState } from './card-state.mts'
import type { Session } from './claude.mts'

export const TITLE_LIMIT = 32
export const IDENTITY_MAX = 24

type Named = { name?: unknown; cwd?: unknown; pid?: unknown }

export const rawName = (s: Named) =>
  (typeof s.name === 'string' && s.name) ||
  (typeof s.cwd === 'string' && s.cwd && path.basename(s.cwd)) ||
  String(s.pid)

/** The name a card falls back to before it has earned a real one.
 *
 * This is the string `laneFor` already slugs into the routing key, so it is
 * stable by construction. It is also opaque: `chief-69` says nothing about what
 * the conversation is. It holds the identity row only until the summariser
 * produces a title, which `frozenIdentity` then keeps for good.
 */
export function identityFor(s: Named, max = IDENTITY_MAX) {
  const raw = String(rawName(s)).toLowerCase().trim()
  return raw.length <= max ? raw : raw.slice(0, max - 1) + '…'
}

export function laneFor(s: Named) {
  const clean = String(rawName(s))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `cc-${clean || s.pid}`.slice(0, 24)
}

export function lineFor(cwd: unknown, max = LINE_MAX, home = os.homedir()) {
  let p = typeof cwd === 'string' ? cwd : ''
  if (p === home) p = '~'
  else if (p.startsWith(home + '/')) p = '~' + p.slice(home.length)
  if (p.length <= max) return p
  let tail = p.slice(-(max - 1))
  const cut = tail.indexOf('/')
  if (cut > 0) tail = tail.slice(cut)
  return `…${tail}`
}

const GENERIC_SEG = new Set([
  '~', 'users', 'home', 'desktop', 'documents', 'downloads', 'playground',
  'code', 'src', 'repos', 'projects', 'dev', 'work', 'tmp',
])

export function pathLabel(text: unknown) {
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

export function titleTrim(raw: unknown, max = TITLE_LIMIT) {
  let s = String(raw).replace(/\s+/g, ' ').trim()
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
    s = cut > max / 2 ? head.slice(0, cut) : head.slice(0, max - 1) + '…'
  }
  return s.replace(/[\s.,;:!?-]+$/, '')
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const hostOf = (u: unknown) => {
  try {
    return new URL(String(u)).hostname
  } catch {
    return ''
  }
}
const baseOf = (p: unknown) => path.basename(str(p))

const PHRASES: Record<string, ((i: any) => string) | undefined> = {
  __proto__: null as never,
  Bash: (i: any) => `running ${str(i.description) || str(i.command).slice(0, 40)}`,
  Read: (i: any) => `reading ${baseOf(i.file_path)}`,
  Edit: (i: any) => `editing ${baseOf(i.file_path)}`,
  Write: (i: any) => `editing ${baseOf(i.file_path)}`,
  NotebookEdit: (i: any) => `editing ${baseOf(i.file_path)}`,
  Grep: (i: any) => readablePattern(i.pattern),
  Glob: (i: any) => `searching ${str(i.pattern) || 'files'}`,
  WebSearch: () => 'searching the web',
  WebFetch: (i: any) => `fetching ${hostOf(i.url)}`,
  Task: (i: any) => `delegating ${str(i.description)}`,
  Agent: (i: any) => `delegating ${str(i.description)}`,
  TodoWrite: () => 'planning',
}

export function readablePattern(pattern: unknown) {
  const p = str(pattern).trim()
  if (!p) return 'searching the code'
  if (/[\\^$*+?{}()[\]|]/.test(p)) return 'searching the code'
  return `searching for ${p}`
}

export function defaultPhrase(name: string) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name)
  if (m) return `${m[1].replace(/_/g, ' ')}: ${m[2].replace(/_/g, ' ')}`.toLowerCase()
  return name.toLowerCase()
}

export function toolPhrase(block: any) {
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

export function stripMd(s: unknown) {
  return String(s)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*\|.*$/gm, ' ')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^[ \t]*#{1,6}\s+/gm, '')
    .replace(/\*+/g, '')
}

export function fmtMins(ms: number) {
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

const API: Record<CardState, { template: string; tone: string; state: CardState }> = {
  working: { template: 'progress', tone: 'neutral', state: 'working' },
  idle: { template: 'progress', tone: 'neutral', state: 'idle' },
  approval: { template: 'needs_you', tone: 'warn', state: 'approval' },
  stuck: { template: 'progress', tone: 'warn', state: 'stuck' },
  asking: { template: 'needs_you', tone: 'warn', state: 'asking' },
  resting: { template: 'countdown', tone: 'neutral', state: 'resting' },
  done: { template: 'result', tone: 'ok', state: 'done' },
  failed: { template: 'result', tone: 'fail', state: 'failed' },
}

export type CardRequest = {
  lane: string
  title: string
  template: string
  tone: string
  state?: CardState
  line: string
  headline?: string
  subline?: string
  startedAt: number
  deadline?: number
  url?: string
  approvalId?: string
}

export type ApprovalView = { id: string; summary: string; at: number; tool?: string; cwd?: string }

/** Clock time rather than a duration. The trailing slot already ticks the wait
 *  live, and a duration frozen into the subline would go stale between pushes
 *  and say the same thing twice. */
export function atClock(ms: number, now = new Date(ms)) {
  return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
}

/** The word for the state a card was in, for a sentence about the past. */
const WAS: Record<CardState, string> = {
  working: 'working', idle: 'idle', stuck: 'stuck', resting: 'resting',
  asking: 'waiting', approval: 'waiting', done: 'done', failed: 'failed',
}

/** What the poller can honestly say about a card it is ending.
 *
 * The session is already gone when this runs, which is why the card is ending, so
 * there is no outcome to report and none is invented. What survives is the last
 * card posted for that lane: the act it was on, the state it was in, and when
 * that state began. Everything below is read off that and nothing else.
 *
 * A lane adopted from the persisted state file on startup has no last card, so
 * this returns nothing and `/activity/end` keeps its own defaults.
 */
export function endFor(last?: Pick<CardRequest, 'state' | 'headline' | 'line' | 'startedAt'>, now = Date.now()) {
  const out: { headline?: string; subline?: string } = {}
  if (!last) return out

  const waiting = last.state === 'asking' || last.state === 'approval'
  // Vanishing mid question is the one ending that is genuinely an outcome: he
  // never answered and now there is nothing to answer. Everything else reports
  // the last true act rather than guessing at a result.
  const act = waiting ? 'closed while waiting on you' : last.headline || last.line || ''
  if (act) out.headline = titleTrim(act, LINE_MAX)

  // Under a minute rounds to "0m", which says nothing and looks broken. A card
  // that lived that briefly gets no duration at all.
  const held = typeof last.startedAt === 'number' && last.startedAt > 0 ? now - last.startedAt : 0
  const ran = held >= 60_000 ? fmtMins(held) : ''
  if (ran) out.subline = waiting ? `${ran} unanswered` : `${WAS[last.state ?? 'working']} for ${ran}`
  return out
}

/** The identity row: the first title this session was ever given, or the cwd
 *  basename while it has none. Frozen upstream in titles.mts, so the only job
 *  here is to prefer it and to keep it out of the subline, which would
 *  otherwise print the same string twice on the same card. */
export function frozenIdentity(s: Named, frozen?: string) {
  const t = String(frozen ?? '').trim()
  return t ? titleTrim(t, IDENTITY_MAX) : identityFor(s)
}

// Claude Code's Notification hook says "Claude needs your permission to use X".
// Anchored on that exact phrase, so it either matches and the tool is certain, or
// it does not and nothing is claimed.
const PERMISSION_RE = /\bpermission to use\s+([A-Za-z][A-Za-z0-9_.-]*)/i

/** The repo a lane belongs to. laneFor built it as `cc-` plus a slug of the
 *  session name or cwd basename, so this is just that slug back. */
export function repoOfLane(lane: unknown) {
  return String(lane ?? '').replace(/^cc-/, '').trim()
}

/** The tool a permission prompt is about, when the line names one.
 *
 * Claude Code tools are PascalCase or `mcp__server__tool`. Requiring that shape
 * is what stops prose like "permission to use the shared drive" from putting
 * "the" on a card as though it were a tool.
 */
export function toolOfLine(line: unknown) {
  const m = PERMISSION_RE.exec(String(line ?? ''))
  if (!m) return ''
  const tok = m[1]
  return /^[A-Z]/.test(tok) || tok.startsWith('mcp__') ? tok : ''
}

/** A subline for a card that arrived without one.
 *
 * hooks/ledge-notify posts a bare {lane, template, line, tone}, so the cards that
 * most need him, the permission prompts, were the only ones still rendering two
 * rows. This fills the gap server-side: the hook stays dumb and any future hook
 * gets the same treatment for free.
 *
 * Everything here comes off the lane and the line the hook already sent. Where
 * the tool is not certain the card says only where it came from, which is worse
 * than naming the tool and much better than naming the wrong one.
 */
export function sublineFor(lane: unknown, line: unknown, max = LINE_MAX) {
  const repo = repoOfLane(lane)
  const tool = toolOfLine(line)
  const out = tool && repo ? `${tool} in ${repo}` : tool || repo
  return out.slice(0, max)
}

export function cardFor(
  s: Session,
  title: string,
  activity = '',
  stuckMs = 0,
  lane = laneFor(s),
  approval?: ApprovalView,
  frozen?: string,
): CardRequest {
  const id = s.bridgeSessionId
  const url = typeof id === 'string' && id ? { url: `claude://code/${encodeURIComponent(id)}` } : {}
  const where = lineFor(s.cwd)
  // The identity row never moves. `title` from the summariser is the churning
  // half, so it drops to the subline where changing is correct.
  const identity = frozenIdentity(s, frozen)
  // The subline says something about the session or it says nothing. The cwd is
  // not something: the lane name already carries where this is, and the row is
  // worth more given back to the act, which gets a second line without it.
  const why = title && title !== identity ? title : ''
  const at = (
    state: CardState,
    line: string,
    startedAt: number,
    subline: string,
    deadline?: number,
  ): CardRequest => ({
    lane,
    title: identity,
    ...API[state],
    line,
    headline: line,
    // Length only, no titleTrim: a subline is already a short fact and has
    // nothing for the rewriter to shorten.
    ...(subline ? { subline: subline.slice(0, LINE_MAX) } : {}),
    startedAt,
    ...(deadline ? { deadline } : {}),
    ...url,
  })

  if (approval) {
    const what = [approval.tool, approval.cwd ? path.basename(approval.cwd) : ''].filter(Boolean).join(' in ')
    return {
      ...at('approval', titleTrim(`allow: ${approval.summary}`, LINE_MAX), approval.at, what),
      approvalId: approval.id,
    }
  }
  if (s.wake) {
    const wakeAt = s.wake.wakeAt ?? undefined
    return at(
      'resting',
      titleTrim(s.wake.reason || 'on a loop, wakes itself', LINE_MAX),
      s.wake.at,
      wakeAt ? `wakes ${atClock(wakeAt)}` : '',
      wakeAt,
    )
  }
  if (s.status === 'busy') {
    return stuckMs
      ? at('stuck', `no output for ${fmtMins(stuckMs)}`, s.statusUpdatedAt, activity)
      : at('working', activity || where, s.statusUpdatedAt, why)
  }
  if (s.status === 'shell') return at('working', activity || where, s.statusUpdatedAt, why)
  if (s.question) return at('asking', s.question, s.statusUpdatedAt, `asked ${atClock(s.statusUpdatedAt)}`)
  return at('idle', s.said || 'idle', s.statusUpdatedAt, '')
}
