// ledge server. node:http listener, zero dependencies.
//
// Binds to loopback and the tailnet address only. There is no public ingress and
// no TLS here on purpose: the only path in is over Tailscale.

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildPayload } from './apns.mjs'
import { LANE_RE, validateActivity, validateEnd, contentStateFor } from './validate.mjs'

export * from './validate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const STATE_FILE = path.join(HERE, 'state.json')

/** IPv4 addresses in Tailscale's CGNAT range (100.64.0.0/10) on this machine. */
export function tailnetAddrs(interfaces = os.networkInterfaces()) {
  const out = []
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const [x, y] = a.address.split('.').map(Number)
      if (x === 100 && y >= 64 && y <= 127) out.push(a.address)
    }
  }
  return out
}

/** Loopback plus the tailnet address, auto-detected. `bindHosts` in config overrides. */
export const bindHosts = (cfg) => cfg.bindHosts ?? ['127.0.0.1', ...tailnetAddrs()]
export const PAYLOAD_MAX_BYTES = 4000
export const COALESCE_MS = 30_000
export const RESTART_MS = 7 * 3600_000 + 50 * 60_000 // 7h50m, under the 8h ceiling
// How long a push-to-start may be in flight before we assume iOS will never report
// an update token and allow a fresh start.
export const START_GRACE_MS = 15_000
// Dismiss an ended activity immediately. A 60s grace left three green "done"
// cards sitting on the lock screen; ending a card should remove it, not leave a
// tombstone. iOS keeps ended activities for hours otherwise.
export const END_DISMISS_MS = 0

// --- coalescer -------------------------------------------------------------

/**
 * At most one push per lane per window. A newer job inside the window replaces the
 * pending one rather than queueing behind it. `immediate` (needs_you, end) skips the
 * window entirely and discards whatever was pending.
 */
export class Coalescer {
  constructor(windowMs = COALESCE_MS) {
    this.windowMs = windowMs
    this.lanes = new Map()
  }

  #slot(lane) {
    let s = this.lanes.get(lane)
    if (!s) this.lanes.set(lane, (s = { last: -Infinity, pending: null, timer: null }))
    return s
  }

  #run(job, s) {
    s.last = Date.now()
    try {
      const r = job()
      return r && typeof r.catch === 'function'
        ? r.catch((e) => console.log(`[coalesce] send failed: ${e.message}`))
        : Promise.resolve(r)
    } catch (e) {
      console.log(`[coalesce] send threw: ${e.message}`)
      return Promise.resolve(null)
    }
  }

  /** Returns the send result, or {coalesced: true} if the job was deferred. */
  push(lane, job, { immediate = false } = {}) {
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

  drop(lane) {
    const s = this.lanes.get(lane)
    if (s?.timer) clearTimeout(s.timer)
    this.lanes.delete(lane)
  }
}

// --- state -----------------------------------------------------------------

export function loadState(file = STATE_FILE) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    s.lanes ??= {}
    // Drop parked ends older than an hour: if the phone never reported the token
    // (app deleted, activity dismissed by hand) the tombstone has nothing left to
    // address and would otherwise sit in state forever.
    for (const [lane, p] of Object.entries(s.pendingEnds ?? {})) {
      if (!p?.at || Date.now() - p.at > 3600_000) delete s.pendingEnds[lane]
    }
    return s
  } catch {
    return { pushToStartToken: null, deviceToken: null, lanes: {} }
  }
}

export function saveState(state, file = STATE_FILE) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

// --- http ------------------------------------------------------------------

const MAX_REQUEST_BYTES = 1 << 20

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
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

const send = (res, code, obj) => {
  const body = obj === undefined ? '' : JSON.stringify(obj)
  res.writeHead(code, body ? { 'content-type': 'application/json' } : {})
  res.end(body)
}

function authed(req, token) {
  const h = req.headers.authorization ?? ''
  const got = Buffer.from(h)
  const want = Buffer.from(`Bearer ${token}`)
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

const oversize = (payload) => Buffer.byteLength(JSON.stringify(payload)) > PAYLOAD_MAX_BYTES

// --- lane rollover ---------------------------------------------------------

function armRestart(ctx, lane) {
  clearTimeout(ctx.restarts.get(lane))
  // The .catch matters: restartLane's own catch block persists state, and if THAT
  // throws (disk full, dir gone) the rejection would otherwise be unhandled and
  // kill the process from a timer at hour eight.
  const t = setTimeout(
    () => restartLane(ctx, lane).catch((e) => console.log(`[restart] lane=${lane} cleanup failed: ${e.message}`)),
    ctx.restartMs,
  )
  t.unref?.()
  ctx.restarts.set(lane, t)
}

// 8h ceiling: end just before it and immediately push-to-start a replacement with
// the same content-state. One failure drops the lane; we do not retry forever.
async function restartLane(ctx, lane) {
  const { state, apns, coalescer, restarts, persist } = ctx
  const entry = state.lanes[lane]
  if (!entry) return
  console.log(`[restart] lane=${lane} rolling over at 7h50m`)
  try {
    if (entry.updateToken) {
      await apns.sendEnd(entry.updateToken, { contentState: entry.last, dismissAt: Date.now() })
    }
    const r = await apns.sendStart(state.pushToStartToken, { lane, contentState: entry.last })
    if (r.status !== 200) throw new Error(`APNs ${r.status} ${r.reason} apns-id=${r.apnsId}`)
    entry.startedAt = Date.now()
    entry.updateToken = null // the phone will report a fresh one via /token
    entry.startPending = Date.now()
    persist()
    armRestart(ctx, lane)
  } catch (e) {
    console.log(`[restart] lane=${lane} failed, dropping: ${e.message}`)
    delete state.lanes[lane]
    restarts.delete(lane)
    coalescer.drop(lane)
    persist()
  }
}

// --- routes ----------------------------------------------------------------

function handleHealth(ctx, res) {
  return send(res, 200, {
    ok: true,
    lanes: Object.keys(ctx.state.lanes),
    paired: Boolean(ctx.state.pushToStartToken),
  })
}

function handleRegister(ctx, body, res) {
  const { state, persist } = ctx
  if (typeof body.pushToStartToken !== 'string' || typeof body.deviceToken !== 'string') {
    return send(res, 400, { error: 'pushToStartToken and deviceToken are required strings' })
  }
  // A changed push-to-start token means the app was reinstalled or re-paired,
  // which wipes every Live Activity off the phone. The per-lane update tokens now
  // point at activities that no longer exist, so an update push updates a ghost
  // and nothing appears. Drop the lanes so the next post push-to-starts them
  // fresh. (Same token again — a normal relaunch — leaves live cards alone.)
  const reinstalled = state.pushToStartToken && state.pushToStartToken !== body.pushToStartToken
  state.pushToStartToken = body.pushToStartToken
  state.deviceToken = body.deviceToken
  if (reinstalled) {
    const n = Object.keys(state.lanes).length
    state.lanes = {}
    state.pendingEnds = {}
    ctx.onForget?.([]) // the poller must repost too, or its cards stay "up" until content changes
    console.log(`[register] new push-to-start token: dropped ${n} stale lane(s) for a clean restart`)
  }
  persist()
  console.log(`[register] push-to-start token stored (${body.pushToStartToken.slice(0, 8)}...)`)
  return send(res, 204)
}

async function handleToken(ctx, body, res) {
  const { state, apns, persist } = ctx
  if (typeof body.lane !== 'string' || !LANE_RE.test(body.lane)) {
    return send(res, 400, { error: 'lane must match ^[a-z0-9-]{1,24}$' })
  }
  if (typeof body.updateToken !== 'string') {
    return send(res, 400, { error: 'updateToken must be a string' })
  }
  // A parked end wins over storing the token: the lane was ended while its start
  // was still in flight, and this token is the first (and only) handle on that
  // card. Also guards the ghost-lane bug: without it, ??= below resurrects a
  // deleted lane whenever the phone's token report races an end.
  const parked = state.pendingEnds?.[body.lane]
  if (parked) {
    delete state.pendingEnds[body.lane]
    persist()
    const r = await apns.sendEnd(body.updateToken, { contentState: parked.cs, dismissAt: Date.now() + END_DISMISS_MS })
    console.log(`[token] lane=${body.lane} fired parked end -> ${r?.status ?? '?'}`)
    return send(res, 204)
  }
  // A token for a lane the server does not hold is a ghost: an activity the phone
  // still shows for a lane that was already ended (a restore whose token arrived
  // after the session died, say). Storing it would resurrect the lane with no
  // content and nothing to ever end it. End the activity instead.
  if (!state.lanes[body.lane]) {
    const cs = contentStateFor({ template: 'result', title: body.lane, line: 'done', tone: 'ok', lane: body.lane }, {})
    const r = await apns.sendEnd(body.updateToken, { contentState: cs, dismissAt: Date.now() + END_DISMISS_MS })
    console.log(`[token] lane=${body.lane} unknown lane, ended the ghost -> ${r?.status ?? '?'}`)
    return send(res, 204)
  }
  const entry = state.lanes[body.lane]
  entry.updateToken = body.updateToken
  entry.startPending = null
  const pendingFlush = entry.dirty ? entry.last : null
  entry.dirty = false
  persist()
  console.log(`[token] lane=${body.lane} update token stored`)
  // Flush whatever arrived while the start was still in flight.
  if (pendingFlush) {
    const r = await apns.sendUpdate(body.updateToken, { contentState: pendingFlush })
    console.log(`[token] lane=${body.lane} flushed held update -> ${r.status}`)
  }
  return send(res, 204)
}

/** APNs said no: surface its status, reason, and id so the caller can debug. */
function apnsReject(res, error, r) {
  return send(res, 502, {
    error,
    status: r?.status ?? 0,
    reason: r?.reason ?? '',
    apnsId: r?.apnsId ?? '',
  })
}

// A start is in flight when we have pushed one but iOS has not yet reported
// that activity's update token. Starting again in this gap is what puts two
// identical cards on the lock screen. Hold the state and let /token flush it.
function startInFlight(entry) {
  return Boolean(
    entry &&
    !entry.updateToken &&
    entry.startPending &&
    Date.now() - entry.startPending < START_GRACE_MS,
  )
}

// The job reads the token at send time, not enqueue time: a coalesced update
// can sit for 30s, during which the phone may rotate the token or the lane
// may roll over. A vanished token means the push has nowhere to go; skip it.
function activityJob(ctx, value, cs, starting) {
  const { state, apns } = ctx
  return starting
    ? () => apns.sendStart(state.pushToStartToken, { lane: value.lane, contentState: cs })
    : () => {
        const tok = state.lanes[value.lane]?.updateToken
        return tok ? apns.sendUpdate(tok, { contentState: cs }) : Promise.resolve(null)
      }
}

/** The commit half of POST /activity: size-check, record the lane state, arm rollover, push. */
async function sendActivity(ctx, res, { value, cs, startedAt, entry, starting }) {
  const { state, coalescer, persist } = ctx
  const payload = starting
    ? buildPayload({ event: 'start', lane: value.lane, contentState: cs })
    : buildPayload({ event: 'update', contentState: cs })
  if (oversize(payload)) {
    return send(res, 400, { error: `payload exceeds ${PAYLOAD_MAX_BYTES} bytes` })
  }

  state.lanes[value.lane] = {
    ...entry,
    startedAt,
    last: cs,
    ...(starting ? { startPending: Date.now(), dirty: false } : {}),
  }
  persist()
  if (starting) armRestart(ctx, value.lane)

  // needs_you and start bypass the 30s window; those are the ones he needs now.
  const immediate = value.template === 'needs_you' || starting
  const r = await coalescer.push(value.lane, activityJob(ctx, value, cs, starting), { immediate })
  if (r?.coalesced) return send(res, 200, { ok: true, lane: value.lane, coalesced: true })
  if (!r || r.status !== 200) return apnsReject(res, 'APNs rejected the push', r)
  return send(res, 200, {
    ok: true,
    lane: value.lane,
    event: starting ? 'start' : 'update',
    apnsId: r.apnsId,
  })
}

async function handleActivity(ctx, body, res) {
  const { state, persist } = ctx
  const { error, value } = validateActivity(body)
  if (error) return send(res, 400, { error })

  const entry = state.lanes[value.lane]
  const startedAt = value.startedAt ?? entry?.startedAt ?? Date.now()
  const cs = contentStateFor(value, { startedAt, prevTitle: entry?.last?.title })

  if (startInFlight(entry)) {
    state.lanes[value.lane] = { ...entry, startedAt, last: cs, dirty: true }
    persist()
    return send(res, 200, { ok: true, lane: value.lane, pending: true })
  }

  // An entry without an update token means the phone never reported one, so
  // start rather than 500.
  const starting = !entry || !entry.updateToken
  if (starting && !state.pushToStartToken) {
    return send(res, 409, { error: 'not paired: open the Ledge app and tap Pair' })
  }

  return sendActivity(ctx, res, { value, cs, startedAt, entry, starting })
}

async function handleActivityEnd(ctx, body, res) {
  const { state, apns, coalescer, restarts, persist } = ctx
  const { error, value } = validateEnd(body)
  if (error) return send(res, 400, { error })
  const entry = state.lanes[value.lane]
  if (!entry) return send(res, 404, { error: `no active lane "${value.lane}"` })

  const cs = contentStateFor(
    { template: 'result', title: value.lane, line: value.line, tone: value.tone },
    {},
  )
  const token = entry.updateToken
  clearTimeout(restarts.get(value.lane))
  restarts.delete(value.lane)
  coalescer.drop(value.lane)
  delete state.lanes[value.lane]

  if (!token) {
    // An end during the start grace has nothing to address: the push-to-start is
    // already on its way to the lock screen, but the phone has not reported the
    // activity's update token yet. Deleting state here used to orphan that card
    // permanently. Park the end instead; handleToken fires it the moment the
    // token arrives.
    if (entry.startPending) {
      ;(state.pendingEnds ??= {})[value.lane] = { cs, at: Date.now() }
      persist()
      return send(res, 200, { ok: true, lane: value.lane, event: 'end', note: 'end parked until the phone reports the activity token' })
    }
    persist()
    return send(res, 200, { ok: true, lane: value.lane, event: 'end', note: 'no update token; state cleared only' })
  }
  persist()
  const r = await apns.sendEnd(token, { contentState: cs, dismissAt: Date.now() + END_DISMISS_MS })
  if (!r || r.status !== 200) return apnsReject(res, 'APNs rejected the end', r)
  return send(res, 200, { ok: true, lane: value.lane, event: 'end', apnsId: r.apnsId })
}

/**
 * What the phone needs to re-create its cards locally: every lane's last content
 * state. The app's Restore button starts those activities on the device (no
 * push-to-start, so no APNs budget: iOS throttles after a burst, and it did on
 * 2026-08-29) and each new activity hands its token back through /token, which
 * replaces the dead one. Authed: titles and questions are in here.
 */
function handleLanes(ctx, res) {
  const lanes = {}
  for (const [lane, e] of Object.entries(ctx.state.lanes)) {
    if (!e.last) continue
    lanes[lane] = e.last
    // An activity the app starts locally has relevance 0, so a working card that
    // keeps getting updates would beat a restored "your turn" for the Dynamic
    // Island. Marking the lane dirty makes the new token's arrival push the
    // current content once, which carries the relevance score.
    e.dirty = true
  }
  ctx.persist()
  return send(res, 200, { lanes })
}

/**
 * The request handler. `apns` is injected so the tests can run without Apple:
 * {sendStart, sendUpdate, sendEnd} each returning {status, apnsId, reason}.
 * Routing, auth, body reading, and error handling only; the routes live above.
 */
export function createHandler({
  cfg,
  apns,
  state,
  coalescer = new Coalescer(),
  restarts = new Map(),
  stateFile = STATE_FILE,
  restartMs = RESTART_MS,
  onForget, // (liveLanes) => void: the poller drops what it posted for every other lane
}) {
  const ctx = { cfg, apns, state, coalescer, restarts, restartMs, onForget, persist: () => saveState(state, stateFile) }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://ledge')
    const route = `${req.method} ${url.pathname}`

    if (route === 'GET /health') return handleHealth(ctx, res)
    if (!authed(req, cfg.token)) return send(res, 401)
    if (route === 'GET /lanes') return handleLanes(ctx, res)

    let body = {}
    if (req.method === 'POST') {
      let raw
      try {
        raw = await readBody(req)
      } catch (e) {
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
      default: return send(res, 404, { error: `no route ${route}` })
    }
  }

  return (req, res) =>
    handle(req, res).catch((e) => {
      console.log(`[error] ${req.method} ${req.url}: ${e.stack}`)
      if (!res.headersSent) send(res, 500, { error: e.message })
    })
}

// --- main ------------------------------------------------------------------

export async function main() {
  const { loadConfig, sendStart, sendUpdate, sendEnd, closeSession } = await import('./apns.mjs')
  const cfg = loadConfig()
  const state = loadState()
  const apns = {
    sendStart: (t, o) => sendStart(cfg, t, o),
    sendUpdate: (t, o) => sendUpdate(cfg, t, o),
    sendEnd: (t, o) => sendEnd(cfg, t, o),
  }
  let poller // set below; the poller needs the port the handler listens on
  const handler = createHandler({ cfg, apns, state, onForget: (live) => poller?.forgetExcept?.(live) })

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
    const { startSessionPoller } = await import('./sessions.mjs')
    // Loopback POST to our own listener: the poller goes through the exact code
    // path a hook's curl does, so nothing is duplicated.
    const post = async (pathname, body) => {
      const r = await fetch(`http://127.0.0.1:${cfg.port}${pathname}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: r.status, body: await r.text() }
    }
    poller = startSessionPoller({
      existingLanes: Object.keys(state.lanes), post, config: cfg.sessions })
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
