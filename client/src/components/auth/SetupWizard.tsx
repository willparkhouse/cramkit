import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useSetup } from '@/lib/setupContext'
import { getApiKey, setApiKey, syncApiKeyToProfile, isValidKeyFormat } from '@/lib/apiKey'
import {
  ExternalLink,
  Loader2,
  CheckCircle,
  AlertCircle,
  Key,
  Sparkles,
  CreditCard,
  Eye,
  EyeOff,
} from 'lucide-react'

type Step = 'choose' | 'byok' | 'done'

export function SetupWizard() {
  const { isOpen, reason, closeSetup } = useSetup()
  const [step, setStep] = useState<Step>('choose')
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset state whenever the modal opens
  useEffect(() => {
    if (isOpen) {
      const existing = getApiKey()
      setStep(existing ? 'done' : 'choose')
      setKeyInput('')
      setShowKey(false)
      setError(null)
    }
  }, [isOpen])

  const handleSave = async () => {
    setError(null)
    const trimmed = keyInput.trim()
    if (!isValidKeyFormat(trimmed)) {
      setError('That doesn\'t look like a valid Anthropic API key (should start with sk-ant-)')
      return
    }

    setSaving(true)
    try {
      setApiKey(trimmed)
      await syncApiKeyToProfile(trimmed)
      setStep('done')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeSetup()}>
      <DialogContent className="max-w-lg">
        {step === 'choose' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                {reason === 'first-time' ? 'Welcome to cramkit' : 'Set up AI features'}
              </DialogTitle>
              <DialogDescription>
                {reason === 'first-time'
                  ? 'cramkit uses AI to evaluate your answers and explain mistakes. Pick how you\'d like to power those features.'
                  : 'You need an Anthropic API key to use this feature. Pick an option below.'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 pt-2">
              {/* BYOK option */}
              <button
                onClick={() => setStep('byok')}
                className="w-full text-left border rounded-lg p-4 hover:border-primary hover:bg-accent transition-colors"
              >
                <div className="flex items-start gap-3">
                  <Key className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium">Use your own Anthropic key</span>
                      <Badge variant="secondary" className="text-[10px]">Cheapest</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Bring your own API key from Anthropic. Pay only for what you use
                      (~$0.05 per quiz session). Best for technical users.
                    </p>
                  </div>
                </div>
              </button>

              {/* Stripe (disabled) */}
              <div className="w-full border rounded-lg p-4 opacity-60 cursor-not-allowed">
                <div className="flex items-start gap-3">
                  <CreditCard className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium">cramkit subscription</span>
                      <Badge variant="outline" className="text-[10px]">Coming soon</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      £10/month, no API key needed. Unlimited quiz sessions and chat,
                      billed via Stripe. Available shortly.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {reason === 'first-time' && (
              <div className="pt-2 flex justify-end">
                <Button variant="ghost" size="sm" onClick={closeSetup}>
                  Skip for now
                </Button>
              </div>
            )}
          </>
        )}

        {step === 'byok' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Key className="h-5 w-5 text-primary" />
                Add your Anthropic API key
              </DialogTitle>
              <DialogDescription>
                Your key is stored in your browser and synced to your account. It is
                sent directly to Anthropic — cramkit never sees it.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 pt-2">
              <ol className="space-y-2 text-sm">
                <li className="flex gap-2">
                  <span className="text-muted-foreground shrink-0">1.</span>
                  <span>
                    Go to{' '}
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary inline-flex items-center gap-0.5 underline"
                    >
                      console.anthropic.com
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    {' '}and create an API key
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-muted-foreground shrink-0">2.</span>
                  <span>Copy the key (it starts with <code className="text-xs bg-muted px-1 py-0.5 rounded">sk-ant-</code>)</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-muted-foreground shrink-0">3.</span>
                  <span>Paste it below and click Save</span>
                </li>
              </ol>

              <div className="space-y-1.5">
                <label htmlFor="wizard-key" className="text-sm font-medium block">
                  API Key
                </label>
                <div className="relative">
                  <input
                    id="wizard-key"
                    type={showKey ? 'text' : 'password'}
                    value={keyInput}
                    onChange={(e) => {
                      setKeyInput(e.target.value)
                      setError(null)
                    }}
                    placeholder="sk-ant-api03-..."
                    className="w-full border rounded-md px-3 py-2 text-sm bg-background font-mono pr-9"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="text-sm text-destructive flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {error}
                </div>
              )}

              <div className="flex justify-between pt-1">
                <Button variant="ghost" size="sm" onClick={() => setStep('choose')}>
                  Back
                </Button>
                <Button onClick={handleSave} disabled={saving || !keyInput.trim()}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save key'}
                </Button>
              </div>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-500" />
                You're all set
              </DialogTitle>
              <DialogDescription>
                Your API key is saved. AI features are now active.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end pt-2">
              <Button onClick={closeSetup}>Done</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
