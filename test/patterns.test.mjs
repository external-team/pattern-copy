/* Unit tests for the shared pattern model. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({ console });
vm.runInContext(readFileSync(join(root, 'src/common/patterns.js'), 'utf8'), ctx);
const V = ctx.PatternCopy;

const one = (pattern, text) => V.findMatches(text, V.compileAll([V.makePattern(pattern)], null));

/* --- glob ------------------------------------------------------------ */
{
  const m = one({ type: 'glob', value: '/var/log/**/*.log' },
    'tail /var/log/myapp/agent.log and /var/log/a/b/c.log done');
  assert.deepEqual(Array.from(m, x => x.text), ['/var/log/myapp/agent.log', '/var/log/a/b/c.log']);
}
{
  // A single * must not cross a separator.
  const m = one({ type: 'glob', value: '/etc/*.conf' }, 'in /etc/myapp/app.conf and /etc/hosts.conf');
  assert.deepEqual(Array.from(m, x => x.text), ['/etc/hosts.conf']);
}
{
  // ? is exactly one character.
  const m = one({ type: 'glob', value: 'id-???' }, 'id-101 id-10 id-1012');
  assert.deepEqual(Array.from(m, x => x.text), ['id-101', 'id-101']);
}

/* --- text ------------------------------------------------------------ */
{
  const m = one({ type: 'text', value: 'a.b' }, 'a.b and axb');
  assert.deepEqual(Array.from(m, x => x.text), ['a.b'], 'text type is literal, not regex');
}

/* --- copy template --------------------------------------------------- */
{
  const m = one(
    { type: 'regex', value: 'PID (?<id>\\d+)', copyTemplate: 'kill $<id>' },
    'stop PID 101 now');
  assert.equal(m[0].text, 'PID 101');
  assert.equal(m[0].copy, 'kill 101');
}
{
  const m = one({ type: 'regex', value: '(\\w+)@(\\w+)', copyTemplate: '$2/$1 $$' }, 'bob@host');
  assert.equal(m[0].copy, 'host/bob $');
}

/* --- overlap resolution ---------------------------------------------- */
{
  const compiled = V.compileAll([
    V.makePattern({ name: 'short', type: 'regex', value: '/var' }),
    V.makePattern({ name: 'long', type: 'regex', value: '/var/log/\\w+' })
  ], null);
  const m = V.findMatches('see /var/log/syslog', compiled);
  assert.deepEqual(Array.from(m, x => x.text), ['/var/log/syslog'], 'longest match wins');
}

/* --- site scoping ----------------------------------------------------- */
{
  const p = V.makePattern({ sites: '*.example.com/*' });
  assert.ok(V.patternAppliesTo(p, 'https://docs.example.com/guide'));
  assert.ok(!V.patternAppliesTo(p, 'https://example.org/guide'));
  assert.ok(V.patternAppliesTo(V.makePattern({ sites: '*' }), 'https://anything/'));
  assert.ok(V.patternAppliesTo(V.makePattern({ sites: 'jira.local' }), 'https://jira.local/browse/X-1'));
}

/* --- invalid patterns are skipped, not fatal -------------------------- */
{
  const compiled = V.compileAll([
    V.makePattern({ name: 'broken', type: 'regex', value: '([' }),
    V.makePattern({ name: 'fine', type: 'regex', value: '\\d+' })
  ], null);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].name, 'fine');
}

/* --- flags ------------------------------------------------------------ */
{
  const m = one({ type: 'regex', value: 'abc', flags: 'i' }, 'ABC abc');
  assert.equal(m.length, 2);
  assert.throws(() => V.toRegExp(V.makePattern({ type: 'regex', value: '' })), /empty/);
}

/* --- locators --------------------------------------------------------- */
{
  const resolve = (v) => {
    const r = V.parseLocator(v);
    return [r.strategy, r.kind, r.query, r.explicit];
  };

  // Bare values are auto-detected.
  assert.deepEqual(resolve('//code'), ['xpath', 'xpath', '//code', false]);
  assert.deepEqual(resolve('(//td)[2]'), ['xpath', 'xpath', '(//td)[2]', false]);
  assert.deepEqual(resolve('./span'), ['xpath', 'xpath', './span', false]);
  assert.deepEqual(resolve('div.foo > span'), ['css', 'css', 'div.foo > span', false]);

  // Selenium's strategies, in both their short and official spellings.
  assert.deepEqual(resolve('xpath=//a/@href'), ['xpath', 'xpath', '//a/@href', true]);
  assert.deepEqual(resolve('css selector=.a .b'), ['css', 'css', '.a .b', true]);
  assert.deepEqual(resolve('id=build'), ['id', 'css', '[id="build"]', true]);
  assert.deepEqual(resolve('name=ticket'), ['name', 'css', '[name="ticket"]', true]);
  assert.deepEqual(resolve('class name=mono'), ['class', 'css', '[class~="mono"]', true]);
  assert.deepEqual(resolve('tag name=pre'), ['tag', 'css', 'pre', true]);
  assert.deepEqual(resolve('link text=Go'), ['link', 'xpath', '//a[normalize-space(.)="Go"]', true]);
  assert.deepEqual(resolve('partial link text=Go'),
    ['partial', 'xpath', '//a[contains(normalize-space(.), "Go")]', true]);

  // A selector containing '=' must not be mistaken for a strategy prefix.
  assert.deepEqual(resolve('input[name=ticket]'), ['css', 'css', 'input[name=ticket]', false]);

  // Quotes in a link text can't be backslash-escaped in XPath.
  assert.equal(V.parseLocator('link=Say "hi"').query, '//a[normalize-space(.)=\'Say "hi"\']');
  assert.equal(
    V.parseLocator('link=it\'s "x"').query,
    '//a[normalize-space(.)=concat("it\'s ", \'"\', "x", \'"\', "")]');

  assert.throws(() => V.parseLocator('   '), /empty/);
  assert.throws(() => V.parseLocator('xpath='), /has no value/);

  // Locators are kept out of the text scanner and compiled on their own.
  const patterns = [
    V.makePattern({ name: 'text', type: 'regex', value: '\\d+' }),
    V.makePattern({ name: 'loc', type: 'locator', value: 'css=.x' }),
    V.makePattern({ name: 'broken', type: 'locator', value: 'xpath=' })
  ];
  assert.deepEqual(Array.from(V.compileAll(patterns, null), c => c.name), ['text']);
  assert.deepEqual(Array.from(V.compileLocators(patterns, null), c => c.name), ['loc']);
}

/* --- locator copy templates ------------------------------------------- */
{
  const el = { getAttribute: (n) => ({ href: '/b/1', 'data-id': '42' }[n] ?? null) };
  assert.equal(V.renderLocatorTemplate('', 'Build 1', el), 'Build 1');
  assert.equal(V.renderLocatorTemplate('$0', 'Build 1', el), 'Build 1');
  assert.equal(V.renderLocatorTemplate('$@href', 'Build 1', el), '/b/1');
  assert.equal(V.renderLocatorTemplate('id $@data-id at $@href', 'x', el), 'id 42 at /b/1');
  assert.equal(V.renderLocatorTemplate('$@missing', 'x', el), '', 'absent attribute is empty');
  assert.equal(V.renderLocatorTemplate('$$0', 'x', el), '$0', 'escaped dollar');
}

/* --- within: locator + pattern ---------------------------------------- */
{
  const scoped = V.makePattern({
    name: 'ticket', type: 'regex', within: '//a/@href',
    value: '/browse/([A-Z]+-\\d+)', copyTemplate: '$1'
  });
  const plain = V.makePattern({ name: 'ip', type: 'regex', value: '\\d+\\.\\d+' });

  const compiled = V.compileAll([scoped, plain], null);
  assert.equal(compiled.length, 2, 'scoped patterns stay in the text family');
  assert.deepEqual(
    [compiled[0].scope.kind, compiled[0].scope.query], ['xpath', '//a/@href']);
  assert.equal(compiled[1].scope, null, 'an unscoped pattern has no scope');

  // The matcher itself is unchanged; only where it is applied differs.
  assert.deepEqual(
    Array.from(V.findMatches('/jira/browse/PROJ-7?a=1', [compiled[0]]), m => m.copy), ['PROJ-7']);

  // Locators have no second half, so `within` is pointless there but still checked.
  const badScope = V.makePattern({ name: 'x', type: 'regex', within: 'xpath=', value: 'a' });
  assert.deepEqual(Array.from(V.compileAll([badScope], null), c => c.name), [],
    'a pattern with an unparseable scope is skipped, not fatal');
  assert.throws(() => V.validate(badScope), /^Error: Within:/,
    'the scope error is labelled so the UI can flag the right field');

  // Site scoping and `within` are independent.
  const elsewhere = V.makePattern({
    name: 'y', type: 'regex', value: 'a', within: 'css=td', sites: '*.other.test/*'
  });
  assert.deepEqual(Array.from(V.compileAll([elsewhere], 'https://here.test/'), c => c.name), []);
  assert.deepEqual(Array.from(V.compileAll([elsewhere], 'https://x.other.test/'), c => c.name), ['y']);
}

/* --- review fixes ----------------------------------------------------- */
{
  // `**/` also matches zero directories.
  const m = one({ type: 'glob', value: '/var/log/**/*.log' }, 'see /var/log/app.log and /var/log/x/y.log');
  assert.deepEqual(Array.from(m, x => x.text), ['/var/log/app.log', '/var/log/x/y.log']);
  const w = one({ type: 'glob', value: 'C:\\logs\\**\\*.txt' }, 'C:\\logs\\a.txt C:\\logs\\d\\b.txt');
  assert.deepEqual(Array.from(w, x => x.text), ['C:\\logs\\a.txt', 'C:\\logs\\d\\b.txt']);
}
{
  // Site globs without a trailing * still cover the paths below them.
  const at = (sites, url) => V.patternAppliesTo(V.makePattern({ sites }), url);
  assert.ok(at('*.example.com', 'https://docs.example.com/guide'));
  assert.ok(!at('*.example.com', 'https://evil.test/x.example.com'), 'host * stays inside the host');
  assert.ok(at('github.com/org', 'https://github.com/org/repo'));
  assert.ok(!at('github.com/org', 'https://github.com/organization'));
  assert.ok(at('github.com', 'https://github.com'));
  assert.ok(!at('github.com', 'https://github.community/t'));
  assert.ok(at('localhost', 'http://localhost:8080/app'));
  assert.ok(at('https://*.example.com/*', 'https://a.example.com/b'));
}
{
  // A stale `within` on a locator is ignored, so it can't block saving.
  assert.doesNotThrow(() => V.validate(V.makePattern({ type: 'locator', value: 'css=code', within: '//td[' })));
}
{
  // Settings round-trip through storage in chunks that fit storage.sync's per-item cap.
  let data = {};
  const changes = [];
  const sync = {
    get: async () => JSON.parse(JSON.stringify(data)),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) {
        assert.ok(k.length + JSON.stringify(v).length <= 8192, `item ${k} over QUOTA_BYTES_PER_ITEM`);
      }
      changes.push(Object.keys(items));
      Object.assign(data, JSON.parse(JSON.stringify(items)));
    },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; }
  };
  const api = { storage: { sync } };

  const fresh = await V.loadSettings(api);
  assert.equal(fresh.patterns.length, V.defaults().patterns.length, 'empty storage gives defaults');

  const big = V.defaults();
  for (let i = 0; i < 80; i++) {
    big.patterns.push(V.makePattern({ name: 'p' + i, value: '\\b(?:' + 'x\\d+\\\\é'.repeat(30) + ')\\b' }));
  }
  await V.saveSettings(api, big);
  assert.ok(Object.keys(data).filter(k => k.startsWith('settings.p')).length > 1, 'split into chunks');
  const back = await V.loadSettings(api);
  assert.equal(JSON.stringify(back.patterns), JSON.stringify(big.patterns), 'patterns survive the round trip');
  assert.ok(!('patternChunks' in back), 'bookkeeping does not leak into settings');
  assert.ok(V.isSettingsChange({ 'settings.p3': {} }) && !V.isSettingsChange({ other: {} }));

  // Shrinking drops the chunks that are no longer used.
  await V.saveSettings(api, V.defaults());
  const left = Object.keys(data).filter(k => k.startsWith('settings.p'));
  assert.equal(left.length, data.settings.patternChunks, 'stale chunks removed');

  // The pre-chunking format still loads.
  data = { settings: { enabled: false, patterns: [{ name: 'old', value: 'x' }] } };
  const legacy = await V.loadSettings(api);
  assert.equal(legacy.enabled, false);
  assert.deepEqual(Array.from(legacy.patterns, p => p.name), ['old']);
}

console.log('All pattern unit tests passed.');
