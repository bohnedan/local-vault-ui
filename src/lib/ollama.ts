// Local-only Ollama client. Security boundary: this is the ONLY module in the
// app that makes outbound HTTP requests, and it only ever talks to OLLAMA_HOST
// (default http://localhost:11434). No vault data is sent anywhere else.

import { getConfig } from '@/lib/config'

export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434'

function assertLocalHost(url: string) {
  const { hostname } = new URL(url)
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
    throw new Error(`Refusing to call non-local Ollama host: ${hostname}`)
  }
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export async function ollamaChat(opts: {
  messages: ChatMessage[]
  format?: 'json'
  // Context window. Ollama defaults to a tiny 2048 tokens, which silently TRUNCATES
  // big prompts (e.g. a dropped PDF + _CLAUDE.md + retrieved notes) — dropping the
  // "return JSON" instructions and leaving no room to finish the reply, so JSON
  // comes back incomplete/unparseable. Defaults to the user-tunable config value
  // (chatNumCtx); callers can still override for unusually large-document work.
  numCtx?: number
  // Which side of the writer/librarian split handles this call (see MODEL-SELECTION.md):
  //   'writer'    — prose (chat answers, note merges)        → writerModel
  //   'librarian' — structured/JSON work (curation, ingest…) → librarianModel
  // Both resolve to chatModel unless the user configured a split, so omitting it (or
  // any legacy caller) just uses chatModel — unchanged behavior.
  role?: 'writer' | 'librarian'
}): Promise<string> {
  const url = `${OLLAMA_HOST}/api/chat`
  assertLocalHost(url)

  const cfg = getConfig()
  const model = opts.role === 'writer' ? cfg.writerModel
    : opts.role === 'librarian' ? cfg.librarianModel
    : cfg.chatModel

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: opts.messages,
      stream: false,
      ...(opts.format ? { format: opts.format } : {}),
      options: { num_ctx: opts.numCtx ?? getConfig().chatNumCtx },
    }),
  })

  if (!res.ok) {
    throw new Error(`Ollama chat failed: ${res.status} ${await res.text()}`)
  }

  const data = await res.json() as { message: { content: string } }
  return data.message.content
}

// Describe/OCR an image with a vision-capable model. Images are base64 (no data:
// prefix), per Ollama's /api/chat "images" field. `model` lets the caller pick the
// model — so a multimodal CHAT model (e.g. Gemma 3) can read images directly,
// without requiring a separate vision model to be installed.
export async function ollamaVisionChat(opts: {
  prompt: string
  imagesBase64: string[]
  model?: string
}): Promise<string> {
  const url = `${OLLAMA_HOST}/api/chat`
  assertLocalHost(url)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model ?? getConfig().visionModel,
      messages: [{ role: 'user', content: opts.prompt, images: opts.imagesBase64 }],
      stream: false,
      options: { num_ctx: 8192 },
    }),
  })

  if (!res.ok) {
    throw new Error(`Ollama vision failed: ${res.status} ${await res.text()}`)
  }

  const data = await res.json() as { message: { content: string } }
  return data.message.content
}

// Stable marker we tag onto genuine context-window-overflow errors, so the caller
// can decide to split-and-retry on THOSE only — not on transient failures (model
// still loading, server busy) that happen to contain "400"/"too long" in the body.
// Misclassifying those as overflow is what silently exploded the index into tiny
// chunks and made the chunk count non-deterministic across rebuilds.
export const EMBED_CONTEXT_OVERFLOW = 'EMBED_CONTEXT_OVERFLOW'

// Real context-overflow signatures from Ollama / llama.cpp. Deliberately narrow.
const CONTEXT_OVERFLOW_RE = /context (length|window)|maximum context|exceeds?.*context|input (length|is too) /i

export async function ollamaEmbed(text: string): Promise<number[]> {
  const url = `${OLLAMA_HOST}/api/embed`
  assertLocalHost(url)

  // An empty/whitespace input makes Ollama 400 with a non-context error; never send
  // one (and never store a bogus embedding for it).
  if (!text.trim()) throw new Error('Ollama embed failed: empty input')

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: getConfig().embedModel,
      input: text,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    // Only a genuine context overflow is tagged for split-and-retry. Everything
    // else (model loading, OOM, server busy) propagates as a plain failure so the
    // note is skipped — not silently shredded into sub-300-char fragments.
    const overflow = (res.status === 400 || res.status === 413) && CONTEXT_OVERFLOW_RE.test(body)
    throw new Error(`Ollama embed failed: ${res.status} ${body}${overflow ? ` [${EMBED_CONTEXT_OVERFLOW}]` : ''}`)
  }

  const data = await res.json() as { embeddings?: number[][] }
  const embedding = data.embeddings?.[0]
  if (!embedding?.length) throw new Error('Ollama embed failed: model returned no embedding')
  return embedding
}
