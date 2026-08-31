import crypto from 'node:crypto'
import path from 'node:path'

export type Decision = 'allow' | 'deny'
export type Approval = { id: string; sessionId: string; tool: string; summary: string; cwd: string; at: number }
type Pending = Approval & { waiters: ((d: Decision | null) => void)[] }

export const APPROVAL_TTL_MS = 10 * 60_000

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** What the card says the tool wants to do, in the owner's words where the tool
 *  gave any: "git push --force", "edit poller.mts", "fetch example.com". */
export function summaryOf(tool: string, input: any): string {
  const i = input && typeof input === 'object' ? input : {}
  switch (tool) {
    case 'Bash': return str(i.description) || str(i.command) || 'run a command'
    case 'Edit': case 'Write': case 'NotebookEdit': return `edit ${path.basename(str(i.file_path)) || 'a file'}`
    case 'Read': return `read ${path.basename(str(i.file_path)) || 'a file'}`
    case 'WebFetch': { try { return `fetch ${new URL(str(i.url)).hostname}` } catch { return 'fetch a url' } }
    case 'WebSearch': return `search: ${str(i.query)}`.trim()
    default: return tool.toLowerCase()
  }
}

/** Permission requests waiting on the owner. In memory: a restart drops them and
 *  the hooks fall through to the terminal prompt, which is the safe direction. */
export class Approvals {
  pending = new Map<string, Pending>()
  now: () => number

  constructor(now = Date.now) {
    this.now = now
  }

  request({ sessionId, tool, input, cwd }: { sessionId: string; tool: string; input: unknown; cwd: string }): Approval {
    const a: Pending = { id: crypto.randomUUID(), sessionId, tool, summary: summaryOf(tool, input), cwd, at: this.now(), waiters: [] }
    this.pending.set(a.id, a)
    return a
  }

  /** Resolves with the decision, or null when nobody decided within `timeoutMs`. */
  wait(id: string, timeoutMs: number): Promise<Decision | null> {
    const a = this.pending.get(id)
    if (!a) return Promise.resolve(null)
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.settle(id, null) }, timeoutMs)
      t.unref?.()
      a.waiters.push((d) => { clearTimeout(t); resolve(d) })
    })
  }

  decide(id: string, decision: Decision): boolean {
    if (!this.pending.has(id)) return false
    this.settle(id, decision)
    return true
  }

  forSession(sessionId: string): Approval | undefined {
    for (const a of this.pending.values()) if (a.sessionId === sessionId) return a
    return undefined
  }

  list(): Approval[] {
    return [...this.pending.values()].map(({ waiters, ...a }) => a)
  }

  private settle(id: string, d: Decision | null) {
    const a = this.pending.get(id)
    if (!a) return
    this.pending.delete(id)
    for (const w of a.waiters) w(d)
  }
}
