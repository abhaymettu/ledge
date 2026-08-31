import http2 from 'node:http2'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { relevanceOf, type Card } from './card-state.mts'

export const JWT_TTL_MS = 45 * 60 * 1000

export type Config = {
  teamId: string
  keyId: string
  keyPath: string
  bundleId: string
  token: string
  port: number
  env: 'production' | 'sandbox'
  url?: string
  bindHosts?: string[]
  sessions?: Record<string, unknown>
}

export const expandTilde = (p: string) =>
  p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p

export const defaultConfigPath = () => path.join(os.homedir(), '.ledge', 'config.json')

export function loadConfig(file = defaultConfigPath()): Config {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Config
  for (const k of ['teamId', 'keyId', 'keyPath', 'bundleId', 'token'] as const) {
    if (!cfg[k]) throw new Error(`${file}: missing "${k}"`)
  }
  cfg.keyPath = expandTilde(cfg.keyPath)
  cfg.port ??= 8787
  cfg.env ??= 'production'
  return cfg
}

export type Env = Config['env']

export const apnsHost = (env: Env) =>
  env === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'

export const otherEnv = (env: Env): Env => (env === 'sandbox' ? 'production' : 'sandbox')

const b64 = (v: string | object) =>
  Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')

let jwt: { token: string | null; at: number; kid: string | null } = { token: null, at: 0, kid: null }

export function authToken(cfg: Pick<Config, 'teamId' | 'keyId' | 'keyPath'>, now = Date.now()) {
  if (jwt.token && jwt.kid === cfg.keyId && now - jwt.at < JWT_TTL_MS) return jwt.token
  const signing = `${b64({ alg: 'ES256', kid: cfg.keyId })}.${b64({
    iss: cfg.teamId,
    iat: Math.floor(now / 1000),
  })}`
  const key = crypto.createPrivateKey(fs.readFileSync(cfg.keyPath, 'utf8'))
  const sig = crypto
    .sign('sha256', Buffer.from(signing), { key, dsaEncoding: 'ieee-p1363' })
    .toString('base64url')
  jwt = { token: `${signing}.${sig}`, at: now, kid: cfg.keyId }
  console.log(`[apns] minted provider JWT kid=${cfg.keyId}`)
  return jwt.token
}

// One session per host, because the fallback below talks to both. A single shared
// session would hand back the production connection while we were asking for sandbox.
const sessions = new Map<string, http2.ClientHttp2Session>()

function connect(env: Env) {
  const host = apnsHost(env)
  const live = sessions.get(host)
  if (live && !live.closed && !live.destroyed) return live
  const s = http2.connect(`https://${host}`)
  const drop = () => {
    if (sessions.get(host) === s) sessions.delete(host)
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
  sessions.set(host, s)
  console.log(`[apns] h2 session -> ${host}`)
  return s
}

export function closeSession() {
  for (const s of sessions.values()) s.close()
  sessions.clear()
  learned = null
}

export type Push = {
  event: 'start' | 'update' | 'end'
  contentState: Card
  lane?: string
  alert?: { title: string; body: string }
  dismissAt?: number
  now?: number
}

export function buildPayload({ event, contentState, lane, alert, dismissAt, now = Date.now() }: Push) {
  const aps: Record<string, unknown> = {
    timestamp: Math.floor(now / 1000),
    event,
    'content-state': contentState,
    'relevance-score': relevanceOf(contentState, now),
  }
  if (event === 'start') {
    aps['attributes-type'] = 'AgentActivity'
    aps.attributes = { lane }
    aps.alert = alert ?? { title: lane, body: contentState?.line || 'started' }
  }
  if (event === 'update' && (contentState.state === 'asking' || contentState.state === 'approval')) {
    aps.alert = { title: contentState.title, body: contentState.line, sound: 'default' }
  }
  // A lane finishing is the other moment worth his attention: the work is there to look
  // at, and he asked for ledge to be the thing that tells him, not a side channel. The
  // end push carries the outcome so a silenced phone still shows what happened.
  if (event === 'end') {
    if (dismissAt) aps['dismissal-date'] = Math.floor(dismissAt / 1000)
    aps.alert = alert ?? { title: contentState.title, body: contentState.line, sound: 'default' }
  }
  return { aps }
}

export type SendResult = { status: number; apnsId: string; reason: string; body: string; bytes: number }

/** Apple binds the topic to the push type: a `liveactivity` push needs the bundle
 *  id with `push-type.liveactivity` appended. The card is the only push Ledge
 *  sends; approvals are answered in the app, reached by tapping the card. */
export function apnsHeaders(cfg: any) {
  return {
    'apns-topic': `${cfg.bundleId}.push-type.liveactivity`,
    'apns-push-type': 'liveactivity',
    'apns-priority': '10',
    'apns-expiration': '0',
  }
}

export function sendTo(
  env: Env,
  cfg: any,
  deviceToken: string,
  payload: { aps: Record<string, unknown> },
): Promise<SendResult> {
  const json = JSON.stringify(payload)
  const bytes = Buffer.byteLength(json)
  return new Promise<SendResult>((resolve, reject) => {
    let req: http2.ClientHttp2Stream
    try {
      req = connect(env).request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${authToken(cfg)}`,
        ...apnsHeaders(cfg),
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
      status = Number(h[':status'])
      apnsId = String(h['apns-id'] ?? '')
    })
    req.on('data', (c) => {
      body += c
    })
    req.on('error', (e) => {
      console.log(`[apns] request error event=${String(payload.aps.event)}: ${e.message}`)
      reject(e)
    })
    req.on('end', () => {
      let reason = ''
      try {
        reason = JSON.parse(body).reason ?? ''
      } catch {}
      console.log(
        `[apns] ${status} apns-id=${apnsId} event=${payload.aps.event} bytes=${bytes}` +
          (reason ? ` reason=${reason}` : ''),
      )
      resolve({ status, apnsId, reason, body, bytes })
    })
    req.end(json)
  })
}

// A device token is only valid on the environment that issued it, and nothing in the
// token says which one that is. A TestFlight build is production; anything built and
// installed locally is sandbox; so config.env goes stale the moment he sideloads, and
// every push dies with BadDeviceToken until someone remembers to edit it. Let Apple
// answer instead: try, and on BadDeviceToken try the other host and keep what worked.
// ponytail: one learned env for the server, not one per token. One phone is the whole
// fleet. Two devices on opposite environments would cost one wasted push per alternation.
let learned: Env | null = null

export async function send(
  cfg: any,
  deviceToken: string,
  payload: { aps: Record<string, unknown> },
  post = sendTo,
): Promise<SendResult> {
  const first: Env = learned ?? (cfg.env === 'sandbox' ? 'sandbox' : 'production')
  const r = await post(first, cfg, deviceToken, payload)
  if (r.status !== 400 || r.reason !== 'BadDeviceToken') {
    if (r.status < 300) learned = first
    return r
  }
  const alt = otherEnv(first)
  console.log(`[apns] BadDeviceToken on ${first}; retrying on ${alt}`)
  const retry = await post(alt, cfg, deviceToken, payload)
  if (retry.status < 300) {
    learned = alt
    console.log(`[apns] ${alt} accepted the token; pushing there from now on`)
  }
  return retry
}

export const sendStart = (cfg: any, pushToStartToken: string, { lane, contentState, alert }: { lane: string; contentState: Card; alert?: Push['alert'] }) =>
  send(cfg, pushToStartToken, buildPayload({ event: 'start', lane, contentState, alert }))

export const sendUpdate = (cfg: any, updateToken: string, { contentState }: { contentState: Card }) =>
  send(cfg, updateToken, buildPayload({ event: 'update', contentState }))

export const sendEnd = (cfg: any, updateToken: string, { contentState, dismissAt, alert }: { contentState: Card; dismissAt: number; alert?: Push['alert'] }) =>
  send(cfg, updateToken, buildPayload({ event: 'end', contentState, dismissAt, alert }))

