/**
 * scribe.js — the Scribe side panel.
 *
 * Context + style → Claude → a formatted draft the user copies into
 * Gmail. Lives in Chrome's side panel rather than the popup because
 * the popup closes the moment you click back into the page, which
 * would throw away the context mid-edit.
 *
 * Storage:
 *   local   lingofrog_anthropic_api_key   the user's own key (never synced)
 *   local   lingofrog_scribe_styles       [{ id, name, instructions }]
 *   local   lingofrog_scribe_style_id     selected style id
 *   local   lingofrog_scribe_guide        general style (string)
 *   session lingofrog_scribe_draft        { context, output, generated,
 *                                           styleId, userLinks } — survives
 *                                           closing the panel, not a restart
 *
 * Corpus (saved links, phrases, UTM rules, config) comes from trie.js,
 * loaded as a classic script ahead of this module.
 */

import Anthropic from './vendor/anthropic-sdk.js';
import { buildRequest, buildSuggestionRequest } from './scribe-prompt.js';
import {
  parseDraft, renderDraft, collectLinks, safeHref, toClipboardHtml, toPlainText,
  canonicalDraft, domToMarkdown, linkElement,
} from './scribe-format.js';

const KEY_STORAGE = 'lingofrog_anthropic_api_key';
const STYLES_STORAGE = 'lingofrog_scribe_styles';
const STYLE_ID_STORAGE = 'lingofrog_scribe_style_id';
const DRAFT_STORAGE = 'lingofrog_scribe_draft';
const GUIDE_STORAGE = 'lingofrog_scribe_guide';

// Phrases ride along in every request, so cap them: the highest-scoring
// ones (same frequency × recency score autocomplete uses) until either
// limit is hit. ~12k characters is roughly 3k tokens.
const MAX_PHRASES = 200;
const MAX_PHRASE_CHARS = 12000;

const DEFAULT_STYLES = [
  {
    id: 'post-call-follow-up',
    name: 'Post-call follow-up',
    instructions: 'Thank them for their time. Recap the key points we discussed and the agreed next steps (with owners and dates where known) as a short bulleted list. Close with the single most important next action. Warm and concise, under 150 words.',
  },
  {
    id: 'intro-email',
    name: 'Intro email',
    instructions: 'Introduce two people who should talk, or introduce myself. Say who each person is and why connecting is worthwhile in 3–5 sentences. Friendly and specific, no filler.',
  },
  {
    id: 'quick-reply',
    name: 'Quick reply',
    instructions: 'Reply to the email in the context. Answer each question it asks and respond to each request, in as few words as clarity allows.',
  },
];

const $ = (sel) => document.querySelector(sel);

const keyCard = $('#key-card');
const keyCurrent = $('#key-current');
const keyInput = $('#api-key-input');
const keyStatus = $('#key-status');
const btnKey = $('#btn-key');
const btnKeySave = $('#btn-key-save');
const btnKeyCancel = $('#btn-key-cancel');
const btnKeyRemove = $('#btn-key-remove');

const contextEl = $('#context');
const contextStatus = $('#context-status');
const btnUseSelection = $('#btn-use-selection');

const guideRow = $('#guide-row');
const guidePreview = $('#guide-preview');
const guideForm = $('#guide-form');
const guideInput = $('#guide-input');

const styleList = $('#style-list');
const styleForm = $('#style-form');
const styleNameInput = $('#style-name');
const styleInstructionsInput = $('#style-instructions');
const btnAddStyle = $('#btn-add-style');

const btnWrite = $('#btn-write');
const btnCopy = $('#btn-copy');
const outputEl = $('#output');
const linkWarning = $('#link-warning');
const writeStatus = $('#write-status');
const btnClear = $('#btn-clear');
const draftHint = $('#draft-hint');
const draftActions = $('#draft-actions');
const btnSuggest = $('#btn-suggest');
const suggestCard = $('#suggest-card');
const suggestTitle = $('#suggest-title');
const suggestWhy = $('#suggest-why');
const suggestText = $('#suggest-text');
const btnSuggestStyle = $('#btn-suggest-style');
const btnSuggestGuide = $('#btn-suggest-guide');
const draftSection = $('.draft-section');
const btnLink = $('#btn-link');
const linkBubble = $('#link-bubble');
const bubbleUrl = $('#bubble-url');
const linkDialog = $('#link-dialog');
const linkTextInput = $('#link-text');
const linkUrlInput = $('#link-url');
const linkUrlLabel = $('#link-url-label');
const linkStatus = $('#link-status');
const btnLinkTest = $('#btn-link-test');
const linkSearch = $('#link-search');
const linkSearchInput = $('#link-search-input');
const linkSearchList = $('#link-search-list');
const saveChip = $('#save-chip');
const saveChipLabel = $('#save-chip-label');

const state = {
  apiKey: '',
  styles: [],
  styleId: null,
  guide: '',
  editingStyleId: null, // null = form closed, '' = adding, id = editing
  // The draft as it stands (user edits included) and as Claude wrote
  // it, both in canonical Markdown so "edited?" is a string compare.
  draft: '',
  generated: '',
  // Style that wrote the current draft (null = none), for suggestions.
  draftStyleId: null,
  // What the current draft was written from, for the link check:
  // { context, savedUrls, userUrls } (userUrls: links the user added).
  draftSources: null,
  stream: null,
  suggesting: false,
  // Style id a pending suggestion is for (null = the general style).
  suggestionStyleId: null,
};

const isEdited = () => !!state.generated && state.draft !== state.generated;

// ── Helpers ─────────────────────────────────────────────────

function showStatus(el, text, type = 'success', ms) {
  el.textContent = text;
  el.className = `status ${type}`;
  clearTimeout(el._timer);
  const duration = ms ?? (type === 'error' ? 8000 : 3000);
  if (duration > 0) el._timer = setTimeout(() => { el.className = 'status'; }, duration);
}

function clearStatus(el) {
  clearTimeout(el._timer);
  el.className = 'status';
}

function maskKey(key) {
  return key.length > 14 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '••••';
}

// ── API key ─────────────────────────────────────────────────

function openKeyCard() {
  keyCard.hidden = false;
  btnKey.classList.add('active');
  keyInput.value = '';
  keyCurrent.hidden = !state.apiKey;
  keyCurrent.textContent = state.apiKey ? `Saved key: ${maskKey(state.apiKey)}` : '';
  btnKeyCancel.hidden = !state.apiKey;
  btnKeyRemove.hidden = !state.apiKey;
  keyInput.focus();
}

function closeKeyCard() {
  keyCard.hidden = true;
  btnKey.classList.remove('active');
  clearStatus(keyStatus);
}

btnKey.addEventListener('click', () => (keyCard.hidden ? openKeyCard() : state.apiKey && closeKeyCard()));
btnKeyCancel.addEventListener('click', closeKeyCard);

btnKeySave.addEventListener('click', async () => {
  const key = keyInput.value.trim();
  if (!key) {
    showStatus(keyStatus, 'Paste your API key first.', 'error');
    return;
  }
  state.apiKey = key;
  await chrome.storage.local.set({ [KEY_STORAGE]: key });
  closeKeyCard();
  updateWriteButton();
  showStatus(writeStatus, '✓ API key saved', 'success');
});
keyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnKeySave.click();
});

btnKeyRemove.addEventListener('click', async () => {
  if (!confirm('Remove your Anthropic API key from this device?')) return;
  state.apiKey = '';
  await chrome.storage.local.remove(KEY_STORAGE);
  openKeyCard();
  updateWriteButton();
});

// ── Context ─────────────────────────────────────────────────

let persistTimer = null;
function persistDraftSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistDraft, 300);
}
function persistDraft() {
  chrome.storage.session.set({
    [DRAFT_STORAGE]: {
      context: contextEl.value,
      output: state.draft,
      generated: state.generated,
      styleId: state.draftStyleId,
      userLinks: state.draftSources ? [...state.draftSources.userUrls] : [],
    },
  }).catch(() => {});
}

contextEl.addEventListener('input', () => {
  updateWriteButton();
  updateClearButton();
  persistDraftSoon();
});

// Asks the active tab's content script for its highlighted text. Only
// Gmail tabs have a content script; anywhere else sendMessage rejects
// ("Receiving end does not exist"), as it does when no frame has a
// selection and so nobody answers.
btnUseSelection.addEventListener('click', async () => {
  let text = '';
  let reachedGmail = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'lingofrog_get_selection' });
    text = (res && res.text) || '';
  } catch (e) {
    reachedGmail = !/Receiving end does not exist|No active tab/i.test(String(e && e.message));
  }
  if (!text) {
    showStatus(
      contextStatus,
      reachedGmail
        ? 'Nothing is highlighted in this Gmail tab. Select some text first.'
        : 'Open Gmail in this tab and highlight some text first. (If LingoFrog was just updated, reload Gmail.)',
      'error'
    );
    return;
  }
  const existing = contextEl.value.trimEnd();
  contextEl.value = existing ? `${existing}\n\n${text}` : text;
  contextEl.scrollTop = contextEl.scrollHeight;
  updateWriteButton();
  updateClearButton();
  persistDraft();
  showStatus(contextStatus, '✓ Added your selection', 'success');
});

// ── General style ───────────────────────────────────────────

function renderGuide() {
  const guide = state.guide.trim();
  guideRow.classList.toggle('empty', !guide);
  // Collapse to one line (minus list markers) for the preview; the
  // editor shows it in full.
  guidePreview.textContent = guide
    ? guide.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean).join(' · ')
    : 'Add rules every draft should follow: tone, length, sign-off, spelling…';
}

function openGuideForm() {
  guideInput.value = state.guide;
  guideRow.hidden = true;
  guideForm.hidden = false;
  guideInput.focus();
}

function closeGuideForm() {
  guideForm.hidden = true;
  guideRow.hidden = false;
}

guideRow.addEventListener('click', openGuideForm);
$('#btn-guide-cancel').addEventListener('click', closeGuideForm);
$('#btn-guide-save').addEventListener('click', () => {
  state.guide = guideInput.value.trim();
  chrome.storage.local.set({ [GUIDE_STORAGE]: state.guide });
  closeGuideForm();
  renderGuide();
});

// ── Styles ──────────────────────────────────────────────────

function saveStyles() {
  return chrome.storage.local.set({ [STYLES_STORAGE]: state.styles, [STYLE_ID_STORAGE]: state.styleId });
}

function selectStyle(id) {
  state.styleId = id;
  saveStyles();
  renderStyles();
}

function renderStyles() {
  styleList.textContent = '';
  if (!state.styles.length) {
    const empty = document.createElement('li');
    empty.className = 'style-empty';
    empty.textContent = 'No styles yet. Scribe will write a general-purpose email.';
    styleList.appendChild(empty);
    return;
  }
  for (const style of state.styles) {
    const selected = style.id === state.styleId;
    const li = document.createElement('li');
    li.className = 'style-row' + (selected ? ' selected' : '');

    const pick = document.createElement('button');
    pick.className = 'style-pick';
    pick.setAttribute('role', 'radio');
    pick.setAttribute('aria-checked', String(selected));
    pick.title = style.instructions;
    const radio = document.createElement('span');
    radio.className = 'style-radio';
    const text = document.createElement('span');
    text.className = 'style-text';
    const name = document.createElement('span');
    name.className = 'style-name';
    name.textContent = style.name;
    const desc = document.createElement('span');
    desc.className = 'style-desc';
    desc.textContent = style.instructions;
    text.append(name, desc);
    pick.append(radio, text);
    pick.addEventListener('click', () => selectStyle(style.id));

    const edit = document.createElement('button');
    edit.className = 'icon-btn style-edit';
    edit.title = 'Edit style';
    edit.setAttribute('aria-label', `Edit ${style.name}`);
    edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    edit.addEventListener('click', () => openStyleForm(style.id));

    const del = document.createElement('button');
    del.className = 'icon-btn style-delete';
    del.title = 'Delete style';
    del.setAttribute('aria-label', `Delete ${style.name}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    del.addEventListener('click', () => deleteStyle(style.id));

    li.append(pick, edit, del);
    styleList.appendChild(li);
  }
}

function openStyleForm(id) {
  const style = id ? state.styles.find((s) => s.id === id) : null;
  state.editingStyleId = style ? style.id : '';
  styleNameInput.value = style ? style.name : '';
  styleInstructionsInput.value = style ? style.instructions : '';
  styleForm.hidden = false;
  btnAddStyle.hidden = true;
  styleNameInput.focus();
}

function closeStyleForm() {
  state.editingStyleId = null;
  styleForm.hidden = true;
  btnAddStyle.hidden = false;
}

function deleteStyle(id) {
  const style = state.styles.find((s) => s.id === id);
  if (!style || !confirm(`Delete the "${style.name}" style?`)) return;
  state.styles = state.styles.filter((s) => s.id !== id);
  if (state.styleId === id) state.styleId = state.styles.length ? state.styles[0].id : null;
  if (state.editingStyleId === id) closeStyleForm();
  saveStyles();
  renderStyles();
}

btnAddStyle.addEventListener('click', () => openStyleForm(null));
$('#btn-style-cancel').addEventListener('click', closeStyleForm);
$('#btn-style-save').addEventListener('click', () => {
  const name = styleNameInput.value.trim();
  const instructions = styleInstructionsInput.value.trim();
  if (!name || !instructions) {
    (name ? styleInstructionsInput : styleNameInput).focus();
    return;
  }
  if (state.editingStyleId) {
    const style = state.styles.find((s) => s.id === state.editingStyleId);
    if (style) Object.assign(style, { name, instructions });
  } else {
    const id = 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.styles.push({ id, name, instructions });
    state.styleId = id;
  }
  closeStyleForm();
  saveStyles();
  renderStyles();
});

// ── Draft rendering ─────────────────────────────────────────

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    // Once the stream ends, write() has already rendered the final
    // draft; a late frame would reset the caret of someone editing it.
    if (state.stream) renderOutput();
  });
}

// Rebuilds the draft from state.draft. Not called on the user's own
// keystrokes (that would reset the caret); see the input handler below.
function renderOutput() {
  const blocks = parseDraft(state.draft);
  outputEl.textContent = '';
  outputEl.classList.toggle('streaming', !!state.stream);
  outputEl.contentEditable = String(!state.stream && blocks.length > 0);
  if (blocks.length) {
    outputEl.appendChild(renderDraft(blocks, document, tagUrl));
  } else if (!state.stream) {
    const placeholder = document.createElement('p');
    placeholder.className = 'placeholder';
    placeholder.textContent = 'Your draft will appear here.';
    outputEl.appendChild(placeholder);
  }
  btnCopy.disabled = !!state.stream || !blocks.length;
  btnLink.disabled = outputEl.contentEditable !== 'true';
  linkBubble.hidden = true;
  closeLinkSearch(false);
  hideSaveChip();
  renderLinkWarning(state.stream ? [] : blocks);
  updateDraftHint();
  updateSuggestButton();
  updateClearButton();
}

function updateDraftHint() {
  const edited = isEdited();
  draftHint.classList.toggle('edited', edited);
  draftHint.textContent = state.stream ? '' : edited ? 'Edited' : state.draft ? 'Click to edit' : '';
}

// ── Editing ─────────────────────────────────────────────────
//
// The draft is contenteditable once written. Each edit is read back to
// Markdown and canonicalized, and copy/link-check work from that, so
// the editor's DOM never reaches the clipboard directly. Paste and drop
// are forced to plain text so nothing (images included) can be pasted
// in with markup.

outputEl.addEventListener('input', () => {
  if (state.stream || outputEl.contentEditable !== 'true') return;
  state.draft = canonicalDraft(domToMarkdown(outputEl));
  btnCopy.disabled = !state.draft;
  renderLinkWarning(parseDraft(state.draft));
  updateDraftHint();
  updateSuggestButton();
  updateClearButton();
  updateWriteButton();
  persistDraftSoon();
});

outputEl.addEventListener('paste', (e) => {
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});
outputEl.addEventListener('drop', (e) => e.preventDefault());

// The current selection, if it's inside the draft.
function draftRange() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  return outputEl.contains(range.commonAncestorContainer) ? range : null;
}

function closestInDraft(node, selector) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const match = el && el.closest(selector);
  return match && outputEl.contains(match) ? match : null;
}

// The list item whose very start the caret is at, if any.
function listItemAtCaretStart() {
  const range = draftRange();
  if (!range || !range.collapsed) return null;
  const li = closestInDraft(range.startContainer, 'li');
  if (!li) return null;
  const before = document.createRange();
  before.setStart(li, 0);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString() ? null : li;
}

outputEl.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (!saveChip.hidden && trackSaveChipKey(e)) return;
  const shortcut = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey ? e.key.toLowerCase() : '';
  if (shortcut === 'k' || shortcut === 'l') {
    e.preventDefault();
    if (shortcut === 'k') openLinkDialog();
    else openLinkSearch();
    return;
  }
  // Like Gmail: Backspace at the start of a bullet turns it back into a
  // plain line, where Chrome would merge it into the bullet above. (Enter
  // on an empty bullet already ends the list.)
  if (e.key === 'Backspace' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const li = listItemAtCaretStart();
    if (!li) return;
    e.preventDefault();
    document.execCommand(li.parentElement.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
    // Chrome leaves the freed line loose in the editor; make it a
    // paragraph like its neighbors so the spacing matches the copy.
    document.execCommand('formatBlock', false, 'p');
  }
});

// ── Links in the draft ──────────────────────────────────────
//
// Modeled on Gmail: Cmd/Ctrl+K or the link button opens an "Edit link"
// dialog, and with the caret in a link a bubble offers Go to link /
// Change / Remove. Added links go through safeHref, are read back like
// any other link, and get UTM rules on copy. They're left out of the
// link check, since the user put them there.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isMac = /Mac/i.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';
btnLink.title = `Insert link (${MOD}K). ${MOD}L searches your saved links.`;

// What the open dialog applies to: { range, anchor } (anchor: the link
// being changed, or null for a new one).
let linkTarget = null;
let bubbleAnchor = null;

function linkKind() {
  return linkDialog.querySelector('input[name="link-kind"]:checked').value;
}

function setLinkKind(kind) {
  linkDialog.querySelector(`input[name="link-kind"][value="${kind}"]`).checked = true;
  linkUrlLabel.textContent = kind === 'email' ? 'To what email address should this link?' : 'To what URL should this link go?';
  btnLinkTest.hidden = kind === 'email';
}

// Like Gmail, "example.com" means a web address; an email address
// typed into the web field becomes a mailto: link.
function webHref(raw) {
  if (!raw || /\s/.test(raw)) return null;
  if (EMAIL_RE.test(raw)) return safeHref('mailto:' + raw);
  const href = safeHref(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) || /^mailto:/i.test(raw) ? raw : 'https://' + raw);
  // Chrome's URL parser takes almost anything as a host, so insist on
  // something that looks like a domain.
  return href && (href.startsWith('mailto:') || new URL(href).hostname.includes('.')) ? href : null;
}

function emailHref(raw) {
  const address = raw.replace(/^mailto:/i, '');
  return EMAIL_RE.test(address) ? safeHref('mailto:' + address) : null;
}

function openLinkDialog(anchor = null) {
  if (outputEl.contentEditable !== 'true') return;
  let range = draftRange();
  if (!range) {
    // Nothing selected in the draft: add the link at the end.
    range = document.createRange();
    range.selectNodeContents(outputEl.lastElementChild || outputEl);
    range.collapse(false);
  }
  anchor = anchor || closestInDraft(range.startContainer, 'a');
  if (anchor) {
    range = document.createRange();
    range.selectNode(anchor);
  }
  linkTarget = { range: range.cloneRange(), anchor };

  const href = anchor ? anchor.dataset.href || anchor.getAttribute('href') : '';
  const text = anchor
    ? (anchor.dataset.bare && anchor.textContent === anchor.getAttribute('href') ? href : anchor.textContent)
    : range.toString().replace(/\s+/g, ' ').trim();
  const email = href ? href.startsWith('mailto:') : EMAIL_RE.test(text);
  setLinkKind(email ? 'email' : 'web');
  linkTextInput.value = text;
  // A selection that is itself an address prefills the address field.
  const looksLikeAddress = email || (/^\S+\.\S+$/.test(text) && !!webHref(text));
  linkUrlInput.value = href ? href.replace(/^mailto:/, '') : looksLikeAddress ? text : '';
  clearStatus(linkStatus);
  linkBubble.hidden = true;
  linkDialog.showModal();
  (text ? linkUrlInput : linkTextInput).focus();
}

// Puts the caret (or the saved selection) back in the draft. A plain
// focus() would scroll a long draft back to its top.
function restoreDraftSelection(range) {
  outputEl.focus({ preventScroll: true });
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function closeLinkDialog() {
  if (linkDialog.open) linkDialog.close();
  if (linkTarget) restoreDraftSelection(linkTarget.range);
  linkTarget = null;
}

function applyLink() {
  const raw = linkUrlInput.value.trim();
  const kind = linkKind();
  const href = kind === 'email' ? emailHref(raw) : webHref(raw);
  if (!href) {
    showStatus(linkStatus, kind === 'email'
      ? 'Enter an email address, like name@example.com.'
      : 'Enter a web address, like https://example.com.', 'error');
    linkUrlInput.focus();
    return;
  }
  const shown = linkTextInput.value.replace(/\s+/g, ' ').trim() || (kind === 'email' ? href.slice(7) : href);
  const { range } = linkTarget;
  linkDialog.close();
  linkTarget = null;
  insertLink(range, shown, href);
}

// Replaces `range` in the draft with a link and returns the new <a>.
function insertLink(range, text, href) {
  const a = linkElement({ type: 'link', text, href, bare: text === href }, document, tagUrl);
  a.dataset.inserted = '1';
  // Recorded before the edit, whose input event re-runs the link check.
  if (state.draftSources) state.draftSources.userUrls.add(href);
  restoreDraftSelection(range);
  // execCommand keeps this on the editor's undo stack.
  document.execCommand('insertHTML', false, a.outerHTML);
  const inserted = outputEl.querySelector('a[data-inserted]');
  if (inserted) delete inserted.dataset.inserted;
  return inserted;
}

// Puts a popup just under `rect`, kept inside the draft section.
function placeUnder(el, rect, gap) {
  const box = draftSection.getBoundingClientRect();
  const left = Math.min(rect.left - box.left, box.width - el.offsetWidth);
  el.style.top = `${rect.bottom - box.top + gap}px`;
  el.style.left = `${Math.max(0, left)}px`;
}

function removeLink(anchor) {
  const range = document.createRange();
  range.selectNodeContents(anchor);
  restoreDraftSelection(range);
  document.execCommand('unlink');
  getSelection().collapseToEnd();
}

linkDialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeLinkDialog();
});
linkDialog.addEventListener('change', (e) => {
  if (e.target.name === 'link-kind') {
    setLinkKind(e.target.value);
    linkUrlInput.focus();
  }
});
for (const input of [linkTextInput, linkUrlInput]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      applyLink();
    }
  });
}
$('#btn-link-ok').addEventListener('click', applyLink);
$('#btn-link-cancel').addEventListener('click', closeLinkDialog);
$('#btn-link-close').addEventListener('click', closeLinkDialog);
btnLinkTest.addEventListener('click', () => {
  const href = webHref(linkUrlInput.value.trim());
  if (href) window.open(tagUrl(href), '_blank', 'noopener');
  else showStatus(linkStatus, 'Enter a web address to test.', 'error');
});

// Keep the draft's selection when clicking the link button or bubble.
for (const el of [btnLink, linkBubble]) el.addEventListener('mousedown', (e) => e.preventDefault());
btnLink.addEventListener('click', () => openLinkDialog());

// Stays out of the way while the save chip sits under a new link.
function updateLinkBubble() {
  const editing = document.activeElement === outputEl && outputEl.contentEditable === 'true';
  const range = editing && saveChip.hidden ? draftRange() : null;
  const anchor = range && closestInDraft(range.startContainer, 'a');
  bubbleAnchor = anchor;
  if (!anchor) {
    linkBubble.hidden = true;
    return;
  }
  const href = anchor.dataset.href || anchor.getAttribute('href');
  bubbleUrl.href = tagUrl(href);
  bubbleUrl.textContent = href.replace(/^mailto:/, '');
  bubbleUrl.title = tagUrl(href);
  linkBubble.hidden = false;
  placeUnder(linkBubble, anchor.getClientRects()[0] || anchor.getBoundingClientRect(), 4);
}

document.addEventListener('selectionchange', updateLinkBubble);
outputEl.addEventListener('blur', () => { linkBubble.hidden = true; });
$('#btn-bubble-change').addEventListener('click', () => bubbleAnchor && openLinkDialog(bubbleAnchor));
$('#btn-bubble-remove').addEventListener('click', () => bubbleAnchor && removeLink(bubbleAnchor));

// ── Saved links (Cmd/Ctrl+L) ────────────────────────────────
//
// The same picker as Cmd+L in a Gmail reply: search your saved links or
// type an address, then Enter (or Cmd+L again) to link the selection.
// With nothing selected, the link's name (or the address) is inserted at
// the caret. After a one-off address, a chip offers to save the selected
// text and address as a link rule, as it does in Gmail.

// The open picker: { range, text, corpus, rules } (rules: saved links
// whose URL is usable, with its href).
let picker = null;
let pickResults = [];
let pickIndex = 0;
// The chip on screen: { trigger, label, href, keys }.
let pendingSave = null;

$('#link-search-hint').textContent = `↑↓ navigate · Enter or ${MOD}L insert · Esc close`;

async function openLinkSearch() {
  if (outputEl.contentEditable !== 'true') return;
  let range = draftRange();
  if (!range) return;
  const anchor = closestInDraft(range.startContainer, 'a');
  if (anchor) {
    range = document.createRange();
    range.selectNode(anchor);
  }
  hideSaveChip();
  // A bare link's text is its address, which isn't worth keeping.
  const text = anchor && anchor.dataset.bare ? '' : range.toString().replace(/\s+/g, ' ').trim();
  const target = { range: range.cloneRange(), text };
  picker = target;
  const corpus = await loadCorpus();
  if (picker !== target) return; // closed or reopened while loading
  utmRules = corpus.utmRules;
  target.corpus = corpus;
  target.rules = corpus.linkRules.getAll()
    .map((r) => ({ ...r, href: webHref(r.url.trim()) }))
    .filter((r) => r.href);

  linkBubble.hidden = true;
  linkSearch.hidden = false;
  linkSearchInput.value = '';
  renderLinkSearch('');
  placeUnder(linkSearch, rangeRect(target.range), 6);
  linkSearchInput.focus();
  linkSearch.scrollIntoView({ block: 'nearest' });
}

// A collapsed range can measure 0×0 (an empty line); fall back to its line.
function rangeRect(range) {
  const rect = range.getBoundingClientRect();
  if (rect.width || rect.height) return rect;
  const node = range.startContainer;
  return (node.nodeType === 1 ? node : node.parentElement).getBoundingClientRect();
}

function closeLinkSearch(restore = true) {
  const target = picker;
  picker = null;
  linkSearch.hidden = true;
  if (restore && target) restoreDraftSelection(target.range);
}

function renderLinkSearch(filter) {
  const query = filter.trim();
  const lower = query.toLowerCase();
  const rules = picker.rules;
  const matches = lower
    ? rules.filter((r) => r.trigger.includes(lower) || r.url.toLowerCase().includes(lower))
    : rules;
  const typed = webHref(query);
  pickResults = [
    ...(typed ? [{ kind: 'url', href: typed }] : []),
    ...matches.map((r) => ({ kind: 'rule', ...r })),
  ];
  pickIndex = 0;
  linkSearchList.textContent = '';

  if (!pickResults.length) {
    const empty = document.createElement('div');
    empty.className = 'lingofrog-ls-empty';
    empty.textContent = query ? 'No matching links' : 'No saved links yet. Type a URL to insert one.';
    linkSearchList.appendChild(empty);
    return;
  }

  pickResults.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'lingofrog-ls-item' + (r.kind === 'url' ? ' lingofrog-ls-url-insert' : '');
    item.setAttribute('role', 'option');
    item.title = r.href;
    const name = document.createElement('span');
    name.className = 'lingofrog-ls-trigger';
    item.appendChild(name);
    if (r.kind === 'url') {
      const email = r.href.startsWith('mailto:');
      const label = document.createElement('span');
      label.className = 'lingofrog-ls-url-insert-label';
      label.textContent = email ? '✉️ Insert email: ' : '🔗 Insert URL: ';
      name.append(label, r.href.replace(/^https?:\/\/|^mailto:/, ''));
    } else {
      name.textContent = r.trigger;
      const host = document.createElement('span');
      host.className = 'lingofrog-ls-url';
      host.textContent = r.href.replace(/^https?:\/\/|^mailto:/, '').split('/')[0];
      item.appendChild(host);
    }
    // mousedown, so the search box keeps focus until the link goes in.
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickIndex = i;
      acceptLinkSearch();
    });
    linkSearchList.appendChild(item);
  });
  updatePickSelection();
}

function updatePickSelection() {
  linkSearchList.querySelectorAll('.lingofrog-ls-item').forEach((item, i) => {
    item.classList.toggle('lingofrog-ls-selected', i === pickIndex);
    item.setAttribute('aria-selected', String(i === pickIndex));
    if (i === pickIndex) item.scrollIntoView({ block: 'nearest' });
  });
}

function acceptLinkSearch() {
  const chosen = pickResults[pickIndex];
  if (!picker || !chosen) {
    closeLinkSearch();
    return;
  }
  const { range, text, corpus } = picker;
  closeLinkSearch(false);
  const shown = text || (chosen.kind === 'rule' ? chosen.label || chosen.trigger : chosen.href.replace(/^mailto:/, ''));
  const a = insertLink(range, shown, chosen.href);
  if (chosen.kind === 'url' && a) maybeShowSaveChip(text, chosen.href, a, corpus);
}

linkSearchInput.addEventListener('input', () => renderLinkSearch(linkSearchInput.value));
linkSearchInput.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!pickResults.length) return;
    pickIndex = (pickIndex + (e.key === 'ArrowDown' ? 1 : -1) + pickResults.length) % pickResults.length;
    updatePickSelection();
  } else if (e.key === 'Enter' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l')) {
    e.preventDefault();
    acceptLinkSearch();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeLinkSearch();
  }
});

// Like Gmail's chip: only for a one-off address, only when the selection
// is short enough to be a useful trigger, and not if that rule already
// exists with this address. Stores the address without UTM tags, so the
// rules are applied fresh each time the link is used.
function maybeShowSaveChip(text, href, anchor, corpus) {
  if (corpus.config.showSaveRuleChip === false) return;
  const trigger = text.toLowerCase().trim();
  if (!trigger || trigger.length > 80) return;
  const existing = corpus.linkRules.rules.get(trigger);
  if (existing && webHref(existing.url.trim()) === href) return;

  pendingSave = { trigger, label: text, href, keys: 0 };
  const shortHref = href.replace(/^https?:\/\/|^mailto:/, '');
  const strong = document.createElement('strong');
  strong.textContent = trigger;
  const next = document.createElement('span');
  next.className = 'lingofrog-src-new';
  next.textContent = shortHref;
  saveChipLabel.textContent = '';
  if (existing) {
    const old = document.createElement('span');
    old.className = 'lingofrog-src-old';
    old.textContent = existing.url.replace(/^https?:\/\/|^mailto:/, '').split('/')[0];
    saveChipLabel.append('Replace ', strong, ' → ', old, ' with ', next, '?');
  } else {
    saveChipLabel.append('Save ', strong, ' → ', next, ' as a link rule?');
  }
  $('#btn-save-chip').textContent = existing ? 'Replace' : 'Save';
  linkBubble.hidden = true;
  saveChip.hidden = false;
  placeUnder(saveChip, anchor.getClientRects()[0] || anchor.getBoundingClientRect(), 6);
}

function hideSaveChip() {
  if (saveChip.hidden) return;
  saveChip.hidden = true;
  pendingSave = null;
  updateLinkBubble();
}

// While the chip is up: Esc dismisses it, and it goes away on its own
// after five keystrokes of typing, as in Gmail. True if the key was used.
function trackSaveChipKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    hideSaveChip();
    return true;
  }
  if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter') {
    if (++pendingSave.keys >= 5) hideSaveChip();
  }
  return false;
}

// Reloads first, so saving never writes back a stale copy of the rules.
async function acceptSaveChip() {
  if (!pendingSave) return;
  const { trigger, label, href } = pendingSave;
  hideSaveChip();
  const corpus = await loadCorpus();
  const replaced = corpus.linkRules.rules.has(trigger);
  corpus.linkRules.addRule(trigger, href, label);
  await corpus.linkRules.save();
  showStatus(writeStatus, replaced ? '✓ Link replaced' : '✓ Link saved', 'success');
}

for (const [id, action] of [['#btn-save-chip', acceptSaveChip], ['#btn-save-chip-dismiss', hideSaveChip]]) {
  $(id).addEventListener('mousedown', (e) => {
    e.preventDefault();
    action();
  });
}

// A click anywhere else closes the picker or chip, as in Gmail. Capture,
// so this runs before a picker item's handler opens the chip.
document.addEventListener('mousedown', (e) => {
  if (!linkSearch.hidden && !linkSearch.contains(e.target)) closeLinkSearch(false);
  if (!saveChip.hidden && !saveChip.contains(e.target)) hideSaveChip();
}, true);

function urlVariants(href) {
  return [href, href.replace(/\/$/, ''), href.replace(/^mailto:/, '')];
}

// Lists every link that isn't one of the user's saved links. A link
// that also appears in the context isn't automatically safe — a hostile
// email can carry its own URL plus "link to this" — so those are listed
// too, just labeled with where they came from. Links found nowhere were
// made up by the model. Links the user added themselves are skipped.
function renderLinkWarning(blocks) {
  const sources = state.draftSources;
  const unsaved = sources
    ? [...new Set(collectLinks(blocks))].filter(
        (href) => !sources.savedUrls.has(href.replace(/\/$/, '')) && !sources.userUrls.has(href)
      )
    : [];
  linkWarning.textContent = '';
  linkWarning.hidden = !unsaved.length;
  if (!unsaved.length) return;
  linkWarning.append(
    unsaved.length === 1
      ? 'Check this link before sending. It isn\'t one of your saved links:'
      : 'Check these links before sending. They aren\'t among your saved links:'
  );
  const list = document.createElement('ul');
  for (const href of unsaved) {
    const fromContext = urlVariants(href).some((v) => v && sources.context.includes(v));
    const li = document.createElement('li');
    li.textContent = `${href} (${fromContext ? 'from your context' : 'not in your context'})`;
    list.appendChild(li);
  }
  linkWarning.appendChild(list);
}

// ── Write ───────────────────────────────────────────────────

function updateWriteButton() {
  if (state.stream) {
    btnWrite.textContent = 'Stop';
    btnWrite.classList.add('stopping');
    btnWrite.disabled = false;
    return;
  }
  btnWrite.textContent = state.draft ? 'Rewrite' : 'Write';
  btnWrite.classList.remove('stopping');
  btnWrite.disabled = !contextEl.value.trim();
}

// Loaded fresh for each write/copy so edits made in the popup since the
// panel opened are picked up.
async function loadCorpus() {
  const corpus = new Corpus();
  await corpus.load();
  return corpus;
}

// Links in a draft always carry the user's UTM rules, in the preview
// and on copy. Unlike the Links tab, this doesn't follow the "Include
// UTM parameters when copying links" setting; Scribe may get its own
// toggle later. Refreshed with every corpus load and on rule edits.
let utmRules = null;
const tagUrl = (href) => (utmRules ? utmRules.applyTo(href) : href);

function savedLinks(corpus) {
  return [...corpus.linkRules.rules.entries()].map(([trigger, rule]) => ({
    label: rule.label || trigger,
    url: rule.url,
  }));
}

function savedUrlSet(links) {
  return new Set(links.map((l) => (safeHref(l.url) || l.url).replace(/\/$/, '')));
}

function topPhrases(corpus) {
  const ranked = [...corpus.phrases.entries()]
    .map(([phrase, data]) => ({ phrase, score: corpus._computeScore(phrase, data) }))
    .sort((a, b) => b.score - a.score);
  const picked = [];
  let chars = 0;
  for (const { phrase } of ranked) {
    if (picked.length >= MAX_PHRASES) break;
    // Skip (rather than stop at) one long phrase so shorter ones still fit.
    if (chars + phrase.length > MAX_PHRASE_CHARS) continue;
    picked.push(phrase);
    chars += phrase.length;
  }
  return picked;
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic didn\'t accept your API key. Check it with the key button above.';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'Your API key doesn\'t have permission to use this model.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limited by Anthropic. Wait a moment and try again.';
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `Anthropic rejected the request: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Couldn\'t reach Anthropic. Check your connection and try again.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error${err.status ? ` (${err.status})` : ''}: ${err.message}`;
  }
  return `Something went wrong: ${err && err.message ? err.message : err}`;
}

async function write() {
  if (state.stream) {
    state.stream.abort();
    return;
  }
  const context = contextEl.value.trim();
  if (!context) return;
  if (!state.apiKey) {
    openKeyCard();
    showStatus(keyStatus, 'Add your API key to start writing.', 'error');
    return;
  }
  if (isEdited() && !confirm('Rewriting replaces your edited draft. Continue?')) return;

  clearStatus(writeStatus);
  hideSuggestion();
  const corpus = await loadCorpus();
  utmRules = corpus.utmRules;
  const links = savedLinks(corpus);
  const phrases = topPhrases(corpus);
  const style = state.styles.find((s) => s.id === state.styleId) || null;
  const client = new Anthropic({ apiKey: state.apiKey, dangerouslyAllowBrowser: true });

  state.draft = '';
  state.generated = '';
  state.draftStyleId = style ? style.id : null;
  state.draftSources = { context, savedUrls: savedUrlSet(links), userUrls: new Set() };
  const stream = client.beta.messages.stream(
    buildRequest({ context, style, guide: state.guide, links, phrases })
  );
  state.stream = stream;
  updateWriteButton();
  renderOutput();

  stream.on('text', (delta) => {
    state.draft += delta;
    scheduleRender();
  });

  try {
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      state.draft = '';
      showStatus(writeStatus, 'Claude declined to write this draft. Try rewording the context or style.', 'error');
    } else if (message.stop_reason === 'max_tokens') {
      showStatus(writeStatus, 'The draft hit the length limit and was cut off.', 'error');
    }
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError) {
      showStatus(writeStatus, 'Stopped.', 'info');
    } else {
      showStatus(writeStatus, describeError(err), 'error', 0);
      if (err instanceof Anthropic.AuthenticationError) openKeyCard();
    }
  } finally {
    // Whatever came back (complete, stopped early, or cut off) becomes
    // the baseline that later edits are compared against.
    state.draft = canonicalDraft(state.draft);
    state.generated = state.draft;
    state.stream = null;
    updateWriteButton();
    renderOutput();
    persistDraft();
  }
}

btnWrite.addEventListener('click', write);
contextEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !btnWrite.disabled) write();
});

// ── Copy ────────────────────────────────────────────────────

// Copies rich text (Gmail keeps the bold, italics, lists, and links)
// plus a plain-text fallback, with UTM rules applied (see tagUrl).
btnCopy.addEventListener('click', async () => {
  const blocks = parseDraft(state.draft);
  if (!blocks.length) return;
  try {
    utmRules = (await loadCorpus()).utmRules;
    const html = toClipboardHtml(blocks, tagUrl);
    const text = toPlainText(blocks, tagUrl);
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
    showStatus(writeStatus, '✓ Draft copied. Paste it into Gmail.', 'success');
  } catch (e) {
    showStatus(writeStatus, 'Copy failed: ' + e.message, 'error');
  }
});

// ── Suggest a rule ──────────────────────────────────────────
//
// Compares the draft as Claude wrote it with the user's edited version
// and proposes one rule for the style that wrote it (or the general
// style if none did). Nothing is saved until the user clicks Add, and
// they can edit the wording first.

function updateSuggestButton() {
  draftActions.hidden = !state.generated || !!state.stream;
  btnSuggest.disabled = !isEdited() || state.suggesting;
  btnSuggest.textContent = state.suggesting ? 'Comparing your edits…' : 'Suggest a rule from my edits';
  btnSuggest.title = isEdited() ? '' : 'Edit the draft first; Scribe suggests a rule based on your changes.';
}

function hideSuggestion() {
  suggestCard.hidden = true;
  state.suggestionStyleId = null;
}

// New rules go on their own line, as a bullet if the rules already are.
function appendRule(existing, rule) {
  const text = existing.trimEnd();
  if (!text) return rule;
  const lastLine = text.split('\n').pop();
  const bullet = /^\s*[-*•]\s/.test(lastLine) && !/^\s*[-*•]\s/.test(rule) ? '- ' : '';
  return `${text}\n${bullet}${rule}`;
}

// Each Add button names where the rule goes. The rule was written for
// the style that drafted the email, so that one is the main button and
// the general style is the alternative (or the only option, when the
// draft had no style).
function showSuggestion(result, style) {
  const rule = (result.guideline || '').trim();
  state.suggestionStyleId = style ? style.id : null;
  suggestTitle.textContent = rule ? 'Suggested rule' : 'No rule to suggest';
  suggestWhy.textContent = result.explanation || '';
  suggestText.hidden = !rule;
  suggestText.value = rule;
  btnSuggestStyle.hidden = !rule || !style;
  btnSuggestStyle.textContent = style ? `Add to "${style.name}"` : '';
  btnSuggestStyle.title = style ? `Only for drafts written with the "${style.name}" style` : '';
  btnSuggestGuide.hidden = !rule;
  btnSuggestGuide.classList.toggle('btn-primary', !style);
  btnSuggestGuide.classList.toggle('btn-secondary', !!style);
  $('#btn-suggest-dismiss').textContent = rule ? 'Dismiss' : 'OK';
  suggestCard.hidden = false;
  suggestCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

btnSuggest.addEventListener('click', async () => {
  if (!isEdited() || state.suggesting) return;
  if (!state.apiKey) {
    openKeyCard();
    return;
  }
  // The style may have been deleted since it wrote the draft; then the
  // suggestion is for the general style.
  const style = state.styles.find((s) => s.id === state.draftStyleId) || null;
  state.suggesting = true;
  updateSuggestButton();
  hideSuggestion();
  try {
    const client = new Anthropic({ apiKey: state.apiKey, dangerouslyAllowBrowser: true });
    const message = await client.beta.messages.create(buildSuggestionRequest({
      style, guide: state.guide, original: state.generated, edited: state.draft,
    }));
    if (message.stop_reason === 'refusal') {
      showStatus(writeStatus, 'Claude declined to suggest a rule for these edits.', 'error');
      return;
    }
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let result;
    try {
      result = JSON.parse(text);
    } catch (e) {
      showStatus(writeStatus, 'Couldn\'t read Claude\'s suggestion. Try again.', 'error');
      return;
    }
    showSuggestion(result, style);
  } catch (err) {
    showStatus(writeStatus, describeError(err), 'error', 0);
    if (err instanceof Anthropic.AuthenticationError) openKeyCard();
  } finally {
    state.suggesting = false;
    updateSuggestButton();
  }
});

$('#btn-suggest-dismiss').addEventListener('click', hideSuggestion);

btnSuggestStyle.addEventListener('click', () => {
  const rule = suggestText.value.trim();
  const style = state.styles.find((s) => s.id === state.suggestionStyleId);
  if (!rule) return;
  if (!style) {
    showStatus(writeStatus, 'That style no longer exists. Add the rule to your general style instead.', 'error');
    return;
  }
  style.instructions = appendRule(style.instructions, rule);
  saveStyles();
  renderStyles();
  hideSuggestion();
  showStatus(writeStatus, `✓ Added to "${style.name}"`, 'success');
});

btnSuggestGuide.addEventListener('click', () => {
  const rule = suggestText.value.trim();
  if (!rule) return;
  state.guide = appendRule(state.guide, rule);
  chrome.storage.local.set({ [GUIDE_STORAGE]: state.guide });
  renderGuide();
  hideSuggestion();
  showStatus(writeStatus, '✓ Added to your general style', 'success');
});

// ── Clear ───────────────────────────────────────────────────

let undoClear = null;

// Disabled mid-stream: Stop is the way out of a draft in progress.
function updateClearButton() {
  btnClear.disabled = !!state.stream || (!contextEl.value.trim() && !state.draft);
}

btnClear.addEventListener('click', () => {
  const snapshot = {
    context: contextEl.value,
    draft: state.draft,
    generated: state.generated,
    draftStyleId: state.draftStyleId,
    draftSources: state.draftSources,
  };
  contextEl.value = '';
  state.draft = '';
  state.generated = '';
  state.draftStyleId = null;
  state.draftSources = null;
  hideSuggestion();
  updateWriteButton();
  renderOutput();
  persistDraft();

  // One-click undo, since this throws away typed context.
  undoClear = snapshot;
  showStatus(writeStatus, 'Cleared.', 'info', 8000);
  const undo = document.createElement('button');
  undo.className = 'status-action';
  undo.textContent = 'Undo';
  undo.addEventListener('click', () => {
    if (!undoClear) return;
    contextEl.value = undoClear.context;
    state.draft = undoClear.draft;
    state.generated = undoClear.generated;
    state.draftStyleId = undoClear.draftStyleId;
    state.draftSources = undoClear.draftSources;
    undoClear = null;
    clearStatus(writeStatus);
    updateWriteButton();
    renderOutput();
    persistDraft();
  });
  writeStatus.appendChild(undo);
  contextEl.focus();
});

// ── Init ────────────────────────────────────────────────────

async function init() {
  const local = await chrome.storage.local.get([KEY_STORAGE, STYLES_STORAGE, STYLE_ID_STORAGE, GUIDE_STORAGE]);
  state.apiKey = local[KEY_STORAGE] || '';
  state.guide = local[GUIDE_STORAGE] || '';
  // Seed the starter styles only on first run — an empty array means
  // the user deleted them all, which we respect.
  state.styles = Array.isArray(local[STYLES_STORAGE]) ? local[STYLES_STORAGE] : DEFAULT_STYLES.map((s) => ({ ...s }));
  state.styleId = state.styles.some((s) => s.id === local[STYLE_ID_STORAGE])
    ? local[STYLE_ID_STORAGE]
    : (state.styles[0] && state.styles[0].id) || null;
  if (!Array.isArray(local[STYLES_STORAGE])) saveStyles();

  let userLinks = [];
  try {
    const { [DRAFT_STORAGE]: draft } = await chrome.storage.session.get(DRAFT_STORAGE);
    if (draft) {
      contextEl.value = draft.context || '';
      state.draft = canonicalDraft(draft.output || '');
      state.generated = draft.generated != null ? draft.generated : state.draft;
      state.draftStyleId = draft.styleId || null;
      userLinks = draft.userLinks || [];
    }
  } catch (e) {
    // Session storage unavailable; start blank.
  }

  const corpus = await loadCorpus();
  utmRules = corpus.utmRules;
  // The link check needs to know what a restored draft came from.
  if (state.draft) {
    state.draftSources = {
      context: contextEl.value,
      savedUrls: savedUrlSet(savedLinks(corpus)),
      userUrls: new Set(userLinks),
    };
  }

  renderGuide();
  renderStyles();
  renderOutput();
  updateWriteButton();
  if (!state.apiKey) openKeyCard();
  else contextEl.focus();
}

// UTM rules edited in the popup while the panel is open: re-tag the
// draft's links right away.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.lingofrog_utm_rules) return;
  loadCorpus().then((corpus) => {
    utmRules = corpus.utmRules;
    // Skip while the user is typing in the draft: a re-render would
    // reset their caret. Copy re-reads the rules anyway.
    if (!state.stream && document.activeElement !== outputEl && !linkDialog.open && !picker) renderOutput();
  });
});

init();
