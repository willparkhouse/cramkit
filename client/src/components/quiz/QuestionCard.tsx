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
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <Badge variant="secondary" className="text-[10px]">{concept.name}</Badge>
          <Badge variant="outline" className="text-[10px]">
            {question.type === 'mcq' ? 'MCQ' : 'Free form'}
          </Badge>
          <Badge variant="outline" className="text-[10px]">Difficulty {question.difficulty}</Badge>
        </div>
        <CardTitle className="text-base font-medium leading-relaxed">
          {question.question}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
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
