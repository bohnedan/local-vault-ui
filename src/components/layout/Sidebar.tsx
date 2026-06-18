'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Terminal,
  FolderOpen,
  Search,
  BookOpen,
  MessageSquare,
  Sparkles,
  Settings,
  Moon,
} from 'lucide-react'
import { cn } from '@/lib/cn'

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/curate', label: 'Curate', icon: Sparkles },
  { href: '/review', label: 'Review', icon: Moon },
  { href: '/commands', label: 'Commands', icon: Terminal },
  { href: '/explorer', label: 'Explorer', icon: FolderOpen },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/setup', label: 'Settings', icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()
  const [vaultLabel, setVaultLabel] = useState('—')
  const [pending, setPending] = useState(0)

  useEffect(() => {
    fetch('/api/setup/status')
      .then(r => r.json())
      .then((d: { vault?: { path?: string } }) => {
        const p = d.vault?.path
        if (p) setVaultLabel(p.split('/').filter(Boolean).pop() ?? p)
      })
      .catch(() => {})
    fetch('/api/pending')
      .then(r => r.json())
      .then((d: { count?: number }) => setPending(d.count ?? 0))
      .catch(() => {})
  }, [pathname])

  return (
    <aside
      className="flex flex-col w-[240px] flex-shrink-0 h-screen border-r"
      style={{
        background: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* Logo */}
      <div
        className="flex items-center gap-3 px-5 py-5 border-b"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, var(--primary), var(--accent))' }}
        >
          <BookOpen size={16} className="text-white" />
        </div>
        <div>
          <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Vault UI</p>
          <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>Knowledge Steering</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== '/' && pathname.startsWith(href))
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150',
                active
                  ? 'text-white'
                  : 'hover:text-white'
              )}
              style={
                active
                  ? {
                      background: 'var(--icon-grad)',
                      color: 'var(--text)',
                      borderLeft: '2px solid var(--primary)',
                    }
                  : {
                      color: 'var(--text-muted)',
                    }
              }
            >
              <Icon
                size={18}
                style={{ color: active ? 'var(--primary)' : 'inherit' }}
              />
              <span className="flex-1">{label}</span>
              {href === '/review' && pending > 0 && (
                <span
                  className="text-xs font-semibold px-1.5 py-0.5 rounded-full min-w-[20px] text-center"
                  style={{ background: 'var(--primary)', color: 'white' }}
                >
                  {pending}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div
        className="px-5 py-4 border-t"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
          {vaultLabel}
        </p>
      </div>
    </aside>
  )
}
