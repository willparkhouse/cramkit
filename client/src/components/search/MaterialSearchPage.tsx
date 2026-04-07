import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { searchSources, type SourceChunk } from '@/lib/api'
import { Search, Loader2, ExternalLink, Video, FileText } from 'lucide-react'

/**
 * Friendlier display title for a chunk. The DB `source_code` is a stable
 * machine identifier (e.g. "neuralcomp-slides-w2", "nc3.4") and looks ugly
 * in the UI. We derive something readable from source_type + parts.
 */
function displayTitle(c: SourceChunk): string {
  if (c.source_type === 'slides') {
    const m = c.source_code.match(/w(\d+)/i)
    const week = m ? m[1] : '?'
    const pos = c.position_label ? ` · ${c.position_label}` : ''
    return `Week ${week} slides${pos}`
  }
  if (c.source_type === 'lecture') {
    // nc{week}.{lecture}  →  "Lecture {week}.{lecture}"
    const m = c.source_code.match(/^[a-z]+(\d+)\.(\w+)$/i)
    const label = m ? `Lecture ${m[1]}.${m[2]}` : c.source_code
    const pos = c.position_label ? ` · ${c.position_label}` : ''
    return `${label}${pos}`
  }
  return c.position_label ? `${c.source_code} · ${c.position_label}` : c.source_code
}

/**
 * Keep results in raw similarity order, but guarantee that the first 3
 * positions contain at least one of each source type when both are available.
 * If the natural top-3 is already mixed, this is a no-op. If it's all one
 * type, we promote the highest-ranked chunk of the missing type into 3rd
 * place. Everything past position 3 stays in pure similarity order.
 */
function rebalance(chunks: SourceChunk[]): SourceChunk[] {
  const out = chunks.slice(0, 8)
  if (out.length < 3) return out

  const top3Types = new Set(out.slice(0, 3).map((c) => c.source_type))
  const missing: 'lecture' | 'slides' | null =
    !top3Types.has('lecture') ? 'lecture' : !top3Types.has('slides') ? 'slides' : null
  if (!missing) return out

  // Find the best-ranked missing-type chunk further down the list
  const promoteIdx = out.findIndex((c, i) => i >= 3 && c.source_type === missing)
  if (promoteIdx === -1) return out

  const [promoted] = out.splice(promoteIdx, 1)
  out.splice(2, 0, promoted)
  return out
}

/**
 * Pure full-text-style search over the lecture transcript and slide RAG.
 * No Claude in the loop — type a query, get ranked chunks, click through
 * to Panopto / the slide PDF. The use case is "I remember Krull mentioned
 * X somewhere, where was that?" — i.e. lookups, not learning.
 *
 * The wrong-answer panel inside the quiz is where the AI-grounded learning
 * loop lives; this page is just a free, fast lookup tool.
 */
export function MaterialSearchPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SourceChunk[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const runSearch = async () => {
    const trimmed = query.trim()
    if (!trimmed || searching) return
    setSearching(true)
    setError(null)
    try {
      // Ask for more than we'll show so we have headroom to rebalance the mix.
      const chunks = await searchSources(trimmed, 'neuralcomp', undefined, 12)
      setResults(rebalance(chunks))
    } catch (err) {
      console.error('Search failed:', err)
      setError('Search failed. Try again in a moment.')
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Search materials</h1>
        <p className="text-sm text-muted-foreground">
          Find a specific moment in your lecture recordings or slide decks. Click any
          result to jump straight to it.
        </p>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. backpropagation, gradient descent, softmax…"
            className="flex h-9 w-full rounded-md border border-input bg-transparent pl-9 pr-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                runSearch()
              }
            }}
          />
        </div>
        <Button onClick={runSearch} disabled={!query.trim() || searching}>
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Search'}
        </Button>
      </div>

      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {results && results.length === 0 && !searching && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground text-center">
            No results. Try different wording.
          </CardContent>
        </Card>
      )}

      {results && results.length > 0 && (
        <div className="divide-y divide-border/50">
          {results.map((c) => {
            const SourceIcon = c.source_type === 'slides' ? FileText : Video
            return (
              <a
                key={c.chunk_id}
                href={c.deep_link}
                target="_blank"
                rel="noreferrer"
                className="group block py-3 px-1 hover:bg-accent/30 transition-colors -mx-1 rounded-md"
              >
                <div className="flex items-center gap-2 mb-1">
                  <SourceIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs font-medium">{displayTitle(c)}</span>
                  <ExternalLink className="h-3 w-3 text-muted-foreground/60 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                <p className="text-sm text-foreground/75 line-clamp-3 leading-relaxed">{c.chunk_text}</p>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
