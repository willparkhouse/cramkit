import { useAppStore } from '@/store/useAppStore'
import { Badge } from '@/components/ui/badge'
import { MODULE_SHORT_NAMES } from '@/lib/constants'
import type { Concept } from '@/types'

interface ConceptSelectorProps {
  selected: Concept | null
  onSelect: (concept: Concept) => void
}

export function ConceptSelector({ selected, onSelect }: ConceptSelectorProps) {
  const concepts = useAppStore((s) => s.concepts)
  const exams = useAppStore((s) => s.exams)

  const examName = (id: string) => {
    const exam = exams.find((e) => e.id === id)
    return exam ? MODULE_SHORT_NAMES[exam.name] || exam.name : ''
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground font-medium">
        Select a concept to learn about:
      </p>
      <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
        {concepts.map((concept) => (
          <Badge
            key={concept.id}
            variant={selected?.id === concept.id ? 'default' : 'outline'}
            className="cursor-pointer text-xs"
            onClick={() => onSelect(concept)}
          >
            {concept.name}
            {concept.module_ids.length > 0 && (
              <span className="ml-1 opacity-60">
                ({concept.module_ids.map(examName).join(', ')})
              </span>
            )}
          </Badge>
        ))}
      </div>
    </div>
  )
}
