import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { retrieve } from '@/lib/embeddings'
import { buildIngestPrompt } from '@/lib/prompts'
import { ollamaChat, ollamaVisionChat } from '@/lib/ollama'
import { getVaultPath } from '@/lib/vault'
import { getConfig } from '@/lib/config'
import { normalizeChanges } from '@/lib/healthFix'
import { applyTags } from '@/lib/tags'
import { reconcileUpdates } from '@/lib/merge'
import { parseModelJson } from '@/lib/modelJson'

export const dynamic = 'force-dynamic'

const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.text'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_CHARS = 12000 // keep within the model's context

type IngestResult = {
  changes: Array<{ path: string; action: 'create' | 'update'; content: string }>
  log_entry: string
  summary: string
  origin?: string
}

async function extractText(ext: string, buffer: Buffer): Promise<string | null> {
  if (TEXT_EXTS.has(ext)) return buffer.toString('utf-8')
  if (ext === '.pdf') {
    try {
      // Dynamic import so a missing/broken pdf lib never breaks the rest of the app.
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({ data: buffer })
      const result = await parser.getText()
      return result.text
    } catch {
      return null
    }
  }
  return null
}

// Save an image into the vault's Assets/ folder, deduping into _inbox/ on collision.
function saveImage(filename: string, buffer: Buffer): string {
  const assetsDir = path.join(getVaultPath(), 'Assets')
  fs.mkdirSync(assetsDir, { recursive: true })
  let target = path.join(assetsDir, filename)
  if (fs.existsSync(target)) {
    const inbox = path.join(getVaultPath(), 'Assets', '_inbox')
    fs.mkdirSync(inbox, { recursive: true })
    target = path.join(inbox, `${Date.now()}-${filename}`)
  }
  fs.writeFileSync(target, buffer)
  return path.relative(getVaultPath(), target)
}

// Turn a source (document text, or an image's vision description) into a proposed
// note. Robust to large/awkward sources: retries with progressively smaller slices
// so a big PDF yields a note instead of a 502, and returns a friendly 422 if the
// local model still can't structure it (rather than a raw "invalid JSON"). The
// retrieval context is computed once; only the source slice shrinks between tries.
const INGEST_NUM_CTX = 16384
const CLIP_STEPS = [MAX_CHARS, 5000, 2500]

async function ingestSource(
  filename: string,
  fullSourceText: string,
  assetPath: string | undefined,
  userNotes: string | undefined,
  tags: string[],
): Promise<NextResponse | IngestResult> {
  const retrievalQuery = `${userNotes ? userNotes + ' ' : ''}${fullSourceText}`.slice(0, 2000)
  const chunks = await retrieve(retrievalQuery, 6)

  for (const limit of CLIP_STEPS) {
    // Skip redundant smaller passes when the source is already short.
    if (limit !== MAX_CHARS && limit >= fullSourceText.length) continue
    const clipped = fullSourceText.slice(0, limit)
    const messages = buildIngestPrompt(filename, clipped, chunks, assetPath, userNotes, tags)

    let raw: string
    try {
      raw = await ollamaChat({ messages, format: 'json', numCtx: INGEST_NUM_CTX })
    } catch (err) {
      // Model/host error (not a parsing issue) — retrying smaller won't help.
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Ingest failed' }, { status: 502 })
    }

    const result = parseModelJson<IngestResult>(raw)
    if (result && Array.isArray(result.changes) && result.changes.length > 0) {
      // Guarantee the user's chosen tags land on the note (code-enforced).
      result.changes = applyTags(normalizeChanges(await reconcileUpdates(result.changes)), tags)
      return { ...result, origin: 'drop' }
    }
    // else: shrink the source and try again
  }

  return NextResponse.json(
    {
      error:
        'The local model couldn’t structure this document into a note. It may be very large or mostly ' +
        'non-text (e.g. a scanned PDF with little extractable text). Try a smaller or text-based source, ' +
        'or drop it and add a short note describing what it is.',
    },
    { status: 422 },
  )
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    const filename = file.name
    const ext = path.extname(filename).toLowerCase()
    const buffer = Buffer.from(await file.arrayBuffer())

    // Optional user-supplied notes to steer the summary (high priority).
    const notesField = form.get('notes')
    const userNotes = typeof notesField === 'string' ? notesField : undefined

    // Optional tags to stamp onto the resulting note (sent as a JSON array string).
    const tagsField = form.get('tags')
    let tags: string[] = []
    if (typeof tagsField === 'string' && tagsField.trim()) {
      try { const parsed = JSON.parse(tagsField); if (Array.isArray(parsed)) tags = parsed.map(String) } catch { /* ignore malformed */ }
    }

    // --- Image branch: save to Assets, then have a vision-capable model describe it ---
    if (IMAGE_EXTS.has(ext)) {
      const assetPath = saveImage(filename, buffer)
      const b64 = buffer.toString('base64')

      // Try the dedicated vision model first, then fall back to the chat model — so
      // a multimodal chat model (e.g. Gemma 3) reads the image directly and no
      // separate vision model needs to be installed. Dedupe + drop empties.
      const cfg = getConfig()
      const candidates = Array.from(new Set([cfg.visionModel, cfg.chatModel].filter(Boolean)))
      let description: string | null = null
      for (const model of candidates) {
        try {
          description = await ollamaVisionChat({
            prompt: 'Describe this image in detail and transcribe ALL visible text exactly. Be concise but complete.',
            imagesBase64: [b64],
            model,
          })
          break
        } catch { /* model missing or not multimodal — try the next candidate */ }
      }
      if (description === null) {
        // No installed model could read the image — keep the saved file, skip the note.
        return NextResponse.json({
          savedOnly: true,
          savedPath: assetPath,
          summary: `Saved ${assetPath} (no multimodal model available — set a vision-capable model, or use a multimodal chat model, in Settings).`,
        })
      }

      const sourceText = `Image file saved at ${assetPath}.\n\nVisual description and transcribed text:\n${description}`
      const out = await ingestSource(filename, sourceText, assetPath, userNotes, tags)
      return out instanceof NextResponse ? out : NextResponse.json(out)
    }

    // --- Text / PDF branch ---
    const text = await extractText(ext, buffer)
    if (text === null) {
      return NextResponse.json({ error: 'unsupported', detail: `Can't extract text from ${filename}` }, { status: 415 })
    }
    if (!text.trim()) {
      return NextResponse.json({ error: 'Document appears to be empty' }, { status: 400 })
    }

    const out = await ingestSource(filename, text, undefined, userNotes, tags)
    return out instanceof NextResponse ? out : NextResponse.json(out)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Ingest failed' },
      { status: 500 }
    )
  }
}
