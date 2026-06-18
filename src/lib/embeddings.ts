import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'
import { listAllNotes, resolveVaultPath } from '@/lib/vault'
import { ollamaEmbed } from '@/lib/ollama'

const DB_PATH = path.join(process.cwd(), 'data', 'index.sqlite')

type ChunkRow = {
  id: number
  note_path: string
  heading: string
  content: string
  embedding: string
  updated_at: number
}

export type RetrievedChunk = {
  notePath: string
  heading: string
  content: string
  score: number
}

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (db) return db
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  db = new Database(DB_PATH)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_path TEXT NOT NULL,
      heading TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_note_path ON chunks(note_path);
  `)
  return db
}

// Target max characters per chunk. Embedding models have a fixed context window
// (nomic-embed-text ~2048 tokens ≈ 8k chars; smaller models far less), so a single
// oversized section/note must never be sent whole or the embed call 400s. ~2000
// chars (~500 tokens) is also a good retrieval granularity. The resilient embed
// below further splits if a model's window is even smaller.
const MAX_CHUNK_CHARS = 2000
// Carry the tail of each chunk into the next so a fact split across a boundary
// stays retrievable in at least one chunk.
const CHUNK_OVERLAP_CHARS = 200

// Last `n` chars of a string, snapped forward to a line boundary when possible.
function tailOverlap(s: string, n: number): string {
  if (s.length <= n) return s
  const slice = s.slice(s.length - n)
  const nl = slice.indexOf('\n')
  return nl === -1 ? slice : slice.slice(nl + 1)
}

// Split text into pieces no longer than maxLen, preferring line boundaries, with
// `overlap` characters shared between consecutive pieces. A single over-long line
// is hard-split into overlapping windows.
function splitText(text: string, maxLen: number, overlap = CHUNK_OVERLAP_CHARS): string[] {
  if (text.length <= maxLen) return [text]
  const out: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    if (line.length > maxLen) {
      if (cur) { out.push(cur); cur = '' }
      const step = Math.max(1, maxLen - overlap)
      for (let i = 0; i < line.length; i += step) out.push(line.slice(i, i + maxLen))
      continue
    }
    if (cur && cur.length + line.length + 1 > maxLen) {
      out.push(cur)
      cur = tailOverlap(cur, overlap) // seed the next chunk with the overlap
    }
    cur = cur ? `${cur}\n${line}` : line
  }
  if (cur) out.push(cur)
  return out
}

// Split a note into self-contained, size-bounded chunks: the frontmatter is
// prefixed to every chunk so each stands alone, per the vault's AI-first rule.
export function chunkNote(notePath: string, content: string): Array<{ heading: string; content: string }> {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  const frontmatter = fmMatch ? fmMatch[0] : ''
  const body = fmMatch ? content.slice(fmMatch[0].length) : content

  // Leave room for the prefixed frontmatter within the chunk budget.
  const budget = Math.max(500, MAX_CHUNK_CHARS - frontmatter.length)

  const sections = body.split(/\n(?=#{1,6}\s)/)
  const chunks: Array<{ heading: string; content: string }> = []

  const pushSection = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    const headingMatch = /^(#{1,6})\s+(.*)/.exec(trimmed)
    const heading = headingMatch ? headingMatch[2].trim() : '(intro)'
    for (const piece of splitText(trimmed, budget)) {
      chunks.push({ heading, content: `${frontmatter}${piece}` })
    }
  }

  for (const section of sections) pushSection(section)
  if (chunks.length === 0 && body.trim()) pushSection(body)

  return chunks
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export async function rebuildIndex(): Promise<{ notes: number; chunks: number; skipped: string[] }> {
  const database = getDb()
  database.exec('DELETE FROM chunks')
  return embedNotes(listAllNotes().map(f => f.path))
}

// Drop all chunks without re-embedding — used when switching to a different vault
// so stale chunks from the previous vault can't leak into retrieval.
export function resetIndex(): void {
  getDb().exec('DELETE FROM chunks')
}

export async function syncIndex(): Promise<{ notes: number; chunks: number; skipped: string[] }> {
  const database = getDb()
  const notes = listAllNotes()

  const stale: string[] = []
  for (const note of notes) {
    const row = database.prepare(
      'SELECT MAX(updated_at) as updated_at FROM chunks WHERE note_path = ?'
    ).get(note.path) as { updated_at: number | null }

    const mtime = Math.floor(note.mtime.getTime() / 1000)
    if (!row.updated_at || mtime > row.updated_at) {
      stale.push(note.path)
    }
  }

  const del = database.prepare('DELETE FROM chunks WHERE note_path = ?')

  // Prune chunks for notes that no longer exist in the vault (deleted/renamed),
  // so they can't pollute retrieval.
  const present = new Set(notes.map(n => n.path))
  const indexed = database.prepare('SELECT DISTINCT note_path FROM chunks').all() as Array<{ note_path: string }>
  for (const row of indexed) {
    if (!present.has(row.note_path)) del.run(row.note_path)
  }

  // Drop chunks for stale notes before re-embedding
  for (const p of stale) del.run(p)

  return embedNotes(stale)
}

function isContextError(err: unknown): boolean {
  return /context length|exceeds|too long|400/i.test(String(err))
}

// Embed a chunk, but if the model rejects it for length, split and embed the
// halves (recursively) so the index still gets built. Adapts to any embed
// model's context window. Returns one (text, embedding) pair per surviving piece.
async function embedResilient(text: string): Promise<Array<{ text: string; embedding: number[] }>> {
  try {
    return [{ text, embedding: await ollamaEmbed(text) }]
  } catch (err) {
    if (!isContextError(err)) throw err // e.g. embed model not installed — surface it
    if (text.length <= 300) {
      // Can't split meaningfully; embed a hard-truncated head so we keep something.
      return [{ text: text.slice(0, 300), embedding: await ollamaEmbed(text.slice(0, 300)) }]
    }
    const mid = text.lastIndexOf('\n', Math.floor(text.length / 2))
    const cut = mid > 200 ? mid : Math.floor(text.length / 2)
    const left = text.slice(0, cut).trim()
    const right = text.slice(cut).trim()
    const out: Array<{ text: string; embedding: number[] }> = []
    if (left) out.push(...await embedResilient(left))
    if (right) out.push(...await embedResilient(right))
    return out
  }
}

async function embedNotes(notePaths: string[]): Promise<{ notes: number; chunks: number; skipped: string[] }> {
  const database = getDb()
  const insert = database.prepare(
    'INSERT INTO chunks (note_path, heading, content, embedding, updated_at) VALUES (?, ?, ?, ?, ?)'
  )

  let chunkCount = 0
  let done = 0
  const skipped: string[] = []

  for (const notePath of notePaths) {
    let content: string
    try {
      content = fs.readFileSync(resolveVaultPath(notePath), 'utf-8')
    } catch {
      continue
    }

    const mtime = Math.floor(fs.statSync(resolveVaultPath(notePath)).mtime.getTime() / 1000)
    const chunks = chunkNote(notePath, content)

    try {
      for (const chunk of chunks) {
        for (const piece of await embedResilient(chunk.content)) {
          insert.run(notePath, chunk.heading, piece.text, JSON.stringify(piece.embedding), mtime)
          chunkCount++
        }
      }
      done++
    } catch (err) {
      // A non-context failure on this note (e.g. transient). Skip it so the rest
      // of the index still builds, unless it's the very first note failing —
      // which usually means the embed model itself is missing.
      skipped.push(notePath)
      if (done === 0) throw err
    }
  }

  return { notes: notePaths.length, chunks: chunkCount, skipped }
}

export async function retrieve(query: string, k = 6): Promise<RetrievedChunk[]> {
  const database = getDb()
  const queryEmbedding = await ollamaEmbed(query)

  const rows = database.prepare('SELECT * FROM chunks').all() as ChunkRow[]

  const scored = rows.map(row => ({
    notePath: row.note_path,
    heading: row.heading,
    content: row.content,
    score: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding) as number[]),
  }))

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

export function indexStats(): { notes: number; chunks: number; hasIndex: boolean } {
  const database = getDb()
  const row = database.prepare(
    'SELECT COUNT(*) as chunks, COUNT(DISTINCT note_path) as notes FROM chunks'
  ).get() as { chunks: number; notes: number }
  return { ...row, hasIndex: fs.existsSync(DB_PATH) }
}
