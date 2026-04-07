import { supabase } from './supabase'

async function billingPost<T>(path: string): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  const res = await fetch(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function startCheckout(): Promise<void> {
  const { url } = await billingPost<{ url: string }>('/api/billing/checkout')
  if (url) window.location.href = url
}

export async function openCustomerPortal(): Promise<void> {
  const { url } = await billingPost<{ url: string }>('/api/billing/portal')
  if (url) window.location.href = url
}
