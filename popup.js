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
const btnSaveSettings = $('#btn-save-settings');
const settingsStatus = $('#settings-status');
const linkStatus = $('#link-status');
const linkRuleList = $('#link-rule-list');
const phraseSearch = $('#phrase-search');
const corpusStatus = $('#corpus-status');
const btnExportPhrases = $('#btn-export-phrases');
const btnExportLinks = $('#btn-export-links');
const linkSearch = $('#link-search');
const btnClearLinks = $('#btn-clear-links');

let importType = 'phrases';

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
    const li = document.createElement('li');
    li.className = 'link-rule-item';

    const trigger = document.createElement('span');
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
    linkRuleList.appendChild(li);
  }
}

function loadSettings() {
  chrome.storage.local.get(['lingofrog_config'], (data) => {
    if (data.lingofrog_config) {
      $('#set-trigger').value = data.lingofrog_config.triggerAfterChars || 8;
      $('#set-max').value = data.lingofrog_config.maxSuggestions || 5;
      $('#set-enabled').checked = data.lingofrog_config.enabled !== false;
      $('#set-autocomplete').checked = data.lingofrog_config.autoComplete !== false;
      $('#set-autolink').checked = data.lingofrog_config.autoLink !== false;
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

// ── Import: Type Toggle ───────────────────────────────────

function setImportType(type) {
  importType = type;
  document.querySelectorAll('.import-type-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });

  if (type === 'phrases') {
    importHint.innerHTML = 'One phrase per line. Casing is preserved on insertion.<br>e.g. <code>Thanks for the quick turnaround</code>';
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

// ── Settings: Save ─────────────────────────────────────────

btnSaveSettings.addEventListener('click', () => {
  const config = {
    triggerAfterChars: parseInt($('#set-trigger').value) || 8,
    maxSuggestions: parseInt($('#set-max').value) || 5,
    enabled: $('#set-enabled').checked,
    autoComplete: $('#set-autocomplete').checked,
    autoLink: $('#set-autolink').checked,
  };

  chrome.storage.local.set({ lingofrog_config: config }, () => {
    corpus.config = { ...corpus.config, ...config };
    showStatus(settingsStatus, '\u2713 Settings saved', 'success');
    updateStats();
  });
});

$('#set-enabled').addEventListener('change', updateToggleStates);

// ── Start ──────────────────────────────────────────────────

init();
