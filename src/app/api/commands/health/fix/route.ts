import { NextRequest, NextResponse } from 'next/server'
import { buildHealthFixChanges } from '@/lib/healthFix'

// Repair vault-health issues deterministically (no model, fully local, always a
// correct fix). Adds missing frontmatter + "For future Claude" preamble while
// preserving the note body verbatim, AND creates stub notes so dangling [[links]]
// resolve (broken links are fixable here, not only via Interlink). Empty notes need
// human judgment and are left alone. Output is the standard change-proposal
// contract, so fixes flow through the review/diff/approve UI before anything writes.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { limit?: number }
    const limit = Math.min(50, Math.max(1, body.limit ?? 25))

    const { changes, remaining, otherIssues, stubs } = buildHealthFixChanges(limit, { includeBrokenLinks: true })

    const structural = changes.length - stubs
    const parts: string[] = []
    if (structural > 0) parts.push(`structural fixes for ${structural} note(s)`)
    if (stubs > 0) parts.push(`${stubs} stub note(s) to resolve broken links`)

    return NextResponse.json({
      changes,
      log_entry: `Vault health auto-fix — ${parts.join(' + ') || 'no changes'} (frontmatter / preamble added, body preserved; stubs created for dangling links).`,
      summary:
        (parts.length ? `Proposed ${parts.join(' and ')}.` : 'Nothing to auto-fix.') +
        (remaining > 0 ? ` ${remaining} more structurally-fixable note(s) after you apply these.` : '') +
        (otherIssues > 0 ? ` (Empty notes still need a human.)` : ''),
      remaining,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Health fix failed' },
      { status: 500 }
    )
  }
}
