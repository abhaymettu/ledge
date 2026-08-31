import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadConfig } from './apns.mts'
import { SESSIONS_DIR, transcriptPathFor } from './claude.mts'

const cfg = loadConfig(process.env.LEDGE_CONFIG)
const base = cfg.url ?? `http://127.0.0.1:${cfg.port}`
const headers = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }
const child = spawn('sleep', ['600'], { stdio: 'ignore' })
const pid = child.pid!
const lane = 'cc-ledge-verify'
const cwd = path.join(os.tmpdir(), 'ledge-verify')
const sessionId = `ledge-verify-${pid}`
const sessionFile = path.join(SESSIONS_DIR, `${pid}.json`)
const transcript = transcriptPathFor(cwd, sessionId)

let failed = 0
const ok = (msg: string) => console.log(`  ok    ${msg}`)
const bad = (msg: string) => { failed++; console.log(`  FAIL  ${msg}`) }
const rec = (type: string, content: unknown) => JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role: type, content } })

const get = async (p: string) => (await fetch(base + p, { headers })).json() as Promise<any>

async function until(what: string, check: () => Promise<boolean>, ms = 15_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await check()) return ok(what)
    await new Promise((r) => setTimeout(r, 1000))
  }
  bad(`${what} (waited ${ms / 1000}s)`)
}

function session(status: 'busy' | 'idle') {
  fs.writeFileSync(sessionFile, JSON.stringify({
    pid, sessionId, cwd, kind: 'interactive', entrypoint: 'cli', name: 'ledge-verify',
    status, statusUpdatedAt: Date.now() - 10_000, startedAt: Date.now() - 20_000,
  }))
}

async function main() {
  console.log('server')
  const health = await get('/health').catch(() => null)
  if (!health?.ok) return bad(`unreachable at ${base}`)
  ok(`reachable at ${base}`)
  health.paired ? ok('phone paired') : bad('not paired: open the Ledge app and tap Pair')

  console.log('poller, with a session it has never seen')
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  fs.writeFileSync(transcript, [
    rec('user', '~/ledge-verify/RUN.md'),
    rec('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'ledge verify', description: 'ledge verify' } }]),
  ].join('\n') + '\n')
  session('busy')
  try {
    await until('a working card goes up, line "running ledge verify"', async () => {
      const card = (await get('/lanes')).lanes[lane]
      return card?.state === 'working' && card.line === 'running ledge verify'
    })
    fs.appendFileSync(transcript, rec('assistant', [{ type: 'text', text: 'Is the card on your lock screen?' }]) + '\n')
    session('idle')
    await until('idle turns it into an asking card with the question', async () => {
      const card = (await get('/lanes')).lanes[lane]
      return card?.state === 'asking' && card.line === 'Is the card on your lock screen?'
    })
  } finally {
    fs.rmSync(sessionFile, { force: true })
    child.kill()
  }
  await until('the card ends once the session exits', async () => !(await get('/lanes')).lanes[lane])
  fs.rmSync(path.dirname(transcript), { recursive: true, force: true })

  console.log()
  console.log(failed ? `${failed} check(s) failed` : 'all good. On the phone: a card "ledge-verify" should have appeared working, turned into a question, and gone.')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { fs.rmSync(sessionFile, { force: true }); child.kill(); console.error(e.message); process.exit(1) })
