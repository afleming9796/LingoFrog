/**
 * trie.js — Prefix trie, corpus manager, and link rules for LingoFrog.
 *
 * Exact prefix matching only. Case-insensitive matching,
 * case-preserving insertion. Score = frequency × recencyBoost.
 */

class TrieNode {
  constructor() {
    this.children = {};
    this.phrases = [];
  }
}

class PhraseTrie {
  constructor() {
    this.root = new TrieNode();
  }

  /**
   * Insert a phrase into the trie.
   * Keys are lowercase for case-insensitive matching.
   * `original` preserves the uploaded casing.
   * Only indexes from the first word — exact prefix matching only.
   */
  insert(phrase, original, score = 1.0) {
    const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;

    let node = this.root;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (!node.children[word]) {
        node.children[word] = new TrieNode();
      }
      node = node.children[word];
      node.phrases.push({ full: phrase, original, score });
    }
  }

  search(prefix, maxResults = 5) {
    const words = prefix.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    let node = this.root;

    for (let i = 0; i < words.length - 1; i++) {
      if (node.children[words[i]]) {
        node = node.children[words[i]];
      } else {
        return [];
      }
    }

    const partial = words[words.length - 1];
    const matchingNodes = [];

    for (const [key, child] of Object.entries(node.children)) {
      if (key.startsWith(partial)) {
        matchingNodes.push(child);
      }
    }

    const results = [];
    const seen = new Set();

    for (const mnode of matchingNodes) {
      this._collectPhrases(mnode, results, seen, 4);
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  _collectPhrases(node, results, seen, maxDepth) {
    if (maxDepth <= 0) return;

    for (const item of node.phrases) {
      if (!seen.has(item.original)) {
        seen.add(item.original);
        results.push(item);
      }
    }

    for (const child of Object.values(node.children)) {
      this._collectPhrases(child, results, seen, maxDepth - 1);
    }
  }

  clear() {
    this.root = new TrieNode();
  }
}


// ── Link Rules ────────────────────────────────────────────────

class LinkRules {
  constructor() {
    this.rules = new Map();
  }

  async load() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['typeless_link_rules'], (data) => {
        if (data.typeless_link_rules) {
          this.rules = new Map(Object.entries(data.typeless_link_rules));
        }
        resolve();
      });
    });
  }

  async save() {
    const obj = Object.fromEntries(this.rules);
    return new Promise((resolve) => {
      chrome.storage.local.set({ typeless_link_rules: obj }, resolve);
    });
  }

  addRule(phrase, url, label = null) {
    this.rules.set(phrase.toLowerCase().trim(), {
      url: url.trim(),
      label: label || phrase.trim(),
    });
  }

  removeRule(phrase) {
    this.rules.delete(phrase.toLowerCase().trim());
  }

  getAll() {
    return [...this.rules.entries()].map(([trigger, data]) => ({
      trigger,
      url: data.url,
      label: data.label,
    }));
  }

  /**
   * Scan text for trigger phrases (case-insensitive).
   * Returns array of { start, end, url, label, trigger }.
   */
  findLinks(text) {
    const lower = text.toLowerCase();
    const matches = [];

    for (const [trigger, data] of this.rules) {
      let searchFrom = 0;
      while (true) {
        const idx = lower.indexOf(trigger, searchFrom);
        if (idx === -1) break;

        const before = idx === 0 || /[\s.,;:!?()\[\]{}]/.test(lower[idx - 1]);
        const after = idx + trigger.length >= lower.length ||
          /[\s.,;:!?()\[\]{}]/.test(lower[idx + trigger.length]);

        if (before && after) {
          matches.push({
            start: idx,
            end: idx + trigger.length,
            url: data.url,
            label: data.label,
            trigger,
          });
        }
        searchFrom = idx + 1;
      }
    }

    matches.sort((a, b) => a.start - b.start);
    const resolved = [];
    let lastEnd = 0;
    for (const m of matches) {
      if (m.start >= lastEnd) {
        resolved.push(m);
        lastEnd = m.end;
      }
    }

    return resolved;
  }

  exportText() {
    return this.getAll().map((r) => `${r.trigger}; ${r.url}`).join('\n');
  }

  async importBulk(text) {
    const lines = text.split('\n');
    let added = 0;
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      const sepIdx = line.indexOf(';');
      if (sepIdx === -1) continue;
      const phrase = line.slice(0, sepIdx).trim();
      const url = line.slice(sepIdx + 1).trim();
      if (!phrase || !url) continue;
      this.addRule(phrase, url);
      added++;
    }
    await this.save();
    return added;
  }

  clear() {
    this.rules.clear();
  }
}


// ── Corpus ────────────────────────────────────────────────────

class Corpus {
  constructor() {
    this.trie = new PhraseTrie();
    this.phrases = new Map(); // original phrase -> { frequency, source, importedAt, lastUsed }
    this.linkRules = new LinkRules();
    this.config = {
      maxSuggestions: 5,
      triggerAfterChars: 8,
      enabled: true,
      autoComplete: true,
      autoLink: true,
    };
  }

  async load() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['typeless_phrases', 'typeless_config'], (data) => {
        if (data.typeless_config) {
          Object.assign(this.config, data.typeless_config);
        }

        if (data.typeless_phrases) {
          this.phrases = new Map(Object.entries(data.typeless_phrases));
        }

        this._rebuildTrie();
        this.linkRules.load().then(resolve);
      });
    });
  }

  async save() {
    const obj = Object.fromEntries(this.phrases);
    return new Promise((resolve) => {
      chrome.storage.local.set({ typeless_phrases: obj }, resolve);
    });
  }

  /**
   * Score = frequency × recencyBoost
   *
   *   recencyBoost:
   *     < 7 days  → ×1.5
   *     < 30 days → ×1.2
   *     older     → ×1.0
   */
  _computeScore(phrase, data) {
    let recencyBoost = 1.0;
    const now = Date.now();
    const lastActive = data.lastUsed || data.importedAt || 0;
    const daysSince = (now - lastActive) / (1000 * 60 * 60 * 24);

    if (daysSince < 7) {
      recencyBoost = 1.5;
    } else if (daysSince < 30) {
      recencyBoost = 1.2;
    }

    return data.frequency * recencyBoost;
  }

  /**
   * Import phrases — one per line. No sentence extraction.
   * Each non-empty line is stored as-is, preserving original casing.
   */
  async importPhrases(text, source = 'import') {
    const lines = text.split('\n');
    let added = 0;
    const now = Date.now();

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      // Normalize smart quotes to straight quotes
      line = line.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

      if (this.phrases.has(line)) {
        const entry = this.phrases.get(line);
        entry.frequency += 1;
        entry.lastUsed = now;
        this.phrases.set(line, entry);
      } else {
        this.phrases.set(line, {
          frequency: 1,
          source,
          importedAt: now,
          lastUsed: now,
        });
        added++;
      }
    }

    this._rebuildTrie();
    await this.save();
    return added;
  }

  async recordUsage(phrase) {
    // Find by case-insensitive match, update the original entry
    const lower = phrase.toLowerCase();
    for (const [key, data] of this.phrases) {
      if (key.toLowerCase() === lower) {
        data.frequency += 0.5;
        data.lastUsed = Date.now();
        this.phrases.set(key, data);
        break;
      }
    }
    await this.save();
  }

  /**
   * Get completions for typed text.
   * Exact prefix matching only — typed text must match the beginning of a phrase.
   * Case-insensitive matching; returned completions use original casing.
   */
  getCompletions(typedText) {
    const typed = typedText.trim();
    if (typed.length < this.config.triggerAfterChars) return [];

    const typedLower = typed.toLowerCase();
    const matches = this.trie.search(typedLower, this.config.maxSuggestions);
    const results = [];
    const seen = new Set();

    for (const match of matches) {
      const originalLower = match.original.toLowerCase();

      // Only show completions where typed text matches from the start
      if (!originalLower.startsWith(typedLower)) continue;

      const suffix = match.original.substring(typed.length).trim();
      if (suffix.length > 0 && !seen.has(suffix.toLowerCase())) {
        seen.add(suffix.toLowerCase());
        results.push({
          completion: suffix,
          full: match.original,
          score: match.score,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, this.config.maxSuggestions);
  }

  _rebuildTrie() {
    this.trie.clear();
    for (const [phrase, data] of this.phrases) {
      const score = this._computeScore(phrase, data);
      // phrase is the original-cased key; trie indexes lowercase, stores original
      this.trie.insert(phrase, phrase, score);
    }
  }

  exportText() {
    return [...this.phrases.keys()].join('\n');
  }

  getAllPhrases(filter = '') {
    const result = [];
    const filterLower = filter.toLowerCase();
    for (const [phrase, data] of this.phrases) {
      if (filterLower && !phrase.toLowerCase().includes(filterLower)) continue;
      result.push({
        phrase,
        frequency: data.frequency,
        score: this._computeScore(phrase, data),
      });
    }
    result.sort((a, b) => b.score - a.score);
    return result;
  }

  async deletePhrase(phrase) {
    this.phrases.delete(phrase);
    this._rebuildTrie();
    await this.save();
  }

  async editPhrase(oldPhrase, newPhrase) {
    newPhrase = newPhrase.trim();
    if (!newPhrase || newPhrase === oldPhrase) return false;
    const data = this.phrases.get(oldPhrase);
    if (!data) return false;
    this.phrases.delete(oldPhrase);
    this.phrases.set(newPhrase, data);
    this._rebuildTrie();
    await this.save();
    return true;
  }

  getStats() {
    const sources = {};
    const topPhrases = [];

    for (const [phrase, data] of this.phrases) {
      sources[data.source] = (sources[data.source] || 0) + 1;
      topPhrases.push({
        phrase,
        frequency: data.frequency,
        score: this._computeScore(phrase, data),
      });
    }

    topPhrases.sort((a, b) => b.score - a.score);

    return {
      totalPhrases: this.phrases.size,
      totalLinkRules: this.linkRules.rules.size,
      sources,
      topPhrases: topPhrases.slice(0, 10),
    };
  }

  async clear() {
    this.phrases.clear();
    this.trie.clear();
    await new Promise((resolve) => {
      chrome.storage.local.remove(['typeless_phrases'], resolve);
    });
  }
}