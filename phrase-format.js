/**
 * phrase-format.js — formatted phrases: line breaks, paragraphs,
 * bulleted and numbered lists, bold, italic, and links.
 *
 * A phrase's key stays its plain text, which is what autocomplete
 * matches and the Phrases list shows, so plain phrases are untouched.
 * A formatted phrase also keeps a `rich` field holding the same phrase
 * as Markdown: blank lines for gaps, "- " / "1. " lists, **bold**,
 * _italic_ (or *italic*), [text](url), and a backslash before any
 * character that would otherwise be markup.
 *
 * Text never reaches innerHTML unescaped, and links must be http(s),
 * mailto or tel, so a phrase (or an imported backup) can't add markup
 * of its own when it's inserted into Gmail.
 *
 * Loaded as a classic script by the popup and the Gmail content script.
 */

const PhraseFormat = (() => {
  // Blocks: { type: 'p', lines: [tokens], gap } or
  //         { type: 'ul' | 'ol', items: [tokens], gap },
  // where `gap` marks a block after an empty line. Tokens:
  //   { type: 'text', text } | { type: 'strong' | 'em', children }
  //   | { type: 'link', href, children }

  const SAFE_PROTOCOLS = new Set(['https:', 'http:', 'mailto:', 'tel:']);

  function safeHref(raw) {
    try {
      const url = new URL(String(raw).trim());
      return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  // ── Markdown → blocks ──────────────────────────────────────

  // Escaped characters are swapped for private-use stand-ins while
  // parsing, so they can't be read as markup, and swapped back after.
  const ESCAPABLE = '\\`*_{}[]()#+-.!|~<>•';
  const hide = (s) => s.replace(/\\(.)/g, (m, c) => {
    const i = ESCAPABLE.indexOf(c);
    return i === -1 ? m : String.fromCharCode(0xe000 + i);
  });
  const reveal = (s) => s.replace(/[-]/g, (c) => ESCAPABLE[c.charCodeAt(0) - 0xe000] || c);

  const INLINE = new RegExp(
    [
      // One level of balanced parens inside the URL (Wikipedia-style).
      String.raw`\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)`,
      String.raw`\*\*(?=\S)(.+?)(?<=\S)\*\*`,
      String.raw`(?<![\w])_(?=\S)(.+?)(?<=\S)_(?![\w])`,
      String.raw`\*(?=\S)(.+?)(?<=\S)\*`,
    ].join('|'),
    'g'
  );

  function parseInline(source) {
    const tokens = [];
    let last = 0;
    const text = (s) => s && tokens.push({ type: 'text', text: reveal(s) });
    for (const m of source.matchAll(INLINE)) {
      text(source.slice(last, m.index));
      if (m[1] !== undefined) {
        const href = safeHref(reveal(m[2]));
        // An unsafe link degrades to its literal source text.
        if (href) tokens.push({ type: 'link', href, children: parseInline(m[1]) });
        else text(m[0]);
      } else if (m[3] !== undefined) {
        tokens.push({ type: 'strong', children: parseInline(m[3]) });
      } else {
        tokens.push({ type: 'em', children: parseInline(m[4] ?? m[5]) });
      }
      last = m.index + m[0].length;
    }
    text(source.slice(last));
    return tokens;
  }

  function parse(md) {
    const blocks = [];
    let current = null;
    let blank = false;
    const start = (block) => {
      block.gap = blank && blocks.length > 0;
      blank = false;
      blocks.push(block);
      return block;
    };
    for (const raw of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
      const line = hide(raw.trimEnd());
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
        current.lines.push(parseInline(line.trim()));
      }
    }
    return blocks;
  }

  // A phrase with no `rich` field as blocks: its text taken literally,
  // a line for each line break and a gap for each empty line. Phrases
  // saved before formatting existed (⌘⇧P on several lines) have line
  // breaks but no formatting.
  function fromText(text) {
    const blocks = [];
    let current = null;
    let blank = false;
    for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim();
      if (!line) {
        current = null;
        blank = true;
        continue;
      }
      if (!current) {
        current = { type: 'p', lines: [], gap: blank && blocks.length > 0 };
        blank = false;
        blocks.push(current);
      }
      current.lines.push([{ type: 'text', text: line }]);
    }
    return blocks;
  }

  // A stored phrase as blocks, from its Markdown if it has any.
  const blocksOf = (phrase, rich) => (rich ? parse(rich) : fromText(phrase));

  // ── Blocks → Markdown ──────────────────────────────────────

  // Keep surrounding spaces outside the markers: "**word** " not "**word **".
  function wrapMarks(inner, mark) {
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
  }

  // Italic is written _like this_ where *like this* would run into the
  // bold markers around or inside it ("***x***" doesn't read back).
  function inlineMarkdown(tokens, parent) {
    return tokens.map((t, i) => {
      if (t.type === 'text') return t.text.replace(/[\\*_[\]]/g, '\\$&');
      const inner = inlineMarkdown(t.children, t);
      if (t.type === 'link') return `[${inner}](${t.href.replace(/[()\\]/g, '\\$&')})`;
      if (t.type === 'strong') return wrapMarks(inner, '**');
      const edge = t.children.length && [t.children[0], t.children[t.children.length - 1]].some((c) => c.type === 'strong');
      const inStrongEdge = parent && parent.type === 'strong' && (i === 0 || i === tokens.length - 1);
      return wrapMarks(inner, edge || inStrongEdge ? '_' : '*');
    }).join('');
  }

  // A paragraph line that starts like a list item gets its marker escaped.
  function escapeLineStart(line) {
    return line.replace(/^(-|•|\d{1,3}(?=[.)]))(?=[.)]?\s)/, (m) => (/\d/.test(m) ? m + '\\' : '\\' + m));
  }

  function joinBlocks(blocks, text) {
    return blocks.map((b, i) => (i ? (b.gap ? '\n\n' : '\n') : '') + text(b)).join('');
  }

  function serialize(blocks) {
    return joinBlocks(blocks, (b) => {
      if (b.type === 'p') return b.lines.map((line) => escapeLineStart(inlineMarkdown(line))).join('\n');
      return b.items.map((item, i) => (b.type === 'ol' ? `${i + 1}. ` : '- ') + inlineMarkdown(item)).join('\n');
    });
  }

  // ── Plain text ─────────────────────────────────────────────

  const tokensText = (tokens) => tokens.map((t) => (t.type === 'text' ? t.text : t.children ? tokensText(t.children) : '')).join('');
  const hasBreak = (tokens) => tokens.some((t) => t.type === 'br' || (t.children && hasBreak(t.children)));

  // The phrase's key: what autocomplete matches and the Phrases list shows.
  function plainText(blocks) {
    return joinBlocks(blocks, (b) => {
      if (b.type === 'p') return b.lines.map(tokensText).join('\n');
      return b.items.map((item, i) => (b.type === 'ol' ? `${i + 1}. ` : '• ') + tokensText(item)).join('\n');
    });
  }

  // True when the phrase is one line of unformatted text, which is stored
  // the way every phrase was before formatting existed.
  function isPlain(blocks) {
    return !blocks.length || (blocks.length === 1 && blocks[0].type === 'p' &&
      blocks[0].lines.length === 1 && blocks[0].lines[0].every((t) => t.type === 'text'));
  }

  // Words in a phrase's plain text, leaving out list markers.
  function wordCount(text) {
    return String(text || '')
      .replace(/^\s*(?:•|\d{1,3}[.)])\s+/gm, '')
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }

  // ── Token helpers ──────────────────────────────────────────

  // Adjacent text merged, empty wrappers dropped, and neighbors with the
  // same formatting combined.
  function normalize(tokens) {
    const out = [];
    for (const t of tokens) {
      const token = t.children ? { ...t, children: normalize(t.children) } : { ...t };
      if (token.type === 'text' ? !token.text : !token.children.length) continue;
      const prev = out[out.length - 1];
      if (prev && prev.type === token.type && (token.type !== 'link' || prev.href === token.href)) {
        if (token.type === 'text') prev.text += token.text;
        else prev.children = normalize([...prev.children, ...token.children]);
        continue;
      }
      out.push(token);
    }
    return out;
  }

  // Trims whitespace at the start or end of a line, inside formatting too.
  function trimEdge(tokens, end) {
    const list = tokens.slice();
    const i = end ? list.length - 1 : 0;
    const t = list[i];
    if (!t) return list;
    if (t.type === 'text') list[i] = { ...t, text: end ? t.text.trimEnd() : t.text.trimStart() };
    else list[i] = { ...t, children: trimEdge(t.children, end) };
    return normalize(list);
  }
  const trimLine = (tokens) => trimEdge(trimEdge(tokens, false), true);

  // The line with its first `n` characters of text removed.
  function dropChars(tokens, n) {
    const out = [];
    for (const t of tokens) {
      if (n <= 0) {
        out.push(t);
      } else if (t.type === 'text') {
        if (t.text.length > n) out.push({ ...t, text: t.text.slice(n) });
        n -= t.text.length;
      } else {
        const len = tokensText(t.children).length;
        if (len > n) out.push({ ...t, children: dropChars(t.children, n) });
        n -= len;
      }
    }
    return normalize(out);
  }

  // The phrase as it continues after the `typed` text the user has
  // already written (matched from its start, as autocomplete does). With
  // `keepTyped`, the first line begins with `typed` exactly as typed,
  // for replacing it. A trailing space the user typed stands in for the
  // phrase's own.
  function continueFrom(blocks, typed, { keepTyped = true } = {}) {
    const [first, ...rest] = blocks;
    if (!first) return blocks;
    const key = first.type === 'p' ? 'lines' : 'items';
    const [line, ...more] = first[key];
    let tail = dropChars(line, typed.trim().length);
    if (/\s$/.test(typed)) tail = trimEdge(tail, false);
    const head = keepTyped ? normalize([{ type: 'text', text: typed }, ...tail]) : tail;
    return [{ ...first, [key]: [head, ...more] }, ...rest];
  }

  // Wraps text that matches a link rule in a link (not text already in
  // one). `findLinks` is LinkRules#findLinks; `mapHref` adds UTM tags.
  function linkify(blocks, findLinks, mapHref) {
    const line = (tokens) => normalize(tokens.flatMap((t) => {
      if (t.type === 'link') return [t];
      if (t.type !== 'text') return [{ ...t, children: line(t.children) }];
      const out = [];
      let at = 0;
      for (const m of findLinks(t.text)) {
        const href = safeHref(mapHref(m.url));
        if (!href || m.start < at) continue;
        out.push({ type: 'text', text: t.text.slice(at, m.start) });
        out.push({ type: 'link', href, children: [{ type: 'text', text: t.text.slice(m.start, m.end) }] });
        at = m.end;
      }
      out.push({ type: 'text', text: t.text.slice(at) });
      return out;
    }));
    return blocks.map((b) => (b.type === 'p' ? { ...b, lines: b.lines.map(line) } : { ...b, items: b.items.map(line) }));
  }

  // ── Blocks → HTML ──────────────────────────────────────────

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

  function inlineHtml(tokens, linkAttr = '') {
    return tokens.map((t) => {
      if (t.type === 'text') return escapeHtml(t.text);
      const inner = inlineHtml(t.children, linkAttr);
      if (t.type === 'link') return `<a href="${escapeHtml(t.href)}"${linkAttr}>${inner}</a>`;
      return t.type === 'strong' ? `<b>${inner}</b>` : `<i>${inner}</i>`;
    }).join('');
  }

  // Gmail's own compose markup: a <div> per line, an empty <div><br></div>
  // for a gap, and lists with no margins of their own (so a list is
  // single-spaced unless there's a gap). With `clipboard`, every block
  // and link spells out Gmail's default font and link color, which a
  // paste would otherwise lose; an insert inherits them. With
  // `inlineFirst`, the first line is left bare so it joins the line the
  // cursor is on.
  const GMAIL_TEXT_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:small;color:#222222';
  const GMAIL_LINK_STYLE = 'color:#1155cc';

  function toHtml(blocks, { clipboard = false, inlineFirst = false } = {}) {
    const style = clipboard ? GMAIL_TEXT_STYLE : '';
    const linkAttr = clipboard ? ` style="${GMAIL_LINK_STYLE}"` : '';
    const inline = (tokens) => inlineHtml(tokens, linkAttr);
    const attr = style ? ` style="${style}"` : '';
    const listAttr = ` style="${style ? style + ';' : ''}margin-top:0;margin-bottom:0"`;
    const div = (inner) => `<div${attr}>${inner || '<br>'}</div>`;
    return blocks.map((b, bi) => {
      let html = b.gap ? div('') : '';
      const lines = b.type === 'p' ? b.lines : b.items;
      // A leading space (before a Bop) would be dropped as collapsible
      // whitespace when inserted.
      const bare = inlineFirst && bi === 0 ? inline(lines[0]).replace(/^ /, '&nbsp;') : '';
      const rest = inlineFirst && bi === 0 ? lines.slice(1) : lines;
      html += bare;
      if (!rest.length) return html;
      if (b.type === 'p') return html + rest.map((line) => div(inline(line))).join('');
      return html + `<${b.type}${listAttr}>${rest.map((item) => `<li>${inline(item)}</li>`).join('')}</${b.type}>`;
    }).join('');
  }

  // ── Editor DOM ↔ blocks ────────────────────────────────────

  // The editor shows a gap as an empty paragraph, like Enter twice makes,
  // so it edits like one.
  function toEditor(blocks, doc) {
    const frag = doc.createDocumentFragment();
    const inline = (parent, tokens) => {
      for (const t of tokens) {
        if (t.type === 'text') {
          parent.appendChild(doc.createTextNode(t.text));
          continue;
        }
        const el = doc.createElement(t.type === 'link' ? 'a' : t.type === 'strong' ? 'b' : 'i');
        if (t.type === 'link') el.href = t.href;
        inline(el, t.children);
        parent.appendChild(el);
      }
    };
    for (const b of blocks) {
      if (b.gap) frag.appendChild(doc.createElement('p')).appendChild(doc.createElement('br'));
      if (b.type === 'p') {
        const p = doc.createElement('p');
        b.lines.forEach((line, i) => {
          if (i) p.appendChild(doc.createElement('br'));
          inline(p, line);
        });
        frag.appendChild(p);
      } else {
        const list = doc.createElement(b.type);
        for (const item of b.items) inline(list.appendChild(doc.createElement('li')), item);
        frag.appendChild(list);
      }
    }
    if (!frag.childNodes.length) frag.appendChild(doc.createElement('p')).appendChild(doc.createElement('br'));
    return frag;
  }

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TABLE', 'TBODY', 'THEAD', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'PRE',
  ]);
  const BLOCK_SELECTOR = [...BLOCK_TAGS].join(',');
  // Never text, even when pasted HTML has some inside them.
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE', 'META', 'LINK', 'SVG', 'IFRAME', 'OBJECT']);

  // Inline content as tokens, with { type: 'br' } where a line ends.
  function nodeTokens(node) {
    if (node.nodeType === 3) {
      return [{ type: 'text', text: node.nodeValue.replace(/ /g, ' ').replace(/\s*\n\s*/g, ' ') }];
    }
    if (node.nodeType !== 1 || (node.classList && node.classList.contains('lingofrog-ghost'))) return [];
    const tag = node.tagName;
    if (SKIP_TAGS.has(tag.toUpperCase())) return [];
    if (tag === 'BR') return [{ type: 'br' }];
    const children = [...node.childNodes].flatMap(nodeTokens);
    if (BLOCK_TAGS.has(tag)) return [{ type: 'br' }, ...children, { type: 'br' }];
    if (tag === 'A') {
      const href = safeHref(node.getAttribute('href') || '');
      return href ? [{ type: 'link', href, children }] : children;
    }
    // An inline style wins over the tag: Google Docs wraps whole pastes
    // in <b style="font-weight:normal">.
    const { fontWeight: weight, fontStyle } = node.style || {};
    const bold = weight ? weight === 'bold' || weight === 'bolder' || Number(weight) >= 600 : tag === 'B' || tag === 'STRONG';
    const italic = fontStyle ? fontStyle === 'italic' || fontStyle === 'oblique' : tag === 'I' || tag === 'EM';
    let out = children;
    if (italic) out = [{ type: 'em', children: out }];
    if (bold) out = [{ type: 'strong', children: out }];
    return out;
  }

  // Splits tokens at line breaks, repeating any formatting a break
  // falls inside of on both lines.
  function splitLines(tokens) {
    const lines = [[]];
    for (const t of tokens) {
      if (t.type === 'br') {
        lines.push([]);
      } else if (t.children) {
        splitLines(t.children).forEach((part, i) => {
          if (i) lines.push([]);
          if (part.length) lines[lines.length - 1].push({ ...t, children: part });
        });
      } else {
        lines[lines.length - 1].push(t);
      }
    }
    return lines;
  }

  // Reads editor (or copied) DOM line by line as it shows on screen: a
  // <br> or a block edge ends a line, an empty line is a gap, and list
  // items stay list items.
  function fromDom(root) {
    const lines = []; // { list: 'ul' | 'ol' | null, tokens }, or null for an empty line
    let pending = [];
    const flush = () => {
      const tokens = pending.flatMap(nodeTokens);
      pending = [];
      if (!hasBreak(tokens) && !tokensText(tokens).trim()) return;
      const split = splitLines(tokens);
      // A <br> at the very end of a block doesn't show a line of its own.
      if (split.length > 1 && !split[split.length - 1].length) split.pop();
      for (const line of split) {
        const trimmed = trimLine(line);
        lines.push(trimmed.length ? { list: null, tokens: trimmed } : null);
      }
    };
    const walk = (parent) => {
      for (const node of parent.childNodes) {
        // An inline element holding blocks (Google Docs wraps a whole
        // paste in a <b>) is walked into like a block.
        if (node.nodeType !== 1 || (!BLOCK_TAGS.has(node.tagName) && !node.querySelector(BLOCK_SELECTOR))) {
          pending.push(node);
          continue;
        }
        if (SKIP_TAGS.has(node.tagName.toUpperCase())) continue;
        flush();
        if (node.tagName === 'UL' || node.tagName === 'OL') {
          // A list item is one line; a break inside one becomes a space.
          for (const li of node.children) {
            const split = splitLines([...li.childNodes].flatMap(nodeTokens));
            const tokens = trimLine(split.flatMap((line, i) => (i ? [{ type: 'text', text: ' ' }, ...line] : line)));
            if (tokensText(tokens).trim()) lines.push({ list: node.tagName.toLowerCase(), tokens });
          }
        } else {
          walk(node);
          flush();
        }
      }
    };
    walk(root);
    flush();

    const blocks = [];
    let current = null;
    let blank = false;
    for (const line of lines) {
      if (!line) {
        current = null;
        blank = true;
        continue;
      }
      const type = line.list || 'p';
      if (!current || current.type !== type) {
        current = type === 'p' ? { type, lines: [] } : { type, items: [] };
        current.gap = blank && blocks.length > 0;
        blank = false;
        blocks.push(current);
      }
      (type === 'p' ? current.lines : current.items).push(line.tokens);
    }
    return blocks;
  }

  // ── Backups ────────────────────────────────────────────────
  //
  // Backups keep one phrase per line. A formatted phrase is written as
  // "md: " and its Markdown with each line break as \n.

  const BACKUP_PREFIX = 'md: ';

  function toBackupLine(md) {
    return BACKUP_PREFIX + md.replace(/\n/g, '\\n');
  }

  // The Markdown in a backup line, or null for a plain phrase's line.
  // Backslashes in the Markdown are always escapes of something, so a \n
  // that isn't part of one is a line break.
  function fromBackupLine(line) {
    if (!line.startsWith(BACKUP_PREFIX)) return null;
    return line.slice(BACKUP_PREFIX.length).replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : m));
  }

  return {
    safeHref, parse, fromText, blocksOf, serialize, plainText, isPlain, wordCount,
    continueFrom, linkify, toHtml, toEditor, fromDom,
    toBackupLine, fromBackupLine, escapeHtml,
  };
})();
