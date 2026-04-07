import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2 } from 'lucide-react'

interface FreeFormAnswerProps {
  onSubmit: (answer: string) => void
  onSkip: () => void
  loading: boolean
}

export function FreeFormAnswer({ onSubmit, onSkip, loading }: FreeFormAnswerProps) {
  const [answer, setAnswer] = useState('')

  return (
    <div className="space-y-4">
      <Textarea
        placeholder="Type your answer here..."
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        rows={4}
        disabled={loading}
      />
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={onSkip}
          disabled={loading}
          className="shrink-0"
        >
          I don't know
        </Button>
        <Button
          onClick={() => {
            if (answer.trim()) onSubmit(answer.trim())
          }}
          disabled={!answer.trim() || loading}
          className="flex-1"
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Evaluating...
            </>
          ) : (
            'Submit Answer'
          )}
        </Button>
      </div>
    </div>
  )
}
