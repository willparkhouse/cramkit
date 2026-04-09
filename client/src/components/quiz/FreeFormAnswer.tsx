import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Lightbulb } from 'lucide-react'

interface FreeFormAnswerProps {
  onSubmit: (answer: string) => void
  onIdk: () => void
  loading: boolean
  /** Open the AI "more context" panel above the textarea */
  onRequestHint?: () => void
  hintBusy?: boolean
  hintOpen?: boolean
}

export function FreeFormAnswer({
  onSubmit,
  onIdk,
  loading,
  onRequestHint,
  hintBusy,
  hintOpen,
}: FreeFormAnswerProps) {
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
          onClick={onIdk}
          disabled={loading}
          className="shrink-0"
        >
          I don't know
        </Button>
        {onRequestHint && !hintOpen && (
          <Button
            variant="ghost"
            onClick={onRequestHint}
            disabled={loading || hintBusy}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title="Get an AI hint about what this question is asking, without giving away the answer"
          >
            <Lightbulb className="h-4 w-4 mr-1.5" />
            More context
          </Button>
        )}
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
