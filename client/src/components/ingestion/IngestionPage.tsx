import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { FileUploader, type UploadedFile } from './FileUploader'
import { ConceptReview } from './ConceptReview'
import { IngestionProgress } from './IngestionProgress'
import { useAppStore } from '@/store/useAppStore'
import { extractConcepts, generateAllQuestions, retryFailedQuestions, type ReviewConcept } from '@/services/ingestion'
import { CheckCircle, ArrowRight, RefreshCw } from 'lucide-react'

type Step = 'upload' | 'extracting' | 'review' | 'generating' | 'done'

interface IngestionPageProps {
  /** Default module id for newly-dropped files. When provided, the inline-per-file
   * module dropdown is still editable but starts pre-set. */
  defaultModuleId?: string
}

export function IngestionPage({ defaultModuleId }: IngestionPageProps = {}) {
  const concepts = useAppStore((s) => s.concepts)
  const questions = useAppStore((s) => s.questions)

  const [files, setFiles] = useState<UploadedFile[]>([])
  // Always start in upload mode. The previous "auto-done" check based on the
  // global concept count was misleading: it'd say "ingestion complete" even
  // for sessions where the user hasn't uploaded anything yet.
  const [step, setStep] = useState<Step>('upload')
  const [stage, setStage] = useState('')
  const [progress, setProgress] = useState({ current: 0, total: 0, detail: '' })
  const [reviewConcepts, setReviewConcepts] = useState<ReviewConcept[]>([])

  const callbacks = {
    onStageChange: setStage,
    onProgress: (current: number, total: number, detail?: string) =>
      setProgress({ current, total, detail: detail || '' }),
  }

  const startExtraction = useCallback(async () => {
    if (files.length === 0) return
    setStep('extracting')
    try {
      const result = await extractConcepts(files, callbacks)
      setReviewConcepts(result)
      setStep('review')
    } catch (err) {
      console.error('Extraction failed:', err)
      setStep('upload')
    }
  }, [files])

  const confirmAndGenerate = useCallback(async () => {
    setStep('generating')
    setProgress({ current: 0, total: 0, detail: '' })
    try {
      await generateAllQuestions(reviewConcepts, callbacks)
      setStep('done')
    } catch (err) {
      console.error('Question generation failed:', err)
      // Still mark done — some questions may have been saved
      setStep('done')
    }
  }, [reviewConcepts])

  const startRetry = useCallback(async () => {
    setStep('generating')
    setProgress({ current: 0, total: 0, detail: '' })
    try {
      await retryFailedQuestions(callbacks)
    } catch (err) {
      console.error('Retry failed:', err)
    }
    setStep('done')
  }, [])

  if (step === 'done') {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Notes Ingestion</h1>
        <Card>
          <CardContent className="flex items-center gap-4 py-6">
            <CheckCircle className="h-8 w-8 text-green-500" />
            <div>
              <p className="font-medium">Ingestion Complete</p>
              <p className="text-sm text-muted-foreground">
                {concepts.length} concepts and {questions.length} questions
                ready.
              </p>
            </div>
          </CardContent>
        </Card>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setStep('upload')}
          >
            Ingest More Notes
          </Button>
          <Button
            variant="outline"
            onClick={startRetry}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry Failed
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Notes Ingestion</h1>

      {step === 'upload' && (
        <>
          <FileUploader files={files} onFilesChange={setFiles} defaultModuleId={defaultModuleId} />
          {files.length > 0 && (
            <div className="flex justify-end">
              <Button onClick={startExtraction}>
                Start Ingestion
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          )}
        </>
      )}

      {step === 'extracting' && (
        <IngestionProgress
          stage={stage}
          current={progress.current}
          total={progress.total}
          details={progress.detail}
        />
      )}

      {step === 'review' && (
        <ConceptReview
          concepts={reviewConcepts}
          onConceptsChange={setReviewConcepts}
          onConfirm={confirmAndGenerate}
        />
      )}

      {step === 'generating' && (
        <IngestionProgress
          stage={stage}
          current={progress.current}
          total={progress.total}
          details={progress.detail}
        />
      )}
    </div>
  )
}
