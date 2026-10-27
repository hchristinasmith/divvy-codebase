import type { ReactNode } from 'react'
import { LINK as SHARED_LINK } from '../../screens/Overview/styles.ts'

// An insight's markdown body (prd-04 Ruling 3, Ruling 8; #55). `body_md`
// is outside text: merchant names and memos written by strangers reach it,
// and the inbox route caps neither its length nor its content (#280). So
// this is a small parser of its own that returns React elements, and text
// only ever reaches the DOM as React text nodes. There is no raw HTML (a
// `<script>` shows as the characters `<script>`), no image (`![a](b)` shows
// its alt text), no autolink, and a link keeps its href only when the URL
// parses with an allow-listed scheme.
//
// Supported: paragraphs, `#` headings (all drawn at one card-sized level),
// `-`/`*` and `1.` lists, and inline `*em*`, `_em_`, `**strong**`, `code`
// and `[text](url)`. Anything else is text.
//
// The work is bounded: the input is cut at MAX_BODY_CHARS, no regex here
// can backtrack, closing delimiters are found through `Finder` (each search
// resumes where the last one for that delimiter stopped, so one line costs
// one pass per delimiter), and inline nesting stops at MAX_INLINE_DEPTH.

export const MAX_BODY_CHARS = 20_000
const MAX_INLINE_DEPTH = 3

const LINK_SCHEMES: ReadonlySet<string> = new Set(['https:', 'mailto:'])

// Every Bidi_Control code point: the ALM, LRM and RLM marks and the
// embedding, override and isolate controls. Each can make a label read as
// something it is not, or move an amount beside it.
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g

/** The text with every bidi control removed. */
export function stripBidi(text: string): string {
  return text.replace(BIDI_CONTROLS, '')
}

/**
 * The href to emit for a link destination, or null when it is not allowed.
 * A URL with credentials is refused: `https://bnz.co.nz@invented.example/`
 * reads as one host and goes to another.
 */
export function safeHref(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username !== '' || url.password !== '') return null
  return LINK_SCHEMES.has(url.protocol) ? url.href : null
}

// ---- Blocks ----

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; start: number; items: string[] }

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t'
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

// `## Text`: up to six `#` then a space, or nothing.
function headingText(line: string): string | null {
  let n = 0
  while (n < line.length && line[n] === '#') n += 1
  if (n === 0 || n > 6) return null
  if (n < line.length && !isSpace(line[n])) return null
  return line.slice(n).trim()
}

function bulletText(line: string): string | null {
  if ((line[0] === '-' || line[0] === '*') && isSpace(line[1])) return line.slice(2).trim()
  return null
}

function orderedItem(line: string): { n: number; text: string } | null {
  let i = 0
  while (i < line.length && i < 9 && isDigit(line[i])) i += 1
  if (i === 0 || (line[i] !== '.' && line[i] !== ')') || !isSpace(line[i + 1])) return null
  return { n: Number(line.slice(0, i)), text: line.slice(i + 2).trim() }
}

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = []
  let open: Block | null = null

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim()
    if (line === '') {
      open = null
      continue
    }
    const heading = headingText(line)
    if (heading !== null) {
      if (heading !== '') blocks.push({ kind: 'heading', text: heading })
      open = null
      continue
    }
    const bullet = bulletText(line)
    if (bullet !== null) {
      if (open?.kind !== 'ul') {
        open = { kind: 'ul', items: [] }
        blocks.push(open)
      }
      open.items.push(bullet)
      continue
    }
    const ordered = orderedItem(line)
    if (ordered !== null) {
      if (open?.kind !== 'ol') {
        open = { kind: 'ol', start: ordered.n, items: [] }
        blocks.push(open)
      }
      open.items.push(ordered.text)
      continue
    }
    // A plain line continues the open paragraph or list item.
    if (open?.kind === 'paragraph') open.lines.push(line)
    else if (open?.kind === 'ul' || open?.kind === 'ol') {
      open.items[open.items.length - 1] += ` ${line}`
    } else {
      open = { kind: 'paragraph', lines: [line] }
      blocks.push(open)
    }
  }
  return blocks
}

// ---- Inline ----

// `indexOf` that remembers, per needle, where its last search began and
// what it found. The inline scan only moves forward, so a later search
// that starts at or before the last hit, or anywhere after a miss, is
// answered from the cache: a run of unclosed `[` costs one pass, not one
// pass per `[`.
class Finder {
  private readonly cache = new Map<string, { from: number; at: number }>()
  constructor(private readonly text: string) {}

  find(needle: string, from: number): number {
    const hit = this.cache.get(needle)
    if (hit && from >= hit.from && (hit.at === -1 || from <= hit.at)) return hit.at
    const at = this.text.indexOf(needle, from)
    this.cache.set(needle, { from, at })
    return at
  }
}

const ESCAPABLE = '\\`*_[]()#!-.+<>'

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char)
}

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || char === ' ' || char === '\t'
}

const CODE = 'rounded-pill bg-canvas px-1 font-mono text-body-13'
// The shared link style, underlined always: inside prose, colour alone is
// not enough to show a link.
const LINK = `${SHARED_LINK} underline`

function parseInline(text: string, depth: number, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  const finder = new Finder(text)
  let plain = ''
  let key = 0
  const push = (node: ReactNode) => {
    if (plain !== '') out.push(plain)
    plain = ''
    out.push(node)
  }
  const nextKey = () => `${keyPrefix}.${(key += 1)}`
  const nest = (inner: string) =>
    depth < MAX_INLINE_DEPTH ? parseInline(inner, depth + 1, nextKey()) : [inner]

  let i = 0
  while (i < text.length) {
    const char = text[i]

    if (char === '\\' && i + 1 < text.length && ESCAPABLE.includes(text[i + 1])) {
      plain += text[i + 1]
      i += 2
      continue
    }

    if (char === '`') {
      const close = finder.find('`', i + 1)
      if (close > i + 1) {
        push(
          <bdi key={nextKey()}>
            <code className={CODE}>{text.slice(i + 1, close)}</code>
          </bdi>,
        )
        i = close + 1
        continue
      }
    }

    if (char === '*' && text[i + 1] === '*') {
      const close = finder.find('**', i + 2)
      if (close > i + 2 && !isWhitespace(text[i + 2]) && !isWhitespace(text[close - 1])) {
        push(<strong key={nextKey()}>{nest(text.slice(i + 2, close))}</strong>)
        i = close + 2
        continue
      }
      plain += '**'
      i += 2
      continue
    }

    if (char === '*' || (char === '_' && !isWordChar(text[i - 1]))) {
      const close = finder.find(char, i + 1)
      const closes =
        close > i + 1 &&
        !isWhitespace(text[i + 1]) &&
        !isWhitespace(text[close - 1]) &&
        !(char === '_' && isWordChar(text[close + 1]))
      if (closes) {
        push(<em key={nextKey()}>{nest(text.slice(i + 1, close))}</em>)
        i = close + 1
        continue
      }
    }

    const image = char === '!' && text[i + 1] === '['
    if (char === '[' || image) {
      const open = image ? i + 1 : i
      const mid = finder.find('](', open + 1)
      const close = mid === -1 ? -1 : finder.find(')', mid + 2)
      // The label must not run past a `]` of its own: `[a] b](c)` is text.
      const bracket = finder.find(']', open + 1)
      if (mid !== -1 && close !== -1 && bracket === mid) {
        const label = text.slice(open + 1, mid)
        const href = image ? null : safeHref(text.slice(mid + 2, close).trim())
        // An image shows its alt text, and a link whose scheme is not
        // allowed shows its label: both as plain, isolated text.
        push(
          href === null ? (
            <bdi key={nextKey()}>{label}</bdi>
          ) : (
            <a
              key={nextKey()}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className={LINK}
            >
              <bdi>{label}</bdi>
            </a>
          ),
        )
        i = close + 1
        continue
      }
    }

    plain += char
    i += 1
  }
  if (plain !== '') out.push(plain)
  return out
}

// ---- Render ----

const TEXT = 'm-0 text-body-14 text-ink'
const HEADING = 'm-0 text-body-14 font-semibold text-ink'
const LIST = 'm-0 flex flex-col gap-1 pl-5 text-body-14 text-ink'

/** Renders an insight's markdown body as inert React elements. */
export default function InsightBody({ markdown }: { markdown: string }) {
  const truncated = markdown.length > MAX_BODY_CHARS
  const source = stripBidi(markdown.slice(0, MAX_BODY_CHARS)).replace(/\r\n?/g, '\n')
  const blocks = parseBlocks(source)

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, b) => {
        const k = String(b)
        switch (block.kind) {
          case 'heading':
            return (
              <h4 key={k} className={HEADING}>
                {parseInline(block.text, 0, k)}
              </h4>
            )
          case 'paragraph':
            return (
              <p key={k} className={TEXT}>
                {parseInline(block.lines.join(' '), 0, k)}
              </p>
            )
          case 'ul':
            return (
              <ul key={k} className={`${LIST} list-disc`}>
                {block.items.map((item, n) => (
                  <li key={n}>{parseInline(item, 0, `${k}.${n}`)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={k} start={block.start} className={`${LIST} list-decimal`}>
                {block.items.map((item, n) => (
                  <li key={n}>{parseInline(item, 0, `${k}.${n}`)}</li>
                ))}
              </ol>
            )
        }
      })}
      {truncated && (
        <p className="m-0 text-body-13 text-ink-muted">
          The rest of this insight is too long to show.
        </p>
      )}
    </div>
  )
}
