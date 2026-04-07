import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import termsMd from '@/content/terms.md?raw'
import privacyMd from '@/content/privacy.md?raw'

/**
 * Renders the static legal documents (TOS and Privacy) from markdown files
 * in src/content. We use vite's `?raw` import so the docs can be edited as
 * plain markdown without touching React. Both pages share this component.
 */
export function LegalPage({ doc }: { doc: 'terms' | 'privacy' }) {
  const content = doc === 'terms' ? termsMd : privacyMd
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <article className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </article>
    </div>
  )
}
