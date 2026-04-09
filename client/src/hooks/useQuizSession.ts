import { useState, useCallback, useRef } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { pickNextQuestion, type QuizFilters } from '@/services/quiz'
import { evaluateAnswer, MissingApiKeyError } from '@/lib/api'
import { bumpStudyActivity } from '@/services/activity'
import { useSetup } from '@/lib/setupContext'
import type { Concept, Question, EvaluateAnswerResponse } from '@/types'

interface QuizState {
  concept: Concept | null
  question: Question | null
  feedback: EvaluateAnswerResponse | null
  showFeedback: boolean
  loading: boolean
  questionsAnswered: number
  correctCount: number
  userAnswer: string | null
}

export function useQuizSession(filters: QuizFilters) {
  const updateKnowledge = useAppStore((s) => s.updateKnowledge)
  const markQuestionUsed = useAppStore((s) => s.markQuestionUsed)
  const { openSetup } = useSetup()

  const [state, setState] = useState<QuizState>({
    concept: null,
    question: null,
    feedback: null,
    showFeedback: false,
    loading: false,
    questionsAnswered: 0,
    correctCount: 0,
    userAnswer: null,
  })

  // Ring buffer of recently-shown concept ids (most-recent-first). Lives in
  // a ref so updates don't re-render the hook. selectNextConcept uses this
  // to down-weight repeats so the user doesn't see the same topic twice in
  // a row.
  const recentConceptIds = useRef<string[]>([])

  const pushRecent = useCallback((conceptId: string) => {
    const next = [conceptId, ...recentConceptIds.current.filter((id) => id !== conceptId)]
    recentConceptIds.current = next.slice(0, 12)
  }, [])

  const nextQuestion = useCallback((overrideFilters?: QuizFilters) => {
    const used = overrideFilters || filters
    console.log('[session] nextQuestion called, filters:', used, 'override:', !!overrideFilters)
    const result = pickNextQuestion(used, recentConceptIds.current)
    if (!result) {
      console.log('[session] no question returned, showing empty state')
      setState((s) => ({ ...s, concept: null, question: null }))
      return
    }
    console.log('[session] got question:', result.question.type, result.concept.name)
    pushRecent(result.concept.id)
    setState((s) => ({
      ...s,
      concept: result.concept,
      question: result.question,
      feedback: null,
      showFeedback: false,
      userAnswer: null,
    }))
  }, [filters, pushRecent])

  const submitMCQ = useCallback(
    (selectedAnswer: string) => {
      if (!state.question || !state.concept) return
      markQuestionUsed(state.question.id)

      const correct =
        selectedAnswer.trim().toLowerCase() ===
        state.question.correct_answer.trim().toLowerCase()

      updateKnowledge(
        state.concept.id,
        state.question.id,
        correct ? 'correct' : 'incorrect'
      )

      setState((s) => ({
        ...s,
        showFeedback: true,
        userAnswer: selectedAnswer,
        questionsAnswered: s.questionsAnswered + 1,
        correctCount: s.correctCount + (correct ? 1 : 0),
        feedback: {
          correct,
          partial_credit: false,
          feedback: correct
            ? 'Correct!'
            : `The correct answer was: ${state.question!.correct_answer}`,
        },
      }))

      // Attribute to the active quiz module filter if it's a single-module
      // selection (most common — leaderboard buckets cleanly). Otherwise
      // fall back to the concept's first module. Multi-module filter or
      // no filter both fall through to the same behaviour.
      const moduleForBump =
        filters.moduleIds.length === 1
          ? filters.moduleIds[0]
          : (state.concept.module_ids[0] ?? null)
      void bumpStudyActivity({
        questionsAnswered: 1,
        questionsCorrect: correct ? 1 : 0,
        moduleId: moduleForBump,
      })
    },
    [state.question, state.concept, updateKnowledge, markQuestionUsed, filters.moduleIds]
  )

  const submitFreeForm = useCallback(
    async (answer: string) => {
      if (!state.question || !state.concept) return
      setState((s) => ({ ...s, loading: true }))

      try {
        const result = await evaluateAnswer({
          question: state.question.question,
          correct_answer: state.question.correct_answer,
          student_answer: answer,
        })

        markQuestionUsed(state.question.id)

        const outcome = result.correct
          ? 'correct'
          : result.partial_credit
            ? 'partial'
            : 'incorrect'

        updateKnowledge(state.concept.id, state.question.id, outcome)

        setState((s) => ({
          ...s,
          loading: false,
          showFeedback: true,
          userAnswer: answer,
          questionsAnswered: s.questionsAnswered + 1,
          correctCount: s.correctCount + (result.correct ? 1 : 0),
          feedback: result,
        }))

        const moduleForBump =
          filters.moduleIds.length === 1
            ? filters.moduleIds[0]
            : (state.concept.module_ids[0] ?? null)
        void bumpStudyActivity({
          questionsAnswered: 1,
          questionsCorrect: result.correct ? 1 : 0,
          moduleId: moduleForBump,
        })
      } catch (err) {
        if (err instanceof MissingApiKeyError) {
          openSetup('required')
        } else {
          console.error('Evaluation failed:', err)
        }
        setState((s) => ({ ...s, loading: false }))
      }
    },
    [state.question, state.concept, updateKnowledge, markQuestionUsed, openSetup, filters.moduleIds]
  )

  // "I don't know" — the user has given up on this question, so we mark it
  // wrong (lowering their confidence score) and reveal the answer.
  const idk = useCallback(() => {
    if (!state.question || !state.concept) return
    markQuestionUsed(state.question.id)
    updateKnowledge(state.concept.id, state.question.id, 'incorrect')

    setState((s) => ({
      ...s,
      showFeedback: true,
      userAnswer: null,
      questionsAnswered: s.questionsAnswered + 1,
      feedback: {
        correct: false,
        partial_credit: false,
        feedback: `The correct answer was: ${state.question!.correct_answer}`,
      },
    }))
  }, [state.question, state.concept, updateKnowledge, markQuestionUsed])

  // "Skip" — this question isn't useful right now (e.g. near-duplicate of
  // one I just answered, or a topic I'm not focusing on). We don't touch
  // knowledge or mark the question used, so it can come back later. Just
  // pull the next question immediately.
  const skip = useCallback(() => {
    const result = pickNextQuestion(filters, recentConceptIds.current)
    if (result) pushRecent(result.concept.id)
    setState((s) => ({
      ...s,
      concept: result?.concept || null,
      question: result?.question || null,
      feedback: null,
      showFeedback: false,
      userAnswer: null,
    }))
  }, [filters, pushRecent])

  return {
    ...state,
    nextQuestion,
    submitMCQ,
    submitFreeForm,
    idk,
    skip,
  }
}
