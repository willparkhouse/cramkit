import type { LectureChunk } from './api'

/**
 * Replaces [[CITE:N]] tokens in an assistant message with markdown links
 * pointing at the Panopto deep-link for the cited chunk.
 *
 * Claude is instructed to emit these tokens by streamLectureChat's system
 * prompt — the renderer just resolves them.
 */
export function renderWithCitations(content: string, chunks: LectureChunk[]): string {
  return content.replace(/\[\[CITE:(\d+)\]\]/g, (_, n: string) => {
    const idx = parseInt(n) - 1
    const chunk = chunks[idx]
    if (!chunk) return ''
    return ` [${chunk.lecture_code} @ ${chunk.timestamp_label}](${chunk.deep_link})`
  })
}
