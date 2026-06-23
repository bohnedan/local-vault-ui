import fs from 'fs'
import { resolveVaultPath } from '@/lib/vault'
import { ollamaChat } from '@/lib/ollama'

// Re-anchor proposed UPDATES on the real, full current note so the model merges
// into existing knowledge instead of rewriting the whole file from the partial
// fragments it saw during retrieval. The first pass (curate/ingest/command) decides
// WHICH notes to touch and drafts content from limited context; here we take each
// update to a file that already exists, load its FULL content as the authoritative
// base, and ask the model to integrate the proposed content into it — preserving
// everything that still holds, adding what's new, and changing only what's
// contradicted. The result is reviewed as a diff, so the user sees a focused
// add/update rather than a wholesale replacement.

type Change = { path: string; action: string; content?: string; from?: string; to?: string }

const MERGE_SYSTEM = `You are merging new information into an EXISTING Obsidian note, fully locally. You are given the
note's CURRENT full content (the authoritative base) and PROPOSED content drafted from new input. Produce
ONE merged note.

Rules:
- PRESERVE every existing detail that still holds — keep it essentially verbatim, including the YAML
  frontmatter, the "## For future Claude" preamble, all sections, lists, and [[wikilinks]]. Never drop or
  water down content the new input doesn't actually touch.
- ADD genuinely new facts into the most relevant existing section (or a new section if none fits).
- UPDATE only the specific statements the new input changes or contradicts. Correct them in place; when a
  fact is superseded, fix it and keep the surrounding context. Do not delete unrelated information.
- Do NOT invent anything. Use only the current note and the proposed content.
- Keep the AI-first structure: frontmatter first, then "## For future Claude", then body. If frontmatter
  has an "updated:" field, set it to {{TODAY}}.
- Output the COMPLETE merged note as raw Markdown ONLY — no code fences, no commentary.`

function stripFences(s: string): string {
  const m = /^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i.exec(s.trim())
  return (m ? m[1] : s).trim()
}

async function mergeNote(notePath: string, current: string, proposed: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10)
  const messages = [
    { role: 'system' as const, content: MERGE_SYSTEM.replace('{{TODAY}}', today) },
    {
      role: 'user' as const,
      content:
        `CURRENT NOTE — ${notePath} (authoritative base, preserve what still holds):\n\n${current}\n\n` +
        `--- PROPOSED CONTENT to integrate (new input drafted this) ---\n\n${proposed}\n\n` +
        `Return the merged note as raw Markdown only.`,
    },
  ]
  // Generous context so a long note + its update both fit without truncation.
  const raw = await ollamaChat({ messages, numCtx: 16384 })
  return stripFences(raw)
}

// For each proposed create/update whose target file ALREADY EXISTS on disk, merge
// the proposal into the current file instead of replacing it. Creates of new files
// and moves/deletes pass through untouched. Best-effort: if a merge fails or looks
// lossy, fall back to the originally-proposed content (no worse than before).
export async function reconcileUpdates<T extends Change>(changes: T[]): Promise<T[]> {
  const out: T[] = []
  for (const c of changes) {
    const target = c.to ?? c.path
    const isWrite = (c.action === 'create' || c.action === 'update') && typeof c.content === 'string' && !!target
    if (!isWrite) { out.push(c); continue }

    let current: string | null = null
    try { current = fs.readFileSync(resolveVaultPath(target!), 'utf-8') } catch { current = null }

    // New file, or no real change to merge into — keep as proposed.
    if (!current || !current.trim() || current.trim() === c.content!.trim()) { out.push(c); continue }

    try {
      const merged = await mergeNote(target!, current, c.content!)
      // Guard against a merge that collapsed the note — never accept an empty/near-empty
      // result; fall back to the proposed content in that case.
      if (merged && merged.length >= Math.min(current.length, c.content!.length) * 0.5) {
        out.push({ ...c, action: 'update', content: merged })
        continue
      }
    } catch { /* fall through to proposed content */ }
    out.push(c)
  }
  return out
}
