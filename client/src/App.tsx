import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import { AuthProvider, useAuth } from '@/lib/auth'
import { SetupProvider, useSetup, hasSeenFirstTimeSetup } from '@/lib/setupContext'
import { ThemeProvider } from '@/lib/theme'
import { AppShell } from '@/components/layout/AppShell'
import { LoginPage } from '@/components/auth/LoginPage'
import { SetupWizard } from '@/components/auth/SetupWizard'
import { DashboardPage } from '@/components/dashboard/DashboardPage'
import { AdminPage } from '@/components/admin/AdminPage'
import { QuizPage } from '@/components/quiz/QuizPage'
import { MaterialSearchPage } from '@/components/search/MaterialSearchPage'
import { SchedulePage } from '@/components/schedule/SchedulePage'
import { ProgressPage } from '@/components/progress/ProgressPage'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { ModulesPage } from '@/components/modules/ModulesPage'
import { LegalPage } from '@/components/legal/LegalPage'
import { hydrateStore } from '@/store/hydrate'
import { useSyncToSupabase } from '@/hooks/useSyncToSupabase'
import { useActiveTime } from '@/hooks/useActiveTime'
import { useAppStore } from '@/store/useAppStore'
import { Loader2 } from 'lucide-react'

function ProtectedApp() {
  const { user, isAdmin } = useAuth()
  const setHydrated = useAppStore((s) => s.setHydrated)
  const { openSetup } = useSetup()

  useSyncToSupabase()
  useActiveTime(!!user)

  useEffect(() => {
    if (user) {
      hydrateStore()
      // First-login setup wizard — only fires once per browser
      if (!hasSeenFirstTimeSetup()) {
        // Small delay so the dashboard renders first
        setTimeout(() => openSetup('first-time'), 400)
      }
    } else {
      setHydrated(false)
    }
  }, [user, openSetup, setHydrated])

  return (
    <>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/modules" element={<ModulesPage />} />
          <Route path="/quiz" element={<QuizPage />} />
          <Route path="/progress" element={<ProgressPage />} />
          <Route path="/search" element={<MaterialSearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/terms" element={<LegalPage doc="terms" />} />
          <Route path="/privacy" element={<LegalPage doc="privacy" />} />

          {/* Admin-only routes */}
          {isAdmin && <Route path="/admin" element={<AdminPage />} />}
          {isAdmin && <Route path="/schedule" element={<SchedulePage />} />}
          {/* Legacy redirect: /ingest is now a tab inside /admin */}
          {isAdmin && <Route path="/ingest" element={<Navigate to="/admin" replace />} />}

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <SetupWizard />
    </>
  )
}

function AuthGate() {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!session) {
    return (
      <Routes>
        {/* Legal pages must be reachable while logged out — payment flows
            and app-store listings will link to them. */}
        <Route path="/terms" element={<LegalPage doc="terms" />} />
        <Route path="/privacy" element={<LegalPage doc="privacy" />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    )
  }

  return <ProtectedApp />
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <SetupProvider>
            <AuthGate />
          </SetupProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
