'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Check, X, FilePlus, FileEdit, ArrowRightLeft, Trash2 } from 'lucide-react'
import { DiffView } from '@/components/curate/DiffView'
import { useToast } from '@/components/shared/Toast'

export type Change = {
  path: string
  action: 'create' | 'update' | 'move' | 'delete'
  content?: string
  before?: string | null
  from?: string // move source
  to?: string   // move destination (defaults to path)
}
export type ProposalResponse = { changes: Change[]; log_entry: string; summary: string; origin?: string; error?: string; raw?: string }

const ACTION_META = {
  create: { icon: FilePlus, color: 'var(--success)' },
  update: { icon: FileEdit, color: 'var(--warning)' },
  move: { icon: ArrowRightLeft, color: 'var(--primary)' },
  delete: { icon: Trash2, color: 'var(--danger)' },
} as const

type Props = {
  result: ProposalResponse
  onApplied?: () => void
  onDiscard?: () => void
}

// Review a set of proposed vault changes as per-file diffs, approve/reject each,
// then apply via /api/curate/apply (local write + log + re-index). Shared by the
// Curate page, every local command, and drag-drop ingest.
export function ProposalReview({ result, onApplied, onDiscard }: Props) {
  const { showToast } = useToast()
  const [changes, setChanges] = useState<Change[]>(result.changes)
  const [approved, setApproved] = useState<Set<string>>(new Set(result.changes.map(c => c.path)))
  const [applying, setApplying] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Proposals render below the command cockpit, inside a scrollable panel — easy to
  // miss. Pull the review into view (and the panel header to its top) as soon as it
  // mounts, so the user sees the diffs and the Apply bar without hunting for scroll.
  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // Fetch the current content of each target so the diff shows real before/after.
  // Only create/update are normalized by what's on disk; move/delete keep their
  // declared action (a delete is still a delete even though the file exists).
  useEffect(() => {
    let active = true
    void (async () => {
      const enriched = await Promise.all(
        result.changes.map(async (c) => {
          if (c.action === 'move' || c.action === 'delete') {
            // Show the current content of the file being moved/deleted as "before".
            const src = c.action === 'move' ? (c.from ?? c.path) : c.path
            try {
              const r = await fetch(`/api/vault/file?path=${encodeURIComponent(src)}`)
              if (r.ok) {
                const d = await r.json() as { content: string }
                return { ...c, before: d.content }
              }
            } catch { /* ignore */ }
            return { ...c, before: null }
          }
          try {
            const r = await fetch(`/api/vault/file?path=${encodeURIComponent(c.path)}`)
            if (r.ok) {
              const d = await r.json() as { content: string }
              return { ...c, before: d.content, action: 'update' as const }
            }
          } catch { /* not found -> create */ }
          return { ...c, before: null, action: 'create' as const }
        })
      )
      if (active) {
        setChanges(enriched)
        setApproved(new Set(enriched.map(c => c.path)))
      }
    })()
    return () => { active = false }
  }, [result])

  function toggle(p: string) {
    setApproved(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p); else next.add(p)
      return next
    })
  }

  async function apply() {
    if (applying) return
    const selected = changes.filter(c => approved.has(c.path))
    if (selected.length === 0) return
    setApplying(true)
    try {
      const res = await fetch('/api/curate/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: selected.map(({ path, action, content, from, to }) => ({ path, action, content, from, to })),
          log_entry: result.log_entry,
          origin: result.origin,
        }),
      })
      const data = await res.json() as { written?: string[]; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Apply failed')
      showToast(`Saved ${data.written?.length ?? 0} file(s) to the vault`, 'success')
      // Let live views (e.g. the dashboard Activity Timeline) refresh immediately.
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('vault:updated'))
      onApplied?.()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Apply failed', 'error')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div ref={rootRef} className="flex flex-col gap-3 scroll-mt-4">
      <div
        className="flex items-center gap-2 pt-2 mt-1 border-t"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Proposed changes — review &amp; apply below
        </span>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-elevated)', color: 'var(--text-subtle)' }}>
          {changes.length}
        </span>
      </div>
      <div className="card p-4">
        <p className="text-sm" style={{ color: 'var(--text)' }}>{result.summary}</p>
      </div>

      {changes.map(change => {
        const meta = ACTION_META[change.action] ?? ACTION_META.update
        const Icon = meta.icon
        const label = change.action === 'move'
          ? `${change.from ?? '?'}  →  ${change.to ?? change.path}`
          : change.path
        // For delete, the "after" is empty (the note is removed). For move with no
        // content rewrite, after = before (relocated unchanged).
        const after = change.action === 'delete'
          ? ''
          : change.content ?? change.before ?? ''
        return (
          <div key={change.path} className="card p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <Icon size={14} style={{ color: meta.color, flexShrink: 0 }} />
                <span className="text-sm font-medium truncate" style={{ color: 'var(--text)' }}>{label}</span>
                <span className="text-xs px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: 'var(--bg-elevated)', color: 'var(--text-subtle)' }}>
                  {change.action}
                </span>
              </div>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                <input type="checkbox" checked={approved.has(change.path)} onChange={() => toggle(change.path)} />
                Apply this change
              </label>
            </div>
            {change.action === 'move' && change.content === undefined ? (
              <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>File relocated unchanged.</p>
            ) : (
              <DiffView before={change.before ?? null} after={after} />
            )}
          </div>
        )
      })}

      {/* Sticky action bar — always reachable no matter how many diffs are listed,
          so the user never has to hunt for the Apply button by scrolling. */}
      <div
        className="sticky bottom-0 z-10 flex items-center justify-between gap-2 -mx-1 px-3 py-3 rounded-xl"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: '0 -8px 24px rgba(0,0,0,0.18)' }}
      >
        <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>
          {approved.size} of {changes.length} selected
        </span>
        <div className="flex items-center gap-2">
          {onDiscard && (
            <button
              onClick={onDiscard}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-150"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
            >
              <X size={14} /> Discard
            </button>
          )}
          <button
            onClick={() => void apply()}
            disabled={applying || approved.size === 0}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))', color: 'white' }}
          >
            {applying ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Apply {approved.size} change{approved.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}
