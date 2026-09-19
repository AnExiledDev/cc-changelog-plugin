> **AI-written from operator direction.** The intent is the operator's; the wording and scope are an agent's.
> `session: 6a501c72-fa3b-4836-9a4d-bbd91a27ec9c | 2026-09-09 | source: op:2026-09-09-2117-e2bd`

# cc-changelog: a Claude Code plugin that draws a pane

`/whatsnew` opens a pane in the terminal listing every release in
`https://changelogs.core-directive.com/feed.json`, with a tab strip, a search
field with three filters, a reader that draws one entry in full, and a line at
the top saying how far behind the running build is. It also registers nine
tools the model can call, and polls for releases in the background so a
session says something when one lands.

It is here because of what it is built on rather than what it does: Claude Code
v2.1.269 ships a plugin runtime that no page of `code.claude.com/docs` mentions.
Nothing in the 192-page docs corpus captured on 2026-09-11 names `modules`,
`surface`, `$.ui.render` or any of it.

The build documents itself, though, and only once the flag is on: it carries a
`plugin-authoring` skill and a `/plugin-types` command, both gated on the same
switch as the runtime. `/plugin-types` writes `claude-code.d.ts` out of the
running build - 450 KB of declarations, every event's input and result, every
method on `$`, every element's props. `types/claude-code.d.ts` here is the copy
v2.1.278 wrote. **It is the authority; the notes below are the map to it.**

## Provenance

Operator, 2026-09-09 (op:2026-09-09-2117-e2bd):

> Can you build it, enable it and make sure it works to the best of your capability?

## Run it

```bash
git clone https://github.com/AnExiledDev/cc-changelog-plugin.git
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ./cc-changelog-plugin
```

`--plugin-dir` loads it for that session only and watches the folder, which is
what you want while reading the code. To keep it, copy the folder into
`~/.claude/skills/cc-changelog` instead and start `claude` with the same
environment variable.

**The flag is not optional.** Without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` the
runtime this is built on does not exist, the module never loads, and the
session says nothing about why.

Then type `/whatsnew`. Two things make the loop fast:

- `claude plugin validate <path>` prints the static scan of what the module
  hooks and calls, and refuses the module before it ever loads.
- `claude --plugin-dir <folder>` loads a plugin from disk for one session and
  watches it: saving a file re-runs `register` in a fresh environment.

`claude --debug hooks --debug-file <path>` is where the engine says what it
refused, including a tree that did not validate.

## What it does

- **`/whatsnew` opens the pane** with all 25 feed items rather than a hand-cut
  dozen. A `Pane` scrolls itself, so the list does not need paging: the engine
  draws `↑↓ pgup pgdn scroll · tab moves · esc back to the prompt` and owns the
  offset. Nothing in the module tracks scroll.
- **Four tabs.** `Releases (25)`, `Search`, one that appears once a release
  is opened, labelled with its version, and `Entry` once an entry has been
  opened. Tab state is one value in `$.store` under `view`, so the pane
  reopens where the reader left it. The detail tab keys on the feed item's
  `id`, not its version: blog posts in the same feed carry no version, and
  matching on one gave every versionless item the same phantom tab.
- **Search is a field and three filters.** An `Input` submits on Enter and
  never on keystroke, so one search is one request to `/search.json`; three
  `Select`s narrow it by tier, by area and by release, and a pick re-runs the
  terms already entered. The tiers are the site's four, the releases are the
  feed's, and the areas are read off the newest release's `entries.json`
  facets rather than spelled in the module, so a renamed area renames itself.
  The model's own `search` calls land in the same tab, terms and filters
  included, so a reader can narrow what the model just found from where it
  left off. Every hit is a button that opens the entry here and a `Link` that
  opens it on the site.
- **The entry reader** draws `/v/{version}/e/{anchor}.json` in full: the
  heading, its tier and area, then its markdown split into headings,
  paragraphs and `Code`. The site serves a fenced usage line as one backtick
  span, so a paragraph that is one whole span is drawn as code too, through
  the engine's own highlighter. Entries open from a search hit or from any row
  of a release's "What changed" list. Under the text sit an `Ask me about it`
  button and the link to the page.
- **`Ask me about it` is `$.ui.ask`.** It raises the engine's own
  AskUserQuestion dialog with three choices, and the pick is written into the
  prompt box with `$.prompt.fill`, cursor at the end, for the reader to send
  or edit. Nothing is submitted from the pane: a press must never spend a turn
  on its own. A dismissed dialog rejects, which the module reads as "never
  mind".
- **The version line is `$.process.run`.** Nothing on `$` says which Claude
  Code is running, so the module runs `claude --version` once per module
  environment with a five-second timeout and reads the version out of what it
  prints. Every failure, from no `claude` on PATH to a sandbox that refuses
  the spawn, is answered with no line rather than an error, because the hint
  is a nicety and the list is the feature.
- **A poll.** `session.start` reads the feed once, remembers the versions it
  saw, and `$.clock.every(30 min)` re-reads it. A version the session has not
  seen raises `$.ui.toast` and sets `$.ui.status`, both without starting a
  turn. The first read only seeds: a session that starts three releases behind
  is not three toasts.
- **Nine tools**, all registered from `session.start`, so they are listed by
  turn one. Five are the changelog: `releases` says which versions exist and
  what shipped since a date; `entries` lists one release's entries and counts
  its sections, tiers and areas; `entry` reads one of them in full; `changelog`
  reads a release as a document, a window at a time; and `search` crosses every
  release at once. They were two until 2026-09-10, and the three that were
  missing are the three questions the two could not answer: what versions
  exist, what one release holds, and what one entry actually says past its
  one-line summary.
- **Four more, one per corpus**, added the same day, because a changelog says
  what changed and nothing here could say what a thing *is*. `reference` is the
  mined inventory of every environment variable, flag, settings key, slash
  command, tool, hook event and model id in the shipped build, with which
  builds each has been seen in and whose sentence the description is; `docs` is
  Anthropic's own documentation as this site captured it; `blog` is the site
  owner's own writing; and `prompts` is what a build actually told the model
  its tools do, byte for byte as it was sent. Each takes the index, the search
  and one document through a single tool, picked by which arguments were given,
  because the argument a model has is a phrase and the ones the routes need are
  a corpus key and a path.
- **Everything pages, and it pages the same way everywhere.** Each answer
  carries `offset`, `count`, `total` and `next_offset`; hand `next_offset` back
  as `offset` to continue, and a null one means there is nothing after this.
  The `changelog` tool pages a document by characters rather than by rows and
  pulls its cut back to the last line break, so a caller reading a release in
  windows is never handed half a sentence. The cut is the site's: `changelog`
  is a pass-through of `/v/{version}/document.json`, which takes `section`,
  `offset` and a character `limit` and answers one window plus the document's
  outline, so nothing here ever holds a release it is not going to use.
- **`search` and `entries` narrow** on `version`, `tier` (`use`, `notice`,
  `soon`, `internal`) and `area`, and `entries` also on `section`.
- **The four corpus tools window server-side too**, through the same routes and
  the same `section` / `offset` / `sections` contract: a documentation page, a
  blog post and a stock tool description are all cut by the site before they
  cross the wire. The hooks reference alone is past a hundred kilobytes, and
  the point of the whole round is that a caller after one paragraph of it pays
  for one paragraph of it.
- **`in_current_build` on a reference name means the newest *mined* build**,
  not the newest release. The inventory trails the changelog by several
  versions, and every answer carries `newest_mined` beside the flag so the
  claim can be read against what measured it.
- **`version` accepts `latest`,** resolved in the plugin rather than by the
  site: the routes take a literal version so that a cached URL is a cached
  release rather than a moving target.
- **A refused argument reaches the model in the site's own words.** The site
  answers 422 with the parameter's name and what it would have accepted, and
  the plugin passes that through, so a model that asked for `tier=urgent` is
  told the four real tiers instead of "answered 422".

## Fetch-friendliness

The site is one small server, and a plugin installed widely polling it every
thirty minutes from every session is the thing that would hurt it. So:

- **Every response is cached in `$.store`** under an `http:` prefix, keyed by
  URL, with the `Cache-Control: max-age` the server sent (15 minutes if it sent
  none). Inside the TTL nothing leaves the machine.
- **`ETag` and `If-None-Match`.** Past the TTL the request carries the stored
  etag, and a `304` refreshes the TTL without transferring the body.
- **A failed fetch serves the cached copy** rather than an error, and never
  clears it.
- **Nothing fetches a whole release.** The biggest thing that crosses the wire
  is one 20,000 character window of a document; the detail tab reads
  `/v/{version}/entries.json?limit=8`, about 9 KB, which carries the release's
  whole summary and the entries it leads with. Until 2026-09-10 both of those
  were `/v/{version}.md`, 207,061 characters for v2.1.267, fetched to draw
  eight headings and a paragraph.
- **The pane never waits on the network.** A `ui.render` hook runs inside a
  dispatch with a budget, so a fetch inside one blocks the frame and a slow
  origin costs the whole tree. The draw reads `$.store` and only `$.store`; a
  document that is missing or stale is fetched beside the dispatch and
  `$.ui.invalidate` asks for the frame again once it lands. One fetch per URL
  per module environment, so an origin that is down cannot turn every redraw
  into another request.
- **The cache is pruned to the 40 most recent documents.** `$.store` is one
  4 MiB JSON file per plugin. It was eight while a release's markdown ran to
  about 200 KB; the answers are single-figure kilobytes now, so the cache holds
  a reader's whole afternoon instead.
- **One identifying user agent**,
  `cc-changelog-plugin/0.2 (+https://changelogs.core-directive.com)`, so a rate
  limit can name this plugin instead of guessing.

`CC_CHANGELOG_BASE_URL` points all of it somewhere else, which is how the
search tool was exercised against a local Laravel before `/search.json` was
live.

The origin holds callers to 120 requests a minute each, and the API as a whole
to 600 a minute, answering `429` with `{"error", "retry_after"}` past either.
Nothing this plugin does in normal use comes near that: the `$.store` cache
means a session with eight terminals open fetches each document once per TTL.
A caller that trips it is walking the corpus, and walking the corpus is fine at
two a second.

## The runtime, as measured

Everything here was read out of `data/claude-code/pretty/pretty-v2.1.267.js` and
then confirmed by running it, except where it says otherwise.

- **The gate.** `pretty-v2.1.267.js:223878`: GrowthBook flag
  `tengu_plugin_hooks_modules`, default `false`, overridden by the environment
  variable `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`. Also off when hooks are disabled
  or the process is restricted.
- **The manifest.** `hooks/hooks.json` takes `modules` (exactly one path, a
  module exporting `register(on)`) and `surface` (a second module drawing
  `Client` elements). `hooks` and `modules` may both be present.
- **A hook is `($, e, next)`,** in that order. `on(event, hook)` or
  `on(event, matcher, hook)`; the event name must be a string literal, so the
  scanner can read what a module hooks before loading it.
- **`$` is spelled `$.noun.event(...)` at the call site, always.** It cannot be
  destructured, renamed, passed across an import, or read as a value. `next` is
  the same: called, or `next.to(e, "<tier>")` on the hook's own parameter.
- **The capabilities** are one list at `pretty-v2.1.267.js:230150`:
  `model.*`, `audio.*`, `mcp.call`, `session.*`, `turn.*`, `flag.value`,
  `tool.register`, `command.register`, `agent.*`, `ui.*`, `fs.*`, `store.*`,
  `http.fetch`, `process.run`, `settings.read`, `env.*`, plus the interception
  events `prompt.section`, `tool.describe`, `skill.prompt`, `attribution.text`,
  `engine.create`.
- **Surfaces are `terminal` and `desktop`.** The components a `ui.render` hook
  may take: `AskUserQuestion` (engine-only), `UserMessage`, `AssistantMessage`,
  `ToolUse`, `ToolResult`, `ToolGroup`, `Spinner`, `TurnDuration`, `InfoNotice`,
  `SessionMode`, `PromptHint`, `AbovePrompt`, `Pane`.
- **The element table comes from `$.ui.resolve(e)`,** and holds `Box`, `Text`,
  `Button`, `Input`, `Select`, `Link`, `Code`, `Client`, `Svg`. Nothing else is
  an element.

## Four things that cost a run each

- **Children go in `props.children`, not as trailing arguments.**
  `Box({ children: [...] })` draws; `Box({}, child, child)` returns a tree with
  no children at all, and the pane renders as an empty frame with no error
  anywhere. The `ui.render` dispatch still logs as settled. This is a trap only
  for a module written in plain calls, which this one is: JSX is available in a
  hooks module with `h` as the factory, and `<Box>{...}</Box>` puts children
  where they belong on its own. `jsconfig.json` here is already set up for it.
- **A `tool.call` result must be a string, an array, or `undefined`.** A plain
  object is refused with *"tool.call step resolved `<tool>` with a result that
  does not match its output shape"*, and what reaches the model is that the
  call failed, not the object. Both tools here return
  `JSON.stringify(value, null, 2)`.
- **A registered command must be answered.** A `command.run` hook that calls
  `next(e)` instead of returning `{ text }` makes Claude Code print
  *"cc-changelog registered /whatsnew but no command.run hook answered it"*.

- **`Code` wraps a long line and then draws the continuation row over the row
  under it** (2.1.269, terminal surface). The declaration promises `wrap:
  'wrap'` by default and the element does wrap; it just measures itself
  unwrapped, so a wrapped line garbles the block below. The module breaks
  code lines itself, at words, eight columns inside the pane's width, so the
  element never has a line to wrap.

## What a pane render carries

```json
{"surface":"terminal","component":"Pane","viewport":{"columns":80,"rows":24},
 "requestId":"cc-changelog",
 "props":{"title":"Claude Code changelog","focused":false,"bodyColumns":76,
          "scroll":{"offset":0,"bodyRows":0}}}
```

`requestId` is the id passed to `$.ui.open({ id, title, focus })`, which is how
a hook tells its own pane from another plugin's. `$.http.fetch` answers
`{ status, ok, headers, text }`; `$.store.get` answers the stored value itself.

## The API it reads

Every tool here is a thin pass-through of a public JSON route on
`https://changelogs.core-directive.com`. Seventeen of them, one paging
contract (`offset`, `limit`, `count`, `total`, `next_offset`, where a null
`next_offset` ends the walk), and one error convention: **422** names the
parameter it refused and what it would have taken, **404** names what the site
does hold, **429** carries `retry_after`. You do not need this plugin to use
them, and there is no key.

| Route | Answers |
| --- | --- |
| `/releases.json` | releases, newest first |
| `/v/{version}/entries.json` | one release's entries, with facets and the summary |
| `/v/{version}/e/{anchor}.json` | one entry in full |
| `/v/{version}/document.json` | one character window of a release, with its outline |
| `/search.json` | entries across every release |
| `/reference.json`, `/reference/search.json`, `/reference/{family}.json`, `/reference/{family}/{slug}.json` | the mined inventory of every flag, env var, settings key, command, tool, hook event and model id |
| `/docs/sources.json`, `/docs/search.json`, `/docs/{source}/pages.json`, `/docs/{source}/{path}.json` | Anthropic's documentation as this site captured it, version by version |
| `/blog.json`, `/blog/{slug}.json` | the site owner's own writing |
| `/prompts/{version}/tools.json`, `/prompts/{version}/tools/{name}.json` | what a build actually told the model its tools do, byte for byte |

The four that answer a whole document take `section`, `offset` and a character
`limit`, and carry the document's outline on every answer, so reading one is a
walk rather than a download.

## The types

`types/claude-code.d.ts` is the plugin API itself: 450 KB of declarations
covering every event's input and result, every method on `$`, and every
element's props. **It is the authority and this README is the map to it.**

Nobody wrote it. Claude Code writes it out of the running build when you type
`/plugin-types`, and the copy here is what 2.1.278 wrote. It is early access
and may move between releases without notice, so regenerate against your own
build rather than trusting this file's age. `types/README.md` has how, and the
terms it is published under, which are not this repository's MIT.

## Caveats

Unannounced and undocumented, so the shape can change in any release, and a
reader on a build without the flag sees nothing at all. Verified on v2.1.267
and v2.1.269, on Linux, on the `terminal` surface. The `desktop`, `mobile` and `vscode`
surfaces, the `surface` module and `Client` elements are read from the bundle
and the declarations and have not been run.
