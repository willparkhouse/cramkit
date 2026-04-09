import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Lightbulb } from 'lucide-react'

interface MCQOptionsProps {
  options: string[]
  correctAnswer: string
  onSubmit: (answer: string) => void
  onIdk: () => void
  /** Open the AI "more context" panel above the options */
  onRequestHint?: () => void
  /** Greys out the hint button while a hint is loading or streaming */
  hintBusy?: boolean
  /** Hides the hint button entirely once a hint is on screen */
  hintOpen?: boolean
}

/**
 * Tile-style MCQ options. Click anywhere on a tile to select it.
 *
 * The visual shape (rounded boxes, 1.5 spacing, py-1.5 px-3) intentionally
 * matches the read-only review state in QuizPage so the transition between
 * "answering" and "reviewing" feels like the same UI lighting up rather
 * than a hard re-render into a different layout.
 */
export function MCQOptions({
  options,
  correctAnswer,
  onSubmit,
  onIdk,
  onRequestHint,
  hintBusy,
  hintOpen,
}: MCQOptionsProps) {
  const [selected, setSelected] = useState<string>('')
  const [submitted, setSubmitted] = useState<string | null>(null)

  // Once submitted, briefly preview the result before letting the parent
  // swap us out for the review card. ~650ms matches the answer-flash
  // keyframe duration.
  const handleSubmit = () => {
    if (!selected || submitted) return
    setSubmitted(selected)
    setTimeout(() => onSubmit(selected), 650)
  }

  const isLocked = submitted !== null

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {options.map((option, i) => {
          const isCorrect = option.trim().toLowerCase() === correctAnswer.trim().toLowerCase()
          const isPicked = submitted === option
          const isSelected = selected === option

          // Borderless tiles — background colour does the delimiting.
          // Tile shape matches the review state exactly.
          let className = 'w-full text-left rounded-md px-3 py-1.5 text-sm transition-colors duration-200 cursor-pointer '

          if (isLocked) {
            // After submission: picked tile flashes green or red, the correct
            // tile (if the user picked wrong) also lights up green.
            if (isPicked && isCorrect) {
              className += 'animate-answer-correct bg-green-100 text-green-900 font-medium dark:bg-green-950/60 dark:text-green-300'
            } else if (isPicked && !isCorrect) {
              className += 'animate-answer-wrong bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-300'
            } else if (isCorrect) {
              className += 'bg-green-100 text-green-900 font-medium dark:bg-green-950/60 dark:text-green-300'
            } else {
              className += 'bg-muted/40 text-muted-foreground'
            }
          } else if (isSelected) {
            className += 'bg-primary/15 text-foreground'
          } else {
            className += 'bg-muted/40 text-foreground hover:bg-muted'
          }

          return (
            <button
              key={i}
              type="button"
              disabled={isLocked}
              onClick={() => setSelected(option)}
              className={className}
            >
              {option}
            </button>
          )
        })}
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={onIdk}
          disabled={isLocked}
          className="shrink-0"
        >
          I don't know
        </Button>
        {onRequestHint && !hintOpen && (
          <Button
            variant="ghost"
            onClick={onRequestHint}
            disabled={isLocked || hintBusy}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title="Get an AI hint about what this question is asking, without giving away the answer"
          >
            <Lightbulb className="h-4 w-4 mr-1.5" />
            More context
          </Button>
        )}
        <Button
          onClick={handleSubmit}
          disabled={!selected || isLocked}
          className="flex-1"
        >
          Submit Answer
        </Button>
      </div>
    </div>
  )
}
