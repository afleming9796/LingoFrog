/**
 * quick-insert.js — ⌥⇧L and ⌥⇧P (Alt+Shift on Windows and Linux):
 * search your links or phrases and put one into the text box you're
 * in, on any site.
 *
 * A link goes in as its URL, with your UTM rules if "Include UTM
 * parameters when copying or inserting links" is on, as the popup's
 * Copy URL button copies it. In a rich text box it's clickable, with
 * the URL as its text, or the highlighted text if there is some; a
 * plain text box gets the bare URL. A phrase goes in with its
 * formatting, and with your link rules linking any text they match
 * (when "Auto-link hyperlinks" is on), as autocomplete does in Gmail.
 * Outside Gmail it all goes in as a paste, so each site's editor
 * treats it like any other paste.
 *
 * In Gmail this loads with the content script, which hooks in through
 * setHost() for its own cases: with text highlighted, ⌥⇧L links it and
 * ⌥⇧P offers to save it. On other sites nothing of LingoFrog runs until
 * one of the shortcuts is pressed. background.js then injects this file
 * (after phrase-format.js and trie.js) into the focused frame of that
 * tab only, through the activeTab permission the shortcut grants.
 *
 * The picker is plain DOM with inline styles, so a page's stylesheets
 * and Content Security Policy can't break it. It isn't in a shadow root,
 * because sites (Gmail included) decide whether a key is a shortcut by
 * checking whether an input has focus, and a shadow root would hide its
 * input from them.
 */

(() => {
  'use strict';

  if (globalThis.LingoFrogQuick) return;

  const ROOT_ID = 'lingofrog-quick';
  const MAX_RESULTS = 50;

  const KINDS = {
    link: {
      title: '🔗 Insert link',
      placeholder: 'Search links or paste a URL…',
      none: 'No links yet. Add them in the LingoFrog popup.',
      noMatch: 'No matching links',
    },
    phrase: {
      title: '💬 Insert phrase',
      placeholder: 'Search phrases or tags…',
      none: 'No phrases yet. Add them in the LingoFrog popup.',
      noMatch: 'No matching phrases',
    },
  };

  // Gmail's content.js: { usePaste, handleShortcut(kind), beforeOpen() }.
  let host = null;
  // The open picker: { kind, el, saved, corpus, loaded, acceptWhenLoaded,
  // root, header, input, list, results, index }.
  let picker = null;
  let toastEl = null;
  let toastTimer = null;
  let lastCall = { kind: null, time: 0 };

  // ── Styles ───────────────────────────────────────────────────

  // Inline and !important, after resetting everything the page's CSS
  // could have set.
  function css(el, styles) {
    el.style.setProperty('all', 'initial', 'important');
    for (const [prop, value] of Object.entries(styles)) {
      el.style.setProperty(prop, value, 'important');
    }
    return el;
  }

  const MONO = "'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace";
  const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

  function make(tag, styles, text) {
    const el = document.createElement(tag);
    css(el, styles);
    if (text != null) el.textContent = text;
    return el;
  }

  // ── Where the cursor is ──────────────────────────────────────

  function connected() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // This frame has the keyboard focus itself, not one of its iframes.
  function isFocusedFrame() {
    const a = document.activeElement;
    return document.hasFocus() && !(a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME'));
  }

  function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  // Inputs that have a cursor (email and number inputs don't expose
  // one). Never password fields.
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel']);

  function isTextControl(el) {
    return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(el.type));
  }

  function editableTarget() {
    const el = deepActiveElement();
    if (!el || el.disabled || el.readOnly) return null;
    if (isTextControl(el) || el.isContentEditable) return el;
    return null;
  }

  function selectionFor(el) {
    const root = el.getRootNode();
    if (root !== document && typeof root.getSelection === 'function') return root.getSelection();
    return window.getSelection();
  }

  function saveSelection(el) {
    if (isTextControl(el)) return { start: el.selectionStart, end: el.selectionEnd };
    const sel = selectionFor(el);
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      if (el.contains(range.commonAncestorContainer)) return { range: range.cloneRange() };
    }
    return {};
  }

  function restoreSelection(el, saved) {
    el.focus({ preventScroll: true });
    try {
      if (isTextControl(el)) {
        if (saved.start != null) el.setSelectionRange(saved.start, saved.end);
      } else if (saved.range) {
        const sel = selectionFor(el);
        sel.removeAllRanges();
        sel.addRange(saved.range);
      }
    } catch (e) {
      // The editor redrew while the picker was open; insert wherever
      // its cursor is now.
    }
  }

  // Where to open the picker: just below the cursor, measured without
  // touching the editor's DOM (editors redraw when it changes).
  function anchorRect(el, saved) {
    if (saved.range) {
      const r = saved.range.cloneRange();
      r.collapse(false);
      const rects = r.getClientRects();
      const rect = rects.length ? rects[rects.length - 1] : r.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return rect;
      const node = r.startContainer.nodeType === Node.ELEMENT_NODE
        ? r.startContainer
        : r.startContainer.parentElement;
      if (node) {
        const nr = node.getBoundingClientRect();
        if (nr.width || nr.height) {
          return { left: nr.left, top: nr.top, bottom: nr.top + Math.min(nr.height, 24) };
        }
      }
    }
    const er = el.getBoundingClientRect();
    if (el.tagName === 'INPUT') return er;
    return { left: er.left, top: er.top, bottom: er.top + Math.min(er.height, 28) };
  }

  // ── What goes in ─────────────────────────────────────────────

  // A link's address with UTM tags, if "Include UTM parameters when
  // copying or inserting links" is on, as the popup's Copy URL makes it.
  function linkHref(corpus, url) {
    return corpus.config.applyUtmOnCopy !== false ? corpus.utmRules.applyTo(url) : url;
  }

  // A link: its URL. In a rich text box it's a clickable link whose text
  // is the URL (an email address for a mailto: link), or the
  // highlighted text if any.
  function linkContent(corpus, url, el, saved) {
    const href = linkHref(corpus, url);
    if (isTextControl(el) || !PhraseFormat.safeHref(href)) return { text: href };
    const highlighted = saved.range ? saved.range.toString() : '';
    const label = highlighted.trim() ? highlighted : href.replace(/^(mailto|tel):/i, '');
    const esc = PhraseFormat.escapeHtml;
    return { text: href, html: `<a href="${esc(href)}">${esc(label)}</a>`, link: true };
  }

  // A phrase: its text, and in a rich text box, HTML for its formatting
  // and for links. Text matching a link rule is linked, as autocomplete
  // does in Gmail, when "Auto-link hyperlinks" is on.
  function phraseContent(corpus, phrase, el) {
    if (isTextControl(el)) return { text: phrase };
    let blocks = PhraseFormat.blocksOf(phrase, corpus.getRich(phrase));
    // The link rules it used, to count as used too.
    const linkTriggers = [];
    if (corpus.config.autoLink !== false) {
      blocks = PhraseFormat.linkify(
        blocks,
        (text) => {
          const found = corpus.linkRules.findLinks(text);
          linkTriggers.push(...found.map((m) => m.trigger));
          return found;
        },
        (url) => linkHref(corpus, url)
      );
    }
    if (PhraseFormat.isPlain(blocks)) return { text: phrase };
    const html = PhraseFormat.toHtml(blocks);
    return {
      text: phrase,
      html,
      linkTriggers,
      // For inserting directly: the first line joins the cursor's line.
      inlineHtml: PhraseFormat.toHtml(blocks, { inlineFirst: true }),
      link: /<a /.test(html),
    };
  }

  // ── Inserting ────────────────────────────────────────────────

  // Hands the content to the page as a paste. Returns true if the page
  // took it (its editor called preventDefault and inserted it).
  function dispatchPaste(el, { text, html }) {
    let data;
    try {
      data = new DataTransfer();
      data.setData('text/plain', text);
      if (html) data.setData('text/html', html);
    } catch (e) {
      return false;
    }
    let target = el;
    if (!isTextControl(el)) {
      const sel = selectionFor(el);
      const node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
      const elNode = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
      if (elNode && el.contains(elNode)) target = elNode;
    }
    const event = new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }

  function insert(el, content) {
    const usePaste = !(host && host.usePaste === false);
    if (usePaste && dispatchPaste(el, content)) return;

    // The page didn't handle the paste (a plain text box, or Gmail):
    // insert it the way typing would, so Undo takes it back out.
    if (isTextControl(el)) {
      if (!document.execCommand('insertText', false, content.text)) {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        el.setRangeText(content.text, start, end, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (content.html) {
      document.execCommand('insertHTML', false, content.inlineHtml || content.html);
      if (content.link) moveCaretPastLink(el);
    } else {
      document.execCommand('insertText', false, content.text);
    }
  }

  // After a link goes in (or a phrase ending in one), the caret sits at
  // the end of the link's text, inside it, and whatever's typed next
  // would become part of the link.
  function moveCaretPastLink(el) {
    const sel = selectionFor(el);
    if (!sel || !sel.rangeCount) return;
    const node = sel.getRangeAt(0).endContainer;
    const elNode = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const a = elNode && elNode.closest('a');
    if (!a || !el.contains(a)) return;
    const range = document.createRange();
    range.setStartAfter(a);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ── Picker ───────────────────────────────────────────────────

  /**
   * A URL typed or pasted into the link search, for inserting once.
   * Same rules as Gmail's ⌘L search (parseUrlInput in content.js):
   * http(s) URLs, bare hosts like example.com/docs (https:// added),
   * and mailto:/tel: links. Anything else is search text.
   */
  function parseUrlInput(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;
    if (/^(javascript|data|vbscript|file):/i.test(trimmed)) return null;
    if (/^(mailto|tel):/i.test(trimmed)) return trimmed;
    let candidate = trimmed;
    if (!/^https?:\/\//i.test(candidate)) {
      const slash = candidate.indexOf('/');
      const hostPart = slash === -1 ? candidate : candidate.slice(0, slash);
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(hostPart)) return null;
      candidate = 'https://' + candidate;
    }
    try {
      const url = new URL(candidate);
      if (!url.hostname.includes('.')) return null;
      return url.toString();
    } catch (e) {
      return null;
    }
  }

  // With nothing typed, the most used first; with a search, the best
  // match first, the most used first among equally good matches (see
  // Corpus.rankResults).
  function findResults(kind, corpus, filter) {
    if (kind === 'link') {
      const results = [];
      const url = parseUrlInput(filter);
      if (url) results.push({ url, typed: true });
      for (const r of corpus.searchLinks(filter)) results.push({ trigger: r.trigger, url: r.url });
      return results.slice(0, MAX_RESULTS);
    }
    return corpus.getAllPhrases(filter).slice(0, MAX_RESULTS).map((r) => ({ phrase: r.phrase }));
  }

  function buildPicker() {
    const root = make('div', {
      display: 'block',
      position: 'fixed',
      'z-index': '2147483647',
      width: '360px',
      'max-width': 'calc(100vw - 20px)',
      'box-sizing': 'border-box',
      background: '#ffffff',
      border: '1px solid #6da34d',
      'border-radius': '10px',
      'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(109, 163, 77, 0.15)',
      'font-family': MONO,
      'font-size': '12px',
      'line-height': '1.4',
      color: '#1a1a1a',
      overflow: 'hidden',
      'text-align': 'left',
    });
    root.id = ROOT_ID;
    root.setAttribute('role', 'dialog');

    const header = make('div', {
      display: 'block',
      'font-family': MONO,
      'font-size': '11px',
      'font-weight': '600',
      color: '#1a1a1a',
      padding: '8px 12px 6px',
      'border-bottom': '1px solid #ececec',
    });

    const input = make('input', {
      display: 'block',
      'box-sizing': 'border-box',
      width: 'calc(100% - 24px)',
      margin: '6px 12px',
      padding: '6px 8px',
      background: '#ffffff',
      border: '1px solid #6da34d',
      'border-radius': '6px',
      color: '#1a1a1a',
      'font-family': MONO,
      'font-size': '12px',
      'line-height': '1.4',
      outline: 'none',
    });
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const list = make('div', {
      display: 'block',
      'max-height': '220px',
      'overflow-y': 'auto',
      padding: '2px 0',
    });
    list.setAttribute('role', 'listbox');

    const hint = make('div', {
      display: 'block',
      'font-family': MONO,
      'font-size': '10px',
      color: '#a0a0a0',
      padding: '5px 12px',
      'border-top': '1px solid #ececec',
    }, '↑↓ choose · Enter insert · Esc close');

    root.append(header, input, list, hint);
    return { root, header, input, list };
  }

  function rowFor(kind, corpus, r) {
    const row = make('div', {
      display: 'flex',
      'align-items': 'center',
      gap: '8px',
      padding: '6px 12px',
      cursor: 'pointer',
      'font-family': MONO,
      'font-size': '12px',
      color: '#1a1a1a',
    });
    row.setAttribute('role', 'option');
    const main = make('span', {
      display: 'block',
      flex: '1 1 auto',
      'min-width': '0',
      'white-space': 'nowrap',
      overflow: 'hidden',
      'text-overflow': 'ellipsis',
      'font-family': MONO,
      'font-size': '12px',
      color: 'inherit',
    });
    main.className = 'lfq-main';
    row.appendChild(main);

    const side = (text) => make('span', {
      display: 'inline',
      'flex-shrink': '0',
      'white-space': 'nowrap',
      'font-family': MONO,
      'font-size': '10px',
      color: '#7a7a7a',
    }, text);

    if (kind === 'link') {
      if (r.typed) {
        main.textContent = 'Insert URL: ' + r.url.replace(/^https?:\/\//, '');
        main.style.setProperty('font-weight', '600', 'important');
        main.style.setProperty('color', '#4d7a2e', 'important');
      } else {
        main.textContent = r.trigger;
        main.title = r.url;
        row.appendChild(side(r.url.replace(/^https?:\/\//, '').split('/')[0]));
      }
      return row;
    }

    main.textContent = r.phrase.replace(/\s*\n+\s*/g, ' ');
    main.title = r.phrase;
    const tag = corpus.getTag(r.phrase);
    if (tag) {
      row.appendChild(make('span', {
        display: 'inline',
        'flex-shrink': '0',
        'white-space': 'nowrap',
        background: '#e7f0dc',
        color: '#4d7a2e',
        'border-radius': '4px',
        padding: '1px 5px',
        'font-family': MONO,
        'font-size': '10px',
        'font-weight': '600',
        'letter-spacing': '0.5px',
      }, tag));
    }
    const count = PhraseFormat.wordCount(r.phrase);
    row.appendChild(side(`${count} ${count === 1 ? 'word' : 'words'}`));
    return row;
  }

  function render() {
    const p = picker;
    const info = KINDS[p.kind];
    p.header.textContent = info.title;
    p.input.placeholder = info.placeholder;
    p.results = p.loaded ? findResults(p.kind, p.corpus, p.input.value) : [];
    p.index = 0;
    p.list.textContent = '';
    if (!p.loaded) return;

    if (!p.results.length) {
      const empty = p.input.value.trim() ? info.noMatch : info.none;
      p.list.appendChild(make('div', {
        display: 'block',
        padding: '12px',
        'text-align': 'center',
        'font-family': MONO,
        'font-size': '11px',
        color: '#a0a0a0',
        'white-space': 'normal',
      }, empty));
      return;
    }

    p.results.forEach((r, i) => {
      const row = rowFor(p.kind, p.corpus, r);
      // mousedown, not click: keep the focus in the search box.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        p.index = i;
        accept();
      });
      row.addEventListener('mouseenter', () => {
        p.index = i;
        updateSelection();
      });
      p.list.appendChild(row);
    });
    updateSelection();
  }

  function updateSelection() {
    const rows = picker.list.children;
    for (let i = 0; i < rows.length; i++) {
      const on = i === picker.index;
      rows[i].style.setProperty('background', on ? '#e7f0dc' : 'transparent', 'important');
      rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
      const main = rows[i].querySelector('.lfq-main');
      const r = picker.results[i];
      if (main && !(r && r.typed)) {
        main.style.setProperty('color', on ? '#4d7a2e' : '#1a1a1a', 'important');
      }
    }
    const row = rows[picker.index];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  function place(root, rect) {
    const margin = 10;
    root.style.setProperty('left', rect.left + 'px', 'important');
    root.style.setProperty('top', rect.bottom + 6 + 'px', 'important');
    const r = root.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    if (left + r.width > window.innerWidth - margin) left = window.innerWidth - r.width - margin;
    if (left < margin) left = margin;
    if (top + r.height > window.innerHeight - margin) top = rect.top - r.height - 6;
    if (top < margin) top = margin;
    root.style.setProperty('left', left + 'px', 'important');
    root.style.setProperty('top', top + 'px', 'important');
  }

  function openPicker(kind, el, saved, corpus) {
    const { root, header, input, list } = buildPicker();
    picker = { kind, el, saved, corpus, loaded: false, root, header, input, list, results: [], index: 0 };
    render();
    // On <html>, not <body>: in some editors the body is the text box.
    document.documentElement.appendChild(root);
    place(root, anchorRect(el, saved));

    input.addEventListener('input', (e) => {
      e.stopPropagation();
      render();
    });
    input.addEventListener('keydown', onPickerKeydown);
    // Keep the page's own shortcuts from seeing typing in the search.
    for (const type of ['keypress', 'keyup']) {
      input.addEventListener(type, (e) => e.stopPropagation());
    }
    root.addEventListener('focusout', () => {
      setTimeout(() => {
        if (picker && picker.root === root && !root.contains(document.activeElement)) {
          closePicker({ restore: false });
        }
      }, 0);
    });
    input.focus({ preventScroll: true });
  }

  function onPickerKeydown(e) {
    e.stopPropagation();
    if (e.isComposing || !picker) return;
    const p = picker;
    const n = p.results.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) { p.index = (p.index + 1) % n; updateSelection(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) { p.index = (p.index - 1 + n) % n; updateSelection(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Typed ahead of the list loading: insert once it's there.
      if (!p.loaded) p.acceptWhenLoaded = true;
      else accept();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePicker({ restore: true });
    } else {
      // The other picker's shortcut, when it reaches the page as a key
      // (it may not when Chrome runs it as the extension's shortcut).
      const kind = shortcutKind(e);
      if (kind) {
        e.preventDefault();
        switchKind(kind);
      }
    }
  }

  function switchKind(kind) {
    if (!picker || picker.kind === kind) return;
    picker.kind = kind;
    picker.input.value = '';
    render();
    picker.input.focus({ preventScroll: true });
  }

  function closePicker({ restore }) {
    if (!picker) return;
    const p = picker;
    picker = null;
    p.root.remove();
    if (restore) restoreSelection(p.el, p.saved);
  }

  function accept() {
    const p = picker;
    const r = p && p.results[p.index];
    if (!r) return;
    const content = p.kind === 'link'
      ? linkContent(p.corpus, r.url, p.el, p.saved)
      : phraseContent(p.corpus, r.phrase, p.el);
    closePicker({ restore: true });
    try {
      insert(p.el, content);
    } catch (e) {
      console.warn('[LingoFrog] Insert failed:', e);
      return;
    }
    // Count what went in as used. Fails in a tab left open across an
    // update; it's in anyway.
    if (p.kind === 'phrase') {
      p.corpus.recordUsage(r.phrase)
        .then(() => p.corpus.recordLinkUsage(content.linkTriggers || []))
        .catch(() => {});
    } else if (!r.typed) {
      p.corpus.recordLinkUsage(r.trigger).catch(() => {});
    }
  }

  // ── Toast ────────────────────────────────────────────────────

  function toast(message) {
    if (toastEl) toastEl.remove();
    clearTimeout(toastTimer);
    toastEl = make('div', {
      display: 'block',
      position: 'fixed',
      'z-index': '2147483647',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#ffffff',
      color: '#9a5b00',
      border: '1px solid #e0a43a',
      'border-radius': '8px',
      'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.1)',
      padding: '6px 12px',
      'font-family': SANS,
      'font-size': '12px',
      'font-weight': '600',
      'white-space': 'nowrap',
      'pointer-events': 'none',
    }, message);
    document.documentElement.appendChild(toastEl);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.remove();
      toastEl = null;
    }, 2800);
  }

  // ── Entry points ─────────────────────────────────────────────

  // 'link' for ⌥⇧L, 'phrase' for ⌥⇧P (Alt+Shift on Windows and Linux).
  // By code too, since on a Mac Option changes the key typed (Ò, ∏).
  function shortcutKind(e) {
    if (!e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey) return null;
    const key = (e.key || '').toLowerCase();
    if (e.code === 'KeyL' || key === 'l') return 'link';
    if (e.code === 'KeyP' || key === 'p') return 'phrase';
    return null;
  }

  async function handleCommand(kind) {
    if (kind !== 'link' && kind !== 'phrase') return;
    // One press can arrive twice, as the extension's shortcut and as a
    // key on the page (content.js). Act on it once.
    const now = Date.now();
    if (lastCall.kind === kind && now - lastCall.time < 500) return;
    lastCall = { kind, time: now };
    if (picker) {
      // Pressed while a picker is open: switch to that picker.
      if (picker.kind === kind) picker.input.focus({ preventScroll: true });
      else switchKind(kind);
      return;
    }
    if (!isFocusedFrame()) return;
    if (host && host.handleShortcut && host.handleShortcut(kind)) return;

    const el = editableTarget();
    if (!el) {
      toast('Click into a text box first');
      return;
    }
    if (host && host.beforeOpen) host.beforeOpen();
    const saved = saveSelection(el);

    if (!connected()) {
      toast('LingoFrog was updated. Reload this page to use it.');
      return;
    }
    // Open right away, so what's typed next goes into the search, and
    // list the links or phrases once they've loaded (a few ms).
    const corpus = new Corpus();
    openPicker(kind, el, saved, corpus);
    const p = picker;
    try {
      await corpus.load();
    } catch (e) {
      if (picker === p) closePicker({ restore: true });
      toast('LingoFrog was updated. Reload this page to use it.');
      return;
    }
    if (picker !== p) return;
    if (corpus.config.enabled === false) {
      closePicker({ restore: true });
      toast('LingoFrog is turned off in its settings');
      return;
    }
    p.loaded = true;
    render();
    if (p.acceptWhenLoaded) accept();
  }

  globalThis.LingoFrogQuick = {
    handleCommand,
    shortcutKind,
    setHost(h) { host = h; },
    isOpen: () => !!picker,
    // Whether an event came from the picker (or the picker is focused).
    contains: (node) => !!(picker && node && picker.root.contains(node)),
  };
})();
