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

  // When a Bop suggestion box is showing, handleInput must not stomp
  // on it until the user does something deliberate. We track the
  // showing state explicitly so dismissal flows the same way as the
  // rest of the app: Esc, click outside, or typing.
  let bopBoxActive = false;

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

  // ── Save Rule Chip State ───────────────────────────────────
  let saveRuleChipBox = null;
  let saveRuleChipTimer = null;
  let pendingSaveRuleChip = null; // { trigger, url, existingRule } when shown

  // ── Save Phrase Chip State ─────────────────────────────────
  // Independent from the save-rule chip so bugs in one can't take out
  // the other; both share the .lingofrog-save-rule-chip CSS class for
  // a consistent visual language.
  let savePhraseChipBox = null;
  let pendingSavePhraseChip = null; // { text, alreadyExists } when shown

  // ── Success Toast State ────────────────────────────────────
  // Single shared toast element used to confirm "Saved" after the
  // save-rule chip and save-phrase chip accept actions (#81).
  let successToastBox = null;
  let successToastTimer = null;

  // ── Initialization ──────────────────────────────────────────

  async function init() {
    if (initialized) return;
    await corpus.load();
    createSuggestionUI();
    createLinkPromptUI();
    createLinkSearchUI();
    createSaveRuleChipUI();
    createSavePhraseChipUI();
    createSuccessToastUI();
    attachListeners();
    initialized = true;
    console.log(
      '[LingoFrog] Loaded —',
      corpus.phrases.size, 'phrases,',
      corpus.linkRules.rules.size, 'link rules'
    );
  }

  // Clamp a popup to stay within the viewport. Must be called after
  // the popup is visible so getBoundingClientRect reports the rendered
  // size. If the popup would overflow vertically, flip above the anchor.
  function clampToViewport(el, anchorRect) {
    const margin = 10;
    const rect = el.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;

    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - rect.width - margin;
    }
    if (left < margin) left = margin;

    if (top + rect.height > window.innerHeight - margin) {
      top = anchorRect
        ? anchorRect.top - rect.height - 4
        : window.innerHeight - rect.height - margin;
    }
    if (top < margin) top = margin;

    el.style.left = left + 'px';
    el.style.top = top + 'px';
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
    headerIcon.src = chrome.runtime.getURL('icons/icon48.png');
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
      suggestionBox.style.left = anchorRect.left + 'px';
      suggestionBox.style.top = (anchorRect.bottom + 4) + 'px';
    }

    suggestionBox.style.display = 'block';
    if (anchorRect) clampToViewport(suggestionBox, anchorRect);
    showGhostText(suggestions[0].completion);
  }

  function hideSuggestions() {
    bopBoxActive = false;
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
      a.href = corpus.utmRules.applyTo(url);
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
    linkSearchBox.style.left = rect.left + 'px';
    linkSearchBox.style.top = (rect.bottom + 6) + 'px';
    linkSearchBox.style.display = 'block';
    clampToViewport(linkSearchBox, rect);

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

  /**
   * Attempt to interpret a user-typed string as a URL for one-off
   * insertion. Returns the normalized URL (string) if it looks like a
   * URL, or null if it should be treated as a filter against registered
   * rules.
   *
   * Accepts:
   *   - explicit http(s):// URLs
   *   - host-only or host+path strings like `example.com/foo` (https:// added)
   *   - mailto: and tel: schemes (passed through, no UTM transform)
   *
   * Rejects javascript:, data:, vbscript:, file: and any other scheme
   * for safety.
   */
  function parseUrlInput(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;

    // Reject dangerous schemes explicitly.
    if (/^(javascript|data|vbscript|file):/i.test(trimmed)) return null;

    // mailto: and tel: pass through.
    if (/^(mailto|tel):/i.test(trimmed)) return trimmed;

    let candidate = trimmed;
    if (!/^https?:\/\//i.test(candidate)) {
      // Looks like a bare host? Require at least one dot in what could
      // be a hostname, and only sensible chars before the first slash.
      const slashIdx = candidate.indexOf('/');
      const host = slashIdx === -1 ? candidate : candidate.slice(0, slashIdx);
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return null;
      candidate = 'https://' + candidate;
    }

    try {
      const url = new URL(candidate);
      // Require a valid-looking host with at least one dot.
      if (!url.hostname.includes('.')) return null;
      return url.toString();
    } catch (e) {
      return null;
    }
  }

  function renderLinkSearchResults(filter) {
    const all = corpus.linkRules.getAll();
    const lower = filter.toLowerCase();
    const ruleMatches = lower
      ? all.filter((r) => r.trigger.includes(lower) || r.url.toLowerCase().includes(lower))
      : all;

    // Detect URL-shaped input and prepend a synthetic "Insert URL" row.
    const urlCandidate = parseUrlInput(filter);
    const results = [];
    if (urlCandidate) {
      results.push({ kind: 'url', url: urlCandidate });
    }
    for (const r of ruleMatches) {
      results.push({ kind: 'rule', trigger: r.trigger, url: r.url, label: r.label });
    }

    linkSearchResults = results;
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
      if (r.kind === 'url') item.classList.add('lingofrog-ls-url-insert');

      const trigger = document.createElement('span');
      trigger.className = 'lingofrog-ls-trigger';

      if (r.kind === 'url') {
        // Synthetic row: "🔗 Insert URL: <hostname/path>"
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
    const { range, text: highlightedText } = linkSearchSelection;
    let inserted = false;
    let insertedAnchor = null;

    try {
      const a = document.createElement('a');
      a.href = corpus.utmRules.applyTo(chosen.url);
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
      inserted = true;
      insertedAnchor = a;
    } catch (e) {
      // surroundContents fails if selection spans multiple elements;
      // fall back to replacing the range with a link containing the text
      try {
        const text = range.toString();
        range.deleteContents();
        const a = document.createElement('a');
        a.href = corpus.utmRules.applyTo(chosen.url);
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
        inserted = true;
        insertedAnchor = a;
      } catch (err) {
        console.error('[LingoFrog] Link search insert error:', err);
      }
    }

    hideLinkSearch();

    if (inserted) {
      // Restore the cursor to just-after the inserted <a> regardless
      // of whether the chip will show. Gmail's input handler runs on
      // the dispatched 'input' event above and can move the cursor to
      // the start of the inserted node via mutation observers. Deferred
      // one tick so it lands after any microtask-scheduled selection
      // moves. This applies even when the chip is disabled — bug
      // surfaced during PR #59 testing where toggling the chip off
      // left the cursor stranded at the start of the phrase.
      deferRestoreCursorAfter(insertedAnchor, activeElement);
      maybeShowSaveRuleChip(chosen, highlightedText, insertedAnchor);
    }
  }

  function deferRestoreCursorAfter(anchorEl, activeEl) {
    if (!anchorEl) return;
    setTimeout(() => {
      try {
        if (activeEl && typeof activeEl.focus === 'function') {
          activeEl.focus({ preventScroll: true });
        }
        if (anchorEl.parentNode) {
          const range = document.createRange();
          range.setStartAfter(anchorEl);
          range.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch (e) {
        // Range may have been invalidated by DOM mutation; ignore.
      }
    }, 0);
  }

  // ── Save Rule Chip ──────────────────────────────────────────
  //
  // After a one-off URL insertion via ⌘L, surface a small chip near
  // the inserted link asking if the user wants to save the highlighted
  // text → URL pair as a new link rule. Replaces the silent auto-save
  // behavior shipped in #51 (per the #56 design): default-off means
  // generic anchor text like "here" or "click" can never be saved by
  // accident.

  function createSaveRuleChipUI() {
    saveRuleChipBox = document.createElement('div');
    saveRuleChipBox.id = 'lingofrog-save-rule-chip';
    saveRuleChipBox.className = 'lingofrog-save-rule-chip';
    document.body.appendChild(saveRuleChipBox);
  }

  /**
   * Conditionally show the chip after a one-off URL insertion.
   * Guards:
   *   - Only fires for synthetic URL rows, not registered-rule picks.
   *   - Skips if the showSaveRuleChip setting is off.
   *   - Skips if highlighted text is empty or exceeds 80 chars
   *     (multi-paragraph highlights aren't useful triggers).
   *
   * The chip stores the RAW URL — not the UTM-applied href — so that
   * UTM rules are re-evaluated each time the rule is later used.
   */
  function maybeShowSaveRuleChip(chosen, highlightedText, anchorEl) {
    if (chosen.kind !== 'url') return;
    if (corpus.config.showSaveRuleChip === false) return;

    const trigger = (highlightedText || '').toLowerCase().trim();
    if (!trigger) return;

    const MAX_TRIGGER_LEN = 80;
    if (trigger.length > MAX_TRIGGER_LEN) return;

    const existing = corpus.linkRules.rules.get(trigger);

    // Build the cursor-restore range deterministically from the
    // inserted anchor element rather than reading window.getSelection
    // at this point. Between link insertion and chip-show, the
    // dispatched 'input' event runs the page's own handlers (Gmail
    // compose, etc.) which can normalize/move the selection — and on
    // the Replace flow specifically we saw cursor landing at the
    // start of the inserted phrase on dismissal. Anchoring to the <a>
    // means we always restore to "just after the inserted link"
    // regardless of what the page did to the live selection.
    let cursorRange = null;
    if (anchorEl && anchorEl.parentNode) {
      try {
        cursorRange = document.createRange();
        cursorRange.setStartAfter(anchorEl);
        cursorRange.collapse(true);
      } catch (e) {
        cursorRange = null;
      }
    }

    showSaveRuleChip({
      trigger,
      url: chosen.url,
      existingRule: existing || null,
      anchorEl,
      cursorRange,
      activeEl: activeElement,
    });
  }

  function showSaveRuleChip({ trigger, url, existingRule, anchorEl, cursorRange, activeEl }) {
    if (!saveRuleChipBox) return;

    pendingSaveRuleChip = {
      trigger,
      url,
      existingRule,
      cursorRange,
      activeEl,
      typedChars: 0,
    };
    saveRuleChipBox.innerHTML = '';

    const isReplace = !!existingRule;
    const displayHost = (() => {
      try { return new URL(url).hostname + new URL(url).pathname; }
      catch { return url; }
    })();
    const existingDisplayHost = isReplace ? (() => {
      try { return new URL(existingRule.url).hostname; }
      catch { return existingRule.url; }
    })() : null;

    const label = document.createElement('span');
    label.className = 'lingofrog-src-label';
    if (isReplace) {
      label.innerHTML = 'Replace <strong>' + escapeHtml(trigger) + '</strong> → '
        + '<span class="lingofrog-src-old">' + escapeHtml(existingDisplayHost) + '</span> with '
        + '<span class="lingofrog-src-new">' + escapeHtml(displayHost) + '</span>?';
    } else {
      label.innerHTML = 'Save <strong>' + escapeHtml(trigger) + '</strong> → '
        + '<span class="lingofrog-src-new">' + escapeHtml(displayHost) + '</span> as a link rule?';
    }

    const btn = document.createElement('button');
    btn.className = 'lingofrog-src-btn';
    btn.textContent = isReplace ? 'Replace' : 'Save';
    btn.tabIndex = -1;  // don't pull focus from the editable
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

    // Position below the inserted anchor (fallback: viewport-centered).
    const rect = anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect()
      : null;
    if (rect && rect.width) {
      saveRuleChipBox.style.left = rect.left + 'px';
      saveRuleChipBox.style.top = (rect.bottom + 6) + 'px';
    } else {
      saveRuleChipBox.style.left = '50%';
      saveRuleChipBox.style.top = '20px';
      saveRuleChipBox.style.transform = 'translateX(-50%)';
    }
    saveRuleChipBox.style.display = 'flex';
    clampToViewport(saveRuleChipBox, rect);

    // Reapply the cursor position after the current tick. The 'input'
    // event we dispatched after insertion runs the page's handlers
    // (Gmail compose hooks into MutationObservers / selection
    // tracking), and those can move the cursor to the start of the
    // newly-inserted node between insertion and now. Without this
    // reapply, the user sees the cursor visibly snap to the start of
    // the phrase the moment the chip appears, then jump back to the
    // end when they dismiss. setTimeout(0) places this after any
    // microtask-scheduled handlers.
    if (cursorRange && activeEl) {
      setTimeout(() => {
        if (!pendingSaveRuleChip) return; // chip already dismissed
        try {
          if (typeof activeEl.focus === 'function') {
            activeEl.focus({ preventScroll: true });
          }
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(cursorRange);
        } catch (e) {
          // Range may have been invalidated by DOM mutation; ignore.
        }
      }, 0);
    }
  }

  function hideSaveRuleChip({ restoreCursor = true } = {}) {
    // Restore editor focus + cursor position before tearing down state,
    // so the cursor lands at the end of the inserted link rather than
    // wherever the contenteditable defaults to on refocus.
    //
    // Skip restoration when the user dismissed by typing into the
    // editor — the saved range is stale (user has typed past it) and
    // restoring would jump them backward.
    if (pendingSaveRuleChip && restoreCursor) {
      const { activeEl, cursorRange } = pendingSaveRuleChip;
      if (activeEl && typeof activeEl.focus === 'function') {
        activeEl.focus({ preventScroll: true });
      }
      if (cursorRange) {
        try {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(cursorRange);
        } catch (e) {
          // Range may have been invalidated by DOM mutation; ignore.
        }
      }
    }

    if (saveRuleChipBox) {
      saveRuleChipBox.style.display = 'none';
      saveRuleChipBox.style.transform = '';
    }
    if (saveRuleChipTimer) {
      clearTimeout(saveRuleChipTimer);
      saveRuleChipTimer = null;
    }
    pendingSaveRuleChip = null;
  }

  async function acceptSaveRuleChip() {
    if (!pendingSaveRuleChip) return;
    const { trigger, url, existingRule } = pendingSaveRuleChip;
    const wasReplace = !!existingRule;

    corpus.linkRules.addRule(trigger, url);
    await corpus.linkRules.save();
    console.log('[LingoFrog] Saved link rule');

    // Capture the chip's position before hiding so the toast anchors
    // to where the user's eye already is.
    const chipRect = saveRuleChipBox && saveRuleChipBox.style.display !== 'none'
      ? saveRuleChipBox.getBoundingClientRect()
      : null;
    hideSaveRuleChip();
    showSuccessToast(wasReplace ? '✓ Link replaced' : '✓ Link saved', chipRect);
  }

  // ── Save Phrase Chip ────────────────────────────────────────
  //
  // Triggered by ⌘+Shift+P on a non-empty selection. Asks the user to
  // confirm saving the highlighted text to the phrase corpus. If the
  // phrase already exists, the chip switches to a Bump variant that
  // increments the existing entry's frequency (matching importBulk).

  function createSavePhraseChipUI() {
    savePhraseChipBox = document.createElement('div');
    savePhraseChipBox.id = 'lingofrog-save-phrase-chip';
    savePhraseChipBox.className = 'lingofrog-save-rule-chip';
    document.body.appendChild(savePhraseChipBox);
  }

  /**
   * Show the save-phrase chip near the selection. Caller supplies the
   * already-trimmed text and the selection's bounding rect (for
   * positioning).
   */
  function showSavePhraseChip(text, anchorRect) {
    if (!savePhraseChipBox) return;

    const alreadyExists = corpus.phrases.has(text);
    pendingSavePhraseChip = { text, alreadyExists };
    savePhraseChipBox.innerHTML = '';

    const truncated = text.length > 50 ? text.slice(0, 50) + '…' : text;

    const label = document.createElement('span');
    label.className = 'lingofrog-src-label';
    if (alreadyExists) {
      label.innerHTML = 'Already saved — bump <strong>'
        + escapeHtml(truncated) + '</strong>?';
    } else {
      label.innerHTML = 'Save <strong>'
        + escapeHtml(truncated) + '</strong> as a phrase?';
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

    // Position below the selection's bounding rect (fallback: top-
    // center of viewport for weird zero-rect cases).
    if (anchorRect && anchorRect.width) {
      savePhraseChipBox.style.left = anchorRect.left + 'px';
      savePhraseChipBox.style.top = (anchorRect.bottom + 6) + 'px';
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
    let toastMessage = null;
    if (result.added) {
      console.log('[LingoFrog] Saved new phrase');
      toastMessage = '✓ Phrase saved';
    } else if (result.bumped) {
      console.log('[LingoFrog] Bumped phrase');
      toastMessage = '✓ Phrase bumped';
    }
    const chipRect = savePhraseChipBox && savePhraseChipBox.style.display !== 'none'
      ? savePhraseChipBox.getBoundingClientRect()
      : null;
    hideSavePhraseChip();
    if (toastMessage) showSuccessToast(toastMessage, chipRect);
  }

  /**
   * Entry point for the ⌘+Shift+P shortcut. Reads the current
   * selection (allowed in editable OR non-editable contexts — per
   * issue #52 we want to support saving from received-email bodies
   * too) and shows the chip if the selection has non-whitespace
   * content.
   */
  function maybeShowSavePhraseChip() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

    const raw = sel.toString();
    const text = raw.trim().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    if (!text) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    showSavePhraseChip(text, rect);
  }

  // ── Success Toast ───────────────────────────────────────────
  //
  // Tiny non-interactive "Saved" confirmation that flashes briefly
  // after the save-rule or save-phrase chip accept actions, then
  // auto-fades. Anchors to wherever the chip was (the user's eye is
  // already there) — falls back to the cursor position otherwise.
  // Per #81.

  function createSuccessToastUI() {
    successToastBox = document.createElement('div');
    successToastBox.id = 'lingofrog-success-toast';
    successToastBox.className = 'lingofrog-success-toast';
    document.body.appendChild(successToastBox);
  }

  function showSuccessToast(message, anchorRect) {
    if (!successToastBox) return;
    successToastBox.textContent = message;

    const rect = anchorRect || getCursorRect();
    if (rect && rect.width !== undefined) {
      // Land in the chip's spot — anchorRect IS the chip's rect, so
      // matching its top puts the toast in the same vertical band
      // the user was just looking at.
      successToastBox.style.left = rect.left + 'px';
      successToastBox.style.top = rect.top + 'px';
      successToastBox.style.transform = '';
    } else {
      successToastBox.style.left = '50%';
      successToastBox.style.top = '20px';
      successToastBox.style.transform = 'translateX(-50%)';
    }
    successToastBox.classList.add('lingofrog-success-toast-visible');
    clampToViewport(successToastBox, rect);

    if (successToastTimer) clearTimeout(successToastTimer);
    successToastTimer = setTimeout(() => {
      successToastBox.classList.remove('lingofrog-success-toast-visible');
    }, 1500);
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

  /**
   * Returns true when there is word-character content remaining after
   * the cursor within the same sentence (i.e. before the next
   * `.!?\n` boundary).
   *
   * Used to suppress autocomplete when the user has clicked or
   * arrow-keyed into the middle of an existing sentence to edit it.
   * Inserting a completion at that point would shove unrelated text
   * into the middle of an in-progress phrase — the suggestion is
   * almost never actually what the user wants.
   *
   * Trailing whitespace, commas, and terminal punctuation don't
   * count as "remaining content" — those positions are reasonable
   * places to expand a phrase.
   */
  function hasTextRemainingInSentence(element) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false;

    // Scope to the closest block-level container so we don't peek
    // across paragraph boundaries — same logic as getTypedText.
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

    const treeWalker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null, false);
    let foundCursor = false;
    let rest = '';
    let currentNode;
    while ((currentNode = treeWalker.nextNode())) {
      // Skip ghost text nodes.
      if (currentNode.parentNode &&
          currentNode.parentNode.classList &&
          currentNode.parentNode.classList.contains('lingofrog-ghost')) {
        continue;
      }
      if (currentNode === range.startContainer) {
        rest += currentNode.textContent.substring(range.startOffset);
        foundCursor = true;
        continue;
      }
      if (foundCursor) {
        rest += currentNode.textContent;
      }
    }
    if (!foundCursor) return false;

    // Only consider text within the current sentence — what lives
    // after the next hard boundary is its own context.
    const currentSentenceTail = rest.split(/[.!?\n]/)[0];
    return /\w/.test(currentSentenceTail);
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
      // Bop-box protection: the input event we dispatched after
      // acceptSuggestion arrives here next tick and would otherwise
      // stomp on the Bop suggestion box. Skip exactly one
      // handleInput call after a Bop is shown; the *next* call
      // (a real user keystroke) resumes normal flow, which is what
      // dismisses the Bop box on typing — matches the rest of the
      // app's "click outside / Esc / keep typing" pattern.
      if (bopBoxActive) {
        bopBoxActive = false;
        removeGhostText();
        // Re-paint the ghost text since removeGhostText above wipes
        // it; the Bop suggestion box itself is still visible via
        // suggestionBox.style.display.
        if (currentSuggestions[0]) showGhostText(currentSuggestions[0].completion);
        return;
      }

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
      } else if (hasTextRemainingInSentence(el)) {
        // Cursor moved into the middle of an existing sentence —
        // the user is editing, not extending. Inserting a phrase
        // would shove unrelated text into the middle of what's
        // already there (#79).
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

    // ── Bop trigger ──
    // If the just-accepted phrase has a followedBy list, surface
    // those as suggestions immediately, bypassing the
    // triggerAfterChars threshold (the user has typed zero new
    // chars at this point). Each Bop completion gets a leading
    // space so the inserted text reads naturally after the
    // just-accepted phrase. Recursion is implicit — when the user
    // accepts the Bop suggestion, acceptSuggestion runs again and
    // checks the new phrase's followedBy, enabling A → B → C bops
    // without special handling.
    if (corpus.config.autoComplete !== false) {
      const followers = corpus.getFollowedBy(selected.full);
      if (followers.length) {
        const bopSuggestions = followers.map((follower, i) => ({
          completion: ' ' + follower,
          full: follower,
          score: 1e6 - i, // preserve declared order via pseudo-score
        }));
        // Defer one tick so the dispatched 'input' event above can
        // settle (Gmail compose runs its own handlers on input which
        // can move the cursor or selection).
        setTimeout(() => {
          const cursorRect = getCursorRect();
          if (cursorRect) {
            showSuggestions(bopSuggestions, cursorRect);
            bopBoxActive = true;
          }
        }, 0);
      }
    }
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

      // ── Save-rule chip: Esc dismisses; typed chars decay the chip ──
      // Mirrors the link-prompt's "typing dismisses" pattern, but with
      // a small grace period so the user can read the chip while
      // they're moving on. After 5 character-producing keypresses,
      // dismiss.
      if (pendingSaveRuleChip) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          hideSaveRuleChip();
          return;
        }
        const isCharish = e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter';
        if (isCharish) {
          pendingSaveRuleChip.typedChars = (pendingSaveRuleChip.typedChars || 0) + 1;
          if (pendingSaveRuleChip.typedChars >= 5) {
            // Don't preventDefault — the user's typing should still
            // land in the editor. Don't restore the cursor either —
            // the saved range is stale after they've typed past it.
            hideSaveRuleChip({ restoreCursor: false });
          }
        }
      }

      // ── Save-phrase chip: Esc or any typing dismisses ──
      // Unlike the save-rule chip (which has a 5-keystroke grace
      // because the user is mid-compose right after URL insertion),
      // the phrase chip appears as a response to a deliberate
      // ⌘+Shift+P pause. Any next keystroke means they've moved on.
      if (pendingSavePhraseChip) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          hideSavePhraseChip();
          return;
        }
        const isCharish = e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter';
        if (isCharish) {
          hideSavePhraseChip();
        }
      }

      // ── Cmd+Shift+P with selected text: save phrase to corpus ──
      // Allowed in editable AND non-editable contexts (per issue #52
      // — supports saving from received-email bodies, not just
      // composes).
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) {
          e.preventDefault();
          e.stopPropagation();
          maybeShowSavePhraseChip();
          return;
        }
      }

      // ── Cmd+L with selected text: open link search ──
      // Checked BEFORE the pendingLink-accept branch so that an
      // active selection always wins. Otherwise a user who typed a
      // trigger phrase (causing the floating prompt to appear) and
      // then highlighted text to insert a *different* link would
      // accidentally accept the prompt instead of opening the search.
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) {
          const el = document.activeElement;
          if (isEditableField(el)) {
            e.preventDefault();
            e.stopPropagation();
            activeElement = el;
            // Dismiss any floating link prompt so it doesn't overlap
            // the link-search popup.
            if (pendingLink) hideLinkPrompt();
            showLinkSearch();
            return;
          }
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
      if (
        !suggestionBox?.contains(e.target) &&
        !linkPromptBox?.contains(e.target) &&
        !linkSearchBox?.contains(e.target) &&
        !saveRuleChipBox?.contains(e.target) &&
        !savePhraseChipBox?.contains(e.target)
      ) {
        hideSuggestions();
        hideLinkPrompt();
        hideLinkSearch();
        hideSaveRuleChip();
        hideSavePhraseChip();
      }
    }, true);

    document.addEventListener('focusin', (e) => {
      if (!isEditableField(e.target)) {
        hideSuggestions();
        hideLinkPrompt();
      }
      // Save-phrase chip is short-lived and tied to the moment the
      // user pressed ⌘+Shift+P. Any focus change (Tab to another
      // field, click into a different element, etc.) means they've
      // moved on — dismiss immediately. Guard against the chip's
      // own buttons stealing focus by checking containment.
      if (savePhraseChipBox && !savePhraseChipBox.contains(e.target)) {
        hideSavePhraseChip();
      }
    }, true);

    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { childList: true, subtree: true });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (
      changes.lingofrog_phrases ||
      changes.lingofrog_link_rules ||
      changes.lingofrog_utm_rules ||
      changes.lingofrog_config
    ) {
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