'use client'

import { ProposalFlow } from '@/components/shared/ProposalFlow'

export default function CuratePage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold gradient-text">Curate</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Drop in meeting notes or a summary — the local model proposes vault updates for your approval.
          Runs entirely on-device via Ollama.
        </p>
      </div>

      <ProposalFlow
        inputLabel="Raw notes / summary"
        inputPlaceholder="e.g. Summarize this meeting and update project notes: ..."
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
