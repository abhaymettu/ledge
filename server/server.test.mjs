// node --test server/
// Covers the two pieces that silently corrupt pushes when wrong: the boundary
// validator and the 30s coalescer. The APNs sender is a stub; nothing here talks
// to Apple.

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPayload } from './apns.mjs'
import {
  validateActivity,
  validateEnd,
  contentStateFor,
  Coalescer,
  TITLE_MAX,
  LINE_MAX,
  COALESCE_MS,
} from './server.mjs'

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
import { createHandler } from './server.mjs'
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
  const state = { pushToStartToken: 'pts', deviceToken: 'dev', lanes: {} }
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
  assert.equal(lanes['cc-a'].template, 'progress')
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
  await post('/register', { pushToStartToken: 'pts', deviceToken: 'dev' })
  assert.deepEqual(forgotten, [], 'the same token again leaves live cards alone')
  await post('/register', { pushToStartToken: 'pts2', deviceToken: 'dev' })
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
      contentState: { template: 'needs_you', tone: 'warn', startedAt: ago(mins) },
    }).aps['relevance-score']
  assert.ok(score(30) > score(5), 'ignored longer must outrank freshly asked')
  assert.ok(score(5) > score(0))
  assert.ok(score(120) <= 100, 'never exceeds the 0-100 range Apple accepts')
  assert.ok(score(0) >= 90, 'any waiting card still outranks working and result')
})

test('relevance: a stuck session outranks a finished one but not a question', () => {
  const of = (cs) => buildPayload({ event: 'update', contentState: cs }).aps['relevance-score']
  const stuck = of({ template: 'progress', tone: 'warn' })
  assert.ok(stuck > of({ template: 'result', tone: 'ok' }), 'stuck beats done')
  assert.ok(stuck > of({ template: 'progress', tone: 'neutral' }), 'stuck beats healthy work')
  assert.ok(stuck < of({ template: 'needs_you', tone: 'warn' }), 'a real question still wins')
})

test('relevance: a blocked lane outranks a working one in the Dynamic Island', () => {
  const score = (template, tone = 'neutral') =>
    buildPayload({ event: 'update', contentState: { template, tone } }).aps['relevance-score']
  assert.ok(score('needs_you') > score('result'), 'needs_you must outrank result')
  assert.ok(score('result') > score('progress'), 'result must outrank progress')
  assert.ok(score('progress', 'fail') > score('progress'), 'a failure must outrank a normal run')
  assert.equal(score('nonsense'), 20, 'unknown templates fall back, never undefined')
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
