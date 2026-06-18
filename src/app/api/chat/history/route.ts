import { NextResponse } from 'next/server'
import { getHistory, clearHistory } from '@/lib/chatHistory'

// Restore the recent (last-7-days) chat thread on page load.
export async function GET() {
  return NextResponse.json({ messages: getHistory() })
}

// Clear the whole thread.
export async function DELETE() {
  clearHistory()
  return NextResponse.json({ success: true })
}
