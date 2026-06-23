import { NextRequest, NextResponse } from 'next/server'
import { retrieve } from '@/lib/embeddings'
import { buildCurationPrompt } from '@/lib/prompts'
import { ollamaChat } from '@/lib/ollama'
import { normalizeChanges } from '@/lib/healthFix'
import { reconcileUpdates } from '@/lib/merge'
import { parseModelJson } from '@/lib/modelJson'

type CurationResult = {
  changes: Array<{ path: string; action: 'create' | 'update' | 'move' | 'delete'; content?: string; from?: string; to?: string }>
  log_entry: string
  summary: string
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { text: string }
    if (!body.text?.trim()) {
      return NextResponse.json({ error: 'Missing text' }, { status: 400 })
    }

    const chunks = await retrieve(body.text, 8)
    const messages = buildCurationPrompt(body.text, chunks)
    const raw = await ollamaChat({ messages, format: 'json' })

    const result = parseModelJson<CurationResult>(raw)
    if (!result) {
      return NextResponse.json(
        { error: 'Model did not return valid JSON', raw },
        { status: 502 }
      )
    }

    if (!Array.isArray(result.changes)) {
      return NextResponse.json(
        { error: 'Model response missing "changes" array', raw },
        { status: 502 }
      )
    }

    result.changes = normalizeChanges(await reconcileUpdates(result.changes))
    return NextResponse.json({ ...result, origin: 'add' })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Curate failed' },
      { status: 500 }
    )
  }
}
