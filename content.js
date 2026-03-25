/**
 * content.js — GhostType content script.
 *
 * Tab       → accept autocomplete suggestion
 * Cmd+L     → accept link prompt (linkify detected phrase)
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

  // ── Initialization ──────────────────────────────────────────

  async function init() {
    if (initialized) return;
    await corpus.load();
    createSuggestionUI();
    createLinkPromptUI();
    attachListeners();
    initialized = true;
    console.log(
      '[GhostType] Loaded —',
      corpus.phrases.size, 'phrases,',
      corpus.linkRules.rules.size, 'link rules'
    );
  }

  // ── Suggestion Box UI ───────────────────────────────────────

  function createSuggestionUI() {
    suggestionBox = document.createElement('div');
    suggestionBox.id = 'ghosttype-suggestions';
    suggestionBox.className = 'ghosttype-box';
    document.body.appendChild(suggestionBox);

    ghostSpan = document.createElement('span');
    ghostSpan.id = 'ghosttype-ghost';
    ghostSpan.className = 'ghosttype-ghost';
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
    header.className = 'ghosttype-header';
    header.textContent = '⌨ GhostType';
    suggestionBox.appendChild(header);

    suggestions.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'ghosttype-item' + (i === 0 ? ' ghosttype-selected' : '');
      item.dataset.index = i;

      const num = document.createElement('span');
      num.className = 'ghosttype-num';
      num.textContent = `${i + 1}`;

      const text = document.createElement('span');
      text.className = 'ghosttype-text';
      const display = s.completion.length > 60 ? s.completion.slice(0, 60) + '…' : s.completion;

      const links = corpus.linkRules.findLinks(s.completion);
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
    hint.className = 'ghosttype-hint';
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
    const items = suggestionBox.querySelectorAll('.ghosttype-item');
    items.forEach((item, i) => {
      item.classList.toggle('ghosttype-selected', i === selectedIndex);
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
    ghostSpan.className = 'ghosttype-ghost';
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
    const existing = document.querySelectorAll('.ghosttype-ghost');
    existing.forEach((el) => el.remove());
  }

  // ── Link Prompt UI ──────────────────────────────────────────

  function createLinkPromptUI() {
    linkPromptBox = document.createElement('div');
    linkPromptBox.id = 'ghosttype-link-prompt';
    linkPromptBox.className = 'ghosttype-link-prompt';
    document.body.appendChild(linkPromptBox);
  }

  function showLinkPrompt(trigger, url, anchorRect) {
    if (!linkPromptBox || !anchorRect) return;

    const domain = url.replace(/^https?:\/\//, '').split('/')[0];

    linkPromptBox.innerHTML = '';

    const icon = document.createElement('span');
    icon.className = 'ghosttype-lp-icon';
    icon.textContent = '🔗';

    const label = document.createElement('span');
    label.className = 'ghosttype-lp-label';
    label.innerHTML = 'Link <strong>' + escapeHtml(trigger) + '</strong>';

    const urlHint = document.createElement('span');
    urlHint.className = 'ghosttype-lp-url';
    urlHint.textContent = domain;

    const hint = document.createElement('span');
    hint.className = 'ghosttype-lp-hint';
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
      console.error('[GhostType] Link prompt apply error:', e);
    }

    hideLinkPrompt();
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
    const links = corpus.linkRules.findLinks(text);

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
          currentNode.parentNode.classList.contains('ghosttype-ghost')) {
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

      const el = document.activeElement;
      if (!isEditableField(el)) {
        hideSuggestions();
        hideLinkPrompt();
        return;
      }

      activeElement = el;
      const typed = getTypedText(el);

      // ── Autocomplete ──
      if (typed.length < corpus.config.triggerAfterChars) {
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
      checkForLinkTriggers();

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

    const fragment = buildCompletionFragment(completion);
    range.insertNode(fragment);

    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

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
    }, true);

    document.addEventListener('click', (e) => {
      if (!suggestionBox?.contains(e.target) && !linkPromptBox?.contains(e.target)) {
        hideSuggestions();
        hideLinkPrompt();
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
    if (changes.ghosttype_phrases || changes.ghosttype_link_rules) {
      corpus.load().then(() => {
        console.log(
          '[GhostType] Updated —',
          corpus.phrases.size, 'phrases,',
          corpus.linkRules.rules.size, 'link rules'
        );
      });
    }
  });

  init();
})();