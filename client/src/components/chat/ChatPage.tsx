import { useState, useRef, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ConceptSelector } from './ConceptSelector'
import { useAppStore } from '@/store/useAppStore'
import { streamChat, MissingApiKeyError } from '@/lib/api'
import { useSetup } from '@/lib/setupContext'
import { MessageSquare, Send, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Concept, ChatMessage } from '@/types'

export function ChatPage() {
  const concepts = useAppStore((s) => s.concepts)
  const { openSetup } = useSetup()
  const [selectedConcept, setSelectedConcept] = useState<Concept | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSelectConcept = (concept: Concept) => {
    setSelectedConcept(concept)
    setMessages([
      {
        role: 'assistant',
        content: `I'm ready to help you learn about **${concept.name}**. Ask me anything about this topic, or I can explain the key concepts.`,
      },
    ])
  }

  const sendMessage = async () => {
    if (!input.trim() || streaming || !selectedConcept) return

    const userMessage: ChatMessage = { role: 'user', content: input.trim() }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput('')
    setStreaming(true)

    const assistantMessage: ChatMessage = { role: 'assistant', content: '' }
    setMessages([...newMessages, assistantMessage])

    try {
      await streamChat(
        newMessages,
        `Concept: ${selectedConcept.name}\nDescription: ${selectedConcept.description}\nKey Facts:\n${selectedConcept.key_facts.join('\n')}\n\nSource Material:\n${selectedConcept.source_excerpt || 'No source excerpt available.'}`,
        (chunk) => {
          assistantMessage.content += chunk
          setMessages((prev) => [...prev.slice(0, -1), { ...assistantMessage }])
        }
      )
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        // Strip the placeholder assistant message and prompt setup
        setMessages((prev) => prev.slice(0, -1))
        openSetup('required')
      } else {
        console.error('Chat error:', err)
        assistantMessage.content += '\n\n[Error: Failed to get response]'
        setMessages((prev) => [...prev.slice(0, -1), { ...assistantMessage }])
      }
    } finally {
      setStreaming(false)
    }
  }

  if (concepts.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Learn</h1>
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
            <MessageSquare className="h-12 w-12 text-muted-foreground" />
            <p className="text-muted-foreground max-w-md">
              No concepts to learn from yet. Enroll in modules to get started.
            </p>
            <Button asChild>
              <Link to="/modules">Browse modules</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4 h-[calc(100vh-8rem)] md:h-[calc(100vh-4rem)] flex flex-col">
      <h1 className="text-2xl font-bold tracking-tight shrink-0">Learn</h1>

      <ConceptSelector
        selected={selectedConcept}
        onSelect={handleSelectConcept}
      />

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
        <div className="space-y-4 pr-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted'
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Input */}
      {selectedConcept && (
        <div className="flex gap-2 shrink-0">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask about ${selectedConcept.name}...`}
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
            disabled={!input.trim() || streaming}
            size="icon"
            className="shrink-0 self-end"
          >
            {streaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
