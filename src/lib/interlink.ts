import fs from 'fs'
import path from 'path'
import { listAllNotes, resolveVaultPath } from '@/lib/vault'

// Graph builder. Two deterministic, fully-local passes that grow the vault's
// interconnection (the Obsidian "mesh"):
//   1. Add [[wikilinks]] for unlinked plain-text mentions of EXISTING notes.
//   2. Create stub notes for broken-link targets, so dangling [[X]] resolve.
// Both are returned as the standard change-proposal contract and reviewed as diffs
// before anything is written (uncheck anything you don't want).

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/
// Titles too generic to safely auto-link.
const STOPLIST = new Set([
  'note', 'notes', 'todo', 'todos', 'task', 'tasks', 'index', 'home', 'log', 'logs',
  'daily', 'inbox', 'readme', 'draft', 'idea', 'ideas', 'meeting', 'meetings', 'recap',
])

type Note = { path: string; title: string; content: string }

function stripFrontmatter(s: string): string {
  return s.replace(FRONTMATTER_RE, '')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A title is a good auto-link candidate if it's distinctive enough.
function isLinkable(title: string): boolean {
  const t = title.trim()
  if (t.length < 4) return false
  if (STOPLIST.has(t.toLowerCase())) return false
  if (/^\d/.test(t)) return false             // dates, numbered notes
  if (/^[\d\W]+$/.test(t)) return false       // no letters
  return true
}

// Add links to a note body. Operates line-by-line, never touches fenced code,
// inline code, existing [[wikilinks]], image embeds, or markdown links. Links the
// FIRST plain-text mention of each candidate, capped per note to avoid noise.
function addLinks(body: string, candidates: Array<{ key: string; display: string }>, maxPerNote = 8): { body: string; added: number } {
  const lines = body.split('\n')
  let inFence = false
  let added = 0
  const linkedThisNote = new Set<string>()

  // Longest titles first so "Agentic Collab" wins over "Collab".
  const ordered = [...candidates].sort((a, b) => b.display.length - a.display.length)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence || added >= maxPerNote) continue

    // Split out protected spans so we only edit plain text.
    const parts = line.split(/(!?\[\[[^\]]*\]\]|`[^`]*`|\[[^\]]*\]\([^)]*\))/g)
    for (let p = 0; p < parts.length; p++) {
      if (added >= maxPerNote) break
      const seg = parts[p]
      if (!seg || /^!?\[\[|^`|^\[[^\]]*\]\(/.test(seg)) continue // protected span
      let edited = seg
      for (const cand of ordered) {
        if (added >= maxPerNote) break
        if (linkedThisNote.has(cand.key)) continue
        const re = new RegExp(`\\b(${escapeRe(cand.display)})\\b`, 'i')
        const m = re.exec(edited)
        if (!m) continue
        const matched = m[1]
        const link = matched === cand.display ? `[[${cand.display}]]` : `[[${cand.display}|${matched}]]`
        edited = edited.slice(0, m.index) + link + edited.slice(m.index + matched.length)
        linkedThisNote.add(cand.key)
        added++
      }
      parts[p] = edited
    }
    lines[i] = parts.join('')
  }

  return { body: lines.join('\n'), added }
}

function inferStubFolder(title: string): string {
  return /^[A-ZÄÖÜ][\wäöü]+ [A-ZÄÖÜ][\wäöü]+$/.test(title.trim()) ? 'People' : 'Knowledge'
}

function stubNote(title: string, today: string): string {
  return [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    'type: stub',
    `created: ${today}`,
    `updated: ${today}`,
    'tags: [stub]',
    'confidence: low',
    '---',
    '',
    '## For future Claude',
    '',
    `Stub created to resolve links pointing to [[${title}]]. Flesh this out when you know more.`,
    '',
  ].join('\n')
}

export type InterlinkChange =
  | { path: string; action: 'update'; content: string }
  | { path: string; action: 'create'; content: string }

export function buildInterlinkChanges(opts: { limit?: number; createStubs?: boolean } = {}): {
  changes: InterlinkChange[]
  linksAdded: number
  stubsProposed: number
  scanned: number
} {
  const limit = opts.limit ?? 30
  const createStubs = opts.createStubs ?? true
  const today = new Date().toISOString().slice(0, 10)

  const notes: Note[] = []
  for (const n of listAllNotes()) {
    try {
      notes.push({ path: n.path, title: path.basename(n.path).replace(/\.md$/, ''), content: fs.readFileSync(resolveVaultPath(n.path), 'utf-8') })
    } catch { /* skip unreadable */ }
  }

  // Index of existing notes (lowercased basename -> canonical display).
  const titleByKey = new Map<string, string>()
  for (const n of notes) {
    const key = n.title.toLowerCase()
    if (isLinkable(n.title) && !titleByKey.has(key)) titleByKey.set(key, n.title)
  }

  const changes: InterlinkChange[] = []
  let linksAdded = 0

  // PASS 1 — add links for unlinked mentions of OTHER existing notes.
  for (const note of notes) {
    if (changes.length >= limit) break
    if (note.title.toLowerCase() === '_claude') continue
    const candidates = Array.from(titleByKey.entries())
      .filter(([key]) => key !== note.title.toLowerCase())
      .map(([key, display]) => ({ key, display }))

    const fm = FRONTMATTER_RE.exec(note.content)?.[0] ?? ''
    const body = stripFrontmatter(note.content)
    const { body: linked, added } = addLinks(body, candidates)
    if (added > 0) {
      linksAdded += added
      changes.push({ path: note.path, action: 'update', content: fm + linked })
    }
  }

  // PASS 2 — create stub notes for broken-link targets (so dangling links resolve).
  const stubs = createStubs ? buildBrokenLinkStubs(today) : []
  changes.push(...stubs)

  return { changes, linksAdded, stubsProposed: stubs.length, scanned: notes.length }
}

// Stub notes for every genuinely-broken [[link]] target in the vault, so dangling
// links resolve. Shared by Interlink and by Health auto-fix (so broken links can be
// fixed from either place). Skips links inside code, the _CLAUDE.md doc, and
// non-distinctive targets.
export function buildBrokenLinkStubs(today = new Date().toISOString().slice(0, 10)): InterlinkChange[] {
  const notes = listAllNotes().map(n => {
    try { return { path: n.path, title: path.basename(n.path).replace(/\.md$/, ''), content: fs.readFileSync(resolveVaultPath(n.path), 'utf-8') } }
    catch { return null }
  }).filter((n): n is Note => !!n)

  const knownKeys = new Set(notes.map(n => n.title.toLowerCase()))
  const knownRel = new Set(notes.map(n => n.path.replace(/\.md$/, '').toLowerCase()))
  const brokenTargets = new Map<string, string>() // key -> display
  for (const note of notes) {
    if (note.title.toLowerCase() === '_claude') continue
    const scan = note.content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
    for (const m of Array.from(scan.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g))) {
      const target = m[1].trim()
      const key = target.toLowerCase()
      const base = key.split('/').pop() ?? key
      if (knownKeys.has(base) || knownRel.has(key)) continue // resolves already
      if (!isLinkable(target.split('/').pop() ?? target)) continue
      if (!brokenTargets.has(base)) brokenTargets.set(base, target.split('/').pop() ?? target)
    }
  }

  return Array.from(brokenTargets.values()).map(display => ({
    path: `${inferStubFolder(display)}/${display}.md`,
    action: 'create' as const,
    content: stubNote(display, today),
  }))
}
