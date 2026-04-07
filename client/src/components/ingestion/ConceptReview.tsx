import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { ChevronDown, ChevronUp, Trash2, Edit2, Check } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { MODULE_SHORT_NAMES } from '@/lib/constants'

import type { ReviewConcept } from '@/services/ingestion'

type ConceptItem = ReviewConcept

interface ConceptReviewProps {
  concepts: ConceptItem[]
  onConceptsChange: (concepts: ConceptItem[]) => void
  onConfirm: () => void
}

export function ConceptReview({
  concepts,
  onConceptsChange,
  onConfirm,
}: ConceptReviewProps) {
  const exams = useAppStore((s) => s.exams)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<number | null>(null)

  const toggle = (i: number) => {
    const next = new Set(expanded)
    next.has(i) ? next.delete(i) : next.add(i)
    setExpanded(next)
  }

  const remove = (i: number) => {
    onConceptsChange(concepts.filter((_, idx) => idx !== i))
  }

  const update = (i: number, updates: Partial<ConceptItem>) => {
    const next = [...concepts]
    next[i] = { ...next[i], ...updates }
    onConceptsChange(next)
  }

  const examName = (id: string) => {
    const exam = exams.find((e) => e.id === id)
    return exam ? MODULE_SHORT_NAMES[exam.name] || exam.name : id
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {concepts.length} concepts extracted. Review, edit, or remove before
          generating questions.
        </p>
        <Button onClick={onConfirm}>Confirm & Generate Questions</Button>
      </div>

      <div className="space-y-2">
        {concepts.map((concept, i) => (
          <Card key={i}>
            <CardHeader
              className="py-3 cursor-pointer"
              onClick={() => toggle(i)}
            >
              <div className="flex items-center gap-2">
                {expanded.has(i) ? (
                  <ChevronUp className="h-4 w-4 shrink-0" />
                ) : (
                  <ChevronDown className="h-4 w-4 shrink-0" />
                )}
                <CardTitle className="text-sm font-medium flex-1">
                  {concept.name}
                </CardTitle>
                <Badge variant="outline" className="text-xs">
                  Difficulty: {concept.difficulty}
                </Badge>
                {concept.module_ids.map((id) => (
                  <Badge key={id} variant="secondary" className="text-xs">
                    {examName(id)}
                  </Badge>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(i)
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            {expanded.has(i) && (
              <CardContent className="pt-0 space-y-3">
                {editing === i ? (
                  <div className="space-y-2">
                    <input
                      className="w-full border rounded px-2 py-1 text-sm bg-background"
                      value={concept.name}
                      onChange={(e) => update(i, { name: e.target.value })}
                    />
                    <Textarea
                      value={concept.description}
                      onChange={(e) =>
                        update(i, { description: e.target.value })
                      }
                      rows={3}
                    />
                    <Textarea
                      value={concept.key_facts.join('\n')}
                      onChange={(e) =>
                        update(i, {
                          key_facts: e.target.value.split('\n').filter(Boolean),
                        })
                      }
                      rows={5}
                      placeholder="One fact per line"
                    />
                    <Button
                      size="sm"
                      onClick={() => setEditing(null)}
                    >
                      <Check className="mr-1 h-3 w-3" /> Done
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {concept.description}
                    </p>
                    <div className="space-y-1">
                      <p className="text-xs font-medium">Key Facts:</p>
                      <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                        {concept.key_facts.map((fact, fi) => (
                          <li key={fi}>{fact}</li>
                        ))}
                      </ul>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(i)}
                    >
                      <Edit2 className="mr-1 h-3 w-3" /> Edit
                    </Button>
                  </>
                )}
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}
