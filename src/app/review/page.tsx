'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Inbox, ChevronLeft, Clock, Moon } from 'lucide-react'
import { ProposalReview, type ProposalResponse } from '@/components/shared/ProposalReview'

type PendingItem = { id: string; createdAt: string; origin: string; summary: string; changeCount: number }

// Morning review: proposals the overnight caretaker generated but did NOT apply
// (per "auto-apply safe steps only"). Approve/reject each as diffs; applying or
// discarding removes it from the queue.
export default function ReviewPage() {
  const [items, setItems] = useState<PendingItem[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [proposal, setProposal] = useState<ProposalResponse | null>(null)
  const [loadingOne, setLoadingOne] = useState(false)

  const loadList = useCallback(async () => {
    try {
      const r = await fetch('/api/pending', { cache: 'no-store' })
      const d = await r.json() as { items: PendingItem[] }
      setItems(d.items)
    } catch { setItems([]) }
  }, [])

  useEffect(() => { void loadList() }, [loadList])

  async function open(id: string) {
    setLoadingOne(true)
    setOpenId(id)
    try {
      const r = await fetch(`/api/pending/${id}`, { cache: 'no-store' })
      setProposal(await r.json() as ProposalResponse)
    } catch { setProposal(null) } finally { setLoadingOne(false) }
  }

  async function resolve(id: string) {
    await fetch(`/api/pending/${id}`, { method: 'DELETE' })
    setOpenId(null); setProposal(null)
    await loadList()
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold gradient-text flex items-center gap-2">
          <Moon size={18} /> Overnight review
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Proposals the nightly caretaker prepared for you. Nothing here has been written — approve the
          diffs you want. (Index sync and structural health fixes were applied automatically.)
        </p>
      </div>

      {openId && proposal ? (
        <div className="flex flex-col gap-4">
          <button
            onClick={() => { setOpenId(null); setProposal(null) }}
            className="self-start flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-muted)' }}
          >
            <ChevronLeft size={15} /> Back to queue
          </button>
          <ProposalReview
            result={proposal}
            onApplied={() => void resolve(openId)}
            onDiscard={() => void resolve(openId)}
          />
        </div>
      ) : loadingOne ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-subtle)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading proposal…
        </div>
      ) : items === null ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-subtle)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="card p-8 flex flex-col items-center gap-2 text-center">
          <Inbox size={26} style={{ color: 'var(--text-subtle)' }} />
          <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Nothing to review</p>
          <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
            The overnight caretaker will queue curation proposals here when your notes change.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map(it => (
            <button
              key={it.id}
              onClick={() => void open(it.id)}
              className="card p-4 text-left transition-all hover:scale-[1.01]"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{it.summary}</span>
                <span className="text-xs px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: 'var(--primary-tint)', color: 'var(--primary)' }}>
                  {it.changeCount} change{it.changeCount === 1 ? '' : 's'}
                </span>
              </div>
              <p className="text-xs mt-1.5 flex items-center gap-1.5" style={{ color: 'var(--text-subtle)' }}>
                <Clock size={11} /> {new Date(it.createdAt).toLocaleString()} · {it.origin}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
