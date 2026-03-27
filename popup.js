/**
 * popup.js — GhostType popup logic.
 */

const corpus = new Corpus();

const $ = (sel) => document.querySelector(sel);
const statPhrases = $('#stat-phrases');
const statLinks = $('#stat-links');
const statActive = $('#stat-active');
const pasteArea = $('#paste-area');
const btnImport = $('#btn-import');
const importStatus = $('#import-status');
const phraseList = $('#phrase-list');
const btnClear = $('#btn-clear');
const fileDrop = $('#file-drop');
const fileInput = $('#file-input');
const btnSaveSettings = $('#btn-save-settings');
const settingsStatus = $('#settings-status');
const linkTriggerInput = $('#link-trigger');
const linkUrlInput = $('#link-url');
const btnAddLink = $('#btn-add-link');
const linkStatus = $('#link-status');
const linkRuleList = $('#link-rule-list');
const phraseSearch = $('#phrase-search');
const corpusStatus = $('#corpus-status');
const btnExportPhrases = $('#btn-export-phrases');
const btnExportLinks = $('#btn-export-links');
const linkBulkArea = $('#link-bulk-area');
const btnBulkImportLinks = $('#btn-bulk-import-links');
const linkBulkStatus = $('#link-bulk-status');

// ── Initialize ─────────────────────────────────────────────

async function init() {
  await corpus.load();
  updateStats();
  updatePhraseList();
  updateLinkRuleList();
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
    const msg = filter ? 'No phrases match your search.' : 'No phrases yet. Add some in the Phrases tab.';
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
  const rules = corpus.linkRules.getAll();
  linkRuleList.innerHTML = '';

  if (rules.length === 0) {
    linkRuleList.innerHTML = '<li class="link-empty">No link rules yet. Add one above.</li>';
    return;
  }

  for (const rule of rules) {
    const li = document.createElement('li');
    li.className = 'link-rule-item';

    const trigger = document.createElement('span');
    trigger.className = 'link-rule-trigger';
    trigger.textContent = rule.trigger;
    trigger.title = rule.trigger;

    const arrow = document.createElement('span');
    arrow.className = 'link-rule-arrow';
    arrow.textContent = '→';

    const url = document.createElement('span');
    url.className = 'link-rule-url';
    url.textContent = rule.url;
    url.title = rule.url;

    const del = document.createElement('button');
    del.className = 'link-rule-delete';
    del.textContent = '×';
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
    linkRuleList.appendChild(li);
  }
}

function loadSettings() {
  chrome.storage.local.get(['ghosttype_config'], (data) => {
    if (data.ghosttype_config) {
      $('#set-trigger').value = data.ghosttype_config.triggerAfterChars || 8;
      $('#set-max').value = data.ghosttype_config.maxSuggestions || 5;
      $('#set-enabled').checked = data.ghosttype_config.enabled !== false;
      $('#set-autocomplete').checked = data.ghosttype_config.autoComplete !== false;
      $('#set-autolink').checked = data.ghosttype_config.autoLink !== false;
    }
    updateToggleStates();
  });
}

function updateToggleStates() {
  const masterEnabled = $('#set-enabled').checked;
  const rowAutoComplete = $('#row-autocomplete');
  const rowAutoLink = $('#row-autolink');

  rowAutoComplete.classList.toggle('disabled', !masterEnabled);
  rowAutoLink.classList.toggle('disabled', !masterEnabled);
  $('#set-autocomplete').disabled = !masterEnabled;
  $('#set-autolink').disabled = !masterEnabled;
}

function showStatus(el, message, type) {
  el.textContent = message;
  el.className = 'status ' + type;
  setTimeout(() => { el.className = 'status'; }, 3000);
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

// ── Import: Paste ──────────────────────────────────────────

btnImport.addEventListener('click', async () => {
  const text = pasteArea.value.trim();
  if (!text) {
    showStatus(importStatus, 'Paste some phrases first', 'error');
    return;
  }

  btnImport.disabled = true;
  btnImport.textContent = 'Importing…';

  try {
    const added = await corpus.importPhrases(text, 'paste');
    showStatus(importStatus, `✓ ${added} new phrases added`, 'success');
    pasteArea.value = '';
    updateStats();
    updatePhraseList();
  } catch (e) {
    showStatus(importStatus, 'Import failed: ' + e.message, 'error');
  }

  btnImport.disabled = false;
  btnImport.textContent = 'Import Phrases';
});

// ── Import: File Drop ──────────────────────────────────────

fileDrop.addEventListener('click', () => fileInput.click());

fileDrop.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileDrop.classList.add('dragover');
});

fileDrop.addEventListener('dragleave', () => {
  fileDrop.classList.remove('dragover');
});

fileDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDrop.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', () => {
  handleFiles(fileInput.files);
  fileInput.value = '';
});

async function handleFiles(files) {
  let totalAdded = 0;

  for (const file of files) {
    try {
      const text = await file.text();
      const added = await corpus.importPhrases(text, file.name);
      totalAdded += added;
    } catch (e) {
      console.error('Failed to import', file.name, e);
    }
  }

  showStatus(importStatus, `✓ ${totalAdded} new phrases from ${files.length} file(s)`, 'success');
  updateStats();
  updatePhraseList();
}

// ── Link Rules ────────────────────────────────────────────

btnAddLink.addEventListener('click', async () => {
  const trigger = linkTriggerInput.value.trim();
  const url = linkUrlInput.value.trim();

  if (!trigger) {
    showStatus(linkStatus, 'Enter a trigger phrase', 'error');
    return;
  }
  if (!url) {
    showStatus(linkStatus, 'Enter a URL', 'error');
    return;
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    showStatus(linkStatus, 'URL must start with http:// or https://', 'error');
    return;
  }

  corpus.linkRules.addRule(trigger, url);
  await corpus.linkRules.save();

  linkTriggerInput.value = '';
  linkUrlInput.value = '';

  showStatus(linkStatus, `✓ Link rule added for "${trigger}"`, 'success');
  updateLinkRuleList();
  updateStats();
});

linkTriggerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); linkUrlInput.focus(); }
});

linkUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); btnAddLink.click(); }
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

// ── Settings: Save ─────────────────────────────────────────

btnSaveSettings.addEventListener('click', () => {
  const config = {
    triggerAfterChars: parseInt($('#set-trigger').value) || 8,
    maxSuggestions: parseInt($('#set-max').value) || 5,
    enabled: $('#set-enabled').checked,
    autoComplete: $('#set-autocomplete').checked,
    autoLink: $('#set-autolink').checked,
  };

  chrome.storage.local.set({ ghosttype_config: config }, () => {
    corpus.config = { ...corpus.config, ...config };
    showStatus(settingsStatus, '✓ Settings saved', 'success');
    updateStats();
  });
});

$('#set-enabled').addEventListener('change', updateToggleStates);

// ── Corpus: Search ────────────────────────────────────────

phraseSearch.addEventListener('input', () => {
  updatePhraseList();
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

// ── Links: Bulk Import ────────────────────────────────────

btnBulkImportLinks.addEventListener('click', async () => {
  const text = linkBulkArea.value.trim();
  if (!text) {
    showStatus(linkBulkStatus, 'Paste some link rules first', 'error');
    return;
  }

  try {
    const added = await corpus.linkRules.importBulk(text);
    showStatus(linkBulkStatus, `\u2713 ${added} link rule${added === 1 ? '' : 's'} imported`, 'success');
    linkBulkArea.value = '';
    updateLinkRuleList();
    updateStats();
  } catch (e) {
    showStatus(linkBulkStatus, 'Import failed: ' + e.message, 'error');
  }
});

// ── Start ──────────────────────────────────────────────────

init();