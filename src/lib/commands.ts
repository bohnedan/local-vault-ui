// Registry of LOCAL vault commands. Every command here runs entirely through
// local Ollama (via /api/commands/local) and produces the same change-proposal
// contract as the curation flow ({ changes, log_entry, summary }), which the user
// reviews as diffs before anything is written. No command in this app touches a
// cloud API — vault data never leaves the device.

export type CommandMode = 'local-model' | 'local-deterministic' | 'local-proposal'

export type LocalCommand = {
  id: string
  title: string
  desc: string
  icon: string
  mode: CommandMode
  inputLabel: string
  inputPlaceholder: string
  // How many vault chunks to retrieve as context (0 = none)
  retrieveK: number
  // Command-specific instructions appended to the shared AI-first system prompt.
  // The model must always respond with the change-proposal JSON contract.
  instructions: string
}

export const CONTRACT_INSTRUCTIONS = `
Respond with ONLY valid JSON in this exact shape, no other text, no markdown fences:
{
  "changes": [
    { "path": "Folder/Note.md", "action": "create" | "update", "content": "...FULL file content..." },
    { "action": "move", "from": "Old/Path.md", "to": "New/Path.md" },
    { "action": "delete", "path": "Folder/Obsolete.md" }
  ],
  "log_entry": "one short paragraph describing what was done and why, for the operations log",
  "summary": "one sentence summary for the UI"
}
As the vault's caretaker you may also reorganize it, not just write notes:
- "move" renames or relocates a note (e.g. file a stray note into the right folder, rename to match
  conventions). Optionally include "content" to also rewrite it during the move.
- "delete" removes a note (use sparingly — only for clear duplicates or explicitly obsolete notes).
- To move INFORMATION from note A to note B: emit an "update" for B with the merged content AND an
  "update" for A with the moved section removed (or a "delete" of A if it becomes empty).
Every change is shown to the user as a reviewable diff before anything is written — propose freely.
When updating an existing file, return its FULL new content, not a diff — and PRESERVE the existing
content that still holds, integrating your changes into it. Add new facts, correct only what's
contradicted, and never drop unrelated sections. You are extending existing knowledge, not replacing it.
Follow the vault's AI-first rules. Each note's "content" MUST be structured in this exact order:
1. YAML frontmatter as the very FIRST thing — real YAML between "---" fences (NOT inside a markdown code block),
   e.g. starting literally with a line of "---". Include fields like date, type, tags, related-people,
   related-projects, confidence.
2. A "## For future Claude" section: 2-3 plain-English sentences summarizing the note.
3. The note body, using [[wikilinks]] for any person/project/client referenced, with recency markers and
   confidence levels where relevant.
Only state facts present in the user's input or the retrieved context — do NOT invent emails, names, or details.`

export const LOCAL_COMMANDS: LocalCommand[] = [
  {
    id: 'synthesize',
    title: 'Synthesize',
    desc: 'Pull together a topic, or recap a time period',
    icon: 'Layers',
    mode: 'local-model',
    inputLabel: 'A topic, or a time period',
    inputPlaceholder: 'e.g. everything I know about local AI / RAG — or "this week"',
    retrieveK: 7,
    instructions: `Read the retrieved notes and produce ONE coherent note, basing it ONLY on the retrieved
context — never fabricate. Decide which kind of output the user's input asks for:
- TOPIC (e.g. "local AI", "the audit project") → write a permanent synthesis at Knowledge/<Topic>.md that
  connects ideas across the source notes, cites every source with [[wikilinks]], and marks confidence levels.
- TIME PERIOD (e.g. "today", "this week", "this month") → write a recap at Knowledge/Recaps/{{TODAY}} Recap.md
  summarizing what happened, decisions made, and open follow-ups, citing source notes with [[wikilinks]].`,
  },
  {
    id: 'health',
    title: 'Vault Health',
    desc: 'Scan vault structure for issues',
    icon: 'Activity',
    mode: 'local-deterministic',
    inputLabel: '',
    inputPlaceholder: '',
    retrieveK: 0,
    instructions: '',
  },
  {
    id: 'interlink',
    title: 'Interlink',
    desc: 'Grow the graph — add wikilinks & resolve broken links',
    icon: 'Network',
    mode: 'local-proposal',
    inputLabel: '',
    inputPlaceholder: '',
    retrieveK: 0,
    instructions: '',
  },
]

export function getLocalCommand(id: string): LocalCommand | undefined {
  return LOCAL_COMMANDS.find(c => c.id === id)
}
