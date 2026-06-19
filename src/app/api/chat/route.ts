import { NextRequest, NextResponse } from 'next/server'
import { retrieve, retrieveNotes, indexStats, syncIndex } from '@/lib/embeddings'
import { buildRagPrompt, buildCurationPrompt } from '@/lib/prompts'
import { normalizeChanges } from '@/lib/healthFix'
import { ollamaChat } from '@/lib/ollama'
import { getConfig } from '@/lib/config'
import { appendToSession, getSession } from '@/lib/chatHistory'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { question: string; mode?: 'ask' | 'edit'; sessionId?: string }
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

    // Prior turns from THIS session only — context never bleeds across conversations.
    const history = body.sessionId ? (getSession(body.sessionId)?.messages ?? []) : []
    const priorUserTurns = history.filter(m => m.role === 'user').slice(-2).map(m => m.content)

    // Expand the retrieval query with recent user turns so pronouns/topics in a
    // follow-up still fetch the right notes (the embedding of "his role?" alone
    // retrieves nothing useful).
    const retrievalQuery = [...priorUserTurns, body.question].join('\n')

    // EDIT MODE — turn the instruction into a reviewable change-proposal (create /
    // update / move / delete), using the same curation pipeline as the Curate page,
    // with the chat history so "save what we just discussed" resolves. Nothing is
    // written here; the client reviews the diffs and applies via /api/curate/apply.
    // Uses light chunk-level context (not full notes) — a small model produces clean
    // JSON only with a bounded prompt; full-note context overflows it.
    if (body.mode === 'edit') {
      const editChunks = await retrieve(retrievalQuery, 6)
      const editCitations = Array.from(
        new Map(editChunks.map(c => [c.notePath, { path: c.notePath, heading: c.heading }])).values()
      )
      const messages = buildCurationPrompt(body.question, editChunks, history)
      const raw = await ollamaChat({ messages, format: 'json' })
      let result: { changes?: unknown[]; log_entry?: string; summary?: string }
      try { result = JSON.parse(raw) } catch {
        return NextResponse.json({ error: 'Model did not return valid JSON', raw }, { status: 502 })
      }
      if (!Array.isArray(result.changes) || result.changes.length === 0) {
        return NextResponse.json({ error: 'The model proposed no changes — try rephrasing the edit.', raw }, { status: 502 })
      }
      // Conform the proposed notes to the vault structure so the edit can't spawn
      // new frontmatter/preamble health issues.
      result.changes = normalizeChanges(result.changes as Array<{ path: string; action: string; content?: string; from?: string; to?: string }>)
      const sid = appendToSession(body.sessionId, [
        { role: 'user', content: body.question },
        { role: 'assistant', content: `Proposed ${result.changes.length} change(s): ${result.summary ?? ''}`.trim() },
      ])
      return NextResponse.json({ mode: 'edit', changes: result.changes, log_entry: result.log_entry, summary: result.summary, citations: editCitations, sessionId: sid })
    }

    // ASK MODE — grounded answer over full-note hybrid retrieval.
    const chunks = await retrieveNotes(retrievalQuery, { topNotes: 7, perNoteChars: 6000 })
    const citations = Array.from(
      new Map(chunks.map(c => [c.notePath, { path: c.notePath, heading: c.heading }])).values()
    )
    const messages = buildRagPrompt(body.question, chunks, history)
    const answer = await ollamaChat({ messages })

    // Persist the exchange to this session (created if new).
    const sid = appendToSession(body.sessionId, [
      { role: 'user', content: body.question },
      { role: 'assistant', content: answer, citations },
    ])

    return NextResponse.json({ answer, citations, sessionId: sid })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Chat failed' },
      { status: 500 }
    )
  }
}
