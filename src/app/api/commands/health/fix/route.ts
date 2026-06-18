import { NextRequest, NextResponse } from 'next/server'
import { buildHealthFixChanges } from '@/lib/healthFix'

// Repair vault-health issues deterministically (no model, fully local, always a
// correct fix). Adds missing frontmatter + "For future Claude" preamble while
// preserving the note body verbatim. Broken wikilinks and empty notes need human
// judgment and are left alone. Output is the standard change-proposal contract, so
// fixes flow through the same review/diff/approve UI before anything is written.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { limit?: number }
    const limit = Math.min(50, Math.max(1, body.limit ?? 12))

    const { changes, remaining, fixableTotal, otherIssues } = buildHealthFixChanges(limit)

    return NextResponse.json({
      changes,
      log_entry: `Vault health auto-fix — added missing frontmatter / "For future Claude" preamble on ${changes.length} note(s), preserving existing content.`,
      summary:
        `Proposed structural fixes for ${changes.length} note(s)` +
        (remaining > 0 ? ` — ${remaining} more fixable note(s) after you apply these.` : '.') +
        (otherIssues > 0 ? ` ${otherIssues} issue(s) (broken links / empty notes) need a human and are left as-is.` : ''),
      remaining,
      fixableTotal,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Health fix failed' },
      { status: 500 }
    )
  }
}
