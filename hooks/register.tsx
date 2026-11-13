import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AgentCard, Architect, Bucket, Check, Gate, Layout, LogLine, Loop, Bg, BgItem, Day, Kit, Main, Plan, PlanItem, Repo, Roster, Tokens, Turn, Usage, View } from '../types'
import {
  DEFAULT_ARCHITECT,
  addCard,
  resumeCard,
  DEFAULT_GATE,
  DEFAULT_MAIN,
  DEFAULT_ROSTER,
  DEFAULT_TURN,
  DEFAULT_USAGE,
  DEFAULT_VIEW,
  EDIT_TOOLS,
  SCHEMA_VERSION,
  afterCall,
  applyStep,
  bucketOf,
  cellWidth,
  piecesThatFit,
  cardTitle,
  afterCompactHooked,
  afterCompactRead,
  afterFillRead,
  afterResponse,
  claimCompactRead,
  compactMark,
  contextFill,
  faultKey,
  forgetCompactRead,
  knowsMono,
  titleLines,
  consultTimeline,
  describeInput,
  endConsult,
  fitLegend,
  fmtClock,
  fmtDuration,
  fmtTimer,
  fmtUsd,
  plural,
  gateSummary,
  gauge,
  isAdvising,
  isLoopActive,
  kTokens,
  lanes,
  limitLabel,
  limitOf,
  fmtResetIn,
  fmtSpeed,
  listOf,
  logRows,
  marksIn,
  momentOf,
  normalize,
  normalizeCard,
  normalizeGate,
  normalizeLog,
  noteTool,
  PALETTES,
  SVG_COLORS,
  parseConfig,
  prettyModel,
  promptLine,
  handbackOf,
  adviceLine,
  receiptOf,
  recordCheck,
  settleCheck,
  shorten,
  startConsult,
  stepSpeed,
  stepLoop,
} from './core'
import type { Config, Panel } from './core'

const PANE = 'flightdeck'
const TITLE = 'Flightdeck'


// ---------------------------------------------------------------- state

const meta = atom({ plugin: 'flightdeck', key: 'meta' } as const, { schemaVersion: SCHEMA_VERSION })
const main = atom({ plugin: 'flightdeck', key: 'main' } as const, DEFAULT_MAIN)
const usage = atom({ plugin: 'flightdeck', key: 'usage' } as const, DEFAULT_USAGE)
const architect = atom({ plugin: 'flightdeck', key: 'architect' } as const, DEFAULT_ARCHITECT)
const gate = atom({ plugin: 'flightdeck', key: 'gate' } as const, DEFAULT_GATE)
const agents = atom({ plugin: 'flightdeck', key: 'agents' } as const, [])
const loops = atom({ plugin: 'flightdeck', key: 'loops' } as const, [])
const log = atom({ plugin: 'flightdeck', key: 'log' } as const, [])
const turn = atom({ plugin: 'flightdeck', key: 'turn' } as const, DEFAULT_TURN)
const receipt = atom({ plugin: 'flightdeck', key: 'receipt' } as const, null)
const view = atom({ plugin: 'flightdeck', key: 'view' } as const, DEFAULT_VIEW)
const roster = atom({ plugin: 'flightdeck', key: 'roster' } as const, DEFAULT_ROSTER)
const DEFAULT_REPO: Repo = { dir: '', sessionId: '', isRepo: false, branch: null, sha: null, dirty: 0, ahead: 0, behind: 0, mod: 0, untracked: 0, del: 0 }
const repo = atom({ plugin: 'flightdeck', key: 'repo' } as const, DEFAULT_REPO)

const DEFAULT_TOKENS: Tokens = { in: 0, cacheRead: 0, out: 0, samples: [], lastMainAt: null, cacheTtlMs: 300_000 }
const tokens = atom({ plugin: 'flightdeck', key: 'tokens' } as const, DEFAULT_TOKENS)
const RATE_MS = 60_000 // t/m: input + output tokens of the last minute, as yas counts it
const SPARK_WINDOW_MS = 120_000 // the sparkline spans two minutes, as yas's does
const SAMPLE_MS = 30 * 60_000 // samples kept for the sparkline

type StepTokens =
  | {
      input_tokens?: number | null
      cache_read_input_tokens?: number | null
      cache_creation_input_tokens?: number | null
      output_tokens?: number | null
      cache_creation?: { ephemeral_1h_input_tokens?: number | null; ephemeral_5m_input_tokens?: number | null } | null
    }
  | null
  | undefined

/** Adds one model request's usage (main loop or a subagent) to the session totals; a main-loop
 *  request also restarts the prompt cache's clock, with the lifetime its cache writes asked for. */
async function addTokens($: EngineInterface, u: StepTokens, isMain = false, agentId?: string) {
  if (!u) return
  const inp = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  const cr = u.cache_read_input_tokens ?? 0
  const out = u.output_tokens ?? 0
  const at = await $.clock.now()
  const ttl = (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0 ? 3_600_000 : (u.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0 ? 300_000 : null
  await update($, tokens, x => {
    const t = normalize(DEFAULT_TOKENS, x)
    const samples = [...listOf<{ at: number; n: number }>(t.samples), { at, n: inp + out }].filter(s => at - s.at <= SAMPLE_MS).slice(-400)
    const sIn = t.in + inp
    const sOut = t.out + out
    // yas's TokenRate samples: cumulative totals with their time, kept 300 s (TokenRate.KEEP).
    const rows = [...listOf<[number, number, number]>(t.rows ?? []), [at / 1000, sIn, sOut] as [number, number, number]].filter(r => at / 1000 - r[0] <= 300)
    return {
      ...t,
      in: sIn,
      cacheRead: t.cacheRead + cr,
      out: sOut,
      samples,
      rows,
      ...(isMain ? { lastMainAt: at, cacheTtlMs: ttl ?? t.cacheTtlMs } : {}),
      ...(agentId
        ? (() => {
            const all = { ...(t.byAgent ?? {}) }
            const a = all[agentId] ?? { in: 0, out: 0, samples: [] }
            all[agentId] = { in: a.in + inp + cr, out: a.out + out, samples: [...a.samples, { at, n: inp + out }].filter(s => at - s.at <= RATE_MS).slice(-60) }
            return { byAgent: all }
          })()
        : {}),
    }
  })
}

const DEFAULT_KIT: Kit = { skills: [], plugins: [] }
const kit = atom({ plugin: 'flightdeck', key: 'kit' } as const, DEFAULT_KIT)

/** The plugins enabled in the merged settings, by their name (`yas@yet-another-statusline` → `yas`). */
async function refreshPlugins($: EngineInterface) {
  const enabled = (await $.settings.read({ key: 'enabledPlugins' }).catch(() => null)) as Record<string, unknown> | null
  const plugins = enabled && typeof enabled === 'object' ? Object.keys(enabled).filter(k => enabled[k] === true).map(k => k.split('@')[0]!) : []
  await update($, kit, x => ({ ...normalize(DEFAULT_KIT, x), plugins }))
}

const DEFAULT_PLAN: Plan = { items: [], firstAt: null, doneAt: null }
const plan = atom({ plugin: 'flightdeck', key: 'plan' } as const, DEFAULT_PLAN)

/** Folds one task-tool call into the plan: TaskCreate adds, TaskUpdate moves or renames, TodoWrite replaces. */
async function notePlan($: EngineInterface, tool: string, input: Record<string, unknown>, result: unknown) {
  if (tool !== 'TaskCreate' && tool !== 'TaskUpdate' && tool !== 'TodoWrite') return
  const at = await $.clock.now()
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  await update($, plan, x => {
    const p = normalize(DEFAULT_PLAN, x)
    let items: PlanItem[] = listOf<PlanItem>(p.items)
    if (tool === 'TaskCreate') {
      const r = (result ?? {}) as { task?: { id?: unknown; subject?: unknown } }
      const id = str(r.task?.id) || String(items.length + 1)
      if (items.every(i => i.status === 'completed') && p.doneAt !== null) items = []
      items = [...items.filter(i => i.id !== id), { id, subject: str(input.subject) || str(r.task?.subject), active: str(input.activeForm), status: 'pending', startedAt: null, endedAt: null }]
    } else if (tool === 'TaskUpdate') {
      const id = str(input.taskId)
      const status = str(input.status)
      items = items
        .map(i => {
          if (i.id !== id) return i
          const next = { ...i, subject: str(input.subject) || i.subject, active: str(input.activeForm) || i.active }
          if (status && status !== i.status) {
            next.status = status
            if (status === 'in_progress') next.startedAt = next.startedAt ?? at
            if (status === 'completed') next.endedAt = at
          }
          return next
        })
        .filter(i => i.status !== 'deleted')
    } else {
      const todos = Array.isArray(input.todos) ? (input.todos as { content?: unknown; status?: unknown; activeForm?: unknown }[]) : []
      items = todos.map((t, n) => {
        const subject = str(t.content)
        const old = items.find(i => i.subject === subject)
        const status = str(t.status) || 'pending'
        return {
          id: String(n + 1),
          subject,
          active: str(t.activeForm),
          status,
          startedAt: old?.startedAt ?? (status === 'in_progress' ? at : null),
          endedAt: status === 'completed' ? (old?.endedAt ?? at) : null,
        }
      })
    }
    const allDone = items.length > 0 && items.every(i => i.status === 'completed')
    return { items, firstAt: items.length === 0 ? null : (p.firstAt ?? at), doneAt: allDone ? (p.doneAt ?? at) : null }
  })
}

const DEFAULT_BG: Bg = { items: [] }
const bg = atom({ plugin: 'flightdeck', key: 'bg' } as const, DEFAULT_BG)

/** A background shell or workflow launched (from its tool call's result), or stopped by TaskStop. */
async function noteBg($: EngineInterface, tool: string, input: Record<string, unknown>, result: unknown) {
  const r = (result ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const at = await $.clock.now()
  let item: BgItem | null = null
  if (tool === 'Bash' && str(r.backgroundTaskId)) {
    item = { id: str(r.backgroundTaskId), kind: 'shell', label: str(input.description) || str(input.command), status: 'running', startedAt: at, endedAt: null }
  } else if (tool === 'Workflow' && str(r.taskId)) {
    item = { id: str(r.taskId), kind: 'workflow', label: str(r.workflowName) || 'workflow', status: 'running', startedAt: at, endedAt: null }
  } else if (tool === 'TaskStop') {
    const id = str(r.task_id) || str(input.task_id) || str(input.shell_id)
    if (id) await endBg($, id, 'killed')
    return
  }
  if (item) {
    const it = item
    await update($, bg, x => ({ items: [...listOf<BgItem>(normalize(DEFAULT_BG, x).items).filter(i => i.id !== it.id), it].slice(-20) }))
  }
}

async function endBg($: EngineInterface, id: string, status: string) {
  const at = await $.clock.now()
  await update($, bg, x => ({
    items: listOf<BgItem>(normalize(DEFAULT_BG, x).items).map(i => (i.id === id && i.endedAt === null ? { ...i, status, endedAt: at } : i)),
  }))
}

const DEFAULT_DAY: Day = { has: false, sIn: 0, sCr: 0, sOut: 0, dIn: 0, dCr: 0, dOut: 0 }
const day = atom({ plugin: 'flightdeck', key: 'day' } as const, DEFAULT_DAY)

/** Reads yas's token log: one line per session, `date session in cacheRead out`, rewritten as yas renders. */
const todayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
type DayBook = Record<string, Record<string, [number, number, number]>>

/** What a session already filed under days other than `day`: each day keeps only that day's increase,
 *  so a session that runs past midnight isn't counted on both days. */
const filedBefore = (book: DayBook, sid: string, day: string): [number, number, number] =>
  Object.entries(book)
    .filter(([d]) => d !== day)
    .reduce<[number, number, number]>((a, [, v]) => {
      const e = v?.[sid]
      return e ? [a[0] + e[0], a[1] + e[1], a[2] + e[2]] : a
    }, [0, 0, 0])

/** Flightdeck's own day book in $.store (kept between sessions): per date, each session's [in, cacheRead, out].
 *  Written from the session's totals; the last seven days are kept. */
async function persistDay($: EngineInterface) {
  const [sid, raw] = await Promise.all([$.session.id().catch(() => ''), $.store.get('days').catch(() => undefined)])
  if (!sid) return
  const t = normalize(DEFAULT_TOKENS, await read($, tokens))
  if (t.in + t.cacheRead + t.out === 0) return
  const book: DayBook = raw && typeof raw === 'object' ? (raw as DayBook) : {}
  const today = todayKey()
  const was = book[today]?.[sid]
  const prev = filedBefore(book, sid, today)
  const now: [number, number, number] = [Math.max(0, t.in - prev[0]), Math.max(0, t.cacheRead - prev[1]), Math.max(0, t.out - prev[2])]
  if (was && was[0] === now[0] && was[1] === now[1] && was[2] === now[2]) return
  book[today] = { ...(book[today] ?? {}), [sid]: now }
  for (const k of Object.keys(book).sort().slice(0, -7)) delete book[k]
  await $.store.set('days', book)
}

/** A resumed session's totals come back from the day book, so its figures don't start over at a restart. */
async function seedTokens($: EngineInterface) {
  const t = normalize(DEFAULT_TOKENS, await read($, tokens))
  if (t.in + t.cacheRead + t.out > 0) return
  const [sid, raw] = await Promise.all([$.session.id().catch(() => ''), $.store.get('days').catch(() => undefined)])
  const book: DayBook = raw && typeof raw === 'object' ? (raw as DayBook) : {}
  if (!sid) return
  const hit = filedBefore(book, sid, '')
  if (hit[0] + hit[1] + hit[2] > 0) await update($, tokens, x => ({ ...normalize(DEFAULT_TOKENS, x), in: hit[0], cacheRead: hit[1], out: hit[2] }))
}

/** Session and today's totals from Flightdeck's own day book, with this session's live totals. */
async function refreshDay($: EngineInterface) {
  const [sid, raw] = await Promise.all([$.session.id().catch(() => ''), $.store.get('days').catch(() => undefined)])
  const book: DayBook = raw && typeof raw === 'object' ? (raw as DayBook) : {}
  const t = normalize(DEFAULT_TOKENS, await read($, tokens))
  const today = todayKey()
  const prev = sid ? filedBefore(book, sid, today) : ([0, 0, 0] as [number, number, number])
  const mine: [number, number, number] = [Math.max(0, t.in - prev[0]), Math.max(0, t.cacheRead - prev[1]), Math.max(0, t.out - prev[2])]
  const sessions = { ...(book[today] ?? {}), ...(sid ? { [sid]: mine } : {}) }
  const r: Day = { ...DEFAULT_DAY, has: true, source: 'flightdeck', sIn: t.in, sCr: t.cacheRead, sOut: t.out }
  for (const v of Object.values(sessions)) Object.assign(r, { dIn: r.dIn + v[0], dCr: r.dCr + v[1], dOut: r.dOut + v[2] })
  await update($, day, () => r)
}

/** Reads the session's directory, id and git state (one `git status`, read-only). */
async function refreshRepo($: EngineInterface) {
  const [dir, sessionId] = await Promise.all([$.session.cwd().catch(() => ''), $.session.id().catch(() => '')])
  const r: Repo = { ...DEFAULT_REPO, dir, sessionId }
  const g = dir ? await $.process.run(['git', 'status', '--porcelain=v2', '--branch'], { cwd: dir, timeoutMs: 3000 }).catch(() => null) : null
  if (g && g.exitCode === 0) {
    r.isRepo = true
    for (const l of g.stdout.split('\n')) {
      if (l.startsWith('# branch.oid ')) {
        const oid = l.slice(13).trim()
        r.sha = oid === '(initial)' ? null : oid.slice(0, 9)
      } else if (l.startsWith('# branch.head ')) {
        const head = l.slice(14).trim()
        r.branch = head === '(detached)' ? null : head
      } else if (l.startsWith('# branch.ab ')) {
        const [a, b] = l.slice(12).trim().split(' ')
        r.ahead = Math.abs(parseInt(a ?? '0', 10)) || 0
        r.behind = Math.abs(parseInt(b ?? '0', 10)) || 0
      } else if (l && !l.startsWith('#')) {
        r.dirty++
        if (l.startsWith('? ')) r.untracked = (r.untracked ?? 0) + 1
        else {
          const xy = l.split(' ')[1] ?? ''
          if (xy.includes('D')) r.del = (r.del ?? 0) + 1
          else r.mod = (r.mod ?? 0) + 1
        }
      }
    }
  }
  await update($, repo, () => r)
}

// yas's context gradient (green → amber → red → pink → violet) and its Dumbometer words.
const GRAD: [number, [number, number, number]][] = [
  [0.0, [150, 200, 120]],
  [0.35, [214, 170, 110]],
  [0.65, [226, 116, 116]],
  [0.85, [226, 106, 150]],
  [1.0, [190, 120, 232]],
]
function grad(t: number): string {
  const x = Math.max(0, Math.min(1, t))
  let c = GRAD[GRAD.length - 1]![1]
  for (let i = 1; i < GRAD.length; i++) {
    const [t0, c0] = GRAD[i - 1]!
    const [t1, c1] = GRAD[i]!
    if (x <= t1) {
      const k = (x - t0) / (t1 - t0)
      c = [0, 1, 2].map(j => Math.round(c0[j]! + (c1[j]! - c0[j]!) * k)) as [number, number, number]
      break
    }
  }
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')
}
const CTX_WORDS = ['Smart', 'Coasting', 'Foggy', 'Cooked', 'Dumb']
const CTX_STEPS = [25, 50, 70, 90]
const ctxWord = (pct: number) => CTX_WORDS[Math.min(CTX_WORDS.length - 1, CTX_STEPS.filter(s => pct >= s).length)]!

/** `/home/me/Work/x` → `~/W/x`: home as ~, middle folders by their first letter, the last kept whole. */
function shortDir(dir: string): string {
  const parts = dir.replace(/^\/(home|Users)\/[^/]+/, '~').split('/')
  return parts.map((p, i) => (i === 0 || i === parts.length - 1 || p.length <= 1 ? p : p.startsWith('.') ? p.slice(0, 2) : p[0])).join('/')
}

type ServerBlock = { type: string; id?: string; name?: string; tool_use_id?: string }

// Every read goes through these, so a value saved under an older shape still reads.
async function getMain($: EngineInterface): Promise<Main> {
  return normalize(DEFAULT_MAIN, await read($, main))
}
async function getUsage($: EngineInterface): Promise<Usage> {
  return normalize(DEFAULT_USAGE, await read($, usage))
}
/** Whether this engine's Text takes `mono`; false when it can't say, or has no `$.session.version` to ask. */
async function readMono($: EngineInterface): Promise<boolean> {
  try {
    return knowsMono(await $.session.version())
  } catch {
    return false
  }
}
async function getArchitect($: EngineInterface): Promise<Architect> {
  const a = normalize(DEFAULT_ARCHITECT, await read($, architect))
  return { ...a, consults: listOf(a.consults), ids: listOf(a.ids), seen: listOf(a.seen) }
}
async function getGate($: EngineInterface): Promise<Gate> {
  return normalizeGate(await read($, gate))
}
async function getCards($: EngineInterface): Promise<AgentCard[]> {
  return listOf<unknown>(await read($, agents)).map(normalizeCard)
}
async function getLoops($: EngineInterface): Promise<Loop[]> {
  return listOf<Loop>(await read($, loops))
}
async function getLog($: EngineInterface): Promise<LogLine[]> {
  return normalizeLog(await read($, log))
}
async function getTurn($: EngineInterface): Promise<Turn> {
  return normalize(DEFAULT_TURN, await read($, turn))
}
async function getView($: EngineInterface): Promise<View> {
  return normalize(DEFAULT_VIEW, await read($, view))
}
async function getRoster($: EngineInterface): Promise<Roster> {
  const r = normalize(DEFAULT_ROSTER, await read($, roster))
  return { architectTypes: listOf(r.architectTypes) }
}

/** A stored shape older than this build's: drop what cannot be read, keep the rest. */
async function migrate($: EngineInterface) {
  const m = await read($, meta)
  if ((m?.schemaVersion ?? 0) >= SCHEMA_VERSION) return
  await update($, log, list => normalizeLog(list))
  await update($, agents, list => listOf<unknown>(list).map(normalizeCard))
  await update($, gate, g => normalizeGate(g))
  await update($, meta, () => ({ schemaVersion: SCHEMA_VERSION }))
}

async function say($: EngineInterface, who: string, text: string, kind: LogLine['kind'] = 'info', agentId: string | null = null) {
  const line: LogLine = { at: await $.clock.now(), who, text, kind, agentId }
  await update($, log, list => [...normalizeLog(list), line].slice(-60))
}

async function refreshStatus($: EngineInterface, cfg: Config) {
  if (!cfg.statusLine) return $.ui.status(undefined)
  const [u, a, g, cards] = await Promise.all([getUsage($), getArchitect($), getGate($), getCards($)])
  const running = cards.filter(c => c.status === 'running').length
  const s = gateSummary(g)
  const ctxFill = contextFill(u)
  const parts = [
    ctxFill.pct !== null ? `ctx ${Math.round(ctxFill.pct)}%` : null,
    cards.length > 0 ? `agents ${running}/${cards.length}` : null,
    a.consults.length > 0 || a.ids.length > 0 ? `${cfg.architectLabel.toLowerCase()} ${isAdvising(a) ? 'advising' : a.consults.length}` : null,
    s.deny > 0 ? `denied ${s.deny}` : null,
  ]
  // Only fields with something to say; with none, no status entry at all.
  const shown = parts.filter(Boolean)
  $.ui.status(shown.length > 0 ? shown.join(' · ') : undefined)
}

async function whoIs($: EngineInterface, agentId: string | undefined) {
  if (!agentId) return 'main'
  const card = (await getCards($)).find(c => c.id === agentId)
  return card ? shorten(cardTitle(card), 14) : 'agent'
}

async function consultStarted($: EngineInterface, cfg: Config, id: string, via: string) {
  const t = await getTurn($)
  const moment = momentOf(t)
  const at = await $.clock.now()
  await update($, architect, a => startConsult(normalize(DEFAULT_ARCHITECT, a), { id, at, moment, via }))
  if (moment === 'before done') await update($, turn, x => ({ ...normalize(DEFAULT_TURN, x), isReviewing: true }))
  await say($, cfg.architectLabel.toLowerCase(), cfg.moments ? `${moment} · ${via}` : `consulted · ${via}`, 'consult')
  await refreshStatus($, cfg)
}

async function consultEnded($: EngineInterface, cfg: Config, advice: string | null, id?: string) {
  const at = await $.clock.now()
  const first = advice?.split('\n').find(l => l.trim()) ?? null
  const text = first ? shorten(first.replace(/^[#>*\s-]+/, ''), 160) : null
  await update($, architect, a => endConsult(normalize(DEFAULT_ARCHITECT, a), at, text, id))
  await update($, turn, t => ({ ...normalize(DEFAULT_TURN, t), isReviewing: false }))
  await say($, cfg.architectLabel.toLowerCase(), text ? `advice: ${shorten(text, 60)}` : 'advice returned', 'consult')
  await refreshStatus($, cfg)
}

async function noteAdvice($: EngineInterface, cfg: Config, advice: string) {
  await update($, architect, x => ({ ...normalize(DEFAULT_ARCHITECT, x), lastAdvice: advice }))
  await say($, cfg.architectLabel.toLowerCase(), `advice: ${shorten(advice, 60)}`, 'consult')
}

async function isArchitectType($: EngineInterface, cfg: Config, type: string) {
  return cfg.architect.test(type) || (await getRoster($)).architectTypes.includes(type)
}

async function openPane($: EngineInterface, cfg: Config) {
  // columns apply when docked beside the transcript, rows when seated inline above the prompt.
  return $.ui.open({ id: PANE, title: TITLE, columns: cfg.paneColumns, rows: 8 })
}

async function resetAll($: EngineInterface) {
  await update($, main, m => ({ ...DEFAULT_MAIN, model: normalize(DEFAULT_MAIN, m).model, mode: normalize(DEFAULT_MAIN, m).mode }))
  await update($, architect, () => DEFAULT_ARCHITECT)
  await update($, gate, () => DEFAULT_GATE)
  await update($, agents, () => [])
  await update($, loops, () => [])
  await update($, log, () => [])
  await update($, turn, () => DEFAULT_TURN)
  await update($, receipt, () => null)
  await update($, view, () => DEFAULT_VIEW)
  await update($, tokens, () => DEFAULT_TOKENS)
  await update($, kit, x => ({ ...normalize(DEFAULT_KIT, x), skills: [] }))
  await update($, plan, () => DEFAULT_PLAN)
  await update($, bg, () => DEFAULT_BG)
  // The context gauge waits for the next measurement rather than showing the pre-clear fill.
  await update($, usage, x => ({ ...normalize(DEFAULT_USAGE, x), pct: null, tokens: null }))
}

/**
 * Stores the compaction window for the model window `window`. A `summary` breakdown estimates locally
 * and sends no request; until the host gives one, the gauge stays on the model's window (afterCompactRead).
 */
async function readCompactWindow($: EngineInterface, window: number) {
  const r = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
  await update($, usage, x => afterCompactRead(normalize(DEFAULT_USAGE, x), window, r?.context.breakdown))
}

/** The session's cost read fresh, not from the last measurement: the receipt subtracts two of these. */
async function costNow($: EngineInterface): Promise<number | null> {
  const u = await $.session.usage().catch(() => null)
  return u?.cost?.usd ?? null
}

async function noteMode($: EngineInterface, mode: string | undefined) {
  if (mode) await update($, main, m => (normalize(DEFAULT_MAIN, m).mode === mode ? normalize(DEFAULT_MAIN, m) : { ...normalize(DEFAULT_MAIN, m), mode }))
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  const C = PALETTES[cfg.palette]
  // tool.check carries no loop id; the tool.call around it does, keyed by the call's id.
  const callLoop = new Map<string, string | null>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'flightdeck',
      description: 'Flightdeck, the live agent dashboard: open, close, reset, or set the layout',
      argumentHint: '[open|close|reset|layout auto|compact|wide|mini]',
    })
    await migrate($)
    // A host without usage (headless, an SDK host, a session not yet bound) just starts without it.
    const u = await $.session.usage().catch(() => null)
    // A resumed session has a fill to draw already: its compaction window is read now, not at its first
    // measurement. Any other start forgets the last reading (the setting may have changed) for that one to read.
    const resumedWindow = u && u.context.tokens !== undefined && u.context.window > 0 ? u.context.window : 0
    if (u) {
      await update($, usage, x => ({
        ...normalize(DEFAULT_USAGE, x),
        pct: u.context.percent ?? null,
        tokens: u.context.tokens ?? null,
        window: u.context.window,
        compactFor: resumedWindow,
        compactMisses: 0,
        hasFill: u.context.tokens !== undefined,
        costUsd: u.cost?.usd ?? null,
        limits: u.rateLimits.map(limitOf),
      }))
    }
    if (cfg.openOnStart) void openPane($, cfg).catch(() => undefined)
    void refreshRepo($).catch(() => undefined)
    void refreshPlugins($).catch(() => undefined)
    // Redraw every 10 s so the t/m rate and sparkline age while the session sits idle.
    await seedTokens($).catch(() => undefined)
    void refreshDay($).catch(() => undefined)
    $.clock.every(10_000, async () => {
      await persistDay($).catch(() => undefined)
      await refreshDay($).catch(() => undefined)
      $.ui.invalidate('ui.render')
    })
    await refreshStatus($, cfg)
    const done = await next(e)
    if (resumedWindow > 0) {
      await readCompactWindow($, resumedWindow)
      await refreshStatus($, cfg)
    }
    return done
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await resetAll($)
      await refreshStatus($, cfg)
    }
    // The process goes on in another conversation, whose first request may find no fill: no compaction.
    if (e.reason === 'clear' || e.reason === 'resume') await update($, usage, x => ({ ...normalize(DEFAULT_USAGE, x), hasFill: false }))
    return next(e)
  })

  on('command.run', { command: 'flightdeck' }, async ($, e) => {
    const [verb = 'open', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Flightdeck closed.' }
    }
    if (verb === 'reset') {
      await resetAll($)
      await refreshStatus($, cfg)
      return { text: 'Flightdeck reset.' }
    }
    if (verb === 'layout') {
      const layout: Layout | null = arg === 'compact' || arg === 'wide' || arg === 'auto' || arg === 'mini' ? arg : null
      if (!layout) return { text: 'Usage: /flightdeck layout auto|compact|wide|mini' }
      await update($, view, v => ({ ...normalize(DEFAULT_VIEW, v), layout }))
      const opened = await openPane($, cfg)
      return { text: opened.isPlaced ? `Flightdeck layout: ${layout}.` : `Layout set to ${layout}; the pane is not shown yet: ${opened.reason}` }
    }
    const opened = await openPane($, cfg)
    if (!opened.isPlaced) return { text: `Flightdeck is not shown yet: ${opened.reason}` }
    return { text: 'Flightdeck opened. Focus it with ctrl+x tab; 1-6 expand cards, f/s/o open the gate rows.' }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteMode($, e.permission_mode)
    return next(e)
  })

  on('agent.offer', async ($, e, next) => {
    const offered = await next(e)
    if (cfg.architect.test(e.agent) || (cfg.matchDescriptions && cfg.architect.test(e.description))) {
      await update($, roster, r => {
        const x = normalize(DEFAULT_ROSTER, r)
        return x.architectTypes.includes(e.agent) ? x : { architectTypes: [...listOf<string>(x.architectTypes), e.agent].slice(-20) }
      })
    }
    return offered
  })

  // A background task's end reaches the conversation as a <task-notification> row: its id and status close the item.
  on('session.append', async ($, e, next) => {
    const running = listOf<BgItem>(normalize(DEFAULT_BG, await read($, bg)).items).filter(i => i.endedAt === null)
    if (running.length > 0 && !e.agentId && e.door !== 'response' && e.door !== 'tool-result') {
      const c = (e.message as unknown as { content?: unknown }).content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n') : ''
      if (text.includes('<task-notification>')) {
        for (const m of text.matchAll(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g)) {
          if (running.some(i => i.id === m[1]!.trim())) await endBg($, m[1]!.trim(), m[2]!.trim())
        }
      }
    }
    return next(e)
  })

  // Every skill the session runs, typed as /name, run by the Skill tool or preloaded into a subagent.
  on('skill.prompt', async ($, e, next) => {
    const name = e.skill.split(':').pop() ?? e.skill
    await update($, kit, x => {
      const k = normalize(DEFAULT_KIT, x)
      return k.skills.includes(name) ? k : { ...k, skills: [...k.skills, name] }
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's turn (its spawn, or a resume by SendMessage) is its card's, not the main turn's.
    if (e.agentId !== undefined) return next(e)
    const [now, cost] = await Promise.all([$.clock.now(), costNow($)])
    await update($, turn, () => ({ ...DEFAULT_TURN, startedAt: now, costAtStart: cost }))
    await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: true }))
    void refreshRepo($).catch(() => undefined)
    void refreshPlugins($).catch(() => undefined)
    // A background architect's report reaches the main loop as the text opening this turn. The
    // SubagentHandback tool call (in tool.call) normally carries it first; this is the fallback.
    const back = e.text ? handbackOf(e.text) : null
    const a = back ? await getArchitect($) : null
    if (back && a && a.ids.includes(back.from)) {
      const advice = adviceLine(back.body)
      if (advice && advice !== a.lastAdvice) await noteAdvice($, cfg, advice)
    } else if (e.text) {
      const p = promptLine(e.text)
      await say($, p.who, p.text)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // The main loop's model is known when its request starts; a long first request shouldn't read "—".
    if (!e.agentId) {
      let isNewModel = false
      await update($, main, m => {
        const x = normalize(DEFAULT_MAIN, m)
        isNewModel = x.model !== '' && x.model !== e.model
        return { ...x, model: e.model, effort: String(e.effort ?? x.effort), steps: x.steps + 1 }
      })
      if (isNewModel) await update($, usage, x => forgetCompactRead(normalize(DEFAULT_USAGE, x)))
      // Under the built-in guard session.compact never runs here. A request that finds the context
      // emptied after a response came back follows a compaction: counted as an estimate (afterFillRead).
      const [u0, live, at] = await Promise.all([getUsage($), $.session.usage().catch(() => null), $.clock.now()])
      let hasFill = u0.hasFill
      if (live) {
        const read = afterFillRead(u0, live.context.tokens !== undefined, at)
        hasFill = read.usage.hasFill
        let isCompaction = false
        if (read.usage !== u0) {
          await update($, usage, x => {
            const r = afterFillRead(normalize(DEFAULT_USAGE, x), live.context.tokens !== undefined, at)
            isCompaction = r.isCompaction
            return r.usage
          })
        }
        if (isCompaction) await say($, 'main', 'context compacted (estimated)')
      }
      // Time the response as it passes: its first piece that is neither the engine's envelope nor the
      // stop. One clock read in the stream and nothing stored until it has ended.
      const sentAt = await $.clock.now()
      let firstAt: number | null = null
      const s = next(e)
      for await (const c of s) {
        if (firstAt === null && c.kind !== 'engine' && c.kind !== 'stop') firstAt = await $.clock.now()
        yield c
      }
      const result = await s.result
      await addTokens($, result.usage as StepTokens, true)
      const speed = result.usage ? stepSpeed(sentAt, firstAt) : null
      if (speed) await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), speed }))
      // Marked here, not at the next request: two compactions can come with one response between them.
      if (result.usage && !hasFill) await update($, usage, x => afterResponse(normalize(DEFAULT_USAGE, x)))
      return result
    }
    const id = e.agentId
    // A step from an agent whose card finished means it was resumed (SendMessage): it runs again.
    const before = (await getCards($)).find(c => c.id === id)
    if (before && before.status !== 'running') {
      // Flipped in the write: a resume its agent.spawn already logged is not logged again.
      let isResumed = false
      await update($, agents, list =>
        listOf<unknown>(list)
          .map(normalizeCard)
          .map(c => {
            if (c.id !== id || c.status === 'running') return c
            isResumed = true
            return resumeCard(c)
          }),
      )
      if (isResumed) {
        await say($, await whoIs($, id), 'resumed', 'info', id)
        await refreshStatus($, cfg)
      }
    }
    const result = yield* next(e)
    await addTokens($, result.usage as StepTokens, false, id)
    const [cards, a] = await Promise.all([getCards($), getArchitect($)])
    if (cards.some(c => c.id === id)) {
      const step = { model: e.model, usage: result.usage, stopReason: result.stopReason }
      await update($, agents, list => listOf<unknown>(list).map(normalizeCard).map(c => (c.id === id ? applyStep(c, step) : c)))
      if (result.stopReason === 'max_tokens') await say($, await whoIs($, id), 'hit max_tokens', 'error', id)
    } else if (!a.ids.includes(id)) {
      const now = await $.clock.now()
      await update($, loops, l => stepLoop(listOf<Loop>(l), id, now))
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    // The compaction window is read once per model window, not on every measurement (a breakdown
    // estimates every category each time): claimed here, in the same write, so no two reads overlap.
    let isStale = false
    await update($, usage, x => {
      const claim = claimCompactRead(normalize(DEFAULT_USAGE, x), e.context.window)
      isStale = claim.isClaimed
      return {
        ...claim.usage,
        pct: e.context.percent ?? null,
        tokens: e.context.tokens ?? null,
        window: e.context.window,
        costUsd: e.cost?.usd ?? null,
        limits: e.rateLimits.map(limitOf),
      }
    })
    if (e.changed.includes('context')) await refreshStatus($, cfg)
    const done = await next(e)
    if (isStale) {
      await readCompactWindow($, e.context.window)
      await refreshStatus($, cfg)
    }
    return done
  })

  on('session.compact', async ($, e, next) => {
    // Any compaction reaching this hook, a subagent's or a precompute too, means the guard isn't in the way.
    if (!(await getUsage($)).isCompactHooked) await update($, usage, x => afterCompactHooked(normalize(DEFAULT_USAGE, x)))
    const done = await next(e)
    // A skip is a veto, by a plugin or a blocking PreCompact hook: the conversation stays as it was.
    if (!done.skip && !e.agentId && e.trigger !== 'precompute') {
      const now = await $.clock.now()
      await update($, usage, x => {
        const u = normalize(DEFAULT_USAGE, x)
        return { ...u, compactions: u.compactions + 1, lastCompactAt: now }
      })
      await say($, 'main', `context compacted (${e.trigger})`)
    }
    return done
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id) {
      const check: Check = {
        id: e.tool_use_id,
        tool: e.tool,
        bucket: bucketOf(e.tool),
        verdict: verdict.decision === 'allow' ? 'rule' : verdict.decision,
        inSubagent: Boolean(callLoop.get(e.tool_use_id)),
        detail: shorten(describeInput(e.tool, e.input), 90),
        at: await $.clock.now(),
      }
      await update($, gate, g => recordCheck(normalizeGate(g), check))
      // The status line updates when the call settles; only a refusal ends here.
      if (verdict.decision === 'deny') {
        await say($, 'gate', `denied by rule · ${check.detail}`, 'error')
        await refreshStatus($, cfg)
      }
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    callLoop.set(e.tool_use_id, e.agentId ?? null)
    const ran = await next(e).finally(() => callLoop.delete(e.tool_use_id))
    const didRun = ran.deny === undefined
    if (didRun && ran.isError !== true) await notePlan($, String(e.tool), e as unknown as Record<string, unknown>, ran.result).catch(() => undefined)
    if (didRun && ran.isError !== true) await noteBg($, String(e.tool), e as unknown as Record<string, unknown>, ran.result).catch(() => undefined)
    // Settle this call's pending ask, if it had one; skip the write (and the redraw) otherwise.
    const g0 = await getGate($)
    const isSettled = settleCheck(g0, e.tool_use_id, didRun) !== g0
    if (isSettled) await update($, gate, g => settleCheck(normalizeGate(g), e.tool_use_id, didRun))
    // A background agent hands its report back through this tool; an architect's report is its advice.
    if (String(e.tool) === 'SubagentHandback') {
      const message = (e as unknown as { message?: unknown }).message
      const a = e.agentId ? await getArchitect($) : null
      if (a && e.agentId && a.ids.includes(e.agentId) && typeof message === 'string') {
        const advice = adviceLine(message)
        if (advice && advice !== a.lastAdvice) await noteAdvice($, cfg, advice)
      }
      return ran
    }
    if (e.tool === 'Agent') {
      if (isSettled) await refreshStatus($, cfg)
      return ran
    }
    const hasFailed = didRun && ran.isError === true
    const isEdit = !hasFailed && didRun && EDIT_TOOLS.has(e.tool)
    const t0 = await getTurn($)
    if (isEdit || hasFailed || (!e.agentId && t0.errorStreak > 0)) {
      await update($, turn, t => afterCall(normalize(DEFAULT_TURN, t), { inSubagent: Boolean(e.agentId), hasFailed, isEdit }))
    }
    const text = shorten(describeInput(e.tool, e), 64)
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, list =>
        listOf<unknown>(list)
          .map(normalizeCard)
          .map(c => (c.id === id ? noteTool(c, { tool: e.tool, text, isError: hasFailed || ran.deny !== undefined }) : c)),
      )
    }
    // The log keeps what is worth a glance: refusals, errors and edits; the rest is on the cards.
    if (ran.deny !== undefined) await say($, await whoIs($, e.agentId), `${text}  denied`, 'error', e.agentId ?? null)
    else if (hasFailed) await say($, await whoIs($, e.agentId), `${text}  ✗`, 'error', e.agentId ?? null)
    else if (isEdit) await say($, await whoIs($, e.agentId), text, 'info', e.agentId ?? null)
    if (isSettled || !didRun) await refreshStatus($, cfg)
    return ran
  })

  // A server-side review tool never reaches tool.call: it shows only in the assistant's rows.
  // Only response rows carry them. A managed plugin may pass user plugins over on other doors.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (!e.agentId && e.message.type === 'assistant') {
      const a = await getArchitect($)
      // Consults this row opened: their result may be in the same row, after the stale read above.
      const opened = new Set<string>()
      for (const block of e.message.content as unknown as readonly ServerBlock[]) {
        if (block.type === 'server_tool_use' && block.name && block.id && cfg.architect.test(block.name)) {
          if (a.seen.includes(block.id)) continue
          const id = block.id
          await update($, architect, x => {
            const y = normalize(DEFAULT_ARCHITECT, x)
            return { ...y, seen: [...listOf<string>(y.seen), id].slice(-60) }
          })
          opened.add(id)
          await consultStarted($, cfg, id, `${block.name} tool`)
        } else if (block.type.endsWith('_tool_result') && block.tool_use_id) {
          const id = block.tool_use_id
          const isOpen = opened.has(id) || (await getArchitect($)).consults.some(c => c.id === id && c.endAt === null)
          if (isOpen) await consultEnded($, cfg, null, id)
        }
      }
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!e.parentAgentId) await noteMode($, e.permissionMode)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    if (await isArchitectType($, cfg, e.subagentType)) {
      await update($, architect, a => {
        const x = normalize(DEFAULT_ARCHITECT, a)
        return { ...x, ids: [...listOf<string>(x.ids), id].slice(-40) }
      })
      await update($, loops, l => listOf<Loop>(l).filter(x => x.id !== id))
      await consultStarted($, cfg, id, e.subagentType.split(':').pop() ?? 'agent')
      return started
    }
    const card: AgentCard = {
      ...normalizeCard({}),
      id,
      type: e.name ?? e.subagentType,
      model: started.model,
      description: e.description,
      spawnedAt: await $.clock.now(),
    }
    // Decided in the write: a resume whose first step already put its card back to running is not logged again.
    let isNew = true
    let isResumed = false
    await update($, agents, list => {
      const cards = listOf<unknown>(list).map(normalizeCard)
      const known = cards.find(c => c.id === id)
      isNew = known === undefined
      isResumed = known !== undefined && known.status !== 'running'
      return addCard(cards, card)
    })
    await update($, loops, l => listOf<Loop>(l).filter(x => x.id !== id))
    if (isNew || isResumed) await say($, shorten(cardTitle(card), 12), isNew ? `spawned · ${card.type}` : 'resumed', 'info', id)
    await refreshStatus($, cfg)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId
    const now = await $.clock.now()
    if (!id) {
      const [t, cards, cost] = await Promise.all([getTurn($), getCards($), costNow($)])
      const r = receiptOf(t, {
        durationMs: e.durationMs,
        agentsSince: cards.filter(c => c.spawnedAt >= t.startedAt).length,
        costNow: cost,
        reason: e.reason,
      })
      await update($, receipt, () => r)
      await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: false }))
      void refreshRepo($).catch(() => undefined)
      void persistDay($).then(() => refreshDay($)).catch(() => undefined)
      await refreshStatus($, cfg)
      return done
    }
    if ((await getArchitect($)).ids.includes(id)) {
      await consultEnded($, cfg, e.answer, id)
      return done
    }
    const cards = await getCards($)
    if (cards.some(c => c.id === id)) {
      const status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await update($, agents, list =>
        listOf<unknown>(list)
          .map(normalizeCard)
          .map(c => (c.id === id ? { ...c, status, endedAt: now, answer: shorten(e.answer, 400) } : c)),
      )
      // This run's own length: a resumed agent's card clock also spans the idle time between runs.
      const took = fmtDuration(e.durationMs)
      await say($, await whoIs($, id), status === 'done' ? `done · ${took}` : status, status === 'done' ? 'done' : 'error', id)
    } else {
      await update($, loops, l => listOf<Loop>(l).map(x => (x.id === id ? { ...x, isDone: true, lastAt: now } : x)))
    }
    await refreshStatus($, cfg)
    return done
  })

  // ---------------------------------------------------------------- drawing

  // After a surface module faults on a surface, this load draws it there as plain text; the other
  // module, and other surfaces, keep theirs. Keyed by faultKey: `desktop:rail.tsx`. `ui.fault` came in
  // Claude Code 2.1.289, and an older engine refuses to load a module that hooks it: the floor the README
  // states and CI's oldest leg tests.
  const faulted = new Set<string>()
  on('ui.fault', async ($, e, next) => {
    const key = faultKey(e.surface, e.module)
    if (e.requestId === PANE && !faulted.has(key)) {
      faulted.add(key)
      $.ui.log(`flightdeck: ${e.module} faulted on ${e.surface} (${e.phase}: ${e.reason}); drawing it without animation`)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Text's `mono` came in Claude Code 2.1.299, after the 2.1.289 Flightdeck supports. An older engine refuses
  // the prop ("Text prop "mono" is not allowed"): a connector drawn with it unmounts the pane, from the first
  // prompt on, when the first connector appears (#28). So the connectors ask for the face only where the
  // engine says it is that new, read once per load.
  let monoRead: Promise<boolean> | null = null

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const hasClient = 'Client' in els
    const hasRail = hasClient && !faulted.has(faultKey(e.surface, 'rail.tsx'))
    const hasClock = hasClient && !faulted.has(faultKey(e.surface, 'elapsed.tsx'))
    const [m, u, a, g, allCards, lp, lines, t, r, v, now, mono, rp, tk, kt, pl, bgs, dy] = await Promise.all([
      getMain($),
      getUsage($),
      getArchitect($),
      getGate($),
      getCards($),
      getLoops($),
      getLog($),
      getTurn($),
      read($, receipt),
      getView($),
      $.clock.now(),
      (monoRead ??= readMono($)),
      read($, repo).then(x => normalize(DEFAULT_REPO, x)),
      read($, tokens).then(x => normalize(DEFAULT_TOKENS, x)),
      read($, kit).then(x => normalize(DEFAULT_KIT, x)),
      read($, plan).then(x => normalize(DEFAULT_PLAN, x)),
      read($, bg).then(x => normalize(DEFAULT_BG, x)),
      read($, day).then(x => normalize(DEFAULT_DAY, x)),
    ])
    // Finished agents leave the panel five minutes after they end; running ones always show.
    const CARD_KEEP_MS = 5 * 60_000
    const cards = allCards.filter(c => c.status === 'running' || c.endedAt === null || now - c.endedAt < CARD_KEEP_MS)
    // The body's own width, down to the narrowest dock Claude Code seats (24): a wider drawing is cut off at the frame.
    const W = Math.max(24, e.props.bodyColumns)
    const layout = v.layout ?? cfg.layout
    const isWide = layout === 'wide' || (layout === 'auto' && W >= 110)
    const colW = isWide ? Math.floor((W - 2) / 2) : W
    const modelName = prettyModel(m.model)
    const viewed = e.props.view?.agentId ?? null
    const advising = isAdvising(a)
    const running = cards.filter(c => c.status === 'running')
    const showArchitect = a.consults.length > 0 || a.ids.length > 0
    const motion = cfg.motion && hasRail
    // A panel with nothing to show yet takes no room: most sessions never spawn an agent.
    // Running background tasks, and finished ones for a minute after they end.
    const bgShown = listOf<BgItem>(bgs.items).filter(i => i.endedAt === null || now - i.endedAt < 60_000)
    const isEmpty: Record<Panel, boolean> = {
      main: false,
      // A finished plan stays two minutes, then leaves the room to the rest.
      tasks: cfg.panels.includes('main') || listOf(pl.items).length === 0 || (pl.doneAt !== null && now - pl.doneAt > 120_000),
      bg: cfg.panels.includes('main') || bgShown.length === 0,
      architect: !showArchitect,
      gate: g.recent.length === 0 && gateSummary(g).total === 0,
      // The agents box stays even when empty, so it doesn't vanish once finished agents have left it.
      agents: false,
      loops: lp.length === 0,
      receipt: !m.isRunning && !r,
      log: false,
    }
    const panels = cfg.panels.filter(p => !isEmpty[p])
    const decider = m.mode === 'auto' ? 'classifier' : 'you'

    // A connector between panels: animated while its flow is live, a dim line otherwise.
    const rail = (key: string, active: boolean, color: string, width: number, marks: number[] = [], isMerge = false) =>
      motion ? (
        <els.Client
          key={key}
          module="./rail.tsx"
          width={width}
          height={1}
          props={{ active, width, color, dim: C.faint, marks, isMerge, mono }}
        />
      ) : (
        <Text color={C.faint} {...(mono ? { mono: true } : {})}>
          {'─'.repeat(Math.max(1, width))}
        </Text>
      )

    // A start time of 0 is unknown (state saved before it was recorded): no clock, not decades.
    const clock = (key: string, since: number, endAt: number | null, color: string) =>
      since <= 0 ? (
        <Text color={color}>—</Text>
      ) : hasClock ? (
        <els.Client key={key} module="./elapsed.tsx" props={{ since, now, endAt, color }} />
      ) : (
        <Text color={color}>{fmtTimer((endAt ?? now) - since)}</Text>
      )

    const isTerminal = e.surface === 'terminal'
    // A row of marks (gate checks, loop dots), sized by `marksIn`. Should a surface draw them wider
    // still, the row is cut at its box rather than running past it.
    const markRow = (marks: RenderChildren, lead = 0) => (
      <Box overflow="hidden" {...(lead ? { marginLeft: lead } : {})}>
        <Text wrap="truncate-start">{marks}</Text>
      </Box>
    )
    // A terminal's border row stands apart from the text above it; a graphical surface draws the
    // border flush against it, so the legend keeps one row of air there.
    const legendGap = isTerminal ? 0 : 1

    // A line of coloured pieces, drawn as a row of boxes the way the log draws its lines. A Text nesting
    // coloured Texts truncates as one line in a terminal, but the desktop app wraps each nested piece on its
    // own, lays truncating ones out as blocks of their own, and collapses runs of spaces. So pieces sit `gap`
    // cells apart (a piece's `lead` adds more), each keeps its width, and pieces that don't fit in `room` are
    // left out from the end; or a piece marked `fill` (one span) truncates to what the others leave.
    type Span = { text: string; color?: string; dim?: boolean; bold?: boolean }
    type Piece = { spans: Span[]; lead?: number; fill?: boolean }
    const styleOf = (s: Span) => ({ ...(s.color ? { color: s.color } : {}), ...(s.dim ? { dimColor: true } : {}), ...(s.bold ? { bold: true } : {}) })
    const widthOf = (p: Piece) => p.spans.reduce((n, s) => n + cellWidth(s.text), 0)
    const line = (pieces: (Piece | null)[], room: number, gap = 1, justify?: 'center') => {
      const all = pieces.filter((p): p is Piece => p !== null)
      const shown = all.some(p => p.fill) ? all : all.slice(0, piecesThatFit(all.map(p => ({ width: widthOf(p), lead: p.lead })), room, gap))
      return (
        <Box width={room} columnGap={gap} overflow="hidden" {...(justify ? { justifyContent: justify } : {})}>
          {shown.map(p => {
            const lead = p.lead ? { marginLeft: p.lead } : {}
            if (p.fill && p.spans[0]) {
              return (
                <Text {...styleOf(p.spans[0])} wrap="truncate">
                  {p.spans[0].text}
                </Text>
              )
            }
            return (
              <Box flexShrink={0} {...lead}>
                {p.spans.length === 1 && p.spans[0] ? <Text {...styleOf(p.spans[0])}>{p.spans[0].text}</Text> : <Text>{p.spans.map(s => <Text {...styleOf(s)}>{s.text}</Text>)}</Text>}
              </Box>
            )
          })}
        </Box>
      )
    }

    // ---- main
    const effortN = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 }[m.effort] ?? 0
    const ctxFill = contextFill(u)
    const ctxGauge = ctxFill.pct !== null ? gauge(ctxFill.pct, 10) : null
    // yas's gauge: the context against the soft limit, a gradient bar filling green to violet.
    const soft = u.tokens !== null ? Math.min(1, u.tokens / cfg.softLimit) : null
    // yas's own colours and glyphs, so these rows read as the yas statusline does.
    const Y = { orange: '#e08848', yellow: '#e5c07b', white: '#e6e6e6', blue: '#61afef', cyan: '#56c8d6', grey: '#808080', salmon: '#e86e6e', track: '#282828' }
    // Design tokens (ui-ux-pro-max: "Dark Mode (OLED)" style, dark dashboard palette): one frame colour,
    // one muted text colour, one accent for every section rule, and semantic data colours.
    const T = { fg: '#F8FAFC', muted: '#94A3B8', border: '#334155', accent: '#8B5CF6', info: '#60A5FA', ok: '#22C55E', warn: '#F59E0B', bad: '#EF4444' }
    const fmtTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))
    const samples = listOf<{ at: number; n: number }>(tk.samples)
    const rate = samples.filter(s => now - s.at <= RATE_MS).reduce((a, s) => a + s.n, 0)
    // yas's token cell: ↓ input (cache read) ↑ output │ ◷ t/m and a two-row sparkline of two minutes.
    // t/m samples: Flightdeck's own, cumulative session totals after each request.
    const rateRows = listOf<[number, number, number]>(tk.rows ?? [])
    // Session figures: the day book's view of this session (Flightdeck's own totals).
    const S = dy.has && dy.sIn + dy.sCr + dy.sOut > 0 ? { in: dy.sIn, cr: dy.sCr, out: dy.sOut } : { in: tk.in, cr: tk.cacheRead, out: tk.out }
    const tokText = (x: { in: number; cr: number; out: number }) => `↓${fmtTok(x.in)} (${fmtTok(x.cr)}) \uf062 ${fmtTok(x.out)}`
    const tokSpans = (x: { in: number; cr: number; out: number }, wid: number) => (
      <Box width={wid} flexShrink={0}>
        <Text>
          <Text color={Y.blue}>{`↓${fmtTok(x.in)}`}</Text>
          <Text color={Y.grey}>{` (${fmtTok(x.cr)})`}</Text>
          <Text color={Y.orange} bold>{' \uf062'}</Text>
          <Text color={Y.cyan}>{` ${fmtTok(x.out)}`}</Text>
        </Text>
      </Box>
    )
    // yas's token band: session over today on the left, │, the t/m rate and the live sparkline.
    const tokenRow = (rw: number) => {
      if (S.in + S.cr + S.out === 0) return null
      const D = dy.has && dy.dIn + dy.dCr + dy.dOut > 0 ? { in: dy.dIn, cr: dy.dCr, out: dy.dOut } : null
      const leftW = Math.max(cellWidth(tokText(S)), D ? cellWidth(tokText(D)) : 0)
      const sw = Math.max(10, rw - leftW - 7)
      const hasSpark = hasClient && !faulted.has(faultKey(e.surface, 'spark.tsx'))
      return (
        <Box width={rw} overflow="hidden">
          <Box flexDirection="column" flexShrink={0} marginRight={1}>
            <Text color={Y.grey}>ses</Text>
            {D ? <Text color={Y.grey}>day</Text> : null}
          </Box>
          <Box flexDirection="column" flexShrink={0}>
            {tokSpans(S, leftW)}
            {D ? tokSpans(D, leftW) : null}
          </Box>
          <Box flexShrink={0} marginX={1} flexDirection="column">
            <Text color={Y.grey}>│</Text>
            {D ? <Text color={Y.grey}>│</Text> : null}
          </Box>
          {hasSpark ? (
            <els.Client
              key="token-spark"
              module="./spark.tsx"
              width={sw}
              height={2}
              props={{
                rows: rateRows,
                now,
                width: sw,
                windowMs: SPARK_WINDOW_MS,
                rateMs: RATE_MS,
                color: Y.salmon,
                rateColor: Y.cyan,
                iconColor: Y.orange,
                dim: Y.grey,
              }}
            />
          ) : (
            <Text wrap="truncate">
              <Text color={Y.orange}>{'\u{f18a7}'}</Text>
              <Text color={Y.cyan}>{` ${fmtTok(rate)}`}</Text>
              <Text color={Y.grey}> t/m</Text>
            </Text>
          )}
        </Box>
      )
    }
    // yas's cache cell: the prompt cache's time left since the main loop's last request, gone once it expires.
    const cacheUntil = tk.lastMainAt !== null ? tk.lastMainAt + tk.cacheTtlMs : null
    const cacheCell = () => {
      if (cacheUntil === null || cacheUntil - now <= 0) return null
      return (
        <Box flexShrink={0} columnGap={1}>
          <Text color={Y.yellow}>{'\uf49b'}</Text>
          {hasClient && !faulted.has(faultKey(e.surface, 'countdown.tsx')) ? (
            <els.Client key="cache-countdown" module="./countdown.tsx" props={{ until: cacheUntil, now, color: Y.yellow, cold: Y.grey }} />
          ) : (
            <Text color={Y.yellow}>{fmtTimer(cacheUntil - now)}</Text>
          )}
        </Box>
      )
    }
    // yas's context bar, drawn slim: a thin gradient line over the filled part, a faint track for the rest.
    const softBar = (bw: number) => {
      const body = Math.max(4, Math.min(60, bw))
      const n = soft === null ? 0 : soft > 0 ? Math.max(1, Math.round(soft * body)) : 0
      return (
        <Text wrap="truncate">
          {Array.from({ length: n }, (_, i) => (
            <Text color={grad(i / Math.max(1, body - 1))}>━</Text>
          ))}
          <Text color={C.faint}>{'─'.repeat(Math.max(0, body - n))}</Text>
        </Text>
      )
    }
    // yas's model pill: the model's own colour (opus copper, sonnet blue, haiku green, fable violet),
    // brighter the higher the effort, with the effort in italics.
    const pillBg = (() => {
      const id = m.model.toLowerCase()
      const base = id.includes('sonnet') ? [110, 140, 205] : id.includes('haiku') ? [90, 170, 130] : id.includes('fable') ? [160, 110, 210] : id.includes('opus') ? [196, 124, 82] : [150, 150, 150]
      const k = ({ '': 0.72, low: 0.78, medium: 0.88, high: 1.0, xhigh: 1.06, max: 1.12 } as Record<string, number>)[m.effort.toLowerCase()] ?? 0.72
      return '#' + base.map(v => Math.min(255, Math.round(v * k)).toString(16).padStart(2, '0')).join('')
    })()
    // yas's rate cells (no $: a Max plan's API-priced cost means nothing), the T- clock ticking every second.
    const ratesCell = (w: number) =>
      u.limits.length > 0 ? (
          <Box columnGap={2} flexShrink={0}>
            {u.limits.slice(0, 2).map(l => {
              // The used % (lime < 70, yellow < 90, red), the burn trend against an even pace through the
              // window (⚡ ahead of it, 🔥 behind), and for the 5h window a T- countdown.
              const is5h = /5h/.test(limitLabel(l.kind))
              const is7d = /7d/.test(limitLabel(l.kind))
              const winMin = is5h ? 300 : is7d ? 10080 : 0
              const warm = is5h ? 5 : 30
              let trend: { text: string; color: string } | null = null
              if (winMin && l.resetsAt && now < l.resetsAt) {
                const elapsed = (now - (l.resetsAt - winMin * 60_000)) / 60_000
                if (elapsed >= warm) {
                  const d = l.pct - (elapsed / winMin) * 100
                  trend = { text: ` ${d > 0 ? '\uef76' : '\uf490'} ${d >= 0 ? '+' : '-'}${Math.abs(d).toFixed(2).padStart(5, '0')}%`, color: grad(0.5 + d / 50) }
                }
              }
              const pc = l.pct < 70 ? '#bedc5a' : l.pct < 90 ? '#e5c07b' : '#e86e6e'
              const hasClock = is5h && l.resetsAt !== null && l.resetsAt !== undefined && l.resetsAt > now
              const resetIn = !is5h && w >= 56 ? fmtResetIn(l.resetsAt, now) : ''
              return (
                <Box flexShrink={0}>
                  <Text>
                    {is5h ? <Text color="#f5be28">{'\uf4cd '}</Text> : <Text dimColor>{`${limitLabel(l.kind)} `}</Text>}
                    <Text color={pc} bold>{`${l.pct.toFixed(1)}%`}</Text>
                    {trend ? <Text color={trend.color}>{trend.text}</Text> : null}
                    {resetIn ? <Text dimColor>{` ↻${resetIn}`}</Text> : null}
                  </Text>
                  {hasClock ? (
                    hasClient && !faulted.has(faultKey(e.surface, 'countdown.tsx')) ? (
                      <els.Client key={`t-${l.kind}`} module="./countdown.tsx" props={{ until: l.resetsAt as number, now, color: '#808080', cold: '#808080', clock: true, prefix: ' T-' }} />
                    ) : (
                      <Text color="#808080">{` T-${fmtTimer((l.resetsAt as number) - now)}`}</Text>
                    )
                  ) : null}
                </Box>
              )
            })}
          </Box>
      ) : null
    const sep = (iw: number) => <Text color={C.faint}>{'┄'.repeat(Math.max(1, iw))}</Text>
    const pill = (
      <Box flexShrink={0}>
        <Text>
          <Text backgroundColor={pillBg} color="#261e1a">{`  \u{f08b9} ${modelName} `}</Text>
          {m.effort ? <Text backgroundColor={pillBg} color="#261e1a">{' \u{f1a51} '}</Text> : null}
          {m.effort ? (
            <Text backgroundColor={pillBg} color="#261e1a" italic>
              {m.effort}
            </Text>
          ) : null}
          <Text backgroundColor={pillBg}>{'  '}</Text>
          <Text color={pillBg}>▌</Text>
        </Text>
      </Box>
    )
    // yas's path cell: home, the folder, ∈ branch/commit and the git counts (* modified, • untracked, - deleted).
    const pathCell = (
      <Box flexShrink={1} overflow="hidden">
        <Text wrap="truncate">
          <Text color={Y.blue}>{`\uf015 ${shortDir(rp.dir || '~')}`}</Text>
          {rp.isRepo ? (
            <Text>
              <Text color="#f5be28">{' ∈ '}</Text>
              <Text color={Y.yellow}>{`${rp.branch ?? 'detached'}${rp.sha ? `/${rp.sha}` : ''}`}</Text>
              {(rp.mod ?? 0) + (rp.untracked ?? 0) + (rp.del ?? 0) > 0 ? (
                <Text color={Y.orange}>{` ${rp.mod ? `${rp.mod}*` : ''}${rp.untracked ? `${rp.untracked}•` : ''}${rp.del ? `${rp.del}-` : ''}`}</Text>
              ) : null}
              {rp.ahead ? <Text color={C.gate}>{` ↑${rp.ahead}`}</Text> : null}
              {rp.behind ? <Text color={C.warn}>{` ↓${rp.behind}`}</Text> : null}
            </Text>
          ) : (
            <Text color={C.faint}>{'  no git'}</Text>
          )}
        </Text>
      </Box>
    )
    const vbar = <Text color={Y.grey}>│</Text>
    const planVisible = listOf(pl.items).length > 0 && !(pl.doneAt !== null && now - pl.doneAt > 120_000)
    // The yas card: one frame whose colour follows the context fill, its bands split by dotted rules.
    // ---- the dashboard: a header strip, KPI tiles in a grid, a throughput chart, then the plan and jobs.
    // Each tile is a small card: an uppercase caption, the figure in bold, a dim detail line and a meter.
    const meter = (frac: number, mw: number, colorAt: (t: number) => string) => {
      const n = Math.max(0, Math.min(mw, Math.round(Math.max(0, Math.min(1, frac)) * mw)))
      return (
        <Text wrap="truncate">
          {Array.from({ length: n }, (_, i) => (
            <Text color={colorAt(i / Math.max(1, mw - 1))}>━</Text>
          ))}
          <Text color={C.faint}>{'─'.repeat(Math.max(0, mw - n))}</Text>
        </Text>
      )
    }
    const heading = (title: string, accent: string, meta?: string, right?: RenderChildren) => (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text wrap="truncate">
            <Text color={T.fg} bold>
              {title}
            </Text>
            {meta ? <Text color={T.muted}>{`   ${meta}`}</Text> : null}
          </Text>
          {right ? <Box flexShrink={0}>{right}</Box> : null}
        </Box>
        <Text color={T.accent}>{'▔'.repeat(Math.max(3, cellWidth(title)))}</Text>
      </Box>
    )
    const tile = (key: string, caption: string, accent: string, value: RenderChildren, detail: RenderChildren | null, bar: RenderChildren | null, tw: number) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={T.border} paddingX={1} width={tw} flexShrink={0}>
        <Text wrap="truncate">
          <Text color={accent}>{'● '}</Text>
          <Text color={T.muted}>{caption}</Text>
        </Text>
        <Box overflow="hidden">{value}</Box>
        {detail ? <Box overflow="hidden">{detail}</Box> : null}
        {bar}
      </Box>
    )
    const grid = (tiles: ((tw: number) => RenderChildren)[], iw: number, cols: number) => {
      const tw = Math.floor((iw - (cols - 1)) / cols)
      const rows: ((tw: number) => RenderChildren)[][] = []
      for (let i = 0; i < tiles.length; i += cols) rows.push(tiles.slice(i, i + cols))
      return rows.map(r => (
        <Box columnGap={1} width={iw}>
          {r.map(t => t(tw))}
        </Box>
      ))
    }
    const planVisibleNow = planVisible
    const mainPanel = (w: number) => {
      const iw = w - 4
      const cols = iw >= 96 ? 4 : 2
      const D = dy.has && dy.dIn + dy.dCr + dy.dOut > 0 ? { in: dy.dIn, cr: dy.dCr, out: dy.dOut } : null
      const tiles: ((tw: number) => RenderChildren)[] = []
      // Context: the fill against the soft limit, its word, and the gradient meter.
      if (soft !== null && u.tokens !== null) {
        tiles.push(tw =>
          tile(
            'ctx',
            'Context',
            grad(soft),
            <Text wrap="truncate">
              <Text color={grad(soft)} bold>{`${Math.round(soft * 100)}%`}</Text>
              <Text color={grad(soft)}>{`  ${ctxWord(soft * 100)}`}</Text>
              {u.compactions > 0 ? <Text color={C.amber}>{`  ${compactMark(u)}`}</Text> : null}
            </Text>,
            <Text color={T.muted} wrap="truncate">{`${fmtTok(u.tokens ?? 0)} of ${kTokens(cfg.softLimit)} · window ${Math.round(ctxFill.pct ?? 0)}%`}</Text>,
            meter(soft ?? 0, tw - 4, t => grad(t * (soft ?? 0))),
            tw,
          ),
        )
      }
      // Rate limits: used %, the burn trend against an even pace, the reset (and T- for the 5 h window).
      for (const l of u.limits.slice(0, 2)) {
        const is5h = /5h/.test(limitLabel(l.kind))
        const winMin = is5h ? 300 : /7d/.test(limitLabel(l.kind)) ? 10080 : 0
        let d: number | null = null
        if (winMin && l.resetsAt && now < l.resetsAt) {
          const elapsed = (now - (l.resetsAt - winMin * 60_000)) / 60_000
          if (elapsed >= (is5h ? 5 : 30)) d = l.pct - (elapsed / winMin) * 100
        }
        const pc = l.pct < 70 ? T.ok : l.pct < 90 ? T.warn : T.bad
        const hasClock = is5h && l.resetsAt !== null && l.resetsAt !== undefined && l.resetsAt > now
        tiles.push(tw =>
          tile(
            `lim-${l.kind}`,
            is5h ? '5h limit' : `${limitLabel(l.kind)} limit`,
            pc,
            <Text wrap="truncate">
              <Text color={pc} bold>{`${l.pct.toFixed(1)}%`}</Text>
              {d !== null ? <Text color={grad(0.5 + d / 50)}>{`  ${d > 0 ? '' : ''} ${d >= 0 ? '+' : '-'}${Math.abs(d).toFixed(1)}%`}</Text> : null}
            </Text>,
            <Box>
              {hasClock ? (
                hasClient && !faulted.has(faultKey(e.surface, 'countdown.tsx')) ? (
                  <els.Client key={`t-${l.kind}`} module="./countdown.tsx" props={{ until: l.resetsAt as number, now, color: C.dim, cold: C.dim, clock: true, prefix: 'resets in ' }} />
                ) : (
                  <Text color={T.muted}>{`resets in ${fmtTimer((l.resetsAt as number) - now)}`}</Text>
                )
              ) : (
                <Text color={T.muted} wrap="truncate">{l.resetsAt ? `resets in ${fmtResetIn(l.resetsAt, now)}` : 'no reset time'}</Text>
              )}
            </Box>,
            meter(l.pct / 100, tw - 4, () => pc),
            tw,
          ),
        )
      }
      // Tokens: this session's input, cache reads and output side by side, today's under them, and a
      // stacked bar of their shares (each kind at least a cell when it has any).
      if (S.in + S.cr + S.out > 0) {
        const TEAL = '#4fc1b0'
        tiles.push(tw => {
          const bw = tw - 4
          const tot = S.in + S.cr + S.out
          const raw = [S.in, S.cr, S.out].map(v => (v > 0 ? Math.max(1, Math.round((v / tot) * bw)) : 0))
          const over = raw.reduce((a2, b2) => a2 + b2, 0) - bw
          if (over > 0) raw[1] = Math.max(raw[1]! > 0 ? 1 : 0, raw[1]! - over)
          return tile(
            'tok',
            'Tokens',
            Y.blue,
            <Text wrap="truncate">
              <Text color={T.info} bold>{`↓${fmtTok(S.in)}`}</Text>
              <Text color={TEAL} bold>{`  ${fmtTok(S.cr)}`}</Text>
              <Text color={Y.orange} bold>{`  ↑${fmtTok(S.out)}`}</Text>
            </Text>,
            <Box flexDirection="column">
              <Text color={T.muted} wrap="truncate">{'in · cache · out  (session)'}</Text>
              {D ? <Text color={T.muted} wrap="truncate">{`today ↓${fmtTok(D.in)}  ${fmtTok(D.cr)}  ↑${fmtTok(D.out)}`}</Text> : null}
            </Box>,
            <Text wrap="truncate">
              <Text color={Y.blue}>{'━'.repeat(raw[0]!)}</Text>
              <Text color={TEAL}>{'━'.repeat(raw[1]!)}</Text>
              <Text color={Y.orange}>{'━'.repeat(raw[2]!)}</Text>
            </Text>,
            tw,
          )
        })
      }
      // Cache: the prompt cache's time left, its lifetime and the last request's time to first token.
      const cacheLeft = cacheUntil !== null ? cacheUntil - now : 0
      tiles.push(tw =>
        tile(
          'cache',
          'Prompt cache',
          Y.yellow,
          cacheLeft > 0 ? (
            <Box>
              <Text color={Y.yellow}>{' '}</Text>
              {hasClient && !faulted.has(faultKey(e.surface, 'countdown.tsx')) ? (
                <els.Client key="cache-countdown" module="./countdown.tsx" props={{ until: cacheUntil as number, now, color: Y.yellow, cold: C.dim }} />
              ) : (
                <Text color={Y.yellow} bold>{fmtTimer(cacheLeft)}</Text>
              )}
            </Box>
          ) : (
            <Text color={T.muted}>cold</Text>
          ),
          <Text color={T.muted} wrap="truncate">{`${tk.cacheTtlMs >= 3_600_000 ? '1h' : '5m'} ttl${m.speed ? ` · ${fmtSpeed(m.speed)}` : ''}`}</Text>,
          cacheLeft > 0 ? meter(cacheLeft / tk.cacheTtlMs, tw - 4, () => Y.yellow) : null,
          tw,
        ),
      )
      const hasSpark = hasClient && !faulted.has(faultKey(e.surface, 'spark.tsx'))
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={soft !== null ? grad(soft) : C.main} paddingX={1} width={w}>
          {heading('Overview', '#a970ff', undefined, pill)}
          <Box width={iw}>{pathCell}</Box>
          {/* session facts as labelled chips: the id (what `claude --resume` takes), the mode and the request count */}
          <Box columnGap={2} width={iw} overflow="hidden">
            {rp.sessionId ? (
              <Box flexShrink={1} overflow="hidden">
                <Text wrap="truncate-middle">
                  <Text color={T.muted}>{'session '}</Text>
                  <Text color="#9aa5ce" backgroundColor="#2a2d3a">{` ${rp.sessionId} `}</Text>
                </Text>
              </Box>
            ) : null}
            {m.mode ? (
              <Box flexShrink={0}>
                <Text>
                  <Text color={T.muted}>{'mode '}</Text>
                  <Text color="#bedc5a">{m.mode}</Text>
                </Text>
              </Box>
            ) : null}
            <Box flexShrink={0}>
              <Text>
                <Text color={T.muted}>{'requests '}</Text>
                <Text color={Y.cyan}>{String(m.steps)}</Text>
              </Text>
            </Box>
          </Box>
          {grid(tiles, iw, cols)}
          {/* throughput: the t/m figure and the two-row sparkline across the full width */}
          {S.in + S.out > 0 ? (
            <Box flexDirection="column" borderStyle="round" borderColor={T.border} paddingX={1} width={iw}>
              {heading(
                'Throughput',
                Y.salmon,
                'tokens per minute · last 2 min',
                rate > 0 ? <Text color={T.ok}>{`● live  ${fmtTok(rate)} t/m`}</Text> : <Text color={T.muted}>{'○ idle'}</Text>,
              )}
              {hasSpark ? (
                <els.Client
                  key="token-spark"
                  module="./spark.tsx"
                  width={iw - 4}
                  height={2}
                  props={{ rows: rateRows, now, width: iw - 4, windowMs: SPARK_WINDOW_MS, rateMs: RATE_MS, color: Y.salmon, rateColor: Y.cyan, iconColor: Y.orange, dim: Y.grey }}
                />
              ) : (
                <Text color={Y.cyan}>{`${fmtTok(rate)} t/m`}</Text>
              )}
            </Box>
          ) : null}
          {kt.skills.length > 0 || kt.plugins.length > 0 ? (
            <Box paddingX={1}>
              <Text wrap="truncate">
                {kt.skills.length > 0 ? <Text color="#ec5ca8">{'\u{f07df} '}</Text> : null}
                {kt.skills.length > 0 ? <Text color="#e5c07b">{kt.skills.join(', ')}</Text> : null}
                {kt.skills.length > 0 && kt.plugins.length > 0 ? <Text color={C.faint}>{'   '}</Text> : null}
                {kt.plugins.length > 0 ? <Text color="#e83c3c">{' '}</Text> : null}
                {kt.plugins.length > 0 ? <Text color={T.muted}>{kt.plugins.join(', ')}</Text> : null}
              </Text>
            </Box>
          ) : null}
          {planVisibleNow ? tasksPanel(iw, false) : null}
          {bgShown.length > 0 ? bgPanel(iw, false) : null}
        </Box>
      )
    }

    // ---- tasks: the plan as yas draws it, the running step with its clock, at most seven rows around it
    const tasksPanel = (w: number, bare = false) => {
      // yas's task block: a time column on the left (the plan's age, each done step's length, the running
      // step's clock), then the box, the number and the step; at most seven rows around the running one.
      const items = listOf<PlanItem>(pl.items)
      const done = items.filter(i => i.status === 'completed').length
      const run = items.findIndex(i => i.status === 'in_progress')
      const act = Math.max(0, run >= 0 ? run : items.findIndex(i => i.status === 'pending'))
      const cap = 7
      const from = Math.max(0, Math.min(act - 2, items.length - cap))
      const shown = items.slice(from, from + cap)
      const TW = 6
      const timeCol = (node: RenderChildren) => (
        <Box width={TW} flexShrink={0} justifyContent="flex-end" marginRight={1}>
          {node}
        </Box>
      )
      return (
        <Box flexDirection="column" {...(bare ? {} : { borderStyle: 'round' as const, borderColor: T.border, paddingX: 1 })} width={w}>
          <Box>
            {timeCol(pl.firstAt !== null ? clock('plan-clock', pl.firstAt, pl.doneAt, Y.grey) : <Text> </Text>)}
            <Text>
              <Text color="#c678dd">{'\uf0ae '}</Text>
              <Text color="#c678dd" bold>{`${done}/${items.length}`}</Text>
            </Text>
          </Box>
          {from > 0 ? (
            <Box>
              {timeCol(<Text> </Text>)}
              <Text color={C.faint}>{`… ${from} done above`}</Text>
            </Box>
          ) : null}
          {shown.map(i => {
            const isRun = i.status === 'in_progress'
            const isDone = i.status === 'completed'
            const tc = isRun && i.startedAt !== null ? clock(`task-${i.id}`, i.startedAt, null, Y.orange) : isDone && i.startedAt !== null && i.endedAt !== null ? <Text color={Y.grey}>{fmtTimer(i.endedAt - i.startedAt)}</Text> : <Text> </Text>
            return (
              <Box>
                {timeCol(tc)}
                <Box flexShrink={0} marginRight={1}>
                  <Text color={isDone ? Y.grey : isRun ? Y.orange : Y.grey}>{isDone ? '☑' : isRun ? '\uf4a0' : '☐'}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text color={isDone ? Y.grey : isRun ? Y.orange : '#e5a06b'} bold={isRun} wrap="truncate">
                    {`${i.id}. ${isRun && i.active ? i.active : i.subject}`}
                  </Text>
                </Box>
              </Box>
            )
          })}
          {from + cap < items.length ? (
            <Box>
              {timeCol(<Text> </Text>)}
              <Text color={C.faint}>{`… ${items.length - from - cap} more`}</Text>
            </Box>
          ) : null}
        </Box>
      )
    }

    // ---- bg: background shells and workflows, as yas lists them under its subagents
    const bgPanel = (w: number, bare = false) => (
      <Box flexDirection="column" {...(bare ? {} : { borderStyle: 'round' as const, borderColor: T.border, paddingX: 1 })} width={w}>
        <Text wrap="truncate">
          <Text color="#56c8d6" bold>
            {`background · ${bgShown.filter(i => i.endedAt === null).length} running`}
          </Text>
        </Text>
        {bgShown.slice(-6).map(i => {
          const isRun = i.endedAt === null
          const col = isRun ? '#56c8d6' : i.status === 'completed' ? C.gate : i.status === 'killed' ? C.dim : C.warn
          return (
            <Box columnGap={1}>
              <Box flexShrink={0}>
                <Text color={col}>{isRun ? '▶' : i.status === 'completed' ? '✓' : i.status === 'killed' ? '■' : '✗'}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text color={i.kind === 'workflow' ? '#c678dd' : '#e5c07b'}>{i.kind === 'workflow' ? 'workflow' : 'shell'}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text color={isRun ? C.text : C.dim} wrap="truncate">
                  {i.label}
                </Text>
              </Box>
              {!isRun ? (
                <Box flexShrink={0}>
                  <Text color={C.faint}>{i.status}</Text>
                </Box>
              ) : null}
              <Box flexShrink={0}>{clock(`bg-${i.id}`, i.startedAt, i.endedAt, C.dim)}</Box>
            </Box>
          )
        })}
      </Box>
    )

    // ---- architect
    const lastConsult = a.consults[a.consults.length - 1]
    const architectPanel = (w: number) => {
      // Both ends are anchors (the first consult, now): should it run past its box, it asks to lose the middle.
      const tl = consultTimeline(a, now, Math.max(8, w - 4))
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={T.border} paddingX={1} width={w}>
          <Box justifyContent="space-between">
            <Text color={C.arch} bold wrap="truncate">
              {cfg.architectLabel} · {advising ? 'advising' : 'on call'}
            </Text>
            <Box flexShrink={0}>
              <Text>
                <Text dimColor>consults </Text>
                <Text color={C.arch} bold>
                  {a.consults.length}
                </Text>
              </Text>
            </Box>
          </Box>
          <Text color={C.arch} wrap="truncate-middle">
            {tl}
          </Text>
          {lastConsult ? (
            <Text dimColor wrap="truncate">
              {advising
                ? `consulting since ${fmtClock(lastConsult.at)}`
                : `last ${fmtDuration(now - (lastConsult.endAt ?? lastConsult.at))} ago · took ${fmtDuration((lastConsult.endAt ?? now) - lastConsult.at)}`}
            </Text>
          ) : (
            <Text dimColor>not consulted yet</Text>
          )}
          {cfg.moments ? (
            <Box flexWrap="wrap" columnGap={2}>
              {(['before a plan', 'error repeats', 'before done'] as const).map(mo => {
                const isOn = lastConsult?.moment === mo
                return (
                  <Text color={isOn ? C.arch : C.dim} bold={isOn}>
                    {isOn ? '◆' : '◇'} {mo}
                  </Text>
                )
              })}
              <Text color={C.faint}>(inferred)</Text>
            </Box>
          ) : null}
          {a.lastAdvice ? (
            <Text color={C.arch} wrap="truncate">
              » {a.lastAdvice}
            </Text>
          ) : null}
        </Box>
      )
    }

    // ---- gate
    const s = gateSummary(g)
    const verdictColor = (c: Check) =>
      c.verdict === 'rule' ? C.gate : c.verdict === 'cleared' ? C.cleared : c.verdict === 'ask' ? C.amber : C.warn
    const checkMark = (c: Check) => (
      <Text color={verdictColor(c)} dimColor={c.inSubagent}>
        {c.verdict === 'deny' ? '✗' : '■'}
      </Text>
    )
    const gatePanel = (w: number) => {
      const strip = g.recent.slice(-Math.max(8, marksIn(w - 4, isTerminal)))
      const open = v.gateOpen
      // The totals in words where they all fit, in numbers alone where they don't: the colours say which is which.
      const totalsOf = (isShort: boolean): Piece[] => [
        { spans: [{ text: '■', color: C.gate }, { text: isShort ? ` ${s.rule}` : ` ${s.rule} allowed`, dim: true }] },
        { spans: [{ text: '■', color: C.cleared }, { text: isShort ? ` ${s.cleared}` : ` ${s.cleared} ${decider}`, dim: true }] },
        ...(s.ask > 0 ? [{ spans: [{ text: isShort ? `■ ${s.ask}` : `■ ${s.ask} pending`, color: C.amber }] }] : []),
        { spans: [{ text: isShort ? `✗ ${s.deny}` : `✗ ${s.deny} denied`, color: s.deny > 0 ? C.warn : C.dim }] },
      ]
      const words = totalsOf(false)
      const isShort = piecesThatFit(words.map(p => ({ width: widthOf(p) })), w - 4, 2) < words.length
      const totals = isShort ? totalsOf(true) : words
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={T.border} paddingX={1} width={w}>
          {heading(cfg.gateLabel === 'GATE' ? 'Permissions' : cfg.gateLabel, C.gate, undefined, <Text dimColor>{`${s.total} checks`}</Text>)}
          {strip.length === 0 ? <Text color={C.faint}>no checks yet</Text> : markRow(strip.map(checkMark))}
          {line([...totals, !isShort && w >= 80 && g.recent.some(c => c.inSubagent) ? { spans: [{ text: 'dim: in subagents', color: C.faint }] } : null], w - 4, 2)}
          {/* Below about 44 columns the three rows' buttons take two lines rather than run past the box. */}
          <Box columnGap={2} flexWrap="wrap">
            {(['file', 'shell', 'other'] as const).map((b: Bucket) => {
              const tl = g.totals[b]
              const n = tl.rule + tl.ask + tl.cleared + tl.deny
              return (
                <Button
                  key={`gate-${b}`}
                  plain
                  hotkey={b[0]}
                  label={`${b} ${n}${open === b ? ' ▾' : ''}`}
                  dimColor={n === 0}
                  onPress={() => update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), gateOpen: normalize(DEFAULT_VIEW, x).gateOpen === b ? null : b }))}
                />
              )
            })}
          </Box>
          {open
            ? g.recent
                .filter(c => c.bucket === open)
                .slice(-5)
                .map(c => (
                  // The verdict sits in a box of its own width, not padded with spaces, which a graphical surface collapses.
                  <Box width={w - 4} columnGap={1} overflow="hidden">
                    <Box width={12} flexShrink={0}>
                      <Text>
                        <Text color={verdictColor(c)}>{c.verdict === 'deny' ? '✗ ' : '■ '}</Text>
                        <Text color={C.dim}>{c.verdict === 'rule' ? 'allowed' : c.verdict === 'cleared' ? decider : c.verdict === 'ask' ? 'pending' : 'denied'}</Text>
                      </Text>
                    </Box>
                    <Text dimColor={c.inSubagent} wrap="truncate">
                      {shorten(c.detail, Math.max(10, w - 18))}
                    </Text>
                  </Box>
                ))
            : null}
        </Box>
      )
    }

    // ---- agents: cards up to the limit, swimlanes beyond it
    const statusColor = (c: AgentCard) => (c.status === 'failed' ? C.warn : c.status === 'done' ? C.gate : C.agent)
    const glyph = (c: AgentCard) => (c.status === 'running' ? '◐' : c.status === 'done' ? '✓' : c.status === 'failed' ? '✗' : '■')
    const expandOnPress = (id: string) => () =>
      update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), expanded: normalize(DEFAULT_VIEW, x).expanded === id ? null : id }))

    // yas's subagent figures: t/m (the last minute while it runs, its average once done), its share of
    // the session's tokens, its total and output tokens.
    const sessionTok = Math.max(1, tk.in + tk.cacheRead + tk.out)
    const statsOf = (c: AgentCard) => {
      const a = tk.byAgent?.[c.id]
      if (!a) return null
      const total = a.in + a.out
      const life = Math.max(1, ((c.endedAt ?? now) - c.spawnedAt) / 60_000)
      const recent = a.samples.filter(x => now - x.at <= RATE_MS).reduce((n, x) => n + x.n, 0)
      const rate = c.status === 'running' ? recent : Math.round(total / life)
      return { rate, share: (total * 100) / sessionTok, total, out: a.out }
    }
    const statsText = (c: AgentCard, withModel: boolean) => {
      const st = statsOf(c)
      if (!st) return null
      return `${st.rate.toLocaleString('en-US')} t/m · ◔ ${st.share.toFixed(1)}% · ${fmtTok(st.total)} ↑${fmtTok(st.out)}${withModel && c.model ? ` · ${prettyModel(c.model)}` : ''}`
    }

    const agentsPanel = (w: number) => {
      // Cards need 20 columns each; when the pane can't hold the limit, lanes take over.
      const fit = Math.max(1, Math.min(cfg.maxCards, Math.floor((w + 1) / 21)))
      const useLanes = cards.length > fit
      const isNarrow = w < 40
      const header = (
        <Box width={w} flexDirection="column">
          {heading('Agents', C.agent, isNarrow ? `${running.length}/${cards.length}` : `${running.length} running · ${cards.length} total`, cards.length > 0 ? <Text color={C.faint}>{`1-${Math.min(cards.length, useLanes ? 6 : fit)}${isNarrow ? '' : ' expand'}`}</Text> : undefined)}
        </Box>
      )
      if (cards.length === 0) {
        return (
          <Box flexDirection="column" width={w}>
            {header}
            <Text color={C.faint}>{allCards.length > 0 ? `no agents in the last 5 min · ${allCards.length} this session` : 'no subagents yet'}</Text>
          </Box>
        )
      }
      if (useLanes) {
        const shown = cards.slice(-6)
        // A lane is its glyph, a label, the bar and a clock: below 34 columns the label narrows, below
        // 36 the bar, so a 24-column pane still holds it. From 40 they are as they always were.
        const labelW = Math.min(28, Math.max(7, Math.floor(w * 0.45)))
        const barW = Math.max(4, w - 11 - labelW)
        const geo = lanes(shown, now, barW)
        return (
          <Box flexDirection="column" width={w}>
            {header}
            {cards.length > shown.length ? <Text color={C.faint}>{`+${cards.length - shown.length} earlier`}</Text> : null}
            {shown.map((c, i) => {
              const gm = geo[i]
              const isViewed = viewed === c.id
              const laneRow = (
                <Box columnGap={1}>
                  <Text color={statusColor(c)} bold={isViewed}>
                    {isViewed ? '▶' : glyph(c)}
                  </Text>
                  <Box width={labelW} flexShrink={0}>
                    <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={shorten(cardTitle(c), labelW - 3)} onPress={expandOnPress(c.id)} />
                  </Box>
                  <Box flexShrink={0}>
                    <Text>
                      <Text color={C.faint}>{'·'.repeat(gm?.before ?? 0)}</Text>
                      <Text color={statusColor(c)}>{'━'.repeat(gm?.bar ?? 1)}</Text>
                      <Text color={C.faint}>{'·'.repeat(gm?.after ?? 0)}</Text>
                    </Text>
                  </Box>
                  {clock(`lane-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
                </Box>
              )
              const last = c.tools[c.tools.length - 1]
              const st = statsText(c, true)
              const detail = st || last ? (
                <Box marginLeft={2} columnGap={1} width={w - 2} overflow="hidden">
                  <Box flexGrow={1} flexShrink={1}>
                    <Text color={C.faint} wrap="truncate">{`└ ${last ? last.text : c.type}`}</Text>
                  </Box>
                  {statsOf(c) ? (
                    <Box flexShrink={0}>
                      <Text>
                        <Text color={Y.cyan}>{fmtTok(statsOf(c)!.rate).padStart(6)}</Text>
                        <Text color={Y.grey}>{' t/m · '}</Text>
                        <Text color="#98c379">{`◔${statsOf(c)!.share.toFixed(1).padStart(5)}%`}</Text>
                        <Text color={Y.grey}>{' · '}</Text>
                        <Text color={Y.white}>{fmtTok(statsOf(c)!.total).padStart(6)}</Text>
                        <Text color={Y.orange}>{` ↑${fmtTok(statsOf(c)!.out).padStart(5)}`}</Text>
                        {c.model ? <Text color={Y.grey}>{' · '}</Text> : null}
                        {c.model ? (
                          <Text color={/haiku/i.test(c.model) ? Y.blue : /sonnet/i.test(c.model) ? Y.yellow : /fable/i.test(c.model) ? '#c678dd' : Y.orange}>{prettyModel(c.model)}</Text>
                        ) : null}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              ) : null
              return (
                <Box flexDirection="column">
                  {laneRow}
                  {detail}
                </Box>
              )
            })}
          </Box>
        )
      }
      const shown = cards.slice(-fit)
      const cardW = Math.max(20, Math.floor((w - (shown.length - 1)) / shown.length))
      const centers = shown.map((_, i) => i * (cardW + 1) + Math.floor(cardW / 2))
      return (
        <Box flexDirection="column" width={w}>
          {header}
          {rail('fan-out', running.length > 0, C.agent, w, centers)}
          <Box columnGap={1}>
            {shown.map((c, i) => {
              const isViewed = viewed === c.id
              const sameModel = !c.model || prettyModel(c.model) === modelName
              return (
                <Box
                  flexDirection="column"
                  borderStyle={isViewed ? 'double' : 'round'}
                  borderColor={c.lastStop === 'max_tokens' ? C.warn : C.agent}
                  borderDimColor={c.status !== 'running' && !isViewed}
                  width={cardW}
                  paddingX={1}
                >
                  <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={titleLines(cardTitle(c), cardW - 7, cardW - 4)[0]} onPress={expandOnPress(c.id)} />
                  <Text bold wrap="truncate">
                    {titleLines(cardTitle(c), cardW - 7, cardW - 4)[1]}
                  </Text>
                  <Text color={C.dim} wrap="truncate">
                    {c.model ? `${c.type} · ${prettyModel(c.model)}` : c.type}
                  </Text>
                  <Text dimColor wrap="truncate">
                    {c.steps > 0 ? `ctx ${kTokens(c.ctx)} · out ${kTokens(c.out)} · ${c.steps} st` : 'starting…'}
                  </Text>
                  {statsOf(c) ? (
                    <Text color="#56c8d6" wrap="truncate">
                      {`${statsOf(c)!.rate.toLocaleString('en-US')} t/m · ◔ ${statsOf(c)!.share.toFixed(1)}%`}
                    </Text>
                  ) : null}
                  <Box columnGap={1}>
                    <Text color={c.lastStop === 'max_tokens' ? C.warn : statusColor(c)}>
                      {cardW >= 26 ? `${glyph(c)} ${c.lastStop === 'max_tokens' ? 'max_tokens' : c.status}` : glyph(c)}
                    </Text>
                    <Box flexShrink={0}>{clock(`card-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}</Box>
                  </Box>
                </Box>
              )
            })}
          </Box>
          {rail('merge', running.length > 0, C.agent, w, centers, true)}
        </Box>
      )
    }

    const expandedCard = cards.find(c => c.id === v.expanded)
    const expandedPanel = (w: number) =>
      expandedCard ? (
        <Box flexDirection="column" borderStyle="single" borderColor={C.agent} paddingX={1} width={w}>
          <Text bold wrap="wrap">
            {expandedCard.description || expandedCard.type}
          </Text>
          <Text dimColor wrap="truncate">{`${expandedCard.type} · ${prettyModel(expandedCard.model)} · ${expandedCard.status} · ${expandedCard.steps} steps`}</Text>
          {expandedCard.tools.length === 0 ? <Text color={C.faint}>no tool calls yet</Text> : null}
          {expandedCard.tools.map(n => (
            <Text color={n.isError ? C.warn : C.text} wrap="truncate">
              {`${n.isError ? '✗' : '·'} ${n.text}`}
            </Text>
          ))}
          {expandedCard.answer ? (
            <Text dimColor wrap="wrap">
              {`» ${shorten(expandedCard.answer, 240)}`}
            </Text>
          ) : null}
        </Box>
      ) : null

    // ---- other loops (workflow agents, forks): ids that match no card
    const loopsPanel = (w: number) => {
      if (lp.length === 0) return null
      const active = lp.filter(l => isLoopActive(l, now)).length
      const dots = lp.slice(-Math.max(4, marksIn(w - 38, isTerminal)))
      const isNarrow = w < 40
      return (
        <Box width={w} columnGap={1}>
          <Text bold>{isNarrow ? 'loops' : 'other loops'}</Text>
          <Text dimColor>{isNarrow ? `${lp.length} · ${active} active` : `${lp.length} seen · ${active} active`}</Text>
          {markRow(
            dots.map(l => (
              <Text color={isLoopActive(l, now) ? C.agent : l.isDone ? C.dim : C.faint}>{isLoopActive(l, now) ? '●' : l.isDone ? '✓' : '○'}</Text>
            )),
            1,
          )}
        </Box>
      )
    }

    // ---- receipt: the turn now, or the last one
    const receiptPanel = (w: number) => {
      const isReview = t.isReviewing
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={T.border} paddingX={1} width={w}>
          {m.isRunning ? (
            <Box width={w - 4} columnGap={1} overflow="hidden">
              <Text color={C.main} wrap="truncate">{`◐ back to ${modelName.toLowerCase()} · turn`}</Text>
              <Box flexShrink={0}>{clock('turn-clock', t.startedAt, null, C.main)}</Box>
              {w >= 60 ? <Text dimColor wrap="truncate">{`· ${plural(t.edits, 'edit')} · ${plural(t.errors, 'error')}`}</Text> : null}
            </Box>
          ) : r ? (
            line(
              [
                { spans: [{ text: r.reason === 'answer' ? '✓' : '✗', color: r.reason === 'answer' ? C.gate : C.warn }] },
                {
                  spans: [{ text: `last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}` }],
                  fill: true,
                },
              ],
              w - 4,
            )
          ) : (
            <Text color={C.faint}>no turn finished yet</Text>
          )}
          {isReview ? (
            <Text color={C.arch} wrap="wrap">
              {`${cfg.architectLabel.toLowerCase()} reviewing before done (inferred)`}
            </Text>
          ) : null}
        </Box>
      )
    }

    // ---- log: whatever rows the other panels leave, 4 to 8
    // The main box's speed line, the legend's gap and the gap above the log are a row each.
    const used = 2 + legendGap + 5 + (m.speed ? 1 : 0) + 1 + (showArchitect ? 6 : 0) + 6 + (v.gateOpen ? 5 : 0) + (cards.length > cfg.maxCards ? 3 + Math.min(6, cards.length) : 8) + (expandedCard ? 8 : 0) + (lp.length ? 1 : 0) + 3
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const nLog = logRows(bodyRows, used)
    const allLines = viewed ? lines.filter(l => l.agentId === viewed) : lines
    // The log scrolls on its own: k / ▲ goes back through the kept lines, j / ▼ forward, the window stays nLog tall.
    const logBack = Math.max(0, Math.min(v.logBack ?? 0, allLines.length - nLog))
    const shownLines = allLines.slice(Math.max(0, allLines.length - nLog - logBack), allLines.length - logBack)
    const scrollLog = (by: number) => () =>
      update($, view, x => {
        const cur = normalize(DEFAULT_VIEW, x)
        return { ...cur, logBack: Math.max(0, Math.min((cur.logBack ?? 0) + by, Math.max(0, allLines.length - nLog))) }
      })
    const colorOf = (l: LogLine) =>
      l.kind === 'error' ? C.warn : l.kind === 'consult' ? C.arch : l.who === 'main' ? C.main : l.who === 'gate' ? C.gate : l.who === 'you' ? C.text : C.agent
    // Below 40 columns a line keeps its minute, not its second, and a shorter name.
    const logPanel = (w: number) => (
      <Box flexDirection="column" borderStyle="round" borderColor={T.border} paddingX={1} width={w}>
        {heading(
          'Session log',
          '#a970ff',
          allLines.length > nLog ? `${allLines.length - logBack - shownLines.length + 1}–${allLines.length - logBack} of ${allLines.length}` : viewed ? 'this agent' : undefined,
          allLines.length > nLog ? (
            <Box columnGap={1}>
              <Button key="log-up" plain hotkey="k" label="▲" onPress={scrollLog(3)} />
              <Button key="log-down" plain hotkey="j" label="▼" onPress={scrollLog(-3)} />
            </Box>
          ) : undefined,
        )}
        {shownLines.length === 0 ? <Text color={C.faint}>nothing yet</Text> : null}
        {shownLines.map(l => (
          <Box>
            <Box width={w < 40 ? 6 : 9} flexShrink={0}>
              <Text color={C.faint}>{w < 40 ? fmtClock(l.at).slice(0, 5) : fmtClock(l.at)}</Text>
            </Box>
            <Box width={w < 40 ? 9 : 14} flexShrink={0} marginRight={1}>
              <Text color={colorOf(l)} bold wrap="truncate">
                {l.who}
              </Text>
            </Box>
            <Text color={l.kind === 'error' ? C.warn : C.text} wrap="truncate">
              {l.text}
            </Text>
          </Box>
        ))}
      </Box>
    )

    const draw = (p: Panel, w: number) =>
      p === 'main'
        ? mainPanel(w)
        : p === 'tasks'
          ? tasksPanel(w)
          : p === 'bg'
            ? bgPanel(w)
            : p === 'architect'
          ? architectPanel(w)
          : p === 'gate'
            ? gatePanel(w)
            : p === 'agents'
              ? (
                  <Box borderStyle="round" borderColor={T.border} paddingX={1} width={w}>
                    {agentsPanel(w - 4)}
                  </Box>
                )
              : p === 'loops'
                ? loopsPanel(w)
                : p === 'receipt'
                  ? receiptPanel(w)
                  : logPanel(w)

    // Panels with the flow between them; the agents panel draws its own rails.
    const column = (ps: Panel[], w: number) => (
      <Box flexDirection="column" width={w}>
        {ps.map((p, i) => {
          const prev = ps[i - 1]
          const link =
            i === 0 || p === 'agents' || prev === 'agents' || p === 'log' || p === 'loops' || prev === 'loops'
              ? null
              : rail(`link-${p}`, p === 'architect' ? advising : m.isRunning, p === 'architect' ? C.arch : C.main, w)
          return (
            <Box flexDirection="column">
              {link}
              {draw(p, w)}
              {p === 'agents' ? expandedPanel(w) : null}
            </Box>
          )
        })}
      </Box>
    )

    // Desktop draws the agents' time axis as SVG under the panels.
    const svgLanes =
      e.surface !== 'terminal' && cards.length > 0
        ? (() => {
            const { Svg } = $.ui.resolve(e)
            const rowH = 18
            const pxW = 520
            const geo = lanes(cards.slice(-10), now, 100)
            const rects = cards
              .slice(-10)
              .map((c, i) => {
                const gm = geo[i]
                const x = 150 + ((gm?.before ?? 0) / 100) * (pxW - 160)
                const wpx = Math.max(3, ((gm?.bar ?? 1) / 100) * (pxW - 160))
                const fill = c.status === 'running' ? SVG_COLORS.running : c.status === 'done' ? SVG_COLORS.done : c.status === 'failed' ? SVG_COLORS.failed : SVG_COLORS.other
                const label = shorten(cardTitle(c), 22).replace(/[<&>]/g, '')
                return `<text x="4" y="${i * rowH + 13}" font-size="11" fill="${SVG_COLORS.label}">${label}</text><rect x="${x}" y="${i * rowH + 4}" width="${wpx}" height="10" rx="3" fill="${fill}"/>`
              })
              .join('')
            const svgH = Math.min(10, cards.length) * rowH + 4
            // No width or height on the element: it takes the markup's own width up to the pane's and
            // scales down to fit a narrow one, rather than running past it at 520 pixels.
            return (
              <Svg
                source={`<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${svgH}" viewBox="0 0 ${pxW} ${svgH}">${rects}</svg>`}
                alt={`${cards.length} agents on a time axis`}
              />
            )
          })()
        : null

    // Inline above the prompt (the terminal's main screen), the pane is a summary of at most 8 rows.
    const isMini = layout === 'mini' || (layout === 'auto' && e.props.placement === 'inline')
    if (isMini) {
      const live = [...cards.filter(c => c.status === 'running'), ...cards.filter(c => c.status !== 'running').reverse()].slice(0, 3)
      const counts = `${s.rule} allowed · ${s.cleared} ${decider}${s.ask > 0 ? ` · ${s.ask} pending` : ''} · ${s.deny} denied`
      const strip = g.recent.slice(-Math.max(4, marksIn(W - cfg.gateLabel.length - 2 - counts.length, isTerminal)))
      const mg = ctxFill.pct !== null ? gauge(ctxFill.pct, 6) : null
      return (
        <Box flexDirection="column" width={W}>
          {line(
            [
              {
                spans: [
                  { text: modelName, color: C.main, bold: true },
                  { text: m.isRunning ? ' ● working' : ' ○ idle', color: m.isRunning ? C.main : C.dim },
                ],
              },
              mg
                ? {
                    spans: [
                      { text: '· ctx ', dim: true },
                      { text: mg.on, color: (ctxFill.pct ?? 0) >= 80 ? C.warn : C.main },
                      { text: mg.off, color: C.faint },
                      { text: ` ${Math.round(ctxFill.pct ?? 0)}%` },
                      ...(u.compactions > 0 ? [{ text: ` ${compactMark(u)}`, color: C.amber }] : []),
                    ],
                  }
                : u.compactions > 0
                  ? { spans: [{ text: compactMark(u), color: C.amber }] }
                  : null,
              showArchitect ? { spans: [{ text: `· ${cfg.architectLabel.toLowerCase()} ${advising ? 'advising' : a.consults.length}`, color: C.arch }] } : null,
            ],
            W,
          )}
          {strip.length > 0 ? (
            <Box columnGap={1}>
              <Text dimColor>{cfg.gateLabel.toLowerCase()}</Text>
              {markRow(strip.map(checkMark))}
              <Text color={s.deny > 0 ? C.warn : s.ask > 0 ? C.amber : C.dim} wrap="truncate">
                {counts}
              </Text>
            </Box>
          ) : null}
          {live.map(c => (
            <Box columnGap={1}>
              <Text color={statusColor(c)}>{glyph(c)}</Text>
              <Box width={Math.max(6, W - 30)} flexShrink={0}>
                <Text wrap="truncate">{cardTitle(c)}</Text>
              </Box>
              {c.steps > 0 ? <Text dimColor>{`ctx ${kTokens(c.ctx)}`}</Text> : null}
              {clock(`mini-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
            </Box>
          ))}
          {cards.length > live.length ? (
            <Text color={C.faint} wrap="truncate">{`+${cards.length - live.length} more agents · /flightdeck layout compact for all`}</Text>
          ) : null}
          {lp.length > 0 ? <Text dimColor wrap="truncate">{`other loops ${lp.length} · ${lp.filter(l => isLoopActive(l, now)).length} active`}</Text> : null}
          {!m.isRunning && r ? (
            <Text dimColor wrap="truncate">
              {`last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}`}
            </Text>
          ) : null}
        </Box>
      )
    }

    const legend = fitLegend(
      [
        { label: 'main', color: C.main },
        { label: 'agents', color: C.agent },
        { label: cfg.gateLabel.toLowerCase(), color: C.gate },
        ...(showArchitect ? [{ label: cfg.architectLabel.toLowerCase(), color: C.arch }] : []),
      ],
      W,
    )

    // ---- repo: the session's folder and git state, as yas draws it; the session id is left out first.
    const repoLine = rp.dir ? (
      <Box flexDirection="column" borderStyle="round" borderColor={C.agent} paddingX={1} width={W}>
        {line(
          [
            { spans: [{ text: '⌂ ', color: C.agent }, { text: shortDir(rp.dir), color: C.agent, bold: true }] },
            rp.isRepo
              ? {
                  spans: [
                    { text: '∈ ', color: C.dim },
                    { text: rp.branch ?? 'detached', color: C.gate },
                    ...(rp.sha ? [{ text: `/${rp.sha}`, color: C.dim }] : []),
                  ],
                }
              : { spans: [{ text: 'no git', color: C.faint }] },
            rp.isRepo && rp.dirty > 0 ? { spans: [{ text: `●${rp.dirty}`, color: C.amber }] } : null,
            rp.isRepo && rp.ahead > 0 ? { spans: [{ text: `↑${rp.ahead}`, color: C.gate }] } : null,
            rp.isRepo && rp.behind > 0 ? { spans: [{ text: `↓${rp.behind}`, color: C.warn }] } : null,
          ],
          W - 4,
        )}
        {rp.sessionId ? (
          <Text color={C.faint} wrap="truncate">
            {`session ${rp.sessionId}`}
          </Text>
        ) : null}
        {kt.skills.length > 0 || kt.plugins.length > 0 ? (
          <Text wrap="truncate">
            {kt.skills.length > 0 ? <Text color="#ec5ca8">{'\u{f07df} '}</Text> : null}
            {kt.skills.length > 0 ? <Text color="#e5c07b">{kt.skills.join(',')}</Text> : null}
            {kt.skills.length > 0 && kt.plugins.length > 0 ? <Text color="#808080">{' | '}</Text> : null}
            {kt.plugins.length > 0 ? <Text color="#e83c3c">{'\uf1e6 '}</Text> : null}
            {kt.plugins.length > 0 ? <Text color="#e5c07b">{kt.plugins.join(',')}</Text> : null}
          </Text>
        ) : null}
      </Box>
    ) : null

    const body = isWide ? (
      <Box flexDirection="column">
        <Box columnGap={2}>
          {column(panels.filter(p => p === 'main' || p === 'tasks' || p === 'bg' || p === 'architect' || p === 'gate'), colW)}
          {column(panels.filter(p => p === 'agents' || p === 'loops' || p === 'receipt'), colW)}
        </Box>
        {panels.includes('log') ? logPanel(W) : null}
      </Box>
    ) : (
      column(panels, W)
    )

    return (
      <Box flexDirection="column" width={W}>
        {/* One title bar: the name on the left, what the main loop and the architect are doing on the right. */}
        <Box justifyContent="space-between" width={W} paddingX={1} marginBottom={legendGap}>
          <Text bold wrap="truncate">
            <Text color={C.text}>{W >= 40 ? 'FLIGHTDECK' : 'FD'}</Text>
            {showArchitect ? <Text color={C.arch}>{`  ${cfg.architectLabel} ${advising ? 'advising' : 'on call'}`}</Text> : null}
          </Text>
          <Box flexShrink={0}>
            <Text color={m.isRunning ? Y.orange : C.dim} bold={m.isRunning}>
              {m.isRunning ? '● working' : '○ idle'}
            </Text>
          </Box>
        </Box>
        {body}
        {svgLanes}
      </Box>
    )
  }).catch(($, e, next) => {
    // Without this a failed draw leaves the engine's empty pane.
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" width={Math.max(20, e.props.bodyColumns)}>
        <Text bold>FLIGHTDECK</Text>
        <Text color={C.warn} wrap="wrap">{`draw failed (${next.error.kind}): ${next.error.message ?? 'no message'}`}</Text>
      </Box>
    )
  })
}
