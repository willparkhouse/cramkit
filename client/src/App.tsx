import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import { AuthProvider, useAuth } from '@/lib/auth'
import { AppShell } from '@/components/layout/AppShell'
import { LoginPage } from '@/components/auth/LoginPage'
import { DashboardPage } from '@/components/dashboard/DashboardPage'
import { IngestionPage } from '@/components/ingestion/IngestionPage'
import { QuizPage } from '@/components/quiz/QuizPage'
import { ChatPage } from '@/components/chat/ChatPage'
import { SchedulePage } from '@/components/schedule/SchedulePage'
import { ProgressPage } from '@/components/progress/ProgressPage'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { hydrateStore } from '@/store/hydrate'
import { useSyncToSupabase } from '@/hooks/useSyncToSupabase'
import { useAppStore } from '@/store/useAppStore'
import { Loader2 } from 'lucide-react'

function ProtectedApp() {
  const { user } = useAuth()
  const setHydrated = useAppStore((s) => s.setHydrated)

  useSyncToSupabase()

  useEffect(() => {
    if (user) {
      hydrateStore()
    } else {
      setHydrated(false)
    }
  }, [user])

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/ingest" element={<IngestionPage />} />
        <Route path="/quiz" element={<QuizPage />} />
        <Route path="/progress" element={<ProgressPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/schedule" element={<SchedulePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
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
        <Route path="*" element={<LoginPage />} />
      </Routes>
    )
  }

  return <ProtectedApp />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </BrowserRouter>
  )
}
