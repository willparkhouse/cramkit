import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { useSubscription } from '@/lib/subscription'
import { startCheckout, openCustomerPortal } from '@/lib/billing'
import { getApiKey, setApiKey, syncApiKeyToProfile, isValidKeyFormat } from '@/lib/apiKey'
import { CheckCircle, AlertCircle, Loader2, ExternalLink, LogOut, Eye, EyeOff, Sparkles, Heart, ChevronDown, ChevronRight, Key, Trophy } from 'lucide-react'
import { fetchMyProfile, updateMyProfile } from '@/services/leaderboard'

export function SettingsPage() {
  const { user, signOut } = useAuth()
  const { tier, status, currentPeriodEnd, loading: subLoading, refresh: refreshSubscription } = useSubscription()
  // Stripe webhook landing — when the user returns from checkout we poll the
  // billing status until it flips to pro (max ~15s) so they don't see a
  // confusing "still Free" state right after paying.
  const [postCheckoutPolling, setPostCheckoutPolling] = useState(false)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('checkout') !== 'success') return
    setPostCheckoutPolling(true)
    let cancelled = false
    let attempts = 0
    const poll = async () => {
      if (cancelled) return
      attempts++
      await refreshSubscription()
      if (attempts >= 8) {
        setPostCheckoutPolling(false)
        // Strip the query so a refresh doesn't re-trigger.
        window.history.replaceState(null, '', window.location.pathname)
        return
      }
      setTimeout(poll, 2000)
    }
    poll()
    return () => { cancelled = true }
  }, [refreshSubscription])
  // Hide the polling spinner once tier flips, even if attempts haven't run out.
  useEffect(() => {
    if (postCheckoutPolling && tier === 'pro') {
      setPostCheckoutPolling(false)
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [postCheckoutPolling, tier])
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [billingBusy, setBillingBusy] = useState(false)
  const [billingErr, setBillingErr] = useState<string | null>(null)
  // Keep BYOK collapsed by default unless the user already has a key — most
  // users will go the Pro route and don't need the API key UI cluttering things.
  const [byokOpen, setByokOpen] = useState(false)
  useEffect(() => {
    if (getApiKey()) setByokOpen(true)
  }, [])

  // Leaderboard profile (display name + opt-out). Hydrate once on mount.
  const [displayName, setDisplayName] = useState('')
  const [optIn, setOptIn] = useState(true)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [profileSavedAt, setProfileSavedAt] = useState<number | null>(null)
  const [profileSaving, setProfileSaving] = useState(false)
  useEffect(() => {
    void fetchMyProfile().then((p) => {
      if (p) {
        setDisplayName(p.display_name ?? '')
        setOptIn(p.leaderboard_opt_in)
      }
      setProfileLoaded(true)
    })
  }, [])

  const handleProfileSave = async () => {
    setProfileSaving(true)
    const ok = await updateMyProfile({
      display_name: displayName.trim() || null,
      leaderboard_opt_in: optIn,
    })
    setProfileSaving(false)
    if (ok) setProfileSavedAt(Date.now())
  }

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

      {/* Account — identity + leaderboard profile + sign out, all packed
          into one compact card. */}
      <Card className="gap-0 py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Email + sign out share a row to save vertical space. */}
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm min-w-0 truncate">
              <span className="text-muted-foreground">Signed in as </span>
              <span className="font-medium">{user?.email}</span>
            </div>
            <Button variant="outline" size="sm" onClick={signOut} className="shrink-0">
              <LogOut className="h-3.5 w-3.5" />
              <span className="sr-only">Sign out</span>
            </Button>
          </div>

          {!profileLoaded ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <div className="border-t pt-3 space-y-2">
              {/* Single row: trophy + name input + opt-in checkbox + save. */}
              <div className="flex items-center gap-2 flex-wrap">
                <label htmlFor="display-name" className="text-xs text-muted-foreground inline-flex items-center gap-1.5 shrink-0">
                  <Trophy className="h-3 w-3" />
                  Leaderboard
                </label>
                <input
                  id="display-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => { setDisplayName(e.target.value); setProfileSavedAt(null) }}
                  placeholder="Anonymous"
                  maxLength={40}
                  className="w-40 border rounded-md px-2.5 py-1 text-sm bg-background"
                />
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={optIn}
                    onChange={(e) => { setOptIn(e.target.checked); setProfileSavedAt(null) }}
                    className="h-3.5 w-3.5 accent-primary shrink-0"
                  />
                  Show me
                </label>
                <Button size="sm" onClick={handleProfileSave} disabled={profileSaving} className="shrink-0 ml-auto h-7 px-2">
                  {profileSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : profileSavedAt ? <CheckCircle className="h-3.5 w-3.5" /> : 'Save'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* AI access — unifies Subscription + BYOK + Models. The previous
          three separate cards confused users into thinking they were unrelated
          settings rather than two ways into the same feature. */}
      <Card className="gap-0 py-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            AI access
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {postCheckoutPolling && tier !== 'pro' && (
            <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Confirming your subscription with Stripe…
            </div>
          )}
          {subLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : tier === 'pro' ? (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-3">
              <div>
                <div className="text-sm font-semibold flex items-center gap-2">
                  Pro
                  <span className="text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-primary/15 text-primary uppercase tracking-wider">
                    {status ?? 'active'}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  All AI features unlocked. No key, no setup.
                  {currentPeriodEnd && <> Renews {new Date(currentPeriodEnd).toLocaleDateString()}.</>}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={onManage} disabled={billingBusy}>
                {billingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Manage subscription'}
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
              <div className="text-sm font-semibold">Upgrade to Pro</div>
              <p className="text-xs text-muted-foreground">
                £10/month. Unlocks AI marking, the "Why?" chatbot, and source-grounded
                chat — all without an API key. Cancel anytime.
              </p>
              <Button size="sm" onClick={onUpgrade} disabled={billingBusy}>
                {billingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Upgrade — £10/mo'}
              </Button>
            </div>
          )}
          {billingErr && <div className="text-xs text-destructive">{billingErr}</div>}

          {/* BYOK — folded into the same card as a secondary path. Collapsed
              by default unless the user already has a saved key. */}
          <div className="border-t pt-3">
            <button
              type="button"
              onClick={() => setByokOpen((o) => !o)}
              className="w-full flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {byokOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <Key className="h-3.5 w-3.5" />
              Or bring your own Anthropic key
            </button>

            {byokOpen && (
              <div className="space-y-3 mt-3">
                <p className="text-xs text-muted-foreground">
                  Paste an Anthropic API key from{' '}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary inline-flex items-center gap-0.5 underline"
                  >
                    console.anthropic.com
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  . Stored in your browser, sent directly to Anthropic — cramkit's
                  servers never see it.
                </p>

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

                {error && (
                  <div className="text-xs text-destructive flex items-center gap-2">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {error}
                  </div>
                )}
                {savedAt && !error && (
                  <div className="text-xs text-green-600 flex items-center gap-2">
                    <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                    Saved
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Model footnote — was its own card, now just a one-liner. */}
          <p className="text-[11px] text-muted-foreground border-t pt-3">
            AI features use{' '}
            <span className="font-mono text-foreground">claude-sonnet-4-6</span>.
            A 50-question session typically costs $0.10–0.30 in API usage.
          </p>
        </CardContent>
      </Card>

      {/* Where the money goes — non-profit commitment, surfaced in settings
          so paying users can sanity-check the claim from the wizard. */}
      <Card className="gap-0 py-4 border-primary/40 bg-primary/5">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Heart className="h-4 w-4 text-primary" />
            Where your money goes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            cramkit is run as a non-profit project by a single student. After
            paying for hosting, AI provider costs, and Stripe fees,{' '}
            <strong className="text-foreground">100% of remaining revenue</strong> is
            donated to the{' '}
            <a
              href="https://founderspledge.com/funds/climate-change-fund"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              Founders Pledge Climate Fund
              <ExternalLink className="inline h-3 w-3 ml-0.5" />
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
