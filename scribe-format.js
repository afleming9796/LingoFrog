/**
 * scribe-format.js — turns Scribe's model output into safe, formatted
 * text.
 *
 * The model writes a small Markdown subset (paragraphs, *italic*,
 * **bold**, "- " / "1. " lists, [text](url) links). We parse that
 * ourselves and only ever build an allowlisted set of nodes: p, br,
 * em, strong, ul, ol, li, a. Model text never reaches innerHTML, so
 * any HTML it writes — or that a pasted email tricks it into writing —
 * renders as literal characters. There is deliberately no image
 * support: an <img> loads on its own and is the classic way an
 * injected prompt exfiltrates data, whereas a link only goes anywhere
 * if the user clicks it.
 *
 * Pure functions apart from renderDraft (which takes a document), so
 * the parser can be exercised outside the extension.
 */

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

// Returns a normalized href, or null for anything that isn't a plain
// web or mailto link (javascript:, data:, relative paths, garbage).
export function safeHref(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch (e) {
    return null;
  }
  return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null;
}

// ── Parsing ────────────────────────────────────────────────

// One pass over a line, earliest match wins:
//   [text](url)  |  **bold**  |  *italic*  |  _italic_  |  bare http(s) URL
const INLINE = new RegExp(
  [
    // One level of balanced parens inside the URL (Wikipedia-style).
    String.raw`\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)`,
    String.raw`\*\*(?=\S)(.+?)(?<=\S)\*\*`,
    String.raw`\*(?=\S)(.+?)(?<=\S)\*`,
    String.raw`(?<![\w])_(?=\S)(.+?)(?<=\S)_(?![\w])`,
    String.raw`(https?:\/\/[^\s<>()\[\]]*[^\s<>()\[\].,;:!?'"])`,
  ].join('|'),
  'g'
);

function parseInline(source) {
  const tokens = [];
  let last = 0;
  for (const m of source.matchAll(INLINE)) {
    if (m.index > last) tokens.push({ type: 'text', text: source.slice(last, m.index) });
    if (m[1] !== undefined) {
      const href = safeHref(m[2]);
      // An unsafe link degrades to its literal source text.
      tokens.push(href ? { type: 'link', text: m[1], href } : { type: 'text', text: m[0] });
    } else if (m[3] !== undefined) {
      tokens.push({ type: 'strong', children: parseInline(m[3]) });
    } else if (m[4] !== undefined || m[5] !== undefined) {
      tokens.push({ type: 'em', children: parseInline(m[4] ?? m[5]) });
    } else {
      const href = safeHref(m[6]);
      tokens.push(href ? { type: 'link', text: m[6], href } : { type: 'text', text: m[6] });
    }
    last = m.index + m[0].length;
  }
  if (last < source.length) tokens.push({ type: 'text', text: source.slice(last) });
  return tokens;
}

// Blocks are { type: 'p', lines: [tokens] } or { type: 'ul'|'ol', items: [tokens] }.
// A blank line ends the current block; consecutive non-list lines
// stay in one paragraph separated by line breaks.
export function parseDraft(text) {
  const blocks = [];
  let current = null;
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      current = null;
      continue;
    }
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (!current || current.type !== 'ul') blocks.push((current = { type: 'ul', items: [] }));
      current.items.push(parseInline(m[1]));
    } else if ((m = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/))) {
      if (!current || current.type !== 'ol') blocks.push((current = { type: 'ol', items: [] }));
      current.items.push(parseInline(m[1]));
    } else {
      if (!current || current.type !== 'p') blocks.push((current = { type: 'p', lines: [] }));
      // Headings aren't part of the format; keep the words, drop the #s.
      current.lines.push(parseInline(line.replace(/^\s*#{1,6}\s+/, '')));
    }
  }
  return blocks;
}

function eachLine(blocks, fn) {
  for (const b of blocks) (b.type === 'p' ? b.lines : b.items).forEach(fn);
}

function walkTokens(tokens, fn) {
  for (const t of tokens) {
    fn(t);
    if (t.children) walkTokens(t.children, fn);
  }
}

export function collectLinks(blocks) {
  const hrefs = [];
  eachLine(blocks, (line) => walkTokens(line, (t) => { if (t.type === 'link') hrefs.push(t.href); }));
  return hrefs;
}

// ── Output: DOM preview ────────────────────────────────────

function appendInline(parent, tokens, doc) {
  for (const t of tokens) {
    if (t.type === 'text') {
      parent.appendChild(doc.createTextNode(t.text));
    } else if (t.type === 'link') {
      const a = doc.createElement('a');
      a.href = t.href;
      a.textContent = t.text;
      a.title = t.href;
      // Without a target, clicking would navigate the side panel itself.
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.appendChild(a);
    } else {
      const el = doc.createElement(t.type);
      appendInline(el, t.children, doc);
      parent.appendChild(el);
    }
  }
}

export function renderDraft(blocks, doc) {
  const frag = doc.createDocumentFragment();
  for (const b of blocks) {
    if (b.type === 'p') {
      const p = doc.createElement('p');
      b.lines.forEach((line, i) => {
        if (i) p.appendChild(doc.createElement('br'));
        appendInline(p, line, doc);
      });
      frag.appendChild(p);
    } else {
      const list = doc.createElement(b.type);
      for (const item of b.items) {
        const li = doc.createElement('li');
        appendInline(li, item, doc);
        list.appendChild(li);
      }
      frag.appendChild(list);
    }
  }
  return frag;
}

// ── Output: clipboard ──────────────────────────────────────
//
// mapHref lets the caller rewrite link targets at copy time (Scribe
// uses it for UTM-on-copy).

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function inlineHtml(tokens, mapHref) {
  return tokens.map((t) => {
    if (t.type === 'text') return escapeHtml(t.text);
    if (t.type === 'link') return `<a href="${escapeHtml(mapHref(t.href))}">${escapeHtml(t.text)}</a>`;
    return `<${t.type}>${inlineHtml(t.children, mapHref)}</${t.type}>`;
  }).join('');
}

// Mirrors Gmail's own compose markup — one <div> per line and an empty
// <div><br></div> between paragraphs — so a paste looks like typing.
export function toClipboardHtml(blocks, mapHref = (h) => h) {
  return blocks.map((b) => {
    if (b.type === 'p') {
      return b.lines.map((line) => `<div>${inlineHtml(line, mapHref) || '<br>'}</div>`).join('');
    }
    const items = b.items.map((item) => `<li>${inlineHtml(item, mapHref)}</li>`).join('');
    return `<${b.type}>${items}</${b.type}>`;
  }).join('<div><br></div>');
}

function inlineText(tokens, mapHref) {
  return tokens.map((t) => {
    if (t.type === 'text') return t.text;
    if (t.type === 'link') {
      const href = mapHref(t.href);
      return t.text === t.href || t.text === href ? href : `${t.text} (${href})`;
    }
    return inlineText(t.children, mapHref);
  }).join('');
}

export function toPlainText(blocks, mapHref = (h) => h) {
  return blocks.map((b) => {
    if (b.type === 'p') return b.lines.map((line) => inlineText(line, mapHref)).join('\n');
    return b.items
      .map((item, i) => (b.type === 'ol' ? `${i + 1}. ` : '• ') + inlineText(item, mapHref))
      .join('\n');
  }).join('\n\n');
}
