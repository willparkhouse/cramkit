import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SkipForward, Lightbulb, X, Loader2 } from 'lucide-react'
import { MCQOptions } from './MCQOptions'
import { FreeFormAnswer } from './FreeFormAnswer'
import { QuestionFlagButton } from './QuestionFlagButton'
import { useAppStore } from '@/store/useAppStore'
import { getModuleShortName } from '@/lib/constants'
import { streamHint } from '@/lib/api'
import { useSetup } from '@/lib/setupContext'
import type { Question, Concept } from '@/types'

interface QuestionCardProps {
  question: Question
  concept: Concept
  onSubmitMCQ: (answer: string) => void
  onSubmitFreeForm: (answer: string) => void
  onIdk: () => void
  onSkip: () => void
  loading: boolean
}

type HintLevel = 'terse' | 'detailed'

type HintStreamState =
  | { phase: 'closed' }
  // `text` carries the prior terse text when expanding so the panel can keep
  // rendering it during the small "expanding…" gap before the first delta.
  // For a fresh terse load, text is empty.
  | { phase: 'loading'; level: HintLevel; text: string }
  | { phase: 'streaming'; level: HintLevel; text: string }
  | { phase: 'done'; level: HintLevel; text: string }
  | { phase: 'error'; level: HintLevel; message: string }
  // Free user with no BYOK key — shown as an upgrade/setup CTA in the panel.
  | { phase: 'missing_key'; level: HintLevel }

export function QuestionCard({
  question,
  concept,
  onSubmitMCQ,
  onSubmitFreeForm,
  onIdk,
  onSkip,
  loading,
}: QuestionCardProps) {
  const exams = useAppStore((s) => s.exams)
  const ownerExam = exams.find((e) => concept.module_ids.includes(e.id))
  const moduleShort = ownerExam ? getModuleShortName(ownerExam) : null

  // Breadcrumb pieces — drop any that are missing rather than showing
  // dangling separators.
  const breadcrumbParts: string[] = []
  if (moduleShort) breadcrumbParts.push(moduleShort)
  if (concept.week !== null && concept.week !== undefined) breadcrumbParts.push(`Week ${concept.week}`)
  if (concept.lecture) breadcrumbParts.push(concept.lecture)

  // Hint state. Reset whenever the question changes — otherwise the previous
  // question's hint would briefly show on the new card.
  const [hint, setHint] = useState<HintStreamState>({ phase: 'closed' })
  const lastQuestionRef = useRef(question.id)
  // Track the question id of the in-flight stream so a stale stream doesn't
  // pump tokens into the new card after the user has clicked Next.
  const streamQuestionRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastQuestionRef.current !== question.id) {
      lastQuestionRef.current = question.id
      streamQuestionRef.current = null
      setHint({ phase: 'closed' })
    }
  }, [question.id])

  const { openSetup } = useSetup()

  const requestHint = async (level: HintLevel = 'terse') => {
    if (hint.phase === 'loading' || hint.phase === 'streaming') return

    // For "detailed" requests, preserve the prior terse text and append the
    // continuation to it. For "terse" requests, start from empty. The
    // early-return above means hint.phase is one of 'closed' | 'done' |
    // 'error' | 'missing_key' — only 'done' carries usable prior text.
    const priorText = level === 'detailed' && hint.phase === 'done' ? hint.text : ''
    // The separator between the terse hint and its continuation. The detailed
    // prompt asks for a connecting word, so a single space joins them into
    // one paragraph cleanly.
    const separator = priorText ? ' ' : ''

    setHint({ phase: 'loading', level, text: priorText })
    streamQuestionRef.current = question.id

    let streamingDelta = ''
    await streamHint(
      { questionId: question.id, level, previous: priorText },
      {
        onDelta: (chunk) => {
          if (streamQuestionRef.current !== question.id) return
          streamingDelta += chunk
          setHint({
            phase: 'streaming',
            level,
            text: priorText + separator + streamingDelta,
          })
        },
        onDone: () => {
          if (streamQuestionRef.current !== question.id) return
          setHint({
            phase: 'done',
            level,
            text: priorText + separator + streamingDelta,
          })
        },
        onError: (message) => {
          if (streamQuestionRef.current !== question.id) return
          setHint({ phase: 'error', level, message })
        },
        onMissingKey: () => {
          if (streamQuestionRef.current !== question.id) return
          setHint({ phase: 'missing_key', level })
        },
      },
    )
  }

  const closeHint = () => {
    streamQuestionRef.current = null
    setHint({ phase: 'closed' })
  }

  // Hint button is disabled while a hint is loading or already streaming.
  const hintBusy = hint.phase === 'loading' || hint.phase === 'streaming'
  const hintOpen = hint.phase !== 'closed'

  return (
    <Card className="gap-0 py-4">
      <CardHeader className="pb-3">
        {breadcrumbParts.length > 0 && (
          <div className="text-[11px] text-muted-foreground mb-1.5">
            {breadcrumbParts.join(' · ')}
          </div>
        )}
        <div className="flex items-start gap-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
            {/* Concept name links to the Study page for that specific concept,
                so a stuck student can click "I need to learn this first" without
                losing the quiz. Opens in a new tab so quiz progress isn't lost.
                Falls back to a non-link Badge when we can't resolve the owning
                module (concepts without module_ids — shouldn't happen but be safe). */}
            {ownerExam ? (
              <Link
                to={`/study?module=${encodeURIComponent(ownerExam.id)}&concept=${encodeURIComponent(concept.id)}`}
                target="_blank"
                rel="noreferrer"
                title={`Open ${concept.name} in Study (new tab)`}
              >
                <Badge variant="secondary" className="text-[10px] cursor-pointer hover:bg-secondary/80 transition-colors">
                  {concept.name}
                </Badge>
              </Link>
            ) : (
              <Badge variant="secondary" className="text-[10px]">{concept.name}</Badge>
            )}
            <Badge variant="outline" className="text-[10px]">
              {question.type === 'mcq' ? 'MCQ' : 'Free form'}
            </Badge>
            <Badge variant="outline" className="text-[10px]">Difficulty {question.difficulty}</Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onSkip}
            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground shrink-0 -my-1"
            title="Show me a different question (doesn't affect your score)"
          >
            <SkipForward className="h-3 w-3 mr-1" />
            Skip
          </Button>
          <QuestionFlagButton questionId={question.id} />
        </div>
        <CardTitle className="text-base font-medium leading-relaxed">
          {question.question}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4 space-y-3">
        <HintPanel
          state={hint}
          onClose={closeHint}
          onRequestMore={() => requestHint('detailed')}
          onOpenSetup={() => openSetup('required')}
        />

        {question.type === 'mcq' && question.options ? (
          <MCQOptions
            options={question.options}
            correctAnswer={question.correct_answer}
            onSubmit={onSubmitMCQ}
            onIdk={onIdk}
            onRequestHint={() => requestHint('terse')}
            hintBusy={hintBusy}
            hintOpen={hintOpen}
          />
        ) : (
          <FreeFormAnswer
            onSubmit={onSubmitFreeForm}
            onIdk={onIdk}
            loading={loading}
            onRequestHint={() => requestHint('terse')}
            hintBusy={hintBusy}
            hintOpen={hintOpen}
          />
        )}
      </CardContent>
    </Card>
  )
}

// ----------------------------------------------------------------------------
// Hint panel — renders nothing while closed, otherwise shows the streamed
// hint inline above the answer options. The terse hint is the default; once
// it lands, a "Tell me more" button appears that re-streams a longer one
// (replacing the terse one in place — not appending).
// ----------------------------------------------------------------------------
function HintPanel({
  state,
  onClose,
  onRequestMore,
  onOpenSetup,
}: {
  state: HintStreamState
  onClose: () => void
  onRequestMore: () => void
  onOpenSetup: () => void
}) {
  if (state.phase === 'closed') return null

  const showSpinner = state.phase === 'loading' || state.phase === 'streaming'
  const canRequestMore = state.phase === 'done' && state.level === 'terse'

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 relative">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Lightbulb className="h-3.5 w-3.5" />
        <span className="font-medium">Hint</span>
        {showSpinner && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-5 w-5 p-0 ml-auto text-muted-foreground hover:text-foreground"
          aria-label="Close hint"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {/* When expanding (loading with prior text), keep the prior text on
          screen so it doesn't blink out — the spinner in the header is enough
          to show that something is happening. The "Pulling lecture material…"
          line only shows on a fresh terse load when there's nothing yet. */}
      {state.phase === 'loading' && !state.text && (
        <p className="text-xs text-muted-foreground italic">Pulling lecture material…</p>
      )}

      {(state.phase === 'loading' || state.phase === 'streaming' || state.phase === 'done') && state.text && (
        <div className="prose prose-sm dark:prose-invert max-w-none text-sm cramkit-chat-prose">
          <Markdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
          >
            {state.text}
          </Markdown>
        </div>
      )}

      {canRequestMore && (
        <div className="flex">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRequestMore}
            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Tell me more
          </Button>
        </div>
      )}

      {state.phase === 'missing_key' && (
        <div className="space-y-1.5">
          <p className="text-xs text-foreground/80">
            Hints need an Anthropic key. Add your own in Settings, or upgrade
            to Pro to let cramkit handle the AI for you.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={onOpenSetup}
            className="h-6 px-2 text-[11px]"
          >
            Open Settings
          </Button>
        </div>
      )}

      {state.phase === 'error' && (
        <p className="text-xs text-destructive">{state.message}</p>
      )}
    </div>
  )
}
