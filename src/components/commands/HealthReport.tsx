'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Activity, AlertTriangle, FileWarning, Link2Off, FileX, CheckCircle2, Wand2 } from 'lucide-react'
import { ProposalReview, type ProposalResponse } from '@/components/shared/ProposalReview'

type Issue = { path: string; kind: string; detail: string }
type Report = {
  scanned: number
  issues: Issue[]
  counts: Record<string, number>
  error?: string
}

const KIND_META: Record<string, { label: string; icon: React.ElementType }> = {
  'missing-frontmatter': { label: 'Missing frontmatter', icon: FileWarning },
  'missing-preamble': { label: 'Missing "For future Claude" preamble', icon: AlertTriangle },
  'empty': { label: 'Empty notes', icon: FileX },
  'broken-wikilink': { label: 'Broken wikilinks', icon: Link2Off },
}

export function HealthReport() {
  const router = useRouter()
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fixing, setFixing] = useState(false)
  const [proposal, setProposal] = useState<ProposalResponse | null>(null)

  async function scan() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/commands/health')
      const data = await res.json() as Report
      if (!res.ok) throw new Error(data.error ?? 'Scan failed')
      setReport(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setLoading(false)
    }
  }

  async function fixWithAI() {
    if (fixing) return
    setFixing(true)
    setError(null)
    setProposal(null)
    try {
      const res = await fetch('/api/commands/health/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 25 }),
      })
      const data = await res.json() as ProposalResponse
      if (!res.ok) throw new Error(data.error ?? 'Fix failed')
      if (!data.changes?.length) throw new Error('No auto-fixable issues in this batch.')
      setProposal(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fix failed')
    } finally {
      setFixing(false)
    }
  }

  useEffect(() => { void scan() }, [])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-subtle)' }}>
        <Loader2 size={14} className="animate-spin" /> Scanning vault…
      </div>
    )
  }

  if (error) return <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>
  if (!report) return null

  const total = report.issues.length

  return (
    <div className="flex flex-col gap-4">
      <div className="card p-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--icon-grad)' }}>
          <Activity size={18} style={{ color: 'var(--primary)' }} />
        </div>
        <div>
          <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
            {total === 0 ? 'Vault looks healthy' : `${total} issue${total === 1 ? '' : 's'} found`}
          </p>
          <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>Scanned {report.scanned} notes · fully local scan</p>
        </div>
      </div>

      {/* Counts summary */}
      <div className="grid grid-cols-2 gap-3">
        {Object.entries(KIND_META).map(([kind, meta]) => {
          const Icon = meta.icon
          const n = report.counts[kind] ?? 0
          return (
            <div key={kind} className="card p-3 flex items-center gap-2.5">
              <Icon size={15} style={{ color: n > 0 ? 'var(--warning)' : 'var(--success)' }} />
              <div className="flex-1">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{meta.label}</p>
              </div>
              <span className="text-sm font-semibold" style={{ color: n > 0 ? 'var(--text)' : 'var(--text-subtle)' }}>{n}</span>
            </div>
          )
        })}
      </div>

      {total === 0 && (
        <div className="card p-4 flex items-center gap-2">
          <CheckCircle2 size={15} style={{ color: 'var(--success)' }} />
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>No structural issues detected.</span>
        </div>
      )}

      {/* Issue list */}
      {total > 0 && (
        <div className="card p-2 flex flex-col">
          {report.issues.map((issue, i) => {
            const meta = KIND_META[issue.kind]
            const Icon = meta?.icon ?? AlertTriangle
            return (
              <button
                key={i}
                onClick={() => router.push(`/explorer?file=${encodeURIComponent(issue.path)}`)}
                className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all duration-150 hover:scale-[1.01]"
                style={{ background: 'transparent' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <Icon size={13} style={{ color: 'var(--warning)', flexShrink: 0 }} />
                <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>{issue.path.replace(/\.md$/, '')}</span>
                <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>— {issue.detail}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => void scan()}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-150 hover:scale-[1.02]"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
        >
          <Activity size={13} /> Re-scan
        </button>
        {total > 0 && (
          <button
            onClick={() => void fixWithAI()}
            disabled={fixing}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-150 hover:scale-[1.02] disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))', color: 'white' }}
            title="Deterministically add missing frontmatter and the 'For future Claude' preamble, batch by batch, for your review"
          >
            {fixing ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
            {fixing ? 'Fixing…' : 'Auto-fix structure'}
          </button>
        )}
      </div>

      {total > 0 && (
        <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
          Auto-fix adds missing frontmatter and a &ldquo;For future Claude&rdquo; preamble (summarised
          from each note&rsquo;s own first paragraph) <strong>and creates stub notes so broken
          <code>[[links]]</code> resolve</strong> — deterministic, fully local, your content preserved.
          Up to 25 notes at a time, each shown as a diff to approve (Apply stays pinned at the bottom).
          Empty notes still need a human. (To also <em>add</em> new links across notes, use Interlink.)
        </p>
      )}

      {proposal && (
        <ProposalReview
          result={proposal}
          onApplied={() => { setProposal(null); void scan() }}
          onDiscard={() => setProposal(null)}
        />
      )}
    </div>
  )
}
