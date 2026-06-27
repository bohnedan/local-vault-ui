'use client'

import { useRef, useState } from 'react'
import { FolderUp, Loader2, FileStack, Play } from 'lucide-react'
import { ProposalReview, type ProposalResponse } from '@/components/shared/ProposalReview'

// Bulk import: point at a folder of exported notes (Markdown, txt, HTML from
// Notion/Evernote, .enex, .csv, .json, PDF, .docx). They're structured into
// AI-first notes a batch at a time and reviewed as diffs before writing.
const EXTS = ['.md', '.markdown', '.txt', '.text', '.html', '.htm', '.enex', '.csv', '.json', '.pdf', '.docx']
const BATCH_SIZE = 6

function ext(name: string) {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i).toLowerCase()
}

export default function ImportPage() {
  const folderInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [done, setDone] = useState(0)
  const [inFlight, setInFlight] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<ProposalResponse | null>(null)

  function pick(list: FileList | null) {
    if (!list) return
    const picked = Array.from(list).filter(f => EXTS.includes(ext(f.name)))
    setFiles(picked); setDone(0); setProposal(null); setError(null)
  }

  async function processNext() {
    if (loading || done >= files.length) return
    setLoading(true); setError(null); setProposal(null)
    const batch = files.slice(done, done + BATCH_SIZE)
    setInFlight(batch.length)
    try {
      const fd = new FormData()
      for (const f of batch) fd.append('files', f)
      const res = await fetch('/api/import/batch', { method: 'POST', body: fd })
      const data = await res.json() as ProposalResponse & { processed?: number; failed?: string[] }
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Import failed')
      if (!data.changes?.length) {
        // Nothing draftable in this batch — skip past it.
        setDone(d => d + batch.length)
      } else {
        setProposal(data)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  // Advance past the current batch once its proposal is applied or discarded.
  function resolveBatch() {
    setProposal(null)
    setDone(d => Math.min(files.length, d + inFlight))
  }

  const remaining = files.length - done
  const pct = files.length ? Math.round((done / files.length) * 100) : 0

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold gradient-text flex items-center gap-2"><FileStack size={18} /> Import notes</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Build your vault from scattered notes. Point at a folder of exports (Markdown, txt, HTML from
          Notion/Evernote, <span className="font-mono">.enex</span>, <span className="font-mono">.csv</span>,
          <span className="font-mono"> .json</span>, PDF, <span className="font-mono">.docx</span>). They&rsquo;re
          structured into AI-first notes <strong>{BATCH_SIZE} at a time</strong> and reviewed as diffs before
          anything is written — all local.
        </p>
      </div>

      {/* Pickers */}
      <div className="card p-5 flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => folderInput.current?.click()}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:scale-[1.02]"
            style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))', color: 'white' }}
          >
            <FolderUp size={15} /> Choose a folder
          </button>
          <button
            onClick={() => fileInput.current?.click()}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:scale-[1.02]"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
          >
            <FileStack size={15} /> …or pick files
          </button>
          {/* webkitdirectory selects a whole folder recursively */}
          <input
            ref={folderInput} type="file" multiple hidden
            // @ts-expect-error non-standard but widely supported folder-select attrs
            webkitdirectory="" directory=""
            onChange={e => pick(e.target.files)}
          />
          <input ref={fileInput} type="file" multiple hidden accept={EXTS.join(',')} onChange={e => pick(e.target.files)} />
        </div>

        {files.length > 0 && (
          <>
            <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
              <span>{files.length} importable file(s) · {done} processed · {remaining} remaining</span>
              <span className="font-mono">{pct}%</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
              <div className="h-full transition-all duration-300" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, var(--primary), var(--accent))' }} />
            </div>
            {remaining > 0 && !proposal && (
              <button
                onClick={() => void processNext()}
                disabled={loading}
                className="self-start flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:scale-[1.02] disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))', color: 'white' }}
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {loading ? `Structuring ${inFlight} file(s)…` : `Process next ${Math.min(BATCH_SIZE, remaining)}`}
              </button>
            )}
            {remaining === 0 && !proposal && (
              <p className="text-sm" style={{ color: 'var(--success)' }}>All files processed. 🎉 Run <strong>Interlink</strong> next to connect them.</p>
            )}
          </>
        )}
        {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
      </div>

      {/* Batch review */}
      {proposal && (
        <div className="mt-5">
          <p className="text-sm font-medium mb-3" style={{ color: 'var(--text)' }}>
            Review this batch ({proposal.changes.length} note(s))
          </p>
          <ProposalReview result={proposal} onApplied={resolveBatch} onDiscard={resolveBatch} />
        </div>
      )}
    </div>
  )
}
