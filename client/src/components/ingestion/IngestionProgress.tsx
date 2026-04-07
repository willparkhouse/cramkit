import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Loader2, CheckCircle } from 'lucide-react'

interface IngestionProgressProps {
  stage: string
  current: number
  total: number
  details?: string
}

export function IngestionProgress({
  stage,
  current,
  total,
  details,
}: IngestionProgressProps) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0
  const done = current === total && total > 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          {done ? (
            <CheckCircle className="h-4 w-4 text-green-500" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          )}
          <CardTitle className="text-sm font-medium">{stage}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <Progress value={percent} className="h-2" />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{details || `${current} / ${total}`}</span>
          <span>{percent}%</span>
        </div>
      </CardContent>
    </Card>
  )
}
