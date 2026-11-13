/** One step of the task plan (TaskCreate/TaskUpdate, or TodoWrite's list). */
export type PlanItem = { id: string; subject: string; active: string; status: string; startedAt: number | null; endedAt: number | null }
export type Plan = { items: PlanItem[]; firstAt: number | null; doneAt: number | null }

/** Background shells (Bash run_in_background) and workflow runs, from launch to their notification. */
export type BgItem = { id: string; kind: string; label: string; status: string; startedAt: number; endedAt: number | null }
export type Bg = { items: BgItem[] }

/** This session's totals and today's (all sessions), from Flightdeck's own day book in $.store. */
export type Day = { has: boolean; source?: string; sIn: number; sCr: number; sOut: number; dIn: number; dCr: number; dOut: number }

/** Skills run this session (in order of first use) and the plugins enabled in settings. */
export type Kit = { skills: string[]; plugins: string[] }

/** The session's directory and its git state, read with `git status` at session start and around each main turn. */
export type Repo = {
  dir: string
  sessionId: string
  isRepo: boolean
  branch: string | null
  sha: string | null
  /** Changed, staged and untracked entries. */
  dirty: number
  /** The same split as yas shows it: modified (*), untracked (•), deleted (-). */
  mod?: number
  untracked?: number
  del?: number
  ahead: number
  behind: number
}

/** Session token totals, main loop and subagents, and recent samples for the t/m rate and sparkline. */
export type Tokens = {
  /** Uncached input plus cache writes. */
  in: number
  cacheRead: number
  out: number
  /** One entry per model request: when it ended and all tokens it moved. */
  samples: { at: number; n: number }[]
  /** The same per subagent, by its agent id: its share of the session and its own t/m. */
  byAgent?: Record<string, { in: number; out: number; samples: { at: number; n: number }[] }>
  /** Flightdeck's own t/m samples, as yas logs its own: [epoch seconds, session input, session output] after each request. */
  rows?: [number, number, number][]
  /** When the main loop's last request ended: the prompt cache's clock starts there. */
  lastMainAt: number | null
  /** The cache's lifetime, from the last request that wrote it: 5 minutes or 1 hour. */
  cacheTtlMs: number
}

export type Moment = 'before a plan' | 'error repeats' | 'before done'

export type Bucket = 'file' | 'shell' | 'other'

/** rule: settings allowed it. ask: put to the decider, outcome pending. cleared: asked, then ran. deny: refused. */
export type Verdict = 'rule' | 'ask' | 'cleared' | 'deny'

export type Main = {
  model: string
  effort: string
  mode: string
  steps: number
  isRunning: boolean
  /** The main loop's last answered request: time to its first piece of response. Null until one is
   *  measured, absent in older state; a `tokPerS` kept by 0.5.0 and earlier is ignored. */
  speed?: { ttftMs: number } | null
}

export type Usage = {
  pct: number | null
  tokens: number | null
  window: number
  /** The compaction window (`autoCompactWindow`, or the host's own) the host measures context against, when auto-compaction
   *  is on and the window is smaller than the model's; null when none is set or none could be read. */
  compactWindow: number | null
  /** The model window `compactWindow` was read for, so a model switch reads it again; 0 = not read yet. */
  compactFor: number
  /** Reads for this model window that came back with no breakdown or failed; it stops asking at 3. */
  compactMisses: number
  costUsd: number | null
  /** `resetsAt`: when the window resets, in ms since the epoch; null when the API gave no time,
   *  absent in state saved before it was kept. */
  limits: { kind: string; pct: number; resetsAt?: number | null }[]
  compactions: number
  lastCompactAt: number | null
  /** `compactions` counts main-loop requests that found the context emptied (afterFillRead), not
   *  session.compact calls, which Claude Code's built-in guard keeps from user plugins. */
  isCompactEstimate: boolean
  /** session.compact has reached Flightdeck: from then on the count is that hook's alone. */
  isCompactHooked: boolean
  /** A main-loop response has come back since the context last started over (a new session, a /clear,
   *  a compaction), so `$.session.usage()` reports a fill until the next compaction. */
  hasFill: boolean
}

export type Consult = { id: string; at: number; endAt: number | null; moment: Moment; via: string }

export type Architect = { consults: Consult[]; ids: string[]; seen: string[]; lastAdvice: string }

export type Check = {
  id: string
  tool: string
  bucket: Bucket
  verdict: Verdict
  inSubagent: boolean
  detail: string
  at: number
}

export type Tally = { rule: number; ask: number; cleared: number; deny: number }

export type Gate = { recent: Check[]; totals: Record<Bucket, Tally> }

export type ToolNote = { tool: string; text: string; isError: boolean }

export type AgentCard = {
  id: string
  type: string
  model: string
  description: string
  status: string
  spawnedAt: number
  endedAt: number | null
  /** The agent's context now: input + cache read + cache write of its latest step. */
  ctx: number
  /** Output tokens summed over its steps. */
  out: number
  steps: number
  lastStop: string | null
  tools: ToolNote[]
  answer: string
}

/** A model loop whose id matches no card: a workflow agent, a compaction or a memory fork. */
export type Loop = { id: string; steps: number; firstAt: number; lastAt: number; isDone: boolean }

export type LogLine = {
  at: number
  who: string
  text: string
  agentId: string | null
  kind: 'info' | 'error' | 'consult' | 'done'
}

export type Turn = {
  edits: number
  errorStreak: number
  errors: number
  isReviewing: boolean
  startedAt: number
  costAtStart: number | null
}

export type Receipt = {
  durationMs: number
  agents: number
  edits: number
  errors: number
  costDelta: number | null
  reason: string
}

export type Layout = 'auto' | 'compact' | 'wide' | 'mini'

export type View = { expanded: string | null; gateOpen: Bucket | null; layout: Layout | null; /** Log lines scrolled back from the newest. */ logBack?: number }

export type Roster = { architectTypes: string[] }

declare module 'claude-code' {
  interface PluginState {
    'flightdeck': {
      meta: { schemaVersion: number }
      main: Main
      usage: Usage
      architect: Architect
      gate: Gate
      agents: AgentCard[]
      loops: Loop[]
      log: LogLine[]
      turn: Turn
      receipt: Receipt | null
      view: View
      roster: Roster
      repo: Repo
      tokens: Tokens
      kit: Kit
      plan: Plan
      bg: Bg
      day: Day
    }
  }
}
