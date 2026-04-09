import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useQuizSession } from '@/hooks/useQuizSession'
import { useAppStore } from '@/store/useAppStore'
import { getModuleShortName } from '@/lib/constants'
import { streamChat, streamSourceChat, searchSources, fetchQuestionSourceChunks, MissingApiKeyError, type SourceChunk, type QuestionSourceChunk } from '@/lib/api'
import { startConversation, logChatMessage, bumpStudyActivity } from '@/services/activity'
import { renderWithCitations } from '@/lib/citations'
import { useSetup } from '@/lib/setupContext'
import { QuestionCard } from './QuestionCard'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Brain, GraduationCap, HelpCircle, Loader2, CheckCircle, XCircle, MinusCircle, ArrowRight, Send, Video, FileText, ExternalLink, SlidersHorizontal, ChevronDown, Sparkles, BookOpen } from 'lucide-react'
import { RightRail } from '@/components/layout/RightRail'
import { Link } from 'react-router-dom'
import { useSearchParams } from 'react-router-dom'
import type { QuizFilters, QuizMode } from '@/services/quiz'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { Question, Concept, EvaluateAnswerResponse, ChatMessage } from '@/types'

// Plugins applied to every markdown renderer in this file. GFM gives us
// tables + strikethrough + task lists, math gives us $...$ and $$...$$.
const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath]
const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex]

export function QuizPage() {
  const concepts = useAppStore((s) => s.concepts)
  const questions = useAppStore((s) => s.questions)
  const allExams = useAppStore((s) => s.exams)
  const enrolledModuleIds = useAppStore((s) => s.enrolledModuleIds)
  const exams = useMemo(
    () => allExams.filter((e) => enrolledModuleIds.includes(e.id)),
    [allExams, enrolledModuleIds]
  )
  const hydrated = useAppStore((s) => s.hydrated)

  const [searchParams] = useSearchParams()
  const rawMode = searchParams.get('mode')
  // Coerce legacy ?mode= values onto the new two-mode surface so old links
  // (and the now-removed Progress quick-action buttons) keep working.
  const initialMode: QuizMode =
    rawMode === 'chronological' || rawMode === 'weakest'
      ? rawMode
      : rawMode === 'mistakes' || rawMode === 'untested' || rawMode === 'spaced'
        ? 'weakest'
        : 'chronological'
  const initialOnlyMistakes = searchParams.get('onlyMistakes') === '1' || rawMode === 'mistakes'
  // ?module= and ?modules= are both honoured: ?module=ID for the legacy
  // single-module deep links, ?modules=ID,ID for new multi-select shares.
  const initialModuleIds: string[] = (() => {
    const multi = searchParams.get('modules')
    if (multi) return multi.split(',').filter(Boolean)
    const single = searchParams.get('module')
    return single ? [single] : []
  })()

  const [filters, setFilters] = useState<QuizFilters>({
    moduleIds: initialModuleIds,
    questionType: 'all',
    week: null,
    mode: initialMode,
    difficulty: 'all',
    onlyMistakes: initialOnlyMistakes,
  })
  const [filtersOpen, setFiltersOpen] = useState(false)

  // Get available weeks for the selected module(s). With no module filter,
  // all weeks across all enrolled modules are shown.
  const availableWeeks = useMemo(() => {
    let filtered = concepts
    if (filters.moduleIds.length > 0) {
      const selectedSet = new Set(filters.moduleIds)
      filtered = filtered.filter((c) => c.module_ids.some((id) => selectedSet.has(id)))
    }
    const weeks = new Map<number, string>()
    for (const c of filtered) {
      if (c.week !== null && c.week !== undefined) {
        weeks.set(c.week, c.lecture || `Week ${c.week}`)
      }
    }
    return Array.from(weeks.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([week, lecture]) => ({ week, lecture }))
  }, [concepts, filters.moduleIds])

  const session = useQuizSession(filters)
  const knowledge = useAppStore((s) => s.knowledge)

  // Global all-time score over the concepts that pass the active filters.
  // Counts every attempt in `knowledge.history` rather than only this session,
  // so the header reflects long-term progress, not just the current page load.
  const globalStats = useMemo(() => {
    const selectedSet = new Set(filters.moduleIds)
    const conceptsInScope = concepts.filter((c) => {
      if (selectedSet.size > 0 && !c.module_ids.some((id) => selectedSet.has(id))) return false
      if (filters.week !== null && filters.week !== undefined && c.week !== filters.week) return false
      return true
    })
    let answered = 0
    let correct = 0
    for (const c of conceptsInScope) {
      const k = knowledge[c.id]
      if (!k) continue
      for (const h of k.history) {
        answered++
        if (h.correct) correct++
      }
    }
    return { answered, correct }
  }, [concepts, knowledge, filters.moduleIds, filters.week])

  // Auto-start on first load
  const [started, setStarted] = useState(false)
  useEffect(() => {
    if (hydrated && concepts.length > 0 && questions.length > 0 && !started) {
      session.nextQuestion()
      setStarted(true)
    }
  }, [hydrated, concepts.length, questions.length, started])

  if (!hydrated) {
    return <div className="text-muted-foreground">Loading...</div>
  }

  if (concepts.length === 0) {
    const hasEnrolledModules = enrolledModuleIds.length > 0
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Quiz</h1>
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
            <Brain className="h-12 w-12 text-muted-foreground" />
            {hasEnrolledModules ? (
              <>
                <p className="text-muted-foreground max-w-md">
                  No questions are available for your enrolled modules yet.
                  cramkit's admin needs to add notes for these modules.
                </p>
                <Button asChild variant="outline">
                  <Link to="/modules">
                    <GraduationCap className="mr-2 h-4 w-4" />
                    Manage modules
                  </Link>
                </Button>
              </>
            ) : (
              <>
                <p className="text-muted-foreground max-w-md">
                  You're not enrolled in any modules yet. Pick the modules
                  you're studying to start quizzing.
                </p>
                <Button asChild>
                  <Link to="/modules">
                    <GraduationCap className="mr-2 h-4 w-4" />
                    Browse modules
                  </Link>
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  const mcqOnly = filters.questionType === 'mcq'

  const updateFilter = (next: QuizFilters) => {
    setFilters(next)
    session.nextQuestion(next)
  }

  const modes: { mode: QuizMode; label: string; description: string }[] = [
    {
      mode: 'chronological',
      label: 'Smart chronological',
      description: 'Walks lectures in order. Stays on the lecture you\'re weakest on and drifts forward as you build confidence. Best with a module selected.',
    },
    {
      mode: 'weakest',
      label: 'Weakest first',
      description: 'Skips around the bank, biased towards whichever concepts you score lowest on right now.',
    },
  ]

  const difficulties: { value: 'all' | 'easy' | 'medium' | 'hard'; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'easy', label: 'Easy' },
    { value: 'medium', label: 'Medium' },
    { value: 'hard', label: 'Hard' },
  ]

  // Build a one-line summary of the active filter state for the collapsed view.
  // 0 selected = All modules, 1 selected = its short name, N selected = "N modules".
  const activeModuleName = (() => {
    if (filters.moduleIds.length === 0) return 'All modules'
    if (filters.moduleIds.length === 1) {
      return getModuleShortName(exams.find((e) => e.id === filters.moduleIds[0])) || 'Module'
    }
    return `${filters.moduleIds.length} modules`
  })()
  const activeMode = modes.find((m) => m.mode === filters.mode)?.label || 'Weakest'
  const selectClass = "w-full border border-border rounded-md bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"

  const filterGroups = (
    <div className="space-y-4">
      <FilterField label="Modules">
        {/* Multi-select chip toggles. Tap "All" to clear selection (= all
            enrolled modules). Tap a module to add/remove it from the selection.
            Resetting the week filter when modules change so the user doesn't
            end up filtering by a week that no longer exists in the new pool. */}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => updateFilter({ ...filters, moduleIds: [], week: null })}
            className={
              filters.moduleIds.length === 0
                ? 'h-7 px-2.5 rounded-full text-[11px] font-medium border border-primary bg-primary text-primary-foreground transition-colors'
                : 'h-7 px-2.5 rounded-full text-[11px] font-medium border border-border bg-transparent text-foreground/80 hover:bg-accent transition-colors'
            }
          >
            All
          </button>
          {exams.map((exam) => {
            const selected = filters.moduleIds.includes(exam.id)
            const shortName = getModuleShortName(exam) || exam.name
            return (
              <button
                key={exam.id}
                type="button"
                onClick={() => {
                  const next = selected
                    ? filters.moduleIds.filter((id) => id !== exam.id)
                    : [...filters.moduleIds, exam.id]
                  updateFilter({ ...filters, moduleIds: next, week: null })
                }}
                className={
                  selected
                    ? 'h-7 px-2.5 rounded-full text-[11px] font-medium border border-primary bg-primary text-primary-foreground transition-colors'
                    : 'h-7 px-2.5 rounded-full text-[11px] font-medium border border-border bg-transparent text-foreground/80 hover:bg-accent transition-colors'
                }
              >
                {shortName}
              </button>
            )
          })}
        </div>
      </FilterField>

      {availableWeeks.length > 0 && (
        <FilterField label="Week">
          <select
            className={selectClass}
            value={filters.week ?? ''}
            onChange={(e) => updateFilter({ ...filters, week: e.target.value ? parseInt(e.target.value) : null })}
          >
            <option value="">All weeks</option>
            {availableWeeks.map(({ week }) => (
              <option key={week} value={week}>Week {week}</option>
            ))}
          </select>
        </FilterField>
      )}

      <FilterField label="Difficulty">
        <select
          className={selectClass}
          value={filters.difficulty}
          onChange={(e) => updateFilter({ ...filters, difficulty: e.target.value as QuizFilters['difficulty'] })}
        >
          {difficulties.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </FilterField>

      <FilterField label="Question type">
        <select
          className={selectClass}
          value={filters.questionType}
          onChange={(e) => updateFilter({ ...filters, questionType: e.target.value as QuizFilters['questionType'] })}
        >
          <option value="all">MCQ + free form</option>
          <option value="mcq">Just MCQ (no AI)</option>
        </select>
      </FilterField>

      <FilterField label="Selection mode">
        <select
          className={selectClass}
          value={filters.mode}
          onChange={(e) => updateFilter({ ...filters, mode: e.target.value as QuizMode })}
        >
          {modes.map(({ mode, label }) => (
            <option key={mode} value={mode}>{label}</option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
          {modes.find((m) => m.mode === filters.mode)?.description}
        </p>
      </FilterField>

      <label className="flex items-center gap-2 cursor-pointer text-xs">
        <input
          type="checkbox"
          checked={filters.onlyMistakes ?? false}
          onChange={(e) => updateFilter({ ...filters, onlyMistakes: e.target.checked })}
          className="h-3.5 w-3.5 accent-primary shrink-0"
        />
        <span className="text-foreground/80">Only ones I've gotten wrong</span>
      </label>
    </div>
  )

  const filterSummary = [
    activeModuleName,
    filters.week !== null ? `W${filters.week}` : null,
    activeMode,
    mcqOnly ? 'Offline' : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const accuracyPct = globalStats.answered > 0
    ? Math.round((globalStats.correct / globalStats.answered) * 100)
    : null

  return (
    <div className="space-y-4">
      {/* Filters live in the global right rail on lg+; below lg they collapse
          into a header bar above the question. */}
      <RightRail>
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-foreground/70" />
            <h2 className="text-sm font-semibold">Filters</h2>
          </div>

          <div
            className="rounded-lg bg-background/60 ring-1 ring-border/60 px-3 py-2.5"
            title="All-time accuracy across every question you've answered for the current filter scope"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              All-time accuracy
            </div>
            {globalStats.answered === 0 ? (
              <div className="text-sm text-muted-foreground mt-0.5">No questions answered yet</div>
            ) : (
              <div className="flex items-baseline gap-2 mt-0.5">
                <span className="text-lg font-semibold tabular-nums">{accuracyPct}%</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {globalStats.correct} of {globalStats.answered} correct
                </span>
              </div>
            )}
          </div>

          {filterGroups}
        </div>
      </RightRail>

      {/* Mobile/tablet collapsible filter bar */}
      <div className="lg:hidden mx-auto max-w-3xl rounded-xl bg-muted/40 ring-1 ring-border/60 shadow-sm">
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent/40 transition-colors rounded-xl"
        >
          <div className="flex items-center gap-2 min-w-0">
            <SlidersHorizontal className="h-3.5 w-3.5 text-foreground/70 shrink-0" />
            <span className="text-xs font-medium text-foreground/80 truncate">{filterSummary}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span
              className="text-xs text-muted-foreground tabular-nums"
              title="All-time accuracy for the current filter scope"
            >
              {globalStats.answered === 0
                ? 'No attempts'
                : `${accuracyPct}% · ${globalStats.correct}/${globalStats.answered}`}
            </span>
            <ChevronDown
              className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${filtersOpen ? 'rotate-180' : ''}`}
            />
          </div>
        </button>

        {filtersOpen && (
          <div className="px-4 pb-4 pt-1 border-t border-border/60">
            {filterGroups}
          </div>
        )}
      </div>

      {/* Question (interactive or read-only with feedback) */}
      {session.question && session.concept && !session.showFeedback && (
        <div className="mx-auto max-w-3xl">
          <QuestionCard
            question={session.question}
            concept={session.concept}
            onSubmitMCQ={session.submitMCQ}
            onSubmitFreeForm={session.submitFreeForm}
            onIdk={session.idk}
            onSkip={session.skip}
            loading={session.loading}
          />
        </div>
      )}

      {session.showFeedback && session.question && session.concept && (
        <ReviewAndFeedback
          question={session.question}
          concept={session.concept}
          feedback={session.feedback}
          userAnswer={session.userAnswer}
          onNext={() => session.nextQuestion()}
          ragModuleSlug={resolveRagSlug(session.concept, allExams)}
        />
      )}

      {/* No questions available */}
      {!session.question && concepts.length > 0 && (
        <div className="mx-auto max-w-3xl">
          <Card>
            <CardContent className="py-6 text-center">
              <p className="text-muted-foreground mb-4">
                No {mcqOnly ? 'MCQ ' : ''}questions available
                {filters.moduleIds.length > 0 ? ' for the selected modules' : ''}. Try changing the filters.
              </p>
              <Button onClick={() => session.nextQuestion()}>Try Again</Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Filter primitives
// ----------------------------------------------------------------------------

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

// Resolve which lecture-RAG module slug a concept belongs to (or null if none).
function resolveRagSlug(concept: Concept, exams: { id: string; slug?: string }[]): string | null {
  for (const id of concept.module_ids) {
    const exam = exams.find((e) => e.id === id)
    if (exam?.slug) return exam.slug
  }
  return null
}

// Shows the question read-only with your answer + correct answer highlighted, feedback, and a "Help me understand" panel
/**
 * Post-answer disclosure that shows the lecture/slide passage(s) the question
 * was generated from. Pure DB lookup — no LLM, no embedding — using the
 * `source_chunk_ids` array stored on the question at generation time. Falls
 * back to the concept's `source_excerpt` for legacy questions that predate
 * per-question grounding.
 */
function QuestionSourceMaterial({ question, concept }: { question: Question; concept: Concept }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [chunks, setChunks] = useState<QuestionSourceChunk[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ids = question.source_chunk_ids ?? []
  const hasChunks = ids.length > 0
  const fallbackExcerpt = concept.source_excerpt?.trim() || null

  // Nothing to show at all — don't render the disclosure.
  if (!hasChunks && !fallbackExcerpt) return null

  const onToggle = async () => {
    const next = !open
    setOpen(next)
    if (next && hasChunks && chunks === null && !loading) {
      setLoading(true)
      setError(null)
      try {
        const rows = await fetchQuestionSourceChunks(ids)
        setChunks(rows)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    }
  }

  const evidence = question.evidence_quote?.trim() || null

  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? '' : '-rotate-90'}`} />
        <BookOpen className="h-3 w-3" />
        Source from lectures
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {evidence && (
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs italic text-foreground/80 border-l-2 border-l-muted-foreground/40">
              “{evidence}”
            </div>
          )}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading source…
            </div>
          )}
          {error && (
            <div className="text-xs text-destructive">Couldn't load source: {error}</div>
          )}
          {!loading && !error && hasChunks && chunks && chunks.length === 0 && (
            <div className="text-xs text-muted-foreground">
              The grounding chunks are no longer available.
            </div>
          )}
          {!loading && chunks && chunks.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chunks.map((c) => {
                const SourceIcon = c.source_type === 'slides' ? FileText : Video
                const label = c.position_label
                  ? `${c.source_code} ${c.source_type === 'lecture' ? '@ ' : ''}${c.position_label}`
                  : c.source_code
                const Tag = c.deep_link ? 'a' : 'div'
                const tagProps = c.deep_link
                  ? { href: c.deep_link, target: '_blank', rel: 'noreferrer' }
                  : {}
                return (
                  <Tag
                    key={c.chunk_id}
                    {...tagProps}
                    className={`inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] ${c.deep_link ? 'hover:bg-muted text-foreground/90' : 'text-muted-foreground'}`}
                  >
                    <SourceIcon className="h-3 w-3" />
                    <span>{label}</span>
                    {c.deep_link && <ExternalLink className="h-3 w-3 opacity-60" />}
                  </Tag>
                )
              })}
            </div>
          )}
          {!hasChunks && fallbackExcerpt && (
            <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed">
              {fallbackExcerpt}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ReviewAndFeedback({
  question,
  concept,
  feedback,
  userAnswer,
  onNext,
  ragModuleSlug,
}: {
  question: Question
  concept: Concept
  feedback: EvaluateAnswerResponse | null
  userAnswer: string | null
  onNext: () => void
  ragModuleSlug: string | null
}) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatStreaming, setChatStreaming] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [showChat, setShowChat] = useState(false)
  const [chunks, setChunks] = useState<SourceChunk[]>([])
  const [retrieving, setRetrieving] = useState(false)
  // Persisted chat conversation id, set when the help panel is opened.
  // Each turn is logged against this id for internal product analytics.
  const conversationIdRef = useRef<string | null>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  // Tracks whether the user is "pinned" to the bottom of the chat — i.e.
  // hasn't manually scrolled up. We only auto-scroll when pinned, so a
  // streaming response doesn't yank the viewport away from the user.
  const stickyRef = useRef(true)
  const { openSetup } = useSetup()

  // Sources Claude has actually cited so far across the conversation,
  // parsed from [[CITE:N]] tokens. We only show these in the panel —
  // the rest of the retrieved pool is an implementation detail.
  const citedChunks = useMemo(() => {
    if (chunks.length === 0) return []
    const cited = new Set<number>()
    for (const msg of chatMessages) {
      if (msg.role !== 'assistant') continue
      for (const match of msg.content.matchAll(/\[\[CITE:(\d+)\]\]/g)) {
        const idx = parseInt(match[1]) - 1
        if (idx >= 0 && idx < chunks.length) cited.add(idx)
      }
    }
    return Array.from(cited).sort((a, b) => a - b).map((i) => ({ chunk: chunks[i], originalIndex: i + 1 }))
  }, [chunks, chatMessages])

  // Plain-text concept context — used as a fallback when no lecture transcripts
  // are available for this concept's module.
  const conceptContext = `Concept: ${concept.name}\nDescription: ${concept.description}\nKey Facts: ${concept.key_facts.join('; ')}\n\nQuiz question: ${question.question}\n${question.type === 'mcq' && question.options ? `Options: ${question.options.join(', ')}\n` : ''}Correct answer: ${question.correct_answer}\nStudent's answer: ${userAnswer || '(skipped)'}`

  // Framing prepended to user turns when we have lecture chunks — gives Claude
  // the failure context up-front so it doesn't have to ask.
  const failureFraming = `The student is revising "${concept.name}". They were asked: "${question.question}"${question.type === 'mcq' && question.options ? `\nOptions: ${question.options.join(' | ')}` : ''}\nCorrect answer: ${question.correct_answer}\nTheir answer: ${userAnswer || '(skipped)'}`

  // Track scroll position and decide whether the user is "pinned" to the bottom.
  // If they scroll up, we stop auto-following. If they scroll back down to the
  // bottom edge, we resume following.
  const handleScroll = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickyRef.current = distanceFromBottom < 40
  }, [])

  useEffect(() => {
    if (!stickyRef.current) return
    const el = chatScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [chatMessages])

  // When the user opens a fresh chat, force-pin to bottom for the initial response.
  useEffect(() => {
    if (showChat) stickyRef.current = true
  }, [showChat])

  const sendMessage = useCallback(async (content: string, withChunks: SourceChunk[] = chunks) => {
    if (chatStreaming) return

    const userMsg: ChatMessage = { role: 'user', content }
    const newMessages = [...chatMessages, userMsg]
    setChatMessages(newMessages)
    setChatInput('')
    setChatStreaming(true)

    // Log the user turn + bump chat-message stat. Fire-and-forget.
    if (conversationIdRef.current) {
      void logChatMessage(conversationIdRef.current, 'user', content)
      void bumpStudyActivity({ chatMessagesSent: 1 })
    }

    const assistantMsg: ChatMessage = { role: 'assistant', content: '' }
    setChatMessages([...newMessages, assistantMsg])

    const onDelta = (delta: string) => {
      assistantMsg.content += delta
      setChatMessages((prev) => [...prev.slice(0, -1), { ...assistantMsg }])
    }

    let succeeded = false
    try {
      if (withChunks.length > 0) {
        await streamSourceChat(newMessages, withChunks, onDelta)
      } else {
        await streamChat(newMessages, conceptContext, onDelta)
      }
      succeeded = true
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        setChatMessages((prev) => prev.slice(0, -1))
        setShowChat(false)
        openSetup('required')
      } else {
        assistantMsg.content += '\n\n[Error: Failed to get response]'
        setChatMessages((prev) => [...prev.slice(0, -1), { ...assistantMsg }])
      }
    } finally {
      setChatStreaming(false)
    }

    // Log the assistant turn after streaming completes.
    if (succeeded && conversationIdRef.current && assistantMsg.content) {
      void logChatMessage(conversationIdRef.current, 'assistant', assistantMsg.content)
    }
  }, [chatMessages, chatStreaming, chunks, conceptContext, openSetup])

  const startChat = useCallback(async () => {
    setShowChat(true)

    // If this concept's module has lecture transcripts, retrieve relevant
    // moments first so the chat is grounded and we can show timestamp links.
    let retrievedChunks: SourceChunk[] = []
    if (ragModuleSlug) {
      setRetrieving(true)
      try {
        const query = `${concept.name}. ${question.question} ${question.correct_answer}`
        retrievedChunks = await searchSources(query, ragModuleSlug)
        setChunks(retrievedChunks)
      } catch (err) {
        console.error('Source retrieval failed, falling back to concept context:', err)
      } finally {
        setRetrieving(false)
      }
    }

    // Persist a conversation row so subsequent turns log against it. We pass
    // the framing as the title so the conversations list is browsable later.
    conversationIdRef.current = await startConversation({
      contextType: 'quiz',
      conceptId: concept.id,
      questionId: question.id,
      ragGrounded: retrievedChunks.length > 0,
      title: `${concept.name} — ${question.question}`,
    })

    const initialQ = retrievedChunks.length > 0
      ? `${failureFraming}\n\nExplain why the correct answer is right and why my answer was wrong. Cite the lecture or slide sources where they support your explanation.`
      : `I just got this question wrong. Please explain why the correct answer is right and why my answer was wrong. Be concise but thorough.`
    sendMessage(initialQ, retrievedChunks)
  }, [ragModuleSlug, concept.id, concept.name, question.id, question.question, question.correct_answer, failureFraming, sendMessage])

  const isCorrect = feedback?.correct
  const isPartial = feedback?.partial_credit

  const icon = isCorrect ? (
    <CheckCircle className="h-5 w-5 text-green-500" />
  ) : isPartial ? (
    <MinusCircle className="h-5 w-5 text-yellow-500" />
  ) : (
    <XCircle className="h-5 w-5 text-destructive" />
  )

  const resultLabel = isCorrect ? 'Correct!' : isPartial ? 'Partial Credit' : 'Incorrect'

  const accentBorder = isCorrect
    ? 'border-l-green-500'
    : isPartial
      ? 'border-l-yellow-500'
      : 'border-l-destructive'

  return (
    <div className="space-y-3">
      {/* Question + answers + result + actions in one card —
          stays narrow; only the chat panel below breaks wider. */}
      <div className="mx-auto max-w-3xl">
      <Card className={`border-l-4 gap-0 py-4 transition-colors ${accentBorder}`}>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <Badge variant="secondary" className="text-[10px]">{concept.name}</Badge>
            <Badge variant="outline" className="text-[10px]">
              {question.type === 'mcq' ? 'MCQ' : 'Free form'}
            </Badge>
            {feedback && (
              <div className="flex items-center gap-1.5 ml-auto text-xs animate-fade-up">
                {icon}
                <span className="font-medium">{resultLabel}</span>
              </div>
            )}
          </div>
          <CardTitle className="text-base font-medium leading-relaxed">
            {question.question}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pb-4">
          {question.type === 'mcq' && question.options && (
            <div className="space-y-1.5">
              {question.options.map((option, i) => {
                const isCorrectOption = option.trim().toLowerCase() === question.correct_answer.trim().toLowerCase()
                const isUserPick = userAnswer != null && option.trim().toLowerCase() === userAnswer.trim().toLowerCase()
                const wrongPick = isUserPick && !isCorrectOption

                // Background colour does the delimiting; no borders.
                let className = 'rounded-md px-3 py-1.5 text-sm transition-colors duration-300 '
                if (isCorrectOption) {
                  className += 'bg-green-100 text-green-900 font-medium dark:bg-green-950/60 dark:text-green-300'
                } else if (wrongPick) {
                  className += 'bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-300'
                } else {
                  className += 'bg-muted/40 text-muted-foreground'
                }

                return (
                  <div key={i} className={className}>
                    {isCorrectOption && '✓ '}
                    {wrongPick && '✗ '}
                    {option}
                    {isUserPick && !wrongPick && ' (your answer)'}
                  </div>
                )
              })}
            </div>
          )}
          {question.type === 'free_form' && (
            <div className="space-y-1.5">
              {userAnswer && (
                <div
                  className={`rounded-md px-3 py-1.5 text-sm transition-colors duration-300 ${
                    isCorrect
                      ? 'bg-green-100 dark:bg-green-950/60'
                      : 'bg-red-100 dark:bg-red-950/60'
                  }`}
                >
                  <span className="font-medium">Your answer: </span>{userAnswer}
                </div>
              )}
              <div className="rounded-md px-3 py-1.5 text-sm bg-green-100 dark:bg-green-950/60 animate-fade-up">
                <span className="font-medium text-green-900 dark:text-green-300">Correct: </span>
                <span className="text-green-800 dark:text-green-400">{question.correct_answer}</span>
              </div>
            </div>
          )}

          {/* AI feedback — only meaningful for free-form answers where the
              model actually graded a written response. For MCQ the result
              is a pure equality check on the client and the green/red tile
              colours already say everything. Showing a fake "AI Feedback"
              box that just regurgitates the correct answer would be noise. */}
          {feedback && question.type === 'free_form' && (
            <div
              className="rounded-md bg-muted/40 p-3 space-y-1.5 animate-fade-up"
              style={{ animationDelay: '220ms' }}
            >
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Sparkles className="h-3 w-3" />
                AI feedback
              </div>
              <p className="text-sm text-foreground/90">{feedback.feedback}</p>
            </div>
          )}

          {/* Actions */}
          <div
            className="flex items-center gap-2 pt-1 animate-fade-up"
            style={{ animationDelay: '320ms' }}
          >
            {!isCorrect && !showChat && (
              <Button variant="outline" size="sm" onClick={startChat} className="shrink-0">
                {ragModuleSlug ? <Video className="mr-1.5 h-3.5 w-3.5" /> : <HelpCircle className="mr-1.5 h-3.5 w-3.5" />}
                Why?
              </Button>
            )}
            <Button onClick={onNext} size="sm" className="flex-1">
              Next question
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </div>

          <QuestionSourceMaterial question={question} concept={concept} />
        </CardContent>
      </Card>
      </div>

      {/* Help panel: course material citations + chat. Wider than the
          question card so the assistant's response has room to breathe.
          Uniform gap-3 spacing throughout. */}
      {showChat && (
        <Card className="py-0 gap-0">
          <CardContent className="p-3 flex flex-col gap-3">
            {/* Source chips — lectures + slides merged */}
            {retrieving && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching lectures and slides…
              </div>
            )}
            {citedChunks.length > 0 && (
              <details className="group">
                <summary className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground transition-colors list-none [&::-webkit-details-marker]:hidden">
                  <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
                  {citedChunks.length} {citedChunks.length === 1 ? 'source' : 'sources'} cited
                </summary>
                <div className="grid gap-1.5 grid-cols-1 sm:grid-cols-3 mt-2">
                  {citedChunks.map(({ chunk: c, originalIndex }) => {
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
                            {originalIndex}
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
            )}

            {/* Chat transcript — taller scroll area, custom thin scrollbar */}
            <div
              ref={chatScrollRef}
              onScroll={handleScroll}
              className="flex flex-col gap-3 max-h-[36rem] overflow-y-auto scrollbar-thin pr-2 -mr-2"
            >
              {/* Hide the auto-sent opener (always the first user message) — its framing is for Claude, not the user. */}
              {chatMessages.slice(chatMessages[0]?.role === 'user' ? 1 : 0).map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted'
                  }`}>
                    {msg.role === 'assistant' ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none cramkit-chat-prose">
                        <Markdown
                          remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                          rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                          components={{
                            a: ({ href, title, children }) => {
                              // Citation links carry a title attribute (set by
                              // renderWithCitations) and their child is the
                              // citation number. Render as a small pill chip.
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
                            },
                          }}
                        >
                          {chunks.length > 0 ? renderWithCitations(msg.content || '...', chunks) : (msg.content || '...')}
                        </Markdown>
                      </div>
                    ) : (
                      <p>{msg.content}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Input row — sits flush against the chat with the same gap-3 rhythm */}
            <div className="flex gap-2 items-stretch">
              <Textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask a follow-up..."
                rows={1}
                className="resize-none text-sm min-h-9 py-2"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (chatInput.trim() && !chatStreaming) sendMessage(chatInput.trim())
                  }
                }}
              />
              <Button
                size="icon"
                className="shrink-0 h-auto"
                disabled={!chatInput.trim() || chatStreaming}
                onClick={() => {
                  if (chatInput.trim()) sendMessage(chatInput.trim())
                }}
              >
                {chatStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
