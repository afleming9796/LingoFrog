/**
 * content.js — LingoFrog content script.
 *
 * Tab       → accept autocomplete suggestion
 * Cmd+L     → accept link prompt (linkify detected phrase)
 *              OR open link search when text is selected
 * Esc       → dismiss either
 * Keep typing → dismisses link prompt
 */

(function () {
  'use strict';

  const corpus = new Corpus();
  let initialized = false;
  let suggestionBox = null;
  let ghostSpan = null;
  let activeElement = null;
  let selectedIndex = 0;
  let currentSuggestions = [];
  let debounceTimer = null;

  // ── Link Prompt State ───────────────────────────────────────
  let linkPromptBox = null;
  let pendingLink = null;

  // ── Link Search Popup State ────────────────────────────────
  let linkSearchBox = null;
  let linkSearchInput = null;
  let linkSearchList = null;
  let linkSearchResults = [];
  let linkSearchIndex = 0;
  let linkSearchSelection = null; // { range, text } saved when popup opens

  // ── Initialization ──────────────────────────────────────────

  async function init() {
    if (initialized) return;
    await corpus.load();
    createSuggestionUI();
    createLinkPromptUI();
    createLinkSearchUI();
    attachListeners();
    initialized = true;
    console.log(
      '[LingoFrog] Loaded —',
      corpus.phrases.size, 'phrases,',
      corpus.linkRules.rules.size, 'link rules'
    );
  }

  // ── Suggestion Box UI ───────────────────────────────────────

  function createSuggestionUI() {
    suggestionBox = document.createElement('div');
    suggestionBox.id = 'lingofrog-suggestions';
    suggestionBox.className = 'lingofrog-box';
    document.body.appendChild(suggestionBox);

    ghostSpan = document.createElement('span');
    ghostSpan.id = 'lingofrog-ghost';
    ghostSpan.className = 'lingofrog-ghost';
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
    headerIcon.src = chrome.runtime.getURL('icon48.png');
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

      const links = corpus.linkRules.findLinks(s.full);
      if (links.length > 0) {
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
      const boxWidth = 380;
      let left = anchorRect.left;
      let top = anchorRect.bottom + 4;

      if (left + boxWidth > window.innerWidth) {
        left = window.innerWidth - boxWidth - 10;
      }
      if (top + 250 > window.innerHeight) {
        top = anchorRect.top - 250;
      }

      suggestionBox.style.left = left + 'px';
      suggestionBox.style.top = top + 'px';
    }

    suggestionBox.style.display = 'block';
    showGhostText(suggestions[0].completion);
  }

  function hideSuggestions() {
    if (suggestionBox) suggestionBox.style.display = 'none';
    currentSuggestions = [];
    selectedIndex = 0;
    removeGhostText();
  }

  function updateSelection(newIndex) {
    selectedIndex = newIndex;
    const items = suggestionBox.querySelectorAll('.lingofrog-item');
    items.forEach((item, i) => {
      item.classList.toggle('lingofrog-selected', i === selectedIndex);
    });
    if (currentSuggestions[selectedIndex]) {
      showGhostText(currentSuggestions[selectedIndex].completion);
    }
  }

  // ── Ghost Text ──────────────────────────────────────────────

  function showGhostText(text) {
    removeGhostText();

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;

    ghostSpan = document.createElement('span');
    ghostSpan.className = 'lingofrog-ghost';
    ghostSpan.textContent = text;
    ghostSpan.contentEditable = 'false';

    try {
      range.insertNode(ghostSpan);
      range.setStartBefore(ghostSpan);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  function removeGhostText() {
    const existing = document.querySelectorAll('.lingofrog-ghost');
    existing.forEach((el) => el.remove());
  }

  // ── Link Prompt UI ──────────────────────────────────────────

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

    let left = anchorRect.left;
    let top = anchorRect.top - 32;

    if (top < 10) {
      top = anchorRect.bottom + 4;
    }
    if (left + 300 > window.innerWidth) {
      left = window.innerWidth - 310;
    }

    linkPromptBox.style.left = left + 'px';
    linkPromptBox.style.top = top + 'px';
    linkPromptBox.style.display = 'flex';

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

      if (idx === -1) {
        hideLinkPrompt();
        return;
      }

      const actualStart = idx;
      const actualEnd = idx + trigger.length;
      const matchedText = currentText.slice(actualStart, actualEnd);

      const before = currentText.slice(0, actualStart);
      const after = currentText.slice(actualEnd);

      const a = document.createElement('a');
      a.href = url;
      a.textContent = matchedText;
      a.target = '_blank';
      a.rel = 'noopener';

      const parent = textNode.parentNode;
      if (!parent) {
        hideLinkPrompt();
        return;
      }

      if (after) {
        const afterNode = document.createTextNode(after);
        parent.insertBefore(afterNode, textNode.nextSibling);
      }

      parent.insertBefore(a, textNode.nextSibling);
      textNode.textContent = before;

      if (!before) {
        parent.removeChild(textNode);
      }

      const sel = window.getSelection();
      const range = document.createRange();
      if (a.nextSibling) {
        range.setStart(a.nextSibling, 0);
      } else {
        range.setStartAfter(a);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);

      if (activeElement) {
        activeElement.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) {
      console.error('[LingoFrog] Link prompt apply error:', e);
    }

    hideLinkPrompt();
  }

  // ── Link Search Popup ────────────────────────────────────────

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
    linkSearchInput.placeholder = 'Search links…';
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

  function showLinkSearch() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (!text) return;

    linkSearchSelection = { range: range.cloneRange(), text };

    const rect = range.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 6;

    const boxWidth = 320;
    if (left + boxWidth > window.innerWidth) {
      left = window.innerWidth - boxWidth - 10;
    }
    if (top + 260 > window.innerHeight) {
      top = rect.top - 260;
    }

    linkSearchBox.style.left = left + 'px';
    linkSearchBox.style.top = top + 'px';
    linkSearchBox.style.display = 'block';

    linkSearchInput.value = '';
    renderLinkSearchResults('');

    // Focus the input after a tick so the selection isn't clobbered
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
    linkSearchResults = lower
      ? all.filter((r) => r.trigger.includes(lower) || r.url.toLowerCase().includes(lower))
      : all;

    linkSearchIndex = 0;
    linkSearchList.innerHTML = '';

    if (linkSearchResults.length === 0) {
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

      const trigger = document.createElement('span');
      trigger.className = 'lingofrog-ls-trigger';
      trigger.textContent = r.trigger;

      const url = document.createElement('span');
      url.className = 'lingofrog-ls-url';
      url.textContent = r.url.replace(/^https?:\/\//, '').split('/')[0];

      item.appendChild(trigger);
      item.appendChild(url);

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
    // Scroll selected item into view
    const selected = items[linkSearchIndex];
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  function acceptLinkSearch() {
    if (!linkSearchSelection || linkSearchResults.length === 0) {
      hideLinkSearch();
      return;
    }

    const chosen = linkSearchResults[linkSearchIndex];
    const { range } = linkSearchSelection;

    try {
      const a = document.createElement('a');
      a.href = chosen.url;
      a.target = '_blank';
      a.rel = 'noopener';

      // Extract the selected content as the link text
      range.surroundContents(a);

      // Place cursor after the link
      const sel = window.getSelection();
      const newRange = document.createRange();
      newRange.setStartAfter(a);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);

      if (activeElement) {
        activeElement.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) {
      // surroundContents fails if selection spans multiple elements;
      // fall back to replacing the range with a link containing the text
      try {
        const text = range.toString();
        range.deleteContents();
        const a = document.createElement('a');
        a.href = chosen.url;
        a.textContent = text;
        a.target = '_blank';
        a.rel = 'noopener';
        range.insertNode(a);

        const sel = window.getSelection();
        const newRange = document.createRange();
        newRange.setStartAfter(a);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);

        if (activeElement) {
          activeElement.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch (err) {
        console.error('[LingoFrog] Link search insert error:', err);
      }
    }

    hideLinkSearch();
  }

  function checkForLinkTriggers() {
    if (corpus.linkRules.rules.size === 0) return;

    const el = document.activeElement;
    if (!isEditableField(el)) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;

    let textNode = range.startContainer;
    if (textNode.nodeType !== Node.TEXT_NODE) {
      if (textNode.childNodes.length > 0 && range.startOffset > 0) {
        const candidate = textNode.childNodes[range.startOffset - 1];
        if (candidate && candidate.nodeType === Node.TEXT_NODE) {
          textNode = candidate;
        } else {
          return;
        }
      } else {
        return;
      }
    }

    const text = textNode.textContent;
    if (!text || text.length < 2) return;

    if (textNode.parentNode && textNode.parentNode.tagName === 'A') return;

    const offset = (textNode === range.startContainer) ? range.startOffset : text.length;
    const textUpToCursor = text.substring(0, offset);

    const matches = corpus.linkRules.findLinks(textUpToCursor);
    if (matches.length === 0) {
      if (pendingLink && pendingLink.textNode !== textNode) {
        hideLinkPrompt();
      }
      return;
    }

    const match = matches[matches.length - 1];

    // Auto-dismiss: if the user keeps typing more than 5 chars past the
    // matched phrase, hide the prompt (fixes #18).
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

  // ── HTML Helpers ────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function buildCompletionFragment(text) {
    const fragment = document.createDocumentFragment();
    const links = corpus.config.autoLink === false ? [] : corpus.linkRules.findLinks(text);

    if (links.length === 0) {
      fragment.appendChild(document.createTextNode(text));
      return fragment;
    }

    let cursor = 0;
    for (const link of links) {
      if (link.start > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, link.start)));
      }

      const a = document.createElement('a');
      a.href = link.url;
      a.textContent = text.slice(link.start, link.end);
      a.target = '_blank';
      a.rel = 'noopener';
      fragment.appendChild(a);

      cursor = link.end;
    }

    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    return fragment;
  }

  /**
   * Scan a text node for link-rule matches and wrap them in <a> tags.
   * Called after tab-completion inserts plain text and normalize() merges
   * adjacent text nodes, so the full phrase lives in one node and
   * boundary issues between typed/completed text don't arise.
   * Returns the last DOM node produced (text or <a>), so the caller
   * can position the cursor after it.  Returns null if nothing changed.
   */
  function applyLinksInTextNode(textNode) {
    if (corpus.config.autoLink === false) return null;
    if (corpus.linkRules.rules.size === 0) return null;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return null;
    if (textNode.parentNode && textNode.parentNode.tagName === 'A') return null;

    const text = textNode.textContent;
    const matches = corpus.linkRules.findLinks(text);
    if (matches.length === 0) return null;

    const parent = textNode.parentNode;
    if (!parent) return null;

    // We process left-to-right by building the replacement nodes,
    // then swap out the original text node.
    const frag = document.createDocumentFragment();
    let cursor = 0;
    let lastNode = null;

    for (const m of matches) {
      if (m.start > cursor) {
        lastNode = document.createTextNode(text.slice(cursor, m.start));
        frag.appendChild(lastNode);
      }

      const a = document.createElement('a');
      a.href = m.url;
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

  // ── Completion Logic ────────────────────────────────────────

  function getTypedText(element) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return '';

    const range = sel.getRangeAt(0);
    if (!range.collapsed) return '';

    // Find the closest block-level container to scope the text walk
    // This avoids crossing paragraph/div boundaries in Gmail compose
    let scope = range.startContainer;
    while (scope && scope !== element) {
      if (scope.nodeType === Node.ELEMENT_NODE) {
        const display = window.getComputedStyle(scope).display;
        if (display === 'block' || display === 'list-item' || scope.tagName === 'DIV' || scope.tagName === 'P' || scope.tagName === 'LI') {
          break;
        }
      }
      scope = scope.parentNode;
    }
    if (!scope) scope = element;

    // Walk all text nodes within the scoped block up to cursor
    const treeWalker = document.createTreeWalker(
      scope, NodeFilter.SHOW_TEXT, null, false
    );

    let accumulated = '';
    let currentNode;

    while ((currentNode = treeWalker.nextNode())) {
      // Skip ghost text nodes
      if (currentNode.parentNode &&
          currentNode.parentNode.classList &&
          currentNode.parentNode.classList.contains('lingofrog-ghost')) {
        continue;
      }

      if (currentNode === range.startContainer) {
        accumulated += currentNode.textContent.substring(0, range.startOffset);
        break;
      }
      accumulated += currentNode.textContent;
    }

    // Normalize smart quotes to straight quotes so apostrophes match
    accumulated = accumulated.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

    // Split only on hard sentence boundaries and newlines (not colons or commas)
    const parts = accumulated.split(/[.!?\n]+/);
    return (parts[parts.length - 1] || '').trim();
  }

  function getCursorRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);

    let rect = range.getBoundingClientRect();

    if (rect.width === 0 && rect.height === 0) {
      const temp = document.createElement('span');
      temp.textContent = '\u200b';
      range.insertNode(temp);
      rect = temp.getBoundingClientRect();
      temp.remove();
    }

    return rect;
  }

  function handleInput() {
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
      removeGhostText();

      // Master kill switch
      if (corpus.config.enabled === false) {
        hideSuggestions();
        hideLinkPrompt();
        return;
      }

      const el = document.activeElement;
      if (!isEditableField(el)) {
        hideSuggestions();
        hideLinkPrompt();
        return;
      }

      activeElement = el;
      const typed = getTypedText(el);

      // ── Autocomplete ──
      if (corpus.config.autoComplete === false) {
        hideSuggestions();
      } else if (typed.length < corpus.config.triggerAfterChars) {
        hideSuggestions();
      } else {
        const suggestions = corpus.getCompletions(typed);
        if (suggestions.length > 0) {
          const cursorRect = getCursorRect();
          showSuggestions(suggestions, cursorRect);
        } else {
          hideSuggestions();
        }
      }

      // ── Link trigger detection ──
      if (corpus.config.autoLink === false) {
        hideLinkPrompt();
      } else {
        checkForLinkTriggers();
      }

    }, 150);
  }

  function acceptSuggestion() {
    if (!currentSuggestions.length || selectedIndex >= currentSuggestions.length) return;

    const selected = currentSuggestions[selectedIndex];
    const completion = selected.completion;
    removeGhostText();
    hideSuggestions();

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    range.collapse(false);

    // Step 1: insert the completion as plain text
    const textNode = document.createTextNode(completion);
    range.insertNode(textNode);

    // Step 2: merge adjacent text nodes so the typed prefix and the
    // completion become one node (e.g. "How to ac" + "tivate your
    // license" → "How to activate your license"), then scan for
    // link-rule matches and auto-wrap them (fixes #12).
    const parent = textNode.parentNode;
    if (parent) {
      // normalize() merges adjacent text nodes.  The inserted textNode
      // may be absorbed into its previous sibling, so grab a reference
      // to whichever node survives that contains our text.
      const prevSibling = textNode.previousSibling;
      parent.normalize();
      const mergedNode = (prevSibling && prevSibling.nodeType === Node.TEXT_NODE)
        ? prevSibling   // textNode was merged into its predecessor
        : textNode;     // textNode is still the live node

      const lastNode = applyLinksInTextNode(mergedNode);

      // Place cursor at the end of the last node produced by link wrapping
      // (or the merged text node itself if no links were applied).
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
    } else {
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    if (activeElement) {
      activeElement.dispatchEvent(new Event('input', { bubbles: true }));
    }

    corpus.recordUsage(selected.full);
  }

  // ── Event Listeners ─────────────────────────────────────────

  function isEditableField(el) {
    if (!el) return false;
    return (
      el.isContentEditable ||
      el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && el.type === 'text')
    );
  }

  function attachListeners() {
    document.addEventListener('input', (e) => {
      if (isEditableField(e.target)) {
        handleInput();
      }
    }, true);

    document.addEventListener('keydown', (e) => {
      // ── Autocomplete: Tab, arrows, Esc ──
      if (currentSuggestions.length) {
        if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          acceptSuggestion();
          return;
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          updateSelection((selectedIndex + 1) % currentSuggestions.length);
          return;
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          updateSelection((selectedIndex - 1 + currentSuggestions.length) % currentSuggestions.length);
          return;
        } else if (e.key === 'Escape') {
          hideSuggestions();
          return;
        }
      }

      // ── Link search popup: Esc dismisses (keyboard handled by its own input) ──
      if (linkSearchBox && linkSearchBox.style.display === 'block') {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          hideLinkSearch();
          return;
        }
        // Let the search input handle everything else
        return;
      }

      // ── Link prompt: Cmd+L, Esc, or typing dismisses ──
      if (pendingLink) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
          e.preventDefault();
          e.stopPropagation();
          acceptLinkPrompt();
          return;
        } else if (e.key === 'Escape') {
          hideLinkPrompt();
          return;
        }
        // Typing dismisses the link prompt
        if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
          setTimeout(() => hideLinkPrompt(), 0);
        }
      }

      // ── Cmd+L with selected text: open link search ──
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) {
          const el = document.activeElement;
          if (isEditableField(el)) {
            e.preventDefault();
            e.stopPropagation();
            activeElement = el;
            showLinkSearch();
            return;
          }
        }
      }
    }, true);

    document.addEventListener('click', (e) => {
      if (!suggestionBox?.contains(e.target) && !linkPromptBox?.contains(e.target) && !linkSearchBox?.contains(e.target)) {
        hideSuggestions();
        hideLinkPrompt();
        hideLinkSearch();
      }
    }, true);

    document.addEventListener('focusin', (e) => {
      if (!isEditableField(e.target)) {
        hideSuggestions();
        hideLinkPrompt();
      }
    }, true);

    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { childList: true, subtree: true });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.typeless_phrases || changes.typeless_link_rules || changes.typeless_config) {
      corpus.load().then(() => {
        console.log(
          '[LingoFrog] Updated —',
          corpus.phrases.size, 'phrases,',
          corpus.linkRules.rules.size, 'link rules,',
          'enabled:', corpus.config.enabled !== false
        );

        // If extension was just disabled, clean up any visible UI
        if (corpus.config.enabled === false) {
          hideSuggestions();
          hideLinkPrompt();
        }
      });
    }
  });

  init();
})();