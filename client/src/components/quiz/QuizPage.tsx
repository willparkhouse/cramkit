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
import { Brain, GraduationCap, Wifi, WifiOff, HelpCircle, Loader2, CheckCircle, XCircle, MinusCircle, ArrowRight, Send, Video, ExternalLink } from 'lucide-react'
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

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Quiz</h1>
        <div className="text-sm text-muted-foreground tabular-nums">
          {session.correctCount}/{session.questionsAnswered} correct
        </div>
      </div>

      {/* Filters — grouped into labelled rows */}
      <div className="space-y-4 rounded-xl border border-border bg-card/50 p-4">
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

        <FilterGroup label="Question type">
          <FilterPill
            active={!mcqOnly}
            onClick={() => updateFilter({ ...filters, questionType: 'all' })}
            icon={<Wifi className="h-3 w-3" />}
          >
            All types
          </FilterPill>
          <FilterPill
            active={mcqOnly}
            onClick={() => updateFilter({ ...filters, questionType: 'mcq' })}
            icon={<WifiOff className="h-3 w-3" />}
          >
            Offline only
          </FilterPill>
        </FilterGroup>
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
    <div className="flex items-start gap-3">
      <div className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pt-1.5">
        {label}
      </div>
      <div className="flex-1 flex flex-wrap gap-1.5">{children}</div>
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
          ? 'inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-xs font-medium border border-primary bg-primary text-primary-foreground transition-colors'
          : 'inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-xs font-medium border border-border bg-transparent text-foreground/80 hover:bg-accent hover:text-foreground transition-colors'
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

  return (
    <div className="space-y-4">
      {/* Question with answers highlighted */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="secondary">{concept.name}</Badge>
            <Badge variant="outline">
              {question.type === 'mcq' ? 'Multiple Choice' : 'Free Form'}
            </Badge>
          </div>
          <CardTitle className="text-base font-medium leading-relaxed">
            {question.question}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {question.type === 'mcq' && question.options && (
            <div className="space-y-2">
              {question.options.map((option, i) => {
                const isCorrectOption = option.trim().toLowerCase() === question.correct_answer.trim().toLowerCase()
                const isUserPick = userAnswer != null && option.trim().toLowerCase() === userAnswer.trim().toLowerCase()
                const wrongPick = isUserPick && !isCorrectOption

                let className = 'rounded-md px-3 py-2 text-sm border '
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
            <div className="space-y-2">
              {userAnswer && (
                <div className={`rounded-md px-3 py-2 text-sm border ${
                  isCorrect
                    ? 'border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950'
                    : 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950'
                }`}>
                  <span className="font-medium">Your answer: </span>{userAnswer}
                </div>
              )}
              <div className="rounded-md px-3 py-2 text-sm border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950">
                <span className="font-medium text-green-800 dark:text-green-300">Correct answer: </span>
                <span className="text-green-700 dark:text-green-400">{question.correct_answer}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Feedback card */}
      {feedback && (
        <Card className={
          isCorrect
            ? 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950'
            : isPartial
              ? 'border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950'
              : 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950'
        }>
          <CardContent className="py-4 space-y-3">
            <div className="flex items-center gap-2">
              {icon}
              <span className="font-medium">{resultLabel}</span>
            </div>
            <p className="text-sm">{feedback.feedback}</p>
            {question.explanation && (
              <div className="text-sm text-muted-foreground border-t pt-2 mt-2">
                <span className="font-medium">Explanation:</span> {question.explanation}
              </div>
            )}

            {/* Help me understand */}
            {!isCorrect && !showChat && (
              <Button variant="outline" size="sm" onClick={startChat}>
                {ragModuleSlug ? <Video className="mr-2 h-4 w-4" /> : <HelpCircle className="mr-2 h-4 w-4" />}
                {ragModuleSlug ? 'Help me understand (with lecture moments)' : 'Why?'}
              </Button>
            )}

            <Button onClick={onNext} className="w-full">
              Next Question
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Help panel: lecture moments + chat */}
      {showChat && (
        <Card>
          <CardContent className="py-4 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <HelpCircle className="h-4 w-4" />
              Understanding this question
            </div>

            {/* Lecture moments */}
            {retrieving && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching lecture recordings…
              </div>
            )}
            {chunks.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Video className="h-3 w-3" />
                  Lecture moments
                </div>
                <div className="space-y-1.5">
                  {chunks.slice(0, 3).map((c) => (
                    <a
                      key={c.chunk_id}
                      href={c.deep_link}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-md border border-border bg-background px-3 py-2 text-xs hover:bg-muted transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-medium">{c.lecture_code} @ {c.timestamp_label}</span>
                        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                      </div>
                      <p className="text-muted-foreground line-clamp-2">{c.chunk_text}</p>
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-3 max-h-80 overflow-y-auto">
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
