# Model selection — writer vs. librarian

This vault talks to **local** models only (via Ollama). The app no longer assumes a
single chat model does everything. Instead it splits generative work across two
roles you can configure independently in **Settings → Local AI models**:

| Role          | Config key       | What it does                                                                 |
| ------------- | ---------------- | --------------------------------------------------------------------------- |
| **Writer**    | `writerModel`    | Prose: chat answers, merging new info into an existing note.                |
| **Librarian** | `librarianModel` | Structure: curation/ingest/command proposals, taxonomy, filing, dedup, link suggestions — all the `format: 'json'` work. |
| Embedding     | `embedModel`     | Retrieval index (see *Retrieval matters more than you think* below).        |
| Vision        | `visionModel`    | OCR / image description on ingest.                                          |

Both `writerModel` and `librarianModel` **default to `chatModel`**, so a single-model
setup keeps working exactly as before. The split is opt-in: set them apart only when
you want it (and have the RAM to swap or co-load two models).

---

## Why split at all?

A knowledge vault has two fundamentally different jobs, and the models that are best
at each are not the same one.

### Librarian

Reads, extracts, organizes. In this app that's every call that asks the model to
return a **structured change-proposal** (`{ changes, log_entry, summary }` JSON):

- Curate page (`/api/curate`)
- Drag-and-drop ingest (`/api/vault/ingest`) and bulk import (`/api/import/batch`)
- Slash-commands (`/api/commands/local`)
- Chat **edit mode** (`/api/chat`, `mode: 'edit'`)
- The nightly caretaker's curation pass (`src/lib/caretake.ts`)

These tasks reward: multimodal capability, long context, extraction accuracy, and
clean **structured output**. They're "taxonomy generation" work — turn 200 loose
notes into `AI / Foundations / Training / Alignment / …`, find duplicates, suggest
`[[wikilinks]]`. Qwen3-VL–class models tend to be very good here, and OCR is a
substantial win for them specifically.

### Writer

Produces prose a human reads. In this app:

- Chat **ask mode** answers (`/api/chat`)
- Note merges (`src/lib/merge.ts`) — integrating new content into an existing note
  while preserving voice and structure

These reward writing quality, coherence, and stylistic consistency. Gemma-class
models tend to produce more natural prose and cleaner educational explanations.

### Rough head-to-head

| Task                      | Tends to win | Notes                                              |
| ------------------------- | ------------ | -------------------------------------------------- |
| OCR / reading screenshots | **Librarian (Qwen-VL)** | By a wide margin — the main reason to run it.   |
| Entity / relationship extraction | **Librarian** | Structured output accuracy.                |
| Topic hierarchy / filing  | **Librarian** | Cleaner taxonomies.                                |
| Summarizing *text*        | Writer (close) | Gemma often writes the nicer summary.            |
| Summarizing *PDFs/images* | **Librarian** | It actually understands the source.                |
| Wiki-page / note prose    | **Writer**   | Slight edge — style and coherence.                 |

---

## The real constraint: RAM

The split is only worth it if you can afford it. Approximate footprints:

| Model              | Memory      |
| ------------------ | ----------- |
| Gemma 4 12B Q4     | ~8–10 GB    |
| Qwen3-VL 8B Q4     | ~7–9 GB     |
| Ollama + OS overhead | ~3–5 GB   |

### 8–16 GB Mac — **one model**

Don't co-load two. Either:

- Run a **single multimodal model** for both roles. `qwen3.5:4b` (~3.4 GB) covers
  chat, curation, *and* image OCR — set it as chat + vision and leave writer/librarian
  defaulting to it. This is the recommended low-RAM setup.
- Or set `writerModel` and `librarianModel` to two different models and let Ollama
  **swap** them in and out. It works, but you pay a model-load stall each time the
  active role changes (e.g. an ask-mode answer right after an ingest). Tolerable for a
  single user; annoying under bursty use.

### 48 GB+ Mac — **two models**

Here the split earns its keep. You can realistically keep both resident:

```
PDFs / screenshots / papers
        │
        ▼
   Librarian  (e.g. Qwen3-VL, aggressively quantized)
        │  → taxonomy, entity extraction, link suggestions, JSON proposals
        ▼
   Writer     (e.g. Gemma 4 12B)
        │  → wiki pages, summaries, merged notes
        ▼
   Reviewed diffs → vault
```

Set `librarianModel` to a strong VL model and `writerModel` to a strong prose model.
Ollama keeps both loaded; no swap stall.

---

## Ollama vs. vLLM

Stay on **Ollama**. For a single-user, local vault its advantages dominate: trivial
model management, GGUF support, Apple-Silicon friendliness, a simple API, low
operational complexity. vLLM only pulls ahead under many concurrent requests / multiple
users / production indexing pipelines — none of which a personal vault hits. The
benefit here is marginal and the operational cost is not.

---

## Retrieval matters more than you think

A common mistake is pairing a powerful generative model with weak retrieval. For this
vault, **embeddings + reranking often move quality more than upgrading the generator**
from an 8B to a 32B model. The chain that matters is:

```
strong embedding model  →  good reranker  →  librarian  →  writer
```

If you're going to invest effort, invest it in the **embedding model** (`embedModel`)
and retrieval quality first. Note linking, topic discovery, and "find related
concepts" depend more on retrieval than on the generator. Strong options as of
mid-2026, all pullable from Ollama:

- **`qwen3-embedding`** (0.6B / 4B / 8B) — best easy local choice; long a top open
  family on MTEB, first-class Ollama support. Pick the size that fits your RAM.
- **`embeddinggemma`** (~300M) — Google's lightweight text embedder (from Gemma);
  great when RAM is tight and you still want quality.
- **Qwen3-VL-Embedding** (2B / 8B) — *multimodal* embedder that beats text-only models
  on mixed media. Only worth it if you actually embed images: **this app's index is
  text-only today** (OCR happens in the librarian generative step, then text is
  embedded), so a multimodal embedder buys nothing here until image-embedding is wired
  in. Until then, stick with `qwen3-embedding`.

⚠️ **Changing `embedModel` requires a full re-index** — a different model means a
different vector space (and often different dimensions), so old vectors aren't
comparable. After switching, click **Rebuild index** in Settings.

---

## How to configure it

In **Settings → Local AI models**:

1. Pick a **Chat model** — the default for both generative roles.
2. (Optional) Pick a **Writer model** and/or **Librarian model** to override per role.
   Leaving them on the chat model is the single-model setup.

Or seed defaults via env (copied into `data/config.json` on first run):

```bash
OLLAMA_CHAT_MODEL=qwen2.5:3b          # default for both roles
OLLAMA_WRITER_MODEL=gemma4:12b        # optional — prose
OLLAMA_LIBRARIAN_MODEL=qwen3-vl:8b    # optional — structure/OCR
OLLAMA_EMBED_MODEL=qwen3-embedding:8b
OLLAMA_VISION_MODEL=llama3.2-vision   # optional — image ingest
```

### Recommended presets

| Machine        | Writer        | Librarian      | Embedding                       |
| -------------- | ------------- | -------------- | ------------------------------- |
| 8–16 GB Mac    | `qwen3.5:4b`  | `qwen3.5:4b`   | `embeddinggemma` or `qwen3-embedding:0.6b` |
| 48 GB+ Mac     | `gemma4:12b`  | `qwen3-vl:8b`+ | `qwen3-embedding:8b`            |

(Model names are illustrative and current as of June 2026 — pull whatever your Ollama
has. The app accepts any installed model name. On 16 GB, don't co-load a 12B writer
with an 8B embedder; keep one generative model and a small embedder.)
