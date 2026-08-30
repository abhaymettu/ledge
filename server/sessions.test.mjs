// node --test server/
// The session poller against temp directories, never the real ~/.claude. `post` is
// a recorder; nothing here touches the HTTP server or Apple.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { startSessionPoller, selectCards, laneFor, lineFor, titleFor, titleTrim, pathLabel, currentActivity, lastQuestion, stripMd, fmtMins, toolPhrase, DEFAULTS, qualifies , WAITING_FRESH_MS, inferredStatus, withInferredStatus, TRANSCRIPT_HEAD_BYTES } from './sessions.mjs'
import { summariseTitle, createTitleSummariser, isPathPrompt, recentContext, needsRefresh } from './claude-state.mjs'

const NOW = () => Date.now()

/** A session file shaped like the real ~/.claude/sessions/<pid>.json. */
const sess = (over = {}) => ({
  pid: process.pid, // alive by construction
  sessionId: '925fb8cf-0000-0000-0000-000000000000',
  cwd: path.join(os.homedir(), 'code', 'career-ops'),
  startedAt: NOW() - 3600_000,
  version: '2.1.251',
  kind: 'interactive',
  name: 'chief-b7',
  status: 'busy',
  updatedAt: NOW(),
  statusUpdatedAt: NOW() - 60_000, // busy for a minute, past minBusyMs
  bridgeSessionId: 'session_01RbTest',
  ...over,
})

function harness(t, config = {}, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledge-sessions-'))
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledge-projects-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }))
  const calls = []
  const post = async (pathname, body) => {
    calls.push({ pathname, body })
    return { status: 200, body: '' }
  }
  const logs = []
  const stop = startSessionPoller({
    post,
    dir,
    projectsDir,
    // Stubbed by default so no test ever spawns the real claude CLI or touches
    // the real ~/.ledge/titles.json. '' is rejected by the acceptance rules, so
    // titles behave exactly as before unless a test injects its own runner.
    titleRun: async () => '',
    titleCachePath: path.join(dir, 'titles.json'),
    config: { pollMs: 3600_000, ...config }, // the interval never fires; tests drive tick()
    log: (l) => logs.push(l),
    ...opts,
  })
  t.after(stop)
  const write = (s, name = `${s.pid}.json`) =>
    fs.writeFileSync(path.join(dir, name), JSON.stringify(s))
  const writeTranscript = (cwd, sessionId, records) => {
    const d = path.join(projectsDir, cwd.replaceAll('/', '-'))
    fs.mkdirSync(d, { recursive: true })
    const file = path.join(d, `${sessionId}.jsonl`)
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    return file
  }
  return { dir, projectsDir, calls, logs, write, writeTranscript, tick: stop.tick, stop }
}

const posts = (calls) => calls.filter((c) => c.pathname === '/activity')
const ends = (calls) => calls.filter((c) => c.pathname === '/activity/end')
const user = (content) => ({ type: 'user', message: { role: 'user', content } })

test('poller: a busy interactive session past minBusyMs produces exactly one card', async (t) => {
  const h = harness(t)
  h.write(sess())
  await h.tick()
  await h.tick() // a second identical poll must not post again
  assert.equal(posts(h.calls).length, 1)
  assert.equal(ends(h.calls).length, 0)
  const body = posts(h.calls)[0].body
  assert.equal(body.lane, 'cc-chief-b7')
  assert.equal(body.template, 'progress')
  assert.equal(body.tone, 'neutral')
  assert.equal(body.progress, undefined)
  assert.equal(body.line, '~/code/career-ops')
  assert.equal(body.title, 'chief-b7') // no transcript: falls back to name
  assert.equal(body.url, 'claude://code/session_01RbTest')
  assert.equal(typeof body.startedAt, 'number')
})

test('poller: startedAt is statusUpdatedAt, not the terminal startedAt', async (t) => {
  const h = harness(t)
  const s = sess()
  h.write(s)
  await h.tick()
  assert.equal(posts(h.calls)[0].body.startedAt, s.statusUpdatedAt)
})

test('poller: a busy session under minBusyMs produces none', async (t) => {
  const h = harness(t)
  h.write(sess({ statusUpdatedAt: NOW() - 1000 }))
  await h.tick()
  assert.equal(h.calls.length, 0)
})

test('poller: idle, shell, and non-interactive produce none', async (t) => {
  const h = harness(t)
  h.write(sess({ status: 'idle', name: 'a1' }), '1001.json')
  h.write(sess({ status: 'shell', name: 'a2' }), '1002.json')
  h.write(sess({ kind: 'background', name: 'a3' }), '1003.json')
  await h.tick()
  assert.equal(h.calls.length, 0)
})

test('poller: a session that starts life idle never gets a card, however long it idles', async (t) => {
  const h = harness(t)
  h.write(sess({ status: 'idle', statusUpdatedAt: NOW() - 3600_000 }))
  await h.tick()
  await h.tick()
  await h.tick()
  assert.equal(h.calls.length, 0)
})

test('poller: a dead pid produces none even if status says busy', async (t) => {
  const h = harness(t)
  const dead = spawnSync('true').pid // exited before spawnSync returned
  assert.ok(Number.isInteger(dead))
  h.write(sess({ pid: dead }))
  await h.tick()
  assert.equal(h.calls.length, 0)
})

test('poller: busy -> idle transitions the same lane to needs_you, no end', async (t) => {
  const h = harness(t)
  h.write(sess())
  await h.tick()
  const idleAt = NOW()
  h.write(sess({ status: 'idle', statusUpdatedAt: idleAt }))
  await h.tick()
  assert.equal(ends(h.calls).length, 0)
  assert.equal(posts(h.calls).length, 2)
  const body = posts(h.calls)[1].body
  assert.equal(body.lane, 'cc-chief-b7')
  assert.equal(body.template, 'needs_you')
  assert.equal(body.tone, 'warn')
  assert.equal(body.line, 'your turn')
  assert.equal(body.startedAt, idleAt) // timer counts how long it has waited on him
})

test('poller: a session with no status (sdk-cli, driven from the Claude app) reads it from the transcript', async (t) => {
  const h = harness(t)
  const s = sess({ entrypoint: 'sdk-cli' })
  delete s.status
  delete s.statusUpdatedAt
  const promptAt = NOW() - 60_000
  const rec = (type, content, ts) => ({ type, timestamp: new Date(ts).toISOString(), message: { role: type, content } })
  h.write(s)
  h.writeTranscript(s.cwd, s.sessionId, [
    rec('user', 'fix the tests', promptAt),
    rec('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }], NOW() - 40_000),
    rec('user', [{ type: 'tool_result', content: 'ok' }], NOW() - 35_000),
    rec('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.mjs' } }], NOW() - 30_000),
    { type: 'attachment', timestamp: new Date(NOW()).toISOString() },
  ])
  await h.tick()
  assert.equal(posts(h.calls).length, 1, 'mid-turn is busy: a card goes up')
  let body = posts(h.calls)[0].body
  assert.equal(body.template, 'progress')
  assert.equal(body.line, 'reading b.mjs')
  assert.equal(body.startedAt, promptAt, 'the timer counts from the prompt, not the last tool call')
  const doneAt = NOW() - 5_000
  h.writeTranscript(s.cwd, s.sessionId, [
    rec('user', 'fix the tests', promptAt),
    rec('assistant', [{ type: 'text', text: 'Done. Should I also push?' }], doneAt),
    { type: 'system', timestamp: new Date(NOW()).toISOString() },
  ])
  await h.tick()
  body = posts(h.calls)[1].body
  assert.equal(body.template, 'needs_you')
  assert.equal(body.line, 'Should I also push?')
  assert.equal(body.startedAt, doneAt)
  assert.equal(ends(h.calls).length, 0)
})

// A session parked on a /loop. ScheduleWakeup's tool_result is the newest entry.
const loopTranscript = (promptAt, scheduledAt, delaySeconds, reason, extra = []) => {
  const rec = (type, content, ts) => ({ type, timestamp: new Date(ts).toISOString(), message: { role: type, content } })
  return [
    rec('user', 'watch the deploy', promptAt),
    rec('assistant', [{ type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds, reason, prompt: 'watch the deploy', noop: true } }], scheduledAt),
    rec('user', [{ type: 'tool_result', content: 'scheduled' }], scheduledAt + 1000),
    { type: 'system', timestamp: new Date(scheduledAt + 1500).toISOString() },
    ...extra.map(([type, content, ts]) => rec(type, content, ts)),
  ]
}

test('poller: a session parked on a /loop shows a countdown to its wake, not your turn', async (t) => {
  const h = harness(t)
  const s = sess({ status: 'idle', statusUpdatedAt: NOW() - 120_000 })
  h.write(s)
  const scheduledAt = NOW() - 100_000
  h.writeTranscript(s.cwd, s.sessionId, loopTranscript(NOW() - 200_000, scheduledAt, 600, 'watching the CI run'))
  await h.tick()
  const body = posts(h.calls)[0].body
  assert.equal(body.template, 'countdown')
  assert.equal(body.tone, 'neutral')
  assert.equal(body.line, 'watching the CI run')
  assert.equal(body.startedAt, scheduledAt)
  assert.equal(body.deadline, scheduledAt + 600_000)
})

test('poller: a wake that is overdue past WAKE_GRACE_MS, a stop, or a later prompt is your turn again', async (t) => {
  for (const [label, transcript] of [
    ['overdue', loopTranscript(NOW() - 900_000, NOW() - 800_000, 60, 'x')],
    ['stopped', (() => { const tr = loopTranscript(NOW() - 200_000, NOW() - 100_000, 600, 'x'); tr[1].message.content[0].input = { stop: true }; return tr })()],
    ['prompt after', loopTranscript(NOW() - 200_000, NOW() - 100_000, 600, 'x', [['user', 'stop looping', NOW() - 50_000], ['assistant', [{ type: 'text', text: 'Stopped. What next?' }], NOW() - 40_000]])],
  ]) {
    const h = harness(t)
    const s = sess({ status: 'idle', statusUpdatedAt: NOW() - 120_000 })
    h.write(s)
    h.writeTranscript(s.cwd, s.sessionId, transcript)
    await h.tick()
    assert.equal(posts(h.calls)[0].body.template, 'needs_you', label)
  }
})

test('inferredStatus: a turn that ends on ScheduleWakeup is idle, not mid-turn', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledge-wake-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'x.jsonl')
  const scheduledAt = NOW() - 100_000
  fs.writeFileSync(file, loopTranscript(NOW() - 200_000, scheduledAt, 600, 'x').map((r) => JSON.stringify(r)).join('\n') + '\n')
  assert.deepEqual(inferredStatus(file), { status: 'idle', statusUpdatedAt: scheduledAt + 1000 })
})

test('selectCards: a parked loop ranks with the working sessions, not ahead of them', () => {
  const mk = (name, status, ago, wake) => ({ ...sess({ name, status, statusUpdatedAt: NOW() - ago }), ...(wake ? { wake } : {}) })
  const cards = new Map([['cc-loop', {}], ['cc-work', {}], ['cc-ask', {}]])
  const { want } = selectCards(
    [mk('loop', 'idle', 10_000, { at: NOW(), wakeAt: NOW() + 60_000, reason: '' }), mk('work', 'busy', 500_000), mk('ask', 'idle', 20_000)],
    cards,
    { minBusyMs: 8000, maxCards: 2, alive: () => true },
  )
  assert.deepEqual([...want.keys()], ['cc-ask', 'cc-work'])
})

test('poller: idle -> busy transitions back to progress, still no end', async (t) => {
  const h = harness(t)
  h.write(sess())
  await h.tick()
  h.write(sess({ status: 'idle', statusUpdatedAt: NOW() }))
  await h.tick()
  // Back to busy just now: under minBusyMs, but the card already exists.
  h.write(sess({ status: 'busy', statusUpdatedAt: NOW() }))
  await h.tick()
  assert.equal(ends(h.calls).length, 0)
  const body = posts(h.calls)[2].body
  assert.equal(body.template, 'progress')
  assert.equal(body.tone, 'neutral')
  assert.equal(body.line, '~/code/career-ops')
})

test('poller: busy -> idle -> busy -> idle never ends (the flapping regression)', async (t) => {
  const h = harness(t)
  h.write(sess())
  await h.tick()
  for (const status of ['idle', 'busy', 'idle']) {
    h.write(sess({ status, statusUpdatedAt: NOW() }))
    await h.tick()
    assert.equal(ends(h.calls).length, 0)
  }
  assert.equal(posts(h.calls).length, 4)
  assert.ok(posts(h.calls).every((c) => c.body.lane === 'cc-chief-b7'))
})

test('poller: shell status is a quiet neutral card, not an orange one', async (t) => {
  // Owner decision 2026-08-29: a shell session is him poking around, not Claude
  // waiting on him. Orange must keep meaning "something wants your attention".
  const h = harness(t)
  h.write(sess())
  await h.tick()
  h.write(sess({ status: 'shell', statusUpdatedAt: NOW() }))
  await h.tick()
  assert.equal(ends(h.calls).length, 0, 'still no end: the session is alive')
  const card = posts(h.calls)[1].body
  assert.equal(card.template, 'progress')
  assert.equal(card.tone, 'neutral')
})

test('poller: the card ends only when the pid dies', async (t) => {
  let dead = false
  const h = harness(t, {}, { alive: () => !dead })
  h.write(sess())
  await h.tick()
  h.write(sess({ status: 'idle', statusUpdatedAt: NOW() }))
  await h.tick()
  assert.equal(ends(h.calls).length, 0)
  dead = true
  await h.tick()
  assert.equal(ends(h.calls).length, 1)
  assert.deepEqual(ends(h.calls)[0].body, { lane: 'cc-chief-b7' })
})

test('poller: a vanished session file with a live pid holds the card, no end', async (t) => {
  const h = harness(t)
  const s = sess()
  h.write(s)
  await h.tick()
  fs.rmSync(path.join(h.dir, `${s.pid}.json`)) // half-written / momentarily unreadable
  await h.tick()
  assert.equal(ends(h.calls).length, 0)
})

test('poller: title comes from the first real user prompt, word-boundary truncated', async (t) => {
  const h = harness(t)
  const s = sess()
  h.writeTranscript(s.cwd, s.sessionId, [
    { type: 'summary', summary: 'not a user line' },
    user('<command-name>/model</command-name>'), // command wrapper: skipped
    user('<local-command-stdout>out</local-command-stdout>'), // skipped
    user([{ type: 'tool_result', content: 'not a prompt' }]), // no text blocks: skipped
    user('  Fix   the flapping session cards on my phone.  '),
  ])
  h.write(s)
  await h.tick()
  assert.equal(posts(h.calls)[0].body.title, 'Fix the flapping session cards')
})

test('poller: missing transcript falls back name -> cwd basename -> pid', async (t) => {
  const h = harness(t)
  const p = h.projectsDir
  assert.equal(titleFor(sess(), new Map(), p), 'chief-b7')
  assert.equal(titleFor(sess({ name: undefined }), new Map(), p), 'career-ops')
  assert.equal(titleFor(sess({ name: undefined, cwd: undefined, pid: 4242 }), new Map(), p), '4242')
})

test('poller: the title cache does not re-read the transcript on a second tick', async (t) => {
  const h = harness(t)
  const s = sess()
  const file = h.writeTranscript(s.cwd, s.sessionId, [user('the original prompt')])
  h.write(s)
  await h.tick()
  fs.rmSync(file) // a re-read now could only produce a fallback title
  h.write(sess({ status: 'idle', statusUpdatedAt: NOW() })) // force a repost
  await h.tick()
  assert.equal(posts(h.calls).length, 2)
  assert.equal(posts(h.calls)[1].body.title, 'the original prompt')
})

test('titleTrim: collapses whitespace, cuts at a word, strips trailing punctuation', () => {
  assert.equal(titleTrim('short one'), 'short one')
  assert.equal(titleTrim('ends with a question mark?'), 'ends with a question mark')
  assert.equal(titleTrim('Fix the flapping session cards on my phone'), 'Fix the flapping session cards')
  // No boundary to cut at, so it hard-cuts and marks the elision rather than
  // silently dropping characters.
  assert.equal(titleTrim('x'.repeat(50)), 'x'.repeat(31) + '\u2026')
  assert.ok(titleTrim('word '.repeat(20)).length <= 32)
})

test('poller: a malformed file does not prevent other sessions from being seen', async (t) => {
  const h = harness(t)
  fs.writeFileSync(path.join(h.dir, '999.json'), '{"pid":999,"status":"bu') // truncated mid-write
  h.write(sess())
  await h.tick()
  assert.equal(posts(h.calls).length, 1)
  assert.equal(posts(h.calls)[0].body.lane, 'cc-chief-b7')
})

test('poller: missing bridgeSessionId yields a card with no url', async (t) => {
  const h = harness(t)
  h.write(sess({ bridgeSessionId: undefined }))
  await h.tick()
  assert.equal(posts(h.calls).length, 1)
  assert.ok(!('url' in posts(h.calls)[0].body))
})

test('poller: maxCards keeps the longest-busy sessions', async (t) => {
  const h = harness(t, { maxCards: 2 })
  h.write(sess({ name: 'young', statusUpdatedAt: NOW() - 20_000 }), '2001.json')
  h.write(sess({ name: 'oldest', statusUpdatedAt: NOW() - 300_000 }), '2002.json')
  h.write(sess({ name: 'older', statusUpdatedAt: NOW() - 100_000 }), '2003.json')
  await h.tick()
  const lanes = posts(h.calls).map((c) => c.body.lane).sort()
  assert.deepEqual(lanes, ['cc-older', 'cc-oldest'])
})

test('poller: over the cap, a WAITING session beats WORKING ones', async (t) => {
  const h = harness(t, { maxCards: 2 })
  h.write(sess({ name: 'aa', statusUpdatedAt: NOW() - 300_000 }), '3001.json')
  h.write(sess({ name: 'bb', statusUpdatedAt: NOW() - 100_000 }), '3002.json')
  await h.tick() // cards up: aa, bb
  // aa flips to waiting (newest statusUpdatedAt of the three)...
  h.write(sess({ name: 'aa', status: 'idle', statusUpdatedAt: NOW() }), '3001.json')
  // ...and cc arrives, busy longer than bb. By busy-time alone, cc+bb would win.
  h.write(sess({ name: 'cc', statusUpdatedAt: NOW() - 200_000 }), '3003.json')
  await h.tick()
  const last = posts(h.calls).slice(2).map((c) => [c.body.lane, c.body.template])
  assert.deepEqual(last.sort(), [
    ['cc-aa', 'needs_you'], // the session that wants him keeps its slot
    ['cc-cc', 'progress'],
  ])
  assert.deepEqual(ends(h.calls).map((c) => c.body.lane), ['cc-bb']) // evicted by the cap
})

test('selectCards: waiting first, then longest in state, capped', () => {
  const mk = (name, status, ago) => sess({ name, status, statusUpdatedAt: NOW() - ago })
  const cards = new Map([['cc-w', {}], ['cc-a', {}], ['cc-b', {}]])
  const { want } = selectCards(
    [mk('w', 'idle', 10_000), mk('a', 'busy', 500_000), mk('b', 'busy', 400_000)],
    cards,
    { minBusyMs: 8000, maxCards: 2, alive: () => true },
  )
  assert.deepEqual([...want.keys()], ['cc-w', 'cc-a'])
})

test('selectCards: a session idle past WAITING_FRESH_MS ranks below a working one', () => {
  const mk = (name, status, ago) => sess({ name, status, statusUpdatedAt: NOW() - ago })
  const cards = new Map([['cc-stale', {}], ['cc-fresh', {}], ['cc-work', {}]])
  const { want } = selectCards(
    [mk('stale', 'idle', WAITING_FRESH_MS + 60_000), mk('work', 'busy', 100_000), mk('fresh', 'idle', 60_000)],
    cards,
    { minBusyMs: 8000, maxCards: 2, alive: () => true },
  )
  assert.deepEqual([...want.keys()], ['cc-fresh', 'cc-work'])
})

test('inferredStatus: a turn longer than the tail window is still busy, and its start is pinned', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledge-infer-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'x.jsonl')
  const rec = (type, content, ts) => JSON.stringify({ type, timestamp: new Date(ts).toISOString(), message: { role: type, content } })
  const big = 'x'.repeat(TRANSCRIPT_HEAD_BYTES) // one line wider than the window pushes the prompt out of it
  const t0 = NOW() - 600_000
  const lines = [rec('user', 'go', t0), JSON.stringify({ type: 'attachment', big }),
    rec('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'a' } }], t0 + 100_000)]
  fs.writeFileSync(file, lines.join('\n') + '\n')
  const cache = new Map()
  const r1 = inferredStatus(file, cache)
  assert.deepEqual(r1, { status: 'busy', statusUpdatedAt: t0 + 100_000 }, 'oldest visible entry stands in for the start')
  // The turn continues: a newer tool call, the window slides, the start must not move later.
  fs.appendFileSync(file, rec('user', [{ type: 'tool_result', content: 'ok' }], t0 + 200_000) + '\n')
  const fake = { cwd: '/c', sessionId: 'x' }
  const proj = path.join(dir, 'p')
  fs.mkdirSync(path.join(proj, '-c'), { recursive: true })
  fs.copyFileSync(file, path.join(proj, '-c', 'x.jsonl'))
  const pinCache = new Map()
  const a = withInferredStatus(fake, pinCache, proj)
  fs.appendFileSync(path.join(proj, '-c', 'x.jsonl'), rec('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: '/q' } }], t0 + 300_000) + '\n')
  const b = withInferredStatus(fake, pinCache, proj)
  assert.equal(a.status, 'busy')
  assert.equal(b.status, 'busy')
  assert.equal(b.statusUpdatedAt, a.statusUpdatedAt, 'pinned: the start does not creep as the window slides')
  fs.appendFileSync(path.join(proj, '-c', 'x.jsonl'), rec('assistant', [{ type: 'text', text: 'done' }], t0 + 400_000) + '\n')
  const c = withInferredStatus(fake, pinCache, proj)
  assert.deepEqual([c.status, c.statusUpdatedAt], ['idle', t0 + 400_000], 'idle reads the closing text and clears the pin')
})

test('poller: missing directory disables it with one log line, no throw', (t) => {
  const logs = []
  const stop = startSessionPoller({
    post: async () => ({ status: 200, body: '' }),
    dir: path.join(os.tmpdir(), 'ledge-sessions-does-not-exist'),
    log: (l) => logs.push(l),
  })
  t.after(stop)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /not found; poller disabled/)
})

test('poller: name fallback goes name -> cwd basename -> pid', () => {
  assert.equal(laneFor({ name: 'Chief B7!', pid: 1 }), 'cc-chief-b7')
  assert.equal(laneFor({ cwd: '/Users/x/My Proj', pid: 1 }), 'cc-my-proj')
  assert.equal(laneFor({ pid: 4242 }), 'cc-4242')
  assert.equal(laneFor({ name: 'x'.repeat(60), pid: 1 }).length, 24)
})

test('poller: line is ~-relative and truncates from the left', () => {
  const home = '/Users/abhay'
  assert.equal(lineFor('/Users/abhay/code/career-ops', 60, home), '~/code/career-ops')
  assert.equal(lineFor('/Users/abhay', 60, home), '~')
  const long = lineFor('/Users/abhay/code/career-ops/prep/phd-uw-madison', 24, home)
  assert.ok(long.startsWith('…/'), long)
  assert.ok(long.endsWith('/phd-uw-madison'), long)
  assert.ok(long.length <= 24, long)
})

test('poller: defaults are the documented ones', () => {
  assert.deepEqual(DEFAULTS, { enabled: true, pollMs: 3000, minBusyMs: 8000, maxCards: 4, stuckAfterMs: 600000, summariseTitles: true, titleRefreshMs: 1200000 })
})

test('titleTrim: a path-first prompt does not collapse to its first word', () => {
  // Shipped defect: "Read ~/Desktop/.../HANDOFF.md and continue" has its only space
  // at index 4, so a pure word-boundary cut titled the card "Read".
  const t = titleTrim('Read ~/Desktop/Playground/memecoin-edge/HANDOFF.md and continue')
  assert.equal(t, 'Read memecoin-edge and continue')
  assert.ok(!t.endsWith('…'), 'substituting the path removes the need to elide')
})

test('titleTrim: still prefers a word boundary when one is close enough', () => {
  const t = titleTrim('someone gave bots free reign on my iPhone lock screen')
  assert.equal(t, 'someone gave bots free reign on')
  assert.ok(!t.endsWith('…'), 'a clean boundary cut needs no ellipsis')
})

test('titleTrim: a path is replaced by its distinctive folder, in place', () => {
  // Shipped defect: the card read "~/Desktop/Playground/memecoi…", which identifies
  // nothing. The folder is the useful part; the prose around it must survive.
  assert.equal(titleTrim('~/Desktop/Playground/memecoin-edge/PROMPT-hunt2.md.'), 'memecoin-edge')
  assert.equal(
    titleTrim('Read ~/Desktop/Playground/memecoin-edge/HANDOFF.md and continue'),
    'Read memecoin-edge and continue',
  )
  assert.equal(
    titleTrim('fix the auth bug in ~/code/career-ops/src/login.ts before the demo tomorrow'),
    'fix the auth bug in career-ops',
  )
})

test('pathLabel: skips generic containers and filenames', () => {
  assert.equal(pathLabel('~/Desktop/Playground/memecoin-edge/HANDOFF.md'), 'memecoin-edge')
  assert.equal(pathLabel('/Users/x/Desktop'), '')      // nothing distinctive
  assert.equal(pathLabel('no path here'), '')
})

// --- currentActivity -------------------------------------------------------

const tu = (name, input = {}) => ({ type: 'tool_use', id: 'tu_1', name, input })
const asst = (content) => ({ type: 'assistant', message: { role: 'assistant', content } })

/** A transcript on disk made of JSONL records; returns its path. */
function transcript(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledge-activity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'x.jsonl')
  fs.writeFileSync(file, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n')
  return file
}

test('toolPhrase: each tool maps to human phrasing, not a tool name dump', () => {
  assert.equal(toolPhrase(tu('Bash', { description: 'Run the test suite' })), 'running Run the test suite')
  assert.equal(toolPhrase(tu('Bash', { command: 'npm test -- --grep poller' })), 'running npm test -- --grep poller')
  assert.equal(toolPhrase(tu('Read', { file_path: '/a/b/sessions.mjs' })), 'reading sessions.mjs')
  assert.equal(toolPhrase(tu('Edit', { file_path: '/a/b/server.mjs' })), 'editing server.mjs')
  assert.equal(toolPhrase(tu('Write', { file_path: '/a/b/new.mjs' })), 'editing new.mjs')
  assert.equal(toolPhrase(tu('NotebookEdit', { file_path: '/a/nb.ipynb' })), 'editing nb.ipynb')
  assert.equal(toolPhrase(tu('Grep', { pattern: 'LINE_MAX' })), 'searching for LINE_MAX')
  assert.equal(toolPhrase(tu('Glob', { pattern: '**/*.mjs' })), 'searching **/*.mjs')
  assert.equal(toolPhrase(tu('WebSearch', { query: 'anything' })), 'searching the web')
  assert.equal(toolPhrase(tu('WebFetch', { url: 'https://api.example.com/v1/x' })), 'fetching api.example.com')
  assert.equal(toolPhrase(tu('Task', { description: 'Audit the hooks' })), 'delegating Audit the hooks')
  assert.equal(toolPhrase(tu('Agent', { description: 'Scout the idea' })), 'delegating Scout the idea')
  assert.equal(toolPhrase(tu('TodoWrite', { todos: [] })), 'planning')
  assert.equal(toolPhrase(tu('SomeMcpTool', {})), 'somemcptool')
})

test('toolPhrase: collapses whitespace, strips a trailing period, fits LINE_MAX at a word', () => {
  assert.equal(toolPhrase(tu('Bash', { description: '  Extract   current activity.  ' })), 'running Extract current activity')
  const long = toolPhrase(tu('Bash', { description: 'word '.repeat(30) }))
  assert.ok(long.length <= 60, long)
  assert.ok(long.endsWith('…'), long)
  assert.ok(!long.includes('wor…'), 'cut lands on a word boundary: ' + long)
  // A Bash command is cut to ~40 chars before phrasing.
  const cmd = toolPhrase(tu('Bash', { command: 'x'.repeat(200) }))
  assert.ok(cmd.length <= 'running '.length + 41, cmd)
})

test('currentActivity: the newest tool_use wins, not the first', (t) => {
  const file = transcript(t, [
    asst([tu('Read', { file_path: '/a/old.mjs' })]),
    asst([{ type: 'text', text: 'thinking' }]),
    asst([tu('Bash', { description: 'Deploy the fix' })]),
    user([{ type: 'tool_result', content: 'ok' }]), // newer, but not a tool_use
  ])
  assert.equal(currentActivity(file), 'running Deploy the fix')
})

test('currentActivity: the last tool_use within a single entry wins', (t) => {
  const file = transcript(t, [
    asst([tu('Read', { file_path: '/a/first.mjs' }), { type: 'text', text: 'x' }, tu('Edit', { file_path: '/a/last.mjs' })]),
  ])
  assert.equal(currentActivity(file), 'editing last.mjs')
})

test('currentActivity: a file larger than the window drops the partial first line and still parses', (t) => {
  // One 300KB line (a giant tool result) followed by a small tool_use entry. The
  // 256KB window opens mid-giant-line; that partial must be discarded, not parsed.
  const file = transcript(t, ['x'.repeat(300 * 1024), asst([tu('Grep', { pattern: 'needle' })])])
  assert.ok(fs.statSync(file).size > 256 * 1024)
  assert.equal(currentActivity(file), 'searching for needle')
})

test('currentActivity: no tool_use anywhere returns ""', (t) => {
  const file = transcript(t, [user('just a prompt'), asst([{ type: 'text', text: 'just prose' }])])
  assert.equal(currentActivity(file), '')
})

test('currentActivity: a malformed or missing file returns "" without throwing', (t) => {
  assert.equal(currentActivity(path.join(os.tmpdir(), 'ledge-activity-does-not-exist.jsonl')), '')
  assert.equal(currentActivity(transcript(t, ['not json at all', '{"half": '])), '')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledge-activity-dir-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(currentActivity(dir), '') // a directory, not a file
})

test('currentActivity: unchanged mtime+size is served from cache, a change re-reads', (t) => {
  const file = transcript(t, [asst([tu('Read', { file_path: '/a/real.mjs' })])])
  const st = fs.statSync(file)
  const cache = new Map()
  // Prime the cache with a sentinel under the file's true mtime+size: a hit
  // proves the file was not re-read.
  cache.set(file, { key: `${st.mtimeMs}:${st.size}`, value: 'sentinel' })
  assert.equal(currentActivity(file, cache), 'sentinel')
  // Growing the file invalidates the key and forces a real read.
  fs.appendFileSync(file, JSON.stringify(asst([tu('Bash', { description: 'Ship it' })])) + '\n')
  assert.equal(currentActivity(file, cache), 'running Ship it')
  assert.equal(currentActivity(file, cache), 'running Ship it') // now cached for real
})

test('poller: a WORKING card leads with the current activity, WAITING still says your turn', async (t) => {
  const h = harness(t)
  const s = sess()
  const file = h.writeTranscript(s.cwd, s.sessionId, [
    user('build the thing'),
    asst([tu('Bash', { description: 'Extract current activity per live session' })]),
  ])
  h.write(s)
  await h.tick()
  assert.equal(posts(h.calls)[0].body.line, 'running Extract current activity per live session')
  fs.rmSync(file) // waiting must not depend on the transcript at all
  h.write(sess({ status: 'idle', statusUpdatedAt: NOW() }))
  await h.tick()
  assert.equal(posts(h.calls)[1].body.line, 'your turn')
})

test('poller: a WORKING card with no tool_use in the transcript falls back to the cwd line', async (t) => {
  const h = harness(t)
  const s = sess()
  h.writeTranscript(s.cwd, s.sessionId, [user('build the thing'), asst([{ type: 'text', text: 'ok' }])])
  h.write(s)
  await h.tick()
  assert.equal(posts(h.calls)[0].body.line, '~/code/career-ops')
})

test('toolPhrase: a raw regex degrades to a plain phrase, not lock screen line noise', () => {
  assert.equal(toolPhrase({ name: 'Grep', input: { pattern: '^\\s*export function' } }), 'searching the code')
  assert.equal(toolPhrase({ name: 'Grep', input: { pattern: 'bridgeSessionId' } }), 'searching for bridgeSessionId')
  assert.equal(toolPhrase({ name: 'Grep', input: { pattern: '' } }), 'searching the code')
})

test('toolPhrase: an MCP tool says who and what, not its raw symbol', () => {
  assert.equal(toolPhrase({ name: 'mcp__blender__get_scene_info' }), 'blender: get scene info')
  assert.equal(toolPhrase({ name: 'mcp__claude_ai_Gmail__send_message' }), 'claude ai gmail: send message')
  assert.equal(toolPhrase({ name: 'SomeOtherTool' }), 'someothertool')
})

test('poller: adopts cards left by a previous run instead of orphaning them', async (t) => {
  // A server restart used to strand every WAITING card: creation requires
  // busy-past-minBusyMs, so an idle session's card was never touched again and sat
  // on the lock screen with a stale title and a stale link.
  const h = harness(t, {}, { existingLanes: ['cc-demo', 'not-a-session-lane'] })
  h.write(sess({ name: 'demo', status: 'idle', statusUpdatedAt: Date.now() - 60_000 }))
  await h.tick()
  const sent = posts(h.calls)
  assert.equal(sent.length, 1, 'the adopted card should be refreshed, not ignored')
  assert.equal(sent[0].body.lane, 'cc-demo')
  assert.equal(sent[0].body.template, 'needs_you', 'an idle adopted session is WAITING')
  assert.equal(ends(h.calls).length, 0, 'adopting must not end it')
})

test('poller: an adopted lane whose session is gone gets ended, not kept alive', async (t) => {
  // The sentinel pid must be null. process.kill(0, 0) signals the process group and
  // reports alive, which would keep a dead card up forever.
  const h = harness(t, {}, { existingLanes: ['cc-ghost'] })
  await h.tick()
  assert.equal(ends(h.calls).map((e) => e.body.lane).includes('cc-ghost'), true)
})

// --- lastQuestion ----------------------------------------------------------

const txt = (text) => asst([{ type: 'text', text }])

test('lastQuestion: extracts the question from the newest assistant text', (t) => {
  const file = transcript(t, [
    user('build the poller'),
    txt('Poller is wired up. Should I run the full test suite now?'),
  ])
  assert.equal(lastQuestion(file), 'Should I run the full test suite now?')
})

test('lastQuestion: skips assistant entries with no text block', (t) => {
  // The newest entry is a bare tool_use; the question lives one entry back.
  const file = transcript(t, [
    txt('Want me to also fix the flaky test?'),
    asst([tu('Bash', { description: 'Run tests' })]),
  ])
  assert.equal(lastQuestion(file), 'Want me to also fix the flaky test?')
})

test('lastQuestion: strips fenced code, backticks, bold, and links', (t) => {
  const file = transcript(t, [
    txt('Here is the diff:\n```js\nis this code a question?\n```\nShould I **ship** `fmtMins` to [prod](https://example.com)?'),
  ])
  assert.equal(lastQuestion(file), 'Should I ship fmtMins to prod?')
})

test('lastQuestion: the LAST question in the message wins', (t) => {
  const file = transcript(t, [
    txt('Want me to commit? Or should I hold off for review?'),
  ])
  assert.equal(lastQuestion(file), 'Or should I hold off for review?')
})

test('lastQuestion: no question means "", not a guessed statement', (t) => {
  const file = transcript(t, [txt('All tests pass and the build is green.')])
  assert.equal(lastQuestion(file), '')
})

test('lastQuestion: a question longer than LINE_MAX is rejected whole, never truncated', (t) => {
  const q = 'Should I also update the config, the readme, and the two other files?'
  assert.ok(q.length > 60)
  assert.equal(lastQuestion(transcript(t, [txt(`Done. ${q}`)])), '')
})

test('lastQuestion: a one-word question is noise', (t) => {
  assert.equal(lastQuestion(transcript(t, [txt('Thoughts?')])), '')
})

test('lastQuestion: missing or malformed transcript returns "" without throwing', (t) => {
  assert.equal(lastQuestion(path.join(os.tmpdir(), 'ledge-question-does-not-exist.jsonl')), '')
  assert.equal(lastQuestion(transcript(t, ['not json at all', '{"half": '])), '')
})

test('stripMd: bullets, headings, and numbered lists unwrap', () => {
  assert.equal(stripMd('## Plan\n- do a\n2. do b\n'), 'Plan\ndo a\ndo b\n')
})

test('poller: a WAITING card shows the question Claude asked', async (t) => {
  const h = harness(t)
  const s = sess()
  h.write(s)
  await h.tick()
  h.writeTranscript(s.cwd, s.sessionId, [
    user('build it'),
    txt('Done with the poller. Should I wire the tests next?'),
  ])
  h.write(sess({ status: 'idle', statusUpdatedAt: NOW() }))
  await h.tick()
  const body = posts(h.calls)[1].body
  assert.equal(body.template, 'needs_you')
  assert.equal(body.tone, 'warn')
  assert.equal(body.line, 'Should I wire the tests next?')
})

test('poller: a WAITING card with no question in the transcript says your turn', async (t) => {
  const h = harness(t)
  const s = sess()
  h.writeTranscript(s.cwd, s.sessionId, [user('build it'), txt('Done. Everything passes.')])
  h.write(s)
  await h.tick()
  h.write(sess({ status: 'idle', statusUpdatedAt: NOW() }))
  await h.tick()
  assert.equal(posts(h.calls)[1].body.line, 'your turn')
})

// --- stuck detection -------------------------------------------------------

test('poller: a WORKING session silent past stuckAfterMs warns, still progress', async (t) => {
  const h = harness(t)
  const s = sess()
  const file = h.writeTranscript(s.cwd, s.sessionId, [asst([tu('Bash', { description: 'Deploy' })])])
  const old = new Date(Date.now() - 11 * 60_000)
  fs.utimesSync(file, old, old)
  h.write(s)
  await h.tick()
  const body = posts(h.calls)[0].body
  assert.equal(body.template, 'progress', 'stuck is not needs_you; that state means Claude asked')
  assert.equal(body.tone, 'warn')
  assert.equal(body.line, 'no output for 11m')
})

test('poller: a WORKING session under the threshold is untouched', async (t) => {
  const h = harness(t)
  const s = sess()
  h.writeTranscript(s.cwd, s.sessionId, [asst([tu('Bash', { description: 'Deploy' })])])
  h.write(s)
  await h.tick()
  const body = posts(h.calls)[0].body
  assert.equal(body.tone, 'neutral')
  assert.equal(body.line, 'running Deploy')
})

test('poller: a missing transcript never marks a session stuck', async (t) => {
  const h = harness(t)
  h.write(sess({ statusUpdatedAt: NOW() - 3600_000 })) // busy an hour, no transcript at all
  await h.tick()
  const body = posts(h.calls)[0].body
  assert.equal(body.tone, 'neutral')
  assert.equal(body.line, '~/code/career-ops')
})

test('poller: a transcript that vanishes clears the stuck flag, no stale mtime', async (t) => {
  const h = harness(t)
  const s = sess()
  const file = h.writeTranscript(s.cwd, s.sessionId, [asst([tu('Bash', { description: 'Deploy' })])])
  const old = new Date(Date.now() - 20 * 60_000)
  fs.utimesSync(file, old, old)
  h.write(s)
  await h.tick()
  assert.equal(posts(h.calls)[0].body.tone, 'warn')
  fs.rmSync(file)
  await h.tick()
  const body = posts(h.calls)[1].body
  assert.equal(body.tone, 'neutral', 'no file means no evidence, not stuck')
  assert.equal(body.line, '~/code/career-ops')
})

test('fmtMins: whole minutes, hours past sixty', () => {
  assert.equal(fmtMins(600000), '10m')
  assert.equal(fmtMins(59 * 60_000), '59m')
  assert.equal(fmtMins(65 * 60_000), '1h 5m')
})

test('lastQuestion: a "?" inside a markdown table is not a question', (t) => {
  const file = transcript(t, [txt('| part | note |\n|---|---|\n| rim (loud ?) | check |\nDone with the table.')])
  assert.equal(lastQuestion(file), '')
  // ...but a real question after a table still wins.
  const file2 = transcript(t, [txt('| rim (loud ?) | check |\nShould I order the rim?')])
  assert.equal(lastQuestion(file2), 'Should I order the rim?')
})

test('lastQuestion: a quoted question is Claude drafting, not asking', (t) => {
  const file = transcript(t, [txt('Suggested reply: "Can I send you my resume today?"')])
  assert.equal(lastQuestion(file), '')
})

// --- lane collisions and refusal recovery ----------------------------------

test('selectCards: two sessions sharing a name each get a stable lane', async (t) => {
  // Lane assignment used to follow readdirSync order, so two sessions with the
  // same name could swap ownership between ticks and flap the card's pid, title
  // and deep link. Order is now pid-sorted and the loser gets its own suffix.
  const h = harness(t, {}, { alive: () => true })
  const now = Date.now() - 60_000
  h.write(sess({ pid: 40001, sessionId: 'a', name: 'chief', status: 'busy', statusUpdatedAt: now }))
  h.write(sess({ pid: 40002, sessionId: 'b', name: 'chief', status: 'busy', statusUpdatedAt: now }))
  await h.tick()
  const lanes = posts(h.calls).map((p) => p.body.lane).sort()
  assert.equal(lanes.length, 2, 'both sessions should be carded, not one dropped')
  assert.equal(new Set(lanes).size, 2, 'their lanes must be distinct')
  assert.ok(lanes.every((l) => /^cc-chief/.test(l)))
})

test('poller: forgetExcept() makes the next tick repost every card not on the phone', async (t) => {
  const h = harness(t)
  h.write(sess())
  await h.tick()
  await h.tick()
  const posts = () => h.calls.filter((c) => c.pathname === '/activity')
  assert.equal(posts().length, 1, 'identical content is not reposted')
  h.stop.forgetExcept([posts()[0].body.lane])
  await h.tick()
  assert.equal(posts().length, 1, 'a lane the phone still shows is left alone')
  h.stop.forgetExcept([])
  await h.tick()
  assert.equal(posts().length, 2, 'the forgotten lane is reposted exactly once')
  await h.tick()
  assert.equal(posts().length, 2)
})

test('poller: a lane refused for a bad body retries once the body changes', async (t) => {
  // `refused` used to hold the lane forever while it stayed wanted, so a card
  // suppressed by one bad payload never came back for the session's lifetime.
  let reject = true
  const h = harness(t, {}, {
    post: async (pathname, body) => {
      h.calls.push({ pathname, body })
      return reject ? { status: 400, body: 'nope' } : { status: 200, body: '' }
    },
  })
  h.write(sess({ name: 'demo', status: 'busy', statusUpdatedAt: Date.now() - 60_000 }))
  await h.tick()
  assert.equal(posts(h.calls).length, 1, 'first attempt is made')
  await h.tick()
  assert.equal(posts(h.calls).length, 1, 'an identical body is not re-sent')
  reject = false
  h.write(sess({ name: 'demo', status: 'busy', statusUpdatedAt: Date.now() - 120_000 }))
  await h.tick()
  assert.equal(posts(h.calls).length, 2, 'a changed body gets a fresh attempt')
})

// --- summarised titles -----------------------------------------------------
// The CLI runner is always injected here; nothing in this file spawns claude.

const settle = () => new Promise((r) => setImmediate(r))

test('summariseTitle: truncates the context to 600 chars and accepts a clean answer', async () => {
  let got
  const run = async (instruction) => ((got = instruction), '  Lock screen agent \n')
  assert.equal(await summariseTitle('x'.repeat(700), run), 'Lock screen agent')
  assert.ok(got.includes('x'.repeat(600)) && !got.includes('x'.repeat(601)))
  assert.ok(got.includes('currently working on'), 'the instruction asks about the present, not the start')
})

test('summariseTitle: refusal, empty, multi-line, quoted, long, or error all yield null', async () => {
  const of = (out) => summariseTitle('p', async () => out)
  assert.equal(await of('I cannot produce a title for this request'), null) // >5 words
  assert.equal(await of(''), null)
  assert.equal(await of('   \n  '), null)
  assert.equal(await of('Lock screen\nagent webhook'), null)
  assert.equal(await of('"Lock screen agent"'), null)
  assert.equal(await of('Webhook'), null) // one word
  assert.equal(await of('Extraordinarily Comprehensive Refactoring'), null) // 32+ chars
  assert.equal(await summariseTitle('p', async () => { throw new Error('timeout') }), null)
})

test('poller: a good summarised title replaces the trimmed prompt on the next tick', async (t) => {
  const h = harness(t, {}, { titleRun: async () => 'Flapping card fix' })
  const s = sess()
  h.writeTranscript(s.cwd, s.sessionId, [user('Fix the flapping session cards on my phone please')])
  h.write(s)
  await h.tick()
  assert.equal(posts(h.calls)[0].body.title, 'Fix the flapping session cards')
  await settle()
  await h.tick()
  assert.equal(posts(h.calls)[1].body.title, 'Flapping card fix')
})

test('poller: a rejected answer keeps the fallback permanently, one CLI call ever', async (t) => {
  for (const bad of ['I cannot help with that request', '', 'two\nlines here', 'x'.repeat(40)]) {
    const runs = []
    const h = harness(t, {}, { titleRun: async (i) => (runs.push(i), bad) })
    const s = sess()
    h.writeTranscript(s.cwd, s.sessionId, [user('Fix the flapping session cards on my phone please')])
    h.write(s)
    await h.tick()
    await settle()
    h.write(sess({ status: 'idle', statusUpdatedAt: NOW() })) // force a repost
    await h.tick()
    const sent = posts(h.calls)
    assert.equal(sent.length, 2)
    assert.equal(sent[1].body.title, 'Fix the flapping session cards', `fallback kept for ${JSON.stringify(bad.slice(0, 12))}`)
    assert.equal(runs.length, 1, 'no retry, ever')
  }
})

test('poller: the tick is not blocked by a pending summarisation', async (t) => {
  const h = harness(t, {}, { titleRun: () => new Promise(() => {}) }) // never resolves
  const s = sess()
  h.writeTranscript(s.cwd, s.sessionId, [user('Fix the flapping session cards on my phone please')])
  h.write(s)
  await h.tick() // would hang here if the tick awaited the CLI
  assert.equal(posts(h.calls)[0].body.title, 'Fix the flapping session cards')
})

test('poller: the disk cache round-trips and prevents a second CLI call', async (t) => {
  const a = harness(t, {}, { titleRun: async () => 'Lock screen agent' })
  const cachePath = path.join(a.dir, 'titles.json')
  const s = sess()
  a.writeTranscript(s.cwd, s.sessionId, [user('someone gave bots free reign on my lock screen')])
  a.write(s)
  await a.tick()
  await settle()
  const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'))[s.sessionId]
  assert.equal(saved.title, 'Lock screen agent')
  assert.equal(typeof saved.at, 'number', 'the disk cache stores {title, at}')
  // A fresh poller (server restart): the cached title shows at once, no CLI call.
  const runs = []
  const b = harness(t, {}, { titleRun: async (i) => (runs.push(i), 'Should Never Run'), titleCachePath: cachePath })
  b.writeTranscript(s.cwd, s.sessionId, [user('someone gave bots free reign on my lock screen')])
  b.write(s)
  await b.tick()
  await settle()
  assert.equal(posts(b.calls)[0].body.title, 'Lock screen agent')
  assert.equal(runs.length, 0, 'a known session never costs a second call')
})

test('poller: summariseTitles false never invokes the runner', async (t) => {
  const runs = []
  const h = harness(t, { summariseTitles: false }, { titleRun: async (i) => (runs.push(i), 'Nope Nope') })
  const s = sess()
  h.writeTranscript(s.cwd, s.sessionId, [user('Fix the flapping session cards on my phone please')])
  h.write(s)
  await h.tick()
  await settle()
  await h.tick()
  assert.equal(runs.length, 0)
  assert.equal(posts(h.calls)[0].body.title, 'Fix the flapping session cards')
})

test('poller: three new sessions are summarised one at a time, none stranded', async (t) => {
  // The original design dropped the third simultaneous session, stranding it on
  // its fallback forever — which is exactly what put three raw prompts on the
  // owner's lock screen. A deferred session must still get its one call.
  const started = []
  const resolvers = []
  const h = harness(t, {}, {
    alive: () => true,
    titleRun: (i) => new Promise((resolve) => (started.push(i), resolvers.push(resolve))),
  })
  const now = NOW() - 60_000
  for (const [pid, id, name] of [[50001, 'aaa', 'one'], [50002, 'bbb', 'two'], [50003, 'ccc', 'three']]) {
    const s = sess({ pid, sessionId: id, name, statusUpdatedAt: now })
    h.writeTranscript(s.cwd, id, [user(`prompt for session ${name} with plenty of words`)])
    h.write(s)
  }
  await h.tick()
  assert.equal(started.length, 1, 'one call in flight; the others wait on the single worker')
  resolvers[0]('Alpha Beta')
  await settle()
  assert.equal(started.length, 2, 'the next launches when the first resolves')
  resolvers[1]('Gamma Delta')
  await settle()
  assert.equal(started.length, 3, 'the third is summarised too, not dropped')
  resolvers[2]('Epsilon Zeta')
  await settle()
  await h.tick()
  await settle()
  assert.equal(started.length, 3, 'and never a second call for any of them')
})

// --- title summariser: one call per session, ever ---------------------------

test('summariser: a permanently failing session is called once, never retried', async (t) => {
  // The retry fix (stop stranding the 3rd session) reintroduced a worse bug: a
  // prompt the model always refuses (a bare file path) was re-requested every
  // tick, burning a metered call every 3 seconds. One call per session, forever.
  let calls = 0
  const cache = path.join(os.tmpdir(), `ledge-titles-${process.pid}-${Math.random()}.json`)
  t.after(() => { try { fs.rmSync(cache) } catch {} })
  const sum = createTitleSummariser({
    cachePath: cache,
    run: async () => { calls++; return 'I need permission to read that file please' }, // a refusal
  })
  for (let i = 0; i < 5; i++) {
    sum.request('sess', 'summarise this prose prompt with several words', 'fallback')
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.equal(calls, 1, 'exactly one model call despite five requests')
  assert.equal(sum.known('sess'), undefined, 'the refusal never became a title')
})

test('summariser: a path-only prompt spends no model call at all', async (t) => {
  let calls = 0
  const cache = path.join(os.tmpdir(), `ledge-titles-${process.pid}-${Math.random()}.json`)
  t.after(() => { try { fs.rmSync(cache) } catch {} })
  const sum = createTitleSummariser({ cachePath: cache, run: async () => { calls++; return 'Nope' } })
  sum.request('sess', '~/Desktop/Playground/memecoin-edge/PROMPT.md', 'memecoin-edge')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls, 0, 'a path prompt is not worth a metered call; the fallback stands')
})

test('isPathPrompt: prose passes, a bare path does not', () => {
  assert.equal(isPathPrompt('~/x/memecoin-edge/PROMPT.md'), true)
  assert.equal(isPathPrompt('fix the bug in ~/x/login.ts before the demo'), false)
  assert.equal(isPathPrompt('someone gave bots free reign'), false)
})

test('qualifies: a waiting session with real history earns a card; a fresh one does not', () => {
  const now = NOW()
  const waited = { ...sess({ status: 'idle', statusUpdatedAt: now - 1000 }) }
  const worked = () => true
  const untouched = () => false
  // A session he worked in and stepped away from survives a poller restart...
  assert.equal(qualifies(waited, 8000, now, () => true, worked), true)
  // ...but a fresh idle session with no transcript does not clutter the screen.
  assert.equal(qualifies(waited, 8000, now, () => true, untouched), false)
  // Busy still gates on minBusyMs regardless of history.
  const fresh = sess({ status: 'busy', statusUpdatedAt: now - 1000 })
  assert.equal(qualifies(fresh, 8000, now, () => true, worked), false, 'quick busy still debounced')
})

// --- refreshable titles ----------------------------------------------------
// A long session drifts (started on memecoin, now doing Kalshi); the title is
// re-summarised from recent activity on a bounded schedule. The zero-cost
// guarantee: an unchanged transcript never costs a model call, ever.

const tmpCache = (t) => {
  const p = path.join(os.tmpdir(), `ledge-titles-${process.pid}-${Math.random()}.json`)
  t.after(() => { try { fs.rmSync(p) } catch {} })
  return p
}

test('needsRefresh: only stale AND changed fires; unchanged or fresh never does', () => {
  assert.equal(needsRefresh(1000, 2000, 100, 1200), true) // stale, transcript newer
  assert.equal(needsRefresh(1000, 1000, 100, 99999), false) // unchanged since summary: free forever
  assert.equal(needsRefresh(1000, 999, 100, 99999), false) // older still
  assert.equal(needsRefresh(1000, 2000, 100, 1050), false) // changed but not stale yet
  assert.equal(needsRefresh(undefined, 2000, 100, 99999), false) // never summarised: request's job
})

test('summariser: stale + changed transcript is re-summarised and the new title replaces the old', async (t) => {
  let clock = 1_000_000
  const answers = ['Memecoin edge hunt', 'Kalshi dead pool']
  let calls = 0
  const titles = []
  const sum = createTitleSummariser({
    cachePath: tmpCache(t),
    titleRefreshMs: 100,
    now: () => clock,
    onTitle: (id, title) => titles.push(title),
    run: async () => (calls++, answers.shift()),
  })
  sum.request('s', 'hunt for memecoin edge opportunities overnight please', 'fb')
  await settle()
  assert.equal(sum.known('s'), 'Memecoin edge hunt')
  clock += 200 // past titleRefreshMs
  sum.refresh('s', 1_000_050, () => 'now researching kalshi dead pool markets instead') // mtime > at
  await settle()
  assert.equal(calls, 2)
  assert.equal(sum.known('s'), 'Kalshi dead pool')
  assert.deepEqual(titles, ['Memecoin edge hunt', 'Kalshi dead pool'])
})

test('summariser: stale but UNCHANGED transcript fires no call, ever (zero-cost guarantee)', async (t) => {
  let clock = 1_000_000
  let calls = 0
  const sum = createTitleSummariser({
    cachePath: tmpCache(t), titleRefreshMs: 100, now: () => clock,
    run: async () => (calls++, 'Alpha Beta'),
  })
  sum.request('s', 'a prose first prompt with plenty of words', 'fb')
  await settle()
  assert.equal(calls, 1)
  clock += 1_000_000_000 // arbitrarily stale
  sum.refresh('s', 1_000_000, () => 'context') // mtime == at: unchanged since the summary
  sum.refresh('s', 999_999, () => 'context') // older still
  await settle()
  assert.equal(calls, 1, 'a quiet session keeps its title for free')
})

test('summariser: under titleRefreshMs no refresh fires even with a changed transcript', async (t) => {
  let clock = 1_000_000
  let calls = 0
  const sum = createTitleSummariser({
    cachePath: tmpCache(t), titleRefreshMs: 10_000, now: () => clock,
    run: async () => (calls++, 'Alpha Beta'),
  })
  sum.request('s', 'a prose first prompt with plenty of words', 'fb')
  await settle()
  clock += 5_000 // half the interval
  sum.refresh('s', clock, () => 'a completely different topic by now')
  await settle()
  assert.equal(calls, 1, 'the schedule bounds the spend')
})

test('summariser: a path-only first prompt spends nothing, but accrued activity CAN be refreshed', async (t) => {
  let clock = 1_000_000
  let calls = 0
  const sum = createTitleSummariser({
    cachePath: tmpCache(t), titleRefreshMs: 100, now: () => clock,
    run: async () => (calls++, 'Kalshi dead pool'),
  })
  sum.request('s', '~/Desktop/Playground/memecoin-edge/PROMPT.md', 'memecoin-edge')
  await settle()
  assert.equal(calls, 0, 'the path prompt costs nothing')
  assert.equal(sum.label('s'), 'memecoin-edge')
  clock += 200
  sum.refresh('s', clock, () => 'researching kalshi dead pool contracts and novig pricing')
  await settle()
  assert.equal(calls, 1)
  assert.equal(sum.known('s'), 'Kalshi dead pool')
})

test('summariser: a refresh queues behind an in-flight first summary; one worker only', async (t) => {
  let clock = 1_000_000
  const started = []
  const resolvers = []
  const cache = tmpCache(t)
  // Seed a previously summarised session so its refresh is eligible.
  fs.writeFileSync(cache, JSON.stringify({ old: { title: 'Old Title', at: 500 } }))
  const sum = createTitleSummariser({
    cachePath: cache, titleRefreshMs: 100, now: () => clock,
    run: (i) => new Promise((resolve) => (started.push(i), resolvers.push(resolve))),
  })
  sum.request('new', 'first prompt for a brand new session here', 'fb')
  await settle()
  assert.equal(started.length, 1, 'the first summary holds the worker')
  sum.refresh('old', 1_000_000, () => 'kalshi work now happening in this session')
  await settle()
  assert.equal(started.length, 1, 'the refresh queues; it never runs concurrently')
  resolvers[0]('New Session Title')
  await settle()
  assert.equal(started.length, 2, 'the refresh launches when the worker frees')
  resolvers[1]('Kalshi dead pool')
  await settle()
  assert.equal(sum.known('old'), 'Kalshi dead pool')
})

test('summariser: the disk cache round-trips {title, at} and keeps the schedule across restarts', async (t) => {
  const cache = tmpCache(t)
  let clock = 1_000_000
  const a = createTitleSummariser({ cachePath: cache, titleRefreshMs: 100, now: () => clock, run: async () => 'Alpha Beta' })
  a.request('s', 'a prose first prompt with plenty of words', 'fb')
  await settle()
  assert.deepEqual(JSON.parse(fs.readFileSync(cache, 'utf8')), { s: { title: 'Alpha Beta', at: 1_000_000 } })
  let calls = 0
  const b = createTitleSummariser({ cachePath: cache, titleRefreshMs: 100, now: () => clock, run: async () => (calls++, 'Gamma Delta') })
  assert.equal(b.known('s'), 'Alpha Beta', 'the restart loads the title')
  b.refresh('s', 2_000_000, () => 'changed transcript context here') // changed but not stale
  await settle()
  assert.equal(calls, 0, 'the loaded `at` still gates the schedule')
  clock += 100
  b.refresh('s', 2_000_000, () => 'changed transcript context here')
  await settle()
  assert.equal(calls, 1)
  assert.equal(b.known('s'), 'Gamma Delta')
})

test('recentContext: recent prose only — tool blocks and "<"/"[" lines skipped, markdown stripped', (t) => {
  const file = transcript(t, [
    user('# Plan\n\nHunt for **memecoin** edge overnight'),
    asst([tu('Bash', { command: 'ls -la' })]), // tool_use only: no prose
    user([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'giant tool dump' }]),
    user('<system-reminder>reminder noise</system-reminder>'),
    user('[Request interrupted by user]'),
    { type: 'summary', summary: 'not a message' },
    asst([{ type: 'text', text: 'Pivoting to `Kalshi` dead-pool *markets* now' }]),
    user('check novig pricing next'),
  ])
  const d = recentContext(file)
  assert.ok(d.includes('memecoin edge overnight'), d)
  assert.ok(d.includes('Pivoting to Kalshi dead-pool markets now'), d)
  assert.ok(d.endsWith('check novig pricing next'), 'newest last: ' + d)
  assert.ok(!d.includes('giant tool dump') && !d.includes('reminder noise') && !d.includes('interrupted'), d)
  assert.ok(!d.includes('**') && !d.includes('#') && !d.includes('`'), d)
})

test('recentContext: caps at 600 chars, trimming the oldest so the newest survives whole', (t) => {
  const file = transcript(t, [
    user('OLDEST marker ' + 'blah '.repeat(200)),
    user('NEWEST kalshi topic sentence'),
  ])
  const d = recentContext(file)
  assert.ok(d.length <= 600, String(d.length))
  assert.ok(d.endsWith('NEWEST kalshi topic sentence'), 'newest last, kept whole')
  assert.ok(!d.includes('OLDEST'), 'the cap trims the oldest end')
})

test('recentContext: a missing or malformed file returns "" without throwing', (t) => {
  assert.equal(recentContext(path.join(os.tmpdir(), 'ledge-recent-does-not-exist.jsonl')), '')
  assert.equal(recentContext(transcript(t, ['not json at all', '{"half": '])), '')
})

test('poller: a drifted session is re-summarised from recent activity and the card updates in place', async (t) => {
  const answers = ['Memecoin edge hunt', 'Kalshi dead pool']
  const h = harness(t, { titleRefreshMs: 1 }, { titleRun: async () => answers.shift() })
  const s = sess()
  h.writeTranscript(s.cwd, s.sessionId, [user('hunt for memecoin edge opportunities overnight please')])
  h.write(s)
  await h.tick()
  await settle()
  await h.tick()
  assert.equal(posts(h.calls)[1].body.title, 'Memecoin edge hunt')
  await new Promise((r) => setTimeout(r, 10)) // let the transcript mtime pass the summary's `at`
  h.writeTranscript(s.cwd, s.sessionId, [
    user('hunt for memecoin edge opportunities overnight please'),
    user('actually pivot to kalshi dead pool markets and novig pricing'),
  ])
  await h.tick() // the refresh launches off the tick path
  await settle()
  await h.tick() // and the better title posts on the next tick
  const sent = posts(h.calls)
  const last = sent[sent.length - 1].body
  assert.equal(last.title, 'Kalshi dead pool')
  assert.equal(last.lane, 'cc-chief-b7', 'same card, updated in place')
})
