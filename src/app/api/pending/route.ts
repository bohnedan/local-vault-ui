import { NextResponse } from 'next/server'
import { listPending } from '@/lib/pending'

// List queued proposals awaiting review (lightweight: no full change bodies).
export async function GET() {
  const items = listPending().map(p => ({
    id: p.id,
    createdAt: p.createdAt,
    origin: p.origin,
    summary: p.summary,
    changeCount: Array.isArray(p.changes) ? p.changes.length : 0,
  }))
  return NextResponse.json({ count: items.length, items })
}
