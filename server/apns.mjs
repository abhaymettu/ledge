// APNs transport for Live Activities. Zero dependencies: node:crypto for the ES256
// JWT, node:http2 because APNs speaks HTTP/2 only.
//
// Two things here are load-bearing and easy to get wrong:
//   1. The provider JWT is cached and regenerated every 45 minutes. Apple rejects a
//      token refreshed more often than every 20 minutes (TooManyProviderTokenUpdates).
//   2. One HTTP/2 session is reused for every push. Apple sends GOAWAY periodically;
//      we drop the session and reconnect on the next push rather than failing it.

import http2 from 'node:http2'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const JWT_TTL_MS = 45 * 60 * 1000
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)

/** Seconds since 2001-01-01. Swift's default JSONDecoder date strategy
 *  (.deferredToDate) is what ActivityKit uses to decode content-state, so a Date
 *  field must arrive in this unit, NOT as a unix timestamp or an ISO string. */
export const appleDate = (ms) => (ms - APPLE_EPOCH_MS) / 1000

export const expandTilde = (p) =>
  p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p

export const defaultConfigPath = () => path.join(os.homedir(), '.ledge', 'config.json')

export function loadConfig(file = defaultConfigPath()) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const k of ['teamId', 'keyId', 'keyPath', 'bundleId', 'token']) {
    if (!cfg[k]) throw new Error(`${file}: missing "${k}"`)
  }
  cfg.keyPath = expandTilde(cfg.keyPath)
  cfg.port ??= 8787
  cfg.env ??= 'production'
  return cfg
}

export const apnsHost = (cfg) =>
  cfg.env === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'

// --- JWT -------------------------------------------------------------------

const b64 = (v) =>
  Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')

let jwt = { token: null, at: 0, kid: null }

/** Cached ES256 provider token. Regenerated once per JWT_TTL_MS. */
export function authToken(cfg, now = Date.now()) {
  if (jwt.token && jwt.kid === cfg.keyId && now - jwt.at < JWT_TTL_MS) return jwt.token
  const signing = `${b64({ alg: 'ES256', kid: cfg.keyId })}.${b64({
    iss: cfg.teamId,
    iat: Math.floor(now / 1000),
  })}`
  const key = crypto.createPrivateKey(fs.readFileSync(cfg.keyPath, 'utf8'))
  // ieee-p1363 gives the raw r||s JOSE signature; the default DER encoding is rejected.
  const sig = crypto
    .sign('sha256', Buffer.from(signing), { key, dsaEncoding: 'ieee-p1363' })
    .toString('base64url')
  jwt = { token: `${signing}.${sig}`, at: now, kid: cfg.keyId }
  console.log(`[apns] minted provider JWT kid=${cfg.keyId}`)
  return jwt.token
}

// --- session ---------------------------------------------------------------

let session = null

function connect(cfg) {
  if (session && !session.closed && !session.destroyed) return session
  const host = apnsHost(cfg)
  const s = http2.connect(`https://${host}`)
  const drop = () => {
    if (session === s) session = null
  }
  s.on('goaway', (code, _id, extra) => {
    console.log(
      `[apns] GOAWAY code=${code}${extra?.length ? ` ${extra.toString('utf8')}` : ''}; reconnecting on next push`,
    )
    drop()
    s.destroy()
  })
  s.on('error', (e) => {
    console.log(`[apns] session error: ${e.message}`)
    drop()
  })
  s.on('close', drop)
  s.unref()
  session = s
  console.log(`[apns] h2 session -> ${host}`)
  return s
}

/** Close the shared session. Used by the process shutdown path and by tests. */
export function closeSession() {
  session?.close()
  session = null
}

// --- payloads --------------------------------------------------------------

/**
 * Which Live Activity the Dynamic Island promotes when several are running.
 * The system attaches the highest scorer to the camera and shows at most two.
 * A lane that is blocked on you must outrank one that is merely working.
 */
export const RELEVANCE = { needs_you: 90, result: 60, countdown: 40, progress: 20 }

/**
 * Relevance for one card, 0-100. Tiers, highest first:
 *   90-100  needs_you  - Claude asked you something. Scaled by how long it has been
 *                        waiting, so with three unanswered sessions the Island shows
 *                        the one you have ignored longest instead of an arbitrary tie.
 *      85   fail       - something broke
 *      70   stuck      - busy but silent; the poller marks these warn
 *      60   result
 *      40   countdown
 *      20   progress   - happily working, the least urgent thing on the screen
 */
export function relevanceFor(cs, now = Date.now()) {
  const template = cs?.template
  if (template === 'needs_you') {
    // startedAt is Apple reference-date seconds; it marks when the wait began.
    const startedMs = typeof cs.startedAt === 'number' ? cs.startedAt * 1000 + APPLE_EPOCH_MS : now
    const mins = Math.max(0, (now - startedMs) / 60_000)
    return 90 + Math.min(10, Math.floor(mins / 3)) // 30min+ of being ignored pins it at 100
  }
  if (cs?.tone === 'fail') return 85
  if (template === 'progress' && cs?.tone === 'warn') return 70 // stuck, not healthy
  return RELEVANCE[template] ?? 20
}

/**
 * Build the `aps` envelope.
 * `attributes-type` / `attributes` are required on start and MUST be absent on
 * update and end. `alert` is required on start or push-to-start is refused.
 */
export function buildPayload({ event, contentState, lane, alert, dismissAt, now = Date.now() }) {
  const aps = {
    timestamp: Math.floor(now / 1000),
    event,
    'content-state': contentState,
    'relevance-score': relevanceFor(contentState, now),
  }
  if (event === 'start') {
    aps['attributes-type'] = 'AgentActivity'
    aps.attributes = { lane }
    aps.alert = alert ?? { title: lane, body: contentState?.line || 'started' }
  }
  if (event === 'end' && dismissAt) aps['dismissal-date'] = Math.floor(dismissAt / 1000)
  return { aps }
}

// --- send ------------------------------------------------------------------

/** POST one payload. Resolves with {status, apnsId, reason} for any HTTP status. */
export function send(cfg, deviceToken, payload) {
  const json = JSON.stringify(payload)
  const bytes = Buffer.byteLength(json)
  return new Promise((resolve, reject) => {
    let req
    try {
      req = connect(cfg).request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${authToken(cfg)}`,
        'apns-topic': `${cfg.bundleId}.push-type.liveactivity`,
        'apns-push-type': 'liveactivity',
        'apns-priority': '10',
        'apns-expiration': '0',
        'content-type': 'application/json',
        'content-length': bytes,
      })
    } catch (e) {
      return reject(e)
    }
    let status = 0
    let apnsId = ''
    let body = ''
    req.setEncoding('utf8')
    req.on('response', (h) => {
      status = h[':status']
      apnsId = h['apns-id'] ?? ''
    })
    req.on('data', (c) => {
      body += c
    })
    req.on('error', (e) => {
      console.log(`[apns] request error event=${payload.aps.event}: ${e.message}`)
      reject(e)
    })
    req.on('end', () => {
      let reason = ''
      try {
        reason = JSON.parse(body).reason ?? ''
      } catch {}
      // Every response is logged, rejections included. A swallowed 400 is the whole bug.
      console.log(
        `[apns] ${status} apns-id=${apnsId} event=${payload.aps.event} bytes=${bytes}` +
          (reason ? ` reason=${reason}` : ''),
      )
      resolve({ status, apnsId, reason, body, bytes })
    })
    req.end(json)
  })
}

export const sendStart = (cfg, pushToStartToken, { lane, contentState, alert }) =>
  send(cfg, pushToStartToken, buildPayload({ event: 'start', lane, contentState, alert }))

export const sendUpdate = (cfg, updateToken, { contentState }) =>
  send(cfg, updateToken, buildPayload({ event: 'update', contentState }))

export const sendEnd = (cfg, updateToken, { contentState, dismissAt }) =>
  send(cfg, updateToken, buildPayload({ event: 'end', contentState, dismissAt }))
