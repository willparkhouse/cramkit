import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'

type Theme = 'light' | 'dark' | 'system'

interface ThemeContextValue {
  theme: Theme
  resolved: 'light' | 'dark'
  setTheme: (theme: Theme) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  resolved: 'light',
  setTheme: () => {},
  toggle: () => {},
})

const STORAGE_KEY = 'cramkit_theme'

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(resolved: 'light' | 'dark') {
  const root = document.documentElement
  if (resolved === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
      return stored || 'dark' // default to dark mode for new visitors
    } catch {
      return 'dark'
    }
  })

  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    theme === 'system' ? getSystemTheme() : theme
  )

  useEffect(() => {
    const next: 'light' | 'dark' = theme === 'system' ? getSystemTheme() : theme
    setResolved(next)
    applyTheme(next)
  }, [theme])

  // Listen to system preference changes when theme === 'system'
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      const next = e.matches ? 'dark' : 'light'
      setResolved(next)
      applyTheme(next)
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch {}
  }, [])

  const toggle = useCallback(() => {
    // Light → dark → system → light
    setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light')
  }, [theme, setTheme])

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
