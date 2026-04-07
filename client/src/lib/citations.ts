import type { SourceChunk } from './api'

/**
 * Replaces [[CITE:N]] tokens in an assistant message with markdown links
 * pointing at the deep-link for the cited source chunk. Lectures get a
 * "@ 12:45" timestamp label; slides get "slide 7" or similar.
 *
 * Claude is instructed to emit these tokens by streamSourceChat's system
 * prompt — the renderer just resolves them.
 */
export function renderWithCitations(content: string, chunks: SourceChunk[]): string {
  return content.replace(/\[\[CITE:(\d+)\]\]/g, (_, n: string) => {
    const idx = parseInt(n) - 1
    const chunk = chunks[idx]
    if (!chunk) return ''
    const label = chunk.position_label
      ? `${chunk.source_code} ${chunk.source_type === 'lecture' ? '@ ' : ''}${chunk.position_label}`
      : chunk.source_code
    return ` [${label}](${chunk.deep_link})`
  })
}
