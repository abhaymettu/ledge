import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { LINE_MAX } from './validate.mts'
import { rawName, titleTrim, toolPhrase, stripMd } from './card.mts'

export const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions')
export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
export const TRANSCRIPT_HEAD_BYTES = 256 * 1024

const tryParse = (s: string): any => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function pidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type Status = 'busy' | 'idle' | 'shell'
/** Parked: on a /loop (wakeAt known) or inside a blocking watch such as Monitor
 *  (wakeAt null: it ends when the condition does). */
export type Wake = { at: number; wakeAt: number | null; reason: string }

export const WAITING_TOOLS = new Set(['Monitor', 'ScheduleWakeup'])

export type Session = {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  bridgeSessionId?: string | null
  entrypoint?: string
  status: Status
  statusUpdatedAt: number
  wake: Wake | null
  question: string
  said: string
}

export type Caches = { statuses: Map<string, any>; wakeups: Map<string, any>; questions: Map<string, any>; said: Map<string, any>; tools: Map<string, any> }
export const caches = (): Caches => ({ statuses: new Map(), wakeups: new Map(), questions: new Map(), said: new Map(), tools: new Map() })

const statusOf = (raw: unknown): Status => (raw === 'busy' || raw === 'shell' ? raw : 'idle')

function parseSession(raw: any, projectsDir: string, caches: Caches, now: number): Session | null {
  if (!raw || typeof raw !== 'object' || raw.kind !== 'interactive') return null
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null
  const file = transcriptPathFor(raw.cwd, raw.sessionId, projectsDir)
  let status: Status
  let statusUpdatedAt: number
  if (typeof raw.status === 'string') {
    if (typeof raw.statusUpdatedAt !== 'number' || !Number.isFinite(raw.statusUpdatedAt)) return null
    status = statusOf(raw.status)
    statusUpdatedAt = raw.statusUpdatedAt
  } else {
    const resolved = resolveStatus(file, caches.statuses)
    if (!resolved) return null
    ;({ status, statusUpdatedAt } = resolved)
  }
  let wake: Wake | null = null
  let question = ''
  let said = ''
  if (status === 'busy') {
    wake = watching(file, caches.tools)
  } else {
    const w = pendingWakeup(file, caches.wakeups)
    if (w && w.wakeAt !== null && now < w.wakeAt + WAKE_GRACE_MS) wake = w
    question = lastQuestion(file, caches.questions)
    said = lastSaid(file, caches.said)
  }
  return { ...raw, status, statusUpdatedAt, wake, question, said }
}

export function readSessions(
  dir: string,
  { projectsDir = PROJECTS_DIR, caches: c = caches(), now = Date.now() }:
    { projectsDir?: string; caches?: Caches; now?: number } = {},
): Session[] | null {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const out: Session[] = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    let raw: string
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    const s = parseSession(tryParse(raw), projectsDir, c, now)
    if (s) out.push(s)
  }
  return out
}

function messageText(m: any): string {
  const c = m?.content
  if (typeof c === 'string') return c.trim()
  if (!Array.isArray(c)) return ''
  return c
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .trim()
}

export function transcriptPathFor(cwd: unknown, sessionId: unknown, projectsDir = PROJECTS_DIR) {
  return path.join(projectsDir, String(cwd).replaceAll('/', '-'), `${sessionId}.jsonl`)
}

export function transcriptTitle(cwd: unknown, sessionId: unknown, projectsDir = PROJECTS_DIR) {
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
  if (truncated) lines.pop()
  for (const line of lines) {
    const o = tryParse(line)
    const t = o?.type === 'user' ? messageText(o.message) : ''
    if (t && !t.startsWith('<')) return t
  }
  return null
}

export function titleFor(
  s: { sessionId?: unknown; pid?: unknown; cwd?: unknown; name?: unknown },
  cache = new Map<string, string>(),
  projectsDir = PROJECTS_DIR,
  onFirstPrompt?: (key: string, prompt: string, title: string) => void,
) {
  const key = String(s.sessionId ?? s.pid)
  const hit = cache.get(key)
  if (hit) return hit
  const prompt = transcriptTitle(s.cwd, s.sessionId, projectsDir)
  const title = titleTrim(prompt ?? rawName(s)) || String(s.pid)
  cache.set(key, title)
  if (prompt) onFirstPrompt?.(key, prompt, title)
  return title
}

export const RECENT_CONTEXT_BYTES = 24 * 1024
export const RECENT_CONTEXT_CHARS = 600

export function recentContext(file: string) {
  let text
  try {
    const st = fs.statSync(file)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(st.size, RECENT_CONTEXT_BYTES))
    const n = fs.readSync(fd, buf, 0, buf.length, Math.max(0, st.size - RECENT_CONTEXT_BYTES))
    fs.closeSync(fd)
    text = buf.subarray(0, n).toString('utf8')
    if (st.size > RECENT_CONTEXT_BYTES) text = text.slice(text.indexOf('\n') + 1)
  } catch {
    return ''
  }
  const parts = []
  const lines = text.split('\n')
  let len = 0
  for (let i = lines.length - 1; i >= 0 && len < RECENT_CONTEXT_CHARS; i--) {
    const o = tryParse(lines[i]) ?? {}
    const t = /^(user|assistant)$/.test(o.type) ? messageText(o.message) : ''
    if (!t || /^[<[]/.test(t)) continue
    const clean = stripMd(t).replace(/\s+/g, ' ').trim()
    if (!clean) continue
    parts.push(clean)
    len += clean.length + 1
  }
  return parts.reverse().join('\n').slice(-RECENT_CONTEXT_CHARS)
}

function scanTail<T>(file: string, cache: Map<string, any>, extract: (lines: string[]) => T): T | '' {
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
    if (st.size > TRANSCRIPT_HEAD_BYTES) text = text.slice(text.indexOf('\n') + 1)
  } catch {
    cache.delete(file)
    return ''
  }
  const value = extract(text.split('\n'))
  cache.set(file, { key, mtimeMs, value })
  return value
}

export function currentActivity(file: string, cache = new Map<string, any>()): string {
  return scanTail(file, cache, (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const blocks = tryParse(lines[i])?.message?.content
      const b = Array.isArray(blocks) && blocks.findLast((x) => x?.type === 'tool_use')
      if (b) return toolPhrase(b)
    }
    return ''
  })
}

export function lastQuestion(file: string, cache = new Map<string, any>()): string {
  return scanTail(file, cache, (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = tryParse(lines[i])
      if (o?.type !== 'assistant') continue
      const blocks = o.message?.content
      const ask = Array.isArray(blocks) && blocks.findLast((x: any) => x?.type === 'tool_use' && x.name === 'AskUserQuestion')
      if (ask) {
        const q = String(ask.input?.questions?.[0]?.question ?? '').replace(/\s+/g, ' ').trim()
        return q.length <= LINE_MAX ? q : titleTrim(q, LINE_MAX)
      }
      const text = messageText(o.message)
      if (!text) continue
      const qs = stripMd(text).match(/[^.!?:\n]*\?/g)
      const q = qs ? qs[qs.length - 1].replace(/\s+/g, ' ').trim() : ''
      return q.length <= LINE_MAX && q.includes(' ') && !/["“”]/.test(q) ? q : ''
    }
    return ''
  })
}

export function inferredStatus(file: string, cache = new Map<string, any>()): { status: Status; statusUpdatedAt: number } | null {
  return scanTail(file, cache, (lines): { status: Status; statusUpdatedAt: number } | null => {
    let status: 'busy' | 'idle' | null = null
    let oldest = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = tryParse(lines[i])
      if (o?.type !== 'assistant' && o?.type !== 'user') continue
      const blocks = o.message?.content
      const has = (t: string) => Array.isArray(blocks) && blocks.some((x) => x?.type === t)
      oldest = Date.parse(o.timestamp) || Date.now()
      if (!status) {
        status = o.type === 'user' || has('tool_use') ? 'busy' : 'idle'
        if (o.type === 'user' && has('tool_result')) {
          const prev = lines.slice(0, i).reverse().map(tryParse).find((p: any) => p?.type === 'assistant')
          const c = prev?.message?.content
          if (Array.isArray(c) && c.some((x) => x?.type === 'tool_use' && x.name === 'ScheduleWakeup')) status = 'idle'
        }
        if (status === 'idle') return { status, statusUpdatedAt: oldest }
      }
      if (o.type === 'user' && !has('tool_result')) return { status, statusUpdatedAt: oldest }
    }
    return status ? { status, statusUpdatedAt: oldest } : null
  }) || null
}

/** A busy session whose newest tool call is a waiting tool (Monitor, ScheduleWakeup)
 *  is watching for something, not working: the loop between its checks. */
export function watching(file: string, cache = new Map<string, any>()): Wake | null {
  return scanTail(file, cache, (lines): Wake | null => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = tryParse(lines[i])
      const blocks = o?.message?.content
      const b = Array.isArray(blocks) && blocks.findLast((x: any) => x?.type === 'tool_use')
      if (!b) continue
      if (!WAITING_TOOLS.has(b.name)) return null
      const at = Date.parse(o.timestamp) || Date.now()
      const i2 = b.input ?? {}
      const reason = String(i2.reason ?? i2.description ?? '').replace(/\s+/g, ' ').trim() || 'watching'
      const delay = Number(i2.delaySeconds)
      return { at, wakeAt: b.name === 'ScheduleWakeup' && Number.isFinite(delay) ? at + delay * 1000 : null, reason }
    }
    return null
  }) || null
}

/** The last thing the session said: the final sentence of its newest text, for an
 *  idle card. "" when there is none. */
export function lastSaid(file: string, cache = new Map<string, any>()): string {
  return scanTail(file, cache, (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = tryParse(lines[i])
      if (o?.type !== 'assistant') continue
      const text = messageText(o.message)
      if (!text) continue
      const sentences = stripMd(text).replace(/\s+/g, ' ').match(/[^.!?\n]+[.!?]?/g) ?? []
      const last = sentences.map((x) => x.trim()).filter((x) => x.length > 1).pop() ?? ''
      return titleTrim(last, LINE_MAX)
    }
    return ''
  })
}

export function resolveStatus(file: string, cache = new Map()): { status: Status; statusUpdatedAt: number } | null {
  const inferred = inferredStatus(file, cache)
  if (!inferred) return null
  const pinKey = `pin:${file}`
  let { status, statusUpdatedAt } = inferred
  if (status === 'busy') {
    statusUpdatedAt = Math.min(statusUpdatedAt, cache.get(pinKey) ?? Infinity)
    cache.set(pinKey, statusUpdatedAt)
  } else cache.delete(pinKey)
  return { status, statusUpdatedAt }
}

export const WAKE_GRACE_MS = 120_000

export function pendingWakeup(file: string, cache = new Map<string, any>()): Wake | null {
  return scanTail(file, cache, (lines): Wake | null => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = tryParse(lines[i])
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

