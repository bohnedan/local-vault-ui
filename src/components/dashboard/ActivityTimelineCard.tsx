'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { History, FilePlus, FileEdit, ArrowRightLeft, Trash2 } from 'lucide-react'

type OpChange = { action: 'create' | 'update' | 'move' | 'delete'; path: string; from?: string; to?: string }
type Operation = { ts: string; origin: string; summary: string; changes: OpChange[] }

const ACTION_META = {
  create: { icon: FilePlus, color: 'var(--success)' },
  update: { icon: FileEdit, color: 'var(--warning)' },
  move: { icon: ArrowRightLeft, color: 'var(--primary)' },
  delete: { icon: Trash2, color: 'var(--danger)' },
} as const

// Human label per origin (where the change came from).
const ORIGIN_LABEL: Record<string, string> = {
  add: 'Add', chat: 'Chat', drop: 'Drop', health: 'Health', interlink: 'Interlink',
  synthesize: 'Synthesize', caretaker: 'Caretaker', edit: 'Edit',
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(today); y.setDate(today.getDate() - 1)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  if (same(d, y)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function ActivityTimelineCard() {
  const router = useRouter()
  const [ops, setOps] = useState<Operation[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const load = () => {
      fetch('/api/timeline?limit=40', { cache: 'no-store' })
        .then(r => r.json())
        .then((d: { operations?: Operation[] }) => { if (active) setOps(d.operations ?? []) })
        .catch(() => {})
        .finally(() => { if (active) setLoading(false) })
    }
    load()
    // Refresh whenever a change is applied anywhere in the app, and when the tab
    // regains focus (so the timeline never looks stale).
    const onUpdate = () => load()
    window.addEventListener('vault:updated', onUpdate)
    window.addEventListener('focus', onUpdate)
    return () => {
      active = false
      window.removeEventListener('vault:updated', onUpdate)
      window.removeEventListener('focus', onUpdate)
    }
  }, [])

  // Group consecutive ops under a day heading.
  const groups: Array<{ day: string; ops: Operation[] }> = []
  for (const op of ops) {
    const day = dayLabel(op.ts)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.ops.push(op)
    else groups.push({ day, ops: [op] })
  }

  return (
    <div className="card p-4 flex flex-col bento-right-wide" style={{ maxHeight: '440px' }}>
      <div className="flex items-center gap-2 mb-4">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--primary-tint)' }}>
          <History size={14} style={{ color: 'var(--accent)' }} />
        </div>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Activity Timeline</h2>
        <span className="text-xs ml-auto" style={{ color: 'var(--text-subtle)' }}>what changed, and where</span>
      </div>

      {loading ? (
        <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>Loading…</p>
      ) : ops.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
          No changes logged yet. Anything you add or edit will appear here for traceability.
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto -mr-1 pr-1 space-y-4">
          {groups.map(group => (
            <div key={group.day}>
              <p className="text-xs font-semibold mb-2 sticky top-0 py-0.5" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>
                {group.day}
              </p>
              <div className="space-y-2.5 border-l pl-3" style={{ borderColor: 'var(--border-subtle)' }}>
                {group.ops.map((op, i) => (
                  <div key={`${op.ts}-${i}`} className="relative">
                    <span className="absolute -left-[15px] top-1.5 w-1.5 h-1.5 rounded-full" style={{ background: 'var(--primary)' }} />
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono" style={{ color: 'var(--text-subtle)' }}>{timeLabel(op.ts)}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                        {ORIGIN_LABEL[op.origin] ?? op.origin}
                      </span>
                      <span className="text-xs flex-1 min-w-0 truncate" style={{ color: 'var(--text)' }} title={op.summary}>{op.summary}</span>
                    </div>
                    <div className="flex flex-col gap-0.5 mt-1">
                      {op.changes.map((c, j) => {
                        const meta = ACTION_META[c.action] ?? ACTION_META.update
                        const Icon = meta.icon
                        const label = c.action === 'move' ? `${c.from} → ${c.to}` : c.path
                        const openPath = c.action === 'move' ? (c.to ?? c.path) : c.path
                        return (
                          <button
                            key={`${c.path}-${j}`}
                            onClick={() => c.action !== 'delete' && router.push(`/explorer?file=${encodeURIComponent(openPath)}`)}
                            disabled={c.action === 'delete'}
                            className="flex items-center gap-1.5 text-left rounded px-1 py-0.5 transition-colors disabled:cursor-default"
                            style={{ background: 'transparent' }}
                            onMouseEnter={e => { if (c.action !== 'delete') e.currentTarget.style.background = 'var(--bg-elevated)' }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                          >
                            <Icon size={11} style={{ color: meta.color, flexShrink: 0 }} />
                            <span className="text-xs truncate" style={{ color: 'var(--text-subtle)' }}>{label.replace(/\.md$/, '')}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
