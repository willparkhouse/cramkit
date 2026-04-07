import { useEffect, useRef } from 'react'
import { bumpStudyActivity } from '@/services/activity'

const FLUSH_INTERVAL_MS = 60_000   // flush accumulated time every minute
const TICK_INTERVAL_MS = 5_000      // sample every 5s
const IDLE_THRESHOLD_MS = 90_000   // count user as idle after 90s of no input

/**
 * Tracks how many seconds the user is actively engaged with the app and
 * flushes them into study_stats_daily.active_seconds via bump_study_activity.
 *
 * "Active" = tab visible AND user has interacted within the last
 * IDLE_THRESHOLD_MS. We sample every TICK_INTERVAL_MS, accumulate locally,
 * and flush every FLUSH_INTERVAL_MS to keep DB writes bounded.
 *
 * Mount once at the app root for any signed-in user.
 */
export function useActiveTime(enabled: boolean): void {
  const accumulatedSecondsRef = useRef(0)
  const lastInteractionRef = useRef(Date.now())

  useEffect(() => {
    if (!enabled) return

    const bump = () => {
      lastInteractionRef.current = Date.now()
    }

    const events: (keyof WindowEventMap)[] = [
      'mousemove',
      'mousedown',
      'keydown',
      'scroll',
      'touchstart',
    ]
    for (const e of events) window.addEventListener(e, bump, { passive: true })

    const tick = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const idleFor = Date.now() - lastInteractionRef.current
      if (idleFor > IDLE_THRESHOLD_MS) return
      accumulatedSecondsRef.current += TICK_INTERVAL_MS / 1000
    }, TICK_INTERVAL_MS)

    const flush = setInterval(() => {
      const seconds = Math.round(accumulatedSecondsRef.current)
      if (seconds <= 0) return
      accumulatedSecondsRef.current = 0
      void bumpStudyActivity({ activeSeconds: seconds })
    }, FLUSH_INTERVAL_MS)

    // Final flush on unload — best-effort, browser may not let it complete.
    const onHide = () => {
      const seconds = Math.round(accumulatedSecondsRef.current)
      if (seconds <= 0) return
      accumulatedSecondsRef.current = 0
      void bumpStudyActivity({ activeSeconds: seconds })
    }
    window.addEventListener('pagehide', onHide)
    window.addEventListener('beforeunload', onHide)

    return () => {
      for (const e of events) window.removeEventListener(e, bump)
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('beforeunload', onHide)
      clearInterval(tick)
      clearInterval(flush)
      onHide()
    }
  }, [enabled])
}
