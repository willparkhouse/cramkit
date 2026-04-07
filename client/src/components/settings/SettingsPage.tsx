import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { getApiKey, setApiKey, syncApiKeyToProfile, isValidKeyFormat } from '@/lib/apiKey'
import { CheckCircle, AlertCircle, Loader2, ExternalLink, LogOut, Eye, EyeOff } from 'lucide-react'

export function SettingsPage() {
  const { user, signOut } = useAuth()
  const [keyInput, setKeyInput] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const existing = getApiKey()
    if (existing) {
      setKeyInput(existing)
      setHasKey(true)
    }
  }, [])

  const handleSave = async () => {
    setError(null)
    const trimmed = keyInput.trim()

    if (!trimmed) {
      setApiKey(null)
      await syncApiKeyToProfile(null)
      setHasKey(false)
      setSavedAt(Date.now())
      return
    }

    if (!isValidKeyFormat(trimmed)) {
      setError('That doesn\'t look like a valid Anthropic API key (should start with sk-ant-)')
      return
    }

    setSaving(true)
    try {
      setApiKey(trimmed)
      await syncApiKeyToProfile(trimmed)
      setHasKey(true)
      setSavedAt(Date.now())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const masked = keyInput.length > 12
    ? `${keyInput.slice(0, 8)}${'•'.repeat(keyInput.length - 12)}${keyInput.slice(-4)}`
    : keyInput

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

      {/* Account */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm">
            <span className="text-muted-foreground">Signed in as: </span>
            <span className="font-medium">{user?.email}</span>
          </div>
          <Button variant="outline" size="sm" onClick={signOut}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </CardContent>
      </Card>

      {/* Anthropic API Key */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Anthropic API Key</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground space-y-2">
            <p>
              Cramkit uses your own Anthropic API key for realtime tasks (answering quizzes, the "Why?" chatbot).
              This means you only pay for what <em>you</em> use.
            </p>
            <p>
              Get a key at{' '}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noreferrer"
                className="text-primary inline-flex items-center gap-0.5 underline"
              >
                console.anthropic.com
                <ExternalLink className="h-3 w-3" />
              </a>
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="api-key" className="text-sm font-medium block">
              API Key
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  id="api-key"
                  type={showKey ? 'text' : 'password'}
                  value={showKey ? keyInput : (hasKey && keyInput === getApiKey() ? masked : keyInput)}
                  onChange={(e) => {
                    setKeyInput(e.target.value)
                    setSavedAt(null)
                  }}
                  placeholder="sk-ant-api03-..."
                  className="w-full border rounded-md px-3 py-2 text-sm bg-background font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
              </Button>
            </div>
          </div>

          {error && (
            <div className="text-sm text-destructive flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {savedAt && !error && (
            <div className="text-sm text-green-600 flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Saved
            </div>
          )}

          <div className="text-xs text-muted-foreground border-t pt-3">
            Your key is stored in your browser's local storage and synced to your Cramkit account
            (visible only to you). It is sent directly to Anthropic from your browser — Cramkit's
            servers never see it.
          </div>
        </CardContent>
      </Card>

      {/* Pricing info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Costs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Realtime tasks use <span className="font-mono text-xs">claude-haiku-4-5</span> (eval) and{' '}
            <span className="font-mono text-xs">claude-sonnet-4-5</span> (chat). Typical session of 50 questions
            costs roughly $0.05–0.20 depending on how many free-form questions you answer.
          </p>
          <p>
            Note ingestion (extracting concepts and generating questions) is paid for by Cramkit and runs
            server-side using a shared key.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
