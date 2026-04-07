import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { supabase, isValidEmail, isBhamEmail } from '@/lib/supabase'
import { Logo } from '@/components/layout/Logo'
import { Loader2, Mail, CheckCircle, AlertTriangle, ArrowRight } from 'lucide-react'

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.52-1.34-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18a10.95 10.95 0 0 1 5.74 0c2.18-1.49 3.14-1.18 3.14-1.18.63 1.58.23 2.75.12 3.04.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.05.78 2.13v3.16c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  )
}

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmed = email.trim().toLowerCase()
    if (!isValidEmail(trimmed)) {
      setError('Please enter a valid email address.')
      return
    }

    setLoading(true)
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { emailRedirectTo: window.location.origin },
    })
    setLoading(false)

    if (authError) {
      setError(authError.message)
    } else {
      setSent(true)
    }
  }

  const showBhamWarning = email && isValidEmail(email.trim()) && isBhamEmail(email.trim())

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Hero with big centered logo */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-lg space-y-10">
          {sent ? (
            <SentState email={email} onReset={() => { setSent(false); setEmail('') }} />
          ) : (
            <>
              {/* Big centred logo */}
              <div className="flex justify-center">
                <Logo className="w-72 md:w-96" />
              </div>

              {/* Dictionary definition */}
              <DictionaryDefinition />

              {/* Form */}
              <form onSubmit={handleSubmit} className="space-y-4 max-w-sm mx-auto">
                <div>
                  <label htmlFor="email" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-2">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@gmail.com"
                    required
                    disabled={loading}
                    autoFocus
                    className="w-full bg-background border border-border rounded-lg px-4 py-3 text-base focus:border-primary focus:outline-none transition-colors"
                  />
                </div>

                {showBhamWarning && (
                  <div className="text-xs text-amber-600 dark:text-amber-500 flex gap-2 px-1">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      Heads up — University of Birmingham mail servers currently
                      filter our login emails, so your bham.ac.uk address probably
                      won't receive the link. Use a personal email (Gmail, Outlook, etc.)
                      instead.
                    </span>
                  </div>
                )}

                {error && (
                  <div className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}

                <Button
                  type="submit"
                  size="lg"
                  className="w-full h-12 text-base font-medium gap-2"
                  disabled={loading || !email.trim()}
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Sending link…
                    </>
                  ) : (
                    <>
                      <Mail className="h-4 w-4" />
                      Send login link
                      <ArrowRight className="h-4 w-4 ml-auto" />
                    </>
                  )}
                </Button>

                <p className="text-xs text-muted-foreground text-center">
                  No password. We'll email you a one-tap login link.
                </p>
              </form>
            </>
          )}
        </div>
      </main>

      <footer className="px-6 py-6 flex flex-col items-center gap-2">
        <p className="text-xs text-muted-foreground">
          Built for May 2026 exams · BYOK Anthropic for AI features
        </p>
        <a
          href="https://github.com/willparkhouse/cramkit"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <GithubIcon className="h-3 w-3" />
          Open source on GitHub
        </a>
      </footer>
    </div>
  )
}

function DictionaryDefinition() {
  return (
    <div className="border-y border-border py-5 px-1 max-w-md mx-auto">
      <div className="flex items-baseline gap-3 mb-2">
        <span className="text-xs italic text-muted-foreground">/ˈkramˌkɪt/</span>
        <span className="text-xs text-muted-foreground">noun</span>
      </div>
      <p className="text-sm text-foreground leading-relaxed">
        a survival pack for the weeks before an exam — past papers,
        scattered lecture notes, and an AI tutor that quietly tracks
        what you actually know.
      </p>
      <p className="text-xs text-muted-foreground italic mt-2">
        "I haven't started revising yet — better break out the cramkit."
      </p>
    </div>
  )
}

interface MailProvider {
  name: string
  url: string
}

/**
 * Recognise common webmail providers from an email address and return a deep
 * link to the user's inbox. Returns null for unknown providers (then we fall
 * back to the generic "check your inbox" copy).
 */
function detectMailProvider(email: string): MailProvider | null {
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain) return null

  // University of Birmingham students use Office 365 / Outlook
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return { name: 'Gmail', url: 'https://mail.google.com/mail/u/0/#inbox' }
  }
  if (
    domain === 'outlook.com' ||
    domain === 'hotmail.com' ||
    domain === 'live.com' ||
    domain === 'msn.com' ||
    domain.endsWith('bham.ac.uk') // uni Office 365 tenant
  ) {
    return { name: 'Outlook', url: 'https://outlook.live.com/mail/0/inbox' }
  }
  if (domain === 'yahoo.com' || domain === 'yahoo.co.uk') {
    return { name: 'Yahoo Mail', url: 'https://mail.yahoo.com/' }
  }
  if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com') {
    return { name: 'iCloud Mail', url: 'https://www.icloud.com/mail' }
  }
  if (domain === 'proton.me' || domain === 'protonmail.com' || domain === 'pm.me') {
    return { name: 'Proton Mail', url: 'https://mail.proton.me/' }
  }
  return null
}

function SentState({ email, onReset }: { email: string; onReset: () => void }) {
  const provider = detectMailProvider(email)

  return (
    <div className="space-y-6 text-center">
      <div className="flex justify-center">
        <Logo className="w-56" />
      </div>
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10">
        <CheckCircle className="h-7 w-7 text-primary" />
      </div>
      <div className="space-y-2">
        <h2 className="text-2xl font-bold tracking-tight">Check your inbox</h2>
        <p className="text-sm text-muted-foreground">
          We sent a login link to <span className="font-medium text-foreground">{email}</span>
        </p>
      </div>

      {provider && (
        <div className="flex justify-center">
          <Button asChild size="lg" className="h-12 px-6 gap-2">
            <a href={provider.url} target="_blank" rel="noreferrer">
              Open {provider.name}
              <ArrowRight className="h-4 w-4" />
            </a>
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground max-w-xs mx-auto">
        Don't see it? Check your spam folder. Some university mail servers
        filter these — if nothing arrives within a minute, try a personal
        email address (Gmail, Outlook).
      </p>
      <Button variant="outline" size="sm" onClick={onReset}>
        Use a different email
      </Button>
    </div>
  )
}
