/* Keeps the toolbar badge in sync and services the keyboard commands. */
(function () {
  'use strict';

  const api = globalThis.patternCopyApi;

  const BADGE_BG = '#1f6feb';

  function setBadge(tabId, count) {
    if (typeof tabId !== 'number') return;
    const text = count > 0 ? (count > 999 ? '999+' : String(count)) : '';
    api.action.setBadgeText({ tabId, text }).catch(() => {});
    if (api.action.setBadgeBackgroundColor) {
      api.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG }).catch(() => {});
    }
  }

  /*
   * Every frame reports its own count; the badge shows the tab's total.
   * The background page is an event page and may be unloaded, so the
   * per-frame counts live in storage.session rather than in a variable.
   */
  const memory = {};
  const session = (api.storage && api.storage.session) || {
    get: async (key) => ({ [key]: memory[key] }),
    set: async (items) => { Object.assign(memory, items); },
    remove: async (key) => { delete memory[key]; }
  };
  const countsKey = (tabId) => 'counts:' + tabId;
  let queue = Promise.resolve();

  /** Serialised, so two frames reporting at once can't lose each other's update. */
  function recordCount(tabId, frameId, count) {
    queue = queue.then(async () => {
      const key = countsKey(tabId);
      const counts = (await session.get(key))[key] || {};
      if (count > 0) counts[frameId] = count; else delete counts[frameId];
      if (Object.keys(counts).length) await session.set({ [key]: counts });
      else await session.remove(key);
      setBadge(tabId, Object.values(counts).reduce((a, b) => a + b, 0));
    }).catch(() => {});
    return queue;
  }

  function forgetTab(tabId) {
    queue = queue.then(() => session.remove(countsKey(tabId))).catch(() => {});
  }

  api.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'pcopy:count' || !sender.tab) return;
    recordCount(sender.tab.id, sender.frameId || 0, msg.count);
  });

  api.tabs.onRemoved.addListener(forgetTab);
  api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // A top-level navigation drops every frame of the old page.
    if (changeInfo.status === 'loading' && changeInfo.url) forgetTab(tabId);
  });

  /*
   * Nothing is written here: on a fresh install storage.sync may not have
   * pulled this account's settings yet, and writing defaults now would
   * overwrite them on every synced device. loadSettings falls back to the
   * defaults on its own.
   */
  api.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'install') return;
    api.runtime.openOptionsPage().catch(() => {});
  });

  async function activeTab() {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function copyAllInActiveTab() {
    const tab = await activeTab();
    if (!tab) return;
    // Frames without the content script (about:, addons.mozilla.org, ...) are skipped.
    await PatternCopyTabs.copyAll(api, tab.id);
  }

  async function toggleEnabled() {
    const settings = await PatternCopy.loadSettings(api);
    settings.enabled = !settings.enabled;
    await PatternCopy.saveSettings(api, settings).catch((err) => {
      console.warn('[Pattern Copy] could not save settings', err && err.message);
    });
  }

  if (api.commands && api.commands.onCommand) {
    api.commands.onCommand.addListener((command) => {
      if (command === 'copy-all-matches') copyAllInActiveTab();
      else if (command === 'toggle-enabled') toggleEnabled();
    });
  }
})();
