export const STATES = ['working', 'asking', 'approval', 'stuck', 'resting', 'idle', 'done', 'failed'] as const
export type CardState = (typeof STATES)[number]

export const TEMPLATES = ['progress', 'needs_you', 'result', 'countdown'] as const
export const TONES = ['neutral', 'warn', 'ok', 'fail'] as const
export type Template = (typeof TEMPLATES)[number]
export type Tone = (typeof TONES)[number]

export const isState = (x: unknown): x is CardState => (STATES as readonly unknown[]).includes(x)

export function stateOf(template: Template, tone: Tone): CardState {
  if (tone === 'fail') return 'failed'
  switch (template) {
    case 'needs_you': return 'asking'
    case 'result': return 'done'
    case 'countdown': return 'resting'
    case 'progress': return tone === 'warn' ? 'stuck' : 'working'
  }
}

export type Card = {
  state: CardState
  /** Stable for the life of the session. Never the summarised title. */
  title: string
  /** Kept as-is so a phone build without headline renders what it renders today. */
  line: string
  headline?: string
  subline?: string
  progress?: number
  startedAt?: number
  deadline?: number
  url?: string
  approvalId?: string
}

export const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
export const appleDate = (ms: number) => (ms - APPLE_EPOCH_MS) / 1000

const RELEVANCE: Record<CardState, number> = { approval: 100, asking: 90, failed: 85, stuck: 70, done: 60, resting: 40, working: 20, idle: 10 }

export function relevanceOf(card: Pick<Card, 'state' | 'startedAt'>, now = Date.now()): number {
  if (card.state === 'asking') {
    const startedMs = typeof card.startedAt === 'number' ? card.startedAt * 1000 + APPLE_EPOCH_MS : now
    const mins = Math.max(0, (now - startedMs) / 60_000)
    return 90 + Math.min(10, Math.floor(mins / 3))
  }
  return RELEVANCE[card.state] ?? 20
}
