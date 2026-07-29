/**
 * lillypad.js — Autocomplete, link picker, and save-phrase for the
 * LillyPad tab. Adapts the content.js patterns for a single
 * contenteditable div running inside the popup.
 *
 * Wrapped in an IIFE so top-level `let`s stay off popup.js's global
 * script scope (they'd collide otherwise — both are plain <script>s).
 */

(function () {
'use strict';

let corpus = null;
let lillypadArea = null;
let lillypadStatus = null;

let suggestionBox = null;
let currentSuggestions = [];
let selectedIndex = 0;
let bopBoxActive = false;
let debounceTimer = null;

let linkSearchBox = null;
let linkSearchInput = null;
let linkSearchList = null;
let linkSearchResults = [];
let linkSearchIndex = 0;
let linkSearchSelection = null;

let savePhraseChipBox = null;
let pendingSavePhraseChip = null;

let saveRuleChipBox = null;
let pendingSaveRuleChip = null;

let linkPromptBox = null;
let pendingLink = null;

let linkPreviewBox = null;
let linkPreviewTarget = null;

let successToastBox = null;
let successToastTimer = null;

// ── Init ──────────────────────────────────────────────────

function initLillypad(c) {
  corpus = c;
  lillypadArea = document.getElementById('lillypad-area');
  lillypadStatus = document.getElementById('lillypad-status');

  createSuggestionUI();
  createLinkSearchUI();
  createSavePhraseChipUI();
  createSaveRuleChipUI();
  createLinkPromptUI();
  createLinkPreviewUI();
  createSuccessToastUI();

  attachListeners();

  document.getElementById('btn-lillypad-copy').addEventListener('click', copyLillypad);
  document.getElementById('btn-lillypad-clear').addEventListener('click', clearLillypad);
}

window.initLillypad = initLillypad;

// ── Small helpers ─────────────────────────────────────────

function isLillypadActive() {
  const el = document.getElementById('tab-lillypad');
  return !!el && el.classList.contains('active');
}

function isInLillypad(node) {
  while (node) {
    if (node === lillypadArea) return true;
    node = node.parentNode;
  }
  return false;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clampToViewport(el, anchorRect) {
  const rect = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let left = parseFloat(el.style.left) || 0;
  let top = parseFloat(el.style.top) || 0;
  if (rect.right > vw - 4) left = Math.max(4, vw - rect.width - 4);
  if (rect.bottom > vh - 4 && anchorRect) {
    top = Math.max(4, anchorRect.top - rect.height - 4);
  }
  if (left < 4) left = 4;
  if (top < 4) top = 4;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function getCursorRect() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  let rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    const temp = document.createElement('span');
    temp.textContent = '​';
    range.insertNode(temp);
    rect = temp.getBoundingClientRect();
    temp.remove();
  }
  return rect;
}

// ── Typed-text extraction ─────────────────────────────────

// Text from start of the current sentence up to the caret. Splits
// on `.!?` and newlines, mirroring content.js so lookup keys behave
// the same in both surfaces.
function getTypedText() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '';
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return '';
  if (!isInLillypad(range.startContainer)) return '';

  const preRange = document.createRange();
  preRange.selectNodeContents(lillypadArea);
  preRange.setEnd(range.startContainer, range.startOffset);

  // innerText on a cloned fragment container is what turns block
  // breaks (<div>, <br>) into '\n' — a plain Range.toString() would
  // lose them, breaking sentence-boundary splitting.
  const tmp = document.createElement('div');
  tmp.appendChild(preRange.cloneContents());
  const text = tmp.innerText
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ');

  const parts = text.split(/[.!?\n]+/);
  return (parts[parts.length - 1] || '').replace(/^\s+/, '');
}

// Suppress suggestions when the caret is inside an existing
// sentence — inserting would shove text into the middle of what's
// already there. Only counts word characters before the next
// hard boundary.
function hasTextRemainingInSentence() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;
  if (!isInLillypad(range.startContainer)) return false;

  const postRange = document.createRange();
  postRange.setStart(range.startContainer, range.startOffset);
  postRange.setEnd(lillypadArea, lillypadArea.childNodes.length);
  const tmp = document.createElement('div');
  tmp.appendChild(postRange.cloneContents());
  const text = tmp.innerText;
  const firstSentence = text.split(/[.!?\n]/)[0];
  return /\w/.test(firstSentence);
}

// ── Suggestion box ────────────────────────────────────────

function createSuggestionUI() {
  suggestionBox = document.createElement('div');
  suggestionBox.id = 'lingofrog-suggestions';
  suggestionBox.className = 'lingofrog-box';
  document.body.appendChild(suggestionBox);
}

function showSuggestions(suggestions, anchorRect) {
  currentSuggestions = suggestions;
  selectedIndex = 0;

  if (!suggestions.length) {
    hideSuggestions();
    return;
  }

  suggestionBox.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'lingofrog-header';
  const headerIcon = document.createElement('img');
  headerIcon.src = 'icons/icon48.png';
  headerIcon.className = 'lingofrog-header-icon';
  headerIcon.alt = '';
  header.appendChild(headerIcon);
  header.appendChild(document.createTextNode('LingoFrog'));
  suggestionBox.appendChild(header);

  suggestions.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'lingofrog-item' + (i === 0 ? ' lingofrog-selected' : '');
    item.dataset.index = i;

    const num = document.createElement('span');
    num.className = 'lingofrog-num';
    num.textContent = `${i + 1}`;

    const text = document.createElement('span');
    text.className = 'lingofrog-text';
    const display = s.completion.length > 60 ? s.completion.slice(0, 60) + '…' : s.completion;
    const linksInPhrase = corpus.linkRules.findLinks(s.full);
    if (linksInPhrase.length > 0) {
      text.innerHTML = '🔗 ' + escapeHtml(display);
    } else {
      text.textContent = display;
    }

    item.appendChild(num);
    item.appendChild(text);

    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = i;
      acceptSuggestion();
    });

    suggestionBox.appendChild(item);
  });

  const hint = document.createElement('div');
  hint.className = 'lingofrog-hint';
  hint.textContent = 'Tab accept · ↑↓ cycle · Esc close';
  suggestionBox.appendChild(hint);

  if (anchorRect) {
    suggestionBox.style.left = anchorRect.left + 'px';
    suggestionBox.style.top = (anchorRect.bottom + 4) + 'px';
  }
  suggestionBox.style.display = 'block';
  if (anchorRect) clampToViewport(suggestionBox, anchorRect);
}

function hideSuggestions() {
  bopBoxActive = false;
  if (suggestionBox) suggestionBox.style.display = 'none';
  currentSuggestions = [];
  selectedIndex = 0;
}

function updateSuggestionSelection(newIndex) {
  selectedIndex = newIndex;
  const items = suggestionBox.querySelectorAll('.lingofrog-item');
  items.forEach((item, i) => {
    item.classList.toggle('lingofrog-selected', i === selectedIndex);
  });
}

function acceptSuggestion() {
  if (!currentSuggestions.length || selectedIndex >= currentSuggestions.length) return;
  const selected = currentSuggestions[selectedIndex];
  const completion = selected.completion;
  hideSuggestions();

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.collapse(false);

  const textNode = document.createTextNode(completion);
  range.insertNode(textNode);

  const parent = textNode.parentNode;
  if (parent) {
    const prevSibling = textNode.previousSibling;
    parent.normalize();
    const mergedNode = (prevSibling && prevSibling.nodeType === Node.TEXT_NODE)
      ? prevSibling
      : textNode;
    const lastNode = applyLinksInTextNode(mergedNode);
    const cursorTarget = lastNode || mergedNode;
    const newRange = document.createRange();
    if (cursorTarget.nodeType === Node.TEXT_NODE) {
      newRange.setStart(cursorTarget, cursorTarget.length);
    } else {
      newRange.setStartAfter(cursorTarget);
    }
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }

  corpus.recordUsage(selected.full);

  // Bops: after accepting a phrase, immediately surface its
  // follower phrases as suggestions (bypasses triggerAfterChars —
  // the user has typed zero new chars). Recursion is implicit:
  // when they accept a bop, acceptSuggestion runs again and
  // re-checks getFollowedBy, chaining A → B → C.
  if (corpus.config.autoComplete !== false) {
    const followers = corpus.getFollowedBy(selected.full) || [];
    if (followers.length) {
      const bopSuggestions = followers.map((f, i) => ({
        completion: ' ' + f,
        full: f,
        score: 1e6 - i,
      }));
      setTimeout(() => {
        const rect = getCursorRect();
        if (rect) {
          showSuggestions(bopSuggestions, rect);
          bopBoxActive = true;
        }
      }, 0);
    }
  }
}

// ── Link auto-wrap ────────────────────────────────────────

function applyLinksInTextNode(textNode) {
  if (corpus.config.autoLink === false) return null;
  if (corpus.linkRules.rules.size === 0) return null;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return null;
  if (textNode.parentNode && textNode.parentNode.tagName === 'A') return null;

  const text = textNode.textContent;
  const matches = corpus.linkRules.findLinks(text);
  if (!matches.length) return null;

  const parent = textNode.parentNode;
  if (!parent) return null;

  const frag = document.createDocumentFragment();
  let cursor = 0;
  let lastNode = null;
  for (const m of matches) {
    if (m.start > cursor) {
      lastNode = document.createTextNode(text.slice(cursor, m.start));
      frag.appendChild(lastNode);
    }
    const a = document.createElement('a');
    a.href = corpus.utmRules.applyTo(m.url);
    a.textContent = text.slice(m.start, m.end);
    a.target = '_blank';
    a.rel = 'noopener';
    frag.appendChild(a);
    lastNode = a;
    cursor = m.end;
  }
  if (cursor < text.length) {
    lastNode = document.createTextNode(text.slice(cursor));
    frag.appendChild(lastNode);
  }
  parent.insertBefore(frag, textNode);
  parent.removeChild(textNode);
  return lastNode;
}

// ── Link search (Cmd+L) ───────────────────────────────────

function createLinkSearchUI() {
  linkSearchBox = document.createElement('div');
  linkSearchBox.id = 'lingofrog-link-search';
  linkSearchBox.className = 'lingofrog-link-search';

  const header = document.createElement('div');
  header.className = 'lingofrog-ls-header';
  header.textContent = '🔗 Insert Link';
  linkSearchBox.appendChild(header);

  linkSearchInput = document.createElement('input');
  linkSearchInput.className = 'lingofrog-ls-input';
  linkSearchInput.type = 'text';
  linkSearchInput.placeholder = 'Search links or paste a URL…';
  linkSearchBox.appendChild(linkSearchInput);

  linkSearchList = document.createElement('div');
  linkSearchList.className = 'lingofrog-ls-list';
  linkSearchBox.appendChild(linkSearchList);

  const hint = document.createElement('div');
  hint.className = 'lingofrog-ls-hint';
  hint.textContent = '↑↓ navigate · Enter or ⌘L insert · Esc close';
  linkSearchBox.appendChild(hint);

  document.body.appendChild(linkSearchBox);

  linkSearchInput.addEventListener('input', () => {
    renderLinkSearchResults(linkSearchInput.value);
  });
  linkSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (linkSearchResults.length) {
        linkSearchIndex = (linkSearchIndex + 1) % linkSearchResults.length;
        updateLinkSearchSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (linkSearchResults.length) {
        linkSearchIndex = (linkSearchIndex - 1 + linkSearchResults.length) % linkSearchResults.length;
        updateLinkSearchSelection();
      }
    } else if (e.key === 'Enter' || ((e.metaKey || e.ctrlKey) && e.key === 'l')) {
      e.preventDefault();
      e.stopPropagation();
      acceptLinkSearch();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideLinkSearch();
    }
  });
}

function parseUrlInput(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) return null;
  if (/^(mailto|tel):/i.test(trimmed)) return trimmed;
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    const slashIdx = candidate.indexOf('/');
    const host = slashIdx === -1 ? candidate : candidate.slice(0, slashIdx);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return null;
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

function showLinkSearch() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  if (!isInLillypad(sel.getRangeAt(0).startContainer)) return;

  const range = sel.getRangeAt(0);
  const text = sel.toString().trim();
  if (!text) return;

  linkSearchSelection = { range: range.cloneRange(), text };

  const rect = range.getBoundingClientRect();
  linkSearchBox.style.left = rect.left + 'px';
  linkSearchBox.style.top = (rect.bottom + 6) + 'px';
  linkSearchBox.style.display = 'block';
  clampToViewport(linkSearchBox, rect);

  linkSearchInput.value = '';
  renderLinkSearchResults('');
  setTimeout(() => linkSearchInput.focus(), 0);
}

function hideLinkSearch() {
  if (linkSearchBox) linkSearchBox.style.display = 'none';
  linkSearchResults = [];
  linkSearchIndex = 0;
  linkSearchSelection = null;
}

function renderLinkSearchResults(filter) {
  const all = corpus.linkRules.getAll();
  const lower = filter.toLowerCase();
  const ruleMatches = lower
    ? all.filter((r) => r.trigger.includes(lower) || r.url.toLowerCase().includes(lower))
    : all;

  const urlCandidate = parseUrlInput(filter);
  const results = [];
  if (urlCandidate) results.push({ kind: 'url', url: urlCandidate });
  for (const r of ruleMatches) {
    results.push({ kind: 'rule', trigger: r.trigger, url: r.url, label: r.label });
  }
  linkSearchResults = results;
  linkSearchIndex = 0;
  linkSearchList.innerHTML = '';

  if (!linkSearchResults.length) {
    const empty = document.createElement('div');
    empty.className = 'lingofrog-ls-empty';
    empty.textContent = filter ? 'No matching links' : 'No link rules defined';
    linkSearchList.appendChild(empty);
    return;
  }

  linkSearchResults.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'lingofrog-ls-item' + (i === 0 ? ' lingofrog-ls-selected' : '');
    item.dataset.index = i;
    if (r.kind === 'url') item.classList.add('lingofrog-ls-url-insert');

    const trigger = document.createElement('span');
    trigger.className = 'lingofrog-ls-trigger';
    if (r.kind === 'url') {
      const label = document.createElement('span');
      label.className = 'lingofrog-ls-url-insert-label';
      label.textContent = '🔗 Insert URL: ';
      const target = document.createElement('span');
      target.textContent = r.url.replace(/^https?:\/\//, '');
      trigger.appendChild(label);
      trigger.appendChild(target);
    } else {
      trigger.textContent = r.trigger;
    }
    item.appendChild(trigger);
    if (r.kind === 'rule') {
      const url = document.createElement('span');
      url.className = 'lingofrog-ls-url';
      url.textContent = r.url.replace(/^https?:\/\//, '').split('/')[0];
      item.appendChild(url);
    }
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      linkSearchIndex = i;
      acceptLinkSearch();
    });
    linkSearchList.appendChild(item);
  });
}

function updateLinkSearchSelection() {
  const items = linkSearchList.querySelectorAll('.lingofrog-ls-item');
  items.forEach((item, i) => {
    item.classList.toggle('lingofrog-ls-selected', i === linkSearchIndex);
  });
  const selected = items[linkSearchIndex];
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function acceptLinkSearch() {
  if (!linkSearchSelection || !linkSearchResults.length) {
    hideLinkSearch();
    return;
  }
  const chosen = linkSearchResults[linkSearchIndex];
  const { range, text: highlightedText } = linkSearchSelection;
  let insertedAnchor = null;

  try {
    const a = document.createElement('a');
    a.href = corpus.utmRules.applyTo(chosen.url);
    a.target = '_blank';
    a.rel = 'noopener';
    range.surroundContents(a);
    insertedAnchor = a;
  } catch (e) {
    try {
      const text = range.toString();
      range.deleteContents();
      const a = document.createElement('a');
      a.href = corpus.utmRules.applyTo(chosen.url);
      a.textContent = text;
      a.target = '_blank';
      a.rel = 'noopener';
      range.insertNode(a);
      insertedAnchor = a;
    } catch (err) {
      console.error('[LillyPad] Link insert error:', err);
    }
  }

  hideLinkSearch();

  // Return focus + caret to the lillypad. The link-search input
  // stole focus while it was open; without this the user's next
  // keystroke lands nowhere and the editor feels broken.
  if (insertedAnchor) {
    lillypadArea.focus();
    const sel = window.getSelection();
    const newRange = document.createRange();
    newRange.setStartAfter(insertedAnchor);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }

  // If the user chose an ad-hoc URL (rather than a saved rule),
  // offer to save the highlighted text → URL as a new rule.
  if (insertedAnchor && chosen.kind === 'url' && corpus.config.showSaveRuleChip !== false) {
    setTimeout(() => {
      maybeShowSaveRuleChip({ url: chosen.url }, highlightedText, insertedAnchor);
    }, 0);
  }
}

// ── Link prompt (on-type detection) ────────────────────────
//
// As the user types, checkForLinkTriggers scans the caret's text
// node for saved link-rule triggers. When one is found, a small
// floating prompt anchored to the trigger tells the user "⌘L to
// link this". ⌘L (with no selection) accepts the prompt and wraps
// the matched text in an <a>.

function createLinkPromptUI() {
  linkPromptBox = document.createElement('div');
  linkPromptBox.id = 'lingofrog-link-prompt';
  linkPromptBox.className = 'lingofrog-link-prompt';
  document.body.appendChild(linkPromptBox);
}

function showLinkPrompt(trigger, url, anchorRect) {
  if (!linkPromptBox || !anchorRect) return;

  const domain = url.replace(/^https?:\/\//, '').split('/')[0];
  linkPromptBox.innerHTML = '';

  const icon = document.createElement('span');
  icon.className = 'lingofrog-lp-icon';
  icon.textContent = '🔗';

  const label = document.createElement('span');
  label.className = 'lingofrog-lp-label';
  label.innerHTML = 'Link <strong>' + escapeHtml(trigger) + '</strong>';

  const urlHint = document.createElement('span');
  urlHint.className = 'lingofrog-lp-url';
  urlHint.textContent = domain;

  const hint = document.createElement('span');
  hint.className = 'lingofrog-lp-hint';
  hint.textContent = '⌘L';

  linkPromptBox.appendChild(icon);
  linkPromptBox.appendChild(label);
  linkPromptBox.appendChild(urlHint);
  linkPromptBox.appendChild(hint);

  let top = anchorRect.top - 32;
  if (top < 10) top = anchorRect.bottom + 4;

  linkPromptBox.style.left = anchorRect.left + 'px';
  linkPromptBox.style.top = top + 'px';
  linkPromptBox.style.display = 'flex';
  clampToViewport(linkPromptBox, anchorRect);

  linkPromptBox.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    acceptLinkPrompt();
  };
}

function hideLinkPrompt() {
  if (linkPromptBox) linkPromptBox.style.display = 'none';
  pendingLink = null;
}

function acceptLinkPrompt() {
  if (!pendingLink) return;
  const { textNode, url, trigger } = pendingLink;

  try {
    const currentText = textNode.textContent;
    const lower = currentText.toLowerCase();
    const idx = lower.lastIndexOf(trigger.toLowerCase());
    if (idx === -1) { hideLinkPrompt(); return; }

    const actualStart = idx;
    const actualEnd = idx + trigger.length;
    const matchedText = currentText.slice(actualStart, actualEnd);

    const before = currentText.slice(0, actualStart);
    const after = currentText.slice(actualEnd);

    const a = document.createElement('a');
    a.href = corpus.utmRules.applyTo(url);
    a.textContent = matchedText;
    a.target = '_blank';
    a.rel = 'noopener';

    const parent = textNode.parentNode;
    if (!parent) { hideLinkPrompt(); return; }

    if (after) {
      const afterNode = document.createTextNode(after);
      parent.insertBefore(afterNode, textNode.nextSibling);
    }
    parent.insertBefore(a, textNode.nextSibling);
    textNode.textContent = before;
    if (!before) parent.removeChild(textNode);

    const sel = window.getSelection();
    const range = document.createRange();
    if (a.nextSibling) range.setStart(a.nextSibling, 0);
    else range.setStartAfter(a);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) {
    console.error('[LillyPad] Link prompt apply error:', e);
  }
  hideLinkPrompt();
}

function checkForLinkTriggers() {
  if (!corpus || corpus.linkRules.rules.size === 0) return;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return;
  if (!isInLillypad(range.startContainer)) return;

  let textNode = range.startContainer;
  // If the range anchors on an element, walk one back to a text node.
  if (textNode.nodeType !== Node.TEXT_NODE) {
    if (textNode.childNodes.length > 0 && range.startOffset > 0) {
      const candidate = textNode.childNodes[range.startOffset - 1];
      if (candidate && candidate.nodeType === Node.TEXT_NODE) {
        textNode = candidate;
      } else { return; }
    } else { return; }
  }

  const text = textNode.textContent;
  if (!text || text.length < 2) return;
  if (textNode.parentNode && textNode.parentNode.tagName === 'A') return;

  const offset = (textNode === range.startContainer) ? range.startOffset : text.length;
  const textUpToCursor = text.substring(0, offset);
  const matches = corpus.linkRules.findLinks(textUpToCursor);
  if (matches.length === 0) {
    if (pendingLink && pendingLink.textNode !== textNode) hideLinkPrompt();
    return;
  }

  const match = matches[matches.length - 1];
  // Give up if the caret has moved 5 chars past the match — the
  // user has clearly moved on.
  if (offset - match.end > 5) {
    if (pendingLink) hideLinkPrompt();
    return;
  }

  if (pendingLink &&
      pendingLink.textNode === textNode &&
      pendingLink.trigger === match.trigger &&
      pendingLink.start === match.start) {
    return;
  }

  const triggerRange = document.createRange();
  triggerRange.setStart(textNode, match.start);
  triggerRange.setEnd(textNode, match.end);
  const rect = triggerRange.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  pendingLink = {
    textNode,
    start: match.start,
    end: match.end,
    trigger: match.trigger,
    url: match.url,
  };
  showLinkPrompt(match.trigger, match.url, rect);
}

// ── Link hover preview ─────────────────────────────────────
//
// Small dark tooltip that appears when the user hovers an
// inserted <a>. Shows the resolved href (with UTMs applied).
// Also fires when the caret sits inside a link so a keyboard-only
// user still gets confirmation of the URL.

function createLinkPreviewUI() {
  linkPreviewBox = document.createElement('div');
  linkPreviewBox.className = 'lingofrog-link-preview';
  linkPreviewBox.style.cssText = [
    'position: fixed',
    'display: none',
    'z-index: 2147483647',
    'background: #1a1a1a',
    'color: #ffffff',
    'padding: 6px 10px',
    'border-radius: 6px',
    'font-size: 11px',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    'max-width: 320px',
    'overflow: hidden',
    'text-overflow: ellipsis',
    'white-space: nowrap',
    'box-shadow: 0 4px 12px rgba(0,0,0,0.3)',
    'pointer-events: none',
  ].join(';') + ';';
  document.body.appendChild(linkPreviewBox);
}

function showLinkPreview(anchor) {
  if (!linkPreviewBox || !anchor) return;
  linkPreviewTarget = anchor;
  linkPreviewBox.textContent = anchor.href;
  const rect = anchor.getBoundingClientRect();
  linkPreviewBox.style.left = rect.left + 'px';
  linkPreviewBox.style.top = (rect.bottom + 4) + 'px';
  linkPreviewBox.style.display = 'block';
  clampToViewport(linkPreviewBox, rect);
}

function hideLinkPreview() {
  if (linkPreviewBox) linkPreviewBox.style.display = 'none';
  linkPreviewTarget = null;
}

function updateLinkPreviewFromCaret() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { hideLinkPreview(); return; }
  const range = sel.getRangeAt(0);
  if (!isInLillypad(range.startContainer)) { hideLinkPreview(); return; }
  let node = range.startContainer;
  while (node && node !== lillypadArea) {
    if (node.tagName === 'A') { showLinkPreview(node); return; }
    node = node.parentNode;
  }
  // Only clear if the caret moved off — leave hover-driven previews alone.
  if (linkPreviewTarget && !linkPreviewTarget.matches(':hover')) hideLinkPreview();
}

// ── Save-rule chip (after Cmd+L URL insert) ────────────────

function createSaveRuleChipUI() {
  saveRuleChipBox = document.createElement('div');
  saveRuleChipBox.id = 'lingofrog-save-rule-chip';
  saveRuleChipBox.className = 'lingofrog-save-rule-chip';
  document.body.appendChild(saveRuleChipBox);
}

function maybeShowSaveRuleChip(chosen, highlightedText, anchorEl) {
  const trigger = (highlightedText || '').trim();
  if (!trigger) return;
  const existing = corpus.linkRules.rules.get(trigger.toLowerCase());
  if (existing && existing.url === chosen.url) return;
  showSaveRuleChip({ trigger, url: chosen.url, existingRule: existing, anchorEl });
}

function showSaveRuleChip({ trigger, url, existingRule, anchorEl }) {
  pendingSaveRuleChip = { trigger, url, existingRule, typedChars: 0 };
  saveRuleChipBox.innerHTML = '';

  const label = document.createElement('span');
  label.className = 'lingofrog-src-label';
  const truncated = trigger.length > 40 ? trigger.slice(0, 40) + '…' : trigger;
  if (existingRule) {
    label.innerHTML = 'Update <strong>' + escapeHtml(truncated) + '</strong> → new URL?';
  } else {
    label.innerHTML = 'Save <strong>' + escapeHtml(truncated) + '</strong> as a link rule?';
  }

  const btn = document.createElement('button');
  btn.className = 'lingofrog-src-btn';
  btn.textContent = existingRule ? 'Update' : 'Save';
  btn.tabIndex = -1;
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    acceptSaveRuleChip();
  });

  const dismiss = document.createElement('button');
  dismiss.className = 'lingofrog-src-dismiss';
  dismiss.textContent = '×';
  dismiss.title = 'Dismiss';
  dismiss.tabIndex = -1;
  dismiss.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideSaveRuleChip();
  });

  saveRuleChipBox.appendChild(label);
  saveRuleChipBox.appendChild(btn);
  saveRuleChipBox.appendChild(dismiss);

  const rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
  if (rect && rect.width) {
    saveRuleChipBox.style.left = rect.left + 'px';
    saveRuleChipBox.style.top = (rect.bottom + 6) + 'px';
    saveRuleChipBox.style.transform = '';
  } else {
    saveRuleChipBox.style.left = '50%';
    saveRuleChipBox.style.top = '20px';
    saveRuleChipBox.style.transform = 'translateX(-50%)';
  }
  saveRuleChipBox.style.display = 'flex';
  clampToViewport(saveRuleChipBox, rect);
}

function hideSaveRuleChip() {
  if (saveRuleChipBox) {
    saveRuleChipBox.style.display = 'none';
    saveRuleChipBox.style.transform = '';
  }
  pendingSaveRuleChip = null;
}

async function acceptSaveRuleChip() {
  if (!pendingSaveRuleChip) return;
  const { trigger, url } = pendingSaveRuleChip;
  corpus.linkRules.addRule(trigger, url);
  await corpus.linkRules.save();
  hideSaveRuleChip();
  showSuccessToast('✓ Link rule saved');
  if (typeof window.updateStats === 'function') window.updateStats();
}

// ── Save-phrase chip (Cmd+Shift+P) ─────────────────────────

function createSavePhraseChipUI() {
  savePhraseChipBox = document.createElement('div');
  savePhraseChipBox.id = 'lingofrog-save-phrase-chip';
  savePhraseChipBox.className = 'lingofrog-save-rule-chip';
  document.body.appendChild(savePhraseChipBox);
}

function maybeShowSavePhraseChip() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  if (!isInLillypad(sel.getRangeAt(0).startContainer)) return;
  const raw = sel.toString();
  const text = raw.trim().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  if (!text) return;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  showSavePhraseChip(text, rect);
}

function showSavePhraseChip(text, anchorRect) {
  const alreadyExists = corpus.phrases.has(text);
  pendingSavePhraseChip = { text, alreadyExists };
  savePhraseChipBox.innerHTML = '';

  const truncated = text.length > 50 ? text.slice(0, 50) + '…' : text;
  const label = document.createElement('span');
  label.className = 'lingofrog-src-label';
  if (alreadyExists) {
    label.innerHTML = 'Already saved — bump <strong>' + escapeHtml(truncated) + '</strong>?';
  } else {
    label.innerHTML = 'Save <strong>' + escapeHtml(truncated) + '</strong> as a phrase?';
  }

  const btn = document.createElement('button');
  btn.className = 'lingofrog-src-btn';
  btn.textContent = alreadyExists ? 'Bump' : 'Save';
  btn.tabIndex = -1;
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    acceptSavePhraseChip();
  });

  const dismiss = document.createElement('button');
  dismiss.className = 'lingofrog-src-dismiss';
  dismiss.textContent = '×';
  dismiss.title = 'Dismiss';
  dismiss.tabIndex = -1;
  dismiss.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideSavePhraseChip();
  });

  savePhraseChipBox.appendChild(label);
  savePhraseChipBox.appendChild(btn);
  savePhraseChipBox.appendChild(dismiss);

  if (anchorRect && anchorRect.width) {
    savePhraseChipBox.style.left = anchorRect.left + 'px';
    savePhraseChipBox.style.top = (anchorRect.bottom + 6) + 'px';
    savePhraseChipBox.style.transform = '';
  } else {
    savePhraseChipBox.style.left = '50%';
    savePhraseChipBox.style.top = '20px';
    savePhraseChipBox.style.transform = 'translateX(-50%)';
  }
  savePhraseChipBox.style.display = 'flex';
  clampToViewport(savePhraseChipBox, anchorRect);
}

function hideSavePhraseChip() {
  if (savePhraseChipBox) {
    savePhraseChipBox.style.display = 'none';
    savePhraseChipBox.style.transform = '';
  }
  pendingSavePhraseChip = null;
}

async function acceptSavePhraseChip() {
  if (!pendingSavePhraseChip) return;
  const { text } = pendingSavePhraseChip;
  const result = await corpus.addOrBumpPhrase(text, 'highlight');
  hideSavePhraseChip();
  if (result.added) {
    showSuccessToast('✓ Phrase saved');
  } else if (result.bumped) {
    showSuccessToast('✓ Phrase bumped');
  }
  if (typeof window.updateStats === 'function') window.updateStats();
}

// ── Success toast ──────────────────────────────────────────

function createSuccessToastUI() {
  successToastBox = document.createElement('div');
  successToastBox.id = 'lingofrog-success-toast';
  successToastBox.className = 'lingofrog-success-toast';
  document.body.appendChild(successToastBox);
}

function showSuccessToast(message) {
  if (!successToastBox) return;
  if (successToastTimer) clearTimeout(successToastTimer);
  successToastBox.textContent = message;
  successToastBox.style.left = '50%';
  successToastBox.style.top = '16px';
  successToastBox.style.transform = 'translateX(-50%)';
  successToastBox.style.display = 'block';
  successToastTimer = setTimeout(() => {
    successToastBox.style.display = 'none';
  }, 1500);
}

// ── Input handler ──────────────────────────────────────────

function handleLillypadInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (bopBoxActive) {
      bopBoxActive = false;
      return;
    }
    if (corpus.config.enabled === false) {
      hideSuggestions();
      hideLinkPrompt();
      return;
    }

    // Autocomplete pass
    if (corpus.config.autoComplete === false) {
      hideSuggestions();
    } else {
      const typed = getTypedText();
      if (typed.length < corpus.config.triggerAfterChars) {
        hideSuggestions();
      } else if (hasTextRemainingInSentence()) {
        hideSuggestions();
      } else {
        const suggestions = corpus.getCompletions(typed);
        if (suggestions.length > 0) {
          const rect = getCursorRect();
          showSuggestions(suggestions, rect);
        } else {
          hideSuggestions();
        }
      }
    }

    // Link-trigger pass — offer to link any saved trigger phrases
    // the user typed. Independent of the autocomplete pass so both
    // surfaces can be shown together when they don't overlap.
    if (corpus.config.autoLink === false) {
      hideLinkPrompt();
    } else {
      checkForLinkTriggers();
    }
  }, 150);
}

// ── Event listeners ────────────────────────────────────────

function attachListeners() {
  lillypadArea.addEventListener('input', handleLillypadInput);

  // Preview inserted-link URLs — on hover for mouse users and on
  // caret-position change for keyboard users.
  lillypadArea.addEventListener('mouseover', (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (a && lillypadArea.contains(a)) showLinkPreview(a);
  });
  lillypadArea.addEventListener('mouseout', (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (a && a === linkPreviewTarget) hideLinkPreview();
  });
  document.addEventListener('selectionchange', () => {
    if (!isLillypadActive()) return;
    updateLinkPreviewFromCaret();
  });

  document.addEventListener('keydown', (e) => {
    if (!isLillypadActive()) return;

    // Suggestion navigation
    if (currentSuggestions.length) {
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        acceptSuggestion();
        return;
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        updateSuggestionSelection((selectedIndex + 1) % currentSuggestions.length);
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        updateSuggestionSelection((selectedIndex - 1 + currentSuggestions.length) % currentSuggestions.length);
        return;
      } else if (e.key === 'Escape') {
        hideSuggestions();
        return;
      }
    }

    // Link search modal owns its own input's keys — only Esc from
    // the document-wide listener while it's up.
    if (linkSearchBox && linkSearchBox.style.display === 'block') {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideLinkSearch();
      }
      return;
    }

    // Save-phrase chip: Esc or any typing dismisses.
    if (pendingSavePhraseChip) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideSavePhraseChip();
        return;
      }
      const isCharish = e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter';
      if (isCharish) hideSavePhraseChip();
    }

    // Save-rule chip: Esc dismisses; typed chars decay it (mirrors
    // Gmail — 5-keystroke grace so the user can read the chip while
    // moving on).
    if (pendingSaveRuleChip) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideSaveRuleChip();
        return;
      }
      const isCharish = e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter';
      if (isCharish) {
        pendingSaveRuleChip.typedChars++;
        if (pendingSaveRuleChip.typedChars >= 5) hideSaveRuleChip();
      }
    }

    // Cmd+Shift+P → save selection as phrase
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim() &&
          isInLillypad(sel.getRangeAt(0).startContainer)) {
        e.preventDefault();
        e.stopPropagation();
        maybeShowSavePhraseChip();
        return;
      }
    }

    // Cmd+L → open link search over a selection, or accept a
    // pending on-type link prompt when there's no selection.
    if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim() &&
          isInLillypad(sel.getRangeAt(0).startContainer)) {
        e.preventDefault();
        e.stopPropagation();
        if (pendingLink) hideLinkPrompt();
        showLinkSearch();
        return;
      }
      if (pendingLink) {
        e.preventDefault();
        e.stopPropagation();
        acceptLinkPrompt();
        return;
      }
    }

    // Link-prompt: Esc or continued typing dismisses it. Typing is
    // handled by handleLillypadInput; only Esc needs coverage here.
    if (pendingLink && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideLinkPrompt();
      return;
    }
  }, true);

  document.addEventListener('click', (e) => {
    if (
      !suggestionBox?.contains(e.target) &&
      !linkSearchBox?.contains(e.target) &&
      !saveRuleChipBox?.contains(e.target) &&
      !savePhraseChipBox?.contains(e.target) &&
      !linkPromptBox?.contains(e.target)
    ) {
      hideSuggestions();
      hideLinkPrompt();
    }
  });
}

// ── Copy / Clear ───────────────────────────────────────────

// Scan every text node in LillyPad for link-rule triggers the
// user typed manually and wrap them, so paste into Gmail gets
// hyperlinks even for phrases the user didn't accept via Cmd+L.
function autoLinkifyAll() {
  const walker = document.createTreeWalker(lillypadArea, NodeFilter.SHOW_TEXT, null, false);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) applyLinksInTextNode(node);
}

async function copyLillypad() {
  const text = lillypadArea.innerText;
  if (!text.trim()) {
    showLillypadStatus('Nothing to copy', 'error');
    return;
  }

  autoLinkifyAll();
  const html = lillypadArea.innerHTML;
  const finalText = lillypadArea.innerText;

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([finalText], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
  } catch (e) {
    await navigator.clipboard.writeText(finalText);
  }

  const linkCount = lillypadArea.querySelectorAll('a').length;
  const suffix = linkCount ? ` with ${linkCount} link${linkCount === 1 ? '' : 's'}` : '';
  showLillypadStatus(`✓ Copied to clipboard${suffix}`, 'success');
}

function clearLillypad() {
  lillypadArea.innerHTML = '';
  lillypadArea.focus();
  hideSuggestions();
  hideLinkSearch();
  hideSaveRuleChip();
  hideSavePhraseChip();
  hideLinkPrompt();
  hideLinkPreview();
}

function showLillypadStatus(message, type) {
  const ms = type === 'error' ? 5000 : 2500;
  lillypadStatus.textContent = message;
  lillypadStatus.className = 'status ' + type;
  setTimeout(() => { lillypadStatus.className = 'status'; }, ms);
}

})();
