'use client'

import { useEffect, useState, useCallback } from 'react'
import { Upload, Loader2, Sparkles, X } from 'lucide-react'
import { useToast } from './Toast'
import { ProposalReview, type ProposalResponse } from './ProposalReview'
import { TagPicker } from './TagPicker'

// All of these now go through /api/vault/ingest (text/pdf → note; image → vision → note).
const INGEST_EXTS = ['.md', '.markdown', '.txt', '.text', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif']

function ext(name: string) {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i).toLowerCase()
}

export function DropZoneOverlay() {
  const { showToast } = useToast()
  const [isDragging, setIsDragging] = useState(false)
  const [dragCounter, setDragCounter] = useState(0)

  // Ingest queue: text/PDF files are turned into structured notes one at a time.
  const [queue, setQueue] = useState<File[]>([])
  const [current, setCurrent] = useState<File | null>(null)
  const [phase, setPhase] = useState<'idle' | 'compose' | 'ingesting' | 'review'>('idle')
  const [result, setResult] = useState<ProposalResponse | null>(null)
  // Optional notes the user attaches to the current file; sent with high priority.
  const [notes, setNotes] = useState('')
  // Optional tags stamped onto the resulting note (code-enforced server-side).
  const [tags, setTags] = useState<string[]>([])

  const rawSave = useCallback(async (file: File) => {
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/vault/drop', { method: 'POST', body: fd })
      const data = await res.json() as { savedPath?: string; error?: string }
      if (res.ok && data.savedPath) showToast(`Saved: ${data.savedPath}`, 'success')
      else showToast(data.error ?? `Failed to save ${file.name}`, 'error')
    } catch {
      showToast(`Error saving ${file.name}`, 'error')
    }
  }, [showToast])

  const handleDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    setIsDragging(false); setDragCounter(0)

    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return

    const toIngest: File[] = []
    for (const file of files) {
      if (INGEST_EXTS.includes(ext(file.name))) toIngest.push(file)
      else showToast(`Unsupported file type: ${file.name}`, 'error')
    }
    if (toIngest.length) setQueue(prev => [...prev, ...toIngest])
  }, [showToast])

  // Dequeue one file at a time and pause on a "compose" step so the user can
  // optionally attach notes before the model drafts the note.
  useEffect(() => {
    if (current || phase !== 'idle' || queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    setCurrent(next)
    setNotes('')
    setTags([])
    setPhase('compose')
  }, [queue, current, phase])

  // Send the current file (plus any attached notes/tags) to the local ingest pipeline.
  const processCurrent = useCallback(async (file: File, attachedNotes: string, attachedTags: string[]) => {
    setPhase('ingesting')
    try {
      const fd = new FormData()
      fd.append('file', file)
      if (attachedNotes.trim()) fd.append('notes', attachedNotes.trim())
      if (attachedTags.length) fd.append('tags', JSON.stringify(attachedTags))
      const res = await fetch('/api/vault/ingest', { method: 'POST', body: fd })
      if (res.status === 415) {
        // Can't extract text — fall back to saving the raw file.
        await rawSave(file)
        showToast(`${file.name}: saved as-is (couldn't read text)`, 'info')
        setCurrent(null); setPhase('idle')
        return
      }
      const data = await res.json() as ProposalResponse & { savedOnly?: boolean; summary?: string }
      if (!res.ok) throw new Error(data.error ?? 'Ingest failed')
      if (data.savedOnly) {
        // Image saved, but no vision model to summarize it.
        showToast(data.summary ?? `Saved ${file.name}`, 'info')
        setCurrent(null); setPhase('idle')
        return
      }
      setResult(data)
      setPhase('review')
    } catch (err) {
      showToast(err instanceof Error ? err.message : `Failed to ingest ${file.name}`, 'error')
      setCurrent(null); setPhase('idle')
    }
  }, [rawSave, showToast])

  function finish() {
    setResult(null); setCurrent(null); setNotes(''); setTags([]); setPhase('idle')
  }

  // Drag listeners
  const onEnter = useCallback((e: DragEvent) => { e.preventDefault(); setDragCounter(c => c + 1); setIsDragging(true) }, [])
  const onLeave = useCallback((e: DragEvent) => { e.preventDefault(); setDragCounter(c => { const n = c - 1; if (n <= 0) setIsDragging(false); return n }) }, [])
  const onOver = useCallback((e: DragEvent) => { e.preventDefault() }, [])

  useEffect(() => {
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [onEnter, onLeave, onOver, handleDrop])

  return (
    <>
      {/* Drag hint */}
      {isDragging && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', border: '2px dashed var(--primary)' }}>
          <div className="flex flex-col items-center gap-4">
            <div className="w-20 h-20 rounded-2xl flex items-center justify-center" style={{ background: 'var(--primary-tint)', border: '2px solid var(--primary)' }}>
              <Upload size={36} style={{ color: 'var(--primary)' }} />
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold" style={{ color: 'white' }}>Drop to add to your vault</p>
              <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.7)' }}>
                .md · .txt · .pdf · images → AI-structured note (reviewed before saving)
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Compose / ingesting / review modal */}
      {(phase === 'compose' || phase === 'ingesting' || phase === 'review') && (
        <div className="fixed inset-0 z-[9999] flex items-start justify-center overflow-y-auto p-6" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}>
          <div className="w-full max-w-2xl my-6 rounded-2xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Sparkles size={16} style={{ color: 'var(--primary)' }} />
                <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                  Ingest {current?.name}
                </span>
                <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(16,185,129,0.12)', color: 'var(--success)' }}>
                  local
                </span>
              </div>
              <button onClick={finish} className="p-1.5 rounded-lg" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                <X size={15} />
              </button>
            </div>

            {phase === 'compose' && current && (
              <div className="flex flex-col gap-3">
                <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  Additional notes <span style={{ color: 'var(--text-subtle)' }}>(optional — sent with the file, high priority for the summary)</span>
                </label>
                <textarea
                  autoFocus
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void processCurrent(current, notes, tags) }}
                  placeholder="e.g. This is the signed audit contract for Example Company — flag the deadline (Aug 15) and link it to [[Example Company]]."
                  className="resize-none rounded-lg p-3 text-sm outline-none"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text)', minHeight: '120px', fontFamily: 'inherit' }}
                />
                <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
                  Your notes take precedence over the extracted/OCR&apos;d text and are folded into the
                  note&apos;s &ldquo;For future Claude&rdquo; summary.
                </p>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                    Tags <span style={{ color: 'var(--text-subtle)' }}>(optional — added to the note&apos;s frontmatter)</span>
                  </label>
                  <TagPicker value={tags} onChange={setTags} />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => void processCurrent(current, '', tags)}
                    className="px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:scale-[1.02]"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                  >
                    Skip notes
                  </button>
                  <button
                    onClick={() => void processCurrent(current, notes, tags)}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:scale-[1.02]"
                    style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))', color: 'white' }}
                  >
                    <Sparkles size={14} /> Create note
                    <kbd className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.2)' }}>⌘↵</kbd>
                  </button>
                </div>
              </div>
            )}

            {phase === 'ingesting' && (
              <div className="flex items-center gap-2 text-sm py-8 justify-center" style={{ color: 'var(--text-subtle)' }}>
                <Loader2 size={16} className="animate-spin" />
                Reading the file and drafting a note locally…
              </div>
            )}

            {phase === 'review' && result && (
              <ProposalReview result={result} onApplied={finish} onDiscard={finish} />
            )}
          </div>
        </div>
      )}
    </>
  )
}
