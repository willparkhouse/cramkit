import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  searchLectures,
  streamLectureChat,
  MissingApiKeyError,
  type LectureChunk,
} from '@/lib/api'
import { renderWithCitations } from '@/lib/citations'
import { useSetup } from '@/lib/setupContext'
import { Send, Loader2, Video } from 'lucide-react'
import type { ChatMessage } from '@/types'

interface LectureMessage extends ChatMessage {
  // Cited chunks attached to assistant turns so [[CITE:n]] can be linkified
  chunks?: LectureChunk[]
}

export function LectureChatPage() {
  const { openSetup } = useSetup()
  const [messages, setMessages] = useState<LectureMessage[]>([
    {
      role: 'assistant',
      content:
        "Ask me anything about your lectures. I'll pull the relevant moments from the recordings and link you straight to them.",
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

    const userMessage: LectureMessage = { role: 'user', content: input.trim() }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput('')

    // Step 1: retrieve relevant chunks
    setRetrieving(true)
    let chunks: LectureChunk[] = []
    try {
      chunks = await searchLectures(userMessage.content, 'neuralcomp')
    } catch (err) {
      console.error('Lecture search failed:', err)
      setMessages([
        ...newMessages,
        { role: 'assistant', content: '[Error: failed to search lectures]' },
      ])
      setRetrieving(false)
      return
    }
    setRetrieving(false)

    // Step 2: stream Claude with the chunks as context
    setStreaming(true)
    const assistantMessage: LectureMessage = { role: 'assistant', content: '', chunks }
    setMessages([...newMessages, assistantMessage])

    try {
      await streamLectureChat(newMessages, chunks, (delta) => {
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
        <Video className="h-5 w-5" />
        <h1 className="text-2xl font-bold tracking-tight">Lecture chat</h1>
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
                  <div className="prose prose-sm max-w-none dark:prose-invert">
                    <ReactMarkdown
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
                Searching lectures…
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="flex gap-2 shrink-0">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about anything from the lectures…"
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
