// Unified text extraction for vault import. Turns a source file into one or more
// plain-text documents the ingest model can structure. Each format is handled
// locally with no external service. Some formats (Evernote .enex, multi-row .csv)
// expand into MANY documents from a single file.

export type ExtractedDoc = { title: string; text: string }

const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.text'])

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

// Strip HTML to readable text: drop script/style, turn block tags into newlines.
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

function titleFromHtml(html: string, fallback: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  return m ? decodeEntities(htmlToText(m[1])).slice(0, 120) || fallback : fallback
}

// Evernote export: an XML file containing many <note> elements.
function parseEnex(xml: string): ExtractedDoc[] {
  const out: ExtractedDoc[] = []
  for (const m of Array.from(xml.matchAll(/<note>([\s\S]*?)<\/note>/g))) {
    const block = m[1]
    const title = decodeEntities((/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? 'Untitled').trim())
    const contentRaw = /<content>([\s\S]*?)<\/content>/.exec(block)?.[1] ?? ''
    const inner = (/<!\[CDATA\[([\s\S]*?)\]\]>/.exec(contentRaw)?.[1] ?? contentRaw)
    const text = htmlToText(inner)
    if (text.trim()) out.push({ title, text })
  }
  return out
}

// Naive CSV → one Markdown-table document (good enough to capture & search it).
function csvToMarkdown(csv: string, title: string): ExtractedDoc[] {
  const rows = csv.split(/\r?\n/).filter(r => r.trim()).map(r => r.split(',').map(c => c.trim().replace(/^"|"$/g, '')))
  if (rows.length === 0) return []
  const header = rows[0]
  const body = rows.slice(1, 500) // cap
  const md = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map(r => `| ${r.join(' | ')} |`),
  ].join('\n')
  return [{ title, text: md }]
}

async function pdfToText(buffer: Buffer): Promise<string | null> {
  try {
    const { PDFParse } = await import('pdf-parse')
    return (await new PDFParse({ data: buffer }).getText()).text
  } catch { return null }
}

async function docxToText(buffer: Buffer): Promise<string | null> {
  try {
    // Optional dep — degrades gracefully if not installed.
    const mammoth = await import('mammoth')
    const res = await mammoth.extractRawText({ buffer })
    return res.value
  } catch { return null }
}

// Extract one or more documents from a file. Returns [] for unsupported types so
// the caller can fall back to saving the raw file.
export async function extractDocs(filename: string, buffer: Buffer): Promise<ExtractedDoc[]> {
  const lower = filename.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot === -1 ? '' : lower.slice(dot)
  const base = filename.slice(0, filename.lastIndexOf('.') === -1 ? filename.length : filename.lastIndexOf('.'))

  if (TEXT_EXTS.has(ext)) return [{ title: base, text: buffer.toString('utf-8') }]
  if (ext === '.html' || ext === '.htm') {
    const html = buffer.toString('utf-8')
    return [{ title: titleFromHtml(html, base), text: htmlToText(html) }]
  }
  if (ext === '.enex') return parseEnex(buffer.toString('utf-8'))
  if (ext === '.csv') return csvToMarkdown(buffer.toString('utf-8'), base)
  if (ext === '.json') return [{ title: base, text: buffer.toString('utf-8').slice(0, 20000) }]
  if (ext === '.pdf') { const t = await pdfToText(buffer); return t ? [{ title: base, text: t }] : [] }
  if (ext === '.docx') { const t = await docxToText(buffer); return t ? [{ title: base, text: t }] : [] }
  return []
}

// Extensions the importer accepts (images handled by the single-file drop path).
export const IMPORT_EXTS = ['.md', '.markdown', '.txt', '.text', '.html', '.htm', '.enex', '.csv', '.json', '.pdf', '.docx']
