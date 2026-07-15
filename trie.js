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
      chrome.storage.local.get(['lingofrog_link_rules'], (data) => {
        if (data.lingofrog_link_rules) {
          this.rules = new Map(Object.entries(data.lingofrog_link_rules));
        }
        resolve();
      });
    });
  }

  async save() {
    const obj = Object.fromEntries(this.rules);
    return new Promise((resolve) => {
      chrome.storage.local.set({ lingofrog_link_rules: obj }, resolve);
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


// ── UTM Rules ─────────────────────────────────────────────────
//
// Maps a host (exact match, e.g. "metabase.com") to up to 3 UTM
// parameter entries: [{ key, value }, ...]. When a LingoFrog-applied
// link's host matches an entry, missing UTM keys are appended to its
// URL. Existing keys in the stored URL are NEVER overwritten — the
// configured params act as defaults that fill in gaps.

class UtmRules {
  constructor() {
    this.rules = new Map();
  }

  async load() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['lingofrog_utm_rules'], (data) => {
        if (data.lingofrog_utm_rules) {
          this.rules = new Map(Object.entries(data.lingofrog_utm_rules));
        }
        resolve();
      });
    });
  }

  async save() {
    const obj = Object.fromEntries(this.rules);
    return new Promise((resolve) => {
      chrome.storage.local.set({ lingofrog_utm_rules: obj }, resolve);
    });
  }

  /**
   * Returns the params array for a host (lowercased), or [] if none.
   */
  getForHost(host) {
    if (!host) return [];
    return this.rules.get(host.toLowerCase()) || [];
  }

  /**
   * Replaces the params array for a host. `params` is an array of
   * { key, value } pairs; entries with empty key/value are dropped,
   * and the array is capped at MAX_PARAMS.
   */
  setForHost(host, params) {
    const clean = (params || [])
      .map((p) => ({ key: (p.key || '').trim(), value: (p.value || '').trim() }))
      .filter((p) => p.key && p.value)
      .slice(0, UtmRules.MAX_PARAMS);
    this.rules.set(host.toLowerCase().trim(), clean);
  }

  removeHost(host) {
    this.rules.delete(host.toLowerCase().trim());
  }

  getAll() {
    return [...this.rules.entries()].map(([host, params]) => ({ host, params }));
  }

  clear() {
    this.rules.clear();
  }

  /**
   * Parse a paste of UTM rules (the round-trip counterpart to
   * exportText). Each non-empty, non-comment line is:
   *
   *   host; key=value; key=value; ...
   *
   * Returns { added, skipped }. Silent skips:
   *   - blank lines
   *   - lines starting with '#' (so users can paste a backup
   *     section including its "# UTM Parameters" header)
   *   - lines whose host fails the standard host regex
   *   - lines that resolve to zero valid (non-empty) key/value pairs
   *
   * Duplicate hosts within the paste follow "last wins" via setForHost.
   */
  async importBulk(text) {
    const hostRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
    let added = 0;
    let skipped = 0;
    for (let line of text.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;

      const segments = line.split(';').map((s) => s.trim());
      const host = (segments.shift() || '').toLowerCase();
      if (!hostRe.test(host)) { skipped++; continue; }

      const params = [];
      for (const seg of segments) {
        const eqIdx = seg.indexOf('=');
        if (eqIdx === -1) continue;
        const key = seg.slice(0, eqIdx).trim();
        const value = seg.slice(eqIdx + 1).trim();
        if (!key || !value) continue;
        params.push({ key, value });
      }

      if (!params.length) { skipped++; continue; }
      this.setForHost(host, params);
      added++;
    }
    await this.save();
    return { added, skipped };
  }

  /**
   * Text representation for backup/export. One line per host:
   *   host; key=value; key=value; ...
   * Mirrors the `phrase; url` shape used by LinkRules.exportText().
   * Hosts with no params are skipped.
   */
  exportText() {
    return this.getAll()
      .filter((r) => r.params && r.params.length)
      .map((r) => {
        const pairs = r.params.map((p) => `${p.key}=${p.value}`).join('; ');
        return `${r.host}; ${pairs}`;
      })
      .join('\n');
  }

  /**
   * Apply this rule set to a URL string. Returns the (possibly
   * modified) URL. Non-http(s), invalid, or unmatched URLs are
   * returned unchanged. Existing query keys in the input URL win
   * over configured ones.
   *
   * Host matching is exact, with a `www.`-equivalence fallback:
   * a URL host of `www.example.com` will fall back to a rule keyed
   * on `example.com` (and vice versa) if there's no exact match.
   * An explicit empty params array on the exact host suppresses the
   * fallback — that's how a user signals "no UTMs for this host."
   */
  applyTo(urlString) {
    if (!urlString) return urlString;
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      return urlString;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return urlString;

    const host = url.hostname.toLowerCase();
    let params = this.rules.get(host);
    if (params === undefined) {
      const alt = host.startsWith('www.') ? host.slice(4) : 'www.' + host;
      params = this.rules.get(alt);
    }
    if (!params || !params.length) return urlString;

    let mutated = false;
    for (const { key, value } of params) {
      if (!url.searchParams.has(key)) {
        url.searchParams.set(key, value);
        mutated = true;
      }
    }
    return mutated ? url.toString() : urlString;
  }
}

UtmRules.MAX_PARAMS = 3;


// ── Corpus ────────────────────────────────────────────────────

class Corpus {
  constructor() {
    this.trie = new PhraseTrie();
    this.phrases = new Map(); // original phrase -> { frequency, source, importedAt, lastUsed, followedBy?: string[] }
    this.linkRules = new LinkRules();
    this.utmRules = new UtmRules();
    this.config = {
      maxSuggestions: 5,
      triggerAfterChars: 8,
      enabled: true,
      autoComplete: true,
      autoLink: true,
      showSaveRuleChip: true,
    };
  }

  /**
   * Translate legacy config fields to their current names. Called by
   * popup load + corpus load. Returns a new object — does not mutate
   * the input.
   *
   * The chip is non-destructive, so we opt every existing install
   * into it on migration regardless of their prior auto-save setting.
   * Users who'd previously turned auto-save off may have done so
   * specifically to avoid the silent-save footgun, not because they
   * never want a save affordance at all — feature-discovery wins
   * here. They can toggle off after seeing the chip once.
   */
  static migrateConfig(stored) {
    if (!stored || typeof stored !== 'object') return stored;
    if ('showSaveRuleChip' in stored) return stored;
    if ('autoSaveLinkRules' in stored) {
      const { autoSaveLinkRules, ...rest } = stored;
      return { ...rest, showSaveRuleChip: true };
    }
    return stored;
  }

  async load() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['lingofrog_phrases', 'lingofrog_config'], (data) => {
        if (data.lingofrog_config) {
          Object.assign(this.config, Corpus.migrateConfig(data.lingofrog_config));
        }

        if (data.lingofrog_phrases) {
          this.phrases = new Map(Object.entries(data.lingofrog_phrases));
        }

        this._rebuildTrie();
        Promise.all([this.linkRules.load(), this.utmRules.load()]).then(() => resolve());
      });
    });
  }

  async save() {
    const obj = Object.fromEntries(this.phrases);
    return new Promise((resolve) => {
      chrome.storage.local.set({ lingofrog_phrases: obj }, resolve);
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

  /**
   * Save a single phrase (vs importBulk, which processes a textarea
   * blob). Returns { added, bumped, phrase }:
   *   - added: true when the phrase didn't exist and a new entry was
   *            inserted with frequency 1.
   *   - bumped: true when the phrase already existed; its frequency
   *             is incremented and lastUsed updated.
   *   - phrase: the normalized text actually stored (trim + smart-
   *             quote normalization), useful for the chip status
   *             message.
   *
   * Mirrors the per-line logic in importBulk so behavior is
   * consistent between bulk paste and the ⌘+Shift+P shortcut.
   */
  async addOrBumpPhrase(text, source = 'highlight') {
    const normalized = (text || '')
      .trim()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"');
    if (!normalized) return { added: false, bumped: false, phrase: '' };

    const now = Date.now();
    if (this.phrases.has(normalized)) {
      const entry = this.phrases.get(normalized);
      entry.frequency += 1;
      entry.lastUsed = now;
      this.phrases.set(normalized, entry);
      this._rebuildTrie();
      await this.save();
      return { added: false, bumped: true, phrase: normalized };
    }

    this.phrases.set(normalized, {
      frequency: 1,
      source,
      importedAt: now,
      lastUsed: now,
    });
    this._rebuildTrie();
    await this.save();
    return { added: true, bumped: false, phrase: normalized };
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
    // Did the user already type a trailing space/whitespace? If yes,
    // we strip leading whitespace from the suffix so it doesn't double
    // up. If no, we keep the suffix's leading whitespace so accepting
    // at a word boundary produces "Thanks for reaching..." rather
    // than "Thanks forreaching...".
    const userTypedTrailingSpace = /\s$/.test(typedText);

    const matches = this.trie.search(typedLower, this.config.maxSuggestions);
    const results = [];
    const seen = new Set();

    for (const match of matches) {
      const originalLower = match.original.toLowerCase();

      // Only show completions where typed text matches from the start
      if (!originalLower.startsWith(typedLower)) continue;

      let suffix = match.original.substring(typed.length);
      if (userTypedTrailingSpace) suffix = suffix.replace(/^\s+/, '');
      suffix = suffix.replace(/\s+$/, ''); // defensive trim of trailing whitespace
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
    // Sweep dangling bop references so the followedBy lists of
    // other phrases don't accumulate cruft pointing at a phrase that
    // no longer exists.
    for (const [, data] of this.phrases) {
      if (data.followedBy && data.followedBy.includes(phrase)) {
        data.followedBy = data.followedBy.filter((p) => p !== phrase);
        if (data.followedBy.length === 0) delete data.followedBy;
      }
    }
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
    // Update any followedBy lists that pointed at the old phrase
    // so the bops stay intact through a rename.
    for (const [, other] of this.phrases) {
      if (other.followedBy && other.followedBy.includes(oldPhrase)) {
        other.followedBy = other.followedBy.map((p) => p === oldPhrase ? newPhrase : p);
      }
    }
    this._rebuildTrie();
    await this.save();
    return true;
  }

  /**
   * Set the ordered list of follow-up phrases for `phrase`. References
   * to phrases that don't exist in the corpus are dropped silently;
   * duplicates are removed; the list is capped at MAX_FOLLOWED_BY.
   * Passing an empty array (or omitting the field) clears the bops.
   */
  async setFollowedBy(phrase, follows) {
    const data = this.phrases.get(phrase);
    if (!data) return false;
    const seen = new Set();
    const clean = [];
    for (const p of (follows || [])) {
      const t = (p || '').trim();
      if (!t || t === phrase) continue;          // no self-loops
      if (seen.has(t)) continue;                  // dedupe
      if (!this.phrases.has(t)) continue;         // drop dangling refs
      seen.add(t);
      clean.push(t);
      if (clean.length >= Corpus.MAX_FOLLOWED_BY) break;
    }
    if (clean.length) data.followedBy = clean;
    else delete data.followedBy;
    this.phrases.set(phrase, data);
    await this.save();
    return true;
  }

  getFollowedBy(phrase) {
    const data = this.phrases.get(phrase);
    if (!data || !data.followedBy) return [];
    // Filter dangling references at read time too, in case storage
    // races left them behind.
    return data.followedBy.filter((p) => this.phrases.has(p));
  }

  /**
   * Backup export for bops. One line per (phrase, follower) edge:
   *   <phrase> -> <follower>
   * Lines preserve the order in each phrase's followedBy array so
   * a roundtrip produces identical suggestion ordering.
   */
  exportBops() {
    const lines = [];
    for (const [phrase, data] of this.phrases) {
      if (!data.followedBy || !data.followedBy.length) continue;
      for (const follower of data.followedBy) {
        lines.push(phrase + ' -> ' + follower);
      }
    }
    return lines.join('\n');
  }

  /**
   * Parse a paste of Bop edges (round-trip counterpart to exportBops).
   * Each non-empty, non-comment line is:
   *
   *   <source phrase> -> <follower phrase>
   *
   * Returns { added, skipped }. Silent skips:
   *   - blank lines
   *   - lines starting with '#'
   *   - lines that don't contain a ` -> ` separator
   *   - lines whose source or follower phrase isn't in this.phrases
   *     (drop dangling refs per the issue)
   *
   * Multiple edges for the same source get accumulated in-batch and
   * committed with a single setFollowedBy call at the end — otherwise
   * each subsequent line would replace the previous follower(s).
   */
  async importBops(text) {
    const sepRe = /\s+->\s+/;
    const followers = new Map(); // source -> [follower, ...]
    let skipped = 0;

    for (let line of text.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;

      const m = line.match(sepRe);
      if (!m) { skipped++; continue; }

      const source = line.slice(0, m.index).trim();
      const follower = line.slice(m.index + m[0].length).trim();
      if (!source || !follower) { skipped++; continue; }
      if (!this.phrases.has(source) || !this.phrases.has(follower)) {
        skipped++;
        continue;
      }
      if (!followers.has(source)) followers.set(source, []);
      followers.get(source).push(follower);
    }

    let added = 0;
    for (const [source, list] of followers) {
      await this.setFollowedBy(source, list);
      added += list.length;
    }
    return { added, skipped };
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
      chrome.storage.local.remove(['lingofrog_phrases'], resolve);
    });
  }
}

Corpus.MAX_FOLLOWED_BY = 1;