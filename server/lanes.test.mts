import test from 'node:test'
import assert from 'node:assert/strict'
import { parseState, tokenArrived, ended, hold, started, inFlight, markHeld, START_GRACE_MS } from './lanes.mts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardFor, endFor, frozenIdentity, identityFor } from './card.mts'
import { createTitleSummariser } from './titles.mts'
import { validateActivity, validateEnd, contentStateFor } from './validate.mts'

const card = { state: 'working', title: 't', line: 'l' } as const

test('lanes: the state file the previous server wrote parses into the union', () => {
  const now = 1_000_000
  const s = parseState({
    pushToStartToken: 'pts',
    lanes: {
      live: { updateToken: 'tok', startedAt: 5, dirty: true, last: card },
      starting: { startPending: 900_000, startedAt: 7, dirty: false, last: card },
      broken: { startedAt: 1 },
    },
    pendingEnds: { old: { cs: card, at: now - 2 * 3600_000 }, fresh: { cs: card, at: now - 60_000 } },
  }, now)
  assert.deepEqual(s.lanes.live, { kind: 'live', token: 'tok', startedAt: 5, card, held: true })
  assert.deepEqual(s.lanes.starting, { kind: 'starting', since: 900_000, startedAt: 7, card, held: false })
  assert.equal(s.lanes.broken, undefined, 'a lane with no card cannot be rendered and is dropped')
  assert.deepEqual(Object.keys(s.pendingEnds), ['fresh'], 'parked ends older than an hour are dropped')
  assert.equal(parseState(null).pushToStartToken, null)
  const legacy = parseState({ lanes: { a: { updateToken: 'tok', last: { template: 'needs_you', tone: 'warn', title: 't', line: 'q?' } } } }, now)
  assert.deepEqual(legacy.lanes.a.card, { state: 'asking', title: 't', line: 'q?' }, 'a card written before CardState gets one and loses template/tone')
})

test('lanes: a token turns a starting lane live and returns what was held', () => {
  const s = parseState({}, 0)
  started(s, 'a', card, 1, 100)
  assert.equal(inFlight(s.lanes.a, 100 + START_GRACE_MS - 1), true)
  assert.equal(inFlight(s.lanes.a, 100 + START_GRACE_MS), false, 'past the grace a new start is allowed')
  const newer = { ...card, line: 'newer' }
  hold(s, 'a', newer, 1)
  assert.deepEqual(tokenArrived(s, 'a', 'tok'), { flush: newer })
  assert.deepEqual(s.lanes.a, { kind: 'live', token: 'tok', startedAt: 1, card: newer, held: false })
  assert.deepEqual(tokenArrived(s, 'nope', 'tok'), { ghost: true })
})

test('lanes: ending a starting lane parks the end; the token fires it and wins over going live', () => {
  const s = parseState({}, 0)
  started(s, 'a', card, 1, 100)
  assert.deepEqual(ended(s, 'a', card, 200), { parked: true })
  assert.equal(s.lanes.a, undefined)
  assert.deepEqual(tokenArrived(s, 'a', 'tok'), { parked: { card, at: 200 } })
  assert.equal(s.lanes.a, undefined, 'the parked end must not resurrect the lane')
  assert.equal(ended(s, 'a', card), null, 'ending a lane that is not there')
  markHeld(s)
})

// ── identity and act ──────────────────────────────────────────────────────

test('identityFor: the name a card keeps, name then cwd basename then pid', () => {
  assert.equal(identityFor({ cwd: '/Users/abhay/Desktop/Playground/ledge' }), 'ledge')
  assert.equal(identityFor({ name: 'Career-Ops', cwd: '/tmp/x' }), 'career-ops')
  assert.equal(identityFor({ pid: 4711 }), '4711')
  assert.equal(identityFor({ cwd: '/a/' + 'x'.repeat(40) }), 'x'.repeat(23) + '…', 'capped, never wraps')
})

test('identity is stable while the summarised title churns', () => {
  const s: any = {
    pid: 1, sessionId: 'a', cwd: '/Users/abhay/Desktop/Playground/ledge',
    status: 'busy', statusUpdatedAt: 1_700_000_000_000, wake: null, question: '', said: '',
  }
  // Three ticks, three different summariser answers, one unchanging identity.
  const titles = ['Kalshi dead pool', 'Lock screen agent', 'Memecoin edge hunt']
  const cards = titles.map((t, i) => cardFor(s, t, `editing file${i}.mts`))
  assert.deepEqual(new Set(cards.map((c) => c.title)), new Set(['ledge']), 'the identity row never moves')
  assert.deepEqual(new Set(cards.map((c) => c.lane)), new Set(['cc-ledge']), 'and neither does the lane')
  assert.deepEqual(cards.map((c) => c.headline), ['editing file0.mts', 'editing file1.mts', 'editing file2.mts'])
  assert.deepEqual(cards.map((c) => c.subline), titles, 'the churn moves to the subline')
})

test('every state carries a headline, and headline never contradicts line', () => {
  const base: any = {
    pid: 1, sessionId: 'a', cwd: '/Users/abhay/Desktop/Playground/ledge',
    status: 'idle', statusUpdatedAt: 1_700_000_000_000, wake: null, question: '', said: '',
  }
  const cases: [string, any, any[]][] = [
    ['working', { ...base, status: 'busy' }, ['t', 'editing card.mts', 0]],
    ['stuck', { ...base, status: 'busy' }, ['t', 'editing card.mts', 600_000]],
    ['asking', { ...base, question: 'which branch?' }, ['t', '', 0]],
    ['idle', { ...base, said: 'all done' }, ['t', '', 0]],
    ['resting', { ...base, wake: { reason: 'rate limit', at: 1, wakeAt: 2 } }, ['t', '', 0]],
  ]
  for (const [name, s, args] of cases) {
    const c = cardFor(s, args[0], args[1], args[2])
    assert.equal(c.state, name)
    assert.equal(c.headline, c.line, `${name}: headline mirrors line so an old build loses nothing`)
    // A subline is optional now: it says a fact about the session or it says
    // nothing and the act takes the row. What it may never be is the cwd.
    assert.ok(!c.subline?.includes('/') && c.subline !== '~', `${name}: no path in the subline`)
    assert.ok(c.headline!.length <= 60 && (c.subline?.length ?? 0) <= 60, `${name}: both fit LINE_MAX`)
  }
})

test('approval names the tool and the repo under the ask', () => {
  const s: any = {
    pid: 1, sessionId: 'a', cwd: '/Users/abhay/Desktop/Playground/ledge',
    status: 'busy', statusUpdatedAt: 1, wake: null, question: '', said: '',
  }
  const c = cardFor(s, 't', '', 0, undefined, {
    id: 'x', summary: 'rm -rf build', at: 1, tool: 'Bash', cwd: '/Users/abhay/Desktop/Playground/ledge',
  })
  assert.equal(c.state, 'approval')
  assert.equal(c.headline, 'allow: rm -rf build')
  assert.equal(c.subline, 'Bash in ledge')
  assert.equal(c.approvalId, 'x')
})

test('validate: headline and subline are optional, capped, and rejected when not strings', () => {
  const ok = validateActivity({ lane: 'cc-a', template: 'progress', tone: 'neutral', line: 'x' })
  assert.equal(ok.error, undefined)
  assert.equal(ok.value.headline, undefined, 'absent stays absent, so old senders are untouched')

  const long = validateActivity({
    lane: 'cc-a', template: 'progress', tone: 'neutral', line: 'x',
    headline: 'h'.repeat(200), subline: 's'.repeat(200),
  })
  assert.equal(long.value.headline.length, 60)
  assert.equal(long.value.subline.length, 60)

  assert.match(
    validateActivity({ lane: 'cc-a', template: 'progress', tone: 'neutral', line: 'x', headline: 7 }).error!,
    /headline must be a string/,
  )
  assert.match(
    validateActivity({ lane: 'cc-a', template: 'progress', tone: 'neutral', line: 'x', subline: 'y'.repeat(300) }).error!,
    /subline too long/,
  )
})

test('validate: /activity/end carries the outcome pair the poller cannot build', () => {
  const e = validateEnd({ lane: 'cc-a', line: 'tests green', headline: 'tests green', subline: '159 passing' })
  assert.equal(e.error, undefined)
  assert.equal(e.value.headline, 'tests green')
  assert.equal(e.value.subline, '159 passing')
  const bare = validateEnd({ lane: 'cc-a' })
  assert.equal(bare.value.line, 'done')
  assert.equal(bare.value.headline, undefined, 'nothing invented when the caller sends nothing')
})

test('contentStateFor: both fields reach the card, absent ones stay absent', () => {
  const full = contentStateFor({ template: 'progress', tone: 'neutral', lane: 'cc-a', line: 'l', headline: 'h', subline: 's' }, {})
  assert.equal(full.headline, 'h')
  assert.equal(full.subline, 's')
  const thin = contentStateFor({ template: 'progress', tone: 'neutral', lane: 'cc-a', line: 'l' }, {})
  assert.ok(!('headline' in thin), 'no empty keys on the wire')
  assert.ok(!('subline' in thin))
})

// ── what a card says on the way out ───────────────────────────────────────

test('endFor: the last act and how long that state had run', () => {
  const now = 1_700_000_000_000
  assert.deepEqual(
    endFor({ state: 'working', headline: 'editing card.mts', line: 'editing card.mts', startedAt: now - 8_040_000 }, now),
    { headline: 'editing card.mts', subline: 'working for 2h 14m' },
  )
  assert.deepEqual(
    endFor({ state: 'idle', line: 'captured 4 notes', startedAt: now - 720_000 }, now),
    { headline: 'captured 4 notes', subline: 'idle for 12m' },
    'falls back to line when the card predates headline',
  )
  assert.deepEqual(
    endFor({ state: 'stuck', headline: 'no output for 11m', line: 'no output for 11m', startedAt: now - 3_600_000 }, now),
    { headline: 'no output for 11m', subline: 'stuck for 1h 0m' },
  )
})

test('endFor: vanishing mid question is the one real outcome', () => {
  const now = 1_700_000_000_000
  for (const state of ['asking', 'approval'] as const) {
    assert.deepEqual(
      endFor({ state, headline: 'which branch?', line: 'which branch?', startedAt: now - 2_460_000 }, now),
      { headline: 'closed while waiting on you', subline: '41m unanswered' },
      `${state} reports the ending, not the question that died with it`,
    )
  }
})

test('endFor: invents nothing when it knows nothing', () => {
  const now = 1_700_000_000_000
  assert.deepEqual(endFor(undefined, now), {}, 'a lane adopted from the state file')
  assert.deepEqual(endFor({ state: 'working', line: '', startedAt: 0 }, now), {}, 'no act, no clock')
  assert.deepEqual(
    endFor({ state: 'working', line: 'editing card.mts', startedAt: now - 20_000 }, now),
    { headline: 'editing card.mts' },
    'under a minute gets no duration rather than "0m"',
  )
})

test('endFor: both fields fit the 35 narrow characters the smallest card holds', () => {
  const now = 1_700_000_000_000
  const longest = endFor(
    { state: 'asking', headline: 'x'.repeat(60), line: 'x'.repeat(60), startedAt: now - 359_940_000 },
    now,
  )
  assert.equal(longest.headline, 'closed while waiting on you')
  assert.ok(longest.headline!.length <= 35, 'the loud row fits at full size')
  assert.ok(longest.subline!.length <= 35, `subline was ${longest.subline}`)
  // The other branch inherits the act, so it is capped where every headline is.
  const act = endFor({ state: 'working', headline: 'y'.repeat(200), line: '', startedAt: now - 120_000 }, now)
  assert.ok(act.headline!.length <= 60, 'never past LINE_MAX')
})

test('endFor: failed is not reachable from the poller, and none is faked', () => {
  const now = 1_700_000_000_000
  // Every ending the poller sends omits tone, so validateEnd defaults it to ok
  // and the card resolves to done. A failure would need a signal the poller
  // does not have, so it never claims one.
  const out = endFor({ state: 'working', headline: 'running tests', line: 'running tests', startedAt: now - 600_000 }, now)
  assert.ok(!('tone' in out), 'endFor never sets tone')
  const v = validateEnd({ lane: 'cc-a', ...out })
  assert.equal(v.value.tone, 'ok')
  assert.equal(contentStateFor({ template: 'result', lane: 'cc-a', ...v.value }, {}).state, 'done')
})

// ── the name a card keeps ─────────────────────────────────────────────────

test('frozenIdentity: the first title wins, the cwd holds the row until there is one', () => {
  const s = { cwd: '/Users/abhay/Desktop/Playground/ledge' }
  assert.equal(frozenIdentity(s, undefined), 'ledge', 'no title yet')
  assert.equal(frozenIdentity(s, ''), 'ledge', 'an empty title is not a title')
  assert.equal(frozenIdentity(s, '   '), 'ledge', 'nor is whitespace')
  assert.equal(frozenIdentity(s, 'Kalshi dead pool'), 'Kalshi dead pool')
  assert.equal(frozenIdentity(s, 'a'.repeat(40)).length, 24, 'capped like any identity')
})

test('a displayed name never changes again, whatever the summariser says later', () => {
  const s: any = {
    pid: 1, sessionId: 'a', cwd: '/Users/abhay/Desktop/Playground/ledge',
    status: 'busy', statusUpdatedAt: 1_700_000_000_000, wake: null, question: '', said: '',
  }
  // Once frozen, the rolling summary drifts through four different answers and
  // the name is asked to move every time. It must not.
  const frozen = 'Kalshi dead pool'
  const rolling = ['Kalshi dead pool', 'Lock screen agent', 'Memecoin edge hunt', 'Paper trader fix']
  const cards = rolling.map((t) => cardFor(s, t, 'editing card.mts', 0, undefined, undefined, frozen))
  assert.deepEqual(new Set(cards.map((c) => c.title)), new Set([frozen]), 'one name, forever')
  assert.deepEqual(new Set(cards.map((c) => c.lane)), new Set(['cc-ledge']), 'and one lane')

  // The drift still shows, just never in the identity row, and never as an echo
  // of the name on the same card.
  assert.equal(cards[0].subline, undefined, 'the first summary is the name, so there is nothing left to add')
  assert.deepEqual(cards.slice(1).map((c) => c.subline), rolling.slice(1))
})

test('the frozen name survives a card the cwd fallback would have renamed', () => {
  // Same session, different cwd mid-run (a cd, a worktree). The fallback would
  // have moved; the frozen name does not.
  const base: any = {
    pid: 1, sessionId: 'a', status: 'busy', statusUpdatedAt: 1_700_000_000_000,
    wake: null, question: '', said: '',
  }
  const before = cardFor({ ...base, cwd: '/a/ledge' }, 't', 'x', 0, 'cc-ledge', undefined, 'Kalshi dead pool')
  const after = cardFor({ ...base, cwd: '/a/somewhere-else' }, 't', 'x', 0, 'cc-ledge', undefined, 'Kalshi dead pool')
  assert.equal(before.title, after.title)
  assert.equal(after.title, 'Kalshi dead pool')
})

test('titles cache: first is written once and survives a restart and a refresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledge-titles-'))
  const cache = path.join(dir, 'titles.json')
  let clock = 1_000_000
  const a = createTitleSummariser({ cachePath: cache, titleRefreshMs: 1, now: () => clock, run: async () => 'First Name' })
  a.request('s', 'a prose first prompt with plenty of words in it', 'fb')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(a.identity('s'), 'First Name')

  clock += 10_000
  a.refresh('s', clock, () => 'quite different context now')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(a.identity('s'), 'First Name', 'a refresh moves known, never identity')

  // A restart reads the frozen value off disk rather than re-freezing on the
  // rolling one, which is what would rename a card already on screen.
  const b = createTitleSummariser({ cachePath: cache, titleRefreshMs: 1, now: () => clock, run: async () => 'Third Name' })
  assert.equal(b.identity('s'), 'First Name')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('titles cache: a file written before first existed adopts its title, not a new one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledge-titles-old-'))
  const cache = path.join(dir, 'titles.json')
  fs.writeFileSync(cache, JSON.stringify({ s: { title: 'Old Shape', at: 1 }, t: 'Older Shape' }))
  const a = createTitleSummariser({ cachePath: cache, run: async () => 'ignored' })
  assert.equal(a.identity('s'), 'Old Shape', 'migrated in place')
  assert.equal(a.identity('t'), 'Older Shape', 'the bare string shape too')
  fs.rmSync(dir, { recursive: true, force: true })
})
