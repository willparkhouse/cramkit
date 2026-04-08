import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import { Sparkles, X, ArrowRight } from 'lucide-react'
import {
  fetchUnseenPublishNotifications,
  dismissPublishNotification,
  type PublishNotification,
} from '@/services/publishNotifications'
import { refreshEnrollments } from '@/store/hydrate'

/**
 * Floating toast (bottom-right) for "your module just dropped" events.
 * Auto-poll only on mount + when the user changes — we don't want to keep
 * polling on a long-lived tab. Each toast is dismissable via the X, which
 * marks the notification seen so it doesn't reappear next session.
 *
 * Auto-enrollment already happened server-side (publish trigger). The toast
 * is purely a heads-up. We refresh the enrollments store on mount so the
 * Modules page reflects the new enrollment immediately.
 */
export function PublishNotificationToast() {
  const { user } = useAuth()
  const [notifs, setNotifs] = useState<PublishNotification[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!user) {
      setNotifs([])
      setLoaded(false)
      return
    }
    let cancelled = false
    void fetchUnseenPublishNotifications().then(async (rows) => {
      if (cancelled) return
      setNotifs(rows)
      setLoaded(true)
      // If there's anything to show, the user just got auto-enrolled —
      // sync the local enrollment store so the Modules page is up to date.
      if (rows.length > 0) {
        await refreshEnrollments().catch(() => {})
      }
    })
    return () => {
      cancelled = true
    }
  }, [user])

  const dismiss = async (id: string) => {
    setNotifs((prev) => prev.filter((n) => n.id !== id))
    await dismissPublishNotification(id)
  }

  if (!loaded || notifs.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
      {notifs.map((n) => (
        <div
          key={n.id}
          className="pointer-events-auto rounded-lg border border-primary/40 bg-background shadow-lg p-4 flex items-start gap-3 animate-in slide-in-from-bottom-2 fade-in duration-300"
        >
          <Sparkles className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">{n.exam_name} just dropped</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              You've been auto-enrolled. Quizzes and source search are ready to go.
            </div>
            <Link
              to="/modules"
              onClick={() => void dismiss(n.id)}
              className="text-xs text-primary inline-flex items-center gap-0.5 mt-2 hover:underline"
            >
              Open module <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <button
            type="button"
            onClick={() => void dismiss(n.id)}
            className="text-muted-foreground hover:text-foreground p-0.5 -mt-0.5 -mr-0.5"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
