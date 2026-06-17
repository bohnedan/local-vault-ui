'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  FolderOpen, Cpu, Database, CheckCircle2, XCircle, Loader2, Download,
  ArrowRight, BookOpen, RefreshCw,
} from 'lucide-react'

type Status = {
  configured: boolean
  vault: { path: string; valid: boolean; noteCount: number }
  ollama: {
    host: string; reachable: boolean; installed: string[]
    chatModel: string; embedModel: string; visionModel: string
    hasChatModel: boolean; hasEmbedModel: boolean; hasVisionModel: boolean
  }
  index: { chunks: number; built: boolean }
}

type Role = 'chatModel' | 'embedModel' | 'visionModel'

// Heuristics to recognize a model's role from its name, so we can auto-pick a
// working model from whatever the user already has installed.
const EMBED_HINTS = ['embed', 'minilm', 'arctic']
const VISION_HINTS = ['llava', 'vl', 'vision', 'moondream', 'minicpm-v', 'bakllava', 'qwen3.5']
const isEmbed = (m: string) => EMBED_HINTS.some(h => m.toLowerCase().includes(h))
const isVision = (m: string) => VISION_HINTS.some(h => m.toLowerCase().includes(h))
function pickEmbed(list: string[]) { return list.find(isEmbed) ?? null }
function pickVision(list: string[]) { return list.find(isVision) ?? null }
function pickChat(list: string[]) {
  const nonEmbed = list.filter(m => !isEmbed(m))
  return nonEmbed.find(m => !isVision(m)) ?? nonEmbed[0] ?? null // prefer a text model, else any
}

// Suggestions only — users are never limited to these. They can pick any model
// already installed, or type any model name to pull. Sizes are approximate.
const SUGGESTIONS: Record<Role, { name: string; note: string }[]> = {
  chatModel: [
    { name: 'qwen3.5:4b', note: 'chat + vision in one, 8GB' },
    { name: 'qwen3.5:2b', note: 'lightest multimodal' },
    { name: 'qwen2.5:3b', note: 'fast, text-only' },
    { name: 'llama3.2:3b', note: 'balanced, text-only' },
  ],
  embedModel: [
    { name: 'nomic-embed-text', note: 'recommended' },
    { name: 'mxbai-embed-large', note: 'higher quality' },
    { name: 'all-minilm', note: 'tiny' },
  ],
  visionModel: [
    { name: 'qwen3.5:4b', note: 'best small OCR, 8GB' },
    { name: 'qwen3.5:2b', note: 'lightest' },
    { name: 'llama3.2-vision', note: 'most accurate, ~8GB' },
    { name: 'llava:7b', note: 'fast, lower accuracy' },
  ],
}

export default function SetupPage() {
  const router = useRouter()
  const [status, setStatus] = useState<Status | null>(null)
  const [vaultInput, setVaultInput] = useState('')
  const [savingVault, setSavingVault] = useState(false)
  const [vaultError, setVaultError] = useState<string | null>(null)
  const [pulling, setPulling] = useState<string | null>(null)
  const [pullingRole, setPullingRole] = useState<Role | null>(null)
  const [pullMsg, setPullMsg] = useState('')
  const [pullPct, setPullPct] = useState<number | null>(null)
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/setup/status')
    const data = await res.json() as Status
    setStatus(data)
    if (!vaultInput && data.vault.path) setVaultInput(data.vault.path)
    return data
  }, [vaultInput])

  useEffect(() => { void refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Once, on first load: if a role's configured model isn't installed but a
  // suitable installed model exists, switch to it so the app works out of the box
  // with whatever the user already has.
  const autoPicked = useRef(false)
  useEffect(() => {
    if (!status?.ollama.reachable || autoPicked.current) return
    autoPicked.current = true
    const o = status.ollama
    const patch: Partial<Record<Role, string>> = {}
    if (!o.hasChatModel) { const c = pickChat(o.installed); if (c) patch.chatModel = c }
    if (!o.hasEmbedModel) { const e = pickEmbed(o.installed); if (e) patch.embedModel = e }
    if (!o.hasVisionModel) { const v = pickVision(o.installed); if (v) patch.visionModel = v }
    if (Object.keys(patch).length) {
      void fetch('/api/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      }).then(() => refresh())
    }
  }, [status, refresh])

  async function saveVault() {
    if (!vaultInput.trim()) return
    setSavingVault(true)
    setVaultError(null)
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultPath: vaultInput.trim() }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Could not set vault')
      await refresh()
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : 'Could not set vault')
    } finally {
      setSavingVault(false)
    }
  }

  function pullModel(model: string, role: Role) {
    setPulling(model)
    setPullingRole(role)
    setPullMsg('starting…')
    setPullPct(null)
    const es = new EventSource(`/api/setup/pull?model=${encodeURIComponent(model)}`)
    const stop = () => { es.close(); setPulling(null); setPullingRole(null) }
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as { type: string; status?: string; pct?: number; message?: string }
      if (ev.type === 'progress') {
        setPullMsg(ev.status ?? 'downloading')
        setPullPct(ev.pct ?? null)
      } else if (ev.type === 'error') {
        setPullMsg(`error: ${ev.message}`); setPullPct(null); stop()
      } else if (ev.type === 'done') {
        setPullMsg(''); setPullPct(null); stop(); void refresh()
      }
    }
    es.onerror = () => { setPullPct(null); setPullMsg('connection lost'); stop() }
  }

  async function buildIndex() {
    setBuilding(true)
    setBuildError(null)
    try {
      const res = await fetch('/api/index/rebuild', { method: 'POST' })
      const data = await res.json() as { chunks?: number; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Index build failed')
      if (!data.chunks) throw new Error('Index built but empty — is the embedding model installed?')
      await refresh()
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Index build failed')
    } finally {
      setBuilding(false)
    }
  }

  // Pick any model for a role (chat/embed/vision); persists immediately.
  async function saveModel(role: Role, model: string) {
    await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [role]: model }),
    })
    await refresh()
  }

  const s = status
  const vaultReady = !!s?.vault.valid
  const modelsReady = !!s?.ollama.hasChatModel && !!s?.ollama.hasEmbedModel
  const indexReady = !!s?.index.built
  const allReady = vaultReady && modelsReady && indexReady

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-6 py-2">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-3" style={{ background: 'var(--icon-grad)' }}>
          <BookOpen size={26} style={{ color: 'var(--primary)' }} />
        </div>
        <h1 className="text-2xl font-bold gradient-text">Welcome to Vault UI</h1>
        <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
          A local-first second brain. Three quick steps and everything runs on your machine — no cloud, no data leaving your device.
        </p>
      </div>

      {/* Step 1 — Vault */}
      <StepCard n={1} title="Connect your vault" icon={FolderOpen} done={vaultReady}>
        <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
          Paste the absolute path to your Obsidian vault folder (e.g. <span className="font-mono">~/Documents/Second-Brain</span>).
        </p>
        <div className="flex gap-2">
          <input
            value={vaultInput}
            onChange={e => setVaultInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void saveVault() }}
            placeholder="/Users/you/path/to/vault"
            className="flex-1 rounded-lg px-3 py-2 text-sm outline-none font-mono"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text)' }}
          />
          <button
            onClick={() => void saveVault()}
            disabled={savingVault || !vaultInput.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:scale-[1.02] disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))', color: 'white' }}
          >
            {savingVault ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            Connect
          </button>
        </div>
        {vaultError && <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{vaultError}</p>}
        {vaultReady && (
          <p className="text-xs mt-2 flex items-center gap-1.5" style={{ color: 'var(--success)' }}>
            <CheckCircle2 size={12} /> Connected — {s?.vault.noteCount} notes found
          </p>
        )}
      </StepCard>

      {/* Step 2 — Ollama + models */}
      <StepCard n={2} title="Local AI models" icon={Cpu} done={modelsReady}>
        {!s?.ollama.reachable ? (
          <div className="text-xs flex items-start gap-2" style={{ color: 'var(--danger)' }}>
            <XCircle size={14} className="mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium">Ollama isn&apos;t running at {s?.ollama.host}.</p>
              <p className="mt-1" style={{ color: 'var(--text-muted)' }}>
                Install it from <span className="font-mono">ollama.com</span>, then run <span className="font-mono">ollama serve</span> and refresh.
              </p>
              <button onClick={() => void refresh()} className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                <RefreshCw size={11} /> Re-check
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
              Pick from models already on your machine, or pull a suggested one. You&apos;re not limited to
              these — type any Ollama model name. Tip: <span className="font-mono">qwen3.5:4b</span> is
              multimodal — set it as both the chat <em>and</em> vision model and one ~3.4 GB model covers
              chat, curation, and image OCR (great for 8 GB RAM).
            </p>
            <ModelPicker role="chatModel" label="Chat model" current={s.ollama.chatModel} ok={s.ollama.hasChatModel}
              installed={s.ollama.installed} active={pullingRole === 'chatModel'} pulling={pulling} pullMsg={pullMsg} pullPct={pullPct}
              onSelect={(m) => void saveModel('chatModel', m)} onPull={(m) => pullModel(m, 'chatModel')} />
            <ModelPicker role="embedModel" label="Embedding model" current={s.ollama.embedModel} ok={s.ollama.hasEmbedModel}
              installed={s.ollama.installed} active={pullingRole === 'embedModel'} pulling={pulling} pullMsg={pullMsg} pullPct={pullPct}
              onSelect={(m) => void saveModel('embedModel', m)} onPull={(m) => pullModel(m, 'embedModel')} />
            <ModelPicker role="visionModel" label="Vision model" optional current={s.ollama.visionModel} ok={s.ollama.hasVisionModel}
              installed={s.ollama.installed} active={pullingRole === 'visionModel'} pulling={pulling} pullMsg={pullMsg} pullPct={pullPct}
              onSelect={(m) => void saveModel('visionModel', m)} onPull={(m) => pullModel(m, 'visionModel')} />
          </div>
        )}
      </StepCard>

      {/* Step 3 — Index */}
      <StepCard n={3} title="Build the search index" icon={Database} done={indexReady}>
        <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
          Embeds your notes locally so Chat can retrieve and cite them. Runs once; updates incrementally after.
        </p>
        <button
          onClick={() => void buildIndex()}
          disabled={building || !vaultReady || !modelsReady}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:scale-[1.02] disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))', color: 'white' }}
        >
          {building ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
          {building ? 'Embedding notes…' : indexReady ? 'Rebuild index' : 'Build index'}
        </button>
        {buildError ? (
          <p className="text-xs mt-2 flex items-start gap-1.5" style={{ color: 'var(--danger)' }}>
            <XCircle size={12} className="mt-0.5 flex-shrink-0" /> {buildError}
          </p>
        ) : !vaultReady || !modelsReady ? (
          <p className="text-xs mt-2" style={{ color: 'var(--text-subtle)' }}>Finish steps 1 and 2 first (the embedding model must be installed).</p>
        ) : indexReady ? (
          <p className="text-xs mt-2 flex items-center gap-1.5" style={{ color: 'var(--success)' }}>
            <CheckCircle2 size={12} /> {s?.index.chunks} chunks indexed
          </p>
        ) : null}
      </StepCard>

      <button
        onClick={() => router.push('/')}
        disabled={!allReady}
        className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold transition-all hover:scale-[1.01] disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ background: allReady ? 'linear-gradient(135deg, var(--primary), var(--accent))' : 'var(--bg-elevated)', color: allReady ? 'white' : 'var(--text-subtle)', border: allReady ? 'none' : '1px solid var(--border)' }}
      >
        {allReady ? 'Enter your vault' : 'Complete the steps above to continue'}
        {allReady && <ArrowRight size={16} />}
      </button>
    </div>
  )
}

function StepCard({ n, title, icon: Icon, done, children }: {
  n: number; title: string; icon: React.ElementType; done: boolean; children: React.ReactNode
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: done ? 'rgba(29,155,108,0.15)' : 'var(--icon-grad)' }}>
          {done ? <CheckCircle2 size={16} style={{ color: 'var(--success)' }} /> : <Icon size={16} style={{ color: 'var(--primary)' }} />}
        </div>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          <span style={{ color: 'var(--text-subtle)' }}>Step {n} · </span>{title}
        </h2>
      </div>
      <div className="pl-11">{children}</div>
    </div>
  )
}

function ModelPicker({ role, label, current, ok, optional, installed, active, pulling, pullMsg, pullPct, onSelect, onPull }: {
  role: Role; label: string; current: string; ok: boolean; optional?: boolean
  installed: string[]; active: boolean; pulling: string | null; pullMsg: string; pullPct: number | null
  onSelect: (model: string) => void; onPull: (model: string) => void
}) {
  const [custom, setCustom] = useState('')
  // Suggestions for this role that aren't installed yet (offer a Pull).
  const suggestable = SUGGESTIONS[role].filter(s => !installed.includes(s.name) && !installed.includes(`${s.name}:latest`))
  // Dropdown options = installed models, plus the current value if it isn't installed.
  const options = Array.from(new Set([...(current && !installed.includes(current) ? [current] : []), ...installed]))

  return (
    <div className="rounded-lg px-3 py-2.5 flex flex-col gap-2" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        {ok ? <CheckCircle2 size={15} style={{ color: 'var(--success)' }} />
            : <XCircle size={15} style={{ color: 'var(--text-subtle)' }} />}
        <span className="text-xs flex-1" style={{ color: 'var(--text-muted)' }}>
          {label}{optional && <span style={{ color: 'var(--text-subtle)' }}> · optional (image ingestion)</span>}
        </span>
        {ok && <span className="text-xs" style={{ color: 'var(--success)' }}>active</span>}
      </div>

      {/* Choose from installed models */}
      {options.length > 0 ? (
        <select
          value={current}
          onChange={e => onSelect(e.target.value)}
          className="text-sm rounded-lg px-2.5 py-1.5 outline-none font-mono"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
        >
          {options.map(m => (
            <option key={m} value={m}>{m}{installed.includes(m) ? '' : ' (not installed)'}</option>
          ))}
        </select>
      ) : (
        <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>No models installed yet — pull one below.</p>
      )}

      {/* Suggestions to pull */}
      {suggestable.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>Suggested:</span>
          {suggestable.map(sug => {
            const isPulling = pulling === sug.name
            return (
              <button
                key={sug.name}
                onClick={() => onPull(sug.name)}
                disabled={!!pulling}
                title={sug.note}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-mono transition-all hover:scale-[1.02] disabled:opacity-50"
                style={{ background: 'var(--primary-tint)', color: 'var(--primary)', border: '1px solid var(--border)' }}
              >
                {isPulling ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                {sug.name}
                <span style={{ color: 'var(--text-subtle)' }}>· {sug.note}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Any custom model name */}
      <div className="flex gap-2">
        <input
          value={custom}
          onChange={e => setCustom(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && custom.trim()) onPull(custom.trim()) }}
          placeholder="…or type any Ollama model name"
          className="flex-1 text-xs rounded-lg px-2.5 py-1.5 outline-none font-mono"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
        />
        <button
          onClick={() => custom.trim() && onPull(custom.trim())}
          disabled={!custom.trim() || !!pulling}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02] disabled:opacity-50"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
        >
          <Download size={11} /> Pull
        </button>
      </div>

      {/* Live download progress for this row's model */}
      {active && pulling && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs" style={{ color: 'var(--primary)' }}>
            <span className="flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> {pulling} · {pullMsg}
            </span>
            {pullPct != null && <span className="font-mono">{pullPct}%</span>}
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-surface)' }}>
            <div
              className="h-full transition-all duration-300"
              style={{
                width: pullPct != null ? `${pullPct}%` : '40%',
                background: 'linear-gradient(90deg, var(--primary), var(--accent))',
                opacity: pullPct != null ? 1 : 0.5,
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
