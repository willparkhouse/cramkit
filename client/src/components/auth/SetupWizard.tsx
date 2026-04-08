import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useSetup } from '@/lib/setupContext'
import { startCheckout } from '@/lib/billing'
import { getApiKey, setApiKey, syncApiKeyToProfile, isValidKeyFormat } from '@/lib/apiKey'
import { fetchMyProfile, updateMyProfile } from '@/services/leaderboard'
import { useAppStore } from '@/store/useAppStore'
import { refreshEnrollments } from '@/store/hydrate'
import * as api from '@/lib/api'
import { MODULE_COLOURS, MODULE_SHORT_NAMES } from '@/lib/constants'
import { formatDate, daysUntil } from '@/lib/utils'
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
  GraduationCap,
  ArrowRight,
  Video,
  FileText,
} from 'lucide-react'

type Step = 'modules' | 'profile' | 'choose' | 'byok' | 'done'

export function SetupWizard() {
  const { isOpen, reason, closeSetup } = useSetup()
  const [step, setStep] = useState<Step>('choose')
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrolling, setEnrolling] = useState<string | null>(null)
  // Leaderboard onboarding state — display name + opt-out toggle. Defaults
  // to opt-in (matches the schema default and the chosen product behaviour).
  const [displayName, setDisplayName] = useState('')
  const [optIn, setOptIn] = useState(true)
  const [profileSaving, setProfileSaving] = useState(false)

  const exams = useAppStore((s) => s.exams)
  const enrolledModuleIds = useAppStore((s) => s.enrolledModuleIds)

  // Reset state whenever the modal opens
  useEffect(() => {
    if (isOpen) {
      const existing = getApiKey()
      // First-time users: lead with module selection. They've never seen the
      // app before — asking about Anthropic keys without context is jarring,
      // and we don't yet know what we're talking about. Returning users (e.g.
      // re-opened from a paywall) skip straight to the key choice.
      if (existing) setStep('done')
      else if (reason === 'first-time') setStep('modules')
      else setStep('choose')
      setKeyInput('')
      setShowKey(false)
      setError(null)
      // Pre-fill the leaderboard profile fields from whatever's already in
      // the DB so a re-opened wizard doesn't clobber existing settings.
      void fetchMyProfile().then((p) => {
        if (p) {
          setDisplayName(p.display_name ?? '')
          setOptIn(p.leaderboard_opt_in)
        }
      })
    }
  }, [isOpen, reason])

  const handleProfileContinue = async () => {
    setProfileSaving(true)
    try {
      await updateMyProfile({
        display_name: displayName.trim() || null,
        leaderboard_opt_in: optIn,
      })
    } finally {
      setProfileSaving(false)
      setStep('choose')
    }
  }

  const handleEnroll = async (moduleId: string) => {
    setEnrolling(moduleId)
    try {
      await api.enrollInModule(moduleId)
      await refreshEnrollments()
    } finally {
      setEnrolling(null)
    }
  }

  const handleUnenroll = async (moduleId: string) => {
    setEnrolling(moduleId)
    try {
      await api.unenrollFromModule(moduleId)
      await refreshEnrollments()
    } finally {
      setEnrolling(null)
    }
  }

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
        {step === 'modules' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <GraduationCap className="h-5 w-5 text-primary" />
                Pick your modules
              </DialogTitle>
              <DialogDescription>
                Select the modules you're studying. cramkit will show you quizzes,
                materials, and progress only for these. You can change this later
                from the Modules page.
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-80 overflow-y-auto -mx-1 px-1 py-2 space-y-1.5">
              {exams.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No modules available yet.
                </p>
              ) : (
                exams.map((exam) => {
                  const enrolled = enrolledModuleIds.includes(exam.id)
                  const colour = MODULE_COLOURS[exam.name] || '#888'
                  const shortName = MODULE_SHORT_NAMES[exam.name] || exam.name
                  const days = Math.ceil(daysUntil(exam.date))
                  return (
                    <button
                      key={exam.id}
                      onClick={() => enrolled ? handleUnenroll(exam.id) : handleEnroll(exam.id)}
                      disabled={enrolling === exam.id}
                      className={`w-full text-left flex items-center gap-3 rounded-md px-3 py-2.5 border transition-colors ${
                        enrolled
                          ? 'border-primary bg-primary/10'
                          : 'border-border hover:border-muted-foreground/50 hover:bg-accent'
                      }`}
                    >
                      <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: colour }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{exam.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {shortName} · {formatDate(exam.date)} · in {days}d
                        </p>
                      </div>
                      {enrolling === exam.id ? (
                        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                      ) : enrolled ? (
                        <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                      ) : null}
                    </button>
                  )
                })
              )}
            </div>

            <div className="pt-2 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {enrolledModuleIds.length} selected
              </p>
              <Button
                onClick={() => setStep('profile')}
                disabled={enrolledModuleIds.length === 0}
              >
                Continue <ArrowRight className="ml-1.5 h-4 w-4" />
              </Button>
            </div>
          </>
        )}

        {step === 'profile' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                Pick a display name
              </DialogTitle>
              <DialogDescription>
                Used on the leaderboard so other students studying the same modules
                can see who's grinding. Skip the name field to stay anonymous, or
                opt out entirely below.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <label htmlFor="wizard-display-name" className="text-sm font-medium block">
                  Display name <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <input
                  id="wizard-display-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Will P."
                  maxLength={40}
                  className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                />
                <p className="text-xs text-muted-foreground">
                  40 characters max. Leave blank to appear as "Anonymous".
                </p>
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={optIn}
                  onChange={(e) => setOptIn(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-primary shrink-0"
                />
                <div className="text-sm">
                  <div className="font-medium">Show me on the leaderboard</div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Uncheck to hide your stats from everyone. You can change this
                    later in Settings.
                  </p>
                </div>
              </label>
            </div>

            <div className="pt-2 flex justify-end">
              <Button onClick={handleProfileContinue} disabled={profileSaving}>
                {profileSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : (
                  <>Continue <ArrowRight className="ml-1.5 h-4 w-4" /></>
                )}
              </Button>
            </div>
          </>
        )}

        {step === 'choose' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                Unlock the AI tutor
              </DialogTitle>
              <DialogDescription>
                Quizzes work for free with multiple choice. AI unlocks an in-app
                tutor that only quotes <em>your</em> slides and lectures.
              </DialogDescription>
            </DialogHeader>

            {/* Feature teaser — one tight demo of the citation chips. The
                launch video does the heavy lifting; these chips show a real
                screenshot preview on hover so users can see what they'd be
                jumping to without leaving the wizard. */}
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 mt-1">
              <p className="text-xs leading-relaxed text-foreground/85">
                "Backprop applies the chain rule across the computation
                graph{' '}
                <CitationChip
                  icon={<Video className="h-2.5 w-2.5" />}
                  label="nc3.1 · 12:47"
                  previewSrc="/demo/nc3-1-12-47.png"
                  previewCaption="Lecture nc3.1 paused at 12:47"
                />{' '}
                <span className="whitespace-nowrap">
                  <CitationChip
                    icon={<FileText className="h-2.5 w-2.5" />}
                    label="Week 3 · slide 14"
                    previewSrc="/demo/week3-slide14.png"
                    previewCaption="Week 3, slide 14 — Chain Rule in Computation Graph"
                  />.&rdquo;
                </span>
              </p>
              <p className="text-[10px] text-muted-foreground italic mt-1.5">
                Hover a chip to peek; click in-app to jump straight there.
              </p>
            </div>

            <div className="space-y-2 pt-2">
              {/* Stripe upgrade — promoted to top now that we're actively
                  selling the feature. */}
              <button
                onClick={() => { void startCheckout() }}
                className="w-full text-left border-2 border-primary rounded-lg p-4 bg-primary/5 hover:bg-primary/10 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <CreditCard className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium">Upgrade to Pro</span>
                      <Badge className="text-[10px]">Recommended</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      £10/month. Zero-faff AI tutoring and free-form quizzes
                      based on your actual module content. Cancel anytime.
                    </p>
                    <p className="text-sm text-primary mt-1.5 font-medium">
                      100% of profit goes to the{' '}
                      <a
                        href="https://founderspledge.com/funds/climate-change-fund"
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-primary/40 hover:decoration-primary"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Founders Pledge Climate Fund
                      </a>
                      .
                    </p>
                  </div>
                </div>
              </button>

              {/* BYOK option — moved below as the "advanced" path. */}
              <button
                onClick={() => setStep('byok')}
                className="w-full text-left border rounded-lg p-3 hover:border-primary hover:bg-accent transition-colors"
              >
                <div className="flex items-start gap-3">
                  <Key className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium">I have my own Anthropic key</span>
                      <Badge variant="secondary" className="text-[9px]">~£0.04/session</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Bring your own key from console.anthropic.com. Pay only for
                      what you use.
                    </p>
                  </div>
                </div>
              </button>
            </div>

            {reason === 'first-time' && (
              <div className="pt-1 flex justify-center">
                <Button variant="ghost" size="sm" onClick={closeSetup} className="text-muted-foreground">
                  Skip — I'll just use multiple choice for now
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

/**
 * Inline citation chip used in the wizard's feature teaser. On hover it
 * pops up a screenshot of where the citation would jump to in the real app.
 * Pure CSS — no portal, no JS state — so it stays inside the dialog without
 * fighting z-index.
 */
function CitationChip({
  icon,
  label,
  previewSrc,
  previewCaption,
}: {
  icon: React.ReactNode
  label: string
  previewSrc: string
  previewCaption: string
}) {
  return (
    <span className="relative inline-block group/chip align-middle">
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-primary/15 text-primary text-[10px] font-medium ring-1 ring-primary/30 cursor-help">
        {icon} {label}
      </span>
      <span
        className="pointer-events-none absolute left-1/2 bottom-full z-50 mb-2 w-72 -translate-x-1/2 opacity-0 group-hover/chip:opacity-100 transition-opacity"
      >
        <span className="block rounded-lg bg-background ring-1 ring-border shadow-xl overflow-hidden">
          <img src={previewSrc} alt={previewCaption} className="block w-full h-auto" />
          <span className="block text-[10px] text-muted-foreground px-2 py-1.5 border-t border-border/60">
            {previewCaption}
          </span>
        </span>
      </span>
    </span>
  )
}
