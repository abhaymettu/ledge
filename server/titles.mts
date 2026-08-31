import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

export const TITLES_PATH = path.join(os.homedir(), '.ledge', 'titles.json')
const SUMMARISE_TIMEOUT_MS = 20_000

const claudeBin =
  [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].find((c) => { try { fs.accessSync(c, fs.constants.X_OK); return true } catch { return false } }) ?? 'claude'

function claudeRun(instruction: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      claudeBin,
      ['-p', '--model', 'haiku', instruction],
      { timeout: SUMMARISE_TIMEOUT_MS, cwd: os.tmpdir() },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    )
  })
}

export function isPathPrompt(text: unknown) {
  const prose = String(text).replace(/\S*\/\S*/g, ' ').replace(/\s+/g, ' ').trim()
  return prose.split(/\s+/).filter(Boolean).length < 3
}

export function summariseTitle(context: unknown, run: (instruction: string) => Promise<string> = claudeRun, onError: (err: unknown) => void = () => {}): Promise<string | null> {
  const instruction =
    'Give a 2-4 word title for what this coding session is currently working on, ' +
    'based on this recent activity; answer with the title only.\n\n' +
    String(context).slice(0, 600)
  return run(instruction).then(
    (out) => {
      const t = String(out ?? '').trim()
      if (!t || t.includes('\n')) return null
      if (/^["'`“”‘’]|["'`“”‘’]$/.test(t)) return null
      // A title is a name, not a sentence, and this one sits directly above a
      // subline that never carries a full stop. Stripped before the checks below
      // so a title is measured at the length it will actually be shown at, which
      // lets a 32 character answer with a full stop through instead of failing
      // on a character that was about to be removed.
      const clean = t.replace(/[.!?…]+$/, '').trim()
      if (!clean) return null
      const words = clean.split(/\s+/).length
      return words >= 2 && words <= 5 && clean.length < 32 ? clean : null
    },
    (err) => {
      onError(err)
      return null
    },
  )
}

/** `title` is the rolling summary, refreshed on drift. `first` is the one the
 *  card is named after and is written exactly once. A cache from before `first`
 *  existed adopts its current title as the frozen one: it is the only candidate
 *  on disk and re-freezing later would rename a card that is already on screen. */
function readTitles(cachePath: string) {
  const out: Record<string, { title: string; at: number; first: string }> = Object.create(null)
  let o: any
  try {
    o = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  } catch {
    return out
  }
  for (const [k, v] of Object.entries(o ?? {}) as [string, any][]) {
    if (typeof v === 'string') out[k] = { title: v, at: 0, first: v }
    else if (typeof v?.title === 'string' && typeof v.at === 'number') {
      out[k] = { title: v.title, at: v.at, first: typeof v.first === 'string' ? v.first : v.title }
    }
  }
  return out
}

function writeTitles(cachePath: string, done: Record<string, unknown>, log: (line: string) => void) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath + '.tmp', JSON.stringify(done))
    fs.renameSync(cachePath + '.tmp', cachePath)
  } catch (e) {
    log(`[sessions] titles cache write failed: ${(e as Error).message}`)
  }
}

export function needsRefresh(lastAt: number | undefined, mtimeMs: number, titleRefreshMs: number, now: number) {
  return lastAt !== undefined && now - lastAt >= titleRefreshMs && mtimeMs > lastAt
}

function singleWorker(perform: (sessionId: string, text: string) => Promise<void>) {
  const pending = new Map<string, string>()
  let inFlight = false
  function pump() {
    if (inFlight || pending.size === 0) return
    const first = pending.entries().next().value
    if (!first) return
    const [sessionId, text] = first
    pending.delete(sessionId)
    inFlight = true
    perform(sessionId, text).finally(() => {
      inFlight = false
      pump()
    })
  }
  return {
    pending,
    push(sessionId: string, text: string) {
      pending.set(sessionId, text)
      pump()
    },
  }
}

export function createTitleSummariser({
  enabled = true,
  run = undefined as ((instruction: string) => Promise<string>) | undefined,
  cachePath = TITLES_PATH,
  titleRefreshMs = 1_200_000,
  onTitle = (sessionId: string, title: string): void => {},
  log = console.log,
  now = Date.now,
} = {}) {
  const done = readTitles(cachePath)
  const attemptedAt = new Map(Object.entries(done).map(([k, v]) => [k, v.at]))
  const fallbacks = Object.create(null)
  let ok = enabled
  if (ok && !run) {
    run = claudeRun
    const [cmd, args]: [string, string[]] = claudeBin === 'claude' ? ['which', ['claude']] : ['test', ['-x', claudeBin]]
    execFile(cmd, args, (err) => {
      if (err) {
        ok = false
        log('[sessions] claude not found; title summarisation off')
      }
    })
  }
  async function perform(sessionId: string, text: string) {
    const at = now()
    attemptedAt.set(sessionId, at)
    const title = await summariseTitle(text, run, (err: any) => {
      const why = String(err?.stderr || err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 120)
      log(`[sessions] title summarise failed: ${why}`)
    })
    if (!title) return
    // The rolling half moves; the frozen half is set by whichever summarisation
    // lands first and is never touched again.
    done[sessionId] = { title, at, first: done[sessionId]?.first ?? title }
    delete fallbacks[sessionId]
    writeTitles(cachePath, done, log)
    onTitle(sessionId, title)
  }
  const worker = singleWorker(perform)
  function submit(sessionId: string, text: string) {
    if (isPathPrompt(text)) attemptedAt.set(sessionId, now())
    else worker.push(sessionId, text)
  }
  return {
    known: (sessionId: string) => done[sessionId]?.title,
    /** The name the card keeps. Undefined until a title has been produced, and
     *  never a second value after that. */
    identity: (sessionId: string) => done[sessionId]?.first,
    label: (sessionId: string) => done[sessionId]?.title ?? fallbacks[sessionId],
    request(sessionId: string, prompt: string, fallback: string) {
      if (!ok || attemptedAt.has(sessionId)) return
      fallbacks[sessionId] ??= fallback
      submit(sessionId, prompt)
    },
    refresh(sessionId: string, mtimeMs: number, getContext: () => string) {
      if (!ok || worker.pending.has(sessionId)) return
      if (needsRefresh(attemptedAt.get(sessionId), mtimeMs, titleRefreshMs, now())) {
        submit(sessionId, getContext())
      }
    },
  }
}

