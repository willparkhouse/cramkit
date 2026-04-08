/**
 * Module-publish notification helpers — fetch unseen "your module just
 * dropped" rows so the dashboard can pop a toast, then mark them seen so
 * they don't repeat across sessions.
 *
 * Rows are inserted by the publish trigger in migration 010 when a module
 * transitions to is_published=true. Users can only see and update their
 * own rows via RLS.
 */
import { supabase } from '@/lib/supabase'

export interface PublishNotification {
  id: string
  exam_id: string
  exam_name: string
  exam_slug: string
  created_at: string
}

export async function fetchUnseenPublishNotifications(): Promise<PublishNotification[]> {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return []
    // Two queries — Supabase JS join on a different table would need a
    // foreign-key relationship, which we have but the embedding syntax is
    // brittle. Just fetch the notifs then the matching exams.
    const { data: notifs, error } = await supabase
      .from('module_publish_notifications')
      .select('id, exam_id, created_at')
      .eq('user_id', user.id)
      .is('seen_at', null)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('fetchUnseenPublishNotifications failed:', error.message)
      return []
    }
    if (!notifs || notifs.length === 0) return []
    const examIds = notifs.map((n) => n.exam_id as string)
    const { data: exams } = await supabase
      .from('exams')
      .select('id, name, slug')
      .in('id', examIds)
    const examById = new Map((exams ?? []).map((e) => [e.id as string, e]))
    return notifs
      .map((n) => {
        const exam = examById.get(n.exam_id as string)
        if (!exam) return null
        return {
          id: n.id as string,
          exam_id: n.exam_id as string,
          exam_name: exam.name as string,
          exam_slug: exam.slug as string,
          created_at: n.created_at as string,
        }
      })
      .filter((n): n is PublishNotification => n !== null)
  } catch (e) {
    console.error('fetchUnseenPublishNotifications threw:', (e as Error).message)
    return []
  }
}

export async function dismissPublishNotification(id: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('module_publish_notifications')
      .update({ seen_at: new Date().toISOString() })
      .eq('id', id)
    if (error) console.error('dismissPublishNotification failed:', error.message)
  } catch (e) {
    console.error('dismissPublishNotification threw:', (e as Error).message)
  }
}

export async function dismissAllPublishNotifications(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    const { error } = await supabase
      .from('module_publish_notifications')
      .update({ seen_at: new Date().toISOString() })
      .in('id', ids)
    if (error) console.error('dismissAllPublishNotifications failed:', error.message)
  } catch (e) {
    console.error('dismissAllPublishNotifications threw:', (e as Error).message)
  }
}
