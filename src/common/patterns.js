/*
 * Shared pattern model: defaults, compilation and matching.
 * Loaded as a plain script by the content script, the options page and the popup,
 * so everything hangs off a single global.
 */
(function (global) {
  'use strict';

  const PALETTE = [
    '#ffd54f', '#80deea', '#a5d6a7', '#ef9a9a',
    '#ce93d8', '#ffcc80', '#90caf9', '#c5e1a5'
  ];

  /** A pattern the user never typed still has to look like one they did. */
  function makePattern(over) {
    return Object.assign({
      id: newId(),
      name: 'Untitled',
      type: 'regex',          // 'text' | 'glob' | 'regex' | 'locator'
      value: '',
      within: '',             // optional locator narrowing where `value` is matched
      flags: '',              // subset of 'imsu'; 'g' is always added
      copyTemplate: '',       // '' -> whole match; else $0/$1/$<name>
      sites: '*',             // comma separated URL globs
      color: PALETTE[0],
      enabled: true
    }, over || {});
  }

  function newId() {
    return 'p_' + Math.random().toString(36).slice(2, 10);
  }

  const DEFAULT_PATTERNS = [
    makePattern({
      id: 'p_unixpath', name: 'Unix path', type: 'regex',
      value: '(?:~|\\.{0,2})?(?:/[\\w.@%+-]+){2,}/?',
      color: PALETTE[0]
    }),
    makePattern({
      id: 'p_winpath', name: 'Windows path', type: 'regex',
      // Spaces are allowed inside a directory segment ("C:\\Program Files\\") but
      // never in the final one, so a path can't swallow the rest of the sentence.
      value: '[A-Za-z]:\\\\(?:[^\\s\\\\/:*?"<>|]+(?: +[^\\s\\\\/:*?"<>|]+)*\\\\)*[^\\s\\\\/:*?"<>|]*',
      color: PALETTE[1]
    }),
    makePattern({
      id: 'p_ipv4', name: 'IPv4 address', type: 'regex',
      value: '\\b(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\b',
      color: PALETTE[2]
    }),
    makePattern({
      id: 'p_uuid', name: 'UUID', type: 'regex',
      value: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b',
      flags: 'i', color: PALETTE[3]
    }),
    makePattern({
      id: 'p_sha', name: 'Git SHA', type: 'regex',
      value: '\\b[0-9a-f]{7,40}\\b', flags: 'i',
      color: PALETTE[4], enabled: false
    }),
    makePattern({
      id: 'p_email', name: 'Email', type: 'regex',
      value: "[\\w.%+-]+@[\\w.-]+\\.[A-Za-z]{2,}",
      color: PALETTE[5], enabled: false
    }),
    makePattern({
      id: 'p_logfile', name: 'Log file (glob example)', type: 'glob',
      value: '/var/log/**/*.log',
      color: PALETTE[6], enabled: false
    }),
    makePattern({
      id: 'p_code', name: 'Inline code (locator example)', type: 'locator',
      value: '//code',
      color: PALETTE[7], enabled: false
    }),
    makePattern({
      // XPath picks the hrefs, the regex pulls the key out of each one.
      id: 'p_ticket', name: 'Ticket from link (combined example)', type: 'regex',
      within: '//a/@href',
      value: '/browse/([A-Z][A-Z0-9]+-\\d+)',
      copyTemplate: '$1',
      color: PALETTE[2], enabled: false
    })
  ];

  const DEFAULT_SETTINGS = {
    enabled: true,
    showHint: true,       // floating copy button on hover
    clickToCopy: false,   // clicking the highlight itself copies
    highlight: true,      // tint the matched text
    maxMatches: 1500,     // per frame, keeps huge pages responsive
    patterns: DEFAULT_PATTERNS
  };

  function defaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  /*
   * storage.sync caps every item at 8 KB, so the pattern list is stored as a
   * JSON string split across `settings.p0`, `settings.p1`, ... while the
   * `settings` item itself only carries the toggles and the chunk count.
   */
  const CHUNK_PREFIX = 'settings.p';
  const ITEM_BUDGET = 8000;   // QUOTA_BYTES_PER_ITEM is 8192, key included

  function settingsStore(api) {
    return (api.storage && api.storage.sync) || api.storage.local;
  }

  function utf8Length(s) {
    let n = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
  }

  function itemBytes(key, value) {
    return utf8Length(key) + utf8Length(JSON.stringify(value));
  }

  function chunkString(s) {
    const chunks = [];
    let i = 0;
    while (i < s.length) {
      const key = CHUNK_PREFIX + chunks.length;
      let size = Math.min(s.length - i, 4000);
      while (size > 1 && itemBytes(key, s.slice(i, i + size)) > ITEM_BUDGET) size = Math.floor(size / 2);
      chunks.push(s.slice(i, i + size));
      i += size;
    }
    return chunks;
  }

  function isChunkKey(key) {
    return key.startsWith(CHUNK_PREFIX) && /^\d+$/.test(key.slice(CHUNK_PREFIX.length));
  }

  /** True when a storage.onChanged batch touched any part of the settings. */
  function isSettingsChange(changes) {
    return Object.keys(changes || {}).some(k => k === 'settings' || isChunkKey(k));
  }

  function readPatterns(all, meta) {
    if (Array.isArray(meta.patterns)) return meta.patterns;   // pre-chunking format
    const n = Number(meta.patternChunks);
    if (!Number.isInteger(n) || n < 0) return null;
    let json = '';
    for (let i = 0; i < n; i++) {
      const part = all[CHUNK_PREFIX + i];
      if (typeof part !== 'string') return null;
      json += part;
    }
    try {
      const parsed = JSON.parse(json || '[]');
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  async function loadSettings(api) {
    let all = {};
    try {
      all = (await settingsStore(api).get(null)) || {};
    } catch (_) {
      all = {};
    }
    const meta = all.settings || {};
    const patterns = readPatterns(all, meta);
    const merged = Object.assign(defaults(), meta);
    delete merged.patternChunks;
    merged.patterns = (patterns || defaults().patterns).map(makePattern);
    return merged;
  }

  /** Rejects (e.g. over the total sync quota) so callers can tell the user. */
  async function saveSettings(api, settings) {
    const store = settingsStore(api);
    const meta = Object.assign({}, settings);
    delete meta.patterns;
    const chunks = chunkString(JSON.stringify(settings.patterns || []));
    meta.patternChunks = chunks.length;

    const items = {};
    chunks.forEach((c, i) => { items[CHUNK_PREFIX + i] = c; });
    items.settings = meta;

    let existing = {};
    try { existing = (await store.get(null)) || {}; } catch (_) { existing = {}; }
    await store.set(items);

    const stale = Object.keys(existing).filter(k => isChunkKey(k) && !(k in items));
    if (stale.length) await store.remove(stale).catch(() => {});
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Path-flavoured globbing: `**` crosses separators, `*` and `?` do not,
   * and whitespace always ends a match so a glob can't swallow a sentence.
   */
  function globToSource(glob) {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        const sep = glob[i + 2];
        if (glob[i + 1] === '*' && (sep === '/' || sep === '\\')) {
          // `**/` also matches zero directories: `a/**/b` covers `a/b`.
          out += '(?:[^\\s]*' + escapeRegExp(sep) + ')?';
          i += 2;
        } else if (glob[i + 1] === '*') { out += '[^\\s]*'; i++; }
        else out += '[^\\s/\\\\]*';
      } else if (c === '?') {
        out += '[^\\s/\\\\]';
      } else {
        out += escapeRegExp(c);
      }
    }
    return out;
  }

  function normalizeFlags(flags) {
    const allowed = new Set(['i', 'm', 's', 'u']);
    const seen = new Set();
    for (const f of String(flags || '')) if (allowed.has(f)) seen.add(f);
    seen.add('g');
    return [...seen].join('');
  }

  function patternSource(pattern) {
    switch (pattern.type) {
      case 'regex': return pattern.value;
      case 'glob': return globToSource(pattern.value);
      default: return escapeRegExp(pattern.value);
    }
  }

  /** Throws with a readable message when the pattern can't compile. */
  function toRegExp(pattern) {
    const source = patternSource(pattern);
    if (!source) throw new Error('Pattern is empty');
    return new RegExp(source, normalizeFlags(pattern.flags));
  }

  /*
   * A glob without a `/` describes a host, so its `*` stays inside the host.
   * A glob that doesn't end in `*` still covers everything below it:
   * `github.com/org` matches `github.com/org/repo`, `jira.local` any path there.
   */
  function urlGlobToRegExp(glob) {
    const star = glob.includes('/') ? '.*' : '[^/?#]*';
    const source = glob.split('*').map(escapeRegExp).join(star);
    const tail = glob.endsWith('*') ? '' : '(?:[:/?#].*)?';
    return new RegExp('^' + source + tail + '$', 'i');
  }

  function patternAppliesTo(pattern, url) {
    const spec = String(pattern.sites || '*').trim();
    if (!spec || spec === '*') return true;
    const bare = url.replace(/^[a-z]+:\/\//i, '');
    return spec.split(',').map(s => s.trim()).filter(Boolean).some(g => {
      const re = urlGlobToRegExp(g);
      return re.test(url) || re.test(bare);
    });
  }

  function compileAll(patterns, url) {
    const out = [];
    patterns.forEach((p, index) => {
      if (!p.enabled || !p.value || p.type === 'locator') return;
      if (url && !patternAppliesTo(p, url)) return;
      try {
        out.push({
          id: p.id,
          name: p.name || 'Pattern',
          re: toRegExp(p),
          scope: p.within ? parseLocator(p.within) : null,
          color: p.color,
          copyTemplate: p.copyTemplate || '',
          priority: index
        });
      } catch (err) {
        console.warn('[Pattern Copy] skipping invalid pattern', p.name, err.message);
      }
    });
    return out;
  }

  /** `$0`/`$1`/`$<name>` substitution; `$$` is a literal dollar. */
  function renderTemplate(template, match) {
    if (!template) return match[0];
    return template.replace(/\$(\$|\d|<[^>]+>)/g, (whole, token) => {
      if (token === '$') return '$';
      if (token[0] === '<') {
        const key = token.slice(1, -1);
        return (match.groups && match.groups[key]) || '';
      }
      return match[Number(token)] || '';
    });
  }

  const MAX_HITS_PER_PATTERN_PER_NODE = 200;

  /**
   * All non-overlapping matches in `text`, earliest first.
   * On a tie the longer match wins, then the earlier pattern in the list.
   */
  function findMatches(text, compiled) {
    const found = [];
    for (const c of compiled) {
      c.re.lastIndex = 0;
      let m;
      let guard = 0;
      while ((m = c.re.exec(text)) !== null) {
        if (m[0].length === 0) { c.re.lastIndex++; continue; }
        if (++guard > MAX_HITS_PER_PATTERN_PER_NODE) break;
        const copy = renderTemplate(c.copyTemplate, m).trim();
        if (!copy) continue;
        found.push({
          start: m.index,
          end: m.index + m[0].length,
          text: m[0],
          copy,
          name: c.name,
          color: c.color,
          priority: c.priority
        });
      }
    }
    if (found.length < 2) return found;

    found.sort((a, b) =>
      a.start - b.start ||
      (b.end - b.start) - (a.end - a.start) ||
      a.priority - b.priority);

    const kept = [];
    let lastEnd = 0;
    for (const m of found) {
      if (m.start >= lastEnd) { kept.push(m); lastEnd = m.end; }
    }
    return kept;
  }

  /* ------------------------------------------------------- locators ----- */

  /*
   * A "locator" pattern targets whole elements instead of substrings.
   * The value is either a bare XPath / CSS selector, or Selenium's
   * `strategy=value` form, so a locator lifted straight out of a page object
   * works unchanged.
   */
  const LOCATOR_STRATEGIES = {
    'xpath': 'xpath',
    'css': 'css',
    'css selector': 'css',
    'id': 'id',
    'name': 'name',
    'class': 'class',
    'class name': 'class',
    'tag': 'tag',
    'tag name': 'tag',
    'link': 'link',
    'link text': 'link',
    'partial link': 'partial',
    'partial link text': 'partial'
  };

  const LOCATOR_STRATEGY_NAMES = Object.keys(LOCATOR_STRATEGIES);

  function cssString(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  /** XPath has no escape character, so a quote in the text forces concat(). */
  function xpathString(value) {
    const s = String(value);
    if (!s.includes('"')) return '"' + s + '"';
    if (!s.includes("'")) return "'" + s + "'";
    return 'concat(' + s.split('"').map(part => '"' + part + '"').join(', \'"\', ') + ')';
  }

  /**
   * Splits a locator into the strategy and the query actually handed to the DOM.
   * Returns { strategy, kind: 'css'|'xpath', query, explicit }.
   */
  function parseLocator(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) throw new Error('Locator is empty');

    let strategy = null;
    let body = raw;
    const prefixed = /^([A-Za-z][A-Za-z ]*?)\s*=\s*([\s\S]*)$/.exec(raw);
    if (prefixed) {
      const key = prefixed[1].trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(LOCATOR_STRATEGIES, key)) {
        strategy = LOCATOR_STRATEGIES[key];
        body = prefixed[2].trim();
        if (!body) throw new Error(`Locator "${key}=" has no value`);
      }
    }

    const explicit = strategy !== null;
    if (!explicit) strategy = /^[(/]|^\.{1,2}\//.test(raw) ? 'xpath' : 'css';

    switch (strategy) {
      case 'xpath': return { strategy, kind: 'xpath', query: body, explicit };
      case 'css': return { strategy, kind: 'css', query: body, explicit };
      case 'id': return { strategy, kind: 'css', query: '[id=' + cssString(body) + ']', explicit };
      case 'name': return { strategy, kind: 'css', query: '[name=' + cssString(body) + ']', explicit };
      case 'class': return { strategy, kind: 'css', query: '[class~=' + cssString(body) + ']', explicit };
      case 'tag': return { strategy, kind: 'css', query: body, explicit };
      case 'link':
        return { strategy, kind: 'xpath', query: '//a[normalize-space(.)=' + xpathString(body) + ']', explicit };
      case 'partial':
        return { strategy, kind: 'xpath', query: '//a[contains(normalize-space(.), ' + xpathString(body) + ')]', explicit };
      default:
        throw new Error('Unknown locator strategy: ' + strategy);
    }
  }

  function compileLocators(patterns, url) {
    const out = [];
    patterns.forEach((p, index) => {
      if (p.type !== 'locator' || !p.enabled || !p.value) return;
      if (url && !patternAppliesTo(p, url)) return;
      try {
        const parsed = parseLocator(p.value);
        out.push({
          id: p.id,
          name: p.name || 'Locator',
          kind: parsed.kind,
          strategy: parsed.strategy,
          query: parsed.query,
          color: p.color,
          copyTemplate: p.copyTemplate || '',
          priority: index
        });
      } catch (err) {
        console.warn('[Pattern Copy] skipping invalid locator', p.name, err.message);
      }
    });
    return out;
  }

  const MAX_LOCATOR_NODES = 500;

  /** Runs one compiled locator against a document. Throws on a bad query. */
  function queryLocator(doc, locator) {
    const nodes = [];
    if (locator.kind === 'css') {
      const list = doc.querySelectorAll(locator.query);
      for (let i = 0; i < list.length && i < MAX_LOCATOR_NODES; i++) nodes.push(list[i]);
      return nodes;
    }

    const view = doc.defaultView || globalThis;
    const snapshot = doc.evaluate(
      locator.query, doc, null, view.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const len = Math.min(snapshot.snapshotLength, MAX_LOCATOR_NODES);
    for (let i = 0; i < len; i++) nodes.push(snapshot.snapshotItem(i));
    return nodes;
  }

  /**
   * The element a hit is anchored to, and the text it stands for.
   * XPath may select attribute or text nodes, which anchor to their owner.
   */
  const VALUE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'PROGRESS', 'METER']);

  function locatorAnchor(node) {
    if (!node) return null;
    switch (node.nodeType) {
      // A form control carries no text; its current value is what it stands for.
      case 1: return {
        element: node,
        value: VALUE_TAGS.has(node.tagName) ? String(node.value ?? '') : node.textContent
      };
      case 2: return { element: node.ownerElement, value: node.value };   // attribute
      case 3:
      case 4: return { element: node.parentElement, value: node.nodeValue }; // text / cdata
      default: return null;
    }
  }

  /** Locator templates have no capture groups: `$0` is the value, `$@attr` an attribute. */
  function renderLocatorTemplate(template, value, element) {
    if (!template) return value;
    return template.replace(/\$(\$|0|@[\w:-]+)/g, (whole, token) => {
      if (token === '$') return '$';
      if (token === '0') return value;
      const attr = element && element.getAttribute(token.slice(1));
      return attr == null ? '' : attr;
    });
  }

  /**
   * Splits the nodes a scope locator selects into the two things a text
   * pattern can be run against: element subtrees (match inside their text)
   * and single values (an attribute, or a form control's value).
   */
  function resolveScope(doc, scope) {
    const elements = [];
    const values = [];
    for (const node of queryLocator(doc, scope)) {
      if (node && node.nodeType === 1 && !VALUE_TAGS.has(node.tagName)) {
        elements.push(node);
      } else {
        const anchor = locatorAnchor(node);
        if (anchor && anchor.element) values.push(anchor);
      }
    }
    return { elements, values };
  }

  /** Throws with a readable message when a pattern of any type can't be used. */
  function validate(pattern, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);

    function checkLocator(value, label) {
      let parsed;
      try {
        parsed = parseLocator(value);
        if (d) {
          if (parsed.kind === 'css') d.createElement('div').querySelector(parsed.query);
          else d.createExpression(parsed.query, null);
        }
      } catch (err) {
        const kind = parsed ? parsed.kind : 'locator';
        const detail = err.message || `is not a valid ${kind} expression`;
        throw new Error(label ? `${label}: ${detail}` : detail);
      }
      return parsed;
    }

    // Locators ignore `within` (the field is disabled for them), so don't judge it.
    const within = pattern.within && pattern.type !== 'locator'
      ? checkLocator(pattern.within, 'Within') : null;
    if (pattern.type === 'locator') return { locator: checkLocator(pattern.value), within };
    toRegExp(pattern);
    return { locator: null, within };
  }

  global.PatternCopy = {
    PALETTE,
    DEFAULT_SETTINGS,
    defaults,
    makePattern,
    newId,
    loadSettings,
    saveSettings,
    isSettingsChange,
    compileAll,
    compileLocators,
    parseLocator,
    queryLocator,
    resolveScope,
    locatorAnchor,
    renderLocatorTemplate,
    validate,
    LOCATOR_STRATEGY_NAMES,
    toRegExp,
    findMatches,
    renderTemplate,
    patternAppliesTo,
    globToSource
  };
})(globalThis);
