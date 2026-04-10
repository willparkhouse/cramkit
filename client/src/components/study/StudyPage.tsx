import { useEffect, useMemo, useState, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store/useAppStore'
import { useSetup } from '@/lib/setupContext'
import { getEffectiveScore } from '@/store/selectors'
import { getModuleShortName, MODULE_COLOURS } from '@/lib/constants'
import {
  streamLesson,
  streamLessonChat,
  type LessonChatTurn,
  type SourceChunk,
} from '@/lib/api'
import { renderWithCitations } from '@/lib/citations'
import { ConceptQuiz } from './ConceptQuiz'
import {
  BookOpen,
  ChevronRight,
  ChevronLeft,
  Loader2,
  Sparkles,
  CheckCircle2,
  Lock,
  Search,
  Send,
  MessageCircle,
  ExternalLink,
  FileText,
  Video,
  ChevronDown,
} from 'lucide-react'
import type { Concept, Exam } from '@/types'

/**
 * Study page — guided revision walkthrough.
 *
 * Three views in one component:
 *   1. Module picker (default landing)
 *   2. Lesson view (one concept: AI walkthrough + source links + "quiz me")
 *   3. Mini quiz view (3-5 questions on the current concept, then back to lesson)
 *
 * The Search Materials feature folded into this page as a "Find a moment"
 * button on the module picker — discoverable but doesn't compete with the
 * primary guided flow.
 *
 * The AI walkthrough is Pro-gated server-side; free users see an upgrade
 * prompt instead of a generated lesson.
 */
export function StudyPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const exams = useAppStore((s) => s.exams)
  const enrolledModuleIds = useAppStore((s) => s.enrolledModuleIds)
  const concepts = useAppStore((s) => s.concepts)
  const knowledge = useAppStore((s) => s.knowledge)

  const enrolledExams = useMemo(
    () => exams.filter((e) => enrolledModuleIds.includes(e.id)),
    [exams, enrolledModuleIds]
  )

  // Internal navigation state. Could be in URL, but the lesson view is
  // ephemeral (no shareable bookmarks needed) so local state is fine.
  const [view, setView] = useState<'pick' | 'lesson'>('pick')
  const [selectedExamId, setSelectedExamId] = useState<string | null>(null)
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null)
  const [activeConceptId, setActiveConceptId] = useState<string | null>(null)
  const allQuestions = useAppStore((s) => s.questions)

  // "Perfect" = every question for this concept has been attempted AND its
  // most recent attempt was correct. Derived from the persisted knowledge
  // history (which the inline quiz already updates via updateKnowledge), so
  // the tick survives page reloads and DB sync without any extra state.
  const isConceptPerfect = useMemo(() => {
    return (conceptId: string): boolean => {
      const k = knowledge[conceptId]
      if (!k || k.history.length === 0) return false
      const latest = new Map<string, boolean>()
      for (const h of k.history) latest.set(h.question_id, h.correct)
      const cqs = allQuestions.filter((q) => q.concept_id === conceptId)
      if (cqs.length === 0) return false
      return cqs.every((q) => latest.get(q.id) === true)
    }
  }, [knowledge, allQuestions])

  // Deep-link via /study?module=ID&concept=ID. Quiz pages link here so a
  // student can jump from a question they don't understand straight into
  // the relevant lesson. Wait until exams + concepts have hydrated so the
  // lookups don't fall through, then consume + clear the params so back-
  // navigation doesn't re-trigger.
  useEffect(() => {
    const moduleParam = searchParams.get('module')
    const conceptParam = searchParams.get('concept')
    if (!moduleParam && !conceptParam) return
    if (enrolledExams.length === 0 || concepts.length === 0) return
    if (moduleParam && enrolledExams.some((e) => e.id === moduleParam)) {
      setSelectedExamId(moduleParam)
      setView('lesson')
      if (conceptParam) {
        const exists = concepts.some(
          (c) => c.id === conceptParam && c.module_ids.includes(moduleParam)
        )
        if (exists) {
          setActiveConceptId(conceptParam)
          // Don't filter to a single week — the deep-linked concept might be
          // mid-list and we want the surrounding context visible in the sidebar.
          setSelectedWeek(null)
        }
      }
    }
    // Clear the params so refreshing or pressing back doesn't re-jump.
    const next = new URLSearchParams(searchParams)
    next.delete('module')
    next.delete('concept')
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrolledExams.length, concepts.length])

  const selectedExam = enrolledExams.find((e) => e.id === selectedExamId) ?? null

  // Group concepts in the selected module by week, ordered.
  const moduleConcepts = useMemo(() => {
    if (!selectedExam) return []
    return concepts
      .filter((c) => c.module_ids.includes(selectedExam.id))
      .sort((a, b) => {
        const wa = a.week ?? 9999
        const wb = b.week ?? 9999
        if (wa !== wb) return wa - wb
        return a.name.localeCompare(b.name)
      })
  }, [concepts, selectedExam])

  const weekConcepts = useMemo(() => {
    if (selectedWeek === null) return moduleConcepts
    return moduleConcepts.filter((c) => c.week === selectedWeek)
  }, [moduleConcepts, selectedWeek])

  const weeksAvailable = useMemo(() => {
    const map = new Map<number, { count: number; lecture: string | null }>()
    for (const c of moduleConcepts) {
      if (c.week === null || c.week === undefined) continue
      const entry = map.get(c.week) ?? { count: 0, lecture: null }
      entry.count++
      if (!entry.lecture && c.lecture) entry.lecture = c.lecture
      map.set(c.week, entry)
    }
    return [...map.entries()]
      .map(([week, e]) => ({ week, ...e }))
      .sort((a, b) => a.week - b.week)
  }, [moduleConcepts])

  // ─── Module picker view ────────────────────────────────────────────────
  if (view === 'pick') {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Study</h1>
          <p className="text-sm text-muted-foreground">
            Pick a module to walk through concept by concept. Each lesson is
            grounded in the actual lectures and slides; quiz yourself when
            you're ready.
          </p>
        </div>

        {enrolledExams.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              You're not enrolled in any modules. Pick some on the Modules
              page to get started.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {enrolledExams.map((exam) => (
              <ModuleStudyRow
                key={exam.id}
                exam={exam}
                concepts={concepts.filter((c) => c.module_ids.includes(exam.id))}
                knowledge={knowledge}
                onPick={() => {
                  setSelectedExamId(exam.id)
                  setSelectedWeek(null)
                  setActiveConceptId(null)
                  setView('lesson')
                }}
              />
            ))}
          </div>
        )}

        {/* Find a moment — pure search shortcut. Folded into the study page
            since search is a secondary use case (looking up a specific
            phrase) rather than a primary revision activity. */}
        <Card className="border-dashed">
          <CardContent className="py-3 flex items-center gap-3">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">Find a moment</div>
              <div className="text-xs text-muted-foreground">
                Looking for a specific phrase from a lecture? Search the
                transcripts and slides directly.
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/find')}
              className="shrink-0"
            >
              Open
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ─── Lesson view ───────────────────────────────────────────────────────
  // selectedExam is guaranteed at this point (set when we transitioned to lesson view).
  if (!selectedExam) {
    setView('pick')
    return null
  }

  return (
    <div className="space-y-4">
      {/* Header with back button + breadcrumb */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setView('pick')
            setActiveConceptId(null)
            setSelectedWeek(null)
          }}
          className="h-7 px-2 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Modules
        </Button>
        <span className="text-xs text-muted-foreground">·</span>
        <span className="text-xs font-medium">{getModuleShortName(selectedExam)}</span>
      </div>

      {/* Week selector */}
      {weeksAvailable.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => {
              setSelectedWeek(null)
              setActiveConceptId(null)
            }}
            className={chipClass(selectedWeek === null)}
          >
            All weeks
          </button>
          {weeksAvailable.map(({ week, count }) => (
            <button
              key={week}
              type="button"
              onClick={() => {
                setSelectedWeek(week)
                setActiveConceptId(null)
              }}
              className={chipClass(selectedWeek === week)}
            >
              W{week} <span className="opacity-60">· {count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Concept list (left) + lesson body (right). On mobile this stacks. */}
      <div className="grid gap-6 md:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            {selectedWeek !== null ? `Week ${selectedWeek}` : 'All concepts'} ·{' '}
            {weekConcepts.length}
          </div>
          {weekConcepts.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No concepts for this selection.
            </p>
          ) : (
            <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
              {weekConcepts.map((c) => {
                const k = knowledge[c.id]
                const score = k ? getEffectiveScore(k.score, k.last_tested) : 0
                // Tick lights up if either signal trips: long-term effective
                // score above mastery, OR every question's most recent attempt
                // was correct (the "you just nailed all of them" check).
                const mastered = score >= 0.8 || isConceptPerfect(c.id)
                const active = c.id === activeConceptId
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setActiveConceptId(c.id)}
                    className={
                      'w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors flex items-center gap-2 ' +
                      (active
                        ? 'bg-primary/15 text-foreground'
                        : 'text-foreground/80 hover:bg-accent')
                    }
                  >
                    {mastered ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                    ) : (
                      <BookOpen className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                    <span className="flex-1 leading-snug">{c.name}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <LessonPanel
          conceptId={activeConceptId}
          concept={weekConcepts.find((c) => c.id === activeConceptId) ?? null}
        />
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Module row on the picker
// ----------------------------------------------------------------------------
function ModuleStudyRow({
  exam,
  concepts,
  knowledge,
  onPick,
}: {
  exam: Exam
  concepts: Concept[]
  knowledge: Record<string, { score: number; last_tested: string | null }>
  onPick: () => void
}) {
  const colour = MODULE_COLOURS[exam.name] || '#888'
  const total = concepts.length
  let mastered = 0
  for (const c of concepts) {
    const k = knowledge[c.id]
    if (k && getEffectiveScore(k.score, k.last_tested) >= 0.8) mastered++
  }
  const pct = total > 0 ? Math.round((mastered / total) * 100) : 0

  return (
    <button
      type="button"
      onClick={onPick}
      className="w-full text-left rounded-md px-3 py-3 hover:bg-accent/40 transition-colors flex items-center gap-3 group"
    >
      <div
        className="w-2.5 h-2.5 rounded-sm shrink-0"
        style={{ backgroundColor: colour }}
      />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{exam.name}</div>
        <div className="text-[11px] text-muted-foreground">
          {total} concepts · {pct}% mastered
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
    </button>
  )
}

// ----------------------------------------------------------------------------
// Lesson panel — shows the AI walkthrough for the selected concept
// ----------------------------------------------------------------------------
type LessonState =
  | { phase: 'idle' }
  | { phase: 'loading'; conceptId: string }
  | { phase: 'streaming'; conceptId: string; text: string; cached: boolean; chunks: SourceChunk[] }
  | { phase: 'done'; conceptId: string; text: string; cached: boolean; chunks: SourceChunk[] }
  | { phase: 'error'; conceptId: string; message: string }
  | { phase: 'missing_key'; conceptId: string }

function LessonPanel({
  conceptId,
  concept,
}: {
  conceptId: string | null
  concept: Concept | null
}) {
  const [state, setState] = useState<LessonState>({ phase: 'idle' })
  const [quizOpen, setQuizOpen] = useState(false)
  const { openSetup } = useSetup()

  // Close the inline quiz whenever the active concept changes — otherwise
  // the previous concept's quiz would briefly flash on the new one.
  useEffect(() => {
    setQuizOpen(false)
  }, [conceptId])

  // Per-stream token. Cleanup nullifies it, so any in-flight stream from a
  // previous mount (or StrictMode double-invoke in dev) stops applying its
  // tokens to React state. Stable ids mean stream A and stream B can coexist
  // briefly without colliding.
  const streamTokenRef = useRef(0)
  // Guard against stale streams when the user clicks a different concept
  // mid-fetch — only the most recent conceptId's tokens should land.
  const activeConceptRef = useRef<string | null>(null)

  // Whenever the conceptId changes, kick off a fresh fetch.
  // IMPORTANT: only depend on conceptId, NOT the `concept` object — that
  // gets re-created on every parent render via .find() in the parent, so
  // depending on it would re-fire this effect on unrelated re-renders.
  // Each invocation gets a unique stream token (incrementing ref) so a
  // previous stream's tokens are dropped if a new mount has fired in
  // between — including the StrictMode double-invoke in dev.
  useEffect(() => {
    if (!conceptId) {
      setState({ phase: 'idle' })
      streamTokenRef.current++
      return
    }

    const myToken = ++streamTokenRef.current
    // eslint-disable-next-line no-console
    console.log(`[lesson] start  token=${myToken} concept=${conceptId.slice(0, 8)}`)
    setState({ phase: 'loading', conceptId })

    let text = ''
    let cached = false
    let chunks: SourceChunk[] = []
    let cancelled = false
    const isStale = () => cancelled || streamTokenRef.current !== myToken

    void streamLesson(conceptId, {
      onChunks: (incoming) => {
        if (isStale()) return
        chunks = incoming
      },
      onCached: () => {
        cached = true
      },
      onDelta: (chunk) => {
        if (isStale()) return
        text += chunk
        setState({ phase: 'streaming', conceptId, text, cached, chunks })
      },
      onDone: () => {
        if (isStale()) return
        // eslint-disable-next-line no-console
        console.log(`[lesson] done   token=${myToken} concept=${conceptId.slice(0, 8)} chars=${text.length}`)
        setState({ phase: 'done', conceptId, text, cached, chunks })
      },
      onError: (message) => {
        if (isStale()) return
        // eslint-disable-next-line no-console
        console.log(`[lesson] error  token=${myToken} concept=${conceptId.slice(0, 8)} msg=${message}`)
        setState({ phase: 'error', conceptId, message })
      },
      onMissingKey: () => {
        if (isStale()) return
        setState({ phase: 'missing_key', conceptId })
      },
    })

    return () => {
      cancelled = true
      // eslint-disable-next-line no-console
      console.log(`[lesson] cancel token=${myToken} concept=${conceptId.slice(0, 8)}`)
    }
  }, [conceptId])

  if (!conceptId || !concept) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Pick a concept on the left to start.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="py-4 space-y-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {concept.week !== null && concept.week !== undefined && (
              <Badge variant="outline" className="text-[10px]">Week {concept.week}</Badge>
            )}
            {concept.lecture && (
              <Badge variant="outline" className="text-[10px]">{concept.lecture}</Badge>
            )}
          </div>
          <h2 className="text-xl font-semibold leading-tight">{concept.name}</h2>
          <p className="text-sm text-muted-foreground mt-1.5">{concept.description}</p>
        </div>

        {/* Walkthrough */}
        <div className="border-t border-border pt-4">
          <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" />
            <span className="font-medium">Walkthrough</span>
            {state.phase === 'loading' && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
            {state.phase === 'streaming' && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
            {(state.phase === 'streaming' || state.phase === 'done') && state.cached && (
              <span className="text-[10px] text-muted-foreground/70">(cached)</span>
            )}
          </div>
          {state.phase === 'loading' && (
            <p className="text-xs text-muted-foreground italic">Generating walkthrough…</p>
          )}
          {(state.phase === 'streaming' || state.phase === 'done') && state.text && (
            <>
              <div className="prose prose-sm dark:prose-invert max-w-none cramkit-chat-prose">
                <Markdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                  components={{ a: CitationOrLink }}
                >
                  {state.chunks.length > 0
                    ? renderWithCitations(state.text, state.chunks)
                    : state.text}
                </Markdown>
              </div>
              {state.phase === 'done' && state.chunks.length > 0 && (
                <CitedSourcesStrip text={state.text} chunks={state.chunks} />
              )}
            </>
          )}
          {state.phase === 'missing_key' && (
            <div className="rounded-md bg-muted/50 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Lock className="h-4 w-4" />
                AI walkthrough needs an Anthropic key
              </div>
              <p className="text-xs text-muted-foreground">
                Add your own Anthropic key in Settings, or upgrade to Pro to
                let cramkit handle the AI for you. Either way unlocks the
                walkthrough.
              </p>
              <Button
                size="sm"
                onClick={() => openSetup('required')}
                className="h-7 text-xs"
              >
                Open Settings
              </Button>
            </div>
          )}
          {state.phase === 'error' && (
            <p className="text-xs text-destructive">{state.message}</p>
          )}
        </div>

        {/* Follow-up chat — only once the walkthrough has fully landed, so the
            model has the same text the student is reading. Resets per concept
            via the conceptId key prop. */}
        {state.phase === 'done' && state.text && (
          <LessonChat
            key={conceptId}
            conceptId={conceptId}
            walkthrough={state.text}
            chunks={state.chunks}
          />
        )}

        {/* Quiz me — inline mini-quiz on this concept's questions only */}
        <div className="border-t border-border pt-4 space-y-3">
          {!quizOpen ? (
            <Button
              onClick={() => setQuizOpen(true)}
              className="w-full"
              disabled={state.phase === 'loading'}
            >
              Quiz me on this concept
            </Button>
          ) : (
            <ConceptQuiz conceptId={conceptId} onClose={() => setQuizOpen(false)} />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ----------------------------------------------------------------------------
// Lesson chat — inline follow-up Q&A under the walkthrough. The walkthrough
// is the shared reference frame: the student can ask "what did you mean by
// that bit?" and the model sees the same text they're reading.
//
// History is local-only and ephemeral: navigating to a different concept
// resets it (parent uses `key={conceptId}` to remount the subtree). Last 6
// turn pairs are sent on each request to keep payloads tight.
// ----------------------------------------------------------------------------
type ChatPhase = 'idle' | 'streaming' | 'error' | 'missing_key'
const MAX_HISTORY_PAIRS_SENT = 6

function LessonChat({
  conceptId,
  walkthrough,
  chunks,
}: {
  conceptId: string
  walkthrough: string
  chunks: SourceChunk[]
}) {
  const [turns, setTurns] = useState<LessonChatTurn[]>([])
  const [input, setInput] = useState('')
  const [phase, setPhase] = useState<ChatPhase>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const { openSetup } = useSetup()

  // Track the in-flight stream so a stale response can't pump tokens into a
  // new turn after the user has already sent the next message.
  const streamTokenRef = useRef(0)

  const submit = async () => {
    const question = input.trim()
    if (!question || phase === 'streaming') return

    // Trim history to the last N pairs before sending. Keep the FULL history
    // in local state for display — only the wire payload is trimmed.
    const trimmed = turns.slice(-MAX_HISTORY_PAIRS_SENT * 2)

    // Optimistically append the user turn + an empty assistant turn that
    // will be filled in as deltas land.
    setTurns((t) => [
      ...t,
      { role: 'user', content: question },
      { role: 'assistant', content: '' },
    ])
    setInput('')
    setPhase('streaming')
    setErrorMsg(null)

    const myToken = ++streamTokenRef.current

    await streamLessonChat(
      { conceptId, walkthrough, history: trimmed, question },
      {
        onDelta: (chunk) => {
          if (streamTokenRef.current !== myToken) return
          setTurns((t) => {
            // Append to the last assistant turn in place.
            const copy = t.slice()
            const last = copy[copy.length - 1]
            if (last && last.role === 'assistant') {
              copy[copy.length - 1] = { ...last, content: last.content + chunk }
            }
            return copy
          })
        },
        onDone: () => {
          if (streamTokenRef.current !== myToken) return
          setPhase('idle')
        },
        onError: (message) => {
          if (streamTokenRef.current !== myToken) return
          setPhase('error')
          setErrorMsg(message)
          // Drop the empty assistant turn so the failed exchange doesn't
          // leave a phantom blank reply on screen.
          setTurns((t) => {
            const copy = t.slice()
            const last = copy[copy.length - 1]
            if (last && last.role === 'assistant' && !last.content) copy.pop()
            return copy
          })
        },
        onMissingKey: () => {
          if (streamTokenRef.current !== myToken) return
          setPhase('missing_key')
          setTurns((t) => {
            const copy = t.slice()
            const last = copy[copy.length - 1]
            if (last && last.role === 'assistant' && !last.content) copy.pop()
            return copy
          })
        },
      },
    )
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="border-t border-border pt-4 space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageCircle className="h-3.5 w-3.5" />
        <span className="font-medium">Ask a follow-up</span>
        {phase === 'streaming' && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
      </div>

      {turns.length > 0 && (
        <div className="space-y-3">
          {turns.map((turn, i) => (
            <div
              key={i}
              className={
                turn.role === 'user'
                  ? 'rounded-md bg-muted/50 px-3 py-2 text-sm'
                  : 'px-1 text-sm'
              }
            >
              {turn.role === 'user' ? (
                <div className="whitespace-pre-wrap">{turn.content}</div>
              ) : turn.content ? (
                <div className="prose prose-sm dark:prose-invert max-w-none cramkit-chat-prose">
                  <Markdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={{ a: CitationOrLink }}
                  >
                    {chunks.length > 0
                      ? renderWithCitations(turn.content, chunks)
                      : turn.content}
                  </Markdown>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">Thinking…</p>
              )}
            </div>
          ))}
        </div>
      )}

      {phase === 'missing_key' && (
        <div className="rounded-md bg-muted/50 p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Lock className="h-4 w-4" />
            Follow-up chat needs an Anthropic key
          </div>
          <p className="text-xs text-muted-foreground">
            Add your own Anthropic key in Settings, or upgrade to Pro to let
            cramkit handle the AI for you.
          </p>
          <Button
            size="sm"
            onClick={() => openSetup('required')}
            className="h-7 text-xs"
          >
            Open Settings
          </Button>
        </div>
      )}

      {phase === 'error' && errorMsg && (
        <p className="text-xs text-destructive">{errorMsg}</p>
      )}

      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about something in the walkthrough…"
          rows={2}
          className="flex-1 min-w-0 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={phase === 'streaming'}
        />
        <Button
          onClick={() => void submit()}
          disabled={phase === 'streaming' || !input.trim()}
          size="sm"
          className="h-9 px-3 shrink-0"
        >
          {phase === 'streaming' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Citation rendering helpers — shared between the walkthrough Markdown and the
// chat assistant turns. renderWithCitations rewrites [[CITE:n]] tokens into
// markdown links with a numeric label and a tooltip; CitationOrLink detects
// those links by their numeric child + title attribute and styles them as a
// pill chip. Falls through to a normal underlined link otherwise.
// ----------------------------------------------------------------------------
function CitationOrLink({
  href,
  title,
  children,
}: {
  href?: string
  title?: string
  children?: React.ReactNode
}) {
  const text = String(children)
  const isCitation = !!title && /^\d+$/.test(text.trim())
  if (isCitation) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={title}
        className="no-underline inline-flex items-center justify-center min-w-[1.25rem] h-[1.25rem] px-1 mx-0.5 rounded-md bg-primary/15 text-primary text-[10px] font-semibold align-text-top hover:bg-primary/25 transition-colors"
      >
        {text}
      </a>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-dotted text-primary"
    >
      {children}
    </a>
  )
}

// Show only the chunks the walkthrough actually cited (parsed back out of the
// rendered text), not all 6 retrieved chunks — keeps the strip tight.
function CitedSourcesStrip({
  text,
  chunks,
}: {
  text: string
  chunks: SourceChunk[]
}) {
  const cited = useMemo(() => {
    const seen = new Set<number>()
    const re = /\[\[CITE:(\d+)\]\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1])
      if (n >= 1 && n <= chunks.length) seen.add(n)
    }
    return Array.from(seen)
      .sort((a, b) => a - b)
      .map((n) => ({ n, chunk: chunks[n - 1] }))
  }, [text, chunks])

  if (cited.length === 0) return null

  return (
    <details className="group mt-3">
      <summary className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground transition-colors list-none [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
        {cited.length} {cited.length === 1 ? 'source' : 'sources'} cited
      </summary>
      <div className="grid gap-1.5 grid-cols-1 sm:grid-cols-2 mt-2">
        {cited.map(({ n, chunk: c }) => {
          const SourceIcon = c.source_type === 'slides' ? FileText : Video
          const label = c.position_label
            ? `${c.source_code} ${c.source_type === 'lecture' ? '@ ' : ''}${c.position_label}`
            : c.source_code
          return (
            <a
              key={c.chunk_id}
              href={c.deep_link}
              target="_blank"
              rel="noreferrer"
              className="block rounded-md border border-border bg-background px-2.5 py-2 text-[11px] hover:bg-muted transition-colors"
            >
              <div className="flex items-center gap-1 mb-0.5">
                <span className="inline-flex items-center justify-center min-w-[1rem] h-[1rem] px-1 rounded bg-primary/15 text-primary text-[9px] font-semibold shrink-0">
                  {n}
                </span>
                <SourceIcon className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="font-medium truncate flex-1">{label}</span>
                <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
              </div>
              <p className="text-muted-foreground line-clamp-2 text-[10px]">{c.chunk_text}</p>
            </a>
          )
        })}
      </div>
    </details>
  )
}

function chipClass(active: boolean): string {
  return active
    ? 'inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[11px] font-medium border border-primary bg-primary text-primary-foreground transition-colors'
    : 'inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[11px] font-medium border border-border bg-transparent text-foreground/80 hover:bg-accent transition-colors'
}
