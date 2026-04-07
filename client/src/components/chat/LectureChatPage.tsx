import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  searchSources,
  streamSourceChat,
  MissingApiKeyError,
  type SourceChunk,
} from '@/lib/api'
import { renderWithCitations } from '@/lib/citations'
import { useSetup } from '@/lib/setupContext'
import { Send, Loader2, BookOpen } from 'lucide-react'
import type { ChatMessage } from '@/types'

interface SourceMessage extends ChatMessage {
  // Cited chunks attached to assistant turns so [[CITE:n]] can be linkified
  chunks?: SourceChunk[]
}

export function LectureChatPage() {
  const { openSetup } = useSetup()
  const [messages, setMessages] = useState<SourceMessage[]>([
    {
      role: 'assistant',
      content:
        "Ask me anything about your course material. I'll pull the most relevant moments from the lecture recordings and slide decks and link you straight to them.",
    },
  ])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [retrieving, setRetrieving] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const sendMessage = async () => {
    if (!input.trim() || streaming || retrieving) return

    const userMessage: SourceMessage = { role: 'user', content: input.trim() }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput('')

    // Step 1: retrieve relevant chunks across lectures + slides
    setRetrieving(true)
    let chunks: SourceChunk[] = []
    try {
      chunks = await searchSources(userMessage.content, 'neuralcomp')
    } catch (err) {
      console.error('Source search failed:', err)
      setMessages([
        ...newMessages,
        { role: 'assistant', content: '[Error: failed to search course material]' },
      ])
      setRetrieving(false)
      return
    }
    setRetrieving(false)

    // Step 2: stream Claude with the chunks as context
    setStreaming(true)
    const assistantMessage: SourceMessage = { role: 'assistant', content: '', chunks }
    setMessages([...newMessages, assistantMessage])

    try {
      await streamSourceChat(newMessages, chunks, (delta) => {
        assistantMessage.content += delta
        setMessages((prev) => [...prev.slice(0, -1), { ...assistantMessage }])
      })
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        setMessages((prev) => prev.slice(0, -1))
        openSetup('required')
      } else {
        console.error('Lecture chat error:', err)
        assistantMessage.content += '\n\n[Error: failed to get response]'
        setMessages((prev) => [...prev.slice(0, -1), { ...assistantMessage }])
      }
    } finally {
      setStreaming(false)
    }
  }

  const busy = streaming || retrieving

  return (
    <div className="space-y-4 h-[calc(100vh-8rem)] md:h-[calc(100vh-4rem)] flex flex-col">
      <div className="flex items-center gap-2 shrink-0">
        <BookOpen className="h-5 w-5" />
        <h1 className="text-2xl font-bold tracking-tight">Course material chat</h1>
      </div>

      <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
        <div className="space-y-4 pr-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-4 py-2 text-sm ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted'
                }`}
              >
                {msg.role === 'assistant' && msg.chunks ? (
                  <div className="prose prose-sm max-w-none dark:prose-invert cramkit-chat-prose">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                      components={{
                        a: ({ href, children }) => (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="underline decoration-dotted text-primary"
                          >
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {renderWithCitations(msg.content, msg.chunks)}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                )}
              </div>
            </div>
          ))}
          {retrieving && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg px-4 py-2 text-sm flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching lectures and slides…
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="flex gap-2 shrink-0">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about anything from the lectures or slides…"
          rows={2}
          className="resize-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              sendMessage()
            }
          }}
        />
        <Button
          onClick={sendMessage}
          disabled={!input.trim() || busy}
          size="icon"
          className="shrink-0 self-end"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}
