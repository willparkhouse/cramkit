import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CheckCircle, XCircle, MinusCircle, ArrowRight } from 'lucide-react'
import type { EvaluateAnswerResponse, Question } from '@/types'

interface AnswerFeedbackProps {
  feedback: EvaluateAnswerResponse
  question: Question
  onNext: () => void
}

export function AnswerFeedback({ feedback, question, onNext }: AnswerFeedbackProps) {
  const icon = feedback.correct ? (
    <CheckCircle className="h-5 w-5 text-green-500" />
  ) : feedback.partial_credit ? (
    <MinusCircle className="h-5 w-5 text-yellow-500" />
  ) : (
    <XCircle className="h-5 w-5 text-destructive" />
  )

  const label = feedback.correct
    ? 'Correct!'
    : feedback.partial_credit
      ? 'Partial Credit'
      : 'Incorrect'

  return (
    <Card className={
      feedback.correct
        ? 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950'
        : feedback.partial_credit
          ? 'border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950'
          : 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950'
    }>
      <CardContent className="py-4 space-y-3">
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-medium">{label}</span>
        </div>
        <p className="text-sm">{feedback.feedback}</p>
        {question.explanation && (
          <div className="text-sm text-muted-foreground border-t pt-2 mt-2">
            <span className="font-medium">Explanation:</span>{' '}
            {question.explanation}
          </div>
        )}
        <Button onClick={() => onNext()} className="w-full">
          Next Question
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  )
}
