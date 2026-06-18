'use client'

import { useEffect, useRef } from 'react'
import { useToast } from '@/components/shared/Toast'

// In-app caretaking scheduler. While the app is open it keeps the embedding index
// fresh on an interval, and runs one fuller "nightly" caretake (sync + health +
// log) per day at the configured hour. Everything runs locally against the vault.
//
// Why client-side and not OS cron: it's cross-platform (identical on Windows +
// Mac), needs no install/admin rights, and "runs while the app is open" matches
// how a desktop second-brain is actually used. It is NOT a true headless daemon —
// if the app is closed at 3am, the nightly run happens at next launch instead
// (we run a catch-up if the day was missed). For always-on scheduling, pair this
// with an OS cron hitting POST /api/caretake — documented in the README.

const SYNC_AT = 'vault-ui:lastSyncMs'
const FULL_ON = 'vault-ui:lastFullDate' // YYYY-MM-DD of last nightly full run
const TICK_MS = 5 * 60 * 1000 // re-evaluate every 5 minutes

type Schedule = { caretakeEnabled: boolean; caretakeHour: number; syncIntervalHours: number }

function todayStr() {
  return new Date().toLocaleDateString('en-CA') // YYYY-MM-DD, local
}

// Guard against React StrictMode's double-mount and concurrent runs.
let running = false

export function AutoCaretake() {
  const { showToast } = useToast()
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false

    async function getSchedule(): Promise<Schedule | null> {
      try {
        const r = await fetch('/api/caretake', { cache: 'no-store' })
        if (!r.ok) return null
        return (await r.json()) as Schedule
      } catch {
        return null
      }
    }

    async function run(mode: 'sync' | 'full') {
      if (running) return
      running = true
      try {
        const r = await fetch('/api/caretake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        })
        if (!r.ok) return
        const d = (await r.json()) as {
          sync: { notes: number; chunks: number }
          health: { scanned: number; issues: unknown[] } | null
          fixesApplied?: number
          proposalsQueued?: number
        }
        if (mode === 'full') {
          const parts = [`${d.fixesApplied ?? 0} fix(es) applied`]
          if (d.proposalsQueued) parts.push(`${d.proposalsQueued} proposal(s) to review`)
          showToast(`Nightly caretake done — ${parts.join(', ')}`, 'success')
        } else if (d.sync.notes > 0) {
          // Only speak up when something actually changed.
          showToast(`Index refreshed — ${d.sync.notes} note(s) updated`, 'info')
        }
      } catch {
        // Local-first: a failed background run is non-fatal and silent.
      } finally {
        running = false
      }
    }

    async function tick() {
      if (cancelled) return
      const sched = await getSchedule()
      if (!sched || !sched.caretakeEnabled) return

      const now = Date.now()

      // 1) Periodic index sync.
      const lastSync = Number(localStorage.getItem(SYNC_AT) ?? 0)
      const intervalMs = Math.max(1, sched.syncIntervalHours) * 60 * 60 * 1000
      if (now - lastSync >= intervalMs) {
        localStorage.setItem(SYNC_AT, String(now))
        await run('sync')
      }

      // 2) Nightly full caretake — once per local day, at/after the chosen hour.
      // Catch-up: if the app was closed past the hour, the first launch that day
      // still runs it.
      const today = todayStr()
      const lastFull = localStorage.getItem(FULL_ON)
      if (lastFull !== today && new Date().getHours() >= sched.caretakeHour) {
        localStorage.setItem(FULL_ON, today)
        await run('full')
      }
    }

    void tick() // evaluate immediately on launch
    timer.current = setInterval(() => void tick(), TICK_MS)

    return () => {
      cancelled = true
      if (timer.current) clearInterval(timer.current)
    }
  }, [showToast])

  return null
}
