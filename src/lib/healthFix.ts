import fs from 'fs'
import path from 'path'
import { scanVaultHealth, type HealthIssue } from '@/lib/health'
import { resolveVaultPath } from '@/lib/vault'
import { buildBrokenLinkStubs } from '@/lib/interlink'

// Deterministic, fully-local repair of STRUCTURAL health issues. No model — so it
// always produces a correct, predictable fix (unlike a small chat model, which
// often returns a non-fix). It only ADDS what's missing; the original body is
// preserved byte-for-byte. Handles the two bulk issues:
//   - missing-frontmatter → prepend a YAML block (title/type/dates/tags/confidence)
//   - missing-preamble    → insert a "## For future Claude" section, summarised
//                           from the note's own first paragraph
// Broken wikilinks and empty notes are left untouched (they need human judgment).

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

function stripFrontmatter(s: string): string {
  return s.replace(FRONTMATTER_RE, '')
}

// Infer a note `type` from its folder path (matches anywhere in the path so
// "CLAUDE_projects/" and "Projects/" both map to "project").
function inferType(notePath: string): string {
  const dir = notePath.slice(0, notePath.lastIndexOf('/')).toLowerCase()
  if (dir.includes('project')) return 'project'
  if (dir.includes('people') || dir.includes('person')) return 'person'
  if (dir.includes('meeting')) return 'meeting'
  if (dir.includes('daily')) return 'daily'
  if (dir.includes('log')) return 'log'
  if (dir.includes('board')) return 'board'
  if (dir.includes('knowledge')) return 'knowledge'
  return 'note'
}

// First meaningful sentence(s) of the body, for a non-hollow preamble.
function deriveSummary(body: string, title: string): string {
  const firstPara = body
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .find(p => p && !p.startsWith('#') && !p.startsWith('---'))
  if (!firstPara) return `This note captures ${title}.`
  const clean = firstPara.replace(/[*_`>#[\]]/g, '').replace(/\s+/g, ' ').trim()
  const cut = clean.slice(0, 240)
  return cut.length < clean.length ? `${cut.replace(/\s+\S*$/, '')}…` : cut
}

function buildFrontmatter(notePath: string, title: string, today: string): string {
  return [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `type: ${inferType(notePath)}`,
    `created: ${today}`,
    `updated: ${today}`,
    'tags: []',
    'confidence: medium',
    '---',
  ].join('\n')
}

// Returns the corrected content, or null if there's nothing this deterministic
// fixer can safely change for the given issue kinds.
export function deterministicFix(
  notePath: string,
  content: string,
  kinds: Set<HealthIssue['kind']>,
  today = new Date().toISOString().slice(0, 10)
): string | null {
  const title = path.basename(notePath).replace(/\.md$/, '')
  const fmMatch = FRONTMATTER_RE.exec(content)
  const body = stripFrontmatter(content).trim()

  const needFrontmatter = kinds.has('missing-frontmatter') && !fmMatch
  const needPreamble = kinds.has('missing-preamble') && !/for future claude/i.test(body)
  if (!needFrontmatter && !needPreamble) return null

  const frontmatter = fmMatch ? fmMatch[0].replace(/\r?\n?$/, '') : buildFrontmatter(notePath, title, today)
  const preamble = needPreamble ? `## For future Claude\n\n${deriveSummary(body, title)}\n` : ''

  const parts = [frontmatter, preamble, body].filter(Boolean)
  return parts.join('\n\n').trimEnd() + '\n'
}

// Guarantee a note has the AI-first structure (frontmatter + "For future Claude"
// preamble), preserving the body. Used to NORMALIZE model-generated notes before
// they're proposed, so chat/curate/ingest edits can't introduce fresh health
// issues — the self-inflicting loop where editing the vault created new problems.
export function ensureStructure(notePath: string, content: string, today?: string): string {
  const kinds = new Set<HealthIssue['kind']>(['missing-frontmatter', 'missing-preamble'])
  const fixed = deterministicFix(notePath, content, kinds, today)
  return fixed ?? content
}

// Normalize the create/update notes in a change-proposal (move/delete untouched).
export function normalizeChanges<T extends { path: string; action: string; content?: string; from?: string; to?: string }>(changes: T[]): T[] {
  return changes.map(c =>
    (c.action === 'create' || c.action === 'update') && typeof c.content === 'string'
      ? { ...c, content: ensureStructure(c.to ?? c.path, c.content) }
      : c
  )
}

const DETERMINISTIC: HealthIssue['kind'][] = ['missing-frontmatter', 'missing-preamble']

export type HealthFixChange = { path: string; action: 'update' | 'create'; content: string }

// Scan the vault and build deterministic structural fixes (up to `limit` notes).
// Shared by the manual "Auto-fix structure" route and the nightly caretake run.
// When `includeBrokenLinks` is set (manual fix only — NOT the unattended nightly
// run), also append stub notes that resolve dangling [[links]], so broken-link
// health issues are fixable from the Health panel too, not only via Interlink.
export function buildHealthFixChanges(
  limit = Number.POSITIVE_INFINITY,
  opts: { includeBrokenLinks?: boolean } = {},
): {
  changes: HealthFixChange[]
  fixableTotal: number
  remaining: number
  otherIssues: number
  stubs: number
} {
  const report = scanVaultHealth()

  const byNote = new Map<string, Set<HealthIssue['kind']>>()
  for (const issue of report.issues) {
    if (!DETERMINISTIC.includes(issue.kind)) continue
    const set = byNote.get(issue.path) ?? new Set<HealthIssue['kind']>()
    set.add(issue.kind)
    byNote.set(issue.path, set)
  }

  const allFiles = Array.from(byNote.keys())
  const batch = allFiles.slice(0, limit)

  const changes: HealthFixChange[] = []
  for (const notePath of batch) {
    let content: string
    try { content = fs.readFileSync(resolveVaultPath(notePath), 'utf-8') } catch { continue }
    const fixed = deterministicFix(notePath, content, byNote.get(notePath)!)
    if (fixed && fixed !== content) changes.push({ path: notePath, action: 'update', content: fixed })
  }

  // Broken-link stubs (manual fix only) — so dangling [[links]] resolve.
  let stubs = 0
  if (opts.includeBrokenLinks) {
    const stubChanges = buildBrokenLinkStubs()
    changes.push(...stubChanges)
    stubs = stubChanges.length
  }

  return {
    changes,
    fixableTotal: allFiles.length,
    remaining: Math.max(0, allFiles.length - batch.length),
    otherIssues: report.issues.filter(i => !DETERMINISTIC.includes(i.kind)).length,
    stubs,
  }
}
