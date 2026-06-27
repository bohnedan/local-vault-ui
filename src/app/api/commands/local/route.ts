import { NextRequest, NextResponse } from 'next/server'
import { retrieve } from '@/lib/embeddings'
import { buildCommandPrompt } from '@/lib/prompts'
import { ollamaChat } from '@/lib/ollama'
import { getLocalCommand } from '@/lib/commands'
import { normalizeChanges } from '@/lib/healthFix'
import { reconcileUpdates } from '@/lib/merge'
import { parseModelJson } from '@/lib/modelJson'

type CommandResult = {
  changes: Array<{ path: string; action: 'create' | 'update' | 'move' | 'delete'; content?: string; from?: string; to?: string }>
  log_entry: string
  summary: string
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { id: string; input: string }
    const command = getLocalCommand(body.id)
    if (!command) {
      return NextResponse.json({ error: `Unknown command: ${body.id}` }, { status: 404 })
    }
    if (!body.input?.trim()) {
      return NextResponse.json({ error: 'Missing input' }, { status: 400 })
    }

    const chunks = command.retrieveK > 0
      ? await retrieve(body.input, command.retrieveK)
      : []

    const messages = buildCommandPrompt(command, body.input, chunks)
    const raw = await ollamaChat({ messages, format: 'json', role: 'librarian' })

    const result = parseModelJson<CommandResult>(raw)
    if (!result) {
      return NextResponse.json({ error: 'Model did not return valid JSON', raw }, { status: 502 })
    }
    if (!Array.isArray(result.changes)) {
      return NextResponse.json({ error: 'Model response missing "changes" array', raw }, { status: 502 })
    }
    // Drop malformed changes (no path on a create/update) before normalizing.
    result.changes = result.changes.filter(c =>
      c && (((c.action === 'create' || c.action === 'update') && c.path && c.content !== undefined) ||
            (c.action === 'move' && c.from && c.to) ||
            (c.action === 'delete' && c.path)))

    result.changes = normalizeChanges(await reconcileUpdates(result.changes))
    return NextResponse.json({ ...result, origin: body.id })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Command failed' },
      { status: 500 }
    )
  }
}
