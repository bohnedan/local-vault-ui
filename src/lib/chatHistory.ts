import fs from 'fs'
import path from 'path'

// Lightweight, local chat history. A single rolling transcript stored in
// data/chat-history.json (gitignored, per-machine). Deliberately minimal: it
// auto-prunes anything older than a week on every read/write, and caps total
// length, so it never grows unbounded. No conversations/sessions model — just the
// recent thread, which is all a local "ask my vault" chat needs.

const FILE = path.join(process.cwd(), 'data', 'chat-history.json')
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // clear after a week
const MAX_MESSAGES = 400                     // hard cap so it stays small

export type Citation = { path: string; heading: string }
export type ChatMessage = { role: 'user' | 'assistant'; content: string; citations?: Citation[]; ts: number }

function read(): ChatMessage[] {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8')) as ChatMessage[]
  } catch {
    return []
  }
}

function write(messages: ChatMessage[]) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(messages, null, 2), 'utf-8')
}

function prune(messages: ChatMessage[]): ChatMessage[] {
  const cutoff = Date.now() - MAX_AGE_MS
  const fresh = messages.filter(m => m.ts >= cutoff)
  return fresh.length > MAX_MESSAGES ? fresh.slice(fresh.length - MAX_MESSAGES) : fresh
}

// Returns the pruned history, and persists the pruned form so old messages are
// actually dropped from disk after a week.
export function getHistory(): ChatMessage[] {
  const pruned = prune(read())
  return pruned
}

export function appendMessages(...msgs: Array<Omit<ChatMessage, 'ts'>>): void {
  const next = prune([...read(), ...msgs.map(m => ({ ...m, ts: Date.now() }))])
  write(next)
}

export function clearHistory(): void {
  try { fs.rmSync(FILE) } catch { /* already gone */ }
}
