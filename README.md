# Pattern Copy

A Firefox extension (Manifest V3) that scans every page for patterns you define —
file paths, IP addresses, ticket ids, anything a regex can describe — highlights
them, and offers a one-click **Copy** hint when you hover over one.


## What it does

- Scans visible text for your text patterns and wraps each hit in a tinted highlight.
- Resolves your locators (XPath, CSS, Selenium strategies) and tints the matched
  elements in place.
- Combines the two: a pattern can take a **Within** locator so the regex only runs
  inside the elements, attributes or field values you point it at.
- Hovering a highlight shows a small floating panel with the pattern's name and a
  **Copy** button. The panel lives in a shadow root, so page CSS can't distort it.
- Content added after load (SPAs, log tails, infinite scroll) is picked up by a
  debounced `MutationObserver`.
- The toolbar badge shows how many matches the current page holds, iframes included.

## Pattern types

Three types match **text**, highlighting the matching substring:

| Type | Meaning | Example |
| --- | --- | --- |
| **Text** | Matched literally, no special characters. | `/etc/hosts` |
| **Glob** | Path-flavoured wildcards. `*` stays inside one segment, `**` crosses separators (`a/**/b` also matches `a/b`), `?` is exactly one character. Whitespace always ends a match. | `/var/log/**/*.log` |
| **Regex** | A raw JavaScript regular expression. `g` is always applied; add `i`, `m`, `s`, `u` in the *Flags* column. | `\bCT \d+\b` |

The fourth matches a whole **element**:

| Type | Meaning | Example |
| --- | --- | --- |
| **Locator** | An XPath, a CSS selector, or a Selenium `strategy=value` locator. | `//code` · `.build > .id` · `id=ticket` |

### Locators

A bare locator is auto-detected: anything starting with `/`, `./`, `../` or `(` is
treated as XPath, everything else as a CSS selector. You can also be explicit with
Selenium's locator strategies, so a locator lifted straight out of a page object
works unchanged:

| Strategy | Also accepted | Example |
| --- | --- | --- |
| `xpath=` | | `xpath=//td[@class="id"]` |
| `css=` | `css selector=` | `css=.build > .id` |
| `id=` | | `id=build-number` |
| `name=` | | `name=ticket` |
| `class=` | `class name=` | `class name=mono` |
| `tag=` | `tag name=` | `tag name=code` |
| `link=` | `link text=` | `link text=Download` |
| `partial link=` | `partial link text=` | `partial link text=Down` |

What gets copied is the element's text. XPath may also select an **attribute** or a
**text node** directly — `//a[@class="dl"]/@href` copies the URL and anchors the hit
on the `<a>` itself. For form controls (`input`, `textarea`, `select`) the live
*value* is copied rather than the empty text content.

A locator hit tints the element in place: it never rewraps or restructures the DOM,
and every class, `data-` and style property is removed again when the pattern is
turned off. Each element is claimed by at most one locator — the first in the list
wins — so overlapping locators stay predictable.

### Combining the two: Within

The locator half and the text half compose. Give a text pattern a **Within**
locator and it only matches inside what that locator selects:

| Within | Pattern | Copy as | Result |
| --- | --- | --- | --- |
| `//a/@href` | `/browse/([A-Z]+-\d+)` | `$1` | every ticket link becomes a one-click copy of just the key |
| `css=td.log` | `\b10\.\d+\.\d+\.\d+\b` | | internal IPs, but only inside log cells |
| `id=payload` | `"token":\s*"([^"]+)"` | `$1` | the token out of one JSON blob, ignoring the rest of the page |

What the scope resolves to decides how the pattern is applied:

- **Elements** — the pattern runs over the text inside them and highlights each
  matching substring, exactly as a page-wide pattern does but confined to that
  subtree.
- **An attribute, or a form control's value** — the pattern runs over that single
  value, and the hit is anchored on the owning element. Only the first match of a
  value counts, since an element carries one hit. A value the pattern doesn't match
  produces no hit at all, so `//a/@href` + a ticket regex quietly skips the links
  that aren't tickets.

Scoped patterns are resolved before the page-wide ones, so the narrower intent wins
where both would match. `Within` doesn't apply to the Locator type, which already is
one.

### Per-pattern options

- **Within** — an optional locator narrowing where this pattern may match. See
  [Combining the two](#combining-the-two-within). Empty means the whole page; not
  used by the Locator type.
- **Copy as** — rewrites what lands on the clipboard. `$0` is the whole match and
  `$$` a literal `$`. Text patterns add `$1`…`$9` and `$<name>` for capture groups;
  locators add `$@attr` for an attribute of the matched element. So `PID (?<id>\d+)`
  with *Copy as* `kill $<id>` puts `kill 101` on the clipboard, and
  locator `css=a.dl` with `$@data-sha` copies that attribute instead of the link text.
  A match whose template renders to nothing produces no hit at all.
- **Sites** — a comma-separated list of URL globs limiting where the pattern runs,
  e.g. `*.example.com, github.com/org, jira.local`. A glob without a `/` is a host
  (its `*` never crosses into the path), and a glob that doesn't end in `*` also
  covers everything below it. Default `*` means everywhere.
- **Colour** — the highlight tint.
- **Flags** — regex flags; ignored by the other types.

When two text patterns overlap, the longer match wins; on a tie the pattern listed
first in the options page wins.

## Ships with

Enabled: Unix path, Windows path, IPv4 address, UUID.
Disabled (switch them on if you want them): Git SHA, Email, a glob example, a
locator example (`//code`) and a combined example (`//a/@href` + a ticket regex).

## Installing

### 1. Temporary (fastest, gone on restart)

```sh
npm install
npm start           # launches Firefox with the extension and the test page loaded
```

Or by hand, with no tooling: open `about:debugging#/runtime/this-firefox` →
**Load Temporary Add-on…** → pick `manifest.json` from this directory. Open
`test/sample.html` to see it working.

A temporary add-on is removed when Firefox restarts. Everything works normally
while it is loaded, including settings, which survive in `storage.sync`.

### 2. Permanent, release Firefox — sign it

Release and Beta Firefox install only signed extensions. Signing is free and the
extension does not have to be public: an *unlisted* submission is reviewed
automatically and handed back as an `.xpi` only you distribute.

1. Create an account on [addons.mozilla.org](https://addons.mozilla.org), then
   generate credentials at **Tools → Manage API Keys**.
2. Sign and download:

   ```sh
   npx web-ext sign \
     --source-dir . \
     --config web-ext-config.mjs \
     --channel unlisted \
     --api-key "$AMO_JWT_ISSUER" \
     --api-secret "$AMO_JWT_SECRET"
   ```

3. Open the resulting `web-ext-artifacts/*.xpi` in Firefox (or drag it onto the
   window) and confirm the install. It survives restarts and self-updates if you
   publish new versions.

The extension id (`pattern-copy@external-team`) and the
`browser_specific_settings.gecko.data_collection_permissions` block that AMO
requires are already in `manifest.json`.

### 3. Permanent, without signing — Developer Edition, Nightly or ESR

Only these builds can be told to accept unsigned extensions:

1. In `about:config`, set `xpinstall.signatures.required` to `false`.
2. `npm run build`, then rename `web-ext-artifacts/pattern_copy-0.1.0.zip` to
   `pattern_copy-0.1.0.xpi` and open it in Firefox.

This switch does nothing in release or Beta Firefox — the setting exists but is
ignored, so those channels need option 2.

## Build / lint / test

```sh
npm run lint        # web-ext lint
npm run build       # produces web-ext-artifacts/*.zip
npm test            # pattern unit tests + a jsdom run of the real content script
```

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+Shift+C` | Copy every unique match on the page, one per line |
| `Alt+Shift+X` | Toggle highlighting on/off |

The pattern editor's **Try it out** box runs your text patterns against whatever
you paste. Paste an HTML snippet and the locators run against it too, so a selector
can be checked without reloading a page.

## Options

`about:addons` → Pattern Copy → Preferences, or the **Settings** button in the popup.
Settings live in `storage.sync`, so they follow a Firefox account, and can be
exported/imported as JSON. The pattern list is stored in chunks to stay under
`storage.sync`'s 8 KB per-item limit; the whole set still has to fit its ~100 KB total,
and **Save** reports an error if it doesn't.

Behaviour switches:

- **Enable Pattern Copy** — master on/off.
- **Show the floating copy hint on hover** — off leaves only the highlights.
- **Tint matches** — off draws a thin underline in the pattern colour instead.
- **Clicking a match copies it immediately** — off by default, because it
  suppresses the page's own click handling on the matched text.
- **Max matches per frame** — guard for very large pages (default 1500).

## Layout

```
manifest.json
src/common/api.js         browser/chrome shim
src/common/patterns.js    pattern model: text patterns + locators (shared by all contexts)
src/common/tabs.js        per-frame messaging for the popup and background
src/content/content.js    text scanner, locator resolver, hint UI
src/content/content.css   highlight styling
src/background/           badge counter + keyboard commands
src/options/              pattern editor with a live tester
src/popup/                quick toggle, match count, copy-all
test/                     unit tests and a jsdom integration test
```

## Known limits

- A *text* match must sit inside a single text node, whether or not it is scoped.
  `/var/<b>log</b>/x` is not detected as one path — use a locator when the target
  is a whole element.
- Locators and `Within` scopes are re-evaluated against the whole document on every
  scan, so each one is capped at 500 nodes, and while any are enabled a page that keeps
  mutating is rescanned at most every 1.5 s.
- The `scripting` permission is used only to list a tab's frames, so the popup count,
  **Copy all** and the badge cover iframes too.
- The text scanner skips `<input>`, `<textarea>` and `contenteditable` regions on
  purpose, so typing is never disturbed. A locator may still target them, since
  that is an explicit instruction.
- `navigator.clipboard` can be blocked on some pages; the extension falls back to
  the legacy `document.execCommand('copy')` path in that case.
