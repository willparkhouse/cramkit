import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Flag, Loader2, X } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { useAppStore } from '@/store/useAppStore'
import { adminFlagQuestion, adminUnflagQuestion } from '@/lib/api'

/**
 * Admin-only flag toggle for a single question. Renders nothing for
 * non-admins. Click reveals an inline comment editor below the trigger;
 * Save persists the flag (creating or updating), Remove clears it.
 *
 * Used in both the main Quiz QuestionCard and the inline ConceptQuiz on
 * the Study page — same UX in both places so admins don't have to learn
 * two flows.
 */
export function QuestionFlagButton({ questionId }: { questionId: string }) {
  const { isAdmin } = useAuth()
  const flag = useAppStore((s) => s.questionFlags[questionId])
  const setFlag = useAppStore((s) => s.setQuestionFlag)
  const clearFlag = useAppStore((s) => s.clearQuestionFlag)

  const [open, setOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Sync editor with the current flag whenever the panel is opened.
  useEffect(() => {
    if (open) {
      setComment(flag?.comment ?? '')
      setError(null)
      // Defer to next tick so the textarea is mounted before focus.
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }, [open, flag?.comment])

  if (!isAdmin) return null

  const isFlagged = !!flag

  const save = async () => {
    setBusy(true)
    setError(null)
    const trimmed = comment.trim()
    try {
      await adminFlagQuestion(questionId, trimmed || null)
      setFlag(questionId, trimmed || null)
      setOpen(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await adminUnflagQuestion(questionId)
      clearFlag(questionId)
      setOpen(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        className={
          'h-6 px-2 text-[11px] shrink-0 -my-1 ' +
          (isFlagged
            ? 'text-orange-500 hover:text-orange-600'
            : 'text-muted-foreground hover:text-foreground')
        }
        title={isFlagged ? 'Edit flag on this question' : 'Flag this question for review'}
      >
        <Flag className={'h-3 w-3 mr-1 ' + (isFlagged ? 'fill-orange-500' : '')} />
        {isFlagged ? 'Flagged' : 'Flag'}
      </Button>

      {open && (
        <div className="w-full rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="font-medium">
              {isFlagged ? 'Edit flag' : 'Flag this question'}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What needs attention? (optional)"
            rows={2}
            className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            disabled={busy}
          />
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            {isFlagged && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void remove()}
                disabled={busy}
                className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
              >
                Remove flag
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => void save()}
              disabled={busy}
              className="h-7 px-3 text-[11px]"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : isFlagged ? 'Save' : 'Flag'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
