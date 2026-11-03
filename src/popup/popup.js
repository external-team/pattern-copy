/* Toolbar popup: quick toggle, what applies here, and the bulk copy action. */
(function () {
  'use strict';

  const api = globalThis.patternCopyApi;

  const enabledBox = document.getElementById('enabled');
  const summary = document.getElementById('summary');
  const list = document.getElementById('patterns');
  const copyAllBtn = document.getElementById('copy-all');
  const rescanBtn = document.getElementById('rescan');
  const optionsBtn = document.getElementById('options');

  let settings = null;
  let tab = null;

  // Every frame is asked, so matches inside iframes count and get copied too.
  const frames = {
    count: () => (tab ? PatternCopyTabs.countAll(api, tab.id) : { count: 0, reachable: false }),
    rescan: () => (tab ? PatternCopyTabs.rescanAll(api, tab.id) : { count: 0, reachable: false }),
    copyAll: () => (tab ? PatternCopyTabs.copyAll(api, tab.id) : { copied: 0 })
  };

  function renderPatterns() {
    list.textContent = '';
    const url = (tab && tab.url) || '';
    const applicable = settings.patterns.filter(p =>
      p.enabled && p.value && (!url || PatternCopy.patternAppliesTo(p, url)));

    if (!applicable.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No patterns active for this page.';
      list.append(li);
      return;
    }

    for (const p of applicable) {
      const li = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = p.color;
      const name = document.createElement('span');
      name.textContent = p.name;
      if (p.type === 'locator') {
        try {
          const resolved = PatternCopy.parseLocator(p.value);
          name.title = `${resolved.strategy}: ${resolved.query}`;
        } catch (_) { /* invalid locators are already skipped in the page */ }
      }
      li.append(swatch, name);
      list.append(li);
    }
  }

  function setSummary(count, reachable) {
    if (!settings.enabled) {
      summary.textContent = 'Highlighting is off.';
    } else if (!reachable) {
      summary.textContent = 'Pattern Copy cannot run on this page.';
    } else {
      summary.textContent = '';
      const strong = document.createElement('strong');
      strong.textContent = String(count);
      summary.append(strong, ` match${count === 1 ? '' : 'es'} on this page.`);
    }
    copyAllBtn.disabled = !settings.enabled || !reachable || !count;
    rescanBtn.disabled = !reachable;
  }

  async function refresh() {
    const state = await frames.count();
    setSummary(state.count, state.reachable);
  }

  async function init() {
    [tab] = await api.tabs.query({ active: true, currentWindow: true });
    settings = await PatternCopy.loadSettings(api);

    enabledBox.checked = settings.enabled;
    renderPatterns();
    await refresh();

    enabledBox.addEventListener('change', async () => {
      settings.enabled = enabledBox.checked;
      try {
        await PatternCopy.saveSettings(api, settings);
      } catch (err) {
        enabledBox.checked = settings.enabled = !enabledBox.checked;
        summary.textContent = 'Could not save: ' + ((err && err.message) || err);
        return;
      }
      // Let the content script react to storage before re-counting.
      setTimeout(refresh, 250);
    });

    copyAllBtn.addEventListener('click', async () => {
      const n = (await frames.copyAll()).copied;
      copyAllBtn.textContent = n ? `Copied ${n} unique value${n === 1 ? '' : 's'}` : 'Nothing to copy';
      setTimeout(() => { copyAllBtn.textContent = 'Copy all matches'; }, 1400);
    });

    rescanBtn.addEventListener('click', async () => {
      const result = await frames.rescan();
      setSummary(result.count, result.reachable);
    });

    optionsBtn.addEventListener('click', () => {
      api.runtime.openOptionsPage();
      window.close();
    });
  }

  init();
})();
