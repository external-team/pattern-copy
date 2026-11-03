/* Pattern editor. Nothing is persisted until "Save" succeeds validation. */
(function () {
  'use strict';

  const api = globalThis.patternCopyApi;

  const $ = (sel) => document.querySelector(sel);

  const el = {
    rows: $('#rows'),
    empty: $('#empty'),
    status: $('#status'),
    save: $('#save'),
    add: $('#add'),
    reset: $('#reset'),
    exportBtn: $('#export'),
    importBtn: $('#import'),
    importFile: $('#import-file'),
    testInput: $('#test-input'),
    testOutput: $('#test-output')
  };

  const TOGGLES = ['enabled', 'showHint', 'highlight', 'clickToCopy'];
  const TYPES = [
    ['text', 'Text'],
    ['glob', 'Glob / path'],
    ['regex', 'Regex'],
    ['locator', 'Locator']
  ];

  let settings = null;
  let statusTimer = 0;

  function setStatus(message, tone) {
    el.status.textContent = message;
    if (tone) el.status.dataset.tone = tone; else delete el.status.dataset.tone;
    clearTimeout(statusTimer);
    if (message) statusTimer = setTimeout(() => setStatus(''), 3000);
  }

  /* --------------------------------------------------------------- render */

  function field(labelText, control) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const span = document.createElement('span');
    span.textContent = labelText;
    wrap.append(span, control);
    return wrap;
  }

  function textInput(value, { mono, placeholder } = {}) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    if (mono) input.className = 'mono';
    if (placeholder) input.placeholder = placeholder;
    return input;
  }

  function renderRow(pattern) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = pattern.id;
    row.dataset.enabled = String(pattern.enabled);

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = pattern.enabled;
    enabled.title = 'Enable this pattern';
    enabled.addEventListener('change', () => {
      pattern.enabled = enabled.checked;
      row.dataset.enabled = String(pattern.enabled);
      runTest();
    });

    const name = textInput(pattern.name, { placeholder: 'Name' });
    name.addEventListener('input', () => { pattern.name = name.value; runTest(); });

    const type = document.createElement('select');
    for (const [value, label] of TYPES) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      type.append(opt);
    }
    type.value = pattern.type;

    const value = textInput(pattern.value, { mono: true });
    const within = textInput(pattern.within, { mono: true });
    const flags = textInput(pattern.flags, { mono: true, placeholder: 'ims' });
    const template = textInput(pattern.copyTemplate, { mono: true });
    const sites = textInput(pattern.sites, { mono: true, placeholder: '*' });

    const note = document.createElement('div');
    note.className = 'note';
    note.hidden = true;

    /** Locators have no regex half, so the regex-only inputs go quiet. */
    function syncType() {
      const isLocator = pattern.type === 'locator';
      value.placeholder = isLocator ? '//code  ·  css=.build .id  ·  id=ticket' : '/var/log/**/*.log';
      template.placeholder = isLocator ? '$0 or $@href' : '$0';
      within.placeholder = isLocator ? 'n/a for locators' : '//td[@class="log"]  ·  //a/@href';
      flags.disabled = isLocator;
      within.disabled = isLocator;
    }

    function describe(resolved) {
      const parts = [];
      if (resolved.within) parts.push(`within ${resolved.within.strategy} → ${resolved.within.query}`);
      if (resolved.locator) parts.push(`${resolved.locator.strategy} → ${resolved.locator.query}`);
      return parts.join('   ·   ');
    }

    function validate() {
      try {
        const text = describe(PatternCopy.validate(pattern));
        value.setAttribute('aria-invalid', 'false');
        within.setAttribute('aria-invalid', 'false');
        note.dataset.tone = 'info';
        note.textContent = text;
        note.hidden = !text;
        return true;
      } catch (err) {
        const onWithin = /^Within:/.test(err.message);
        value.setAttribute('aria-invalid', String(!onWithin));
        within.setAttribute('aria-invalid', String(onWithin));
        note.dataset.tone = 'error';
        note.textContent = err.message;
        note.hidden = false;
        return false;
      }
    }

    type.addEventListener('change', () => {
      pattern.type = type.value;
      syncType();
      validate();
      runTest();
    });
    value.addEventListener('input', () => { pattern.value = value.value; validate(); runTest(); });
    within.addEventListener('input', () => { pattern.within = within.value; validate(); runTest(); });
    flags.addEventListener('input', () => { pattern.flags = flags.value; validate(); runTest(); });
    template.addEventListener('input', () => { pattern.copyTemplate = template.value; runTest(); });
    sites.addEventListener('input', () => { pattern.sites = sites.value; });

    const color = document.createElement('input');
    color.type = 'color';
    color.value = pattern.color || PatternCopy.PALETTE[0];
    color.addEventListener('input', () => { pattern.color = color.value; });

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(
      iconButton('↑', 'Move up', () => move(pattern, -1)),
      iconButton('↓', 'Move down', () => move(pattern, 1)),
      iconButton('⧉', 'Duplicate', () => duplicate(pattern)),
      iconButton('✕', 'Delete', () => remove(pattern))
    );

    const second = document.createElement('div');
    second.className = 'row-second';
    second.append(field('Within', within), field('Copy as', template), field('Sites', sites));

    row.append(
      enabled,
      field('Name', name),
      field('Type', type),
      field('Pattern', value),
      field('Flags', flags),
      color,
      actions,
      second,
      note
    );

    syncType();
    validate();
    return row;
  }

  function iconButton(glyph, title, onClick) {
    const b = document.createElement('button');
    b.className = 'icon';
    b.type = 'button';
    b.textContent = glyph;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    el.rows.textContent = '';
    for (const pattern of settings.patterns) el.rows.append(renderRow(pattern));
    el.empty.hidden = settings.patterns.length > 0;
    runTest();
  }

  /* ------------------------------------------------------------ mutations */

  function indexOf(pattern) {
    return settings.patterns.findIndex(p => p.id === pattern.id);
  }

  function move(pattern, delta) {
    const i = indexOf(pattern);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= settings.patterns.length) return;
    const [item] = settings.patterns.splice(i, 1);
    settings.patterns.splice(j, 0, item);
    render();
  }

  function duplicate(pattern) {
    const copy = PatternCopy.makePattern(Object.assign({}, pattern, {
      id: PatternCopy.newId(),
      name: pattern.name + ' (copy)'
    }));
    settings.patterns.splice(indexOf(pattern) + 1, 0, copy);
    render();
  }

  function remove(pattern) {
    const i = indexOf(pattern);
    if (i >= 0) settings.patterns.splice(i, 1);
    render();
  }

  /* ----------------------------------------------------------------- test */

  function chip(text, color, title) {
    const span = document.createElement('span');
    span.className = 'chip';
    if (color) span.style.borderColor = color;
    span.textContent = text;
    if (title) span.title = title;
    return span;
  }

  function line(label) {
    const row = document.createElement('div');
    row.className = 'test-line';
    const name = document.createElement('span');
    name.className = 'test-name';
    name.textContent = label;
    row.append(name);
    return row;
  }

  /** Locators and scopes only mean something against a DOM, so the sample is parsed. */
  function runDomTest(text, scoped, locators) {
    if (!scoped.length && !locators.length) return;

    if (!text.includes('<')) {
      const row = line('Locators & scopes');
      row.append(chip('paste an HTML snippet above to test them'));
      el.testOutput.append(row);
      return;
    }

    const doc = new DOMParser().parseFromString(text, 'text/html');

    for (const locator of locators) {
      const row = line(locator.name);
      let nodes;
      try {
        nodes = PatternCopy.queryLocator(doc, locator);
      } catch (err) {
        row.append(chip(err.message, 'var(--danger)'));
        el.testOutput.append(row);
        continue;
      }
      if (!nodes.length) row.append(chip('no match'));
      for (const node of nodes) {
        const anchor = PatternCopy.locatorAnchor(node);
        if (!anchor || !anchor.element) continue;
        const copy = PatternCopy.renderLocatorTemplate(
          locator.copyTemplate, anchor.value || '', anchor.element).trim();
        row.append(chip(copy || '(empty)', locator.color, '<' + anchor.element.tagName.toLowerCase() + '>'));
      }
      el.testOutput.append(row);
    }

    for (const entry of scoped) {
      const row = line(entry.name);
      let resolved;
      try {
        resolved = PatternCopy.resolveScope(doc, entry.scope);
      } catch (err) {
        row.append(chip(err.message, 'var(--danger)'));
        el.testOutput.append(row);
        continue;
      }

      const found = [];
      // Walk text nodes, exactly as the page scanner does, so the preview matches.
      for (const element of resolved.elements) {
        const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          for (const m of PatternCopy.findMatches(n.nodeValue, [entry])) found.push([m, element]);
        }
      }
      for (const anchor of resolved.values) {
        const m = PatternCopy.findMatches(anchor.value || '', [entry])[0];
        if (m) found.push([m, anchor.element]);
      }

      if (!found.length) {
        const scopeHit = resolved.elements.length + resolved.values.length;
        row.append(chip(scopeHit ? `scope matched ${scopeHit}, pattern matched none` : 'scope matched nothing'));
      }
      for (const [m, element] of found) {
        row.append(chip(m.copy, entry.color, '<' + element.tagName.toLowerCase() + '> ' + m.text));
      }
      el.testOutput.append(row);
    }
  }

  function runTest() {
    const text = el.testInput.value || el.testInput.placeholder;
    el.testOutput.textContent = '';

    const all = PatternCopy.compileAll(settings.patterns, null);
    const scoped = all.filter(c => c.scope);
    const matches = PatternCopy.findMatches(text, all.filter(c => !c.scope));

    runDomTest(text, scoped, PatternCopy.compileLocators(settings.patterns, null));

    if (!matches.length) {
      const note = document.createElement('div');
      note.className = 'hint-text';
      note.textContent = 'No text-pattern matches in the sample.';
      el.testOutput.append(note);
      return;
    }

    const byName = new Map();
    for (const m of matches) {
      if (!byName.has(m.name)) byName.set(m.name, []);
      byName.get(m.name).push(m);
    }

    for (const [name, list] of byName) {
      const row = line(name);
      for (const m of list) {
        row.append(chip(m.copy, m.color, m.copy !== m.text ? 'matched: ' + m.text : ''));
      }
      el.testOutput.append(row);
    }
  }

  /* ------------------------------------------------------------ persistence */

  function readToggles() {
    for (const key of TOGGLES) settings[key] = $('#opt-' + key).checked;
    const max = Number($('#opt-maxMatches').value);
    settings.maxMatches = Number.isFinite(max) && max > 0 ? Math.min(max, 20000) : 1500;
  }

  function writeToggles() {
    for (const key of TOGGLES) $('#opt-' + key).checked = !!settings[key];
    $('#opt-maxMatches').value = settings.maxMatches;
  }

  function firstInvalid() {
    return settings.patterns.find(p => {
      if (!p.enabled) return false;
      try { PatternCopy.validate(p); return false; } catch (_) { return true; }
    });
  }

  async function save() {
    readToggles();
    const bad = firstInvalid();
    if (bad) {
      setStatus(`"${bad.name || 'Untitled'}" is not a valid pattern`, 'error');
      return;
    }
    try {
      await PatternCopy.saveSettings(api, settings);
    } catch (err) {
      // storage.sync holds ~100 KB in total; a very large pattern list can exceed it.
      setStatus('Save failed: ' + ((err && err.message) || err), 'error');
      return;
    }
    setStatus('Saved', 'ok');
  }

  function exportSettings() {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pattern-copy-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importSettings(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = Array.isArray(parsed) ? { patterns: parsed } : parsed;
      if (!Array.isArray(incoming.patterns)) throw new Error('no "patterns" array');
      settings = Object.assign(PatternCopy.defaults(), settings, incoming);
      settings.patterns = incoming.patterns.map(PatternCopy.makePattern);
      writeToggles();
      render();
      setStatus('Imported — review, then Save', 'ok');
    } catch (err) {
      setStatus('Import failed: ' + err.message, 'error');
    }
  }

  /* ----------------------------------------------------------------- init */

  async function init() {
    settings = await PatternCopy.loadSettings(api);
    writeToggles();
    render();

    el.save.addEventListener('click', save);
    el.add.addEventListener('click', () => {
      const color = PatternCopy.PALETTE[settings.patterns.length % PatternCopy.PALETTE.length];
      settings.patterns.push(PatternCopy.makePattern({ name: 'New pattern', type: 'glob', color }));
      render();
      const last = el.rows.lastElementChild;
      if (last) last.querySelector('input[type="text"]').focus();
    });
    el.reset.addEventListener('click', () => {
      if (!confirm('Replace all patterns and options with the defaults?')) return;
      settings = PatternCopy.defaults();
      writeToggles();
      render();
      setStatus('Defaults restored — press Save to apply');
    });
    el.exportBtn.addEventListener('click', exportSettings);
    el.importBtn.addEventListener('click', () => el.importFile.click());
    el.importFile.addEventListener('change', () => {
      const file = el.importFile.files[0];
      if (file) importSettings(file);
      el.importFile.value = '';
    });
    el.testInput.addEventListener('input', runTest);

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
    });
  }

  init();
})();
