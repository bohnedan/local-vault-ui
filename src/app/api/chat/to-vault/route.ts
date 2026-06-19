import { NextRequest, NextResponse } from 'next/server'
import { retrieve } from '@/lib/embeddings'
import { buildIngestPrompt } from '@/lib/prompts'
import { ollamaChat } from '@/lib/ollama'
import { normalizeChanges } from '@/lib/healthFix'

// "Include conversation in the vault" — runs the current chat transcript through
// the SAME ingest pipeline a dropped document uses (retrieve context → draft a
// structured AI-first note → return a proposal for review). Nothing is written
// here; the client reviews the diff and applies it via /api/curate/apply.
export async function POST(req: NextRequest) {
  try {
    const { transcript, notes } = (await req.json()) as { transcript?: string; notes?: string }
    if (!transcript?.trim()) {
      return NextResponse.json({ error: 'Empty conversation' }, { status: 400 })
    }

    const filename = `Conversation ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.md`
    const clipped = transcript.slice(0, 12000)
    const retrievalQuery = `${notes ? notes + ' ' : ''}${clipped}`.slice(0, 2000)
    const chunks = await retrieve(retrievalQuery, 6)
    const messages = buildIngestPrompt(filename, clipped, chunks, undefined, notes)
    const raw = await ollamaChat({ messages, format: 'json' })

    let result: { changes?: unknown[]; log_entry?: string; summary?: string }
    try { result = JSON.parse(raw) } catch {
      return NextResponse.json({ error: 'Model did not return valid JSON', raw }, { status: 502 })
    }
    if (!Array.isArray(result.changes) || result.changes.length === 0) {
      return NextResponse.json({ error: 'Model proposed no note', raw }, { status: 502 })
    }
    result.changes = normalizeChanges(result.changes as Array<{ path: string; action: string; content?: string }>)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to capture conversation' },
      { status: 500 }
    )
  }
}
