/**
 * IndexedDB-backed local cache for lesson walkthroughs.
 *
 * Stores the walkthrough text + source chunks per concept so the Study page
 * can render offline when the student pre-loads a week while they have signal.
 *
 * Schema: one object store keyed by concept_id, each entry holds:
 *   { conceptId, text, chunks (SourceChunk[]), cachedAt (ISO string) }
 *
 * Intentionally simple — no versioning, no TTL, no eviction. Walkthroughs
 * don't change and the total size for a full module (~80 concepts × ~3KB) is
 * well under 1MB.
 */
import type { SourceChunk } from './api'

const DB_NAME = 'cramkit-lessons'
const DB_VERSION = 1
const STORE_NAME = 'walkthroughs'

export interface CachedLesson {
  conceptId: string
  text: string
  chunks: SourceChunk[]
  cachedAt: string
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'conceptId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getCachedLesson(conceptId: string): Promise<CachedLesson | null> {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(conceptId)
      req.onsuccess = () => resolve((req.result as CachedLesson) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

export async function putCachedLesson(entry: CachedLesson): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.put(entry)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // Cache write failure is non-fatal.
  }
}

/**
 * Returns the set of concept IDs that are currently cached locally.
 * Used to render the "cached" indicator on the concept list.
 */
export async function getCachedConceptIds(): Promise<Set<string>> {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.getAllKeys()
      req.onsuccess = () => resolve(new Set(req.result.map(String)))
      req.onerror = () => resolve(new Set())
    })
  } catch {
    return new Set()
  }
}
