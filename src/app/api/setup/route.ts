import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getConfig, setConfig, type AppConfig } from '@/lib/config'
import { resetIndex } from '@/lib/embeddings'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Partial<AppConfig>
    const patch: Partial<AppConfig> = {}

    if (body.vaultPath !== undefined) {
      // Cross-platform ~ expansion (os.homedir works on Windows + macOS).
      const p = body.vaultPath.trim().replace(/^~(?=$|[/\\])/, os.homedir())
      const resolved = path.resolve(p)
      let stat: fs.Stats
      try {
        stat = fs.statSync(resolved)
      } catch {
        return NextResponse.json({ error: `Path not found: ${resolved}` }, { status: 400 })
      }
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: `Not a directory: ${resolved}` }, { status: 400 })
      }
      patch.vaultPath = resolved
    }

    if (body.chatModel !== undefined) patch.chatModel = body.chatModel.trim()
    if (body.writerModel !== undefined) patch.writerModel = body.writerModel.trim()
    if (body.librarianModel !== undefined) patch.librarianModel = body.librarianModel.trim()
    if (body.embedModel !== undefined) patch.embedModel = body.embedModel.trim()
    if (body.visionModel !== undefined) patch.visionModel = body.visionModel.trim()

    // Keep the writer/librarian split INHERITING from the chat model until the user
    // explicitly overrides a role. setConfig persists every resolved field, so once
    // anything is saved these roles become concrete — without this, a single-model
    // user who later changes their chat model would leave both roles pinned to the
    // old one. So: if chat model changes and a role still tracks the old chat model
    // (and isn't being set in this same request), move it to the new chat model too.
    if (patch.chatModel !== undefined) {
      const cur = getConfig()
      if (body.writerModel === undefined && cur.writerModel === cur.chatModel) patch.writerModel = patch.chatModel
      if (body.librarianModel === undefined && cur.librarianModel === cur.chatModel) patch.librarianModel = patch.chatModel
    }

    // Automatic-caretaking schedule.
    if (body.caretakeEnabled !== undefined) patch.caretakeEnabled = !!body.caretakeEnabled
    if (body.caretakeHour !== undefined) {
      patch.caretakeHour = Math.min(23, Math.max(0, Math.floor(body.caretakeHour)))
    }
    if (body.syncIntervalHours !== undefined) {
      patch.syncIntervalHours = Math.min(168, Math.max(1, Math.floor(body.syncIntervalHours)))
    }

    const vaultChanged = patch.vaultPath !== undefined && patch.vaultPath !== getConfig().vaultPath
    const next = setConfig(patch)

    // Switching vaults invalidates the embedding index (it held the old vault's chunks).
    if (vaultChanged) {
      try { resetIndex() } catch { /* index may not exist yet */ }
    }

    return NextResponse.json({ success: true, config: next, vaultChanged })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Save failed' },
      { status: 500 }
    )
  }
}
