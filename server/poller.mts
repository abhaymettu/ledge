import fs from 'node:fs'
import { LANE_RE, LANE_MAX } from './validate.mts'
import {
  SESSIONS_DIR, PROJECTS_DIR, pidAlive, readSessions, transcriptPathFor, currentActivity, caches as newCaches,
  titleFor, transcriptTitle, recentContext, type Session,
} from './claude.mts'
import { createTitleSummariser } from './titles.mts'
import { laneFor, cardFor, endFor, type ApprovalView, type CardRequest } from './card.mts'

export const WAITING_FRESH_MS = 30 * 60_000
export const IDLE_CARD_MS = WAITING_FRESH_MS

export const DEFAULTS = { enabled: true, pollMs: 3000, minBusyMs: 8000, maxCards: 4, stuckAfterMs: 600000, summariseTitles: true, titleRefreshMs: 1200000 }

export function qualifies(s: Session, minBusyMs: number, now = Date.now(), alive = pidAlive, hasWork: (s: Session) => boolean = () => false) {
  if (!alive(s.pid)) return false
  if (s.status === 'busy') return now - s.statusUpdatedAt >= minBusyMs
  return hasWork(s)
}

export function selectCards(
  sessions: Session[],
  cards: Map<string, unknown>,
  { minBusyMs, maxCards, now = Date.now(), alive = pidAlive, hasWork = () => false }:
    { minBusyMs: number; maxCards: number; now?: number; alive?: (pid: number) => boolean; hasWork?: (s: Session) => boolean },
) {
  const live = new Map<string, Session>()
  for (const s of [...sessions].sort((a, b) => (a?.pid ?? 0) - (b?.pid ?? 0))) {
    if (!alive(s.pid)) continue
    let lane = laneFor(s)
    if (!LANE_RE.test(lane)) continue
    if (live.has(lane)) {
      const suffix = `-${String(s.pid).slice(-4)}`
      lane = lane.slice(0, LANE_MAX - suffix.length) + suffix
      if (!LANE_RE.test(lane) || live.has(lane)) continue
    }
    live.set(lane, s)
  }
  const idleFor = (s: Session) => (s.status === 'idle' && !s.wake && !s.question ? now - s.statusUpdatedAt : 0)
  const eligible = [...live].filter(([lane, s]) => (cards.has(lane) || qualifies(s, minBusyMs, now, alive, hasWork)) && idleFor(s) < IDLE_CARD_MS)
  const wants = (s: Session) => s.status !== 'busy' && !s.wake && Boolean(s.question)
  const rank = (lane: string, s: Session) => {
    if (wants(s)) return 0
    const active = s.status === 'busy' || Boolean(s.wake)
    if (active) return cards.has(lane) ? 1 : 2
    return cards.has(lane) ? 3 : 4
  }
  eligible.sort(([la, a], [lb, b]) => rank(la, a) - rank(lb, b) || a.statusUpdatedAt - b.statusUpdatedAt)
  return { want: new Map(eligible.slice(0, maxCards)), live }
}

export type PollerOptions = {
  post: (pathname: string, body: unknown) => Promise<{ status: number; body: string }>
  config?: Record<string, unknown>
  dir?: string
  projectsDir?: string
  alive?: (pid: number) => boolean
  existingLanes?: string[]
  log?: (line: string) => void
  titleRun?: (instruction: string) => Promise<string>
  titleCachePath?: string
  approvals?: { forSession: (sessionId: string) => ApprovalView | undefined }
}

export function startSessionPoller({
  post,
  config = {},
  dir = SESSIONS_DIR,
  projectsDir = PROJECTS_DIR,
  alive = pidAlive,
  existingLanes = [],
  log = console.log,
  titleRun,
  titleCachePath,
  approvals,
}: PollerOptions) {
  const { pollMs, minBusyMs, maxCards, stuckAfterMs, summariseTitles, titleRefreshMs } = { ...DEFAULTS, ...config } as typeof DEFAULTS
  const cards = new Map<string, { pid: number | null; sig: string; last?: CardRequest }>()
  for (const lane of existingLanes) {
    if (String(lane).startsWith('cc-')) cards.set(lane, { pid: null, sig: '' })
  }
  const titles = new Map()
  const summarise = createTitleSummariser({
    enabled: summariseTitles !== false,
    run: titleRun,
    cachePath: titleCachePath,
    titleRefreshMs,
    onTitle: (key, title) => { titles.set(key, title) },
    log,
  })
  const activities = new Map()
  const caches = newCaches()
  const refused = new Map()
  let timer: NodeJS.Timeout | null = null
  let inFlight = false

  const stop: (() => void) & { tick?: () => Promise<void>; forgetExcept?: (live: string[]) => void } = () => {
    if (timer) clearInterval(timer)
    timer = null
  }

  function cardTitle(s: Session) {
    const key = String(s.sessionId ?? s.pid)
    if (!titles.has(key)) {
      const known = summarise.known(key)
      if (known) titles.set(key, known)
    }
    return titleFor(s, titles, projectsDir, summarise.request)
  }

  function bodyFor(s: Session, lane: string) {
    const file = transcriptPathFor(s.cwd, s.sessionId, projectsDir)
    const busy = s.status === 'busy'
    const activity = busy ? currentActivity(file, activities) : ''
    const mtimeMs = (activities.get(file) ?? caches.questions.get(file))?.mtimeMs
    if (mtimeMs) summarise.refresh(String(s.sessionId ?? s.pid), mtimeMs, () => recentContext(file))
    const silentMs = busy ? Date.now() - (activities.get(file)?.mtimeMs || Infinity) : 0
    const frozen = summarise.identity(String(s.sessionId ?? s.pid))
    return cardFor(
      s, cardTitle(s), activity, silentMs >= stuckAfterMs ? silentMs : 0, lane,
      approvals?.forSession(String(s.sessionId)),
      frozen,
    )
  }

  async function postCard(lane: string, s: Session) {
    const body = bodyFor(s, lane)
    const sig = JSON.stringify(body)
    if (refused.get(lane) === sig) return
    if (cards.get(lane)?.sig === sig) return
    const r: Partial<{ status: number; body: string }> = (await post('/activity', body)) ?? {}
    const status = r.status ?? 0
    if (status >= 200 && status < 300) {
      log(`[sessions] card ${cards.has(lane) ? 'now' : 'up'} lane=${lane} pid=${s.pid} ${body.template}`)
      cards.set(lane, { pid: s.pid, sig, last: body })
      return
    }
    log(`[sessions] card refused lane=${lane}: ${r.status ?? '?'} ${r.body ?? ''}`)
    if (status < 500) refused.set(lane, sig)
  }

  async function endDeadCards(want: Map<string, Session>, live: Map<string, Session>) {
    for (const [lane, card] of [...cards]) {
      if (want.has(lane) || (!live.has(lane) && card.pid !== null && alive(card.pid))) continue
      cards.delete(lane)
      // The session is gone, so nothing new can be learned about it. endFor says
      // only what the last card already said, plus how long that state had run.
      const r: Partial<{ status: number; body: string }> =
        (await post('/activity/end', { lane, ...endFor(card.last) })) ?? {}
      log(`[sessions] card down lane=${lane} -> ${r.status}`)
    }
  }

  function forgiveRefused(want: Map<string, Session>) {
    for (const lane of [...refused.keys()]) if (!want.has(lane)) refused.delete(lane)
  }

  stop.forgetExcept = (live) => {
    const keep = new Set(live)
    for (const [lane, card] of cards) if (!keep.has(lane)) cards.set(lane, { ...card, sig: '' })
  }

  async function tick() {
    if (inFlight) return
    inFlight = true
    try {
      const sessions = readSessions(dir, { projectsDir, caches })
      if (sessions === null) {
        log(`[sessions] ${dir} unreadable; poller disabled`)
        stop()
        return
      }
      const hasWork = (s: Session) => Boolean(transcriptTitle(s.cwd, s.sessionId, projectsDir))
      const { want, live } = selectCards(sessions, cards, { minBusyMs, maxCards, alive, hasWork })
      for (const [lane, s] of want) await postCard(lane, s)
      await endDeadCards(want, live)
      forgiveRefused(want)
    } catch (e) {
      log(`[sessions] tick failed: ${(e as Error).message}`)
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
    tick()
  }, pollMs)
  timer.unref?.()
  log(`[sessions] polling ${dir} every ${pollMs}ms minBusyMs=${minBusyMs} maxCards=${maxCards}`)
  stop.tick = tick
  return stop
}
