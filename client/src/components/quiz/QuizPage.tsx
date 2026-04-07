import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useQuizSession } from '@/hooks/useQuizSession'
import { useAppStore } from '@/store/useAppStore'
import { MODULE_SHORT_NAMES, MODULE_COLOURS, MODULE_RAG_SLUGS } from '@/lib/constants'
import { streamChat, streamSourceChat, searchSources, MissingApiKeyError, type SourceChunk } from '@/lib/api'
import { renderWithCitations } from '@/lib/citations'
import { useSetup } from '@/lib/setupContext'
import { QuestionCard } from './QuestionCard'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Brain, GraduationCap, Wifi, WifiOff, HelpCircle, Loader2, CheckCircle, XCircle, MinusCircle, ArrowRight, Send, Video, FileText, ExternalLink, SlidersHorizontal, ChevronDown, Sparkles } from 'lucide-react'
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
  const initialMode = (searchParams.get('mode') as QuizMode) || 'weakest'
  const initialModule = searchParams.get('module') || null

  const [filters, setFilters] = useState<QuizFilters>({
    moduleId: initialModule,
    questionType: 'all',
    week: null,
    mode: initialMode,
    difficulty: 'all',
  })
  const [filtersOpen, setFiltersOpen] = useState(false)

  // Get available weeks for the selected module (or all)
  const availableWeeks = useMemo(() => {
    let filtered = concepts
    if (filters.moduleId) {
      filtered = filtered.filter((c) => c.module_ids.includes(filters.moduleId!))
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
  }, [concepts, filters.moduleId])

  const session = useQuizSession(filters)

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
                  Cramkit's admin needs to add notes for these modules.
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
      mode: 'weakest',
      label: 'Weakest first',
      description: 'Prioritises concepts you score lowest on. The default — best for general revision.',
    },
    {
      mode: 'untested',
      label: 'Untested',
      description: "Only shows concepts you've never been quizzed on yet. Good for seeing what's left to cover.",
    },
    {
      mode: 'mistakes',
      label: 'Review mistakes',
      description: "Only shows concepts where you've gotten questions wrong or scored below 50%.",
    },
    {
      mode: 'spaced',
      label: 'Spaced repetition',
      description: 'Concepts that are due for review — your previous score has decayed over time so it\'s worth revisiting.',
    },
  ]

  const difficulties: { value: 'all' | 'easy' | 'medium' | 'hard'; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'easy', label: 'Easy' },
    { value: 'medium', label: 'Medium' },
    { value: 'hard', label: 'Hard' },
  ]

  // Build a one-line summary of the active filter state for the collapsed view
  const activeModuleName = filters.moduleId
    ? MODULE_SHORT_NAMES[exams.find((e) => e.id === filters.moduleId)?.name || ''] || 'Module'
    : 'All modules'
  const activeMode = modes.find((m) => m.mode === filters.mode)?.label || 'Weakest'
  const filterSummary = [
    activeModuleName,
    filters.week !== null ? `W${filters.week}` : null,
    activeMode,
    mcqOnly ? 'Offline' : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {/* Compact filter bar — collapsed by default. Same width as the
          question card so the eye reads them as a unit. */}
      <div className="mx-auto max-w-3xl rounded-xl bg-muted/40 ring-1 ring-border/60 shadow-sm">
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
            <span className="text-xs text-muted-foreground tabular-nums">
              {session.correctCount}/{session.questionsAnswered}
            </span>
            <ChevronDown
              className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${filtersOpen ? 'rotate-180' : ''}`}
            />
          </div>
        </button>

        {filtersOpen && (
          <div className="px-4 pb-3 pt-1 space-y-2.5 border-t border-border/60">
            <FilterGroup label="Module">
              <FilterPill
                active={filters.moduleId === null}
                onClick={() => updateFilter({ ...filters, moduleId: null, week: null })}
              >
                All
              </FilterPill>
              {exams.map((exam) => {
                const shortName = MODULE_SHORT_NAMES[exam.name] || exam.name
                const colour = MODULE_COLOURS[exam.name] || '#888'
                const active = filters.moduleId === exam.id
                return (
                  <FilterPill
                    key={exam.id}
                    active={active}
                    accentColour={active ? colour : undefined}
                    onClick={() =>
                      updateFilter({ ...filters, moduleId: active ? null : exam.id, week: null })
                    }
                  >
                    {shortName}
                  </FilterPill>
                )
              })}
            </FilterGroup>

            {availableWeeks.length > 0 && (
              <FilterGroup label="Week">
                <FilterPill
                  active={filters.week === null}
                  onClick={() => updateFilter({ ...filters, week: null })}
                >
                  All
                </FilterPill>
                {availableWeeks.map(({ week }) => {
                  const active = filters.week === week
                  return (
                    <FilterPill
                      key={week}
                      active={active}
                      onClick={() => updateFilter({ ...filters, week: active ? null : week })}
                    >
                      W{week}
                    </FilterPill>
                  )
                })}
              </FilterGroup>
            )}

            <FilterGroup label="Difficulty">
              {difficulties.map(({ value, label }) => (
                <FilterPill
                  key={value}
                  active={filters.difficulty === value}
                  onClick={() => updateFilter({ ...filters, difficulty: value })}
                >
                  {label}
                </FilterPill>
              ))}
            </FilterGroup>

            <FilterGroup label="Type">
              <FilterPill
                active={!mcqOnly}
                onClick={() => updateFilter({ ...filters, questionType: 'all' })}
                icon={<Wifi className="h-3 w-3" />}
              >
                All
              </FilterPill>
              <FilterPill
                active={mcqOnly}
                onClick={() => updateFilter({ ...filters, questionType: 'mcq' })}
                icon={<WifiOff className="h-3 w-3" />}
              >
                Offline
              </FilterPill>
            </FilterGroup>

            <div className="pt-2 mt-1 border-t border-border/60 space-y-2">
              <FilterGroup label="Mode">
                {modes.map(({ mode, label, description }) => (
                  <FilterPill
                    key={mode}
                    active={filters.mode === mode}
                    onClick={() => updateFilter({ ...filters, mode })}
                    title={description}
                  >
                    {label}
                  </FilterPill>
                ))}
              </FilterGroup>
              <p className="text-[11px] text-muted-foreground pl-[68px]">
                {modes.find((m) => m.mode === filters.mode)?.description}
              </p>
            </div>
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
                {filters.moduleId ? ' for this module' : ''}. Try changing the filters.
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

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-14 shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="flex-1 flex flex-wrap gap-1">{children}</div>
    </div>
  )
}

function FilterPill({
  active,
  onClick,
  children,
  icon,
  accentColour,
  title,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  icon?: React.ReactNode
  accentColour?: string
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={active && accentColour ? { backgroundColor: accentColour, borderColor: accentColour, color: 'white' } : undefined}
      className={
        active
          ? 'inline-flex items-center gap-1 h-7 px-3 rounded-full text-[11px] font-medium bg-primary text-primary-foreground shadow-sm transition-all'
          : 'inline-flex items-center gap-1 h-7 px-3 rounded-full text-[11px] font-medium bg-background/60 ring-1 ring-border/60 text-foreground/80 hover:bg-background hover:text-foreground hover:ring-border transition-all'
      }
    >
      {icon}
      {children}
    </button>
  )
}

// Resolve which lecture-RAG module slug a concept belongs to (or null if none).
function resolveRagSlug(concept: Concept, exams: { id: string; name: string }[]): string | null {
  for (const id of concept.module_ids) {
    const exam = exams.find((e) => e.id === id)
    if (exam && MODULE_RAG_SLUGS[exam.name]) return MODULE_RAG_SLUGS[exam.name]
  }
  return null
}

// Shows the question read-only with your answer + correct answer highlighted, feedback, and a "Help me understand" panel
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

    const assistantMsg: ChatMessage = { role: 'assistant', content: '' }
    setChatMessages([...newMessages, assistantMsg])

    const onDelta = (delta: string) => {
      assistantMsg.content += delta
      setChatMessages((prev) => [...prev.slice(0, -1), { ...assistantMsg }])
    }

    try {
      if (withChunks.length > 0) {
        await streamSourceChat(newMessages, withChunks, onDelta)
      } else {
        await streamChat(newMessages, conceptContext, onDelta)
      }
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

    const initialQ = retrievedChunks.length > 0
      ? `${failureFraming}\n\nExplain why the correct answer is right and why my answer was wrong. Cite the lecture or slide sources where they support your explanation.`
      : `I just got this question wrong. Please explain why the correct answer is right and why my answer was wrong. Be concise but thorough.`
    sendMessage(initialQ, retrievedChunks)
  }, [ragModuleSlug, concept.name, question.question, question.correct_answer, failureFraming, sendMessage])

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
