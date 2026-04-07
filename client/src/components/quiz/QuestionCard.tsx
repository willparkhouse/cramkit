import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SkipForward } from 'lucide-react'
import { MCQOptions } from './MCQOptions'
import { FreeFormAnswer } from './FreeFormAnswer'
import type { Question, Concept } from '@/types'

interface QuestionCardProps {
  question: Question
  concept: Concept
  onSubmitMCQ: (answer: string) => void
  onSubmitFreeForm: (answer: string) => void
  onIdk: () => void
  onSkip: () => void
  loading: boolean
}

export function QuestionCard({
  question,
  concept,
  onSubmitMCQ,
  onSubmitFreeForm,
  onIdk,
  onSkip,
  loading,
}: QuestionCardProps) {
  return (
    <Card className="gap-0 py-4">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
            <Badge variant="secondary" className="text-[10px]">{concept.name}</Badge>
            <Badge variant="outline" className="text-[10px]">
              {question.type === 'mcq' ? 'MCQ' : 'Free form'}
            </Badge>
            <Badge variant="outline" className="text-[10px]">Difficulty {question.difficulty}</Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onSkip}
            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground shrink-0 -my-1"
            title="Show me a different question (doesn't affect your score)"
          >
            <SkipForward className="h-3 w-3 mr-1" />
            Skip
          </Button>
        </div>
        <CardTitle className="text-base font-medium leading-relaxed">
          {question.question}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        {question.type === 'mcq' && question.options ? (
          <MCQOptions
            options={question.options}
            correctAnswer={question.correct_answer}
            onSubmit={onSubmitMCQ}
            onIdk={onIdk}
          />
        ) : (
          <FreeFormAnswer onSubmit={onSubmitFreeForm} onIdk={onIdk} loading={loading} />
        )}
      </CardContent>
    </Card>
  )
}
