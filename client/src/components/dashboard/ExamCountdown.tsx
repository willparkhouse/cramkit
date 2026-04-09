import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { daysUntil, formatDate } from '@/lib/utils'
import { getModuleShortName } from '@/lib/constants'
import { useModuleConfidence } from '@/store/selectors'
import type { Exam } from '@/types'

interface ExamCountdownProps {
  exam: Exam
}

export function ExamCountdown({ exam }: ExamCountdownProps) {
  const days = daysUntil(exam.date)
  const confidence = useModuleConfidence(exam.id)
  const shortName = getModuleShortName(exam)
  const confidencePercent = Math.round(confidence * 100)

  const urgencyColor =
    days <= 7
      ? 'text-destructive'
      : days <= 14
        ? 'text-orange-500'
        : 'text-muted-foreground'

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{exam.name}</CardTitle>
          <Badge variant="secondary">{shortName}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-baseline justify-between">
          <span className={`text-2xl font-bold ${urgencyColor}`}>
            {Math.ceil(days)}d
          </span>
          <span className="text-xs text-muted-foreground">
            {formatDate(exam.date)}
          </span>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Confidence</span>
            <span className="font-medium">{confidencePercent}%</span>
          </div>
          <Progress value={confidencePercent} className="h-2" />
        </div>
        <div className="text-xs text-muted-foreground">
          Weight: {Math.round(exam.weight * 100)}%
        </div>
      </CardContent>
    </Card>
  )
}
