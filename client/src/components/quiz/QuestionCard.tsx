import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MCQOptions } from './MCQOptions'
import { FreeFormAnswer } from './FreeFormAnswer'
import type { Question, Concept } from '@/types'

interface QuestionCardProps {
  question: Question
  concept: Concept
  onSubmitMCQ: (answer: string) => void
  onSubmitFreeForm: (answer: string) => void
  onSkip: () => void
  loading: boolean
}

export function QuestionCard({
  question,
  concept,
  onSubmitMCQ,
  onSubmitFreeForm,
  onSkip,
  loading,
}: QuestionCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 mb-2">
          <Badge variant="secondary">{concept.name}</Badge>
          <Badge variant="outline">
            {question.type === 'mcq' ? 'Multiple Choice' : 'Free Form'}
          </Badge>
          <Badge variant="outline">Difficulty: {question.difficulty}</Badge>
        </div>
        <CardTitle className="text-base font-medium leading-relaxed">
          {question.question}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {question.type === 'mcq' && question.options ? (
          <MCQOptions
            options={question.options}
            onSubmit={onSubmitMCQ}
            onSkip={onSkip}
          />
        ) : (
          <FreeFormAnswer onSubmit={onSubmitFreeForm} onSkip={onSkip} loading={loading} />
        )}
      </CardContent>
    </Card>
  )
}
