import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { retrieve } from '@/lib/embeddings'
import { buildIngestPrompt } from '@/lib/prompts'
import { ollamaChat, ollamaVisionChat } from '@/lib/ollama'
import { getVaultPath } from '@/lib/vault'
import { normalizeChanges } from '@/lib/healthFix'

export const dynamic = 'force-dynamic'

const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.text'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_CHARS = 12000 // keep within the model's context

type IngestResult = {
  changes: Array<{ path: string; action: 'create' | 'update'; content: string }>
  log_entry: string
  summary: string
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

function buildProposal(raw: string): NextResponse | IngestResult {
  let result: IngestResult
  try {
    result = JSON.parse(raw) as IngestResult
  } catch {
    return NextResponse.json({ error: 'Model did not return valid JSON', raw }, { status: 502 })
  }
  if (!Array.isArray(result.changes) || result.changes.length === 0) {
    return NextResponse.json({ error: 'Model proposed no note', raw }, { status: 502 })
  }
  result.changes = normalizeChanges(result.changes)
  return result
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

    // --- Image branch: save to Assets, then have the vision model describe it ---
    if (IMAGE_EXTS.has(ext)) {
      const assetPath = saveImage(filename, buffer)
      let description: string
      try {
        description = await ollamaVisionChat({
          prompt: 'Describe this image in detail and transcribe ALL visible text exactly. Be concise but complete.',
          imagesBase64: [buffer.toString('base64')],
        })
      } catch {
        // Vision model unavailable — keep the saved image, skip the AI note.
        return NextResponse.json({
          savedOnly: true,
          savedPath: assetPath,
          summary: `Saved ${assetPath} (vision model unavailable — install it in Settings to auto-summarize images).`,
        })
      }

      const sourceText = `Image file saved at ${assetPath}.\n\nVisual description and transcribed text:\n${description}`
      // Bias retrieval toward the user's notes too, so related vault notes surface.
      const retrievalQuery = `${userNotes ? userNotes + ' ' : ''}${description}`.slice(0, 2000)
      const chunks = await retrieve(retrievalQuery, 6)
      const messages = buildIngestPrompt(filename, sourceText, chunks, assetPath, userNotes)
      const raw = await ollamaChat({ messages, format: 'json' })
      const out = buildProposal(raw)
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

    const clipped = text.slice(0, MAX_CHARS)
    const retrievalQuery = `${userNotes ? userNotes + ' ' : ''}${clipped}`.slice(0, 2000)
    const chunks = await retrieve(retrievalQuery, 6)
    const messages = buildIngestPrompt(filename, clipped, chunks, undefined, userNotes)
    const raw = await ollamaChat({ messages, format: 'json' })
    const out = buildProposal(raw)
    return out instanceof NextResponse ? out : NextResponse.json(out)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Ingest failed' },
      { status: 500 }
    )
  }
}
