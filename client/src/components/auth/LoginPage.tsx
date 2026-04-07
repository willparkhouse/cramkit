import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { supabase, isValidEmail, isBhamEmail } from '@/lib/supabase'
import { Loader2, Mail, CheckCircle, GraduationCap } from 'lucide-react'

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
      options: {
        emailRedirectTo: window.location.origin,
      },
    })
    setLoading(false)

    if (authError) {
      setError(authError.message)
    } else {
      setSent(true)
    }
  }

  const showBhamWarning = email && isValidEmail(email.trim()) && !isBhamEmail(email.trim())

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center text-primary-foreground font-bold">
              ck
            </div>
            <CardTitle className="text-2xl">Cramkit</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">
            AI-powered exam revision built for Birmingham students
          </p>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-4 text-center py-4">
              <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
              <div>
                <p className="font-medium">Check your inbox</p>
                <p className="text-sm text-muted-foreground mt-1">
                  We sent a login link to <span className="font-medium">{email}</span>
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Don't see it? Check your spam folder. University mail servers
                sometimes filter these — if nothing arrives within a minute, try
                a personal email (Gmail, Outlook).
              </p>
              <Button variant="outline" size="sm" onClick={() => { setSent(false); setEmail('') }}>
                Use a different email
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="text-sm font-medium block mb-1.5">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@bham.ac.uk"
                  required
                  disabled={loading}
                  className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  We'll send you a passwordless login link.
                </p>
              </div>

              {showBhamWarning && (
                <div className="text-xs text-muted-foreground bg-muted border rounded-md px-3 py-2 flex gap-2">
                  <GraduationCap className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>
                    Cramkit is built for Birmingham students. Anyone can sign up,
                    but if you're a Birmingham student we recommend using your
                    bham.ac.uk email so your account gets verified.
                  </span>
                </div>
              )}

              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
                  {error}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={loading || !email.trim()}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending link...
                  </>
                ) : (
                  <>
                    <Mail className="mr-2 h-4 w-4" />
                    Send login link
                  </>
                )}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
