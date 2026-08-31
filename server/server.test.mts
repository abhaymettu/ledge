// node --test server/
// Covers the two pieces that silently corrupt pushes when wrong: the boundary
// validator and the 30s coalescer. The APNs sender is a stub; nothing here talks
// to Apple.

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPayload, authToken, JWT_TTL_MS, send, closeSession, apnsHost, apnsHeaders } from './apns.mts'
import crypto from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  validateActivity,
  validateEnd,
  contentStateFor,
  Coalescer,
  TITLE_MAX,
  LINE_MAX,
  COALESCE_MS,
} from './server.mts'

const ok = (over = {}) => ({ lane: 'networking', template: 'progress', ...over })

// --- validator -------------------------------------------------------------

test('validator: accepts a well formed activity', () => {
  const { error, value } = validateActivity(ok({ line: 'drafting 3 outreach emails', tone: 'warn' }))
  assert.equal(error, undefined)
  assert.deepEqual(value, {
    lane: 'networking',
    template: 'progress',
    line: 'drafting 3 outreach emails',
    tone: 'warn',
  })
})

test('validator: rejects lane path traversal', () => {
  for (const lane of ['../../etc', '../etc/passwd', 'Networking', 'net work', '', 'a'.repeat(25), '/', 'a/b']) {
    const { error } = validateActivity(ok({ lane }))
    assert.match(error ?? '', /^lane must match/, `lane ${JSON.stringify(lane)} should be rejected`)
  }
})

test('validator: accepts the lane charset', () => {
  for (const lane of ['a', 'networking', 'phd-2', 'x'.repeat(24)]) {
    assert.equal(validateActivity(ok({ lane })).error, undefined)
  }
})

test('validator: rejects an oversized line rather than truncating it', () => {
  const { error, value } = validateActivity(ok({ line: 'x'.repeat(5000) }))
  assert.equal(value, undefined)
  assert.match(error, /^line too long \(5000 > \d+\)$/)
})

test('validator: rejects an oversized title', () => {
  const { error } = validateActivity(ok({ title: 'x'.repeat(5000) }))
  assert.match(error, /^title too long/)
})

test('validator: truncates ordinary overflow to 24 and 60', () => {
  const { value } = validateActivity(ok({ title: 'T'.repeat(80), line: 'L'.repeat(120) }))
  assert.equal(value.title.length, TITLE_MAX)
  assert.equal(value.line.length, LINE_MAX)
})

test('validator: rejects an unknown template', () => {
  for (const template of ['spinner', 'PROGRESS', '', null, 42, undefined]) {
    const { error } = validateActivity(ok({ template }))
    assert.match(error ?? '', /^template must be one of/)
  }
})

test('validator: accepts all four templates', () => {
  for (const template of ['progress', 'needs_you', 'result', 'countdown']) {
    assert.equal(validateActivity(ok({ template })).error, undefined)
  }
})

test('validator: clamps progress to 0...1', () => {
  assert.equal(validateActivity(ok({ progress: 5 })).value.progress, 1)
  assert.equal(validateActivity(ok({ progress: -1 })).value.progress, 0)
  assert.equal(validateActivity(ok({ progress: 0.42 })).value.progress, 0.42)
  assert.equal(validateActivity(ok({ progress: '0.5' })).value.progress, 0.5)
  assert.equal(validateActivity(ok({})).value.progress, undefined)
  assert.match(validateActivity(ok({ progress: 'soon' })).error, /^progress must be/)
})

test('validator: rejects a bad tone and defaults to neutral', () => {
  assert.equal(validateActivity(ok({})).value.tone, 'neutral')
  assert.match(validateActivity(ok({ tone: 'panic' })).error, /^tone must be one of/)
})

test('validator: rejects a non-object body', () => {
  for (const body of [null, 'nope', 42, ['a']]) {
    assert.match(validateActivity(body).error, /^body must be a JSON object/)
  }
})

test('validator: parses a deadline as epoch seconds or ISO', () => {
  const soon = Math.floor((Date.now() + 3600_000) / 1000)
  assert.equal(validateActivity(ok({ template: 'countdown', deadline: soon })).value.deadline, soon * 1000)
  const iso = new Date(Date.now() + 3600_000).toISOString()
  assert.equal(validateActivity(ok({ template: 'countdown', deadline: iso })).value.deadline, Date.parse(iso))
  assert.match(validateActivity(ok({ template: 'countdown', deadline: 'tomorrow' })).error, /^deadline must be/)
})

test('validateEnd: same lane rule, defaults to a done/ok close', () => {
  assert.match(validateEnd({ lane: '../../etc' }).error, /^lane must match/)
  assert.deepEqual(validateEnd({ lane: 'phd' }).value, { lane: 'phd', line: 'done', tone: 'ok' })
  assert.match(validateEnd({ lane: 'phd', line: 'x'.repeat(5000) }).error, /^line too long/)
})

test('contentState: carries one state, derived from template and tone or given directly', () => {
  const cs = (over) => contentStateFor(validateActivity(ok(over)).value, {})
  assert.equal(cs({ template: 'progress' }).state, 'working')
  assert.equal(cs({ template: 'progress', tone: 'warn' }).state, 'stuck')
  assert.equal(cs({ template: 'needs_you', tone: 'warn' }).state, 'asking')
  assert.equal(cs({ template: 'countdown' }).state, 'resting')
  assert.equal(cs({ template: 'result', tone: 'ok' }).state, 'done')
  assert.equal(cs({ template: 'result', tone: 'fail' }).state, 'failed')
  assert.equal(cs({ template: 'progress', tone: 'fail' }).state, 'failed')
  assert.equal(cs({ template: 'progress', state: 'asking' }).state, 'asking', 'an explicit state wins')
  assert.match(validateActivity(ok({ state: 'nonsense' })).error ?? '', /^state must be one of/)
  const wire = cs({ template: 'needs_you' })
  assert.equal('template' in wire, false, 'the phone sees state, not the API vocabulary')
  assert.equal('tone' in wire, false)
})

test('contentState: dates are Apple reference-date seconds, optionals omitted', () => {
  const cs = contentStateFor(validateActivity(ok({})).value, { startedAt: Date.UTC(2001, 0, 1) })
  assert.equal(cs.startedAt, 0)
  assert.equal('progress' in cs, false)
  assert.equal('deadline' in cs, false)
  // startedAt now ships on every template: a needs_you card must be able to say how
  // long it has been waiting on you.
  const c2 = contentStateFor(validateActivity(ok({ template: 'result' })).value, { startedAt: Date.now() })
  assert.equal('startedAt' in c2, true)
})

// --- coalescer -------------------------------------------------------------

function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const sent = []
  const c = new Coalescer(COALESCE_MS)
  const job = (tag) => () => {
    sent.push(tag)
    return Promise.resolve({ status: 200, apnsId: tag })
  }
  return { c, sent, job }
}

test('coalescer: three rapid updates collapse to two pushes', async (t) => {
  const { c, sent, job } = harness(t)
  await c.push('networking', job('u1'))
  t.mock.timers.tick(1000)
  await c.push('networking', job('u2'))
  t.mock.timers.tick(1000)
  await c.push('networking', job('u3'))
  assert.deepEqual(sent, ['u1'], 'only the first lands inside the window')

  t.mock.timers.tick(COALESCE_MS)
  assert.deepEqual(sent, ['u1', 'u3'], 'the newest pending update replaces the older one')
})

test('coalescer: needs_you jumps the queue and clears what was pending', async (t) => {
  const { c, sent, job } = harness(t)
  await c.push('networking', job('u1'))
  t.mock.timers.tick(1000)
  await c.push('networking', job('u2')) // deferred
  await c.push('networking', job('needs_you'), { immediate: true })
  assert.deepEqual(sent, ['u1', 'needs_you'], 'needs_you lands without waiting out the window')

  t.mock.timers.tick(COALESCE_MS * 2)
  assert.deepEqual(sent, ['u1', 'needs_you'], 'the superseded u2 never fires')
})

test('coalescer: lanes do not block each other', async (t) => {
  const { c, sent, job } = harness(t)
  await c.push('networking', job('n1'))
  await c.push('phd', job('p1'))
  await c.push('brain', job('b1'))
  assert.deepEqual(sent, ['n1', 'p1', 'b1'])
})

test('coalescer: a push after the window lands immediately', async (t) => {
  const { c, sent, job } = harness(t)
  await c.push('networking', job('u1'))
  t.mock.timers.tick(COALESCE_MS + 1)
  await c.push('networking', job('u2'))
  assert.deepEqual(sent, ['u1', 'u2'])
})

test('coalescer: drop cancels a pending push', async (t) => {
  const { c, sent, job } = harness(t)
  await c.push('networking', job('u1'))
  await c.push('networking', job('u2'))
  c.drop('networking')
  t.mock.timers.tick(COALESCE_MS * 2)
  assert.deepEqual(sent, ['u1'])
})

test('coalescer: a throwing job does not break the lane', async (t) => {
  const { c, sent, job } = harness(t)
  await c.push('networking', () => {
    throw new Error('boom')
  })
  t.mock.timers.tick(COALESCE_MS + 1)
  await c.push('networking', job('u2'))
  assert.deepEqual(sent, ['u2'])
})

// --- start race ------------------------------------------------------------
// iOS reports an activity's update token asynchronously. A second request that
// lands in that gap must NOT push a second start, or the lock screen shows two
// identical cards. Observed live on 2026-08-29 with two "test" cards.

import http from 'node:http'
import { createHandler } from './server.mts'
import { sublineFor, toolOfLine } from './card.mts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const startHarness = async (t, extra = {}) => {
  const calls = []
  const apns = extra.apns ?? {
    sendStart: async (...a) => (calls.push(['start', ...a]), { status: 200, apnsId: 'A' }),
    sendUpdate: async (...a) => (calls.push(['update', ...a]), { status: 200, apnsId: 'B' }),
    sendEnd: async (...a) => (calls.push(['end', ...a]), { status: 200, apnsId: 'C' }),
  }
  const state = { pushToStartToken: 'pts', lanes: {} }
  const stateFile = extra.stateFile ?? join(tmpdir(), `ledge-test-${process.pid}-${Math.random()}.json`)
  const srv = http.createServer(
    createHandler({ cfg: { token: 'tok', bundleId: 'com.test.x' }, ...extra, apns, state, stateFile }),
  )
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  t.after(() => { srv.close(); rmSync(stateFile, { force: true }) })
  const post = (p, b) =>
    fetch(base + p, {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify(b),
    })
  return { calls, post, state, base }
}

test('lanes: each lane\'s last content state, and only with the token', async (t) => {
  const { post, base } = await startHarness(t)
  await post('/activity', { lane: 'cc-a', template: 'progress', line: 'one', title: 'A' })
  const r = await fetch(base + '/lanes', { headers: { authorization: 'Bearer tok' } })
  const { lanes } = await r.json()
  assert.deepEqual(Object.keys(lanes), ['cc-a'])
  assert.equal(lanes['cc-a'].line, 'one')
  assert.equal(lanes['cc-a'].state, 'working')
  assert.equal((await fetch(base + '/lanes')).status, 401)
})

test('token: a token for a lane the server no longer holds ends that activity instead of resurrecting the lane', async (t) => {
  const { calls, post, state } = await startHarness(t)
  await post('/activity', { lane: 'cc-a', template: 'progress', line: 'x' })
  await post('/token', { lane: 'cc-a', updateToken: 'old' })
  await post('/activity/end', { lane: 'cc-a' })
  assert.deepEqual(Object.keys(state.lanes), [])
  const r = await post('/token', { lane: 'cc-a', updateToken: 'ghost' })
  assert.equal(r.status, 204)
  assert.deepEqual(Object.keys(state.lanes), [], 'the lane stays gone')
  const ends = calls.filter((c) => c[0] === 'end')
  assert.equal(ends.at(-1)[1], 'ghost', 'the ghost activity is ended')
})

test('lanes: the token a restored activity reports triggers one update carrying the relevance score', async (t) => {
  const { calls, post, base } = await startHarness(t)
  await post('/activity', { lane: 'cc-a', template: 'needs_you', line: 'go?' })
  await post('/token', { lane: 'cc-a', updateToken: 'old' })
  const before = calls.filter((c) => c[0] === 'update').length
  await fetch(base + '/lanes', { headers: { authorization: 'Bearer tok' } })
  await post('/token', { lane: 'cc-a', updateToken: 'new' })
  const updates = calls.filter((c) => c[0] === 'update')
  assert.equal(updates.length, before + 1, 'exactly one flush to the new token')
  assert.equal(updates.at(-1)[1], 'new')
  assert.equal(updates.at(-1)[2].contentState.line, 'go?')
})

test('register: a new push-to-start token tells the poller to repost everything', async (t) => {
  const forgotten = []
  const { post, state } = await startHarness(t, { onForget: (live) => forgotten.push(live) })
  await post('/activity', { lane: 'cc-a', template: 'progress', line: 'one' })
  await post('/register', { pushToStartToken: 'pts' })
  assert.deepEqual(forgotten, [], 'the same token again leaves live cards alone')
  await post('/register', { pushToStartToken: 'pts2' })
  assert.deepEqual(Object.keys(state.lanes), [])
  assert.deepEqual(forgotten, [[]], 'a changed token wipes the phone, so the poller forgets every card')
})

test('start race: a second push before /token does not start a second activity', async (t) => {
  const { calls, post } = await startHarness(t)
  await post('/activity', { lane: 'test', template: 'progress', line: 'one' })
  await post('/activity', { lane: 'test', template: 'progress', line: 'two' })
  const starts = calls.filter((c) => c[0] === 'start')
  assert.equal(starts.length, 1, `expected exactly 1 start, got ${starts.length}`)
})

test('start race: the held state is flushed once /token arrives', async (t) => {
  const { calls, post } = await startHarness(t)
  await post('/activity', { lane: 'test', template: 'progress', line: 'one' })
  await post('/activity', { lane: 'test', template: 'progress', line: 'two' })
  await post('/token', { lane: 'test', updateToken: 'utok' })
  const updates = calls.filter((c) => c[0] === 'update')
  assert.equal(updates.length, 1, 'the held update should flush exactly once')
  assert.equal(updates[0][2].contentState.line, 'two', 'the newest line should win')
})

test('start race: a normal update after /token still updates, never restarts', async (t) => {
  const { calls, post } = await startHarness(t)
  await post('/activity', { lane: 'test', template: 'progress', line: 'one' })
  await post('/token', { lane: 'test', updateToken: 'utok' })
  await post('/activity', { lane: 'test', template: 'needs_you', line: 'three' })
  assert.equal(calls.filter((c) => c[0] === 'start').length, 1)
  assert.equal(calls.filter((c) => c[0] === 'update').length, 1)
})

// --- deadline units --------------------------------------------------------
// Shipped bug, 2026-08-29: a deadline passed in milliseconds rendered a countdown
// to the year 58000 on the lock screen instead of erroring.

test('deadline: accepts seconds, milliseconds and ISO alike', () => {
  const ms = Date.now() + 3 * 3600_000
  const expect = (d) => validateActivity(ok({ template: 'countdown', deadline: d })).value.deadline
  assert.ok(Math.abs(expect(Math.floor(ms / 1000)) - ms) < 1000)
  assert.equal(expect(ms), ms)
  assert.equal(expect(new Date(ms).toISOString()), ms)
})

test('deadline: rejects a value that is a unit mistake, not a date', () => {
  for (const bad of [1788040201397000, 1, -1, Date.now() + 400 * 24 * 3600_000]) {
    const { error } = validateActivity(ok({ template: 'countdown', deadline: bad }))
    assert.match(error ?? '', /deadline must be/, `${bad} should be rejected`)
  }
})

test('startedAt is present on every template, not just progress', () => {
  for (const template of ['progress', 'needs_you', 'result', 'countdown']) {
    const { value } = validateActivity(ok({ template }))
    const cs = contentStateFor(value, { startedAt: Date.now() })
    assert.ok(cs.startedAt !== undefined, `${template} should carry startedAt`)
  }
})

// --- relevance + deep link -------------------------------------------------

test('relevance: the longest-ignored waiting session wins the Dynamic Island', () => {
  // Every needs_you used to score 100, so three unanswered sessions tied and iOS
  // picked one arbitrarily. The one you have ignored longest should win.
  const E = 978307200000
  const ago = (mins) => (Date.now() - mins * 60_000 - E) / 1000
  const score = (mins) =>
    buildPayload({
      event: 'update',
      contentState: { state: 'asking', title: 't', line: '', startedAt: ago(mins) },
    }).aps['relevance-score']
  assert.ok(score(30) > score(5), 'ignored longer must outrank freshly asked')
  assert.ok(score(5) > score(0))
  assert.ok(score(120) <= 100, 'never exceeds the 0-100 range Apple accepts')
  assert.ok(score(0) >= 90, 'any waiting card still outranks working and result')
})

test('relevance: a stuck session outranks a finished one but not a question', () => {
  const of = (cs) => buildPayload({ event: 'update', contentState: cs }).aps['relevance-score']
  const card = (state) => ({ state, title: 't', line: '' })
  const stuck = of(card('stuck'))
  assert.ok(stuck > of(card('done')), 'stuck beats done')
  assert.ok(stuck > of(card('working')), 'stuck beats healthy work')
  assert.ok(stuck < of(card('asking')), 'a real question still wins')
})

test('relevance: a blocked lane outranks a working one in the Dynamic Island', () => {
  const score = (state) =>
    buildPayload({ event: 'update', contentState: { state, title: 't', line: '' } }).aps['relevance-score']
  assert.ok(score('asking') > score('done'), 'asking must outrank done')
  assert.ok(score('done') > score('working'), 'done must outrank working')
  assert.ok(score('failed') > score('working'), 'a failure must outrank a normal run')
  assert.equal(score('nonsense'), 20, 'an unknown state falls back, never undefined')
})

test('url: only https claude.ai is tappable from the lock screen', () => {
  const u = (url) => validateActivity(ok({ url }))
  assert.equal(u('https://claude.ai/code/session_abc').error, undefined)
  for (const bad of [
    'http://claude.ai/x',                 // not https
    'https://evil.example.com/x',         // host not allowed
    'javascript:alert(1)',                // not a URL we accept
    'not a url',
    'https://claude.ai/' + 'x'.repeat(300), // over the cap
  ]) {
    assert.match(u(bad).error ?? '', /^url /, `${bad.slice(0, 40)} should be rejected`)
  }
})

test('url: reaches the content state so the widget can make the card tappable', () => {
  const { value } = validateActivity(ok({ url: 'https://claude.ai/code/session_abc' }))
  assert.equal(contentStateFor(value, { startedAt: Date.now() }).url, 'https://claude.ai/code/session_abc')
})

// --- deferred sends and the rollover timer ---------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Bug: the coalesced job captured entry.updateToken at enqueue time. A token the
// phone rotated (or a lane that rolled over) inside the 30s window got the push
// sent to a dead token.
test('coalesce: a deferred update sends to the current token, not the enqueued one', async (t) => {
  const { calls, post } = await startHarness(t, { coalescer: new Coalescer(80) })
  await post('/activity', { lane: 'test', template: 'progress', line: 'one' })
  await post('/token', { lane: 'test', updateToken: 'utok1' })
  await post('/activity', { lane: 'test', template: 'progress', line: 'two' }) // deferred
  await post('/token', { lane: 'test', updateToken: 'utok2' }) // phone rotates the token
  await sleep(150)
  const updates = calls.filter((c) => c[0] === 'update')
  assert.equal(updates.length, 1)
  assert.equal(updates[0][1], 'utok2', 'the deferred push must use the rotated token')
})

// Bug: restartLane's catch block persists state; if THAT throws (state dir gone,
// disk full) the rejection escaped the setTimeout callback unhandled and killed
// the whole server process at the 7h50m rollover.
test('rollover: a failing restart with an unwritable state file does not kill the process', async (t) => {
  const dir = join(tmpdir(), `ledge-test-dir-${process.pid}-${Math.random()}`)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir)
  let starts = 0
  const apns = {
    // first start (from /activity) succeeds; the rollover's replacement start fails
    sendStart: async () => ({ status: ++starts === 1 ? 200 : 500, apnsId: 'A', reason: 'boom' }),
    sendUpdate: async () => ({ status: 200, apnsId: 'B' }),
    sendEnd: async () => ({ status: 200, apnsId: 'C' }),
  }
  const { post, base } = await startHarness(t, {
    apns,
    restartMs: 40,
    stateFile: join(dir, 'state.json'),
  })
  await post('/activity', { lane: 'test', template: 'progress', line: 'one' })
  rmSync(dir, { recursive: true, force: true }) // every persist from here on throws
  await sleep(150) // the rollover fires, fails, and its cleanup persist throws
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200, 'the server must still be answering')
})

// --- empty titles and ends during the start grace ---------------------------

test('title: blank never clobbers the label, and a real one is trimmed', async (t) => {
  // checkText treated '' as a present string, so an empty or whitespace title
  // slipped past the "leave the label alone" guard and reset the card's label.
  const { post } = await startHarness(t)
  await post('/activity', { lane: 'test', template: 'progress', title: 'the real label' })
  await post('/token', { lane: 'test', updateToken: 'utok' })
  for (const title of ['', '   ', undefined]) {
    await post('/activity', { lane: 'test', template: 'needs_you', line: 'x', title })
  }
  const { value } = validateActivity({ lane: 'test', template: 'progress', title: '  padded  ' })
  assert.equal(value.title, 'padded', 'whitespace around a title must not reach the lock screen')
  const blank = validateActivity({ lane: 'test', template: 'progress', title: '   ' })
  assert.equal('title' in blank.value, false, 'a blank title counts as not supplied')
})

test('end during start grace: the card dies when the token arrives, not never', async (t) => {
  // Sequence seen in the wild: push-to-start sent, /activity/end arrives before
  // the phone reports the update token. State was deleted, the card had no
  // handle, and it sat on the lock screen for hours.
  const { calls, post, state } = await startHarness(t)
  await post('/activity', { lane: 'test', template: 'progress', line: 'working' })
  const r = await post('/activity/end', { lane: 'test' })
  assert.equal(r.status, 200)
  assert.equal(calls.filter((c) => c[0] === 'end').length, 0, 'no token yet, nothing to end')
  assert.ok(state.pendingEnds?.test, 'the end must be parked, not dropped')

  await post('/token', { lane: 'test', updateToken: 'utok' })
  const ends = calls.filter((c) => c[0] === 'end')
  assert.equal(ends.length, 1, 'the parked end fires the moment the token arrives')
  assert.equal(ends[0][1], 'utok', 'and it targets the token just reported')
  assert.equal(state.pendingEnds?.test, undefined, 'the tombstone is consumed')
  assert.equal(state.lanes.test, undefined, 'the ghost lane must not be resurrected')
})

test('end after the token: unchanged, ends immediately', async (t) => {
  const { calls, post } = await startHarness(t)
  await post('/activity', { lane: 'test', template: 'progress' })
  await post('/token', { lane: 'test', updateToken: 'utok' })
  await post('/activity/end', { lane: 'test' })
  assert.equal(calls.filter((c) => c[0] === 'end').length, 1)
})

// --- constraints that used to live in comments ---------------------------------

test('payload: start carries attributes-type, attributes and an alert; update and end do not; end carries dismissal-date', () => {
  const card = { state: 'working', title: 't', line: 'l' }
  const start = buildPayload({ event: 'start', lane: 'x', contentState: card }).aps
  assert.equal(start['attributes-type'], 'AgentActivity')
  assert.deepEqual(start.attributes, { lane: 'x' })
  assert.deepEqual(start.alert, { title: 'x', body: 'l' })
  const update = buildPayload({ event: 'update', contentState: card }).aps
  assert.equal('attributes' in update, false)
  assert.equal('alert' in update, false)
  const end = buildPayload({ event: 'end', contentState: card, dismissAt: 1_000_000_000_000 }).aps
  assert.equal(end['dismissal-date'], 1_000_000_000)
})

test('jwt: one provider token is reused for JWT_TTL_MS and signed in the JOSE r||s form Apple accepts', (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyPath = join(tmpdir(), `ledge-jwt-${process.pid}.p8`)
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  t.after(() => rmSync(keyPath, { force: true }))
  const cfg = { teamId: 'TEAM', keyId: 'KEYID', keyPath }
  const now = Date.now()
  const a = authToken(cfg, now)
  assert.equal(authToken(cfg, now + JWT_TTL_MS - 1), a, 'reused inside the window (Apple rejects refreshes under 20 minutes apart)')
  assert.notEqual(authToken(cfg, now + JWT_TTL_MS + 1), a, 'minted again after it')
  const [h, p, sig] = a.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEYID' })
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).iss, 'TEAM')
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))
  assert.equal(ok, true, 'raw r||s, not DER: DER is what Apple rejects')
})

test('body: a request over 1MB is refused with 413 before it is parsed', async (t) => {
  const { base } = await startHarness(t)
  const r = await fetch(base + '/activity', {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify({ lane: 'x', template: 'progress', line: 'a'.repeat(1 << 20) }),
  }).catch(() => ({ status: 413 }))
  assert.equal(r.status, 413)
})

test('activity: a start without a paired phone is 409, not a push to nowhere', async (t) => {
  const { calls, post, state } = await startHarness(t)
  state.pushToStartToken = null
  const r = await post('/activity', { lane: 'x', template: 'progress', line: 'l' })
  assert.equal(r.status, 409)
  assert.equal(calls.length, 0)
})

test('end: a live lane is ended with a dismissal date of now, so the card leaves the lock screen at once', async (t) => {
  const { calls, post } = await startHarness(t)
  await post('/activity', { lane: 'x', template: 'progress', line: 'l' })
  await post('/token', { lane: 'x', updateToken: 'tok' })
  const before = Date.now()
  await post('/activity/end', { lane: 'x' })
  const end = calls.find((c) => c[0] === 'end')
  assert.ok(end, 'an end was pushed')
  assert.ok(end[2].dismissAt >= before && end[2].dismissAt <= Date.now() + 1000)
  assert.equal(end[2].contentState.state, 'done')
})

// --- approvals -------------------------------------------------------------------

test('approvals: a request is listed, a decision resolves the waiting hook, an unknown id is 404', async (t) => {
  const { post, base } = await startHarness(t)
  const get = (p) => fetch(base + p, { headers: { authorization: 'Bearer tok' } })
  const r = await post('/approvals', { sessionId: 'sess-1', tool: 'Bash', input: { command: 'git push --force', description: 'push the branch' }, cwd: '/x' })
  assert.equal(r.status, 201)
  const { id } = await r.json()
  const listed = (await (await get('/approvals')).json()).approvals
  assert.equal(listed.length, 1)
  assert.equal(listed[0].summary, 'push the branch')
  const waiting = get(`/approvals/${id}?wait=5000`)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal((await post(`/approvals/${id}`, { decision: 'allow' })).status, 204)
  assert.deepEqual(await (await waiting).json(), { decision: 'allow' })
  assert.equal((await post(`/approvals/${id}`, { decision: 'allow' })).status, 404, 'decided once')
  assert.equal((await post(`/approvals/${id}`, { decision: 'maybe' })).status, 400)
})

// The card is the only push Ledge sends. An approval is answered in the app,
// reached by tapping the card, so opening one must not push anything of its own.
test('apns: every push is a liveactivity push, on the topic Apple binds to that type', () => {
  assert.equal(apnsHeaders({ bundleId: 'com.abhay.ledge' })['apns-topic'], 'com.abhay.ledge.push-type.liveactivity')
})

test('approvals: opening one pushes nothing, the card already on screen carries it', async (t) => {
  const { calls, post } = await startHarness(t)
  const r = await post('/approvals', { sessionId: 's', tool: 'Read', input: { file_path: '/a/b' }, cwd: '/x' })
  assert.equal(r.status, 201, 'the hook is waiting on this')
  assert.equal(calls.length, 0)
})

test('approvals: nobody deciding within the wait is no decision, never an allow', async (t) => {
  const { post, base } = await startHarness(t)
  const { id } = await (await post('/approvals', { sessionId: 's', tool: 'Edit', input: { file_path: '/a/b.mts' }, cwd: '/x' })).json()
  const r = await fetch(base + `/approvals/${id}?wait=100`, { headers: { authorization: 'Bearer tok' } })
  assert.deepEqual(await r.json(), { decision: null })
})

test('history: an ended lane is kept with its card and outcome, newest last, capped', async (t) => {
  const { post, base } = await startHarness(t)
  await post('/activity', { lane: 'cc-a', template: 'progress', line: 'l', title: 'A' })
  await post('/token', { lane: 'cc-a', updateToken: 'tok' })
  await post('/activity/end', { lane: 'cc-a', tone: 'fail', line: 'broke' })
  const { history } = await (await fetch(base + '/history', { headers: { authorization: 'Bearer tok' } })).json()
  assert.equal(history.length, 1)
  assert.equal(history[0].lane, 'cc-a')
  assert.equal(history[0].outcome, 'failed')
  assert.equal(history[0].card.title, 'A')
})

test('apns: a token the configured environment rejects is retried on the other one, and that is remembered', async (t) => {
  t.after(closeSession)
  closeSession()
  const bad = { status: 400, apnsId: '', reason: 'BadDeviceToken', body: '', bytes: 0 }
  const ok = { status: 200, apnsId: 'a', reason: '', body: '', bytes: 0 }
  const tried: string[] = []
  // The sideload case: config still says production, the phone holds a sandbox token.
  const post = async (env, _cfg, _tok, _payload) => {
    tried.push(env)
    return env === 'sandbox' ? ok : bad
  }
  const cfg = { env: 'production' }
  const first = await send(cfg, 'tok', { aps: {} }, post)
  assert.equal(first.status, 200)
  assert.deepEqual(tried, ['production', 'sandbox'], 'tries the configured host, then the other')

  // Having learned it, the next push must not pay for the rejection again.
  const second = await send(cfg, 'tok', { aps: {} }, post)
  assert.equal(second.status, 200)
  assert.deepEqual(tried, ['production', 'sandbox', 'sandbox'], 'goes straight to what worked')

  // A token both environments reject is a dead token, not a routing problem: report it.
  closeSession()
  const dead = await send(cfg, 'tok', { aps: {} }, async () => bad)
  assert.equal(dead.reason, 'BadDeviceToken')
})

test('apns: each environment has its own host', () => {
  assert.equal(apnsHost('production'), 'api.push.apple.com')
  assert.equal(apnsHost('sandbox'), 'api.sandbox.push.apple.com')
})

test('payload: a lane finishing alerts, and says which lane and how it went', () => {
  const done = buildPayload({
    event: 'end',
    contentState: { state: 'done', title: 'strafe', line: 'installed' },
    dismissAt: 1_700_000_000_000,
  }).aps
  assert.deepEqual(done.alert, { title: 'strafe', body: 'installed', sound: 'default' })
  assert.equal(done['dismissal-date'], 1_700_000_000)

  // A failure is the case he most needs to hear about, so it alerts too.
  const failed = buildPayload({
    event: 'end',
    contentState: { state: 'failed', title: 'strafe', line: 'build broke' },
    dismissAt: 1_700_000_000_000,
  }).aps
  assert.equal((failed.alert as any).body, 'build broke')
})

test('payload: an update alerts only when the card needs him (asking, approval), never for working', () => {
  const upd = (state) => buildPayload({ event: 'update', contentState: { state, title: 'T', line: 'L' } }).aps
  assert.deepEqual(upd('asking').alert, { title: 'T', body: 'L', sound: 'default' })
  assert.deepEqual(upd('approval').alert, { title: 'T', body: 'L', sound: 'default' })
  for (const s of ['working', 'stuck', 'resting', 'done', 'failed']) assert.equal('alert' in upd(s), false, s)
})

// ── the hook posts a bare card, the server fills the row under it ──────────

test('sublineFor: the tool when the line names one, the repo when it does not', () => {
  assert.equal(sublineFor('cc-ledge', 'Claude needs your permission to use AskUserQuestion'),
    'AskUserQuestion in ledge')
  assert.equal(sublineFor('cc-ledge', 'Claude needs your permission to use Bash'), 'Bash in ledge')
  assert.equal(sublineFor('cc-memecoin-edge', 'Claude needs your permission to use mcp__blender__get_scene_info'),
    'mcp__blender__get_scene_info in memecoin-edge')
  assert.equal(sublineFor('cc-ledge', 'Claude is waiting for your input'), 'ledge',
    'no tool named, so only where it came from')
  assert.equal(sublineFor('cc-chief-b7', 'started'), 'chief-b7')
})

test('sublineFor: prose that merely contains the phrase names no tool', () => {
  // The whole point of the shape check: a wrong tool on a permission card is
  // worse than no tool at all.
  assert.equal(sublineFor('cc-ledge', 'asked for permission to use the shared drive'), 'ledge')
  assert.equal(sublineFor('cc-ledge', 'permission to use a colleague machine'), 'ledge')
  assert.equal(toolOfLine('Claude needs your permission to use the tool'), '')
  assert.equal(toolOfLine('Claude needs your permission to use Read'), 'Read')
})

test('sublineFor: nothing to say stays nothing, and it never runs long', () => {
  assert.equal(sublineFor('', ''), '')
  assert.equal(sublineFor(undefined, undefined), '')
  assert.ok(sublineFor('cc-' + 'r'.repeat(80), 'Claude needs your permission to use Bash').length <= 60)
})

test('a hook-posted card gains a subline without a headline being invented', async (t) => {
  const { post, base } = await startHarness(t)
  // Exactly what hooks/ledge-notify sends: no title, no headline, no subline.
  await post('/activity', {
    lane: 'cc-ledge', template: 'needs_you', tone: 'warn',
    line: 'Claude needs your permission to use AskUserQuestion',
  })
  const { lanes } = await (await fetch(base + '/lanes', { headers: { authorization: 'Bearer tok' } })).json()
  const card = lanes['cc-ledge']
  assert.equal(card.subline, 'AskUserQuestion in ledge', 'the row under the line is filled')
  assert.equal(card.line, 'Claude needs your permission to use AskUserQuestion')
  assert.ok(!('headline' in card), 'headline stays absent; the phone falls back to line')
})

test('the fill never clobbers the frozen identity a poller card established', async (t) => {
  const { post, base } = await startHarness(t)
  const read = async () =>
    (await (await fetch(base + '/lanes', { headers: { authorization: 'Bearer tok' } })).json()).lanes['cc-ledge']

  // The poller names the card.
  await post('/activity', {
    lane: 'cc-ledge', template: 'progress', tone: 'neutral', title: 'Lock screen agent',
    line: 'editing card.mts', headline: 'editing card.mts', subline: '~/Desktop/Playground/ledge',
  })
  assert.equal((await read()).title, 'Lock screen agent')

  // The hook posts over it with no title at all, the way ledge-notify does.
  await post('/activity', {
    lane: 'cc-ledge', template: 'needs_you', tone: 'warn',
    line: 'Claude needs your permission to use Bash',
  })
  const after = await read()
  assert.equal(after.title, 'Lock screen agent', 'the name the card was given survives the hook')
  assert.equal(after.subline, 'Bash in ledge', 'and the derived subline replaces the stale one')
  assert.equal(after.state, 'asking')
})

test('a sender that supplies a subline is never second-guessed', async (t) => {
  const { post, base } = await startHarness(t)
  await post('/activity', {
    lane: 'cc-ledge', template: 'needs_you', tone: 'warn',
    line: 'Claude needs your permission to use Bash', subline: 'said it itself',
  })
  const { lanes } = await (await fetch(base + '/lanes', { headers: { authorization: 'Bearer tok' } })).json()
  assert.equal(lanes['cc-ledge'].subline, 'said it itself')
})
