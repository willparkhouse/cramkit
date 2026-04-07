import type { SourceChunk } from './api'

/**
 * Replaces [[CITE:N]] tokens in an assistant message with compact markdown
 * links pointing at the deep-link for the cited source chunk. Renders as
 * a small pill-style number badge — the full source label appears on
 * hover via the link's title attribute.
 *
 * Claude is instructed to emit these tokens by streamSourceChat's system
 * prompt — the renderer just resolves them.
 */
export function renderWithCitations(content: string, chunks: SourceChunk[]): string {
  return content.replace(/\[\[CITE:(\d+)\]\]/g, (_, n: string) => {
    const idx = parseInt(n) - 1
    const chunk = chunks[idx]
    if (!chunk) return ''
    // Tooltip text shown on hover — full source code + position
    const tooltip = chunk.position_label
      ? `${chunk.source_code} ${chunk.source_type === 'lecture' ? '@ ' : ''}${chunk.position_label}`
      : chunk.source_code
    // Emit a markdown link with the citation number as the visible label.
    // The custom <a> renderer in QuizPage detects href + cite_n and styles it.
    return ` [${n}](${chunk.deep_link} "${tooltip.replace(/"/g, '&quot;')}")`
  })
}
