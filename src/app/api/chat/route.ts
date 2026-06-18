import { NextRequest, NextResponse } from 'next/server'
import { retrieveNotes, indexStats, syncIndex } from '@/lib/embeddings'
import { buildRagPrompt } from '@/lib/prompts'
import { ollamaChat } from '@/lib/ollama'
import { getConfig } from '@/lib/config'
import { appendMessages } from '@/lib/chatHistory'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { question: string }
    if (!body.question?.trim()) {
      return NextResponse.json({ error: 'Missing question' }, { status: 400 })
    }

    // Keep the index fresh so newly added/edited notes are answerable without a
    // manual "Sync Index". Incremental: only re-embeds changed notes (fast when
    // nothing changed). If the embed model is down, fall back to the existing index.
    let stats = indexStats()
    if (stats.chunks > 0) {
      try { await syncIndex() } catch { /* embed model unavailable — use existing index */ }
      stats = indexStats()
    }

    // Empty index = nothing to search. This is the usual cause of "I don't know"
    // about something that IS in the notes: the index was never built (often
    // because the embedding model wasn't installed). Say so explicitly.
    if (stats.chunks === 0) {
      return NextResponse.json({
        answer:
          `I don't have any of your notes indexed on this machine yet, so I can't search them.\n\n` +
          `**To fix it:** make sure the embedding model \`${getConfig().embedModel}\` is installed ` +
          `(Settings → Embedding model → Pull), then click **Sync Index** in the top bar (or **Build index** ` +
          `in Settings). Ask again once it finishes. The index is per-machine and isn't shared via git.`,
        citations: [],
        indexEmpty: true,
      })
    }

    // Note-level retrieval with full-note context (not just the matching fragment).
    const chunks = await retrieveNotes(body.question, { topNotes: 6, perNoteChars: 6000 })
    const messages = buildRagPrompt(body.question, chunks)
    const answer = await ollamaChat({ messages })

    const citations = Array.from(
      new Map(chunks.map(c => [c.notePath, { path: c.notePath, heading: c.heading }])).values()
    )

    // Persist the exchange to the lightweight (7-day) history.
    appendMessages(
      { role: 'user', content: body.question },
      { role: 'assistant', content: answer, citations },
    )

    return NextResponse.json({ answer, citations })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Chat failed' },
      { status: 500 }
    )
  }
}
