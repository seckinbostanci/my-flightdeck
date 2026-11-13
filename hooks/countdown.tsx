// The prompt cache's time left, ticking on the surface's frame clock so the pane need not redraw.
// `until` and `now` come from the hooks module's $.clock; between redraws it counts down on its own.
import type { ClientModule } from 'claude-code'

type Props = { until: number; now: number; color: string; cold: string; clock?: boolean; prefix?: string }
type Ref = { left: number; ticks: number; lastNow: number }
type State = { ref: Ref }

// yas's fmt_dur: 34s, 2m24s, 1h05m.
const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const hrs = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  if (hrs) return `${hrs}h${String(mins).padStart(2, '0')}m`
  return mins ? `${mins}m${String(s % 60).padStart(2, '0')}s` : `${s % 60}s`
}

const Countdown: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref = surface.state?.ref ?? { left: 0, ticks: 0, lastNow: -1 }
  if (props.now !== ref.lastNow) {
    // A fresh reading from the hooks module: restart the local count from it.
    ref.lastNow = props.now
    ref.left = props.until - props.now
    ref.ticks = 0
  }
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(1000, () => {
      if (ref.left - ref.ticks * 1000 > 0) {
        ref.ticks += 1
        surface.setState({ ref })
      }
    })
  }
  const left = ref.left - ref.ticks * 1000
  if (props.clock) {
    // The window has reset: the T- clock leaves rather than sitting at 0:00 until the next redraw.
    if (left <= 0) return <Text>{''}</Text>
    // yas's T- clock: h:mm:ss, or m:ss under an hour.
    const s = Math.max(0, Math.floor(left / 1000))
    // Not `h`: that name is the JSX factory, and shadowing it here would break the <Text> below.
    const hrs = Math.floor(s / 3600)
    const mins = Math.floor((s % 3600) / 60)
    const t = hrs ? `${hrs}:${String(mins).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${mins}:${String(s % 60).padStart(2, '0')}`
    return <Text color={props.color}>{`${props.prefix ?? ''}${t}`}</Text>
  }
  return left > 0 ? <Text color={props.color}>{fmt(left)}</Text> : <Text color={props.cold}>cold</Text>
}

export default Countdown
