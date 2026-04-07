import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Right-rail slot. Mirrors the left sidebar layout: AppShell renders an empty
 * fixed `<aside>` on the right; any page can call `useRightRail()` and render
 * children into it via portal. The shell reserves horizontal space only while
 * a page is actively using the rail.
 */

interface RightRailContextValue {
  setActive: (active: boolean) => void
  containerRef: React.RefObject<HTMLDivElement | null>
  active: boolean
}

const RightRailContext = createContext<RightRailContextValue | null>(null)

export function RightRailProvider({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState(false)
  return (
    <RightRailContext.Provider value={{ setActive, containerRef, active }}>
      {children}
    </RightRailContext.Provider>
  )
}

/** Container that AppShell mounts. Always rendered (lg+); content portaled in. */
export function RightRailSlot() {
  const ctx = useContext(RightRailContext)
  if (!ctx) return null
  return (
    <aside
      ref={ctx.containerRef}
      className={`hidden lg:fixed lg:inset-y-0 lg:right-0 lg:w-72 lg:flex-col border-l border-border bg-sidebar overflow-y-auto ${
        ctx.active ? 'lg:flex' : ''
      }`}
    />
  )
}

/** Page-side hook: pass children, they get portaled into the slot and the
 *  shell starts reserving space. Cleans up automatically on unmount. */
export function RightRail({ children }: { children: ReactNode }) {
  const ctx = useContext(RightRailContext)
  const [target, setTarget] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!ctx) return
    ctx.setActive(true)
    setTarget(ctx.containerRef.current)
    return () => ctx.setActive(false)
  }, [ctx])

  if (!target) return null
  return createPortal(children, target)
}

export function useRightRailActive() {
  return useContext(RightRailContext)?.active ?? false
}
