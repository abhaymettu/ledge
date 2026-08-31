export const COALESCE_MS = 30_000

type Job = () => unknown
type Slot = { last: number; pending: Job | null; timer: NodeJS.Timeout | null }

export class Coalescer {
  windowMs: number
  lanes = new Map<string, Slot>()

  constructor(windowMs = COALESCE_MS) {
    this.windowMs = windowMs
  }

  #slot(lane: string): Slot {
    let s = this.lanes.get(lane)
    if (!s) this.lanes.set(lane, (s = { last: -Infinity, pending: null, timer: null }))
    return s
  }

  #run(job: Job, s: Slot): Promise<any> {
    s.last = Date.now()
    try {
      const r: any = job()
      return r && typeof r.catch === 'function'
        ? r.catch((e: Error) => console.log(`[coalesce] send failed: ${e.message}`))
        : Promise.resolve(r)
    } catch (e: any) {
      console.log(`[coalesce] send threw: ${e.message}`)
      return Promise.resolve(null)
    }
  }

  push(lane: string, job: Job, { immediate = false } = {}): Promise<any> {
    const s = this.#slot(lane)
    if (immediate) {
      if (s.timer) clearTimeout(s.timer)
      s.timer = null
      s.pending = null
      return this.#run(job, s)
    }
    const wait = this.windowMs - (Date.now() - s.last)
    if (wait <= 0 && !s.timer) return this.#run(job, s)
    s.pending = job
    if (!s.timer) {
      s.timer = setTimeout(() => {
        s.timer = null
        const j = s.pending
        s.pending = null
        if (j) this.#run(j, s)
      }, Math.max(wait, 0))
      s.timer.unref?.()
    }
    return Promise.resolve({ coalesced: true })
  }

  drop(lane: string) {
    const s = this.lanes.get(lane)
    if (s?.timer) clearTimeout(s.timer)
    this.lanes.delete(lane)
  }
}
