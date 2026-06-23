'use client'

import { ProposalFlow } from '@/components/shared/ProposalFlow'

// The single "add knowledge" entry. Paste anything — a meeting, a fact about a
// person, a project update, a stray thought — and the local model decides which
// note(s) to create or update (it may touch several files), then shows the changes
// as diffs to approve. Files go through the same pipeline via global drag-and-drop.
export default function AddPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold gradient-text">Add to vault</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Just write what you want to capture — a meeting, a person, a project update, an idea. The local
          model figures out where it belongs (a person note, a project page, today&rsquo;s daily note, a
          board…) and may create several notes at once. You review every change as a diff before anything
          is written. To add a file, drag &amp; drop it anywhere.
        </p>
      </div>

      <ProposalFlow
        inputLabel="What do you want to add?"
        inputPlaceholder="e.g. Kickoff with Example Company — agreed on the audit scope. Max Mustermann (their CTO) owns the tooling. Next milestone in two weeks."
        storageKey="add-input-height"
        request={(input) =>
          fetch('/api/curate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: input }),
          })
        }
      />
    </div>
  )
}
