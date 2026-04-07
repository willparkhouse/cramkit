import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

interface MCQOptionsProps {
  options: string[]
  onSubmit: (answer: string) => void
  onSkip: () => void
}

export function MCQOptions({ options, onSubmit, onSkip }: MCQOptionsProps) {
  const [selected, setSelected] = useState<string>('')

  return (
    <div className="space-y-4">
      <RadioGroup value={selected} onValueChange={setSelected}>
        {options.map((option, i) => (
          <div key={i} className="flex items-center space-x-3">
            <RadioGroupItem value={option} id={`option-${i}`} />
            <label
              htmlFor={`option-${i}`}
              className="text-sm font-medium leading-relaxed cursor-pointer flex-1"
            >
              {option}
            </label>
          </div>
        ))}
      </RadioGroup>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={onSkip}
          className="shrink-0"
        >
          I don't know
        </Button>
        <Button
          onClick={() => {
            if (selected) onSubmit(selected)
          }}
          disabled={!selected}
          className="flex-1"
        >
          Submit Answer
        </Button>
      </div>
    </div>
  )
}
