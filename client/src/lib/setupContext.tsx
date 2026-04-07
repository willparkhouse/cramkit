import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface SetupContextValue {
  isOpen: boolean
  reason: 'first-time' | 'required' | null
  openSetup: (reason: 'first-time' | 'required') => void
  closeSetup: () => void
}

const SetupContext = createContext<SetupContextValue>({
  isOpen: false,
  reason: null,
  openSetup: () => {},
  closeSetup: () => {},
})

const FIRST_LOGIN_FLAG = 'cramkit_seen_setup'

export function SetupProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [reason, setReason] = useState<'first-time' | 'required' | null>(null)

  const openSetup = useCallback((r: 'first-time' | 'required') => {
    setReason(r)
    setIsOpen(true)
  }, [])

  const closeSetup = useCallback(() => {
    setIsOpen(false)
    if (reason === 'first-time') {
      try { localStorage.setItem(FIRST_LOGIN_FLAG, '1') } catch {}
    }
  }, [reason])

  return (
    <SetupContext.Provider value={{ isOpen, reason, openSetup, closeSetup }}>
      {children}
    </SetupContext.Provider>
  )
}

export function useSetup() {
  return useContext(SetupContext)
}

export function hasSeenFirstTimeSetup(): boolean {
  try {
    return localStorage.getItem(FIRST_LOGIN_FLAG) === '1'
  } catch {
    return true
  }
}
