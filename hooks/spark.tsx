// yas's t/m cell, ported line for line from yas 0.9.9 (claude/yas/tokens.py TokenRate.update and
// TokenRate.history, yas_image_layout._spark2): the same kind of samples (cumulative totals after each
// request, kept by the hooks module), the same rate, the same buckets and the same two-row, 16-level salmon sparkline.
// It ticks every second, as yas re-renders every second, so the buckets slide between redraws.
import type { ClientModule } from 'claude-code'

type Row = [number, number, number] // [epoch seconds, total input, total output]
type Props = {
  rows: Row[]
  now: number // ms
  width: number
  windowMs: number // the sparkline's window: yas passes 120 s
  rateMs: number // TokenRate.WINDOW: yas's token_window, 60 s
  color: string
  rateColor: string
  iconColor: string
  dim: string
}
type Ref = { ticks: number; lastNow: number; props: Props }
type State = { ref: Ref }

const RAMP = '▁▂▃▄▅▆▇█' // C.SPARK_RAMP
// yas's render/text.fmt_tok: promoted at the rounding boundary so it never exceeds six characters.
const fmtTok = (n: number) =>
  n >= 999_950_000 ? `${(n / 1_000_000_000).toFixed(1)}B` : n >= 999_950 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)

/** TokenRate.update's return: tokens gained between the first and last sample inside the window. */
function tokRate(rows: Row[], now: number, window: number): number {
  const samples = rows.filter(([ts]) => now - ts <= window).sort((a, b) => a[0] - b[0])
  if (samples.length < 2) return 0
  const [, ti0, to0] = samples[0]!
  const [, ti1, to1] = samples[samples.length - 1]!
  return Math.max(0, ti1 + to1 - (ti0 + to0))
}

/** TokenRate.history: each delta between consecutive samples lands in the bucket of its midpoint. */
function history(rows: Row[], now: number, nBuckets: number, window: number): number[] {
  if (nBuckets <= 0) return []
  const samples = rows.filter(([ts]) => now - ts <= window + window / nBuckets).sort((a, b) => a[0] - b[0])
  if (samples.length < 2) return Array.from({ length: nBuckets }, () => 0)
  const bucketSize = window / nBuckets
  const lastBucket = Math.floor(now / bucketSize)
  const firstBucket = lastBucket - nBuckets + 1
  const buckets = Array.from({ length: nBuckets }, () => 0)
  for (let i = 0; i < samples.length - 1; i++) {
    const [ts0, ti0, to0] = samples[i]!
    const [ts1, ti1, to1] = samples[i + 1]!
    const delta = Math.max(0, ti1 + to1 - (ti0 + to0))
    if (delta === 0) continue
    const abs = Math.floor((ts0 + ts1) / 2 / bucketSize)
    if (abs >= firstBucket && abs <= lastBucket) buckets[abs - firstBucket]! += delta
  }
  return buckets
}

/** yas_image_layout._spark2: 16 levels, the bottom row 1-8 over a ▁ baseline, the top row 9-16. */
function spark2(hist: number[]): [string, string] {
  if (hist.length === 0) return ['', '']
  const hi = Math.max(...hist) || 1
  let top = ''
  let bot = ''
  for (const v of hist) {
    const lvl = v ? Math.round((v / hi) * 16) : 0
    bot += lvl === 0 ? '▁' : RAMP[Math.min(lvl, 8) - 1]
    top += lvl > 8 ? RAMP[lvl - 9] : ' '
  }
  return [top, bot]
}

const Spark: ClientModule<Props, State> = (props, surface) => {
  const { Text, Box } = surface.elements
  const ref = surface.state?.ref ?? { ticks: 0, lastNow: -1, props }
  ref.props = props // the timer reads the latest props, not the ones it was set up with
  if (props.now !== ref.lastNow) {
    ref.lastNow = props.now
    ref.ticks = 0
  }
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(1000, () => {
      ref.ticks += 1
      surface.setState({ ref })
    })
  }
  const now = (props.now + ref.ticks * 1000) / 1000
  const rate = tokRate(props.rows, now, props.rateMs / 1000)
  // yas: rate = ICON_TOK_RATE + ' ' + fmt_tok(rate) + ' t/m'; the sparkline fills the rest of the cell.
  // The label is plain text over two rows (the rate, then t/m): a Nerd Font glyph on only one of the
  // rows could be drawn wider than the layout measured it and push that row's bars a column right.
  // A fixed width keeps the bars from shifting as the figure grows from 1 to 6 characters.
  const headW = 7
  const sw = Math.max(0, props.width - headW)
  const [top, bot] = spark2(history(props.rows, now, sw, props.windowMs / 1000))
  // The label and the two sparkline rows sit in boxes of their own: both rows start at the same column
  // whatever width the terminal gives the gauge glyph, so the top row's bars stand on the bottom row's.
  return (
    <Box>
      <Box flexShrink={0} width={headW} flexDirection="column">
        <Text color={props.rateColor} bold>
          {fmtTok(rate)}
        </Text>
        <Text color={props.dim}>t/m</Text>
      </Box>
      <Box flexDirection="column" width={sw} overflow="hidden">
        <Text color={props.color}>{top}</Text>
        <Text color={props.color}>{bot}</Text>
      </Box>
    </Box>
  )
}

export default Spark
