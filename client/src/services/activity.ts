/**
 * Activity logging — chat history + daily study stats.
 *
 * Writes go directly to Supabase via RLS (no server round-trip). Failures are
 * logged but never thrown — analytics must never break the user-facing flow.
 */
import { supabase } from '@/lib/supabase'

// ----------------------------------------------------------------------------
// Chat history
// ----------------------------------------------------------------------------

export interface StartConversationInput {
  contextType: 'quiz' | 'concept' | 'source'
  moduleId?: string | null
  conceptId?: string | null
  questionId?: string | null
  ragGrounded?: boolean
  /** First user message — used as the conversation title (truncated to 200). */
  title?: string | null
}

export async function startConversation(input: StartConversationInput): Promise<string | null> {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null

    const { data, error } = await supabase
      .from('chat_conversations')
      .insert({
        user_id: user.id,
        context_type: input.contextType,
        module_id: input.moduleId ?? null,
        concept_id: input.conceptId ?? null,
        question_id: input.questionId ?? null,
        rag_grounded: input.ragGrounded ?? false,
        title: input.title ? input.title.slice(0, 200) : null,
      })
      .select('id')
      .single()

    if (error) {
      console.error('startConversation failed:', error.message)
      return null
    }
    return data.id as string
  } catch (e) {
    console.error('startConversation threw:', (e as Error).message)
    return null
  }
}

export async function logChatMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { error } = await supabase.from('chat_messages').insert({
      conversation_id: conversationId,
      user_id: user.id,
      role,
      content,
    })
    if (error) console.error('logChatMessage failed:', error.message)

    // Touch updated_at on the parent so the conversation list can sort by
    // recency. Best-effort — RLS allows this since we own the row.
    await supabase
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId)
  } catch (e) {
    console.error('logChatMessage threw:', (e as Error).message)
  }
}

// ----------------------------------------------------------------------------
// Daily study stats — increments via RPC for atomic concurrent writes.
// ----------------------------------------------------------------------------

export interface BumpActivityInput {
  questionsAnswered?: number
  questionsCorrect?: number
  activeSeconds?: number
  chatMessagesSent?: number
}

export async function bumpStudyActivity(input: BumpActivityInput): Promise<void> {
  try {
    const { error } = await supabase.rpc('bump_study_activity', {
      p_questions_answered: input.questionsAnswered ?? 0,
      p_questions_correct: input.questionsCorrect ?? 0,
      p_active_seconds: input.activeSeconds ?? 0,
      p_chat_messages_sent: input.chatMessagesSent ?? 0,
    })
    if (error) console.error('bumpStudyActivity failed:', error.message)
  } catch (e) {
    console.error('bumpStudyActivity threw:', (e as Error).message)
  }
}
