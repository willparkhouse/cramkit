import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useQuizSession } from '@/hooks/useQuizSession'
import { useAppStore } from '@/store/useAppStore'
import { MODULE_SHORT_NAMES, MODULE_COLOURS, MODULE_RAG_SLUGS } from '@/lib/constants'
import { streamChat, streamLectureChat, searchLectures, MissingApiKeyError, type LectureChunk } from '@/lib/api'
import { renderWithCitations } from '@/lib/citations'
import { useSetup } from '@/lib/setupContext'
import { QuestionCard } from './QuestionCard'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Brain, GraduationCap, Wifi, WifiOff, HelpCircle, Loader2, CheckCircle, XCircle, MinusCircle, ArrowRight, Send, Video, ExternalLink, SlidersHorizontal, ChevronDown } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useSearchParams } from 'react-router-dom'
import type { QuizFilters, QuizMode } from '@/services/quiz'
import Markdown from 'react-markdown'
import type { Question, Concept, EvaluateAnswerResponse, ChatMessage } from '@/types'

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

  const modes: { mode: QuizMode; label: string }[] = [
    { mode: 'weakest', label: 'Weakest First' },
    { mode: 'untested', label: 'Untested' },
    { mode: 'mistakes', label: 'Review Mistakes' },
    { mode: 'spaced', label: 'Spaced Repetition' },
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
    <div className="mx-auto max-w-3xl space-y-4">
      {/* Compact filter bar — collapsed by default */}
      <div className="rounded-lg border border-border bg-card/40">
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-accent/30 transition-colors rounded-lg"
        >
          <div className="flex items-center gap-2 min-w-0">
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground truncate">{filterSummary}</span>
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
          <div className="px-4 pb-3 pt-1 space-y-2.5 border-t border-border">
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

            <FilterGroup label="Mode">
              {modes.map(({ mode, label }) => (
                <FilterPill
                  key={mode}
                  active={filters.mode === mode}
                  onClick={() => updateFilter({ ...filters, mode })}
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
          </div>
        )}
      </div>

      {/* Question (interactive or read-only with feedback) */}
      {session.question && session.concept && !session.showFeedback && (
        <QuestionCard
          question={session.question}
          concept={session.concept}
          onSubmitMCQ={session.submitMCQ}
          onSubmitFreeForm={session.submitFreeForm}
          onSkip={session.skip}
          loading={session.loading}
        />
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
        <Card>
          <CardContent className="py-6 text-center">
            <p className="text-muted-foreground mb-4">
              No {mcqOnly ? 'MCQ ' : ''}questions available
              {filters.moduleId ? ' for this module' : ''}. Try changing the filters.
            </p>
            <Button onClick={() => session.nextQuestion()}>Try Again</Button>
          </CardContent>
        </Card>
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
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  icon?: React.ReactNode
  accentColour?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={active && accentColour ? { backgroundColor: accentColour, borderColor: accentColour, color: 'white' } : undefined}
      className={
        active
          ? 'inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[11px] font-medium border border-primary bg-primary text-primary-foreground transition-colors'
          : 'inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[11px] font-medium border border-border bg-transparent text-foreground/80 hover:bg-accent hover:text-foreground transition-colors'
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
  const [chunks, setChunks] = useState<LectureChunk[]>([])
  const [retrieving, setRetrieving] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const { openSetup } = useSetup()

  // Plain-text concept context — used as a fallback when no lecture transcripts
  // are available for this concept's module.
  const conceptContext = `Concept: ${concept.name}\nDescription: ${concept.description}\nKey Facts: ${concept.key_facts.join('; ')}\n\nQuiz question: ${question.question}\n${question.type === 'mcq' && question.options ? `Options: ${question.options.join(', ')}\n` : ''}Correct answer: ${question.correct_answer}\nStudent's answer: ${userAnswer || '(skipped)'}`

  // Framing prepended to user turns when we have lecture chunks — gives Claude
  // the failure context up-front so it doesn't have to ask.
  const failureFraming = `The student is revising "${concept.name}". They were asked: "${question.question}"${question.type === 'mcq' && question.options ? `\nOptions: ${question.options.join(' | ')}` : ''}\nCorrect answer: ${question.correct_answer}\nTheir answer: ${userAnswer || '(skipped)'}`

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  const sendMessage = useCallback(async (content: string, withChunks: LectureChunk[] = chunks) => {
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
        await streamLectureChat(newMessages, withChunks, onDelta)
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
    let retrievedChunks: LectureChunk[] = []
    if (ragModuleSlug) {
      setRetrieving(true)
      try {
        const query = `${concept.name}. ${question.question} ${question.correct_answer}`
        retrievedChunks = await searchLectures(query, ragModuleSlug)
        setChunks(retrievedChunks)
      } catch (err) {
        console.error('Lecture retrieval failed, falling back to concept context:', err)
      } finally {
        setRetrieving(false)
      }
    }

    const initialQ = retrievedChunks.length > 0
      ? `${failureFraming}\n\nExplain why the correct answer is right and why my answer was wrong. Cite the lecture sources where they support your explanation.`
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
      {/* Question + answers + result + actions in one card */}
      <Card className={`border-l-4 ${accentBorder}`}>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <Badge variant="secondary" className="text-[10px]">{concept.name}</Badge>
            <Badge variant="outline" className="text-[10px]">
              {question.type === 'mcq' ? 'MCQ' : 'Free form'}
            </Badge>
            {feedback && (
              <div className="flex items-center gap-1.5 ml-auto text-xs">
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

                let className = 'rounded-md px-3 py-1.5 text-sm border '
                if (isCorrectOption) {
                  className += 'border-green-300 bg-green-50 text-green-800 font-medium dark:border-green-800 dark:bg-green-950 dark:text-green-300'
                } else if (wrongPick) {
                  className += 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
                } else {
                  className += 'border-border text-muted-foreground'
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
                <div className={`rounded-md px-3 py-1.5 text-sm border ${
                  isCorrect
                    ? 'border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950'
                    : 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950'
                }`}>
                  <span className="font-medium">Your answer: </span>{userAnswer}
                </div>
              )}
              <div className="rounded-md px-3 py-1.5 text-sm border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950">
                <span className="font-medium text-green-800 dark:text-green-300">Correct: </span>
                <span className="text-green-700 dark:text-green-400">{question.correct_answer}</span>
              </div>
            </div>
          )}

          {/* Feedback line + explanation, inline */}
          {feedback && (
            <div className="text-sm text-muted-foreground border-t pt-3">
              {feedback.feedback}
              {question.explanation && (
                <span className="block mt-1 text-xs">{question.explanation}</span>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
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

      {/* Help panel: lecture moments + chat */}
      {showChat && (
        <Card>
          <CardContent className="py-3 space-y-3">
            {/* Lecture moments */}
            {retrieving && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching lecture recordings…
              </div>
            )}
            {chunks.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Video className="h-3 w-3" />
                  Lecture moments
                </div>
                <div className="grid gap-1.5 grid-cols-1 sm:grid-cols-3">
                  {chunks.slice(0, 3).map((c) => (
                    <a
                      key={c.chunk_id}
                      href={c.deep_link}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-md border border-border bg-background px-2.5 py-2 text-[11px] hover:bg-muted transition-colors"
                    >
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <span className="font-medium truncate">{c.lecture_code} @ {c.timestamp_label}</span>
                        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                      </div>
                      <p className="text-muted-foreground line-clamp-2 text-[10px]">{c.chunk_text}</p>
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-3 max-h-[28rem] overflow-y-auto pr-1">
              {/* Hide the auto-sent opener (always the first user message) — its framing is for Claude, not the user. */}
              {chatMessages.slice(chatMessages[0]?.role === 'user' ? 1 : 0).map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted'
                  }`}>
                    {msg.role === 'assistant' ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                        <Markdown
                          components={{
                            a: ({ href, children }) => (
                              <a
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                className="underline decoration-dotted text-primary"
                              >
                                {children}
                              </a>
                            ),
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
              <div ref={chatEndRef} />
            </div>

            <div className="flex gap-2">
              <Textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask a follow-up..."
                rows={1}
                className="resize-none text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (chatInput.trim() && !chatStreaming) sendMessage(chatInput.trim())
                  }
                }}
              />
              <Button
                size="icon"
                className="shrink-0 self-end"
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
