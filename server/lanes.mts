import fs from 'node:fs'
import { isState, stateOf, TEMPLATES, TONES, type Card, type Template, type Tone } from './card-state.mts'

export type Lane =
  | { kind: 'starting'; since: number; startedAt: number; card: Card; held: boolean }
  | { kind: 'live'; token: string; startedAt: number; card: Card; held: boolean }

export type ParkedEnd = { card: Card; at: number }

/** A card that ended, kept so the app can show what happened while he was away. */
export type Ended = { lane: string; card: Card; endedAt: number; outcome: 'done' | 'failed' }

export type State = {
  pushToStartToken: string | null
  lanes: Record<string, Lane>
  pendingEnds: Record<string, ParkedEnd>
  history: Ended[]
}

export const HISTORY_MAX = 50

export const START_GRACE_MS = 15_000
export const PARKED_END_TTL_MS = 3600_000

function parseCard(raw: any): Card | null {
  if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string' || typeof raw.line !== 'string') return null
  const { template, tone, state, ...rest } = raw
  const isTemplate = (x: unknown): x is Template => (TEMPLATES as readonly unknown[]).includes(x)
  const isTone = (x: unknown): x is Tone => (TONES as readonly unknown[]).includes(x)
  const resolved = isState(state) ? state : isTemplate(template) ? stateOf(template, isTone(tone) ? tone : 'neutral') : null
  return resolved ? { ...rest, state: resolved } : null
}

export const empty = (): State => ({ pushToStartToken: null, lanes: {}, pendingEnds: {}, history: [] })

export function parseState(raw: any, now = Date.now()): State {
  const s = empty()
  if (!raw || typeof raw !== 'object') return s
  s.pushToStartToken = typeof raw.pushToStartToken === 'string' ? raw.pushToStartToken : null
  for (const [lane, e] of Object.entries<any>(raw.lanes ?? {})) {
    if (!e || typeof e !== 'object') continue
    const card = parseCard(e.kind === 'starting' || e.kind === 'live' ? e.card : e.last)
    if (!card) continue
    if (e.kind === 'starting' || e.kind === 'live') { s.lanes[lane] = { ...e, card }; continue }
    const startedAt = typeof e.startedAt === 'number' ? e.startedAt : now
    s.lanes[lane] = typeof e.updateToken === 'string'
      ? { kind: 'live', token: e.updateToken, startedAt, card, held: Boolean(e.dirty) }
      : { kind: 'starting', since: typeof e.startPending === 'number' ? e.startPending : now, startedAt, card, held: Boolean(e.dirty) }
  }
  for (const h of Array.isArray(raw.history) ? raw.history : []) {
    const card = parseCard(h?.card)
    if (card && typeof h.lane === 'string' && typeof h.endedAt === 'number') {
      s.history.push({ lane: h.lane, card, endedAt: h.endedAt, outcome: h.outcome === 'failed' ? 'failed' : 'done' })
    }
  }
  s.history = s.history.slice(-HISTORY_MAX)
  for (const [lane, p] of Object.entries<any>(raw.pendingEnds ?? {})) {
    const card = parseCard(p?.card ?? p?.cs)
    if (card && typeof p.at === 'number' && now - p.at <= PARKED_END_TTL_MS) s.pendingEnds[lane] = { card, at: p.at }
  }
  return s
}

export function loadState(file: string, now = Date.now()): State {
  try {
    return parseState(JSON.parse(fs.readFileSync(file, 'utf8')), now)
  } catch {
    return empty()
  }
}

export function saveState(state: State, file: string) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

export const inFlight = (lane: Lane | undefined, now = Date.now(), grace = START_GRACE_MS): boolean =>
  lane?.kind === 'starting' && now - lane.since < grace

export function started(state: State, lane: string, card: Card, startedAt: number, now = Date.now()) {
  state.lanes[lane] = { kind: 'starting', since: now, startedAt, card, held: false }
}

export function updated(state: State, lane: string, card: Card, startedAt: number) {
  const e = state.lanes[lane]
  if (e?.kind === 'live') state.lanes[lane] = { ...e, startedAt, card }
}

export function hold(state: State, lane: string, card: Card, startedAt: number) {
  const e = state.lanes[lane]
  if (e) state.lanes[lane] = { ...e, startedAt, card, held: true }
}

export type TokenOutcome = { parked: ParkedEnd } | { ghost: true } | { flush: Card | null }

export function tokenArrived(state: State, lane: string, token: string): TokenOutcome {
  const parked = state.pendingEnds[lane]
  if (parked) {
    delete state.pendingEnds[lane]
    return { parked }
  }
  const e = state.lanes[lane]
  if (!e) return { ghost: true }
  state.lanes[lane] = { kind: 'live', token, startedAt: e.startedAt, card: e.card, held: false }
  return { flush: e.held ? e.card : null }
}

export type EndOutcome = { token: string } | { parked: true }

export function ended(state: State, lane: string, card: Card, now = Date.now(), outcome: Ended['outcome'] = 'done'): EndOutcome | null {
  const e = state.lanes[lane]
  if (!e) return null
  delete state.lanes[lane]
  state.history = [...(state.history ?? []), { lane, card: e.card, endedAt: now, outcome }].slice(-HISTORY_MAX)
  if (e.kind === 'live') return { token: e.token }
  state.pendingEnds[lane] = { card, at: now }
  return { parked: true }
}

export function rolledOver(state: State, lane: string, now = Date.now()) {
  const e = state.lanes[lane]
  if (e) state.lanes[lane] = { kind: 'starting', since: now, startedAt: now, card: e.card, held: false }
}

export function markHeld(state: State) {
  for (const [lane, e] of Object.entries(state.lanes)) state.lanes[lane] = { ...e, held: true }
}

export function forgetAll(state: State) {
  state.lanes = {}
  state.pendingEnds = {}
}
