import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { syncKnowledgeToServer } from '@/store/hydrate'

export function useSyncToSupabase() {
  const knowledge = useAppStore((s) => s.knowledge)
  const hydrated = useAppStore((s) => s.hydrated)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const knowledgeRef = useRef(knowledge)
  knowledgeRef.current = knowledge

  useEffect(() => {
    if (!hydrated) return

    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      syncKnowledgeToServer(knowledgeRef.current)
    }, 2000)

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [knowledge, hydrated])
}
