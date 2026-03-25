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
  statActive.style.color = stats.totalPhrases > 0 ? '#a6e3a1' : '#f38ba8';
}

function updatePhraseList() {
  const stats = corpus.getStats();
  phraseList.innerHTML = '';

  if (stats.topPhrases.length === 0) {
    phraseList.innerHTML = '<li style="color: #585b70; font-size: 11px; padding: 12px 0;">No phrases yet. Add some in the Phrases tab.</li>';
    return;
  }

  for (const item of stats.topPhrases) {
    const li = document.createElement('li');
    li.className = 'phrase-item';

    const freq = document.createElement('span');
    freq.className = 'phrase-freq';
    freq.textContent = Math.round(item.score);

    const text = document.createElement('span');
    text.className = 'phrase-text';
    text.textContent = item.phrase.length > 50 ? item.phrase.slice(0, 50) + '…' : item.phrase;
    text.title = item.phrase;

    li.appendChild(freq);
    li.appendChild(text);
    phraseList.appendChild(li);
  }
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
    }
  });
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
  };

  chrome.storage.local.set({ ghosttype_config: config }, () => {
    corpus.config = { ...corpus.config, ...config };
    showStatus(settingsStatus, '✓ Settings saved', 'success');
  });
});

// ── Start ──────────────────────────────────────────────────

init();