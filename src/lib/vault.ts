import path from 'path'
import fs from 'fs'
import { getConfig } from '@/lib/config'

// Resolved at call time (not import time) so changing the vault in the UI takes
// effect immediately, without a server restart.
export function getVaultPath(): string {
  return getConfig().vaultPath
}

export const SKIP_DIRS = new Set([
  '.obsidian',
  '.git',
  'obsidian-second-brain',
  'node_modules',
  '.trash',
])

// Notes that aren't "content" — scaffolding docs and append-only operational logs.
// Their structure and example/ephemeral [[links]] shouldn't be health-flagged or
// auto-fixed (logs have no frontmatter by design, and reference throwaway things;
// flagging them caused a fix→reflag loop). Shared by the health scan and the
// link-graph builder so both treat the exact same notes as non-content.
export function isMetaNote(notePath: string): boolean {
  if (path.basename(notePath).toLowerCase() === '_claude.md') return true
  // Any note under a Logs/ or Dev Logs/ directory (operational logs).
  return notePath.split('/').some(seg => /^(dev )?logs$/i.test(seg))
}

export type FileNode = {
  name: string
  path: string
  type: 'file' | 'folder'
  children?: FileNode[]
}

export function sanitizePath(relativePath: string): string {
  // Prevent path traversal
  const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '')
  return normalized
}

export function resolveVaultPath(relativePath: string): string {
  const safe = sanitizePath(relativePath)
  return path.join(getVaultPath(), safe)
}

export function buildFileTree(dirPath: string, vaultBase: string): FileNode {
  const name = path.basename(dirPath)
  const relativePath = path.relative(vaultBase, dirPath)

  const stat = fs.statSync(dirPath)
  if (stat.isFile()) {
    return { name, path: relativePath, type: 'file' }
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const children: FileNode[] = []

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('.')) continue

    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      children.push(buildFileTree(fullPath, vaultBase))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      children.push({
        name: entry.name,
        path: path.relative(vaultBase, fullPath),
        type: 'file',
      })
    }
  }

  // Sort: folders first, then files alphabetically
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return { name, path: relativePath, type: 'folder', children }
}

export function countMarkdownFiles(dirPath: string): number {
  let count = 0
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      const fullPath = `${dirPath}/${entry.name}`
      if (entry.isDirectory()) {
        count += countMarkdownFiles(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        count++
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return count
}

export function listAllNotes(dirPath?: string): Array<{ path: string; mtime: Date }> {
  const base = getVaultPath()
  const root = dirPath ?? base
  const files: Array<{ path: string; mtime: Date }> = []

  function walk(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const stat = fs.statSync(fullPath)
          files.push({ path: path.relative(base, fullPath), mtime: stat.mtime })
        }
      }
    } catch {
      // ignore
    }
  }

  if (!base) return files
  walk(root)
  return files
}

// Move/rename a note within the vault. Both ends are path-contained. Creates the
// destination folder if needed; refuses to clobber an existing destination.
export function moveNote(from: string, to: string): void {
  const src = resolveVaultPath(from)
  const dst = resolveVaultPath(to)
  if (!fs.existsSync(src)) throw new Error(`Source not found: ${from}`)
  if (fs.existsSync(dst)) throw new Error(`Destination already exists: ${to}`)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.renameSync(src, dst)
}

// Delete a note from the vault (path-contained).
export function deleteNote(target: string): void {
  const abs = resolveVaultPath(target)
  if (!fs.existsSync(abs)) return // already gone — idempotent
  fs.rmSync(abs)
}

export function appendToLog(entry: string) {
  const today = new Date().toISOString().slice(0, 10)
  const logPath = path.join(getVaultPath(), 'Logs', `${today}.md`)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })

  const stamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const block = `\n\n## ${stamp} — ${entry.split('\n')[0]}\n\n${entry}\n`

  if (fs.existsSync(logPath)) {
    fs.appendFileSync(logPath, block, 'utf-8')
  } else {
    fs.writeFileSync(logPath, `# Vault Operations Log — ${today}${block}`, 'utf-8')
  }
}

export function getRecentFiles(dirPath: string, limit = 6): Array<{ path: string; mtime: Date }> {
  const files: Array<{ path: string; mtime: Date }> = []

  function walk(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        const fullPath = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const stat = fs.statSync(fullPath)
          files.push({ path: path.relative(dirPath, fullPath), mtime: stat.mtime })
        }
      }
    } catch {
      // ignore
    }
  }

  walk(dirPath)
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  return files.slice(0, limit)
}
