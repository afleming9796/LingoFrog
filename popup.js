/**
 * popup.js — LingoFrog popup logic.
 */

const corpus = new Corpus();

const $ = (sel) => document.querySelector(sel);
const pasteArea = $('#paste-area');
const btnImport = $('#btn-import');
const importStatus = $('#import-status');
const importHint = $('#import-hint');
const phraseList = $('#phrase-list');
const linkStatus = $('#link-status');
const linkRuleList = $('#link-rule-list');
const phraseSearch = $('#phrase-search');
const corpusStatus = $('#corpus-status');
const btnExportAll = $('#btn-export-all');
const btnImportAll = $('#btn-import-all');
const backupStatus = $('#backup-status');
const linkSearch = $('#link-search');
const utmList = $('#utm-list');
const utmStatus = $('#utm-status');
const btnAddUtmRoot = $('#btn-add-utm-root');

let importType = 'phrases';

// UI state for the UTM section. `expandedHost` is the host of the row
// currently expanded for editing (null = none). `draftRoot` represents
// an in-progress "add new root" entry that hasn't been saved yet.
let utmExpandedHost = null;
let utmDraftRoot = null; // { host: '', params: [{key, value}] } when active

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

// ── Initialize ─────────────────────────────────────────────

async function init() {
  await corpus.load();
  updateStats();
  updatePhraseList();
  updateLinkRuleList();
  updateUtmList();
  loadSettings();
  focusActiveTabSearch();
}

// On popup open, drop the cursor in the current tab's search input so
// users can start typing (or hit ⌃L → type) without an extra click.
// Only Links and Phrases have a search; other tabs are no-ops.
function focusActiveTabSearch() {
  const active = document.querySelector('.tab-content.active');
  if (!active) return;
  const search = active.querySelector('#link-search, #phrase-search');
  if (search) search.focus();
}

function updateStats() {
  const stats = corpus.getStats();
  phraseSearch.placeholder = searchPlaceholder(stats.totalPhrases, 'phrase');
  linkSearch.placeholder = searchPlaceholder(stats.totalLinkRules, 'link');
}

// Singular-aware count baked into the search-input placeholder.
// Empty state falls back to "Search phrases..." so "Search 0 phrases..."
// never shows.
function searchPlaceholder(count, noun) {
  if (count === 0) return `Search ${noun}s...`;
  const label = count.toLocaleString() + ' ' + noun + (count === 1 ? '' : 's');
  return `Search ${label}...`;
}

function updatePhraseList() {
  const filter = phraseSearch ? phraseSearch.value.trim() : '';
  const allPhrases = corpus.getAllPhrases(filter);
  phraseList.innerHTML = '';
  // Reset the scroll wrapper's max-height. startEditPhrase bumps it
  // up while editing so the Bop row isn't clipped.
  const scroll = document.getElementById('phrase-list-scroll');
  if (scroll) scroll.style.maxHeight = '';

  if (allPhrases.length === 0) {
    const msg = filter ? 'No phrases match your search.' : 'No phrases yet. Click + to add one.';
    phraseList.innerHTML = `<li class="link-empty">${msg}</li>`;
    return;
  }

  for (const item of allPhrases) {
    const li = document.createElement('li');
    li.className = 'phrase-item';

    const freq = document.createElement('span');
    freq.className = 'phrase-freq';
    freq.textContent = Math.round(item.score);

    const text = document.createElement('span');
    text.className = 'phrase-text';
    text.textContent = item.phrase.length > 60 ? item.phrase.slice(0, 60) + '\u2026' : item.phrase;
    text.title = item.phrase;

    text.addEventListener('click', () => openPhraseForm('edit', item.phrase));

    li.appendChild(freq);
    li.appendChild(text);
    // Small badge if this phrase has any follow-ups configured, so
    // users can scan the list and see which entries are bopped.
    const followCount = corpus.getFollowedBy(item.phrase).length;
    if (followCount) {
      const badge = document.createElement('span');
      badge.className = 'phrase-bop-badge';
      badge.textContent = followCount === 1 ? 'bop' : `bop ×${followCount}`;
      badge.title = 'This phrase bops to ' + followCount + ' follow-up phrase' + (followCount === 1 ? '' : 's');
      li.appendChild(badge);
    }
    phraseList.appendChild(li);
  }
}


function updateLinkRuleList() {
  const filter = linkSearch ? linkSearch.value.trim().toLowerCase() : '';
  const rules = corpus.linkRules.getAll();
  linkRuleList.innerHTML = '';

  const filtered = filter
    ? rules.filter((r) => r.trigger.includes(filter) || r.url.toLowerCase().includes(filter))
    : rules;

  if (filtered.length === 0) {
    const msg = filter ? 'No links match your search.' : 'No link rules yet. Click + to add one.';
    linkRuleList.innerHTML = `<li class="link-empty">${msg}</li>`;
    return;
  }

  for (const rule of filtered) {
    linkRuleList.appendChild(renderLinkRuleRow(rule));
  }
}

// Returns true when the URL is safe to render as a clickable <a>.
// Allow http/https/mailto/tel; reject anything else so an admin
// click in the popup can't fire a dangerous scheme.
function isSafeNavigableUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol);
  } catch (e) {
    return false;
  }
}

// Inline SVGs for the row action buttons. Kept small; sized by the
// .link-rule-action svg CSS rule.
const ICON_OPEN_URL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 11L11 5"/><path d="M6 5h5v5"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="8.5" height="9.5" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H4A1.5 1.5 0 0 0 2.5 3.5v6A1.5 1.5 0 0 0 4 11h1"/></svg>';

function renderLinkRuleRow(rule) {
  const li = document.createElement('li');
  li.className = 'link-rule-item';

  // Trigger: click opens the Edit Link sub-view. Was previously an
  // <a> that navigated to the URL \u2014 that job now belongs to the Open
  // action button below.
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'link-rule-trigger';
  trigger.textContent = rule.trigger;
  trigger.title = 'Edit ' + rule.trigger;
  trigger.addEventListener('click', () => openLinkForm('edit', rule.trigger));

  const arrow = document.createElement('span');
  arrow.className = 'link-rule-arrow';
  arrow.textContent = '\u2192';

  const url = document.createElement('span');
  url.className = 'link-rule-url';
  url.textContent = rule.url;
  url.title = rule.url;

  // Open: <a> with target=_blank when the URL is safe; disabled span
  // otherwise. Anchor keeps us free of the "tabs" permission we'd
  // otherwise need for chrome.tabs.create.
  const safe = isSafeNavigableUrl(rule.url);
  const openBtn = document.createElement(safe ? 'a' : 'span');
  openBtn.className = 'link-rule-action';
  openBtn.innerHTML = ICON_OPEN_URL;
  if (safe) {
    openBtn.href = rule.url;
    openBtn.target = '_blank';
    openBtn.rel = 'noopener noreferrer';
    openBtn.title = 'Open URL in new tab';
    openBtn.setAttribute('aria-label', 'Open URL in new tab');
  } else {
    openBtn.setAttribute('aria-disabled', 'true');
    openBtn.title = 'Cannot open this URL scheme';
    openBtn.setAttribute('aria-label', 'Cannot open this URL scheme');
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'link-rule-action';
  copyBtn.innerHTML = ICON_COPY;
  copyBtn.title = 'Copy URL';
  copyBtn.setAttribute('aria-label', 'Copy URL');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(rule.url);
      showStatus(linkStatus, '\u2713 URL copied', 'success');
    } catch (e) {
      showStatus(linkStatus, 'Copy failed: ' + e.message, 'error');
    }
  });

  li.appendChild(trigger);
  li.appendChild(arrow);
  li.appendChild(url);
  li.appendChild(openBtn);
  li.appendChild(copyBtn);
  return li;
}


function loadSettings() {
  chrome.storage.local.get(['lingofrog_config'], (data) => {
    const stored = data.lingofrog_config;
    const cfg = Corpus.migrateConfig(stored);

    // If a migration actually translated old field names, persist the
    // new shape so future loads (and any later migration changes)
    // start from the migrated form. Without this, the legacy field
    // lingers in storage indefinitely until the user clicks Save
    // Settings — leaving us re-migrating on every load.
    if (cfg && cfg !== stored) {
      chrome.storage.local.set({ lingofrog_config: cfg });
    }

    if (cfg) {
      $('#set-trigger').value = cfg.triggerAfterChars || 8;
      $('#set-max').value = cfg.maxSuggestions || 5;
      $('#set-enabled').checked = cfg.enabled !== false;
      $('#set-autocomplete').checked = cfg.autoComplete !== false;
      $('#set-autolink').checked = cfg.autoLink !== false;
      $('#set-save-rule-chip').checked = cfg.showSaveRuleChip !== false;
    }
    updateToggleStates();
  });
}

function updateToggleStates() {
  const masterEnabled = $('#set-enabled').checked;
  const rowAutoComplete = $('#row-autocomplete');
  const rowAutoLink = $('#row-autolink');
  const rowSaveRuleChip = $('#row-save-rule-chip');

  rowAutoComplete.classList.toggle('disabled', !masterEnabled);
  rowAutoLink.classList.toggle('disabled', !masterEnabled);
  rowSaveRuleChip.classList.toggle('disabled', !masterEnabled);
  $('#set-autocomplete').disabled = !masterEnabled;
  $('#set-autolink').disabled = !masterEnabled;
  $('#set-save-rule-chip').disabled = !masterEnabled;
}

function showStatus(el, message, type, duration) {
  el.textContent = message;
  el.className = 'status ' + type;
  // Scroll into view in case the status sits below the popup's viewport,
  // which can happen once the body hits Chrome's max popup height.
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  // Errors persist longer than success messages so users have time to
  // read what went wrong before it disappears.
  const ms = duration ?? (type === 'error' ? 7000 : 3000);
  setTimeout(() => { el.className = 'status'; }, ms);
}

// ── Tab Switching ──────────────────────────────────────────

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── Import view ───────────────────────────────────────────
//
// The Import UI no longer lives in the tab bar; it opens from the
// "Import from backup" button in Settings. The top-line header
// stays visible and the Settings tab stays highlighted so the tab
// bar itself is the way back — no dedicated Back button needed.

function openImportView(defaultType) {
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
  document.getElementById('tab-import').classList.add('active');
  // Leave the Settings tab active — this view is a sub-page of Settings.
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === 'settings');
  });
  setImportType(defaultType);
  pasteArea.value = '';
  importStatus.className = 'status';
}

btnImportAll.addEventListener('click', () => openImportView('links'));

// ── Import: Type Toggle ───────────────────────────────────

// Per-type config for hint, placeholder, button label, and empty-
// paste error. Keeps setImportType + submit-handler small.
const IMPORT_TYPES = {
  phrases: {
    label: 'Phrases',
    button: 'Import Phrases',
    empty: 'Paste some phrases first',
    hint: 'One phrase per line. Casing is preserved on insertion.<br>e.g. <code>Thanks for the quick turnaround</code><br><br>Tip: when you highlight text in Gmail, press <code>⌘ + Shift + P</code> to save it directly or press <code>⌘ + L</code> to insert a link. Search existing links or paste a new one.',
    placeholder: 'Add your phrases here, one per line...\n\nThanks for the quick turnaround\nPlease see the attached document\nThese pretzels are making me thirsty\n\nThen start typing in Gmail to see the magic',
  },
  links: {
    label: 'Links',
    button: 'Import Links',
    empty: 'Paste some link rules first',
    hint: 'One link rule per line: <code>phrase; https://url</code><br>e.g. <code>pricing page; https://example.com/pricing</code>',
    placeholder: 'Add link rules here, one per line...\n\ndocs; https://docs.example.com\nribbit; https://example.com/ribbit\n\nThen type a link\'s text in a Gmail body to auto hyperlink',
  },
  bops: {
    label: 'Bops',
    button: 'Import Bops',
    empty: 'Paste some Bops first',
    hint: 'One Bop per line: <code>source phrase -&gt; follower phrase</code><br>Both phrases must already be saved in your corpus.',
    placeholder: 'Paste Bops here, one per line...\n\nThanks for the quick turnaround -> Let me know if you have any questions',
  },
  utms: {
    label: 'UTM Parameters',
    button: 'Import UTM Rules',
    empty: 'Paste some UTM rules first',
    hint: 'One UTM rule per line: <code>host; key=value; key=value</code><br>e.g. <code>example.com; utm_source=lingofrog; utm_medium=email</code>',
    placeholder: 'Paste UTM rules here, one per line...\n\nexample.com; utm_source=lingofrog; utm_medium=email\ndocs.example.com; utm_source=lingofrog',
  },
};
const OVERFLOW_TYPES = new Set(['bops', 'utms']);

const importOverflowBtn = $('#import-type-overflow');
const importOverflowMenu = $('#import-type-overflow-menu');

function setImportType(type) {
  const cfg = IMPORT_TYPES[type];
  if (!cfg) return;
  importType = type;

  // Primary buttons (Phrases, Links) get active state when picked.
  document.querySelectorAll('.import-type-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });

  // Overflow button stays as a small "⋯" circle. When one of its
  // types is active, it picks up the green active styling and its
  // tooltip reflects the current pick — the type name itself shows
  // through the hint text and Import button label below.
  if (OVERFLOW_TYPES.has(type)) {
    importOverflowBtn.classList.add('active');
    importOverflowBtn.title = cfg.label + ' (click to change)';
  } else {
    importOverflowBtn.classList.remove('active');
    importOverflowBtn.title = 'More types';
  }

  importHint.innerHTML = cfg.hint;
  pasteArea.placeholder = cfg.placeholder;
  btnImport.textContent = cfg.button;
  closeImportOverflow();
}

function openImportOverflow() { importOverflowMenu.classList.add('open'); }
function closeImportOverflow() { importOverflowMenu.classList.remove('open'); }

// Primary type buttons.
document.querySelectorAll('.import-type-btn').forEach((btn) => {
  btn.addEventListener('click', () => setImportType(btn.dataset.type));
});

// Overflow button toggles the menu.
importOverflowBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (importOverflowMenu.classList.contains('open')) closeImportOverflow();
  else openImportOverflow();
});

// Menu items select the corresponding type (and close the menu).
document.querySelectorAll('.import-type-overflow-item').forEach((item) => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    setImportType(item.dataset.type);
  });
});

// Click anywhere else dismisses the menu.
document.addEventListener('click', (e) => {
  if (!importOverflowMenu.classList.contains('open')) return;
  if (importOverflowBtn.contains(e.target) || importOverflowMenu.contains(e.target)) return;
  closeImportOverflow();
});

// ── Import: Submit ────────────────────────────────────────

btnImport.addEventListener('click', async () => {
  const cfg = IMPORT_TYPES[importType];
  const text = pasteArea.value.trim();
  if (!text) {
    showStatus(importStatus, cfg.empty, 'error');
    return;
  }

  btnImport.disabled = true;
  btnImport.textContent = 'Importing\u2026';

  try {
    if (importType === 'phrases') {
      const added = await corpus.importPhrases(text, 'paste');
      showStatus(importStatus, `\u2713 ${added} new phrase${added === 1 ? '' : 's'} added`, 'success');
      updatePhraseList();
    } else if (importType === 'links') {
      const added = await corpus.linkRules.importBulk(text);
      showStatus(importStatus, `\u2713 ${added} link rule${added === 1 ? '' : 's'} imported`, 'success');
      updateLinkRuleList();
    } else if (importType === 'bops') {
      const { added, skipped } = await corpus.importBops(text);
      const skipNote = skipped ? ` (${skipped} skipped)` : '';
      showStatus(importStatus, `\u2713 ${added} Bop${added === 1 ? '' : 's'} imported${skipNote}`, 'success');
      updatePhraseList();
    } else if (importType === 'utms') {
      const { added, skipped } = await corpus.utmRules.importBulk(text);
      const skipNote = skipped ? ` (${skipped} skipped)` : '';
      showStatus(importStatus, `\u2713 ${added} UTM rule${added === 1 ? '' : 's'} imported${skipNote}`, 'success');
      updateUtmList();
    }
    pasteArea.value = '';
    updateStats();
  } catch (e) {
    showStatus(importStatus, 'Import failed: ' + e.message, 'error');
  }

  btnImport.disabled = false;
  btnImport.textContent = cfg.button;
});

// ── Corpus: Search ────────────────────────────────────────

phraseSearch.addEventListener('input', () => {
  updatePhraseList();
});

// ── Corpus / Links: named actions (wired to ellipsis menus) ─

async function copyPhrasesToClipboard() {
  const text = corpus.exportText();
  if (!text) {
    showStatus(corpusStatus, 'Nothing to copy', 'error');
    return;
  }
  await navigator.clipboard.writeText(text);
  const count = corpus.phrases.size;
  showStatus(corpusStatus, `✓ Copied ${count} phrase${count === 1 ? '' : 's'} to clipboard`, 'success');
}

async function clearAllPhrases() {
  const stats = corpus.getStats();
  if (stats.totalPhrases === 0) return;
  if (!confirm(`Delete all ${stats.totalPhrases} phrases? This cannot be undone.`)) return;
  await corpus.clear();
  updateStats();
  updatePhraseList();
}

async function copyLinksToClipboard() {
  const text = corpus.linkRules.exportText();
  if (!text) {
    showStatus(linkStatus, 'Nothing to copy', 'error');
    return;
  }
  await navigator.clipboard.writeText(text);
  const count = corpus.linkRules.rules.size;
  showStatus(linkStatus, `✓ Copied ${count} link rule${count === 1 ? '' : 's'} to clipboard`, 'success');
}

async function clearAllLinks() {
  const count = corpus.linkRules.rules.size;
  if (count === 0) return;
  if (!confirm(`Delete all ${count} link rules? This cannot be undone.`)) return;
  corpus.linkRules.clear();
  await corpus.linkRules.save();
  updateStats();
  updateLinkRuleList();
}

// ── Links: Search ─────────────────────────────────────────

linkSearch.addEventListener('input', updateLinkRuleList);

// ── Settings: Auto-persist on change ───────────────────────

// Auto-persist on change. Each control writes the full config; the
// popup is single-context so there is no risk of partial-state drift.
// The content-script storage listener picks the new config up in
// open Gmail tabs. No "Save Settings" button: the toggle staying
// in position (or number staying in the field) is the confirmation.

function clampNum(el, fallback) {
  const min = parseInt(el.min);
  const max = parseInt(el.max);
  const n = parseInt(el.value);
  if (Number.isNaN(n)) {
    el.value = fallback;
    return fallback;
  }
  if (!Number.isNaN(min) && n < min) { el.value = min; return min; }
  if (!Number.isNaN(max) && n > max) { el.value = max; return max; }
  return n;
}

function persistConfig() {
  const config = {
    triggerAfterChars: clampNum($('#set-trigger'), 8),
    maxSuggestions: clampNum($('#set-max'), 5),
    enabled: $('#set-enabled').checked,
    autoComplete: $('#set-autocomplete').checked,
    autoLink: $('#set-autolink').checked,
    showSaveRuleChip: $('#set-save-rule-chip').checked,
  };
  chrome.storage.local.set({ lingofrog_config: config });
  corpus.config = { ...corpus.config, ...config };
  updateStats();
}

[
  '#set-enabled',
  '#set-autocomplete',
  '#set-autolink',
  '#set-save-rule-chip',
  '#set-trigger',
  '#set-max',
].forEach((sel) => {
  $(sel).addEventListener('change', persistConfig);
});

// Master toggle additionally re-cascades the enabled state of the
// dependent rows (autocomplete, autolink, chip).
$('#set-enabled').addEventListener('change', updateToggleStates);

// ── Settings: Backup All ──────────────────────────────────

btnExportAll.addEventListener('click', async () => {
  const phrasesText = corpus.exportText();
  const linksText = corpus.linkRules.exportText();
  const utmsText = corpus.utmRules.exportText();
  const bopsText = corpus.exportBops();

  if (!phrasesText && !linksText && !utmsText && !bopsText) {
    showStatus(backupStatus, 'Nothing to copy', 'error');
    return;
  }

  const sections = [];
  if (linksText) sections.push(`# Links\n\n${linksText}`);
  if (phrasesText) sections.push(`# Phrases\n\n${phrasesText}`);
  if (utmsText) sections.push(`# UTM Parameters\n\n${utmsText}`);
  if (bopsText) sections.push(`# Bops\n\n${bopsText}`);

  await navigator.clipboard.writeText(sections.join('\n\n'));

  const phraseCount = corpus.phrases.size;
  const linkCount = corpus.linkRules.rules.size;
  const utmCount = [...corpus.utmRules.rules.values()].filter((p) => p && p.length).length;
  const bopCount = bopsText ? bopsText.split('\n').length : 0;
  const parts = [
    `${linkCount} link rule${linkCount === 1 ? '' : 's'}`,
    `${phraseCount} phrase${phraseCount === 1 ? '' : 's'}`,
    `${utmCount} UTM rule${utmCount === 1 ? '' : 's'}`,
    `${bopCount} bop${bopCount === 1 ? '' : 's'}`,
  ];
  showStatus(backupStatus, `✓ Copied ${parts.join(', ')}`, 'success');
});

// ── Links: UTM Parameters ─────────────────────────────────

function updateUtmList() {
  utmList.innerHTML = '';

  const rules = corpus.utmRules.getAll();

  if (utmDraftRoot) {
    utmList.appendChild(renderUtmDraft());
  }

  if (rules.length === 0 && !utmDraftRoot) {
    const empty = document.createElement('div');
    empty.className = 'utm-empty';
    empty.textContent = 'No UTM rules yet. Add one above to apply parameters automatically.';
    utmList.appendChild(empty);
    return;
  }

  for (const { host, params } of rules) {
    utmList.appendChild(renderUtmRow(host, params));
  }
}

function renderUtmRow(host, params) {
  const li = document.createElement('li');
  li.className = 'utm-item';
  li.dataset.host = host;

  const isExpanded = utmExpandedHost === host;
  if (isExpanded) li.classList.add('expanded');

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'utm-item-header';

  const caret = document.createElement('span');
  caret.className = 'utm-item-caret';
  caret.textContent = '▶';

  const hostEl = document.createElement('span');
  hostEl.className = 'utm-item-host';
  hostEl.textContent = host;

  const count = document.createElement('span');
  count.className = 'utm-item-count';
  count.textContent = `${params.length} param${params.length === 1 ? '' : 's'}`;

  const del = document.createElement('button');
  del.className = 'utm-item-delete';
  del.textContent = '×';
  del.title = 'Remove base url';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Remove UTM rule for "${host}"?`)) return;
    corpus.utmRules.removeHost(host);
    await corpus.utmRules.save();
    if (utmExpandedHost === host) utmExpandedHost = null;
    updateUtmList();
    showStatus(utmStatus, `✓ Removed ${host}`, 'success');
  });

  header.appendChild(caret);
  header.appendChild(hostEl);
  header.appendChild(count);
  header.appendChild(del);

  header.addEventListener('click', () => {
    if (isExpanded) {
      utmExpandedHost = null;
    } else {
      utmExpandedHost = host;
    }
    updateUtmList();
  });

  li.appendChild(header);

  // ── Body (only rendered when expanded) ──
  if (isExpanded) {
    li.appendChild(renderUtmBody({
      params,
      onSave: async (newParams) => {
        corpus.utmRules.setForHost(host, newParams);
        await corpus.utmRules.save();
        updateUtmList();
        showStatus(utmStatus, `✓ Saved ${host}`, 'success');
      },
    }));
  }

  return li;
}

function renderUtmDraft() {
  const li = document.createElement('li');
  li.className = 'utm-item expanded';
  li.dataset.host = '__draft__';

  // ── Header with host input ──
  const header = document.createElement('div');
  header.className = 'utm-item-header';

  const caret = document.createElement('span');
  caret.className = 'utm-item-caret';
  caret.textContent = '▶';

  const hostInput = document.createElement('input');
  hostInput.className = 'utm-item-host-input';
  hostInput.placeholder = 'example.com';
  hostInput.value = utmDraftRoot.host || '';
  hostInput.autocomplete = 'off';
  hostInput.spellcheck = false;
  hostInput.addEventListener('input', () => {
    utmDraftRoot.host = hostInput.value;
  });

  const cancel = document.createElement('button');
  cancel.className = 'utm-item-delete';
  cancel.textContent = '×';
  cancel.title = 'Cancel';
  cancel.addEventListener('click', () => {
    utmDraftRoot = null;
    updateUtmList();
  });

  header.appendChild(caret);
  header.appendChild(hostInput);
  header.appendChild(cancel);
  li.appendChild(header);

  // ── Body ──
  li.appendChild(renderUtmBody({
    params: utmDraftRoot.params,
    saveLabel: 'Add base url',
    onSave: async (newParams) => {
      const host = (utmDraftRoot.host || '').toLowerCase().trim();
      if (!HOST_RE.test(host)) {
        showStatus(utmStatus, 'Enter a valid host like example.com', 'error');
        hostInput.focus();
        return;
      }
      if (corpus.utmRules.rules.has(host)) {
        showStatus(utmStatus, `${host} already exists`, 'error');
        return;
      }
      corpus.utmRules.setForHost(host, newParams);
      await corpus.utmRules.save();
      utmDraftRoot = null;
      utmExpandedHost = host;
      updateUtmList();
      showStatus(utmStatus, `✓ Added ${host}`, 'success');
    },
  }));

  // Focus host input after render
  setTimeout(() => hostInput.focus(), 0);
  return li;
}

/**
 * Renders the editable params body. Owns its own working copy of the
 * params array; calls onSave(newParams) when the user clicks Save.
 */
function renderUtmBody({ params, onSave, saveLabel = 'Save' }) {
  // Working copy. Don't mutate the caller's array until save.
  const working = (params && params.length)
    ? params.map((p) => ({ key: p.key, value: p.value }))
    : [{ key: '', value: '' }];

  const body = document.createElement('div');
  body.className = 'utm-item-body';

  const rowsContainer = document.createElement('div');
  body.appendChild(rowsContainer);

  function rerenderRows() {
    rowsContainer.innerHTML = '';
    working.forEach((param, i) => {
      const row = document.createElement('div');
      row.className = 'utm-param-row';

      const keyInput = document.createElement('input');
      keyInput.className = 'utm-param-key';
      keyInput.placeholder = 'utm_source';
      keyInput.value = param.key;
      keyInput.spellcheck = false;
      keyInput.autocomplete = 'off';
      keyInput.addEventListener('input', () => { working[i].key = keyInput.value; });

      const eq = document.createElement('span');
      eq.className = 'utm-param-eq';
      eq.textContent = '=';

      const valInput = document.createElement('input');
      valInput.className = 'utm-param-value';
      valInput.placeholder = 'value';
      valInput.value = param.value;
      valInput.spellcheck = false;
      valInput.autocomplete = 'off';
      valInput.addEventListener('input', () => { working[i].value = valInput.value; });

      const remove = document.createElement('button');
      remove.className = 'utm-param-remove';
      remove.textContent = '×';
      remove.title = 'Remove parameter';
      remove.addEventListener('click', () => {
        working.splice(i, 1);
        if (working.length === 0) working.push({ key: '', value: '' });
        rerenderRows();
        updateAddVisibility();
      });

      row.appendChild(keyInput);
      row.appendChild(eq);
      row.appendChild(valInput);
      row.appendChild(remove);
      rowsContainer.appendChild(row);
    });
  }

  rerenderRows();

  const actions = document.createElement('div');
  actions.className = 'utm-item-actions';

  const addParam = document.createElement('button');
  addParam.className = 'btn-link';
  addParam.textContent = '+ Add parameter';
  addParam.addEventListener('click', () => {
    if (working.length >= 3) return;
    working.push({ key: '', value: '' });
    rerenderRows();
    updateAddVisibility();
  });

  const save = document.createElement('button');
  save.className = 'btn btn-primary';
  save.textContent = saveLabel;
  save.addEventListener('click', () => {
    const cleaned = working
      .map((p) => ({ key: (p.key || '').trim(), value: (p.value || '').trim() }))
      .filter((p) => p.key && p.value);
    if (cleaned.length === 0) {
      showStatus(utmStatus, 'Add at least one parameter', 'error');
      return;
    }
    onSave(cleaned);
  });

  function updateAddVisibility() {
    addParam.disabled = working.length >= 3;
    addParam.style.visibility = working.length >= 3 ? 'hidden' : 'visible';
  }

  actions.appendChild(addParam);
  actions.appendChild(save);
  body.appendChild(actions);
  updateAddVisibility();

  return body;
}

btnAddUtmRoot.addEventListener('click', () => {
  if (utmDraftRoot) return;
  utmDraftRoot = { host: '', params: [{ key: '', value: '' }] };
  utmExpandedHost = null;
  updateUtmList();
});

// ── UTM view ──────────────────────────────────────────────
//
// Reached from the Links tab's ellipsis menu. The top-line header
// stays visible and the Links tab stays highlighted so the tab
// bar itself is the way back — no dedicated Back button needed.

function openUtmView() {
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
  document.getElementById('tab-utm').classList.add('active');
  // Leave the Links tab active — this view is a sub-page of Links.
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === 'links');
  });
}

// ── Row-level ellipsis menus (Phrases + Links tab toolbars) ─

const ROW_MENU_ACTIONS = {
  phrases: {
    copy: copyPhrasesToClipboard,
    import: () => openImportView('phrases'),
    delete: clearAllPhrases,
  },
  links: {
    utm: openUtmView,
    copy: copyLinksToClipboard,
    import: () => openImportView('links'),
    delete: clearAllLinks,
  },
};

function wireRowOverflow(name) {
  const btn = document.getElementById(name + '-overflow');
  const menu = document.getElementById(name + '-overflow-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close any other open row menu first.
    document.querySelectorAll('.row-overflow-menu.open').forEach((m) => {
      if (m !== menu) m.classList.remove('open');
    });
    document.querySelectorAll('.row-overflow-btn.active').forEach((b) => {
      if (b !== btn) b.classList.remove('active');
    });
    const willOpen = !menu.classList.contains('open');
    menu.classList.toggle('open', willOpen);
    btn.classList.toggle('active', willOpen);
  });

  menu.querySelectorAll('.row-overflow-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.remove('open');
      btn.classList.remove('active');
      const handler = (ROW_MENU_ACTIONS[name] || {})[item.dataset.action];
      if (handler) handler();
    });
  });
}

wireRowOverflow('phrases');
wireRowOverflow('links');

// Click outside dismisses any open row menu.
document.addEventListener('click', (e) => {
  document.querySelectorAll('.row-overflow-menu.open').forEach((menu) => {
    const container = menu.parentElement;
    if (!container || !container.contains(e.target)) {
      menu.classList.remove('open');
      const btn = container && container.querySelector('.row-overflow-btn');
      if (btn) btn.classList.remove('active');
    }
  });
});

// ── Add-mode: inline "morph" forms on Phrases and Links ────
//
// Clicking ＋ swaps the tab's search input into an "Add …" prompt.
// On Links a second URL input drops in below with a ↳ arrow.
// ＋ hides while add mode is up; ✓ (save) and ✕ (cancel) take its
// place. ✓ is enabled once the form is valid. Enter advances /
// saves, Esc cancels.

// ---- Phrases: full-page add/edit form ----

const btnAddPhrase = document.getElementById('btn-add-phrase');
const phraseFormInput = document.getElementById('phrase-form-input');
const phraseFormTitle = document.getElementById('phrase-form-title');
const phraseFormBopsBox = document.getElementById('phrase-form-bops-box');
const phraseFormBopsSearch = document.getElementById('phrase-form-bops-search');
const phraseFormBopsDropdown = document.getElementById('phrase-form-bops-dropdown');
const phraseFormBopsCounter = document.getElementById('phrase-form-bops-counter');
const phraseFormStatus = document.getElementById('phrase-form-status');
const btnPhraseFormSave = document.getElementById('btn-phrase-form-save');
const btnPhraseFormCancel = document.getElementById('btn-phrase-form-cancel');
const btnPhraseFormDelete = document.getElementById('btn-phrase-form-delete');

const BOPS_MAX = (typeof Corpus !== 'undefined' && Corpus.MAX_FOLLOWED_BY) || 3;

// State for the current form session. `originalPhrase` is null in
// add mode, or the phrase being edited otherwise; `workingBops`
// mirrors the corpus's followedBy list but is only committed on
// Save.
let phraseFormOriginal = null;
let workingBops = [];

function openPhraseForm(mode, phrase) {
  phraseFormOriginal = mode === 'edit' ? phrase : null;
  phraseFormInput.value = phrase || '';
  workingBops = phrase ? corpus.getFollowedBy(phrase).slice() : [];
  phraseFormBopsSearch.value = '';
  phraseFormStatus.className = 'status';

  phraseFormTitle.textContent = mode === 'edit' ? 'Edit phrase' : 'New phrase';
  btnPhraseFormDelete.hidden = mode !== 'edit';

  renderPhraseFormBops();
  renderPhraseFormBopsDropdown('');
  updatePhraseFormSaveEnabled();

  // Show the form view; keep the Phrases tab visually active.
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
  document.getElementById('tab-phrase-form').classList.add('active');
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === 'corpus');
  });

  autoGrowPhraseInput();
  phraseFormInput.focus();
  if (mode === 'edit') phraseFormInput.select();
}

// Grow the textarea to fit its content. Manual resize via the drag
// handle keeps working — the next input event will re-fit based on
// content, so if the user dragged it larger and then adds text,
// their extra height is only preserved up to the point where new
// content needs more room.
function autoGrowPhraseInput() {
  // border-y (1px + 1px) since scrollHeight excludes borders and
  // box-sizing: border-box means the assigned height must include
  // them for a stable measurement.
  phraseFormInput.style.height = 'auto';
  phraseFormInput.style.height = (phraseFormInput.scrollHeight + 2) + 'px';
}

function closePhraseForm() {
  // Navigate back to the Phrases list.
  document.querySelector('.tab[data-tab="corpus"]').click();
}

function updatePhraseFormSaveEnabled() {
  const text = phraseFormInput.value.trim();
  // Disable save if empty, or if we're editing and nothing changed
  // (text unchanged AND same bops list).
  let dirty = true;
  if (phraseFormOriginal !== null) {
    const originalBops = corpus.getFollowedBy(phraseFormOriginal);
    const sameBops =
      originalBops.length === workingBops.length &&
      originalBops.every((b, i) => b === workingBops[i]);
    dirty = text !== phraseFormOriginal || !sameBops;
  }
  btnPhraseFormSave.disabled = text.length === 0 || !dirty;
}

function renderPhraseFormBops() {
  // Rebuild chip list before the search input.
  const chips = phraseFormBopsBox.querySelectorAll('.phrase-edit-bop-chip');
  chips.forEach((c) => c.remove());
  workingBops.forEach((phrase) => {
    const chip = document.createElement('span');
    chip.className = 'phrase-edit-bop-chip';
    const text = document.createElement('span');
    text.className = 'phrase-edit-bop-chip-text';
    text.textContent = phrase.length > 30 ? phrase.slice(0, 30) + '…' : phrase;
    text.title = phrase;
    chip.appendChild(text);
    const x = document.createElement('button');
    x.className = 'phrase-edit-bop-chip-x';
    x.textContent = '×';
    x.tabIndex = -1;
    x.title = 'Remove';
    x.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = workingBops.indexOf(phrase);
      if (idx >= 0) workingBops.splice(idx, 1);
      renderPhraseFormBops();
      renderPhraseFormBopsDropdown(phraseFormBopsSearch.value);
      updatePhraseFormSaveEnabled();
    });
    chip.appendChild(x);
    phraseFormBopsBox.insertBefore(chip, phraseFormBopsSearch);
  });

  // Only show the counter when the max is > 1 — a "1 / 1" reads
  // as noise when there's only ever one bop slot.
  if (BOPS_MAX > 1) {
    phraseFormBopsCounter.hidden = false;
    phraseFormBopsCounter.textContent = `${workingBops.length} / ${BOPS_MAX}`;
  } else {
    phraseFormBopsCounter.hidden = true;
  }

  if (workingBops.length >= BOPS_MAX) {
    phraseFormBopsSearch.style.display = 'none';
    phraseFormBopsDropdown.hidden = true;
  } else {
    phraseFormBopsSearch.style.display = '';
    phraseFormBopsSearch.placeholder = workingBops.length
      ? 'Add another…'
      : 'Search phrases to add a bop…';
  }
}

function renderPhraseFormBopsDropdown(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q || workingBops.length >= BOPS_MAX) {
    phraseFormBopsDropdown.hidden = true;
    phraseFormBopsDropdown.innerHTML = '';
    return;
  }
  const exclude = new Set([phraseFormOriginal, ...workingBops].filter(Boolean));
  const matches = [];
  for (const [phrase] of corpus.phrases) {
    if (exclude.has(phrase)) continue;
    if (!phrase.toLowerCase().includes(q)) continue;
    matches.push(phrase);
    if (matches.length >= 8) break;
  }
  phraseFormBopsDropdown.innerHTML = '';
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'phrase-form-bops-empty';
    empty.textContent = corpus.phrases.size === 0
      ? 'Add a phrase first — bops chain to phrases you\'ve saved.'
      : 'No matching phrases';
    phraseFormBopsDropdown.appendChild(empty);
  } else {
    matches.forEach((phrase) => {
      const item = document.createElement('div');
      item.className = 'phrase-form-bops-item';
      item.textContent = phrase.length > 60 ? phrase.slice(0, 60) + '…' : phrase;
      item.title = phrase;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        addBopToForm(phrase);
      });
      phraseFormBopsDropdown.appendChild(item);
    });
  }
  phraseFormBopsDropdown.hidden = false;
}

function addBopToForm(phrase) {
  if (workingBops.length >= BOPS_MAX) return;
  if (workingBops.includes(phrase)) return;
  workingBops.push(phrase);
  phraseFormBopsSearch.value = '';
  renderPhraseFormBops();
  renderPhraseFormBopsDropdown('');
  updatePhraseFormSaveEnabled();
  phraseFormBopsSearch.focus();
}

async function savePhraseForm() {
  // Collapse any line breaks (from paste or an old browser
  // shortcut) into single spaces — multi-line phrases silently
  // break Gmail autocomplete.
  const text = phraseFormInput.value.replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!text) return;

  let targetPhrase = text;
  let statusMsg;
  if (phraseFormOriginal === null) {
    const result = await corpus.addOrBumpPhrase(text, 'popup');
    const label = text.length > 40 ? text.slice(0, 40) + '…' : text;
    statusMsg = result.added ? `✓ Added "${label}"` : `✓ Bumped "${label}"`;
  } else {
    if (text !== phraseFormOriginal) {
      const ok = await corpus.editPhrase(phraseFormOriginal, text);
      if (!ok) {
        showStatus(phraseFormStatus, 'Could not rename phrase', 'error');
        return;
      }
    }
    statusMsg = '✓ Saved';
  }

  await corpus.setFollowedBy(targetPhrase, workingBops);
  updateStats();
  showStatus(corpusStatus, statusMsg, 'success');
  closePhraseForm();
  updatePhraseList();
}

async function deletePhraseFromForm() {
  if (phraseFormOriginal === null) return;
  if (!confirm(`Delete "${phraseFormOriginal}"? This cannot be undone.`)) return;
  await corpus.deletePhrase(phraseFormOriginal);
  updateStats();
  showStatus(corpusStatus, '✓ Deleted', 'success');
  closePhraseForm();
  updatePhraseList();
}

btnAddPhrase.addEventListener('click', () => openPhraseForm('add'));
btnPhraseFormCancel.addEventListener('click', closePhraseForm);
btnPhraseFormSave.addEventListener('click', savePhraseForm);
btnPhraseFormDelete.addEventListener('click', deletePhraseFromForm);

phraseFormInput.addEventListener('input', () => {
  updatePhraseFormSaveEnabled();
  autoGrowPhraseInput();
});
phraseFormInput.addEventListener('keydown', (e) => {
  // Textarea is here for visual wrapping only — line breaks in a
  // phrase would silently break Gmail autocomplete. Enter flags a
  // warning instead of inserting a newline (users save via the ✓
  // button); Esc cancels.
  if (e.key === 'Enter') {
    e.preventDefault();
    showStatus(phraseFormStatus, 'Line breaks are not supported', 'error');
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePhraseForm();
  }
});

phraseFormBopsSearch.addEventListener('input', () =>
  renderPhraseFormBopsDropdown(phraseFormBopsSearch.value));
phraseFormBopsSearch.addEventListener('focus', () =>
  renderPhraseFormBopsDropdown(phraseFormBopsSearch.value));
phraseFormBopsSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const firstItem = phraseFormBopsDropdown.querySelector('.phrase-form-bops-item');
    if (firstItem) firstItem.dispatchEvent(new MouseEvent('mousedown'));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (phraseFormBopsSearch.value) {
      phraseFormBopsSearch.value = '';
      renderPhraseFormBopsDropdown('');
    } else {
      closePhraseForm();
    }
  }
});

// ---- Links: add / edit sub-view ----

const btnAddLink = document.getElementById('btn-add-link');
const linkFormTitle = document.getElementById('link-form-title');
const linkFormTrigger = document.getElementById('link-form-trigger');
const linkFormUrl = document.getElementById('link-form-url');
const btnLinkFormCancel = document.getElementById('btn-link-form-cancel');
const btnLinkFormSave = document.getElementById('btn-link-form-save');
const btnLinkFormDelete = document.getElementById('btn-link-form-delete');
const linkFormStatus = document.getElementById('link-form-status');

// Normalize what the user typed into the URL field: allow schemeless
// input ("example.com/foo" → "https://example.com/foo"), preserve
// mailto:/tel:, reject dangerous schemes and hostnames that aren't
// actual domains. Returns null when the input can't be salvaged.
function normalizeAddedUrl(raw) {
  // Strip all whitespace, not just leading/trailing — the URL field
  // is now a wrapping textarea, so pasted URLs may carry embedded
  // newlines that URL() would otherwise reject.
  const t = (raw || '').replace(/\s+/g, '');
  if (!t) return null;
  if (/^(javascript|data|vbscript|file):/i.test(t)) return null;
  if (/^(mailto|tel):/i.test(t)) return t;
  const candidate = /^https?:\/\//i.test(t) ? t : 'https://' + t;
  try {
    const u = new URL(candidate);
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

// Null in add mode, or the trigger key being edited otherwise.
let linkFormOriginal = null;

function openLinkForm(mode, trigger) {
  linkFormOriginal = mode === 'edit' ? trigger : null;

  if (mode === 'edit') {
    const data = corpus.linkRules.rules.get(trigger);
    // Prefill with the trigger key (lowercased) rather than the stored
    // label. Every display surface — this row, the Gmail link-prompt,
    // the link-search overlay — already shows the key, so mirroring
    // that here keeps the "matching is case-insensitive" mental model
    // intact: a "My Calendly" saved by an older version won't come
    // back as "My Calendly" in the form and read as case-sensitive.
    linkFormTrigger.value = trigger;
    linkFormUrl.value = data ? data.url : '';
  } else {
    linkFormTrigger.value = '';
    linkFormUrl.value = '';
  }
  linkFormStatus.className = 'status';
  linkFormTitle.textContent = mode === 'edit' ? 'Edit link' : 'New link';
  btnLinkFormDelete.hidden = mode !== 'edit';

  updateLinkFormSaveEnabled();

  document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
  document.getElementById('tab-link-form').classList.add('active');
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === 'links');
  });

  autoGrowLinkFormUrl();
  linkFormTrigger.focus();
  if (mode === 'edit') linkFormTrigger.select();
}

function closeLinkForm() {
  document.querySelector('.tab[data-tab="links"]').click();
}

// Grow the URL textarea to fit its content (mirrors
// autoGrowPhraseInput). The +2 accounts for the 1px top and bottom
// borders that scrollHeight excludes but border-box height must
// include.
function autoGrowLinkFormUrl() {
  linkFormUrl.style.height = 'auto';
  linkFormUrl.style.height = (linkFormUrl.scrollHeight + 2) + 'px';
}

function updateLinkFormSaveEnabled() {
  const text = linkFormTrigger.value.trim();
  const urlOk = normalizeAddedUrl(linkFormUrl.value) !== null;
  btnLinkFormSave.disabled = !(text.length > 0 && urlOk);
}

async function saveLinkForm() {
  const text = linkFormTrigger.value.trim();
  const url = normalizeAddedUrl(linkFormUrl.value);
  if (!text || !url) return;

  try {
    if (linkFormOriginal === null) {
      const newKey = text.toLowerCase();
      if (corpus.linkRules.rules.has(newKey)) {
        showStatus(linkFormStatus, 'A rule already exists for that trigger', 'error');
        return;
      }
      corpus.linkRules.addRule(text, url);
    } else {
      corpus.linkRules.updateRule(linkFormOriginal, { trigger: text, url });
    }
    await corpus.linkRules.save();
  } catch (e) {
    showStatus(linkFormStatus, e.message, 'error');
    return;
  }

  updateStats();
  const label = text.length > 40 ? text.slice(0, 40) + '…' : text;
  showStatus(linkStatus, `✓ Saved "${label}"`, 'success');
  closeLinkForm();
  updateLinkRuleList();
}

async function deleteLinkFromForm() {
  if (linkFormOriginal === null) return;
  if (!confirm(`Delete "${linkFormOriginal}"? This cannot be undone.`)) return;
  corpus.linkRules.removeRule(linkFormOriginal);
  await corpus.linkRules.save();
  updateStats();
  showStatus(linkStatus, '✓ Deleted', 'success');
  closeLinkForm();
  updateLinkRuleList();
}

btnAddLink.addEventListener('click', () => openLinkForm('add'));
btnLinkFormCancel.addEventListener('click', closeLinkForm);
btnLinkFormSave.addEventListener('click', saveLinkForm);
btnLinkFormDelete.addEventListener('click', deleteLinkFromForm);

linkFormTrigger.addEventListener('input', updateLinkFormSaveEnabled);
linkFormUrl.addEventListener('input', () => {
  updateLinkFormSaveEnabled();
  autoGrowLinkFormUrl();
});

for (const el of [linkFormTrigger, linkFormUrl]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (el === linkFormTrigger) {
        linkFormUrl.focus();
      } else if (!btnLinkFormSave.disabled) {
        saveLinkForm();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeLinkForm();
    }
  });
}

// ── Start ──────────────────────────────────────────────────

init();
