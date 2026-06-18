# Vault UI — Local RAG + Curation for any Obsidian Vault

A local, single-user web app for browsing, searching, querying, and curating an
Obsidian vault. All AI runs **locally via [Ollama](https://ollama.com)** — vault data
never leaves the device. Point it at *your* vault; nothing is hardcoded.

## Quickstart (for colleagues)

```bash
# 1. Install Ollama (one time) — https://ollama.com — then make sure it's running:
ollama serve            # leave running in the background

# 2. Get the app
git clone <repo-url> vault-ui && cd vault-ui
npm install
npm run dev             # opens http://localhost:3000
```

That's it — **the app walks you through the rest.** On first launch you land on a 3-step
setup wizard:

1. **Connect your vault** — paste the path to your Obsidian folder (e.g. `~/Documents/Second-Brain`). Validated live.
2. **Local AI models** — it detects Ollama and offers a one-click **Pull** for any missing model (chat + embeddings), with download progress. No terminal needed.
3. **Build the index** — one click embeds your notes locally so Chat can cite them.

When all three are green, click **Enter your vault**. You can change the vault or models
anytime from **Settings** in the sidebar. No `.env` editing required.

## Security boundary (read this)

**Allowed:** local inference (Ollama), local storage (SQLite), the local vault filesystem.

**Not allowed / not present in the codebase:** OpenAI / Anthropic / Gemini APIs, external
vector databases, external telemetry. The only module that makes outbound HTTP requests is
[`src/lib/ollama.ts`](src/lib/ollama.ts), and it asserts the target host is `localhost`
(`127.0.0.1`/`::1`) before every call. Everything else is filesystem-only.

> Vault data NEVER leaves the device.

## Stack

- Next.js 14 (App Router) + TypeScript + Tailwind
- Ollama: `qwen2.5:3b` (chat) + `nomic-embed-text` (embeddings)
- `better-sqlite3` for the local embedding index (cosine similarity over stored chunk vectors)

## Configuration

All config is set **in the app** (the setup wizard / Settings) and stored locally in
`data/config.json` (gitignored): vault path, chat model, embedding model. You never need
to edit files.

`.env.local` is optional and only provides **defaults** the wizard seeds from:

```
OLLAMA_HOST=http://localhost:11434   # only change if Ollama runs on a non-default port
OLLAMA_CHAT_MODEL=qwen2.5:3b         # default offered in the wizard
OLLAMA_EMBED_MODEL=nomic-embed-text  # default offered in the wizard
# VAULT_PATH is optional — colleagues set it in the wizard instead
```

Recommended models on a 16 GB machine: `qwen2.5:3b` (chat) + `nomic-embed-text` (embeddings).
Larger chat models (e.g. `gemma4`) give better quality but are slower; swap anytime in Settings.

## Features

| Page | What it does |
|------|--------------|
| **Dashboard** | Vault stats, recent files, quick capture, AI briefing card |
| **Chat** | Ask questions about the vault. RAG: embeds the question, retrieves the top-k chunks locally, gemma answers with clickable citations to source notes |
| **Curate** | Paste meeting notes / a summary. gemma proposes multi-file vault updates (project page, daily note, decision log, person notes) following the vault's AI-first conventions. Review per-file diffs, approve/reject each, then apply. Applied changes are logged to `Logs/YYYY-MM-DD.md` and re-indexed |
| **Explorer** | File tree + markdown preview |
| **Search** | Keyword/grep search across notes |
| **Commands** | Run vault commands |

## How RAG works

1. **Index** (`src/lib/embeddings.ts`): each `.md` note is split into self-contained chunks
   (frontmatter + each heading section), embedded via `nomic-embed-text`, stored in
   `data/index.sqlite` (gitignored, rebuildable).
2. **Retrieve**: a query is embedded and scored against all chunks by cosine similarity; top-k returned.
3. **Answer**: retrieved chunks + the question go to `qwen2.5:3b`, which is instructed to answer
   only from the provided sources and cite them as `[[wikilinks]]`.

`Sync Index` (top bar) does an incremental re-embed of only notes whose mtime changed.
`POST /api/index/rebuild` does a full rebuild.

## Curation conventions

The curation prompt (`src/lib/prompts.ts`) loads the vault's `_CLAUDE.md` so proposed notes
follow the "AI-first" rules: rich frontmatter, a "For future Claude" preamble, mandatory
`[[wikilinks]]`, recency markers, and confidence levels. Nothing is written until you approve
the diff.

## The local model as caretaker

The local LLM doesn't just answer questions — it reorganizes the vault, always
behind a reviewable diff:

- **Move / rename / delete.** Curation and every command can emit `move`
  (`{from, to}`) and `delete` (`{path}`) actions, not just `create`/`update`. Ask
  e.g. *"file this stray note under Projects and rename it to match conventions"*
  or *"move the decisions from the meeting note into the project page"* — the model
  proposes the moves/edits, you approve each in the diff view
  (`src/app/api/curate/apply/route.ts`, `src/components/shared/ProposalReview.tsx`).
- **Health auto-fix.** Commands → **Vault Health** → **Auto-fix structure**
  deterministically adds missing frontmatter and a "For future Claude" preamble
  (summarised from each note's own first paragraph), 12 notes at a time, content
  preserved verbatim. Fully local, no model variance. Broken wikilinks and empty
  notes are left for a human (`src/lib/healthFix.ts`).

## Chat history & capturing conversations

Chat keeps a **lightweight, local history** — the recent thread is restored on load and **auto-clears
after 7 days** (`src/lib/chatHistory.ts`, stored in gitignored `data/chat-history.json`, capped so it
never grows large). A **Clear** button wipes it on demand. **Include conversation in vault** runs the
whole transcript through the normal ingest pipeline (`/api/chat/to-vault` → `buildIngestPrompt`) and
shows the drafted note as a diff to approve — same path as a dropped document.

## Drag-drop ingest (with notes)

Drop a `.md` / `.txt` / `.pdf` / image anywhere in the app. Before the model drafts a note you get a
**compose step** to attach **optional notes** — these are sent with the file at **high priority** and
are treated as authoritative: they're folded into the note's "For future Claude" summary and win over
the extracted/OCR'd text where they conflict (`src/lib/prompts.ts` → `buildIngestPrompt`). Use it to
flag what matters ("this is the signed contract — surface the Aug 15 deadline, link [[Client]]"). The
drafted note is shown as a diff to approve before anything is written.

## Indexing: when it runs & how to debug it

The embedding index updates on several triggers so "I added a note → it's
searchable" just works:

- **Live watcher** (`src/lib/watcher.ts`) — watches the vault dir and incrementally
  re-indexes ~3s after any `.md` add/change/delete, **including edits made in
  Obsidian**. (Recursive watching works on macOS + Windows; on Linux it falls back
  to the periodic sync below.)
- **On every applied change** (curate/command/ingest) and **on chat**.
- **Scheduled** sync every *N* hours + nightly full caretake (see below).

**If notes aren't showing up** (e.g. "chunk totals don't change"), open **Settings →
Diagnostics** (`/api/diagnostics`). It shows, side by side: the configured vault
path, **notes on disk vs. indexed notes vs. chunks**, the embed model + Ollama
reachability, the **exact index DB path and launch cwd**, and a list of on-disk
notes not yet indexed — with a plain-language verdict and a one-click **Rebuild
index**. The usual culprits it surfaces: a wrong/nested vault path, the embed model
not installed, or the app launched from a different working directory (which uses a
different `data/index.sqlite`).

## Vault initialization & caretaking

**Initialize an empty vault.** Point the wizard at a brand-new/empty folder and Step 1 offers
**Initialize vault** — it scaffolds the AI-first skeleton (`_CLAUDE.md` + `Projects/`, `Daily/`,
`Logs/`, `People/`, `Knowledge/`, `Assets/`) so curation has conventions to follow. It's
idempotent and never overwrites an existing file (`src/lib/vaultInit.ts`).

**Automatic caretaking** (Settings → Step 4). While the app is open, an in-app scheduler
(`src/components/layout/AutoCaretake.tsx`) keeps the index fresh and runs a nightly health check —
all local:

- **Index sync** every *N* hours (default 6) — incremental re-embed of changed notes.
- **Nightly full caretake** at a chosen hour (default 03:00). Two tiers — *auto-apply the safe steps,
  queue the risky ones for review*:
  - **Auto-applied (safe, deterministic):** index sync + a health scan + structural health fixes
    (add missing frontmatter / "For future Claude" preamble, body preserved verbatim).
  - **Queued for review (model-driven):** a curation proposal over the notes that changed in the last
    24h (link related notes, file strays via `move`, merge duplicates, synthesize a `Knowledge/` note
    when warranted). It is **never written unattended** — it lands in the **Review** queue.
  - A summary is appended to `Logs/YYYY-MM-DD.md`. If the app was closed past the hour, it catches up
    at next launch.

**Review queue** (sidebar → **Review**, with a count badge). Proposals the overnight caretaker prepared
but did not write. Open each, approve/reject the diffs (`/api/pending`, `data/pending/*.json`,
gitignored). This keeps the propose→review→approve safety model even for unattended runs.

It's a foreground scheduler, not a headless daemon — it only runs while the app is open. For
**always-on** scheduling, point an OS cron/Task Scheduler at the same endpoint:

```bash
# macOS/Linux cron — nightly full caretake at 03:00 (app or no app)
0 3 * * * curl -s -X POST http://localhost:3000/api/caretake -H 'Content-Type: application/json' -d '{"mode":"full"}'
```

`POST /api/caretake` accepts `{"mode":"sync"}` (index only) or `{"mode":"full"}` (sync + health +
log). `GET /api/caretake` returns the current schedule. Disable the in-app scheduler any time from
Settings.

## Notes

- Local-only tool — no auth; bind to localhost only.
- The embedding index (`data/`) is rebuildable and gitignored.
- The chat model is configurable via `OLLAMA_CHAT_MODEL` (default `qwen2.5:3b` — fast on a 16GB M-series machine). Larger models like `gemma4` give better quality but the curation flow (which generates full file contents) can be slow. Curation output is always a proposal to review, not an autonomous write.
