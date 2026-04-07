import Anthropic from '@anthropic-ai/sdk'

const apiKey = process.env.ANTHROPIC_API_KEY

if (!apiKey) {
  console.warn('ANTHROPIC_API_KEY not set in environment')
}

export const anthropic = new Anthropic({
  apiKey: apiKey || '',
})

export const SONNET_MODEL = 'claude-sonnet-4-20250514'
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
