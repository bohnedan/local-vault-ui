import fs from 'fs'
import path from 'path'

// Runtime configuration, stored locally in data/config.json (gitignored).
// This is what makes the app portable: each colleague picks their own vault and
// models from the UI instead of editing env files. Env vars act as defaults/seed.

const CONFIG_PATH = path.join(process.cwd(), 'data', 'config.json')

export type AppConfig = {
  vaultPath: string
  // Generative model used as the default for both roles below. Kept for back-compat
  // (single-model setups) and as the fallback writer/librarian resolve to.
  chatModel: string
  // Two-model split (see MODEL-SELECTION.md). The vault has two distinct generative
  // jobs and the best model for each isn't the same one:
  //   writerModel    — prose: chat answers, merging into an existing note.
  //   librarianModel — structure: curation/ingest/command/caretake proposals (the
  //                    format:'json' work), taxonomy, filing, dedup, link suggestions.
  // BOTH default to chatModel, so leaving them unset keeps single-model behavior.
  // Set them apart only with the RAM to swap/co-load two models.
  writerModel: string
  librarianModel: string
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
  const chatModel = process.env.OLLAMA_CHAT_MODEL ?? 'qwen2.5:3b'
  return {
    vaultPath: process.env.VAULT_PATH ?? '',
    chatModel,
    // Default both roles to the chat model; env can override each independently.
    writerModel: process.env.OLLAMA_WRITER_MODEL ?? chatModel,
    librarianModel: process.env.OLLAMA_LIBRARIAN_MODEL ?? chatModel,
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
    const merged = { ...defaults(), ...raw }
    // Back-compat: a config.json written before the writer/librarian split only has
    // chatModel. Inherit it for the roles the user hasn't explicitly set, so the
    // split is opt-in and never silently swaps in the env/global default chat model.
    if (raw.writerModel === undefined) merged.writerModel = merged.chatModel
    if (raw.librarianModel === undefined) merged.librarianModel = merged.chatModel
    return merged
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
