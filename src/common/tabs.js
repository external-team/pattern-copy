/*
 * Talks to the content script in every frame of a tab. tabs.sendMessage
 * without a frameId reaches all frames but resolves with whichever answers
 * first, so the frames are enumerated and messaged one by one instead.
 * Used by the popup and the background page.
 */
(function (global) {
  'use strict';

  /** Frame ids we may script in this tab, top frame first. */
  async function frameIds(api, tabId) {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => 0
      });
      const ids = [...new Set(results.map(r => r.frameId))].sort((a, b) => a - b);
      return ids.length ? ids : [0];
    } catch (_) {
      return [0];
    }
  }

  /** One reply per frame that has the content script; frames without it are dropped. */
  async function sendToFrames(api, tabId, message) {
    const ids = await frameIds(api, tabId);
    const replies = await Promise.all(ids.map(frameId =>
      api.tabs.sendMessage(tabId, message, { frameId })
        .then(reply => (reply ? { frameId, reply } : null))
        .catch(() => null)));
    return replies.filter(Boolean);
  }

  async function countAll(api, tabId) {
    const replies = await sendToFrames(api, tabId, { type: 'pcopy:getCount' });
    const count = replies.reduce((n, r) => n + (r.reply.count || 0), 0);
    return { count, reachable: replies.length > 0 };
  }

  async function rescanAll(api, tabId) {
    const replies = await sendToFrames(api, tabId, { type: 'pcopy:rescan' });
    const count = replies.reduce((n, r) => n + (r.reply.count || 0), 0);
    return { count, reachable: replies.length > 0 };
  }

  /** Gathers every frame's values and writes them in one go, from the top frame if it can. */
  async function copyAll(api, tabId) {
    const replies = await sendToFrames(api, tabId, { type: 'pcopy:values' });
    const values = replies.flatMap(r => r.reply.values || []);
    const unique = [...new Set(values)].filter(Boolean);
    if (!unique.length) return { copied: 0 };

    const text = unique.join('\n');
    for (const { frameId } of replies) {
      try {
        const res = await api.tabs.sendMessage(tabId, { type: 'pcopy:writeText', text }, { frameId });
        if (res && res.ok) return { copied: unique.length };
      } catch (_) { /* try the next frame */ }
    }
    return { copied: 0 };
  }

  global.PatternCopyTabs = { frameIds, sendToFrames, countAll, rescanAll, copyAll };
})(globalThis);
