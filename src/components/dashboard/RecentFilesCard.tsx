'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Clock, FileText, ChevronRight } from 'lucide-react'

type RecentFile = {
  path: string
  mtime: string
}

export function RecentFilesCard() {
  const router = useRouter()
  const [files, setFiles] = useState<RecentFile[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/vault/recent')
        if (res.ok) {
          const data = await res.json() as { files: RecentFile[] }
          setFiles(data.files)
        }
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  function openFile(path: string) {
    router.push(`/explorer?file=${encodeURIComponent(path)}`)
  }

  function formatTime(iso: string): string {
    const d = new Date(iso)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    const mins = Math.floor(diff / 60000)
    const hours = Math.floor(mins / 60)
    const days = Math.floor(hours / 24)
    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (mins > 0) return `${mins}m ago`
    return 'just now'
  }

  return (
    <div className="card p-4 flex flex-col row-span-2">
      <div className="flex items-center gap-2 mb-4">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: 'var(--primary-tint)' }}
        >
          <Clock size={14} style={{ color: 'var(--accent)' }} />
        </div>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Recent Files</h2>
      </div>

      {loading ? (
        <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>Loading…</p>
      ) : files.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>No files found</p>
      ) : (
        <div className="space-y-1 flex-1">
          {files.map(file => {
            const parts = file.path.split('/')
            const name = parts.at(-1)?.replace('.md', '') ?? file.path
            const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
            return (
              <button
                key={file.path}
                onClick={() => openFile(file.path)}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all duration-150 hover:scale-[1.01] group"
                style={{
                  background: 'transparent',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = 'transparent'
                }}
              >
                <FileText size={13} style={{ color: 'var(--text-subtle)', flexShrink: 0 }} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate" style={{ color: 'var(--text)' }}>{name}</p>
                  {folder && (
                    <p className="text-xs truncate" style={{ color: 'var(--text-subtle)' }}>{folder}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>{formatTime(file.mtime)}</span>
                  <ChevronRight size={12} style={{ color: 'var(--text-subtle)' }} />
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
