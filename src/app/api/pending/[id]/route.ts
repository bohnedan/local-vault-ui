import { NextRequest, NextResponse } from 'next/server'
import { getPending, removePending } from '@/lib/pending'

// Full proposal for the review surface (feeds straight into <ProposalReview/>).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const p = getPending(id)
  if (!p) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(p)
}

// Remove a proposal once it's been applied or discarded.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  removePending(id)
  return NextResponse.json({ success: true })
}
