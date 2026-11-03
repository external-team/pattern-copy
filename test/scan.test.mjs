/*
 * Runs the real content script inside jsdom against the sample page.
 * `npm test` (needs `npm i --no-save jsdom`).
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const dom = new JSDOM(read('test/sample.html'), {
  url: 'https://example.test/sample',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;

let stored = {};
const listeners = [];
window.patternCopyApi = {
  storage: {
    local: { get: async () => stored, set: async (v) => { stored = v; } },
    onChanged: { addListener: (fn) => listeners.push(fn) }
  },
  runtime: {
    onMessage: { addListener: () => {} },
    sendMessage: () => {}
  }
};

window.eval(read('src/common/patterns.js'));
const V = window.PatternCopy;

// Defaults plus a few locators, so one jsdom boot covers both families.
const settings = V.defaults();
settings.patterns.push(
  V.makePattern({ id: 'l_build', name: 'Build id', type: 'locator', value: 'id=build-id' }),
  V.makePattern({ id: 'l_status', name: 'Status', type: 'locator', value: 'css=td.status' }),
  V.makePattern({ id: 'l_href', name: 'Artifact URL', type: 'locator', value: '//a[@class="dl"]/@href' }),
  V.makePattern({ id: 'l_sha', name: 'Artifact SHA', type: 'locator', value: 'css=a.dl', copyTemplate: '$@data-sha' }),
  V.makePattern({ id: 'l_rev', name: 'Revision', type: 'locator', value: 'css=.rev', copyTemplate: '$@data-rev' }),
  V.makePattern({ id: 'l_ticket', name: 'Ticket', type: 'locator', value: 'name=ticket' }),
  V.makePattern({ id: 'l_link', name: 'Download link', type: 'locator', value: 'link text=Download artifact' }),
  V.makePattern({ id: 'l_scoped', name: 'Elsewhere only', type: 'locator', value: 'css=table', sites: '*.other.test/*' }),
  // `within` + regex: the locator says where, the pattern says what.
  V.makePattern({
    id: 's_ticket', name: 'Ticket key', type: 'regex',
    within: '//a[@class="ticket"]/@href',
    value: '/browse/([A-Z]+-\\d+)', copyTemplate: '$1'
  }),
  V.makePattern({
    id: 's_logip', name: 'Log cell IP', type: 'regex',
    within: 'css=td.log',
    value: '\\b10\\.\\d+\\.\\d+\\.\\d+\\b'
  })
);
stored = { settings };

window.eval(read('src/content/content.js'));

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
await tick(50);

const hits = [...window.document.querySelectorAll('mark.pcopy-hit')];
const values = hits.map((h) => h.dataset.pcopyValue);
const named = (name) => hits.filter((h) => h.dataset.pcopyName === name).map((h) => h.textContent);

console.log(`${hits.length} hits:`, values);

assert.ok(values.includes('/var/log/myapp/agent.log'), 'unix path in <code>');
assert.ok(values.includes('/etc/myapp/app.conf'), 'second unix path');
assert.ok(values.includes('10.28.4.17'), 'ipv4 inside <b>');
assert.ok(values.includes('192.168.0.1'), 'bare ipv4');
assert.ok(values.includes('3f2a9c7e-1b4d-4a8e-9c2f-77ab10d5e6f1'), 'uuid');
assert.ok(named('Windows path').some((v) => v.startsWith('C:\\Program Files')), 'windows path');
assert.ok(values.some((v) => v === '/var/log/messages'), 'path inside <pre>');

// Disabled by default.
assert.equal(named('Email').length, 0, 'email pattern is off by default');
assert.equal(named('Git SHA').length, 0, 'sha pattern is off by default');

// contenteditable and <script> contents must be left alone.
const editable = window.document.querySelector('[contenteditable="true"]');
assert.equal(editable.querySelectorAll('mark.pcopy-hit').length, 0, 'contenteditable untouched');
assert.equal(window.document.querySelector('script').querySelectorAll('*').length, 0, 'script untouched');

// Visible text must survive highlighting byte for byte.
assert.ok(
  window.document.body.textContent.includes('C:\\Program Files\\MyApp\\bin\\myapp.exe'),
  'page text unchanged'
);

// The floating hint lives in a shadow root, outside the page's own DOM.
const host = window.document.querySelector('pattern-copy-root');
assert.ok(host && host.shadowRoot.querySelector('button'), 'hint UI attached');

// MutationObserver picks up content added after the first scan.
const extra = window.document.createElement('p');
extra.textContent = 'later: /srv/data/volume-9/state.json on 172.16.9.5';
window.document.body.appendChild(extra);
await tick(1600);   // locators are configured, so rescans are throttled (DOC_PASS_INTERVAL)
assert.equal(extra.querySelectorAll('mark.pcopy-hit').length, 2, 'added node rescanned');

// A rescan must not re-wrap what is already wrapped.
const before = window.document.querySelectorAll('mark.pcopy-hit').length;
window.document.body.appendChild(window.document.createElement('span'));
await tick(1600);   // locators are configured, so rescans are throttled (DOC_PASS_INTERVAL)
assert.equal(window.document.querySelectorAll('mark.pcopy-hit').length, before, 'no double wrapping');

/* ------------------------------------------------------------- locators */

const els = [...window.document.querySelectorAll('.pcopy-hit--el')];
const byName = (name) => els.filter((e) => e.dataset.pcopyName === name);
const copyOf = (name) => byName(name).map((e) => e.dataset.pcopyValue);

console.log(`${els.length} element hits:`, els.map((e) => `${e.dataset.pcopyName}=${e.dataset.pcopyValue}`));

assert.deepEqual(copyOf('Build id'), ['4812'], 'Selenium id= strategy');
assert.deepEqual(copyOf('Status'), ['passed', 'failed'], 'css= strategy, every match');
assert.deepEqual(copyOf('Artifact URL'),
  ['/artifacts/pattern-copy-0.1.0.zip', '/artifacts/pattern-copy-0.0.9.zip'],
  'XPath attribute node copies the attribute, anchored on its owner');
assert.equal(byName('Artifact URL')[0].tagName, 'A', 'attribute hit anchors to the owner element');
assert.deepEqual(copyOf('Revision'), ['r4812'], '$@attr template');
assert.deepEqual(copyOf('Ticket'), ['PROJ-1042'], 'a form control copies its value, not its text');
assert.deepEqual(copyOf('Download link'), [], 'an element is claimed by one locator only');
assert.deepEqual(copyOf('Elsewhere only'), [], 'site glob excludes this page');

// `a.dl` is already claimed by the XPath href locator, so $@data-sha never lands.
assert.deepEqual(copyOf('Artifact SHA'), [], 'first locator in the list wins an element');

// Text patterns still run inside a locator-marked element.
const statusCell = window.document.querySelector('td.status');
assert.ok(statusCell.classList.contains('pcopy-hit'), 'element hit marked in place, not re-wrapped');
assert.equal(statusCell.children.length, 0, 'locator hit does not restructure the element');

/* ------------------------------------------------- within = locator + regex */

// An attribute scope: the regex runs over the href, the hit sits on the <a>.
assert.deepEqual(copyOf('Ticket key'), ['PROJ-1042', 'PROJ-998'],
  'regex applied to the located attribute value, non-matching href dropped');
assert.ok(byName('Ticket key').every((e) => e.tagName === 'A'), 'anchored on the owning element');

// An element scope: the regex highlights substrings inside, not the whole cell.
const scopedIps = [...window.document.querySelectorAll('mark.pcopy-hit')]
  .filter((m) => m.dataset.pcopyName === 'Log cell IP');
assert.deepEqual(scopedIps.map((m) => m.dataset.pcopyValue), ['10.1.1.4', '10.1.1.5'],
  'substring highlight inside the scope');
assert.ok(scopedIps.every((m) => m.closest('td.log')), 'every scoped hit is inside the scope');
assert.ok(!window.document.querySelector('td.log').classList.contains('pcopy-hit--el'),
  'an element scope is not itself marked');

// The page-wide IPv4 pattern still claims the address outside the table, and the
// scoped pattern never reaches it.
const outside = [...window.document.querySelectorAll('mark.pcopy-hit')]
  .find((m) => m.dataset.pcopyValue === '10.9.9.9');
assert.ok(outside, 'text outside the scope is still matched by the global pattern');
assert.equal(outside.dataset.pcopyName, 'IPv4 address', 'and is attributed to the global pattern');

/* ---------------------------------------------------------- review fixes */

const doc = window.document;
const reapply = async (over) => {
  stored = { settings: Object.assign({}, settings, over) };
  for (const fn of listeners) fn({ settings: {} }, 'sync');
  await tick(60);
};

// The page's own adjacent text nodes survive a highlight/unhighlight cycle untouched.
const own = doc.createElement('p');
const ownA = doc.createTextNode('alpha ');
const ownB = doc.createTextNode('beta ');
own.append(ownA, ownB, doc.createTextNode('host 10.20.30.40 end'));
doc.body.appendChild(own);
await tick(1600);
assert.equal(own.querySelectorAll('mark.pcopy-hit').length, 1, 'own paragraph highlighted');
await reapply({});   // full teardown + rescan
await reapply({ enabled: false });
assert.equal(own.childNodes.length, 3, 'our split pieces merged back, page nodes left separate');
assert.ok(own.childNodes[0] === ownA && own.childNodes[1] === ownB, 'page text nodes keep their identity');
assert.equal(own.textContent, 'alpha beta host 10.20.30.40 end');
await reapply({});

// A region that becomes contenteditable after the scan is cleaned and then left alone.
const editor = doc.createElement('div');
editor.innerHTML = '<p>gateway 10.7.7.7</p>';
doc.body.appendChild(editor);
await tick(1600);
assert.equal(editor.querySelectorAll('mark.pcopy-hit').length, 1, 'scanned while still plain');
editor.setAttribute('contenteditable', 'true');
await tick(0);
assert.equal(editor.querySelectorAll('mark.pcopy-hit').length, 0, 'marks removed when it turns editable');
assert.equal(editor.querySelector('p').childNodes.length, 1, 'editor text re-joined');
editor.querySelector('p').append(' and 10.8.8.8');
await tick(1600);
assert.equal(editor.querySelectorAll('mark.pcopy-hit').length, 0, 'typing in the editor is not highlighted');
editor.remove();

// The match cap follows what is on the page, not a running total.
await reapply({ maxMatches: 5 });
assert.equal(doc.querySelectorAll('.pcopy-hit').length, 5, 'capped');
for (const h of [...doc.querySelectorAll('.pcopy-hit')]) h.remove();
const fresh = doc.createElement('p');
fresh.textContent = 'next view: 10.3.3.3 and 10.4.4.4';
doc.body.appendChild(fresh);
await tick(1600);
assert.equal(fresh.querySelectorAll('mark.pcopy-hit').length, 2, 'hits removed by the page free up the cap');
own.remove();
fresh.remove();
await reapply({});

// Teardown must leave the page exactly as it was found.
const htmlBefore = window.document.querySelector('table').outerHTML;
stored = { settings: Object.assign({}, settings, { enabled: false }) };
for (const fn of listeners) fn({ settings: {} }, 'local');
await tick(60);
assert.equal(window.document.querySelectorAll('.pcopy-hit').length, 0, 'all hits removed when disabled');
const table = window.document.querySelector('table');
assert.ok(!table.outerHTML.includes('pcopy'), 'no leftover classes, data- or style props');
assert.ok(!/class=""|style=""/.test(table.outerHTML), 'no empty attributes left behind');

console.log('\nAll content-script assertions passed.');
