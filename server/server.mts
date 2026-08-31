import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildPayload } from './apns.mts'
import { LANE_RE, validateActivity, validateEnd, contentStateFor } from './validate.mts'
import { Coalescer, COALESCE_MS } from './coalescer.mts'
import {
  type State, type Lane, loadState, saveState, inFlight, started, updated, hold, tokenArrived, ended,
  rolledOver, markHeld, forgetAll, START_GRACE_MS,
} from './lanes.mts'
import type { Card } from './card-state.mts'
import { sublineFor } from './card.mts'
import { Approvals, APPROVAL_TTL_MS, type Decision } from './approvals.mts'

export * from './validate.mts'
export { Coalescer, COALESCE_MS, START_GRACE_MS, loadState, saveState }

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const STATE_FILE = path.join(HERE, 'state.json')
export const PAYLOAD_MAX_BYTES = 4000
export const RESTART_MS = 7 * 3600_000 + 50 * 60_000
export const END_DISMISS_MS = 0
const MAX_REQUEST_BYTES = 1 << 20

export function tailnetAddrs(interfaces = os.networkInterfaces()): string[] {
  const out: string[] = []
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const [x, y] = a.address.split('.').map(Number)
      if (x === 100 && y >= 64 && y <= 127) out.push(a.address)
    }
  }
  return out
}

export const bindHosts = (cfg: any): string[] => cfg.bindHosts ?? ['127.0.0.1', ...tailnetAddrs()]

type ApnsResult = { status: number; apnsId?: string; reason?: string } | null | undefined
export type Apns = {
  sendStart: (token: string, o: { lane: string; contentState: Card }) => Promise<ApnsResult>
  sendUpdate: (token: string, o: { contentState: Card }) => Promise<ApnsResult>
  sendEnd: (token: string, o: { contentState: Card; dismissAt: number }) => Promise<ApnsResult>
}

type Ctx = {
  cfg: any
  apns: Apns
  state: State
  approvals: Approvals
  coalescer: Coalescer
  restarts: Map<string, NodeJS.Timeout>
  restartMs: number
  onForget?: (live: string[]) => void
  persist: () => void
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > MAX_REQUEST_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const send = (res: http.ServerResponse, code: number, obj?: unknown) => {
  const body = obj === undefined ? '' : JSON.stringify(obj)
  res.writeHead(code, body ? { 'content-type': 'application/json' } : {})
  res.end(body)
}

function authed(req: http.IncomingMessage, token: string) {
  const got = Buffer.from(req.headers.authorization ?? '')
  const want = Buffer.from(`Bearer ${token}`)
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

const oversize = (payload: unknown) => Buffer.byteLength(JSON.stringify(payload)) > PAYLOAD_MAX_BYTES

const apnsReject = (res: http.ServerResponse, error: string, r: ApnsResult) =>
  send(res, 502, { error, status: r?.status ?? 0, reason: r?.reason ?? '', apnsId: r?.apnsId ?? '' })

// done and failed are the only states the poller does not build. Whatever the
// caller sends is what the card says, so headline and subline ride through
// here rather than being invented server-side.
const endCard = (lane: string, line = 'done', tone = 'ok', headline?: string, subline?: string): Card =>
  contentStateFor({ template: 'result', title: lane, line, tone, headline, subline }, {})

function armRestart(ctx: Ctx, lane: string) {
  clearTimeout(ctx.restarts.get(lane))
  const t = setTimeout(
    () => restartLane(ctx, lane).catch((e) => console.log(`[restart] lane=${lane} cleanup failed: ${e.message}`)),
    ctx.restartMs,
  )
  t.unref?.()
  ctx.restarts.set(lane, t)
}

async function restartLane(ctx: Ctx, lane: string) {
  const { state, apns, coalescer, restarts, persist } = ctx
  const entry = state.lanes[lane]
  if (!entry) return
  console.log(`[restart] lane=${lane} rolling over at 7h50m`)
  try {
    if (entry.kind === 'live') await apns.sendEnd(entry.token, { contentState: entry.card, dismissAt: Date.now() })
    const r = await apns.sendStart(state.pushToStartToken!, { lane, contentState: entry.card })
    if (r?.status !== 200) throw new Error(`APNs ${r?.status} ${r?.reason} apns-id=${r?.apnsId}`)
    rolledOver(state, lane)
    persist()
    armRestart(ctx, lane)
  } catch (e: any) {
    console.log(`[restart] lane=${lane} failed, dropping: ${e.message}`)
    delete state.lanes[lane]
    restarts.delete(lane)
    coalescer.drop(lane)
    persist()
  }
}

const handleHealth = (ctx: Ctx, res: http.ServerResponse) =>
  send(res, 200, { ok: true, lanes: Object.keys(ctx.state.lanes), paired: Boolean(ctx.state.pushToStartToken) })

function handleRegister(ctx: Ctx, body: any, res: http.ServerResponse) {
  const { state, persist } = ctx
  if (typeof body.pushToStartToken !== 'string') {
    return send(res, 400, { error: 'pushToStartToken is required and must be a string' })
  }
  const reinstalled = Boolean(state.pushToStartToken) && state.pushToStartToken !== body.pushToStartToken
  state.pushToStartToken = body.pushToStartToken
  if (reinstalled) {
    const n = Object.keys(state.lanes).length
    forgetAll(state)
    ctx.onForget?.([])
    console.log(`[register] new push-to-start token: dropped ${n} stale lane(s) for a clean restart`)
  }
  persist()
  console.log(`[register] push-to-start token stored (${body.pushToStartToken.slice(0, 8)}...)`)
  return send(res, 204)
}

async function handleToken(ctx: Ctx, body: any, res: http.ServerResponse) {
  const { state, apns, persist } = ctx
  if (typeof body.lane !== 'string' || !LANE_RE.test(body.lane)) {
    return send(res, 400, { error: 'lane must match ^[a-z0-9-]{1,24}$' })
  }
  if (typeof body.updateToken !== 'string') return send(res, 400, { error: 'updateToken must be a string' })
  const lane: string = body.lane
  const token: string = body.updateToken
  const outcome = tokenArrived(state, lane, token)
  persist()
  if ('parked' in outcome) {
    const r = await apns.sendEnd(token, { contentState: outcome.parked.card, dismissAt: Date.now() + END_DISMISS_MS })
    console.log(`[token] lane=${lane} fired parked end -> ${r?.status ?? '?'}`)
    return send(res, 204)
  }
  if ('ghost' in outcome) {
    const r = await apns.sendEnd(token, { contentState: endCard(lane), dismissAt: Date.now() + END_DISMISS_MS })
    console.log(`[token] lane=${lane} unknown lane, ended the ghost -> ${r?.status ?? '?'}`)
    return send(res, 204)
  }
  console.log(`[token] lane=${lane} update token stored`)
  if (outcome.flush) {
    const r = await apns.sendUpdate(token, { contentState: outcome.flush })
    console.log(`[token] lane=${lane} flushed held update -> ${r?.status}`)
  }
  return send(res, 204)
}

async function handleActivity(ctx: Ctx, body: any, res: http.ServerResponse) {
  const { state, apns, coalescer, persist } = ctx
  const { error, value } = validateActivity(body)
  if (error) return send(res, 400, { error })
  const lane: string = value.lane
  const entry: Lane | undefined = state.lanes[lane]
  const startedAt: number = value.startedAt ?? entry?.startedAt ?? Date.now()
  // A card posted by a hook carries no subline. Fill it here rather than in the
  // hook, so the shell stays dumb. Only when absent: a sender that said
  // something is never second-guessed, and `title` is untouched either way, so
  // the frozen identity still comes from prevTitle below.
  if (value.subline === undefined) {
    const derived = sublineFor(lane, value.line)
    if (derived) value.subline = derived
  }
  const card = contentStateFor(value, { startedAt, prevTitle: entry?.card.title })

  if (inFlight(entry)) {
    hold(state, lane, card, startedAt)
    persist()
    return send(res, 200, { ok: true, lane, pending: true })
  }
  const starting = entry?.kind !== 'live'
  if (starting && !state.pushToStartToken) return send(res, 409, { error: 'not paired: open the Ledge app and tap Pair' })
  const payload = starting
    ? buildPayload({ event: 'start', lane, contentState: card })
    : buildPayload({ event: 'update', contentState: card })
  if (oversize(payload)) return send(res, 400, { error: `payload exceeds ${PAYLOAD_MAX_BYTES} bytes` })

  if (starting) started(state, lane, card, startedAt)
  else updated(state, lane, card, startedAt)
  persist()
  if (starting) armRestart(ctx, lane)

  const job = starting
    ? () => apns.sendStart(state.pushToStartToken!, { lane, contentState: card })
    : () => {
        const e = state.lanes[lane]
        return e?.kind === 'live' ? apns.sendUpdate(e.token, { contentState: card }) : Promise.resolve(null)
      }
  const r = await coalescer.push(lane, job, { immediate: card.state === 'asking' || starting })
  if (r?.coalesced) return send(res, 200, { ok: true, lane, coalesced: true })
  if (r?.status !== 200) return apnsReject(res, 'APNs rejected the push', r)
  return send(res, 200, { ok: true, lane, event: starting ? 'start' : 'update', apnsId: r.apnsId })
}

async function handleActivityEnd(ctx: Ctx, body: any, res: http.ServerResponse) {
  const { state, apns, coalescer, restarts, persist } = ctx
  const { error, value } = validateEnd(body)
  if (error) return send(res, 400, { error })
  const lane: string = value.lane
  clearTimeout(restarts.get(lane))
  restarts.delete(lane)
  coalescer.drop(lane)
  const outcome = ended(state, lane, endCard(lane, value.line, value.tone, value.headline, value.subline), Date.now(), value.tone === 'fail' ? 'failed' : 'done')
  if (!outcome) return send(res, 404, { error: `no active lane "${lane}"` })
  persist()
  if ('parked' in outcome) {
    return send(res, 200, { ok: true, lane, event: 'end', note: 'end parked until the phone reports the activity token' })
  }
  const r = await apns.sendEnd(outcome.token, { contentState: endCard(lane, value.line, value.tone, value.headline, value.subline), dismissAt: Date.now() + END_DISMISS_MS })
  if (r?.status !== 200) return apnsReject(res, 'APNs rejected the end', r)
  return send(res, 200, { ok: true, lane, event: 'end', apnsId: r.apnsId })
}

function handleApprovalRequest(ctx: Ctx, body: any, res: http.ServerResponse) {
  if (typeof body.sessionId !== 'string' || typeof body.tool !== 'string') {
    return send(res, 400, { error: 'sessionId and tool are required strings' })
  }
  const a = ctx.approvals.request({ sessionId: body.sessionId, tool: body.tool, input: body.input, cwd: String(body.cwd ?? '') })
  console.log(`[approval] ${a.id.slice(0, 8)} session=${a.sessionId.slice(0, 8)} ${a.tool}: ${a.summary}`)
  return send(res, 201, { id: a.id })
}

async function handleApprovalWait(ctx: Ctx, id: string, url: URL, res: http.ServerResponse) {
  const wait = Math.min(Number(url.searchParams.get('wait')) || 0, APPROVAL_TTL_MS)
  const decision = await ctx.approvals.wait(id, wait)
  console.log(`[approval] ${id.slice(0, 8)} -> ${decision ?? 'no decision'}`)
  return send(res, 200, { decision })
}

function handleApprovalDecide(ctx: Ctx, id: string, body: any, res: http.ServerResponse) {
  const d: unknown = body.decision
  if (d !== 'allow' && d !== 'deny') return send(res, 400, { error: 'decision must be allow or deny' })
  if (!ctx.approvals.decide(id, d as Decision)) return send(res, 404, { error: 'no such approval, it may have expired' })
  return send(res, 204)
}

function handleLanes(ctx: Ctx, res: http.ServerResponse) {
  const lanes: Record<string, Card> = {}
  for (const [lane, e] of Object.entries(ctx.state.lanes)) lanes[lane] = e.card
  markHeld(ctx.state)
  ctx.persist()
  return send(res, 200, { lanes })
}

export function createHandler({
  cfg,
  apns,
  state,
  coalescer = new Coalescer(),
  restarts = new Map<string, NodeJS.Timeout>(),
  stateFile = STATE_FILE,
  restartMs = RESTART_MS,
  onForget,
  approvals,
}: {
  cfg: any
  apns: Apns
  state: State
  coalescer?: Coalescer
  restarts?: Map<string, NodeJS.Timeout>
  stateFile?: string
  restartMs?: number
  onForget?: (live: string[]) => void
  approvals?: Approvals
}) {
  state.pendingEnds ??= {}
  const ctx: Ctx = { cfg, apns, state, approvals: approvals ?? new Approvals(), coalescer, restarts, restartMs, onForget, persist: () => saveState(state, stateFile) }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://ledge')
    const route = `${req.method} ${url.pathname}`
    if (route === 'GET /health') return handleHealth(ctx, res)
    if (!authed(req, cfg.token)) return send(res, 401)
    if (route === 'GET /lanes') return handleLanes(ctx, res)
    if (route === 'GET /approvals') return send(res, 200, { approvals: ctx.approvals.list() })
    if (route === 'GET /history') return send(res, 200, { history: ctx.state.history })
    const approval = /^\/approvals\/([0-9a-f-]{1,64})$/.exec(url.pathname)?.[1]
    if (approval && req.method === 'GET') return handleApprovalWait(ctx, approval, url, res)

    let body: any = {}
    if (req.method === 'POST') {
      let raw: string
      try {
        raw = await readBody(req)
      } catch (e: any) {
        return send(res, 413, { error: e.message })
      }
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        return send(res, 400, { error: 'body is not valid JSON' })
      }
    }
    switch (route) {
      case 'POST /register': return handleRegister(ctx, body, res)
      case 'POST /token': return handleToken(ctx, body, res)
      case 'POST /activity': return handleActivity(ctx, body, res)
      case 'POST /activity/end': return handleActivityEnd(ctx, body, res)
      case 'POST /approvals': return handleApprovalRequest(ctx, body, res)
      case `POST /approvals/${approval}`: return handleApprovalDecide(ctx, approval!, body, res)
      default: return send(res, 404, { error: `no route ${route}` })
    }
  }

  return (req: http.IncomingMessage, res: http.ServerResponse) =>
    handle(req, res).catch((e) => {
      console.log(`[error] ${req.method} ${req.url}: ${e.stack}`)
      if (!res.headersSent) send(res, 500, { error: e.message })
    })
}

export async function main() {
  const { loadConfig, sendStart, sendUpdate, sendEnd, closeSession } = await import('./apns.mts')
  const cfg = loadConfig()
  const state = loadState(STATE_FILE)
  const apns: Apns = {
    sendStart: (t, o) => sendStart(cfg, t, o),
    sendUpdate: (t, o) => sendUpdate(cfg, t, o),
    sendEnd: (t, o) => sendEnd(cfg, t, o),
  }
  let poller: { forgetExcept?: (live: string[]) => void } | undefined
  const approvals = new Approvals()
  const handler = createHandler({ cfg, apns, state, approvals, onForget: (live) => poller?.forgetExcept?.(live) })

  const hosts = bindHosts(cfg)
  if (hosts.length === 1) console.log('[listen] no tailnet address found; loopback only (set "bindHosts" in config to override)')
  for (const host of hosts) {
    const srv = http.createServer(handler)
    srv.on('error', (e) => console.log(`[listen] ${host}:${cfg.port} unavailable: ${e.message}`))
    srv.listen(cfg.port, host, () =>
      console.log(`[listen] http://${host}:${cfg.port} env=${cfg.env} lanes=${Object.keys(state.lanes).length}`),
    )
  }
  if (cfg.sessions?.enabled !== false) {
    const { startSessionPoller } = await import('./poller.mts')
    const post = async (pathname: string, body: unknown) => {
      const r = await fetch(`http://127.0.0.1:${cfg.port}${pathname}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: r.status, body: await r.text() }
    }
    poller = startSessionPoller({ existingLanes: Object.keys(state.lanes), post, config: cfg.sessions, approvals })
  }
  process.on('SIGINT', () => {
    closeSession()
    process.exit(0)
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
