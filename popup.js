/**
 * popup.js — LingoFrog popup logic.
 */

const corpus = new Corpus();

const $ = (sel) => document.querySelector(sel);
const statPhrases = $('#stat-phrases');
const statLinks = $('#stat-links');
const statActive = $('#stat-active');
const pasteArea = $('#paste-area');
const btnImport = $('#btn-import');
const importStatus = $('#import-status');
const importHint = $('#import-hint');
const phraseList = $('#phrase-list');
const btnClear = $('#btn-clear');
const linkStatus = $('#link-status');
const linkRuleList = $('#link-rule-list');
const phraseSearch = $('#phrase-search');
const corpusStatus = $('#corpus-status');
const btnExportPhrases = $('#btn-export-phrases');
const btnExportLinks = $('#btn-export-links');
const btnExportAll = $('#btn-export-all');
const backupStatus = $('#backup-status');
const linkSearch = $('#link-search');
const btnClearLinks = $('#btn-clear-links');
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
}

function updateStats() {
  const stats = corpus.getStats();
  statPhrases.textContent = stats.totalPhrases.toLocaleString();
  statLinks.textContent = stats.totalLinkRules;
  statActive.textContent = '●';
  const isEnabled = corpus.config.enabled !== false;
  statActive.style.color = isEnabled ? (stats.totalPhrases > 0 ? '#a6e3a1' : '#f38ba8') : '#6c7086';
  statActive.title = isEnabled ? 'Enabled' : 'Disabled';
}

function updatePhraseList() {
  const filter = phraseSearch ? phraseSearch.value.trim() : '';
  const allPhrases = corpus.getAllPhrases(filter);
  phraseList.innerHTML = '';

  if (allPhrases.length === 0) {
    const msg = filter ? 'No phrases match your search.' : 'No phrases yet. Add some in the Import tab.';
    phraseList.innerHTML = `<li style="color: #585b70; font-size: 11px; padding: 12px 0;">${msg}</li>`;
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

    text.addEventListener('click', () => {
      startEditPhrase(li, item.phrase, freq);
    });

    const del = document.createElement('button');
    del.className = 'phrase-delete';
    del.textContent = '\u00d7';
    del.title = 'Delete phrase';
    del.addEventListener('click', async () => {
      await corpus.deletePhrase(item.phrase);
      updateStats();
      updatePhraseList();
    });

    li.appendChild(freq);
    li.appendChild(text);
    li.appendChild(del);
    phraseList.appendChild(li);
  }
}

function startEditPhrase(li, originalPhrase, freqEl) {
  li.innerHTML = '';
  li.appendChild(freqEl);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'phrase-edit-input';
  input.value = originalPhrase;

  const save = async () => {
    const newPhrase = input.value.trim();
    if (newPhrase && newPhrase !== originalPhrase) {
      await corpus.editPhrase(originalPhrase, newPhrase);
    }
    updateStats();
    updatePhraseList();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); updatePhraseList(); }
  });
  input.addEventListener('blur', save);

  li.appendChild(input);
  input.focus();
  input.select();
}

function updateLinkRuleList() {
  const filter = linkSearch ? linkSearch.value.trim().toLowerCase() : '';
  const rules = corpus.linkRules.getAll();
  linkRuleList.innerHTML = '';

  const filtered = filter
    ? rules.filter((r) => r.trigger.includes(filter) || r.url.toLowerCase().includes(filter))
    : rules;

  if (filtered.length === 0) {
    const msg = filter ? 'No links match your search.' : 'No link rules yet. Add some in the Import tab.';
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

function renderLinkRuleRow(rule) {
  const li = document.createElement('li');
  li.className = 'link-rule-item';

  // Trigger: clickable <a> that navigates to the raw URL in a new
  // tab. No UTM application \u2014 the popup is an admin/inspection view
  // and applying UTMs here would muddy the analytics signal. Unsafe
  // schemes fall back to a plain span without the navigate
  // affordance.
  let trigger;
  if (isSafeNavigableUrl(rule.url)) {
    trigger = document.createElement('a');
    trigger.href = rule.url;
    trigger.target = '_blank';
    trigger.rel = 'noopener noreferrer';
  } else {
    trigger = document.createElement('span');
  }
  trigger.className = 'link-rule-trigger';
  trigger.textContent = rule.trigger;
  trigger.title = rule.trigger;

  const arrow = document.createElement('span');
  arrow.className = 'link-rule-arrow';
  arrow.textContent = '\u2192';

  const url = document.createElement('span');
  url.className = 'link-rule-url';
  url.textContent = rule.url;
  url.title = rule.url;

  const del = document.createElement('button');
  del.className = 'link-rule-delete';
  del.textContent = '\u00d7';
  del.title = 'Remove rule';
  del.addEventListener('click', async () => {
    corpus.linkRules.removeRule(rule.trigger);
    await corpus.linkRules.save();
    updateLinkRuleList();
    updateStats();
  });

  li.appendChild(trigger);
  li.appendChild(arrow);
  li.appendChild(url);
  li.appendChild(del);
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

// ── Import: Type Toggle ───────────────────────────────────

function setImportType(type) {
  importType = type;
  document.querySelectorAll('.import-type-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });

  if (type === 'phrases') {
    importHint.innerHTML = 'One phrase per line. Casing is preserved on insertion.<br>e.g. <code>Thanks for the quick turnaround</code><br><br>Tip: highlight text in gmail and press <code>⌘ + Shift + P</code> to save it directly.';
    pasteArea.placeholder = 'Paste phrases here, one per line...\n\nThanks for the quick turnaround\nPlease see the attached document\nLet me know if you have any questions';
    btnImport.textContent = 'Import Phrases';
  } else {
    importHint.innerHTML = 'One link rule per line: <code>phrase; https://url</code><br>e.g. <code>pricing page; https://example.com/pricing</code>';
    pasteArea.placeholder = 'Paste link rules here, one per line...\n\npricing page; https://example.com/pricing\ndocs; https://docs.example.com';
    btnImport.textContent = 'Import Links';
  }
}

document.querySelectorAll('.import-type-btn').forEach((btn) => {
  btn.addEventListener('click', () => setImportType(btn.dataset.type));
});

// ── Import: Submit ────────────────────────────────────────

btnImport.addEventListener('click', async () => {
  const text = pasteArea.value.trim();
  if (!text) {
    showStatus(importStatus, importType === 'phrases' ? 'Paste some phrases first' : 'Paste some link rules first', 'error');
    return;
  }

  btnImport.disabled = true;
  btnImport.textContent = 'Importing\u2026';

  try {
    if (importType === 'phrases') {
      const added = await corpus.importPhrases(text, 'paste');
      showStatus(importStatus, `\u2713 ${added} new phrase${added === 1 ? '' : 's'} added`, 'success');
      updatePhraseList();
    } else {
      const added = await corpus.linkRules.importBulk(text);
      showStatus(importStatus, `\u2713 ${added} link rule${added === 1 ? '' : 's'} imported`, 'success');
      updateLinkRuleList();
    }
    pasteArea.value = '';
    updateStats();
  } catch (e) {
    showStatus(importStatus, 'Import failed: ' + e.message, 'error');
  }

  btnImport.disabled = false;
  btnImport.textContent = importType === 'phrases' ? 'Import Phrases' : 'Import Links';
});

// ── Corpus: Search ────────────────────────────────────────

phraseSearch.addEventListener('input', () => {
  updatePhraseList();
});

// ── Corpus: Clear ──────────────────────────────────────────

btnClear.addEventListener('click', async () => {
  const stats = corpus.getStats();
  if (stats.totalPhrases === 0) return;

  if (confirm(`Delete all ${stats.totalPhrases} phrases? This cannot be undone.`)) {
    await corpus.clear();
    updateStats();
    updatePhraseList();
  }
});

// ── Corpus: Export Phrases ────────────────────────────────

btnExportPhrases.addEventListener('click', async () => {
  const text = corpus.exportText();
  if (!text) {
    showStatus(corpusStatus, 'No phrases to export', 'error');
    return;
  }
  await navigator.clipboard.writeText(text);
  const count = corpus.phrases.size;
  showStatus(corpusStatus, `\u2713 Copied ${count} phrase${count === 1 ? '' : 's'} to clipboard`, 'success');
});

// ── Links: Search ─────────────────────────────────────────

linkSearch.addEventListener('input', () => {
  updateLinkRuleList();
});

// ── Links: Export ─────────────────────────────────────────

btnExportLinks.addEventListener('click', async () => {
  const text = corpus.linkRules.exportText();
  if (!text) {
    showStatus(linkStatus, 'No link rules to export', 'error');
    return;
  }
  await navigator.clipboard.writeText(text);
  const count = corpus.linkRules.rules.size;
  showStatus(linkStatus, `\u2713 Copied ${count} link rule${count === 1 ? '' : 's'} to clipboard`, 'success');
});

// ── Links: Clear ──────────────────────────────────────────

btnClearLinks.addEventListener('click', async () => {
  const count = corpus.linkRules.rules.size;
  if (count === 0) return;

  if (confirm(`Delete all ${count} link rules? This cannot be undone.`)) {
    corpus.linkRules.clear();
    await corpus.linkRules.save();
    updateStats();
    updateLinkRuleList();
  }
});

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

  if (!phrasesText && !linksText && !utmsText) {
    showStatus(backupStatus, 'Nothing to copy', 'error');
    return;
  }

  const sections = [];
  if (phrasesText) sections.push(`# Phrases\n\n${phrasesText}`);
  if (linksText) sections.push(`# Links\n\n${linksText}`);
  if (utmsText) sections.push(`# UTM Parameters\n\n${utmsText}`);

  await navigator.clipboard.writeText(sections.join('\n\n'));

  const phraseCount = corpus.phrases.size;
  const linkCount = corpus.linkRules.rules.size;
  const utmCount = [...corpus.utmRules.rules.values()].filter((p) => p && p.length).length;
  const parts = [
    `${phraseCount} phrase${phraseCount === 1 ? '' : 's'}`,
    `${linkCount} link rule${linkCount === 1 ? '' : 's'}`,
    `${utmCount} UTM rule${utmCount === 1 ? '' : 's'}`,
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
  del.title = 'Remove root';
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
    saveLabel: 'Add root',
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

$('#utm-jump-link').addEventListener('click', (e) => {
  e.preventDefault();
  const target = $('#utm-section-anchor');
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ── Start ──────────────────────────────────────────────────

init();
