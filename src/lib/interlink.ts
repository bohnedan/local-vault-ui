import fs from 'fs'
import path from 'path'
import { listAllNotes, resolveVaultPath, isMetaNote } from '@/lib/vault'

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
export function isLinkable(title: string): boolean {
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

// THE canonical "broken link" definition, shared by the health scan (which counts
// them) and the stub builder (which resolves them). Returns the distinct broken-link
// target basenames in `content` — links pointing at no existing note. `known` is a
// lowercased set containing every note's relative path AND its basename (without
// .md). A target is only counted when it's STUBBABLE (passes isLinkable): dates,
// stoplist words and too-short targets are skipped, because they're either
// intentional (daily-note links Obsidian creates on click) or too generic to stub
// safely. Keeping detector and fixer on this one predicate is what stops the
// fix→reflag loop — what Health flags is exactly what Auto-fix can resolve.
export function brokenLinkTargets(content: string, known: Set<string>): string[] {
  const scan = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of Array.from(scan.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g))) {
    const target = m[1].trim()
    const key = target.toLowerCase()
    const base = key.split('/').pop() ?? key
    if (known.has(key) || known.has(base)) continue // resolves already
    if (!isLinkable(base)) continue                 // not a safely-stubbable target
    if (seen.has(base)) continue
    seen.add(base)
    out.push(target.split('/').pop() ?? target) // display (original case, basename)
  }
  return out
}

// Lowercased set of every note's relative path AND basename (without .md), used to
// decide whether a [[link]] resolves. Built once and shared by the link passes.
export function buildKnownSet(notes: Array<{ path: string }>): Set<string> {
  const known = new Set<string>()
  for (const n of notes) {
    const rel = n.path.replace(/\.md$/, '')
    known.add(rel.toLowerCase())
    known.add(path.basename(rel).toLowerCase())
  }
  return known
}

// Stub notes for every genuinely-broken [[link]] target in the vault, so dangling
// links resolve. Shared by Interlink and by Health auto-fix (so broken links can be
// fixed from either place). Uses brokenLinkTargets and skips meta/log notes — the
// SAME exclusions the health scan applies — so the fixer never invents stubs for
// throwaway links that live only in operational logs.
export function buildBrokenLinkStubs(today = new Date().toISOString().slice(0, 10)): InterlinkChange[] {
  const notes = listAllNotes().map(n => {
    try { return { path: n.path, title: path.basename(n.path).replace(/\.md$/, ''), content: fs.readFileSync(resolveVaultPath(n.path), 'utf-8') } }
    catch { return null }
  }).filter((n): n is Note => !!n)

  const known = buildKnownSet(notes)
  const brokenTargets = new Map<string, string>() // lowercased basename -> display
  for (const note of notes) {
    if (isMetaNote(note.path)) continue
    for (const display of brokenLinkTargets(note.content, known)) {
      const key = display.toLowerCase()
      if (!brokenTargets.has(key)) brokenTargets.set(key, display)
    }
  }

  return Array.from(brokenTargets.values()).map(display => ({
    path: `${inferStubFolder(display)}/${display}.md`,
    action: 'create' as const,
    content: stubNote(display, today),
  }))
}
