/**
 * Multimodal input — pass image / audio / video / file parts (not just text) to
 * `agent.run`. The agent puts them on the user message's `parts`; your
 * `LanguageModel` adapter forwards them to the provider (see how the Gemini
 * adapter maps them in examples/ai-assistant/gemini-model.ts). `content` keeps a
 * text-only fallback for memory / planner / fact search.
 *
 * Run with:  bun run examples/multimodal.ts
 */
import { Agent, type ContentPart, type LanguageModel, partsToText } from '../src/index'

// A mock model that just reports what modalities it received on the user message.
const model: LanguageModel = {
  id: 'mock-multimodal',
  generate: ({ messages }) => {
    const user = messages.findLast((m) => m.role === 'user')
    const kinds = (user?.parts ?? []).map((p) => p.type)
    return Promise.resolve({ content: `received parts: [${kinds.join(', ')}]` })
  },
}

const agent = new Agent({ model })

// Mix text with an image (by URL) and an audio clip (inline base64).
const input: ContentPart[] = [
  { type: 'text', text: 'What is in this image, and transcribe the audio?' },
  { type: 'image', source: { url: 'https://example.com/photo.jpg', mimeType: 'image/jpeg' } },
  { type: 'audio', source: { data: 'UklGRg...(base64)...', mimeType: 'audio/wav' } },
]

console.log('Text fallback:', partsToText(input))
const result = await agent.run(input)
console.log('Model saw:', result.output)

// Plain strings still work unchanged.
console.log((await agent.run('just text')).output)
