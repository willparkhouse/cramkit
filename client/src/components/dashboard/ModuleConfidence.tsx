import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useAppStore } from '@/store/useAppStore'
import { useModuleConfidence } from '@/store/selectors'
import { getModuleShortName } from '@/lib/constants'
import type { Exam } from '@/types'

function ModuleBar({ exam }: { exam: Exam }) {
  const confidence = useModuleConfidence(exam.id)
  const concepts = useAppStore((s) => s.concepts)
  const count = concepts.filter((c) => c.module_ids.includes(exam.id)).length
  const percent = Math.round(confidence * 100)
  const shortName = getModuleShortName(exam)

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{shortName}</span>
        <span className="text-muted-foreground">
          {percent}% ({count} concepts)
        </span>
      </div>
      <Progress value={percent} className="h-2" />
    </div>
  )
}

export function ModuleConfidence() {
  const allExams = useAppStore((s) => s.exams)
  const enrolledModuleIds = useAppStore((s) => s.enrolledModuleIds)
  const exams = allExams.filter((e) => enrolledModuleIds.includes(e.id))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Knowledge by Module
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {exams.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No exams loaded yet. Check your Supabase connection.
          </p>
        ) : (
          exams.map((exam) => <ModuleBar key={exam.id} exam={exam} />)
        )}
      </CardContent>
    </Card>
  )
}
