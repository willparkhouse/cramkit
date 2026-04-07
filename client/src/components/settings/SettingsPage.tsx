import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { useSubscription } from '@/lib/subscription'
import { startCheckout, openCustomerPortal } from '@/lib/billing'
import { getApiKey, setApiKey, syncApiKeyToProfile, isValidKeyFormat } from '@/lib/apiKey'
import { CheckCircle, AlertCircle, Loader2, ExternalLink, LogOut, Eye, EyeOff, Sparkles } from 'lucide-react'

export function SettingsPage() {
  const { user, signOut } = useAuth()
  const { tier, status, currentPeriodEnd, loading: subLoading } = useSubscription()
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [billingBusy, setBillingBusy] = useState(false)
  const [billingErr, setBillingErr] = useState<string | null>(null)

  const onUpgrade = async () => {
    setBillingErr(null)
    setBillingBusy(true)
    try { await startCheckout() } catch (e) { setBillingErr((e as Error).message); setBillingBusy(false) }
  }
  const onManage = async () => {
    setBillingErr(null)
    setBillingBusy(true)
    try { await openCustomerPortal() } catch (e) { setBillingErr((e as Error).message); setBillingBusy(false) }
  }

  useEffect(() => {
    const existing = getApiKey()
    if (existing) {
      setKeyInput(existing)
    }
  }, [])

  const handleSave = async () => {
    setError(null)
    const trimmed = keyInput.trim()

    if (!trimmed) {
      setApiKey(null)
      await syncApiKeyToProfile(null)
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
      setSavedAt(Date.now())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

      {/* Account */}
      <Card className="gap-0 py-4">
        <CardHeader className="pb-3">
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

      {/* Subscription */}
      <Card className="gap-0 py-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Subscription
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {subLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : tier === 'pro' ? (
            <>
              <div className="text-sm">
                <div className="font-medium">Pro</div>
                <div className="text-muted-foreground text-xs mt-0.5">
                  Status: {status ?? 'active'}
                  {currentPeriodEnd && (
                    <> · renews {new Date(currentPeriodEnd).toLocaleDateString()}</>
                  )}
                </div>
                <div className="text-muted-foreground text-xs mt-2">
                  All AI features run through cramkit's Anthropic key — no setup needed.
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={onManage} disabled={billingBusy}>
                {billingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Manage subscription'}
              </Button>
            </>
          ) : (
            <>
              <div className="text-sm space-y-2">
                <div className="font-medium">Free</div>
                <p className="text-muted-foreground text-xs">
                  Unlock the AI features (quiz answer eval, "Why?" chat, source-grounded chat) by either pasting your own Anthropic API key below, or upgrading to Pro for £10/month — no key faff, just works.
                </p>
              </div>
              <Button size="sm" onClick={onUpgrade} disabled={billingBusy}>
                {billingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Upgrade to Pro — £10/mo'}
              </Button>
            </>
          )}
          {billingErr && <div className="text-xs text-destructive">{billingErr}</div>}
        </CardContent>
      </Card>

      {/* Anthropic API Key */}
      <Card className="gap-0 py-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Anthropic API Key</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground space-y-2">
            <p>
              cramkit uses your own Anthropic API key for the AI features
              (answering free-form quiz questions and the "Why?" chatbot).
              You only pay for what you use.
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
              <div className="relative flex-1 min-w-0">
                <input
                  id="api-key"
                  type={showKey ? 'text' : 'password'}
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value)
                    setSavedAt(null)
                    setError(null)
                  }}
                  placeholder="sk-ant-api03-..."
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full border rounded-md pl-3 pr-9 py-2 text-sm bg-background font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
                  aria-label={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button onClick={handleSave} disabled={saving} className="shrink-0">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
              </Button>
            </div>
          </div>

          {error && (
            <div className="text-sm text-destructive flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {savedAt && !error && (
            <div className="text-sm text-green-600 flex items-center gap-2">
              <CheckCircle className="h-4 w-4 shrink-0" />
              Saved
            </div>
          )}

          <div className="text-xs text-muted-foreground border-t pt-3">
            Your key is stored in your browser's local storage and synced to
            your cramkit account (visible only to you). It's sent directly to
            Anthropic from your browser — cramkit's servers never see it.
          </div>
        </CardContent>
      </Card>

      {/* Models */}
      <Card className="gap-0 py-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Models</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            cramkit uses{' '}
            <span className="font-mono text-xs text-foreground">
              claude-sonnet-4-6
            </span>{' '}
            for free-form answer evaluation and the "Why?" chatbot.
          </p>
          <p>
            A typical session of 50 questions costs roughly $0.10–0.30
            depending on how many free-form questions you answer and how
            much you chat with the explainer.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
