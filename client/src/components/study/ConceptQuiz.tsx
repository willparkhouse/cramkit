/**
 * Inline mini-quiz embedded in the Study lesson view.
 *
 * Walks the questions for ONE concept in order. After each answer, shows
 * an inline result block (correct/incorrect + the explanation), then a
 * "Next question" button. When all questions are exhausted shows a small
 * "all done" state with the session score.
 *
 * Why not reuse the main useQuizSession hook?
 *   - Selection logic (priority weighting, anti-recency, mode picking) is
 *     irrelevant — we just walk the per-concept question list in order.
 *   - Leaderboard / activity bumps don't apply to a study-mode session.
 *   - The hook owns its own filter state which we'd have to fake.
 * The piece we DO share is updateKnowledge so the lesson view's mastery
 * checkmark lights up after the student gets a few right.
 */
import { useMemo, useState, useEffect } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/useAppStore'
import { evaluateAnswer, MissingApiKeyError } from '@/lib/api'
import { useSetup } from '@/lib/setupContext'
import { MCQOptions } from '@/components/quiz/MCQOptions'
import { FreeFormAnswer } from '@/components/quiz/FreeFormAnswer'
import {
  CheckCircle,
  XCircle,
  MinusCircle,
  ArrowRight,
  Loader2,
  Trophy,
} from 'lucide-react'
import type { Question } from '@/types'

type Result = 'correct' | 'partial' | 'incorrect'

interface AnswerOutcome {
  result: Result
  feedback: string | null
  userAnswer: string
}

export function ConceptQuiz({ conceptId, onClose }: { conceptId: string; onClose: () => void }) {
  const allQuestions = useAppStore((s) => s.questions)
  const updateKnowledge = useAppStore((s) => s.updateKnowledge)
  const markQuestionUsed = useAppStore((s) => s.markQuestionUsed)
  const { openSetup } = useSetup()

  // Pick this concept's questions, ordered by id (stable across renders).
  // We don't randomise — student doing a focused per-concept walk wants the
  // same set every time so they can spot which one tripped them up.
  const questions = useMemo(
    () => allQuestions.filter((q) => q.concept_id === conceptId).sort((a, b) => a.id.localeCompare(b.id)),
    [allQuestions, conceptId]
  )

  // Reset session state whenever the concept changes.
  const [index, setIndex] = useState(0)
  const [outcome, setOutcome] = useState<AnswerOutcome | null>(null)
  const [evaluating, setEvaluating] = useState(false)
  const [score, setScore] = useState({ correct: 0, total: 0 })

  useEffect(() => {
    setIndex(0)
    setOutcome(null)
    setEvaluating(false)
    setScore({ correct: 0, total: 0 })
  }, [conceptId])

  if (questions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4 space-y-2 text-center">
        <p className="text-sm text-muted-foreground">
          No questions yet for this concept.
        </p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    )
  }

  // Done state: shown after the last question is answered AND the user clicks
  // "next" to advance past it. We compute "done" as index >= questions.length.
  if (index >= questions.length) {
    const pct = score.total > 0 ? Math.round((score.correct / score.total) * 100) : 0
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-5 space-y-3 text-center">
        <Trophy className="h-8 w-8 mx-auto text-primary" />
        <div>
          <p className="text-sm font-medium">All caught up</p>
          <p className="text-xs text-muted-foreground mt-1">
            {score.correct}/{score.total} correct ({pct}%)
          </p>
        </div>
        <div className="flex gap-2 justify-center">
          <Button variant="outline" size="sm" onClick={onClose}>
            Back to lesson
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setIndex(0)
              setOutcome(null)
              setScore({ correct: 0, total: 0 })
            }}
          >
            Restart
          </Button>
        </div>
      </div>
    )
  }

  const question = questions[index]

  // ─── Submit handlers ────────────────────────────────────────────────────
  const recordOutcome = (q: Question, userAnswer: string, result: Result, feedback: string | null) => {
    markQuestionUsed(q.id)
    updateKnowledge(conceptId, q.id, result)
    setScore((s) => ({
      correct: s.correct + (result === 'correct' ? 1 : 0),
      total: s.total + 1,
    }))
    setOutcome({ result, feedback, userAnswer })
  }

  const handleMCQSubmit = (answer: string) => {
    const correct = answer.trim().toLowerCase() === question.correct_answer.trim().toLowerCase()
    recordOutcome(question, answer, correct ? 'correct' : 'incorrect', null)
  }

  const handleFreeFormSubmit = async (answer: string) => {
    setEvaluating(true)
    try {
      const result = await evaluateAnswer({
        question: question.question,
        correct_answer: question.correct_answer,
        student_answer: answer,
      })
      const r: Result = result.correct ? 'correct' : result.partial_credit ? 'partial' : 'incorrect'
      recordOutcome(question, answer, r, result.feedback)
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        openSetup('required')
      } else {
        recordOutcome(question, answer, 'incorrect', `Could not evaluate: ${(err as Error).message}`)
      }
    } finally {
      setEvaluating(false)
    }
  }

  const handleIdk = () => {
    recordOutcome(question, '(I don\'t know)', 'incorrect', null)
  }

  const next = () => {
    setIndex((i) => i + 1)
    setOutcome(null)
  }

  const isCorrect = outcome?.result === 'correct'
  const isPartial = outcome?.result === 'partial'

  // ─── Active question (no answer yet) ───────────────────────────────────
  if (!outcome) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            Question {index + 1} of {questions.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-5 px-2 text-[11px]"
          >
            Close quiz
          </Button>
        </div>
        <p className="text-sm font-medium leading-relaxed">{question.question}</p>
        {question.type === 'mcq' && question.options ? (
          <MCQOptions
            options={question.options}
            correctAnswer={question.correct_answer}
            onSubmit={handleMCQSubmit}
            onIdk={handleIdk}
          />
        ) : (
          <FreeFormAnswer
            onSubmit={handleFreeFormSubmit}
            onIdk={handleIdk}
            loading={evaluating}
          />
        )}
      </div>
    )
  }

  // ─── Result view (after answering, before "next") ──────────────────────
  const Icon = isCorrect ? CheckCircle : isPartial ? MinusCircle : XCircle
  const iconColour = isCorrect
    ? 'text-green-500'
    : isPartial
      ? 'text-yellow-500'
      : 'text-destructive'

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          Question {index + 1} of {questions.length}
        </span>
        <span>
          {score.correct}/{score.total} so far
        </span>
      </div>

      <p className="text-sm font-medium leading-relaxed">{question.question}</p>

      {/* Read-only review of MCQ options with the correct one highlighted */}
      {question.type === 'mcq' && question.options && (
        <div className="space-y-1.5">
          {question.options.map((option, i) => {
            const isCorrectOption =
              option.trim().toLowerCase() === question.correct_answer.trim().toLowerCase()
            const isUserPick =
              option.trim().toLowerCase() === outcome.userAnswer.trim().toLowerCase()
            const wrongPick = isUserPick && !isCorrectOption
            let cls = 'rounded-md px-3 py-1.5 text-sm border '
            if (isCorrectOption) {
              cls +=
                'border-green-300 bg-green-50 text-green-900 font-medium dark:border-green-800 dark:bg-green-950 dark:text-green-300'
            } else if (wrongPick) {
              cls +=
                'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
            } else {
              cls += 'border-border text-muted-foreground'
            }
            return (
              <div key={i} className={cls}>
                {isCorrectOption && '✓ '}
                {wrongPick && '✗ '}
                {option}
              </div>
            )
          })}
        </div>
      )}

      {/* Free-form: show student answer + correct answer side by side */}
      {question.type === 'free_form' && (
        <div className="space-y-1.5">
          <div
            className={
              'rounded-md px-3 py-1.5 text-sm border ' +
              (isCorrect
                ? 'border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950'
                : 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950')
            }
          >
            <span className="font-medium">Your answer: </span>
            {outcome.userAnswer}
          </div>
          <div className="rounded-md px-3 py-1.5 text-sm border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950">
            <span className="font-medium text-green-800 dark:text-green-300">
              Correct:{' '}
            </span>
            <span className="text-green-700 dark:text-green-400">
              {question.correct_answer}
            </span>
          </div>
        </div>
      )}

      {/* Result + feedback */}
      <div className="flex items-start gap-2 text-sm border-t border-border/60 pt-3">
        <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${iconColour}`} />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="font-medium">
            {isCorrect ? 'Correct' : isPartial ? 'Partial credit' : 'Incorrect'}
          </div>
          {outcome.feedback && (
            <p className="text-xs text-muted-foreground">{outcome.feedback}</p>
          )}
          {question.explanation && (
            <div className="prose prose-sm dark:prose-invert max-w-none cramkit-chat-prose text-xs text-muted-foreground border-t border-border/40 pt-2 mt-2">
              <span className="font-medium not-italic">Explanation: </span>
              <Markdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
              >
                {question.explanation}
              </Markdown>
            </div>
          )}
        </div>
      </div>

      <Button onClick={next} className="w-full" disabled={evaluating}>
        {evaluating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : index + 1 >= questions.length ? (
          <>Finish</>
        ) : (
          <>
            Next question
            <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
          </>
        )}
      </Button>
    </div>
  )
}
