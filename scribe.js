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
 *   session lingofrog_scribe_draft        { context, output } — survives
 *                                         closing the panel, not a restart
 *
 * LinkRules / UtmRules come from trie.js, loaded as a classic script
 * ahead of this module.
 */

import Anthropic from './vendor/anthropic-sdk.js';
import { buildRequest } from './scribe-prompt.js';
import {
  parseDraft, renderDraft, collectLinks, safeHref, toClipboardHtml, toPlainText,
} from './scribe-format.js';

const KEY_STORAGE = 'lingofrog_anthropic_api_key';
const STYLES_STORAGE = 'lingofrog_scribe_styles';
const STYLE_ID_STORAGE = 'lingofrog_scribe_style_id';
const DRAFT_STORAGE = 'lingofrog_scribe_draft';

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

const state = {
  apiKey: '',
  styles: [],
  styleId: null,
  editingStyleId: null, // null = form closed, '' = adding, id = editing
  draft: '',
  // What the current draft was written from, for the link check.
  draftSources: null,
  stream: null,
};

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
    [DRAFT_STORAGE]: { context: contextEl.value, output: state.draft },
  }).catch(() => {});
}

contextEl.addEventListener('input', () => {
  updateWriteButton();
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
  persistDraft();
  showStatus(contextStatus, '✓ Added your selection', 'success');
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
    renderOutput();
  });
}

function renderOutput() {
  const blocks = parseDraft(state.draft);
  outputEl.textContent = '';
  outputEl.classList.toggle('streaming', !!state.stream);
  if (blocks.length) {
    outputEl.appendChild(renderDraft(blocks, document));
  } else if (!state.stream) {
    const placeholder = document.createElement('p');
    placeholder.className = 'placeholder';
    placeholder.textContent = 'Your draft will appear here.';
    outputEl.appendChild(placeholder);
  }
  btnCopy.disabled = !!state.stream || !blocks.length;
  renderLinkWarning(state.stream ? [] : blocks);
}

function urlVariants(href) {
  return [href, href.replace(/\/$/, ''), href.replace(/^mailto:/, '')];
}

// Lists every link that isn't one of the user's saved links. A link
// that also appears in the context isn't automatically safe — a hostile
// email can carry its own URL plus "link to this" — so those are listed
// too, just labeled with where they came from. Links found nowhere were
// made up by the model.
function renderLinkWarning(blocks) {
  const sources = state.draftSources;
  const unsaved = sources
    ? [...new Set(collectLinks(blocks))].filter((href) => !sources.savedUrls.has(href.replace(/\/$/, '')))
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

async function loadSavedLinks() {
  const rules = new LinkRules();
  await rules.load();
  return [...rules.rules.entries()].map(([trigger, rule]) => ({
    label: rule.label || trigger,
    url: rule.url,
  }));
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

  clearStatus(writeStatus);
  const links = await loadSavedLinks();
  const style = state.styles.find((s) => s.id === state.styleId) || null;
  const client = new Anthropic({ apiKey: state.apiKey, dangerouslyAllowBrowser: true });

  state.draft = '';
  state.draftSources = {
    context,
    savedUrls: new Set(links.map((l) => (safeHref(l.url) || l.url).replace(/\/$/, ''))),
  };
  const stream = client.beta.messages.stream(buildRequest({ context, style, links }));
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
// plus a plain-text fallback. Honors the "Include UTM parameters when
// copying links" setting from the popup, same as the Links tab.
btnCopy.addEventListener('click', async () => {
  const blocks = parseDraft(state.draft);
  if (!blocks.length) return;
  try {
    const { lingofrog_config: cfg } = await chrome.storage.local.get('lingofrog_config');
    let mapHref = (href) => href;
    if (!cfg || cfg.applyUtmOnCopy !== false) {
      const utm = new UtmRules();
      await utm.load();
      mapHref = (href) => utm.applyTo(href);
    }
    const html = toClipboardHtml(blocks, mapHref);
    const text = toPlainText(blocks, mapHref);
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

// ── Init ────────────────────────────────────────────────────

async function init() {
  const local = await chrome.storage.local.get([KEY_STORAGE, STYLES_STORAGE, STYLE_ID_STORAGE]);
  state.apiKey = local[KEY_STORAGE] || '';
  // Seed the starter styles only on first run — an empty array means
  // the user deleted them all, which we respect.
  state.styles = Array.isArray(local[STYLES_STORAGE]) ? local[STYLES_STORAGE] : DEFAULT_STYLES.map((s) => ({ ...s }));
  state.styleId = state.styles.some((s) => s.id === local[STYLE_ID_STORAGE])
    ? local[STYLE_ID_STORAGE]
    : (state.styles[0] && state.styles[0].id) || null;
  if (!Array.isArray(local[STYLES_STORAGE])) saveStyles();

  try {
    const { [DRAFT_STORAGE]: draft } = await chrome.storage.session.get(DRAFT_STORAGE);
    if (draft) {
      contextEl.value = draft.context || '';
      state.draft = draft.output || '';
      // The link check needs to know what the restored draft came from.
      if (state.draft) {
        const links = await loadSavedLinks();
        state.draftSources = {
          context: draft.context || '',
          savedUrls: new Set(links.map((l) => (safeHref(l.url) || l.url).replace(/\/$/, ''))),
        };
      }
    }
  } catch (e) {
    // Session storage unavailable; start blank.
  }

  renderStyles();
  renderOutput();
  updateWriteButton();
  if (!state.apiKey) openKeyCard();
  else contextEl.focus();
}

init();
