import fs from 'fs'
import { syncIndex, indexStats, retrieve } from '@/lib/embeddings'
import { scanVaultHealth, type HealthReport } from '@/lib/health'
import { buildHealthFixChanges } from '@/lib/healthFix'
import { appendToLog, listAllNotes, resolveVaultPath } from '@/lib/vault'
import { buildCurationPrompt } from '@/lib/prompts'
import { ollamaChat } from '@/lib/ollama'
import { savePending } from '@/lib/pending'

// Shared caretaking routine, run both on-demand and by the in-app scheduler.
// Fully local. Two tiers, matching the user's chosen "auto-apply safe steps only":
//   - SAFE, auto-applied: index sync + deterministic health fixes (add missing
//     frontmatter / "For future Claude" preamble, body preserved verbatim).
//   - RISKY, queued for review: a model-generated curation proposal over the notes
//     that changed in the last day — saved to the pending queue, never written
//     unattended. The user approves it (as diffs) in the morning.

export type CaretakeResult = {
  mode: 'sync' | 'full'
  sync: { notes: number; chunks: number; skipped: number }
  health: HealthReport | null
  fixesApplied: number
  proposalsQueued: number
  ranAt: string
}

const DAY_MS = 24 * 60 * 60 * 1000

export async function runCaretake(mode: 'sync' | 'full'): Promise<CaretakeResult> {
  const sync = await syncIndex()

  let health: HealthReport | null = null
  let fixesApplied = 0
  let proposalsQueued = 0

  if (mode === 'full') {
    health = scanVaultHealth()

    // 1) SAFE — auto-apply deterministic structural fixes (content-preserving).
    fixesApplied = applyDeterministicHealthFixes()
    if (fixesApplied > 0) await syncIndex()

    // 2) RISKY — generate a curation proposal over recently-changed notes and
    //    QUEUE it for morning review. Best-effort: a model hiccup must not break
    //    the safe steps above.
    try {
      proposalsQueued = await queueNightlyCuration()
    } catch { /* model unavailable / bad JSON — skip, try again tomorrow */ }

    const stats = indexStats()
    const issueLine = Object.entries(health.counts)
      .filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'no issues'

    appendToLog(
      `Nightly caretake\n\n` +
        `- Index: ${stats.notes} notes, ${stats.chunks} chunks (${sync.notes} re-embedded${sync.skipped.length ? `, ${sync.skipped.length} skipped` : ''})\n` +
        `- Health: scanned ${health.scanned} notes — ${issueLine}\n` +
        `- Auto-applied ${fixesApplied} structural fix(es) (frontmatter / preamble)\n` +
        `- Queued ${proposalsQueued} curation proposal(s) for your review`
    )
  }

  return {
    mode,
    sync: { notes: sync.notes, chunks: indexStats().chunks, skipped: sync.skipped.length },
    health,
    fixesApplied,
    proposalsQueued,
    ranAt: new Date().toISOString(),
  }
}

// Apply every deterministic structural fix in the vault, writing directly (these
// only ADD frontmatter/preamble and preserve the body). Returns the count written.
function applyDeterministicHealthFixes(): number {
  const { changes } = buildHealthFixChanges()
  let applied = 0
  for (const change of changes) {
    try {
      fs.writeFileSync(resolveVaultPath(change.path), change.content, 'utf-8')
      applied++
    } catch { /* skip a note we can't write */ }
  }
  if (applied > 0) {
    appendToLog(`Auto-fixed structure on ${applied} note(s): ${changes.slice(0, applied).map(c => c.path).join(', ')}`)
  }
  return applied
}

// Ask the local model to propose how to integrate/organize the notes that changed
// in the last day. Saves the proposal to the pending queue (does NOT write to the
// vault). Returns 1 if a proposal was queued, else 0.
async function queueNightlyCuration(): Promise<number> {
  const cutoff = Date.now() - DAY_MS
  const recent = listAllNotes()
    .filter(n => n.mtime.getTime() >= cutoff)
    .map(n => n.path)
  if (recent.length === 0) return 0

  const userText =
    `These notes changed in the last 24 hours:\n${recent.map(p => `- ${p}`).join('\n')}\n\n` +
    `As the vault's caretaker, propose high-confidence changes to integrate and organize them: ` +
    `add missing [[wikilinks]] between clearly-related notes, file stray notes into the right folder ` +
    `(via "move"), merge obvious duplicates, and—only if a cluster clearly warrants it—synthesize a ` +
    `permanent Knowledge/ note. Be conservative: propose nothing if there's nothing clearly worth doing.`

  const chunks = await retrieve(recent.join(' '), 12)
  const messages = buildCurationPrompt(userText, chunks)
  const raw = await ollamaChat({ messages, format: 'json' })

  let result: { changes?: unknown[]; log_entry?: string; summary?: string }
  try { result = JSON.parse(raw) } catch { return 0 }
  if (!Array.isArray(result.changes) || result.changes.length === 0) return 0

  savePending({
    origin: 'nightly-curation',
    summary: result.summary || `Overnight curation over ${recent.length} recently-changed note(s)`,
    log_entry: result.log_entry || 'Overnight curation proposal.',
    changes: result.changes,
  })
  return 1
}
