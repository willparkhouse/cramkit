import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAppStore } from '@/store/useAppStore'
import { useModulePriorities } from '@/store/selectors'
import { MODULE_SHORT_NAMES, MODULE_COLOURS } from '@/lib/constants'

export function PriorityAllocation() {
  const exams = useAppStore((s) => s.exams)
  const priorities = useModulePriorities()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Recommended Time Allocation
        </CardTitle>
      </CardHeader>
      <CardContent>
        {exams.length === 0 ? (
          <p className="text-sm text-muted-foreground">No exams loaded.</p>
        ) : (
          <div className="space-y-3">
            {/* Stacked bar */}
            <div className="flex h-8 rounded-md overflow-hidden">
              {exams.map((exam) => {
                const pct = (priorities.get(exam.id) || 0) * 100
                const colour = MODULE_COLOURS[exam.name] || '#888'
                return (
                  <div
                    key={exam.id}
                    style={{
                      width: `${pct}%`,
                      backgroundColor: colour,
                    }}
                    className="flex items-center justify-center text-white text-xs font-medium transition-all"
                    title={`${exam.name}: ${Math.round(pct)}%`}
                  >
                    {pct > 10 ? `${Math.round(pct)}%` : ''}
                  </div>
                )
              })}
            </div>

            {/* Legend */}
            <div className="grid grid-cols-2 gap-2">
              {exams.map((exam) => {
                const pct = Math.round(
                  (priorities.get(exam.id) || 0) * 100
                )
                const colour = MODULE_COLOURS[exam.name] || '#888'
                const shortName =
                  MODULE_SHORT_NAMES[exam.name] || exam.name
                return (
                  <div key={exam.id} className="flex items-center gap-2 text-xs">
                    <div
                      className="h-3 w-3 rounded-sm shrink-0"
                      style={{ backgroundColor: colour }}
                    />
                    <span className="text-muted-foreground">
                      {shortName}: {pct}%
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
