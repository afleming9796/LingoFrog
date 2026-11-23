/**
 * trie.js — Prefix trie, corpus manager, and link rules for LingoFrog.
 *
 * Exact prefix matching only. Case-insensitive matching,
 * case-preserving insertion. Phrases and links rank by how often and
 * how recently they've been used (see Usage).
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

  // Adds or replaces a rule. `addedAt` records when it was first added,
  // so a new link isn't mistaken for an unused one.
  addRule(phrase, url, label = null) {
    const key = phrase.toLowerCase().trim();
    const prev = this.rules.get(key);
    this.rules.set(key, {
      ...prev,
      url: url.trim(),
      label: label || phrase.trim(),
      addedAt: (prev && prev.addedAt) || Date.now(),
    });
  }

  removeRule(phrase) {
    this.rules.delete(phrase.toLowerCase().trim());
  }

  // Rename a rule and/or update its URL. Throws if the new trigger
  // normalizes to an existing key that isn't the one being edited —
  // the Link edit page relies on this to surface a "trigger already
  // exists" error instead of silently overwriting.
  updateRule(oldPhrase, { trigger, url }) {
    const oldKey = oldPhrase.toLowerCase().trim();
    const newKey = trigger.toLowerCase().trim();
    if (!this.rules.has(oldKey)) throw new Error('Rule not found');
    if (newKey !== oldKey && this.rules.has(newKey)) {
      const err = new Error('A rule already exists for that trigger');
      err.code = 'DUPLICATE_TRIGGER';
      throw err;
    }
    const next = { ...this.rules.get(oldKey), url: url.trim(), label: trigger.trim() };
    if (newKey !== oldKey) this.rules.delete(oldKey);
    this.rules.set(newKey, next);
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


// ── Usage ─────────────────────────────────────────────────────
//
// How often and how recently each phrase and link has been put into
// something: an autocomplete or Bop accepted, a link prompt or link
// search pick, Option+Shift+L/P, or the popup's copy buttons (not
// imports or edits). Search and autocomplete rank by it.
//
// It's kept in its own storage key, apart from the phrases and links,
// so recording a use from a Gmail tab never rewrites them. Entries are
// keyed like the items themselves (a phrase by its text, a link by its
// trigger) and move with them when they're renamed.
//
//   lingofrog_usage: { since, phrases: { [phrase]: entry },
//                      links: { [trigger]: entry } }
//   entry: { uses, last, score }
//
// `since` is when tracking started. `score` is a recency-weighted
// count as of `last`: each use adds 1, and the total halves every
// Usage.HALF_LIFE_DAYS, so what's used now outranks what was used a
// lot long ago.

class Usage {
  constructor() {
    this.data = Usage.empty();
    // Writes are read-modify-write of the whole store, so they run one
    // at a time; a phrase and its links recorded together both count.
    this._queue = Promise.resolve();
  }

  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  static empty() {
    return { since: null, phrases: Object.create(null), links: Object.create(null) };
  }

  // Null-prototype maps, so any phrase can be a key.
  static normalize(stored) {
    const data = Usage.empty();
    if (stored && typeof stored === 'object') {
      data.since = stored.since || null;
      Object.assign(data.phrases, stored.phrases);
      Object.assign(data.links, stored.links);
    }
    return data;
  }

  static _read() {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(['lingofrog_usage'], (stored) => {
          resolve(Usage.normalize(stored && stored.lingofrog_usage));
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  static _write(data) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ lingofrog_usage: data }, resolve);
      } catch (e) {
        reject(e);
      }
    });
  }

  // An entry's score now.
  static decayed(entry, now = Date.now()) {
    if (!entry || !entry.score) return 0;
    const days = Math.max(0, now - (entry.last || 0)) / 86400000;
    return entry.score * Math.pow(0.5, days / Usage.HALF_LIFE_DAYS);
  }

  // Two entries for the same item as one: the uses added up, or with
  // `keepMost`, the larger count (a backup restored over what it came
  // from shouldn't double it).
  static merge(a, b, { keepMost = false } = {}) {
    if (!a) return b;
    if (!b) return a;
    const last = Math.max(a.last || 0, b.last || 0);
    const uses = keepMost ? Math.max(a.uses || 0, b.uses || 0) : (a.uses || 0) + (b.uses || 0);
    const score = keepMost
      ? Math.max(Usage.decayed(a, last), Usage.decayed(b, last))
      : Usage.decayed(a, last) + Usage.decayed(b, last);
    return { uses, last, score };
  }

  load() {
    return this._serial(async () => {
      this.data = await Usage._read();
      if (!this.data.since) {
        this.data.since = Date.now();
        await Usage._write(this.data);
      }
    });
  }

  get(kind, key) {
    return this.data[kind][key] || null;
  }

  /**
   * Records one use of each key, against what's stored now (another tab
   * may have recorded uses since this one loaded). `startScore(key)` is
   * the score to start from for a key with no entry yet.
   */
  record(kind, keys, startScore = () => 0) {
    const list = [].concat(keys).filter((k) => k);
    if (!list.length) return Promise.resolve();
    return this._serial(() => this._record(kind, list, startScore));
  }

  async _record(kind, list, startScore) {
    const fresh = await Usage._read();
    const now = Date.now();
    for (const key of list) {
      const prev = fresh[kind][key];
      const base = prev ? Usage.decayed(prev, now) : startScore(key);
      fresh[kind][key] = { uses: (prev ? prev.uses || 0 : 0) + 1, last: now, score: base + 1 };
    }
    if (!fresh.since) fresh.since = now;
    await Usage._write(fresh);
    this.data = fresh;
  }

  // An item was renamed: its usage moves with it, merging into any the
  // new name already had.
  rename(kind, oldKey, newKey) {
    if (oldKey === newKey) return Promise.resolve();
    return this._serial(() => this._rename(kind, oldKey, newKey));
  }

  async _rename(kind, oldKey, newKey) {
    const fresh = await Usage._read();
    const moved = fresh[kind][oldKey];
    if (!moved) return;
    delete fresh[kind][oldKey];
    fresh[kind][newKey] = Usage.merge(fresh[kind][newKey], moved);
    await Usage._write(fresh);
    this.data = fresh;
  }

  remove(kind, key) {
    return this._serial(() => this._remove(kind, key));
  }

  async _remove(kind, key) {
    const fresh = await Usage._read();
    if (!(key in fresh[kind])) return;
    delete fresh[kind][key];
    await Usage._write(fresh);
    this.data = fresh;
  }

  clear(kind) {
    return this._serial(() => this._clear(kind));
  }

  async _clear(kind) {
    const fresh = await Usage._read();
    fresh[kind] = Object.create(null);
    await Usage._write(fresh);
    this.data = fresh;
  }

  // Merges restored entries ({ kind, key, entry }) into what's stored.
  restore(items) {
    if (!items.length) return Promise.resolve();
    return this._serial(() => this._restore(items));
  }

  async _restore(items) {
    const fresh = await Usage._read();
    for (const { kind, key, entry } of items) {
      fresh[kind][key] = Usage.merge(fresh[kind][key], entry, { keepMost: true });
    }
    await Usage._write(fresh);
    this.data = fresh;
  }
}

Usage.HALF_LIFE_DAYS = 30;


// ── Corpus ────────────────────────────────────────────────────

class Corpus {
  constructor() {
    this.trie = new PhraseTrie();
    // original phrase -> { frequency, source, importedAt, lastUsed, followedBy?: string[], rich?: string, tag?: string }
    // A formatted phrase (line breaks, lists, bold, links; see
    // phrase-format.js) is keyed by its plain text, which is what
    // matching uses, and keeps its Markdown in `rich`.
    this.phrases = new Map();
    this.linkRules = new LinkRules();
    this.utmRules = new UtmRules();
    this.usage = new Usage();
    this.config = {
      maxSuggestions: 5,
      triggerAfterChars: 8,
      enabled: true,
      autoComplete: true,
      autoLink: true,
      showSaveRuleChip: true,
      applyUtmOnCopy: true,
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
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(['lingofrog_phrases', 'lingofrog_config'], (data) => {
        if (data.lingofrog_config) {
          Object.assign(this.config, Corpus.migrateConfig(data.lingofrog_config));
        }

        if (data.lingofrog_phrases) {
          this.phrases = new Map(Object.entries(data.lingofrog_phrases));
        }

        this._rebuildTrie();
        Promise.all([this.linkRules.load(), this.utmRules.load(), this.usage.load()]).then(() => {
          // Again, now that usage (which ranks the phrases) has loaded.
          this._rebuildTrie();
          resolve();
        }, reject);
      });
    });
  }

  // Reloads just the usage, when another tab recorded some.
  async reloadUsage() {
    await this.usage.load();
    this._rebuildTrie();
  }

  async save() {
    const obj = Object.fromEntries(this.phrases);
    return new Promise((resolve) => {
      chrome.storage.local.set({ lingofrog_phrases: obj }, resolve);
    });
  }

  /**
   * A phrase's ranking score: its recency-weighted uses (see Usage). A
   * phrase not used since tracking started starts from its old
   * frequency, which counted half a point per autocomplete accepted, so
   * the order people are used to carries over.
   */
  phraseScore(phrase, now = Date.now()) {
    const entry = this.usage.get('phrases', phrase);
    if (entry) return Usage.decayed(entry, now);
    const data = this.phrases.get(phrase);
    if (!data) return 0;
    const legacyUses = Math.max(0, ((data.frequency || 1) - 1) * 2);
    return Usage.decayed({ score: legacyUses, last: data.lastUsed || data.importedAt || 0 }, now);
  }

  linkScore(trigger, now = Date.now()) {
    return Usage.decayed(this.usage.get('links', trigger), now);
  }

  /**
   * How well `text` matches a search (already lowercased): 0 for the
   * whole text, 1 its start, 2 the start of a word in it, 3 anywhere in
   * it, or -1 for no match.
   */
  static matchTier(text, query) {
    const t = String(text || '').toLowerCase();
    let at = t.indexOf(query);
    if (at === -1) return -1;
    if (t === query) return 0;
    if (at === 0) return 1;
    while (at !== -1) {
      if (!/[\p{L}\p{N}]/u.test(t[at - 1])) return 2;
      at = t.indexOf(query, at + 1);
    }
    return 3;
  }

  /**
   * Orders search results. By default (order 'usage'): with no search,
   * the most used first; with one, the best match first
   * (Corpus.matchTier), the most used first among equally good
   * matches, then A to Z. Order 'az' is A to Z only, for the popup's
   * lists.
   */
  static rankResults(items, query, order = 'usage') {
    if (order === 'az') return items.sort((a, b) => a.name.localeCompare(b.name));
    return items.sort((a, b) =>
      (query ? a.tier - b.tier : 0) ||
      b.score - a.score ||
      a.name.localeCompare(b.name)
    );
  }

  /**
   * Links for a search box: [{ trigger, url, label, score }], best first
   * (see rankResults; pass { order: 'az' } for A to Z). A link matches
   * on its trigger, or less well, on its URL.
   */
  searchLinks(filter = '', { order = 'usage' } = {}) {
    const query = filter.trim().toLowerCase();
    const now = Date.now();
    const results = [];
    for (const r of this.linkRules.getAll()) {
      let tier = 0;
      if (query) {
        tier = Corpus.matchTier(r.trigger, query);
        if (tier === -1) tier = r.url.toLowerCase().includes(query) ? 4 : -1;
        if (tier === -1) continue;
      }
      results.push({ ...r, name: r.trigger, tier, score: this.linkScore(r.trigger, now) });
    }
    return Corpus.rankResults(results, query, order);
  }

  /**
   * Import phrases — one per line. No sentence extraction.
   * Each non-empty line is stored as-is, preserving original casing,
   * except a formatted phrase's line ("md: " + its Markdown, as
   * exportText writes it).
   *
   * A phrase that's already saved counts as used once more, unless
   * `bump` is false (restoring a backup shouldn't reorder suggestions).
   */
  async importPhrases(text, source = 'import', { bump = true } = {}) {
    const lines = text.split('\n');
    let added = 0;
    const now = Date.now();

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      // Normalize smart quotes to straight quotes
      line = line.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

      const { phrase, rich } = Corpus.readPhraseLine(line);
      if (!phrase) continue;
      if (this.phrases.has(phrase)) {
        const entry = this.phrases.get(phrase);
        if (bump) {
          entry.frequency += 1;
          entry.lastUsed = now;
        }
        if (rich) entry.rich = rich;
        this.phrases.set(phrase, entry);
      } else {
        this.phrases.set(phrase, {
          frequency: 1,
          source,
          importedAt: now,
          lastUsed: now,
          ...(rich ? { rich } : {}),
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
   *
   * `rich` is the phrase's Markdown when it's formatted (see
   * phrase-format.js); `text` is then its plain text. Saving an
   * existing phrase with formatting replaces its formatting.
   */
  async addOrBumpPhrase(text, source = 'highlight', rich = null) {
    const normalized = (text || '')
      .trim()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"');
    if (!normalized) return { added: false, bumped: false, phrase: '' };
    const richText = rich ? rich.replace(/[‘’]/g, "'").replace(/[“”]/g, '"') : null;

    const now = Date.now();
    if (this.phrases.has(normalized)) {
      const entry = this.phrases.get(normalized);
      entry.frequency += 1;
      entry.lastUsed = now;
      if (richText) entry.rich = richText;
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
      ...(richText ? { rich: richText } : {}),
    });
    this._rebuildTrie();
    await this.save();
    return { added: true, bumped: false, phrase: normalized };
  }

  // The formatted version of a phrase (Markdown), or null for plain text.
  getRich(phrase) {
    const data = this.phrases.get(phrase);
    return (data && data.rich) || null;
  }

  // Sets or (with null) clears a phrase's formatting.
  async setRich(phrase, rich) {
    const data = this.phrases.get(phrase);
    if (!data) return false;
    if (rich) data.rich = rich;
    else delete data.rich;
    await this.save();
    return true;
  }

  // The phrase's tag (a short label, see setTag), or null.
  getTag(phrase) {
    const data = this.phrases.get(phrase);
    return (data && data.tag) || null;
  }

  // Sets or (with an empty tag) clears a phrase's tag: a label of up
  // to MAX_TAG_LENGTH characters shown beside the phrase in the popup
  // and in Gmail suggestions. A phrase has at most one.
  async setTag(phrase, tag) {
    const data = this.phrases.get(phrase);
    if (!data) return false;
    const clean = Corpus.cleanTag(tag);
    if (clean) data.tag = clean;
    else delete data.tag;
    await this.save();
    return true;
  }

  // Trimmed and cut to MAX_TAG_LENGTH characters (counting an emoji
  // as one).
  static cleanTag(tag) {
    const chars = [...String(tag || '').trim()];
    return chars.slice(0, Corpus.MAX_TAG_LENGTH).join('').trim();
  }

  // Records that a phrase was used (matched case-insensitively). Writes
  // only the usage store, never the phrases.
  async recordUsage(phrase) {
    let key = this.phrases.has(phrase) ? phrase : null;
    if (!key) {
      const lower = phrase.toLowerCase();
      for (const k of this.phrases.keys()) {
        if (k.toLowerCase() === lower) { key = k; break; }
      }
    }
    if (!key) return;
    await this.usage.record('phrases', key, (k) => this.phraseScore(k));
    this._rebuildTrie();
  }

  // Records that links were used, by trigger.
  async recordLinkUsage(triggers) {
    const keys = [].concat(triggers)
      .map((t) => String(t || '').toLowerCase().trim())
      .filter((t) => this.linkRules.rules.has(t));
    await this.usage.record('links', [...new Set(keys)]);
  }

  // Link edits that keep usage in step: renaming carries a link's usage
  // to its new trigger, deleting drops it.
  async updateLink(oldTrigger, { trigger, url }) {
    this.linkRules.updateRule(oldTrigger, { trigger, url });
    await this.linkRules.save();
    await this.usage.rename('links', oldTrigger.toLowerCase().trim(), trigger.toLowerCase().trim());
  }

  async removeLink(trigger) {
    this.linkRules.removeRule(trigger);
    await this.linkRules.save();
    await this.usage.remove('links', trigger.toLowerCase().trim());
  }

  async clearLinks() {
    this.linkRules.clear();
    await this.linkRules.save();
    await this.usage.clear('links');
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
    const now = Date.now();
    for (const [phrase] of this.phrases) {
      const score = this.phraseScore(phrase, now);
      // phrase is the original-cased key; trie indexes lowercase, stores original
      this.trie.insert(phrase, phrase, score);
    }
  }

  // One phrase per line; a formatted phrase as "md: " + its Markdown,
  // which importPhrases reads back.
  exportText() {
    return [...this.phrases].map(([phrase, data]) => Corpus.phraseLine(phrase, data)).join('\n');
  }

  static phraseLine(phrase, data) {
    return data && data.rich ? PhraseFormat.toBackupLine(data.rich) : phrase;
  }

  // { phrase, rich } from one line of a backup or bulk import.
  static readPhraseLine(line) {
    const md = PhraseFormat.fromBackupLine(line);
    if (md === null) return { phrase: line, rich: null };
    const blocks = PhraseFormat.parse(md);
    return {
      phrase: PhraseFormat.plainText(blocks),
      rich: PhraseFormat.isPlain(blocks) ? null : PhraseFormat.serialize(blocks),
    };
  }

  /**
   * Phrases for a search box: [{ phrase, frequency, score }], best
   * first (see rankResults; the Phrases tab passes { order: 'az' } for
   * A to Z). A phrase matches on its text or its tag; a tag counts as
   * well as the same match in the text.
   */
  getAllPhrases(filter = '', { order = 'usage' } = {}) {
    const query = filter.trim().toLowerCase();
    const now = Date.now();
    const result = [];
    for (const [phrase, data] of this.phrases) {
      let tier = 0;
      if (query) {
        const tiers = [Corpus.matchTier(phrase, query), data.tag ? Corpus.matchTier(data.tag, query) : -1]
          .filter((t) => t !== -1);
        if (!tiers.length) continue;
        tier = Math.min(...tiers);
      }
      result.push({
        phrase,
        name: phrase,
        tier,
        frequency: data.frequency,
        score: this.phraseScore(phrase, now),
      });
    }
    return Corpus.rankResults(result, query, order);
  }

  async deletePhrase(phrase) {
    this.phrases.delete(phrase);
    await this.usage.remove('phrases', phrase);
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
    await this.usage.rename('phrases', oldPhrase, newPhrase);
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
        lines.push(Corpus.bopKey(phrase) + ' -> ' + Corpus.bopKey(follower));
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

      const source = this._readBopKey(line.slice(0, m.index).trim());
      const follower = this._readBopKey(line.slice(m.index + m[0].length).trim());
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

  /**
   * Tags as text, one "phrase -> tag" line per tagged phrase. The
   * phrase is written the way a Bop line writes it (line breaks as \n).
   */
  exportTags() {
    const lines = [];
    for (const [phrase, data] of this.phrases) {
      if (data.tag) lines.push(Corpus.bopKey(phrase) + ' -> ' + data.tag);
    }
    return lines.join('\n');
  }

  /**
   * Parse a paste of tags (round-trip counterpart to exportTags) and
   * tag the phrases it names. The tag is what follows the last " -> ",
   * so a phrase may contain the arrow itself. Returns { added, skipped }:
   * blank and '#' lines are ignored; lines without an arrow or a tag, or
   * naming a phrase that isn't saved, are skipped.
   */
  async importTags(text) {
    const sepRe = /\s+->\s+/g;
    let added = 0;
    let skipped = 0;
    for (let line of text.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      let last = null;
      for (const m of line.matchAll(sepRe)) last = m;
      if (!last) { skipped++; continue; }
      const phrase = this._readBopKey(line.slice(0, last.index).trim());
      const tag = Corpus.cleanTag(line.slice(last.index + last[0].length));
      const data = this.phrases.get(phrase);
      if (!data || !tag) { skipped++; continue; }
      data.tag = tag;
      added++;
    }
    if (added) await this.save();
    return { added, skipped };
  }

  /**
   * Usage as text, one line per phrase or link that's been used:
   *
   *   phrase: Thanks for reaching out -> 14 uses; last 2026-11-20; score 6.31
   *   link: docs -> 9 uses; last 2026-11-18; score 3.4
   *
   * A phrase is written the way a Bop line writes it. `score` is the
   * recency-weighted score as of the last use (see Usage).
   */
  exportUsage() {
    const line = (kind, name, e) =>
      `${kind}: ${name} -> ${e.uses} ${e.uses === 1 ? 'use' : 'uses'}; ` +
      `last ${new Date(e.last).toISOString().slice(0, 10)}; score ${Math.round(e.score * 100) / 100}`;
    const lines = [];
    for (const phrase of this.phrases.keys()) {
      const e = this.usage.get('phrases', phrase);
      if (e && e.uses) lines.push(line('phrase', Corpus.bopKey(phrase), e));
    }
    for (const trigger of this.linkRules.rules.keys()) {
      const e = this.usage.get('links', trigger);
      if (e && e.uses) lines.push(line('link', trigger, e));
    }
    return lines.join('\n');
  }

  /**
   * Reads usage lines (exportUsage's format) back, merging them into
   * what's recorded: the larger count and the later date win, so
   * restoring a backup twice doesn't double anything. Returns
   * { added, skipped }; lines for phrases or links that aren't saved
   * are skipped.
   */
  async importUsage(text) {
    const items = [];
    let skipped = 0;
    for (let line of text.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(phrase|link):\s*(.*)$/i);
      let last = null;
      for (const arrow of (m ? m[2] : '').matchAll(/\s+->\s+/g)) last = arrow;
      if (!m || !last) { skipped++; continue; }
      const kind = m[1].toLowerCase() === 'phrase' ? 'phrases' : 'links';
      const name = m[2].slice(0, last.index).trim();
      const stats = m[2].slice(last.index + last[0].length);
      const uses = Number((stats.match(/(\d+)\s*uses?\b/i) || [])[1]);
      const date = stats.match(/last\s+(\d{4})-(\d{2})-(\d{2})/i);
      const score = Number((stats.match(/score\s+([\d.]+)/i) || [])[1]);
      const key = kind === 'phrases' ? this._readBopKey(name) : name.toLowerCase();
      const exists = kind === 'phrases' ? this.phrases.has(key) : this.linkRules.rules.has(key);
      if (!exists || !uses || !date) { skipped++; continue; }
      const lastUsed = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
      items.push({ kind, key, entry: { uses, last: lastUsed, score: Number.isFinite(score) ? score : uses } });
    }
    await this.usage.restore(items);
    this._rebuildTrie();
    return { added: items.length, skipped };
  }

  /**
   * The note Copy All puts above a backup's first section, for whoever
   * edits the backup later, by hand or with AI. splitBackup ignores
   * everything above the first header, so restoring never reads it.
   * Bump "format 1" if the backup format changes in a way an older
   * restore can't read.
   */
  static backupNote(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return [
      `LingoFrog backup, format 1, copied ${day}.`,
      'To restore it: open LingoFrog, click the gear (Settings), then Import from backup, and paste all of this under All.',
      '',
      'Notes for anyone editing this backup, by hand or with AI:',
      '- Restoring adds to what\'s saved and deletes nothing. To rename or remove phrases or links, first use Delete all phrases and Delete all links (in the ⋯ menu on the Phrases and Links tabs), then restore the edited backup. Keep the original until the restore looks right.',
      '- A phrase is matched by its exact text. If you change one, change it the same way under Phrases, Bops, Tags and Usage. The same goes for a link\'s trigger under Links and Usage. Lines naming a phrase or link that isn\'t saved are skipped.',
      '- Links: trigger; URL. UTM Parameters: host; key=value; key=value.',
      '- Phrases: one per line. A line starting with "md: " is a formatted phrase in Markdown, with line breaks written as \\n.',
      '- Bops: phrase -> next phrase. Tags: phrase -> tag (up to 4 characters). Here and in Usage, a formatted phrase is written as plain text: no "md: " and no Markdown, list items starting with "• " or "1. ", and line breaks as \\n.',
      '- Usage is how LingoFrog ranks suggestions. Leave it as it is, or delete the whole section.',
      '- Everything above the first line starting with "# " is ignored when restoring.',
    ].join('\n');
  }

  /**
   * Splits a full backup (Settings → Copy All to Clipboard) into its
   * sections, by their "# Links", "# Phrases", "# UTM Parameters",
   * "# Bops", "# Tags" and "# Usage" headers. Returns { links, phrases,
   * utms, bops, tags, usage } with the text of each section present, or
   * null when there are no section headers (so it isn't a backup).
   */
  static splitBackup(text) {
    const names = { links: 'links', phrases: 'phrases', 'utm parameters': 'utms', bops: 'bops', tags: 'tags', usage: 'usage' };
    const sections = {};
    let current = null;
    for (const line of String(text || '').split('\n')) {
      const m = line.trim().match(/^#\s*(links|phrases|utm parameters|bops|tags|usage)$/i);
      if (m) {
        current = names[m[1].toLowerCase()];
        sections[current] = sections[current] || [];
      } else if (current) {
        sections[current].push(line);
      }
    }
    if (!current) return null;
    return Object.fromEntries(Object.entries(sections).map(([k, lines]) => [k, lines.join('\n')]));
  }

  /**
   * Restores a full backup in one go, adding to what's saved and
   * deleting nothing. Sections go in dependency order: links and
   * phrases first, since Bops, tags and usage name them. Returns counts
   * per section present ({ links, phrases, utms, bops, tags, usage,
   * skipped }), or null if the text isn't a backup.
   */
  async restoreBackup(text) {
    const sections = Corpus.splitBackup(text);
    if (!sections) return null;
    const result = { skipped: 0 };
    if (sections.links != null) {
      result.links = await this.linkRules.importBulk(sections.links);
    }
    if (sections.phrases != null) {
      await this.importPhrases(sections.phrases, 'import', { bump: false });
      result.phrases = sections.phrases.split('\n').filter((l) => l.trim()).length;
    }
    if (sections.utms != null) {
      const { added, skipped } = await this.utmRules.importBulk(sections.utms);
      result.utms = added;
      result.skipped += skipped;
    }
    if (sections.bops != null) {
      const { added, skipped } = await this.importBops(sections.bops);
      result.bops = added;
      result.skipped += skipped;
    }
    if (sections.tags != null) {
      const { added, skipped } = await this.importTags(sections.tags);
      result.tags = added;
      result.skipped += skipped;
    }
    if (sections.usage != null) {
      const { added, skipped } = await this.importUsage(sections.usage);
      result.usage = added;
      result.skipped += skipped;
    }
    return result;
  }

  // A formatted phrase's key has line breaks; a bop line writes them as \n.
  // Tag lines write phrases the same way.
  static bopKey(phrase) {
    return phrase.replace(/\n/g, '\\n');
  }

  _readBopKey(written) {
    if (this.phrases.has(written)) return written;
    const multiLine = written.replace(/\\n/g, '\n');
    return this.phrases.has(multiLine) ? multiLine : written;
  }

  getStats() {
    const sources = {};
    const topPhrases = [];

    for (const [phrase, data] of this.phrases) {
      sources[data.source] = (sources[data.source] || 0) + 1;
      topPhrases.push({
        phrase,
        frequency: data.frequency,
        score: this.phraseScore(phrase),
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
    await this.usage.clear('phrases');
    await new Promise((resolve) => {
      chrome.storage.local.remove(['lingofrog_phrases'], resolve);
    });
  }
}

Corpus.MAX_FOLLOWED_BY = 1;
Corpus.MAX_TAG_LENGTH = 4;