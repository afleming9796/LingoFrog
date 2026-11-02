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
 * The draft is also editable in place. domToMarkdown reads the edited
 * DOM back into the same Markdown subset, and everything downstream
 * (copy, the link check) re-parses that, so whatever the editor holds
 * still goes through the allowlist above.
 *
 * Pure functions apart from renderDraft / domToMarkdown (which take DOM
 * nodes), so the parser can be exercised outside the extension.
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
      // `bare`: the visible text is the URL itself, so it should track
      // any rewrite of the href (UTM tags) rather than stay as written.
      tokens.push(href ? { type: 'link', text: m[6], href, bare: true } : { type: 'text', text: m[6] });
    }
    last = m.index + m[0].length;
  }
  if (last < source.length) tokens.push({ type: 'text', text: source.slice(last) });
  return tokens;
}

// Blocks are { type: 'p', lines: [tokens], gap } or
// { type: 'ul'|'ol', items: [tokens], gap }. A blank line ends the
// current block, and `gap` marks a block that comes after one: an empty
// line in the email. Consecutive non-list lines stay in one paragraph
// separated by line breaks, and a list can sit right under a line (or
// above one) with no gap, as in Gmail.
export function parseDraft(text) {
  const blocks = [];
  let current = null;
  let blank = false;
  const start = (block) => {
    block.gap = blank && blocks.length > 0;
    blank = false;
    blocks.push(block);
    return block;
  };
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      current = null;
      blank = true;
      continue;
    }
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (!current || current.type !== 'ul') current = start({ type: 'ul', items: [] });
      current.items.push(parseInline(m[1]));
    } else if ((m = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/))) {
      if (!current || current.type !== 'ol') current = start({ type: 'ol', items: [] });
      current.items.push(parseInline(m[1]));
    } else {
      if (!current || current.type !== 'p') current = start({ type: 'p', lines: [] });
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

// ── Output ─────────────────────────────────────────────────
//
// Every renderer takes mapHref, which rewrites link targets on the way
// out (Scribe uses it to apply UTM rules). Tokens keep the href the
// model wrote, so the link check still sees the original URL.

function linkParts(t, mapHref) {
  const href = mapHref(t.href);
  return { href, text: t.bare ? href : t.text };
}

// ── Output: DOM preview ────────────────────────────────────

// t: a link token ({ text, href, bare }). Also used for links the user
// adds while editing, so they read back the same way.
export function linkElement(t, doc, mapHref = (h) => h) {
  const { href, text } = linkParts(t, mapHref);
  const a = doc.createElement('a');
  a.href = href;
  a.textContent = text;
  a.title = href;
  // The untagged URL, so reading an edited draft back doesn't bake
  // UTM tags into the text.
  a.dataset.href = t.href;
  if (t.bare) a.dataset.bare = '1';
  // Without a target, clicking would navigate the side panel itself.
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function appendInline(parent, tokens, doc, mapHref) {
  for (const t of tokens) {
    if (t.type === 'text') {
      parent.appendChild(doc.createTextNode(t.text));
    } else if (t.type === 'link') {
      parent.appendChild(linkElement(t, doc, mapHref));
    } else {
      const el = doc.createElement(t.type);
      appendInline(el, t.children, doc, mapHref);
      parent.appendChild(el);
    }
  }
}

export function renderDraft(blocks, doc, mapHref = (h) => h) {
  const frag = doc.createDocumentFragment();
  for (const b of blocks) {
    // The gap is a real empty line, like Enter twice makes, so it edits
    // like one.
    if (b.gap) frag.appendChild(doc.createElement('p')).appendChild(doc.createElement('br'));
    if (b.type === 'p') {
      const p = doc.createElement('p');
      b.lines.forEach((line, i) => {
        if (i) p.appendChild(doc.createElement('br'));
        appendInline(p, line, doc, mapHref);
      });
      frag.appendChild(p);
    } else {
      const list = doc.createElement(b.type);
      for (const item of b.items) {
        const li = doc.createElement('li');
        appendInline(li, item, doc, mapHref);
        list.appendChild(li);
      }
      frag.appendChild(list);
    }
  }
  return frag;
}

// ── Output: clipboard ──────────────────────────────────────

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Gmail's default compose text (font "Sans Serif", size "Normal") and
// link color. Unstyled HTML takes on whatever font the paste path
// supplies (Chrome's clipboard sanitizer fills in its own defaults, such
// as Times at 16px), so every block spells out Gmail's instead.
const GMAIL_TEXT_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:small;color:#222222';
const GMAIL_LINK_STYLE = 'color:#1155cc';

function inlineHtml(tokens, mapHref) {
  return tokens.map((t) => {
    if (t.type === 'text') return escapeHtml(t.text);
    if (t.type === 'link') {
      const { href, text } = linkParts(t, mapHref);
      return `<a href="${escapeHtml(href)}" style="${GMAIL_LINK_STYLE}">${escapeHtml(text)}</a>`;
    }
    return `<${t.type}>${inlineHtml(t.children, mapHref)}</${t.type}>`;
  }).join('');
}

// Mirrors Gmail's own compose markup — one <div> per line and an empty
// <div><br></div> for each gap — so a paste looks like typing. Lists get
// no margins of their own, so they're single-spaced unless there's a gap.
export function toClipboardHtml(blocks, mapHref = (h) => h) {
  const div = (inner) => `<div style="${GMAIL_TEXT_STYLE}">${inner}</div>`;
  return blocks.map((b) => {
    const gap = b.gap ? div('<br>') : '';
    if (b.type === 'p') {
      return gap + b.lines.map((line) => div(inlineHtml(line, mapHref) || '<br>')).join('');
    }
    const items = b.items.map((item) => `<li>${inlineHtml(item, mapHref)}</li>`).join('');
    return `${gap}<${b.type} style="${GMAIL_TEXT_STYLE};margin-top:0;margin-bottom:0">${items}</${b.type}>`;
  }).join('');
}

// Blocks joined by a line break, or a blank line where there's a gap.
const joinBlocks = (blocks, text) => blocks.map((b, i) => (i ? (b.gap ? '\n\n' : '\n') : '') + text(b)).join('');

function inlineText(tokens, mapHref) {
  return tokens.map((t) => {
    if (t.type === 'text') return t.text;
    if (t.type === 'link') {
      const { href, text } = linkParts(t, mapHref);
      return text === href ? href : `${text} (${href})`;
    }
    return inlineText(t.children, mapHref);
  }).join('');
}

export function toPlainText(blocks, mapHref = (h) => h) {
  return joinBlocks(blocks, (b) => {
    if (b.type === 'p') return b.lines.map((line) => inlineText(line, mapHref)).join('\n');
    return b.items
      .map((item, i) => (b.type === 'ol' ? `${i + 1}. ` : '• ') + inlineText(item, mapHref))
      .join('\n');
  });
}

// ── Markdown round trip (for the editable draft) ───────────

function inlineMarkdown(tokens) {
  return tokens.map((t) => {
    if (t.type === 'text') return t.text;
    if (t.type === 'em') return `*${inlineMarkdown(t.children)}*`;
    if (t.type === 'strong') return `**${inlineMarkdown(t.children)}**`;
    return t.bare ? t.href : `[${t.text}](${t.href})`;
  }).join('');
}

export function toMarkdown(blocks) {
  return joinBlocks(blocks, (b) => {
    if (b.type === 'p') return b.lines.map(inlineMarkdown).join('\n');
    return b.items
      .map((item, i) => (b.type === 'ol' ? `${i + 1}. ` : '- ') + inlineMarkdown(item))
      .join('\n');
  });
}

// One canonical spelling of a draft, so "has the user edited it?" is a
// plain string comparison.
export function canonicalDraft(text) {
  return toMarkdown(parseDraft(text));
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

// Keep surrounding spaces outside the markers: "*word* " not "*word *".
function wrapMarks(inner, mark) {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

function nodeMarkdown(node) {
  // Chrome's editor pads spaces with &nbsp; as you type and insert;
  // they're plain spaces as far as the email is concerned.
  if (node.nodeType === 3) return node.nodeValue.replace(/ /g, ' ').replace(/\s*\n\s*/g, ' ');
  if (node.nodeType !== 1) return '';
  const tag = node.tagName;
  if (tag === 'BR') return '\n';
  const inner = [...node.childNodes].map(nodeMarkdown).join('');
  if (tag === 'EM' || tag === 'I') return wrapMarks(inner, '*');
  if (tag === 'STRONG' || tag === 'B') return wrapMarks(inner, '**');
  if (tag === 'A') {
    const href = node.dataset.href || node.getAttribute('href') || '';
    if (!inner.trim() || !href) return inner;
    // A bare URL the user didn't touch goes back to being a bare URL.
    if (node.dataset.bare && inner === node.getAttribute('href')) return href;
    return `[${inner}](${href})`;
  }
  // Spans, fonts, and anything else: keep the text, drop the wrapper.
  // Images and other embeds have no text, so they vanish here.
  return inner;
}

// Reads the contenteditable draft back into Markdown, line by line as it
// shows on screen: a <br> or a block edge ends a line, an empty line
// (Enter twice, or an empty <p>) is a blank line, which is what puts a
// gap in the email, and list items become "- " / "1. " lines.
export function domToMarkdown(root) {
  const lines = [];
  let pending = [];
  const flush = () => {
    const md = pending.map(nodeMarkdown).join('');
    pending = [];
    // Only whitespace between blocks: nothing on screen.
    if (!md.trim() && !md.includes('\n')) return;
    // A <br> at the very end of a block doesn't show a line of its own
    // (Chrome leaves one there to hold the line open).
    lines.push(...md.replace(/\n$/, '').split('\n').map((line) => line.trim()));
  };
  const walk = (parent) => {
    for (const node of parent.childNodes) {
      if (node.nodeType !== 1 || !BLOCK_TAGS.has(node.tagName)) {
        pending.push(node);
        continue;
      }
      flush();
      if (node.tagName === 'UL' || node.tagName === 'OL') {
        [...node.children]
          .map((li) => nodeMarkdown(li).replace(/\s*\n\s*/g, ' ').trim())
          .filter(Boolean)
          .forEach((t, i) => lines.push((node.tagName === 'OL' ? `${i + 1}. ` : '- ') + t));
      } else {
        walk(node);
        flush();
      }
    }
  };
  walk(root);
  flush();
  return lines.join('\n');
}
