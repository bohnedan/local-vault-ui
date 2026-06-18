import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { extractDocs, type ExtractedDoc } from '@/lib/extract'
import { retrieve } from '@/lib/embeddings'
import { buildIngestPrompt } from '@/lib/prompts'
import { ollamaChat } from '@/lib/ollama'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAX_CHARS = 12000
const MAX_DOCS = 25 // bound per request so one huge .enex can't run forever

type Change = { path: string; action: 'create' | 'update'; content: string }

// Bulk import: take a batch of uploaded source files (any supported format),
// extract their text locally, and have the local model draft a structured AI-first
// note for each — returned as ONE change-proposal for batch review. Nothing is
// written here; the client reviews the diffs and applies via /api/curate/apply.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const files = form.getAll('files').filter((f): f is File => typeof f !== 'string')
    if (files.length === 0) return NextResponse.json({ error: 'No files provided' }, { status: 400 })

    // Extract every file into one-or-more text docs (enex/csv expand).
    type Unit = { filename: string; title: string; text: string }
    const units: Unit[] = []
    const failed: string[] = []
    let truncated = false

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer())
      let docs: ExtractedDoc[]
      try { docs = await extractDocs(file.name, buffer) } catch { docs = [] }
      if (docs.length === 0) { failed.push(file.name); continue }
      for (const d of docs) {
        if (units.length >= MAX_DOCS) { truncated = true; break }
        if (d.text.trim()) units.push({ filename: file.name, title: d.title, text: d.text })
      }
      if (truncated) break
    }

    const changes: Change[] = []
    const usedPaths = new Set<string>()
    for (const unit of units) {
      const clipped = unit.text.slice(0, MAX_CHARS)
      const pseudoName = `${unit.title}${path.extname(unit.filename) || '.md'}`
      try {
        const chunks = await retrieve(clipped.slice(0, 2000), 5)
        const messages = buildIngestPrompt(pseudoName, clipped, chunks)
        const raw = await ollamaChat({ messages, format: 'json' })
        const parsed = JSON.parse(raw) as { changes?: Change[] }
        for (const c of parsed.changes ?? []) {
          if (!c?.path || c.content === undefined) continue
          // De-dupe target paths within the batch so notes don't clobber each other.
          let p = c.path
          if (usedPaths.has(p)) {
            const ext = path.extname(p)
            p = `${p.slice(0, -ext.length)} (${unit.title}).${ext.replace('.', '')}`
          }
          usedPaths.add(p)
          changes.push({ path: p, action: 'create', content: c.content })
        }
      } catch {
        failed.push(unit.filename)
      }
    }

    return NextResponse.json({
      changes,
      log_entry: `Bulk import — drafted ${changes.length} note(s) from ${units.length} document(s).`,
      summary: `Imported ${changes.length} note(s) from this batch` +
        (failed.length ? `; ${failed.length} file(s) couldn't be read` : '') +
        (truncated ? `; batch capped at ${MAX_DOCS} docs (more remain — run the next batch)` : '.'),
      processed: units.length,
      failed,
      truncated,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Import failed' },
      { status: 500 }
    )
  }
}
