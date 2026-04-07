import { supabase } from './supabase'

const STORAGE_KEY = 'cramkit_anthropic_key'

export function getApiKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setApiKey(key: string | null): void {
  try {
    if (key) {
      localStorage.setItem(STORAGE_KEY, key)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // ignore quota errors
  }
}

/**
 * Sync the API key to the user's Supabase metadata so it follows them
 * across devices. Stored in user_metadata which is only visible to the user.
 */
export async function syncApiKeyToProfile(key: string | null): Promise<void> {
  await supabase.auth.updateUser({
    data: { anthropic_api_key: key },
  })
}

/**
 * On login, hydrate the local storage key from the user's profile if missing.
 */
export async function hydrateApiKeyFromProfile(): Promise<void> {
  const local = getApiKey()
  if (local) return

  const { data: { user } } = await supabase.auth.getUser()
  const remoteKey = user?.user_metadata?.anthropic_api_key as string | undefined
  if (remoteKey) {
    setApiKey(remoteKey)
  }
}

export function isValidKeyFormat(key: string): boolean {
  return /^sk-ant-[a-zA-Z0-9_-]{20,}$/.test(key.trim())
}
