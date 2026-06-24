import fs from 'fs'
import path from 'path'

// Runtime configuration, stored locally in data/config.json (gitignored).
// This is what makes the app portable: each colleague picks their own vault and
// models from the UI instead of editing env files. Env vars act as defaults/seed.

const CONFIG_PATH = path.join(process.cwd(), 'data', 'config.json')

export type AppConfig = {
  vaultPath: string
  chatModel: string
  embedModel: string
  visionModel: string
  // Context window (tokens) for chat/curation requests. Bounded by TWO ceilings:
  // the model's trained max (asking beyond it degrades output) and the machine's
  // RAM/VRAM (the KV cache scales with this — too high OOMs or falls back to CPU).
  // Tune per machine + model. Too LOW silently truncates the prompt — dropping the
  // "return JSON" rule in edit mode — which surfaces as a 502 unparseable-JSON error.
  chatNumCtx: number
  // Automatic caretaking. All local, all opt-out-able from Settings.
  caretakeEnabled: boolean   // master switch for the in-app scheduler
  caretakeHour: number       // 0–23, local time, for the nightly full caretake
  syncIntervalHours: number  // how often to keep the embedding index fresh
}

function defaults(): AppConfig {
  return {
    vaultPath: process.env.VAULT_PATH ?? '',
    chatModel: process.env.OLLAMA_CHAT_MODEL ?? 'qwen2.5:3b',
    embedModel: process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
    visionModel: process.env.OLLAMA_VISION_MODEL ?? 'llama3.2-vision',
    chatNumCtx: Number(process.env.OLLAMA_NUM_CTX) || 16384,
    caretakeEnabled: true,
    caretakeHour: 3,
    syncIntervalHours: 6,
  }
}

export function getConfig(): AppConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Partial<AppConfig>
    return { ...defaults(), ...raw }
  } catch {
    return defaults()
  }
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...getConfig(), ...patch }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8')
  return next
}

// A vault is "configured" only if the path is set and points at a real directory.
export function isConfigured(): boolean {
  const { vaultPath } = getConfig()
  if (!vaultPath) return false
  try {
    return fs.statSync(vaultPath).isDirectory()
  } catch {
    return false
  }
}
