/*
 * Scans visible text for the configured patterns, wraps hits in <mark>,
 * and shows a floating "Copy" hint while the pointer is over one.
 */
(function () {
  'use strict';

  const api = globalThis.patternCopyApi;

  if (window.__patternCopyInjected) return;
  window.__patternCopyInjected = true;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO',
    'HEAD', 'TITLE', 'META', 'LINK', 'TEMPLATE'
  ]);

  /*
   * The text scanner skips far more than this, but a locator is an explicit
   * instruction: only elements that cannot sensibly carry a hit are refused.
   */
  const LOCATOR_SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'TITLE', 'META', 'LINK', 'TEMPLATE'
  ]);

  const HINT_HIDE_DELAY = 220;
  const RESCAN_DELAY = 300;
  // Scoped patterns and locators query the whole document, so on a page that
  // never stops mutating they run at most this often.
  const DOC_PASS_INTERVAL = 1500;
  const EDITABLE = '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

  let settings = null;
  let compiled = [];   // text patterns matched against the whole page
  let scoped = [];     // text patterns narrowed by a `within` locator
  let locators = [];
  let hitCount = 0;
  let observer = null;
  let scanning = false;
  let rescanTimer = 0;
  let lastDocPass = 0;
  const pendingRoots = new Set();
  // Rebuilt for every scan: contenteditable can be switched on at any time.
  let skipCache = new WeakMap();
  // Text nodes we split off while highlighting, so removal merges only those.
  let pieces = new WeakSet();

  let ui = null;          // { host, shadow, panel, button, label, hideTimer }
  let activeHit = null;

  /* ------------------------------------------------------------------ setup */

  async function init() {
    settings = await PatternCopy.loadSettings(api);
    apply();
    api.storage.onChanged.addListener(async (changes, area) => {
      if (!PatternCopy.isSettingsChange(changes)) return;
      settings = await PatternCopy.loadSettings(api);
      apply();
    });
    api.runtime.onMessage.addListener(onMessage);
    // The badge sums every frame, so a frame that goes away must say so.
    window.addEventListener('pagehide', () => reportCount(0));
    window.addEventListener('pageshow', (e) => { if (e.persisted) reportCount(); });
  }

  function apply() {
    teardown();
    if (!settings.enabled) { reportCount(); return; }

    const text = PatternCopy.compileAll(settings.patterns, location.href);
    compiled = text.filter(c => !c.scope);
    scoped = text.filter(c => c.scope);
    locators = PatternCopy.compileLocators(settings.patterns, location.href);
    if (!compiled.length && !scoped.length && !locators.length) { reportCount(); return; }

    ensureUI();
    startObserver();
    scan([document.body || document.documentElement]);
    reportCount();
  }

  function teardown() {
    stopObserver();
    hideHint(true);
    removeHighlights(document);
    hitCount = 0;
    lastDocPass = 0;
    pendingRoots.clear();
  }

  /* -------------------------------------------------------------- scanning */

  function isSkippable(el) {
    if (!el) return true;
    const cached = skipCache.get(el);
    if (cached !== undefined) return cached;

    let skip = false;
    if (SKIP_TAGS.has(el.tagName)) skip = true;
    else if (el.closest('pattern-copy-root, mark.pcopy-hit, ' + EDITABLE)) skip = true;

    skipCache.set(el, skip);
    return skip;
  }

  function collectTextNodes(root) {
    const start = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
    if (!start || !start.isConnected) return [];
    if (root.nodeType === Node.TEXT_NODE) {
      return isSkippable(start) ? [] : [root];
    }

    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = node.nodeValue;
        if (!value || value.length < 2 || !value.trim()) return NodeFilter.FILTER_REJECT;
        if (isSkippable(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    return nodes;
  }

  function scan(roots) {
    if (document.designMode === 'on') return;
    // Recount instead of accumulating: the page removes highlighted nodes too,
    // and a stale total would eventually stop scanning for good.
    hitCount = countHits();
    if (hitCount >= settings.maxMatches) return;
    scanning = true;
    skipCache = new WeakMap();
    try {
      if (scoped.length || locators.length) lastDocPass = Date.now();
      scanScoped();
      scanText(roots);
      scanLocators();
    } finally {
      // Drop the records our own <mark> insertions just generated.
      if (observer) observer.takeRecords();
      scanning = false;
    }
  }

  function scanText(roots) {
    if (!compiled.length) return;
    for (const root of roots) {
      if (!root || !root.isConnected) continue;
      if (root.nodeType === Node.ELEMENT_NODE && isSkippable(root)) continue;
      for (const node of collectTextNodes(root)) {
        if (hitCount >= settings.maxMatches) return;
        if (!node.isConnected) continue;
        const matches = PatternCopy.findMatches(node.nodeValue, compiled);
        if (matches.length) highlightNode(node, matches);
      }
    }
  }

  /*
   * A `within` locator says where a text pattern may match. Against an element
   * the pattern runs over the text inside it and highlights each substring;
   * against an attribute or a form control it runs over that single value and
   * the hit is anchored on the owning element.
   */
  function scanScoped() {
    if (!scoped.length) return;
    for (const entry of scoped) {
      if (hitCount >= settings.maxMatches) return;

      let resolved;
      try {
        resolved = PatternCopy.resolveScope(document, entry.scope);
      } catch (err) {
        console.warn('[Pattern Copy] scope failed', entry.name, err.message);
        continue;
      }

      for (const element of resolved.elements) {
        for (const node of collectTextNodes(element)) {
          if (hitCount >= settings.maxMatches) return;
          if (!node.isConnected) continue;
          const matches = PatternCopy.findMatches(node.nodeValue, [entry]);
          if (matches.length) highlightNode(node, matches);
        }
      }

      for (const anchor of resolved.values) {
        if (hitCount >= settings.maxMatches) return;
        // An element carries one hit, so only the first match of a value counts.
        const matches = PatternCopy.findMatches(anchor.value || '', [entry]);
        if (matches.length) attachHit(anchor.element, entry, matches[0].copy);
      }
    }
  }

  /*
   * Locators address whole elements, so they are re-evaluated against the
   * whole document rather than against the mutated subtrees: the pass is
   * idempotent because an element that already carries a hit is left alone.
   */
  function scanLocators() {
    if (!locators.length) return;
    for (const locator of locators) {
      if (hitCount >= settings.maxMatches) return;
      let nodes;
      try {
        nodes = PatternCopy.queryLocator(document, locator);
      } catch (err) {
        console.warn('[Pattern Copy] locator failed', locator.name, err.message);
        continue;
      }
      for (const node of nodes) {
        if (hitCount >= settings.maxMatches) return;
        markElement(node, locator);
      }
    }
  }

  function markElement(node, locator) {
    const anchor = PatternCopy.locatorAnchor(node);
    if (!anchor || !anchor.element) return;
    const value = PatternCopy.renderLocatorTemplate(locator.copyTemplate, anchor.value || '', anchor.element);
    attachHit(anchor.element, locator, value);
  }

  /** Tints one element in place and hangs the copy value off it. */
  function attachHit(el, pattern, rawValue) {
    if (!el || !el.isConnected) return false;
    if (el === document.documentElement || el === document.body) return false;
    if (LOCATOR_SKIP_TAGS.has(el.tagName) || el.classList.contains('pcopy-hit')) return false;
    if (el.closest('pattern-copy-root')) return false;

    const value = String(rawValue || '').trim();
    if (!value) return false;

    el.classList.add('pcopy-hit', 'pcopy-hit--el');
    if (!settings.highlight) el.classList.add('pcopy-hit--plain');
    el.dataset.pcopyValue = value;
    el.dataset.pcopyName = pattern.name;
    if (pattern.color) el.style.setProperty('--pcopy-color', pattern.color);
    hitCount++;
    return true;
  }

  function highlightNode(node, matches) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;

    for (const m of matches) {
      if (hitCount >= settings.maxMatches) break;
      if (m.start > last) frag.appendChild(piece(text.slice(last, m.start)));

      const mark = document.createElement('mark');
      mark.className = settings.highlight ? 'pcopy-hit' : 'pcopy-hit pcopy-hit--plain';
      mark.textContent = text.slice(m.start, m.end);
      mark.dataset.pcopyValue = m.copy;
      mark.dataset.pcopyName = m.name;
      if (m.color) mark.style.setProperty('--pcopy-color', m.color);
      frag.appendChild(mark);

      last = m.end;
      hitCount++;
    }

    if (!frag.childNodes.length) return;
    if (last < text.length) frag.appendChild(piece(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  function piece(text) {
    const node = document.createTextNode(text);
    pieces.add(node);
    return node;
  }

  const HIT_CLASSES = ['pcopy-hit', 'pcopy-hit--el', 'pcopy-hit--plain', 'pcopy-hit--active', 'pcopy-hit--copied'];

  /** Every match of `selector` in `root`, `root` itself included. */
  function within(root, selector) {
    const found = [...root.querySelectorAll(selector)];
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) found.unshift(root);
    return found;
  }

  /** Puts every element we touched back exactly as we found it. */
  function unmarkElements(root) {
    for (const el of within(root, '.pcopy-hit--el')) {
      el.classList.remove(...HIT_CLASSES);
      if (!el.classList.length) el.removeAttribute('class');
      delete el.dataset.pcopyValue;
      delete el.dataset.pcopyName;
      el.style.removeProperty('--pcopy-color');
      if (!el.getAttribute('style')) el.removeAttribute('style');
    }
  }

  /*
   * Unwraps every <mark> under `root` and re-joins the text we split, without
   * normalize(): that would also merge the page's own adjacent text nodes,
   * which frameworks keep references to.
   */
  function removeHighlights(root) {
    unmarkElements(root);
    const marks = within(root, 'mark.pcopy-hit');
    if (!marks.length) return;
    const wasScanning = scanning;
    scanning = true;
    const parents = new Set();
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(piece(mark.textContent), mark);
      parents.add(parent);
    }
    for (const parent of parents) mergePieces(parent);
    if (observer) observer.takeRecords();
    scanning = wasScanning;
  }

  function mergePieces(parent) {
    let prev = null;
    for (let node = parent.firstChild; node;) {
      const next = node.nextSibling;
      if (pieces.has(node)) {
        if (prev) { prev.appendData(node.data); node.remove(); }
        else prev = node;
      } else {
        prev = null;
      }
      node = next;
    }
  }

  /* -------------------------------------------------------------- observer */

  function startObserver() {
    stopObserver();
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['contenteditable']
    });
  }

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    clearTimeout(rescanTimer);
    rescanTimer = 0;
  }

  function onMutations(records) {
    if (scanning) return;
    for (const rec of records) {
      if (rec.type === 'characterData') {
        pendingRoots.add(rec.target);
      } else if (rec.type === 'attributes') {
        // A region turned into an editor: get our marks out of the user's text.
        if (rec.target.closest(EDITABLE)) removeHighlights(rec.target);
        else pendingRoots.add(rec.target);
      } else {
        for (const node of rec.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
            pendingRoots.add(node);
          }
        }
      }
    }
    if (!pendingRoots.size || rescanTimer) return;
    let delay = RESCAN_DELAY;
    if (scoped.length || locators.length) {
      delay = Math.max(delay, lastDocPass + DOC_PASS_INTERVAL - Date.now());
    }
    rescanTimer = setTimeout(() => {
      rescanTimer = 0;
      const roots = [...pendingRoots];
      pendingRoots.clear();
      scan(roots);
      reportCount();
    }, delay);
  }

  /* -------------------------------------------------------------- hint UI */

  const HINT_CSS = `
    :host { all: initial; }
    .panel {
      position: fixed;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      border-radius: 8px;
      background: #1d2026;
      color: #f4f6fa;
      font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 4px 14px rgba(0, 0, 0, .3);
      opacity: 0;
      transform: translateY(2px);
      transition: opacity 110ms ease, transform 110ms ease;
      pointer-events: none;
    }
    .panel[data-open="true"] { opacity: 1; transform: none; pointer-events: auto; }
    .name {
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: .65;
      padding-left: 2px;
    }
    button {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 6px;
      background: #2f6feb;
      color: #fff;
      cursor: pointer;
      font: inherit;
    }
    button:hover { background: #3d7ef5; }
    button:focus-visible { outline: 2px solid #9ec5ff; outline-offset: 1px; }
    .panel[data-state="copied"] button { background: #2ea043; }
    .panel[data-state="failed"] button { background: #b4303a; }
    svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2;
          stroke-linecap: round; stroke-linejoin: round; }
  `;

  function ensureUI() {
    if (ui && ui.host.isConnected) return ui;

    const host = document.createElement('pattern-copy-root');
    host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = HINT_CSS;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.dataset.open = 'false';

    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML =
      '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/>' +
      '<path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span class="btn-label">Copy</span>';

    const name = document.createElement('span');
    name.className = 'name';

    panel.append(button, name);
    shadow.append(style, panel);
    (document.body || document.documentElement).appendChild(host);

    ui = { host, shadow, panel, button, name, label: button.querySelector('.btn-label'), hideTimer: 0 };

    panel.addEventListener('mouseenter', () => clearTimeout(ui.hideTimer));
    panel.addEventListener('mouseleave', () => scheduleHide());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (activeHit) copyHit(activeHit);
    });

    document.addEventListener('mouseover', onPointerOver, true);
    document.addEventListener('mouseout', onPointerOut, true);
    document.addEventListener('click', onDocumentClick, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange, true);

    return ui;
  }

  function hitFrom(target) {
    if (!target || target.nodeType !== Node.ELEMENT_NODE) {
      target = target && target.parentElement;
    }
    return target && target.closest ? target.closest('.pcopy-hit') : null;
  }

  function onPointerOver(e) {
    if (!settings || !settings.showHint) return;
    const hit = hitFrom(e.target);
    if (!hit || hit === activeHit) return;
    showHint(hit);
  }

  function onPointerOut(e) {
    if (!activeHit) return;
    const to = e.relatedTarget;
    if (to && (hitFrom(to) === activeHit || (ui && ui.host.contains(to)))) return;
    scheduleHide();
  }

  function onDocumentClick(e) {
    if (!settings || !settings.clickToCopy) return;
    const hit = hitFrom(e.target);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    copyHit(hit);
  }

  function onViewportChange() {
    if (!activeHit) return;
    if (!activeHit.isConnected) { hideHint(true); return; }
    positionHint(activeHit);
  }

  function showHint(hit) {
    ensureUI();
    clearTimeout(ui.hideTimer);
    if (activeHit && activeHit !== hit) activeHit.classList.remove('pcopy-hit--active');
    activeHit = hit;
    hit.classList.add('pcopy-hit--active');
    ui.panel.dataset.state = 'idle';
    ui.label.textContent = 'Copy';
    ui.name.textContent = hit.dataset.pcopyName || '';
    ui.panel.dataset.open = 'true';
    positionHint(hit);
  }

  function scheduleHide() {
    if (!ui) return;
    clearTimeout(ui.hideTimer);
    ui.hideTimer = setTimeout(() => hideHint(), HINT_HIDE_DELAY);
  }

  function hideHint(immediate) {
    if (!ui) return;
    clearTimeout(ui.hideTimer);
    ui.panel.dataset.open = 'false';
    if (activeHit) activeHit.classList.remove('pcopy-hit--active');
    activeHit = null;
    if (immediate) ui.panel.dataset.state = 'idle';
  }

  function positionHint(hit) {
    const rect = hit.getBoundingClientRect();
    const panel = ui.panel;
    // Measure while visible; the panel is already laid out at this point.
    const width = panel.offsetWidth || 90;
    const height = panel.offsetHeight || 26;

    let left = rect.left;
    let top = rect.top - height - 6;
    if (top < 4) top = Math.min(rect.bottom + 6, window.innerHeight - height - 4);
    left = Math.max(4, Math.min(left, window.innerWidth - width - 4));

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  /* ---------------------------------------------------------- clipboard */

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return legacyCopy(text);
    }
  }

  /** navigator.clipboard is blocked on some pages (no focus, strict CSP). */
  function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    area.remove();
    return ok;
  }

  async function copyHit(hit) {
    const value = hit.dataset.pcopyValue || hit.textContent;
    const ok = await writeClipboard(value);
    if (ui) {
      ui.panel.dataset.state = ok ? 'copied' : 'failed';
      ui.label.textContent = ok ? 'Copied' : 'Failed';
      clearTimeout(ui.hideTimer);
      ui.hideTimer = setTimeout(() => hideHint(), 900);
    }
    if (ok) {
      hit.classList.add('pcopy-hit--copied');
      setTimeout(() => hit.classList.remove('pcopy-hit--copied'), 650);
    }
  }

  /** This frame's values; the popup merges every frame's before copying. */
  function collectValues() {
    return [...document.querySelectorAll('.pcopy-hit')]
      .map(m => m.dataset.pcopyValue || m.textContent)
      .filter(Boolean);
  }

  /* ---------------------------------------------------------- messaging */

  function onMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'pcopy:getCount':
        return Promise.resolve({ count: countHits(), enabled: !!(settings && settings.enabled) });
      case 'pcopy:values':
        return Promise.resolve({ values: collectValues() });
      case 'pcopy:writeText':
        return writeClipboard(String(msg.text || '')).then(ok => ({ ok }));
      case 'pcopy:rescan':
        apply();
        return Promise.resolve({ count: countHits() });
    }
  }

  function countHits() {
    return document.querySelectorAll('.pcopy-hit').length;
  }

  /** Every frame reports; the background sums them per tab for the badge. */
  function reportCount(count) {
    try {
      const sent = api.runtime.sendMessage({
        type: 'pcopy:count',
        count: count === undefined ? countHits() : count
      });
      if (sent && sent.catch) sent.catch(() => {});
    } catch (_) { /* background may be asleep */ }
  }

  init();
})();
