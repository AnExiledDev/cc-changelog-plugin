/**
 * cc-changelog: the unofficial Claude Code changelog, in the terminal.
 *
 * Three surfaces over one origin, `https://changelogs.core-directive.com`:
 *
 * - `/whatsnew` opens a pane with tabs. Releases lists every item in the feed
 *   and the engine scrolls it; picking one opens its summary; Search shows
 *   whatever the last search tool call found.
 * - Nine tools the model may call: five over the changelog (what exists, what
 *   one release holds, one entry in full, a release as a document, and a
 *   search across all of them), and one apiece over the four corpora the
 *   site had only ever served as HTML: the mined name inventory, the
 *   captured documentation, the owner's own writing, and the stock injected
 *   tool descriptions. Every one of them is windowed by the server.
 * - A poll that toasts when a release the reader has not seen appears.
 *
 * Everything that leaves this module goes through `fetchJson` / `fetchText`,
 * which is the whole of being a good guest on that origin: nothing is fetched
 * twice inside its own `Cache-Control: max-age`, the cache is `$.store` and so
 * is shared by every session on the machine, a repeat fetch revalidates with
 * `If-None-Match` where the origin sent an ETag, and every request identifies
 * itself. The poll's own interval is a floor on top of that.
 */

const DEFAULT_BASE = "https://changelogs.core-directive.com";

/** Identifies this plugin in the origin's logs; a bare fetch says nothing. */
const USER_AGENT = "cc-changelog-plugin/0.2 (+https://changelogs.core-directive.com)";

const PANE = "cc-changelog";

/** Where the pane's own state lives, and where the HTTP cache lives. */
const VIEW_KEY = "view";
const SEEN_KEY = "seen";
const HTTP_PREFIX = "http:";

/**
 * The floor under the poll, whatever the feed's own `max-age` says.
 *
 * The feed is public and small, but a reader may keep a dozen sessions open
 * for days, and every one of them runs this timer. Half an hour against a
 * release cadence of about one a day is already far more often than the answer
 * can change, and the store cache means the sessions past the first cost the
 * origin nothing at all.
 */
const POLL_MS = 30 * 60 * 1000;

/** What a response with no `Cache-Control` of its own is held for. */
const FALLBACK_TTL_MS = 15 * 60 * 1000;

/**
 * The most of one release's document a tool result may carry.
 *
 * `/v/{version}.md` is 200 KB for a busy release, which is a context window
 * spent on one call. This is the `limit` the `document.json` route is asked
 * for, so the cut happens on the server and the 200 KB never crosses the wire;
 * a model that wants more names a section or hands `next_offset` back.
 */
const TOOL_CHARS = 20000;

/**
 * Further than any release's document goes, in characters.
 *
 * The lists below are bounded in rows and the biggest release here is 207,061
 * characters, so the same guard has to be counted in the same unit; the site's
 * own ceiling on that route is this number.
 */
const DOCUMENT_MAX_OFFSET = 1000000;

/** A release, as the site spells one, and as its routes will accept one. */
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** An entry's anchor, matching the route's own constraint. */
const ANCHOR = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * A reference name's slug, a blog post's slug and a documentation corpus key,
 * each matching the route that takes it. Checked here for the reason the
 * anchor is: a route that does not match answers the site's own HTML 404 and
 * the model is handed a page of markup instead of a sentence it can act on.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SOURCE = /^[a-z0-9][a-z0-9-]*$/;

/** A documentation page's path, which carries slashes and dots and is one name. */
const DOC_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** A stock tool's name, as the prompt ledger spells one. */
const PROMPT_TOOL = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/**
 * The site's own caps, restated so a bad argument is a smaller answer rather
 * than a 422 the model has to read and retry.
 */
const SEARCH_LIMIT = 40;
const RELEASES_LIMIT = 100;
const ENTRIES_LIMIT = 200;
const REFERENCE_LIMIT = 100;
const DOCS_PAGES_LIMIT = 200;
const DOCS_HITS_LIMIT = 50;
const BLOG_LIMIT = 100;
const PROMPT_TOOLS_LIMIT = 100;

/**
 * Further than each of these documents runs, in characters, as the site's own
 * route bounds it. Counted in the same unit the window is, for the reason
 * `DOCUMENT_MAX_OFFSET` is: a row-shaped guard would refuse an offset a third
 * of the way into a page.
 */
const DOC_MAX_OFFSET = 500000;
const PROSE_MAX_OFFSET = 200000;

/**
 * Further than any of these lists goes. It exists so a model that mistakes a
 * total for an offset gets an empty page rather than an argument the site
 * refuses.
 */
const MAX_OFFSET = 5000;

/**
 * How many fetched documents the store keeps.
 *
 * `$.store` is capped at four mebibytes for the whole plugin. Nothing here
 * fetches a whole release any more: the biggest answer is one window of a
 * document, which is the twenty thousand characters above, and the rest are
 * single-figure kilobytes. So the cache holds a reader's whole afternoon
 * rather than the last eight things they looked at, and dropping one still
 * costs only a refetch.
 */
const CACHE_ENTRIES = 40;

/**
 * How many of a release's entries the detail tab lists.
 *
 * The pane scrolls, so this is not a height. It is how much of a release a
 * reader wants before they decide to open the page: the document leads with
 * the entries that matter most to them, and past the first handful the answer
 * is the site rather than a terminal pane.
 */
const DETAIL_ENTRIES = 8;

/** @type {import('claude-code').Register} */
export const register = (on) => {
    on("session.start", async ($, e, next) => {
        await $.command.register({
            name: "whatsnew",
            description: "What changed in the Claude Code you are running",
        });

        // One table, read twice: here to declare the tools and below to hook
        // the calls. Nine names drifting apart in two places is the bug this
        // shape cannot have.
        for (const tool of TOOLS) {
            await $.tool.register({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            });
        }

        await watchForReleases($);

        return next(e);
    });

    on("command.run", { command: "whatsnew" }, async ($, e) => {
        const feed = await loadFeed($);

        if (feed.error !== undefined) {
            return { text: feed.error };
        }

        // The order matters: marking the feed seen is what stops the next
        // session starring the same releases, but the stars this reader is
        // about to look at have to survive it. So the unseen versions are
        // written into the view, which is what the list reads, and the store's
        // `seen` is caught up in the same breath.
        await setView($, {
            tab: "releases",
            item: undefined,
            unseen: feed.items.filter((item) => item.unseen).map((item) => item.version),
        });
        await markSeen($, feed.items);
        await $.ui.open({ id: PANE, title: "Claude Code changelog", focus: true });

        const behind = feed.behind === undefined ? "" : ` ${feed.behind}.`;

        return { text: `${feed.items.length} releases in the pane (esc to close).${behind}` };
    });

    on("ui.render", { surface: "terminal", component: "Pane" }, async ($, e, next) => {
        if (e.requestId !== PANE) {
            return next(e);
        }

        return drawPane($, e);
    });

    // A hook apiece rather than a loop over TOOLS: the engine refuses a module
    // that hands `$` anywhere it cannot see, and `tool.run($, e)` is exactly
    // that, so each call names the function that serves it.
    on("tool.call", { tool: "mcp__cc-changelog__changelog" }, async ($, e) => {
        return { result: asToolResult(await changelogTool($, e)) };
    });

    on("tool.call", { tool: "mcp__cc-changelog__search" }, async ($, e) => {
        return { result: asToolResult(await searchTool($, e)) };
    });

    on("tool.call", { tool: "mcp__cc-changelog__releases" }, async ($, e) => {
        return { result: asToolResult(await releasesTool($, e)) };
    });

    on("tool.call", { tool: "mcp__cc-changelog__entries" }, async ($, e) => {
        return { result: asToolResult(await entriesTool($, e)) };
    });

    on("tool.call", { tool: "mcp__cc-changelog__entry" }, async ($, e) => {
        return { result: asToolResult(await entryTool($, e)) };
    });

    on("tool.call", { tool: "mcp__cc-changelog__reference" }, async ($, e) => {
        return { result: asToolResult(await referenceTool($, e)) };
    });

    on("tool.call", { tool: "mcp__cc-changelog__docs" }, async ($, e) => {
        return { result: asToolResult(await docsTool($, e)) };
    });

    on("tool.call", { tool: "mcp__cc-changelog__blog" }, async ($, e) => {
        return { result: asToolResult(await blogTool($, e)) };
    });

    on("tool.call", { tool: "mcp__cc-changelog__prompts" }, async ($, e) => {
        return { result: asToolResult(await promptsTool($, e)) };
    });
};

/* -------------------------------------------------------------------------
 * The pane
 * ---------------------------------------------------------------------- */

/**
 * Draws whichever tab the reader is on.
 *
 * The tree is never sliced to fit: a Pane scrolls a tall tree itself, so
 * cutting the list here would take the scrolling away rather than help it. It
 * is sized to `e.viewport.columns` instead, which is the measurement the
 * engine re-runs this hook for when the terminal is resized.
 */
const drawPane = async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);

    const columns = e.props?.bodyColumns ?? e.viewport?.columns ?? 80;
    const view = (await $.store.get(VIEW_KEY)) ?? { tab: "releases" };
    const feed = await loadFeed($);

    const body =
        feed.error !== undefined
            ? [Text({ key: "err", color: "red", children: feed.error })]
            : await bodyFor($, e, view, feed, columns);

    return Box({
        flexDirection: "column",
        paddingX: 1,
        children: [tabs($, e, view, feed), ...body],
    });
};

/**
 * The tab strip.
 *
 * Buttons rather than a Select: a tab is a place, and the strip has to show
 * which one the reader is in. The detail tab only exists once a release has
 * been picked, so the strip is two entries until then and three afterwards.
 */
const tabs = ($, e, view, feed) => {
    const { Box, Button, Text } = $.ui.resolve(e);
    const detail = itemOf(view, feed);

    const entries = [
        { tab: "releases", label: `Releases (${feed.items.length})` },
        ...(detail === undefined ? [] : [{ tab: "detail", label: detail.tabLabel }]),
        { tab: "search", label: "Search" },
    ];

    return Box({
        key: "tabs",
        flexDirection: "row",
        gap: 2,
        marginBottom: 1,
        children: entries.map((entry) =>
            entry.tab === view.tab
                ? Text({ key: entry.tab, bold: true, underline: true, children: entry.label })
                : Button({
                      key: entry.tab,
                      label: entry.label,
                      plain: true,
                      onPress: () => {
                          void setView($, { ...view, tab: entry.tab }).then(() =>
                              $.ui.invalidate("ui.render"),
                          );
                      },
                  }),
        ),
    });
};

const bodyFor = async ($, e, view, feed, columns) => {
    if (view.tab === "detail") {
        return releaseDetail($, e, view, feed, columns);
    }

    if (view.tab === "search") {
        return searchTab($, e, view, columns);
    }

    return releaseList($, e, view, feed, columns);
};

/**
 * Every item the feed carries, one row apiece, newest first.
 *
 * The pane's own scrolling is what makes this list rather than a page of it:
 * the engine draws the tree into the frame it has and scrolls the rest, so a
 * cap here would be a cap on what can be reached at all.
 */
const releaseList = ($, e, view, feed, columns) => {
    const { Box, Button, Text } = $.ui.resolve(e);

    return [
        ...(feed.behind === undefined
            ? []
            : [Text({ key: "behind", color: "yellow", children: `${feed.behind}  (${feed.installed})` })]),
        ...feed.items.map((item) =>
        Box({
            key: item.id,
            flexDirection: "column",
            marginBottom: 1,
            children: [
                Button({
                    key: `open-${item.id}`,
                    label: `${(view.unseen ?? []).includes(item.version) ? "* " : "  "}${item.title}`,
                    plain: true,
                    onPress: () => {
                        void setView($, { tab: "detail", item: item.id }).then(() =>
                            $.ui.invalidate("ui.render"),
                        );
                    },
                }),
                Text({
                    key: `sum-${item.id}`,
                    dimColor: true,
                    wrap: "wrap",
                    children: `    ${clip(item.summary, columns * 2)}`,
                }),
            ],
        }),
        ),
    ];
};

/**
 * How far behind the running build is, in words, or nothing.
 *
 * Nothing on `$` says which Claude Code is running: `session.start` carries the
 * cwd, the surface and whether it is interactive, and no accessor anywhere
 * answers a version. So this asks the binary, which is a host command and may
 * fail for a dozen ordinary reasons (no `claude` on PATH, a wrapper script, a
 * sandbox). Every one of them is answered with no hint rather than an error:
 * the hint is a nicety and the list is the feature.
 *
 * Read once per module environment, because a reader does not upgrade Claude
 * Code underneath the session that is running it.
 */
let installedVersion;

const installed = async ($) => {
    if (installedVersion !== undefined) {
        return installedVersion;
    }

    installedVersion = $.process
        .run(["claude", "--version"], { timeoutMs: 5000 })
        .then((result) => (result.exitCode === 0 ? (result.stdout.match(/[0-9]+\.[0-9]+\.[0-9]+/) ?? [])[0] : undefined))
        .catch(() => undefined);

    return installedVersion;
};

/**
 * The releases published since the one that is running.
 *
 * Counted off the feed's own order rather than by comparing version numbers,
 * because the feed is what the site published and a build the site has never
 * heard of should read as "up to date" rather than as an enormous number.
 */
const behindHint = (items, version) => {
    if (version === undefined) {
        return undefined;
    }

    const releases = items.filter((item) => item.version !== undefined);
    const index = releases.findIndex((item) => item.version === version);

    if (index === 0) {
        return "You are running the newest release";
    }

    if (index === -1) {
        return `More than ${releases.length} releases behind`;
    }

    return index === 1 ? "One release behind" : `${index} releases behind`;
};

/**
 * One release's own summary, the first of what changed in it, and its page.
 *
 * `/v/{version}/entries.json?limit=8` and nothing else: it carries the run's
 * whole summary and the entries the release leads with, which is everything
 * this tab draws, in about seven kilobytes. It used to be `/v/{version}.md`,
 * the whole release, 207 KB of it for eight headings and a paragraph.
 */
const releaseDetail = async ($, e, view, feed, columns) => {
    const { Box, Text } = $.ui.resolve(e);
    const item = itemOf(view, feed);

    if (item === undefined) {
        return [Text({ key: "gone", dimColor: true, children: "That release is no longer in the feed." })];
    }

    const head = [
        Text({ key: "title", bold: true, children: item.title }),
        Text({ key: "date", dimColor: true, children: item.date }),
    ];

    const link = Box({
        key: "link",
        marginTop: 1,
        children: [linkOrText($, e, "read", item.url, "Read the whole release")],
    });

    const base = await baseUrl($);
    const detail = await paneJson($, `${base}/v/${item.version}/entries.json?limit=${DETAIL_ENTRIES}`);

    if (detail === undefined) {
        // The feed's own summary is the release's first paragraph cut at 180
        // characters, so it is what the tab says while the entries are still
        // on their way, and what it keeps saying if they never arrive.
        return [...head, paragraph($, e, "prose", item.summary, columns), link];
    }

    const entries = detail.entries ?? [];
    const rest = (detail.total ?? entries.length) - entries.length;

    return [
        ...head,
        ...paragraphsOf(detail.summary ?? item.summary).map((text, index) =>
            paragraph($, e, `p${index}`, text, columns),
        ),
        // `Text` takes no margin of its own, so anything spaced is spaced by a
        // `Box` around it; a prop an element does not take refuses the whole
        // tree and draws the engine's empty frame instead.
        Box({
            key: "changed",
            marginTop: 1,
            children: [
                Text({ key: "changed-t", bold: true, children: `What changed (${detail.total ?? entries.length})` }),
            ],
        }),
        // The indent is padding rather than spaces in the string: a wrapped line
        // carries the padding and would not carry the spaces, so a two-line
        // glance written with spaces starts flush against the frame.
        ...entries.map((entry, index) =>
            Box({
                key: `entry-${index}`,
                flexDirection: "column",
                marginTop: 1,
                paddingLeft: 2,
                width: columns,
                children: [
                    Text({ key: `h${index}`, wrap: "wrap", children: entry.heading ?? entry.anchor }),
                    Box({
                        key: `gb${index}`,
                        paddingLeft: 2,
                        width: columns - 2,
                        children: [
                            Text({
                                key: `g${index}`,
                                dimColor: true,
                                wrap: "wrap",
                                children: entry.glance ?? entry.teaser ?? "",
                            }),
                        ],
                    }),
                ],
            }),
        ),
        ...(rest > 0
            ? [
                  Box({
                      key: "more",
                      marginTop: 1,
                      paddingLeft: 2,
                      children: [
                          Text({ key: "more-t", dimColor: true, children: `and ${rest} more, on the page` }),
                      ],
                  }),
              ]
            : []),
        link,
    ];
};

/** One wrapped paragraph, sized to the pane rather than to the terminal. */
const paragraph = ($, e, key, text, columns) => {
    const { Box, Text } = $.ui.resolve(e);

    return Box({
        key,
        flexDirection: "column",
        marginTop: 1,
        width: columns,
        children: [Text({ key: `${key}-t`, wrap: "wrap", children: text })],
    });
};

/**
 * A document the pane may draw right now, and a fetch for the next frame.
 *
 * A `ui.render` hook runs inside a dispatch with a budget of its own, so a
 * fetch inside one blocks the frame on the network: opening a release used to
 * await the whole release document before anything was drawn at all, and a
 * slow origin cost the tree rather than the paragraph. So the draw reads the
 * cache and only the cache, the fetch is started beside the dispatch rather
 * than inside it, and `$.ui.invalidate` asks for the frame again once the
 * answer is in.
 *
 * A stale copy is drawn rather than waited for, for the same reason, and
 * revalidated in the same breath. One fetch per URL per module environment: a
 * fetch that fails keeps its claim, so an origin that is down cannot turn
 * every redraw into another request.
 */
const claimed = new Set();

const paneJson = async ($, url) => {
    const cached = await $.store.get(`${HTTP_PREFIX}${url}`);
    const fresh = cached !== undefined && cached.expiresAt > $.clock.now();

    if (fresh !== true && claimed.has(url) !== true) {
        claimed.add(url);

        void fetchJson($, url).then((response) => {
            if (response.ok === true) {
                claimed.delete(url);
            }

            $.ui.invalidate("ui.render");
        });
    }

    return cached === undefined ? undefined : parsedJson(cached.text);
};

/**
 * A block of markdown as its paragraphs, which is how the pane draws prose.
 *
 * The site's own summary is one string with blank lines in it, and a `Text`
 * wraps whatever it is handed, so the blank lines would be swallowed and a
 * three paragraph summary would draw as one block.
 */
const paragraphsOf = (markdown) =>
    String(markdown ?? "")
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter((part) => part !== "");

/**
 * The item the detail tab is showing, if the feed still carries it.
 *
 * By the feed's own id rather than by version, because the feed carries blog
 * posts too and every one of them has no version at all: matching on version
 * once made `undefined === undefined` true and put a tab reading `vundefined`
 * beside Releases.
 */
const itemOf = (view, feed) =>
    view.item === undefined ? undefined : feed.items.find((item) => item.id === view.item);

/**
 * A link, or the text of one.
 *
 * `Link` takes `https:` (or `http://localhost`) and a bad href does not fail
 * the element, it refuses the whole tree: the pane would draw the engine's own
 * empty frame with the reason only in the debug log. The dev override points
 * this plugin at `http://127.0.0.1:<port>`, which is exactly such an href, so
 * anything that is not plainly safe is drawn as text.
 */
const linkOrText = ($, e, key, href, label) => {
    const { Link, Text } = $.ui.resolve(e);

    return href.startsWith("https://")
        ? Link({ key, href, label })
        : Text({ key, dimColor: true, children: `    ${href}` });
};

/**
 * What the last `search` tool call found.
 *
 * The pane has no text field of its own on purpose: the search that matters
 * here is the model's, and this is where its reader can see what it read.
 */
const searchTab = ($, e, view, columns) => {
    const { Box, Text } = $.ui.resolve(e);
    const search = view.search;

    if (search === undefined || search.results.length === 0) {
        return [
            Text({
                key: "empty",
                dimColor: true,
                wrap: "wrap",
                children:
                    search === undefined
                        ? "Nothing searched yet. Ask me to search the changelog and the hits land here."
                        : `No entry carries every term of "${search.query}".`,
            }),
        ];
    }

    return [
        Text({ key: "q", dimColor: true, children: `"${search.query}", ${search.results.length} entries` }),
        ...search.results.map((hit, index) =>
            Box({
                key: `hit-${index}`,
                flexDirection: "column",
                marginTop: 1,
                children: [
                    Text({ key: `hit-h-${index}`, wrap: "wrap", children: `v${hit.version}  ${hit.heading}` }),
                    // A link rather than a button: a hit is an entry, and half
                    // the releases search answers are older than the 25 items
                    // the feed carries, so there is often no tab to open.
                    linkOrText($, e, `hit-link-${index}`, hit.url, "open"),
                    Text({
                        key: `hit-sum-${index}`,
                        dimColor: true,
                        wrap: "wrap",
                        children: `    ${clip(hit.summary ?? "", columns * 2)}`,
                    }),
                ],
            }),
        ),
    ];
};

/* -------------------------------------------------------------------------
 * The tools
 * ---------------------------------------------------------------------- */

/**
 * The release a tool was asked about.
 *
 * `latest` and an omitted version both mean the newest one, and both are
 * resolved here rather than on the site. The routes take a literal version on
 * purpose: a URL that means a different release next week cannot be cached,
 * and everything this module fetches is cached.
 */
const releaseAsked = async ($, raw) => {
    const given = text(raw);

    if (given !== undefined && given.toLowerCase() !== "latest") {
        return VERSION.test(given)
            ? { version: given }
            : { error: `\`${given}\` is not a release, which reads like \`2.1.267\`.` };
    }

    const feed = await loadFeed($);
    const newest = feed.items?.[0]?.version ?? (await newestRelease($));

    return newest === undefined ? { error: "The site did not say which release is newest." } : { version: newest };
};

/** The newest release, when the feed could not say. */
const newestRelease = async ($) => {
    const base = await baseUrl($);
    const response = await fetchJson($, `${base}/releases.json?limit=1`);

    return response.ok === true ? response.json?.releases?.[0]?.version : undefined;
};

/**
 * One release as a document, cut to what the caller asked for by the server.
 *
 * A pass-through of `/v/{version}/document.json`, deliberately: `section` and
 * `offset` are the site's arguments and the window, the outline and the paging
 * are the site's answer, so there is no second implementation of the cut here
 * to disagree with it. It used to fetch `/v/{version}.md` whole and slice it
 * in this module, which meant 207 KB crossing the wire to answer with twenty.
 */
const changelogTool = async ($, e) => {
    const asked = await releaseAsked($, e.version);

    if (asked.error !== undefined) {
        return asked;
    }

    const base = await baseUrl($);
    const url = `${base}/v/${asked.version}/document.json?${query({
        section: text(e.section),
        offset: bounded(e.offset, 0, 0, DOCUMENT_MAX_OFFSET),
        limit: TOOL_CHARS,
    })}`;

    const response = await fetchJson($, url);

    return response.ok === true ? response.json : problem(url, response);
};

const searchTool = async ($, e) => {
    const terms = text(e.query);

    if (terms === undefined) {
        return { error: "A search needs terms." };
    }

    const within = text(e.version) === undefined ? { version: undefined } : await releaseAsked($, e.version);

    if (within.error !== undefined) {
        return within;
    }

    const base = await baseUrl($);
    const url = `${base}/search.json?${query({
        q: terms,
        limit: bounded(e.limit, 10, 1, SEARCH_LIMIT),
        offset: bounded(e.offset, 0, 0, MAX_OFFSET),
        version: within.version,
        tier: text(e.tier),
        area: text(e.area),
    })}`;

    const response = await fetchJson($, url);

    if (response.ok !== true) {
        return problem(url, response);
    }

    const answer = response.json ?? {};
    const results = answer.results ?? [];

    // Kept for the pane, which is the reader's own view of what the model just
    // read. The tab's contents are this and nothing else.
    const view = (await $.store.get(VIEW_KEY)) ?? { tab: "releases" };
    await $.store.set(VIEW_KEY, { ...view, search: { query: terms, results } });
    $.ui.invalidate("ui.render");

    return answer;
};

const releasesTool = async ($, e) => {
    const base = await baseUrl($);
    const url = `${base}/releases.json?${query({
        limit: bounded(e.limit, 20, 1, RELEASES_LIMIT),
        offset: bounded(e.offset, 0, 0, MAX_OFFSET),
        since: text(e.since),
    })}`;

    const response = await fetchJson($, url);

    return response.ok === true ? response.json : problem(url, response);
};

const entriesTool = async ($, e) => {
    const asked = await releaseAsked($, e.version);

    if (asked.error !== undefined) {
        return asked;
    }

    const base = await baseUrl($);
    const url = `${base}/v/${asked.version}/entries.json?${query({
        limit: bounded(e.limit, 25, 1, ENTRIES_LIMIT),
        offset: bounded(e.offset, 0, 0, MAX_OFFSET),
        section: text(e.section),
        tier: text(e.tier),
        area: text(e.area),
    })}`;

    const response = await fetchJson($, url);

    return response.ok === true ? response.json : problem(url, response);
};

const entryTool = async ($, e) => {
    const asked = await releaseAsked($, e.version);

    if (asked.error !== undefined) {
        return asked;
    }

    const anchor = text(e.anchor);

    // Checked here rather than left to the route, because a route that does not
    // match answers Laravel's own 404 page and the caller would be handed a
    // slab of HTML instead of a sentence saying what was wrong with the name.
    if (anchor === undefined || ANCHOR.test(anchor) !== true) {
        return { error: `\`${String(e.anchor)}\` is not an entry anchor; they read like \`hooks-session-end\`.` };
    }

    const base = await baseUrl($);
    const url = `${base}/v/${asked.version}/e/${anchor}.json`;
    const response = await fetchJson($, url);

    return response.ok === true ? response.json : problem(url, response);
};

/**
 * The mined name inventory: what a flag, variable, setting or slash command is.
 *
 * Four routes behind one tool, picked by which arguments were given, because a
 * model asking "what is CLAUDE_CODE_ENABLE_FUNCTION_HOOKS" does not know
 * whether the site files that under `env` and should not have to. The index,
 * the search, one family's page and one name's document are the site's own
 * four; nothing is re-ranked or re-cut here.
 */
const referenceTool = async ($, e) => {
    const base = await baseUrl($);
    const family = text(e.family);
    const slug = text(e.slug);
    const terms = text(e.q);

    if (slug !== undefined) {
        if (family === undefined) {
            return { error: "A `slug` needs its `family` too; a search answers both at once." };
        }

        if (SLUG.test(slug) !== true) {
            return { error: `\`${slug}\` is not a reference slug; they read like \`claude-code-enable-function-hooks\`.` };
        }

        return fetched($, `${base}/reference/${encodeURIComponent(family)}/${slug}.json`);
    }

    const paging = query({
        limit: bounded(e.limit, 25, 1, REFERENCE_LIMIT),
        offset: bounded(e.offset, 0, 0, MAX_OFFSET),
    });

    if (terms !== undefined) {
        return fetched($, `${base}/reference/search.json?${query({ q: terms, family })}&${paging}`);
    }

    return family === undefined
        ? fetched($, `${base}/reference.json`)
        : fetched($, `${base}/reference/${encodeURIComponent(family)}.json?${paging}`);
};

/**
 * Anthropic's own documentation as this site captured it.
 *
 * A page is served a window at a time for the reason a release document is:
 * the hooks reference alone is past a hundred kilobytes, and a caller after
 * one paragraph of it should not pay for the rest. `q` is the way in, because
 * a corpus key and a path are two things a model cannot guess and a phrase is
 * one it has.
 */
const docsTool = async ($, e) => {
    const base = await baseUrl($);
    const source = text(e.source);
    const path = text(e.path);
    const terms = text(e.q);

    if (source !== undefined && SOURCE.test(source) !== true) {
        return { error: `\`${source}\` is not a corpus key; they read like \`claude-code\`.` };
    }

    if (path !== undefined) {
        if (source === undefined) {
            return { error: "A `path` needs its `source` too; a search answers both at once." };
        }

        if (DOC_PATH.test(path) !== true) {
            return { error: `\`${path}\` is not a page path; they read like \`cli/hooks\`.` };
        }

        return fetched(
            $,
            `${base}/docs/${source}/${path}.json?${query({
                section: text(e.section),
                offset: bounded(e.offset, 0, 0, DOC_MAX_OFFSET),
                limit: TOOL_CHARS,
            })}`,
        );
    }

    if (terms !== undefined) {
        return fetched(
            $,
            `${base}/docs/search.json?${query({
                q: terms,
                limit: bounded(e.limit, 10, 1, DOCS_HITS_LIMIT),
                offset: bounded(e.offset, 0, 0, MAX_OFFSET),
            })}`,
        );
    }

    if (source === undefined) {
        return fetched($, `${base}/docs/sources.json`);
    }

    return fetched(
        $,
        `${base}/docs/${source}/pages.json?${query({
            limit: bounded(e.limit, 50, 1, DOCS_PAGES_LIMIT),
            offset: bounded(e.offset, 0, 0, MAX_OFFSET),
        })}`,
    );
};

/**
 * The site owner's own writing about all of this.
 *
 * The one corpus here that is neither mined nor captured: a changelog entry
 * says what changed and a documentation page says what a thing is, and these
 * are the argument about why any of it matters. Markdown rather than the
 * rendered page, windowed like everything else.
 */
const blogTool = async ($, e) => {
    const base = await baseUrl($);
    const slug = text(e.slug);

    if (slug === undefined) {
        return fetched(
            $,
            `${base}/blog.json?${query({
                limit: bounded(e.limit, 25, 1, BLOG_LIMIT),
                offset: bounded(e.offset, 0, 0, MAX_OFFSET),
            })}`,
        );
    }

    if (SLUG.test(slug) !== true) {
        return { error: `\`${slug}\` is not a post slug; they read like \`what-the-changelog-is-for\`.` };
    }

    return fetched(
        $,
        `${base}/blog/${slug}.json?${query({
            section: text(e.section),
            offset: bounded(e.offset, 0, 0, PROSE_MAX_OFFSET),
            limit: TOOL_CHARS,
        })}`,
    );
};

/**
 * What one build actually told the model its tools do.
 *
 * The stock injected descriptions, captured per release, byte for byte as they
 * were sent. Not a description of the Read tool: the description Claude Code
 * was handed. A version with no capture is a 404 naming the ledger, because
 * the ledger is deliberately sparse and a missing capture is the common case
 * here rather than a typo.
 */
const promptsTool = async ($, e) => {
    const asked = await releaseAsked($, e.version);

    if (asked.error !== undefined) {
        return asked;
    }

    const base = await baseUrl($);
    const name = text(e.tool);

    if (name === undefined) {
        return fetched(
            $,
            `${base}/prompts/${asked.version}/tools.json?${query({
                limit: bounded(e.limit, 50, 1, PROMPT_TOOLS_LIMIT),
                offset: bounded(e.offset, 0, 0, MAX_OFFSET),
            })}`,
        );
    }

    if (PROMPT_TOOL.test(name) !== true) {
        return { error: `\`${name}\` is not a stock tool name; they read like \`Read\` or \`WebFetch\`.` };
    }

    return fetched(
        $,
        `${base}/prompts/${asked.version}/tools/${name}.json?${query({
            section: text(e.section),
            offset: bounded(e.offset, 0, 0, PROSE_MAX_OFFSET),
            limit: TOOL_CHARS,
        })}`,
    );
};

/** One fetch, the site's document or the site's own account of what was wrong. */
const fetched = async ($, url) => {
    const response = await fetchJson($, url);

    return response.ok === true ? response.json : problem(url, response);
};

/* -------------------------------------------------------------------------
 * What the model sees
 * ---------------------------------------------------------------------- */

/** The paging arguments, worded once because they mean the same on every tool. */
const PAGING = {
    offset: {
        type: "number",
        description:
            "Start here rather than at the first result. Hand back the `next_offset` of the " +
            "previous answer to continue; `next_offset: null` means there is nothing after this.",
    },
};

/**
 * What every tool this plugin serves tells the model, in the order a caller
 * usually needs them. The hooks that answer the calls are in `register`, one
 * per tool; only the declarations are gathered here.
 *
 * The first five are one tool split five ways rather than five separate ideas:
 * `releases` says what exists, `entries` says what one release holds, `entry`
 * reads one finding in full, `changelog` reads the release as a document, and
 * `search` crosses every release at once. Each description names the next one,
 * because a model that has just been handed a truncated list is exactly the
 * reader who needs to know which tool is not truncated.
 *
 * The last four are one corpus each, and they answer a different question:
 * `reference` is what a name is, `docs` is what Anthropic published, `blog` is
 * what this site's owner argued, and `prompts` is what the model was actually
 * told. Every one of them takes the index, the search and the document through
 * one tool, because the argument a caller has is a phrase and the arguments
 * the routes need are a key and a path.
 */
const TOOLS = [
    {
        name: "changelog",
        description:
            "The full changelog for one Claude Code release, from changelogs.core-directive.com: " +
            "what changed, why it matters, and what is present but switched off. " +
            "Omit `version` (or pass `latest`) for the newest release. A release's notes run to " +
            "hundreds of kilobytes, so this answers the summary, the document's `sections`, and one " +
            "window of the document; pass `section` to read one part rather than the head, and pass " +
            "`next_offset` back as `offset` to read on. To reach one entry rather than the prose " +
            "around it, use `entries` and `entry`; to cross releases, use `search`.",
        inputSchema: {
            type: "object",
            properties: {
                version: {
                    type: "string",
                    description: "A release, as `2.1.267`. Omitted or `latest`, the newest release.",
                },
                section: {
                    type: "string",
                    description:
                        "A heading from this release's `sections`, to read that section rather " +
                        "than the head of the document. Matched case-insensitively.",
                },
                ...PAGING,
            },
        },
    },
    {
        name: "search",
        description:
            "Search every Claude Code release the site has read, by entry: hit an entry's own " +
            "heading and prose rather than a whole release. Every term has to appear in the same " +
            "entry. Narrow with `version`, `tier` (`use`, `notice`, `soon`, `internal`) or `area`, " +
            "and page with `offset`; `total` says how many there really are. Each hit carries an " +
            "`anchor` the `entry` tool reads in full.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "The terms to look for, as a reader would type them." },
                limit: { type: "number", description: "At most this many hits (1-40, default 10)." },
                version: {
                    type: "string",
                    description: "Only this release, as `2.1.267` or `latest`. Omitted, every release.",
                },
                tier: {
                    type: "string",
                    description:
                        "Only entries of this tier: `use` (do something with it), `notice` " +
                        "(behaviour changed), `soon` (present but switched off), `internal`.",
                },
                area: { type: "string", description: "Only entries in this area, as `hooks` or `cli`." },
                ...PAGING,
            },
            required: ["query"],
        },
    },
    {
        name: "releases",
        description:
            "Which Claude Code releases the site has published, newest first, with each one's date, " +
            "entry count and one-line summary. This is how to answer what the newest version is, " +
            "what shipped since a date (`since`, as `2026-09-01`), or which versions exist at all. " +
            "A release marked `provisional: true` is a fast first look that a full run will replace.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "At most this many releases (1-100, default 20)." },
                since: {
                    type: "string",
                    description: "Only releases published on or after this date, as `2026-09-01`.",
                },
                ...PAGING,
            },
        },
    },
    {
        name: "entries",
        description:
            "Every entry in one release, in the order the release puts them, as headings with a " +
            "one-line summary each. Where `changelog` hands back the release's prose a window at a " +
            "time, this pages through its entries and narrows on `section`, `tier` or `area`. It also " +
            "answers `facets`: how many entries each section, tier and area holds, which is the " +
            "cheapest way to see the shape of a release before reading any of it. Read one entry " +
            "in full with the `entry` tool and the `anchor` given here.",
        inputSchema: {
            type: "object",
            properties: {
                version: {
                    type: "string",
                    description: "A release, as `2.1.267`. Omitted or `latest`, the newest release.",
                },
                section: { type: "string", description: "Only entries under this section heading." },
                tier: {
                    type: "string",
                    description: "Only entries of this tier: `use`, `notice`, `soon` or `internal`.",
                },
                area: { type: "string", description: "Only entries in this area, as `hooks` or `cli`." },
                limit: { type: "number", description: "At most this many entries (1-200, default 25)." },
                ...PAGING,
            },
        },
    },
    {
        name: "entry",
        description:
            "One changelog entry in full: the whole prose the release carries for it, as markdown, " +
            "rather than the one-line summary `search` and `entries` answer. Takes the `anchor` " +
            "either of those tools gave, plus its release.",
        inputSchema: {
            type: "object",
            properties: {
                version: {
                    type: "string",
                    description: "The entry's release, as `2.1.267`. Omitted or `latest`, the newest release.",
                },
                anchor: {
                    type: "string",
                    description: "The entry's `anchor`, as answered by `search` or `entries`.",
                },
            },
            required: ["anchor"],
        },
    },
    {
        name: "reference",
        description:
            "What a Claude Code environment variable, CLI flag, settings key, slash command, tool, " +
            "hook event or model id actually is, from the site's mined inventory of every name in " +
            "the shipped build. This is the tool for `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`, " +
            "`--resume`, `PostToolUse` and the like: it answers which builds a name has been seen " +
            "in, whether it is in the current one, whose sentence the description is " +
            "(`description_source`: `docs`, `entry` or `none`), and the changelog entries and " +
            "documentation pages that mention it. Pass `q` to search by part of a name; pass the " +
            "`family` and `slug` a hit carries to read one in full. Given neither, it lists the " +
            "families and says which build the inventory was mined from. `in_current_build` is " +
            "scoped to that mined build, which trails the newest release by several versions.",
        inputSchema: {
            type: "object",
            properties: {
                q: {
                    type: "string",
                    description: "Part of a name, as `CLAUDE_CODE_ENABLE` or `--resume`. Matched anywhere in it.",
                },
                family: {
                    type: "string",
                    description:
                        "One of `env`, `cli`, `flag`, `setting`, `slash`, `tool`, `hook`, `model`. " +
                        "Narrows a search, or lists that family on its own.",
                },
                slug: {
                    type: "string",
                    description: "One name's `slug`, as answered by a search. Needs `family` with it.",
                },
                limit: { type: "number", description: "At most this many names (1-100, default 25)." },
                ...PAGING,
            },
        },
    },
    {
        name: "docs",
        description:
            "Anthropic's own Claude Code, API and SDK documentation, as this site captured it, " +
            "with the text as published rather than as summarised. Pass `q` to search every " +
            "captured page and get the passage around each match; pass the `source` and `path` a " +
            "hit carries to read that page. Given neither, it lists the corpora there are. A page " +
            "answers one window at a time with the `sections` that name its parts: pass `section` " +
            "to read one part, and hand `next_offset` back as `offset` to read on. For what " +
            "changed rather than what is true, use `search` or `changelog`.",
        inputSchema: {
            type: "object",
            properties: {
                q: { type: "string", description: "A word or phrase, as `hooks` or `output styles`." },
                source: {
                    type: "string",
                    description: "A corpus key, as `claude-code`. Alone, lists that corpus's pages.",
                },
                path: {
                    type: "string",
                    description: "A page's `path`, as `cli/hooks`. Needs `source` with it.",
                },
                section: {
                    type: "string",
                    description: "A heading from the page's `sections`, to read that part rather than the head.",
                },
                limit: { type: "number", description: "At most this many hits or pages (default 10 / 50)." },
                ...PAGING,
            },
        },
    },
    {
        name: "blog",
        description:
            "The site owner's own writing about Claude Code, which is the one thing here that is " +
            "neither a changelog entry nor somebody else's documentation: the argument about why a " +
            "change matters, and what this site thinks of a feature. Given nothing, it lists the " +
            "published posts newest first with each one's standfirst; given a `slug`, it answers " +
            "that post's markdown a window at a time with the `sections` that name its parts.",
        inputSchema: {
            type: "object",
            properties: {
                slug: { type: "string", description: "A post's `slug`, as answered by the list." },
                section: { type: "string", description: "A heading from the post's `sections`." },
                limit: { type: "number", description: "At most this many posts (1-100, default 25)." },
                ...PAGING,
            },
        },
    },
    {
        name: "prompts",
        description:
            "What one Claude Code build actually told the model its tools do: the stock injected " +
            "tool descriptions, captured release by release, byte for byte as they were sent. Not " +
            "a description of the Read tool, the description Claude Code was handed. Given a " +
            "`version` alone it lists that build's tools in the order the client sent them, with " +
            "each one's size; given `tool` as well it answers that description a window at a time " +
            "with its `sections`. The ledger is sparse on purpose, so a version with no capture is " +
            "an answer saying so rather than an error to work around.",
        inputSchema: {
            type: "object",
            properties: {
                version: {
                    type: "string",
                    description: "A release, as `2.1.267`. Omitted or `latest`, the newest release.",
                },
                tool: {
                    type: "string",
                    description: "A stock tool's `name`, as `Read` or `WebFetch`, from the list.",
                },
                section: { type: "string", description: "A heading from the description's `sections`." },
                limit: { type: "number", description: "At most this many tools (1-100, default 50)." },
                ...PAGING,
            },
        },
    },
];

/* -------------------------------------------------------------------------
 * The poll
 * ---------------------------------------------------------------------- */

/**
 * Toasts once when a release this session has not announced shows up.
 *
 * Started from `session.start` rather than from the command, because the point
 * is a reader who never runs the command hearing about a release anyway. The
 * timer belongs to the module's environment and dies with it, which is what
 * makes a hot reload leave nothing behind.
 *
 * What it has announced is held in the module's own environment rather than in
 * the store, and that is the whole design rather than an oversight. The store
 * is shared by every session on the machine, so with eight terminals open the
 * first one to poll would record the release and the other seven would find
 * nothing new and say nothing: the reader gets the notice in whichever window
 * they were not looking at. Measured on this box, where eighteen sessions
 * raced for it. The store still keeps `seen`, because the pane's `*` marks
 * what the reader has actually looked at and that is a fact about the reader
 * rather than about a session.
 *
 * It writes no `seen` of its own for the same reason: the poll runs every half
 * hour whether or not anyone opened the pane, so a poll that marked the feed
 * seen would clear the reader's `*` before they ever looked at it. Only
 * `/whatsnew` marks a release seen, because only `/whatsnew` shows it to them.
 */
const watchForReleases = async ($) => {
    const announced = new Set((await $.store.get(SEEN_KEY))?.versions ?? []);

    // A machine that has never opened the pane knows nothing, so the first
    // pass records what is already out instead of announcing a three week old
    // release as news. Every pass after it announces.
    let seeded = announced.size > 0;

    const check = async () => {
        const feed = await loadFeed($);

        if (feed.error !== undefined) {
            return;
        }

        // Releases only. The feed carries the site's blog posts in the same
        // dated stream and none of them has a version, so without this every
        // post is forever unknown and the first one announced itself as
        // "Claude Code undefined is out".
        const fresh = feed.items.filter(
            (item) => item.version !== undefined && announced.has(item.version) !== true,
        );

        for (const item of fresh) {
            announced.add(item.version);
        }

        if (seeded !== true) {
            seeded = true;

            return;
        }

        if (fresh.length === 0) {
            return;
        }

        const headline =
            fresh.length === 1
                ? `Claude Code ${fresh[0].version} is out`
                : `${fresh.length} new Claude Code releases, newest ${fresh[0].version}`;

        $.ui.toast(`${headline} - /whatsnew to read it`, { timeoutMs: 10000 });
        $.ui.status(`${headline} (/whatsnew)`);
        $.ui.invalidate("ui.render");
    };

    await check();

    $.clock.every(POLL_MS, () => void check());
};

const markSeen = async ($, items) => {
    const versions = items.map((item) => item.version).filter((version) => version !== undefined);

    await $.store.set(SEEN_KEY, { versions });
};

/* -------------------------------------------------------------------------
 * The feed
 * ---------------------------------------------------------------------- */

/**
 * The feed as rows, with the reader's own "seen" flag folded in.
 *
 * The version is parsed off the item's URL rather than its title, because the
 * URL is the site's own identifier for a release and the title is prose.
 */
const loadFeed = async ($) => {
    const base = await baseUrl($);
    const response = await fetchJson($, `${base}/feed.json`);

    if (response.ok !== true) {
        return { items: [], error: `The changelog feed answered ${response.status}.` };
    }

    const seen = (await $.store.get(SEEN_KEY))?.versions ?? [];

    // Releases only. The feed is one dated stream carrying the site's blog
    // posts as well, and a post has no version, no changelog document and
    // nothing the detail tab could draw. Operator, 2026-09-10: "Blog posts can
    // be removed."
    const items = (response.json?.items ?? [])
        .map((item) => {
            const url = String(item.url ?? "");
            const version = (url.match(/\/v\/([0-9]+\.[0-9]+\.[0-9]+)/) ?? [])[1];

            return {
                id: String(item.id ?? url),
                version,
                title: String(item.title ?? ""),
                url,
                date: String(item.date_published ?? "").slice(0, 10),
                tabLabel: `v${version}`,
                summary: String(item.summary ?? ""),
                /** Only `/whatsnew` reads this, and only to freeze it into the view. */
                unseen: version !== undefined && seen.length > 0 && seen.includes(version) !== true,
            };
        })
        .filter((item) => item.version !== undefined);

    const version = await installed($);

    return { items, error: undefined, installed: version, behind: behindHint(items, version) };
};

/* -------------------------------------------------------------------------
 * Fetching, once
 * ---------------------------------------------------------------------- */

const baseUrl = async ($) => {
    // An override so the plugin can be run against a checkout of the site
    // (`php artisan serve`) before a change to it is live.
    const override = await $.env.get("CC_CHANGELOG_BASE_URL");

    return (override ?? DEFAULT_BASE).replace(/\/+$/, "");
};

const fetchJson = async ($, url) => {
    const response = await fetchText($, url);

    if (response.ok !== true) {
        return response;
    }

    try {
        return { ...response, json: JSON.parse(response.text) };
    } catch {
        return { ok: false, status: response.status, text: response.text, json: undefined };
    }
};

/**
 * A GET that costs the origin nothing it has already answered.
 *
 * Three things, and the first is the one that matters: the answer is kept in
 * `$.store`, which outlives the session, so a reader with eight terminals open
 * fetches the feed once per TTL rather than eight times a session apiece. The
 * TTL is the response's own `max-age` (the site says 1800 seconds on the feed
 * and 60 on the JSON routes, which it recomputes), never a number invented
 * here, so the origin stays in charge of its own caching. Past the TTL the
 * entry is revalidated rather than refetched where the origin sent an ETag,
 * and a 304 costs it a header rather than the document again.
 *
 * There is no way to abandon a request in flight: `HttpInit` takes a method,
 * headers and a body, and no signal, so a dispatch the reader walked away from
 * still pays for whatever it started. The cache is what keeps that cheap.
 */
const fetchText = async ($, url) => {
    const key = `${HTTP_PREFIX}${url}`;
    const cached = await $.store.get(key);
    const now = $.clock.now();

    if (cached !== undefined && cached.expiresAt > now) {
        return { ok: true, status: cached.status, text: cached.text };
    }

    const headers = { "user-agent": USER_AGENT, accept: "*/*" };

    if (cached?.etag !== undefined) {
        headers["if-none-match"] = cached.etag;
    }

    let response;

    try {
        response = await $.http.fetch(url, { headers });
    } catch (error) {
        // A fetch that failed with something cached is a reason to keep serving
        // the stale copy: an origin that is briefly down should not empty the
        // pane the reader is looking at.
        return cached === undefined
            ? { ok: false, status: 0, text: String(error) }
            : { ok: true, status: cached.status, text: cached.text };
    }

    if (response.status === 304 && cached !== undefined) {
        await $.store.set(key, { ...cached, expiresAt: now + ttlOf(response) });

        return { ok: true, status: cached.status, text: cached.text };
    }

    if (response.ok !== true) {
        return { ok: false, status: response.status, text: response.text ?? "" };
    }

    await $.store.set(key, {
        status: response.status,
        text: response.text,
        etag: response.headers?.etag,
        expiresAt: now + ttlOf(response),
        storedAt: now,
    });

    await pruneCache($);

    return { ok: true, status: response.status, text: response.text };
};

/** Drops all but the most recently fetched `CACHE_ENTRIES` documents. */
const pruneCache = async ($) => {
    const keys = (await $.store.keys()).filter((key) => key.startsWith(HTTP_PREFIX));

    if (keys.length <= CACHE_ENTRIES) {
        return;
    }

    const dated = await Promise.all(
        keys.map(async (key) => ({ key, storedAt: (await $.store.get(key))?.storedAt ?? 0 })),
    );

    dated.sort((a, b) => b.storedAt - a.storedAt);

    for (const entry of dated.slice(CACHE_ENTRIES)) {
        await $.store.delete(entry.key);
    }
};

/** How long the origin said its own answer may be held. */
const ttlOf = (response) => {
    const control = response.headers?.["cache-control"] ?? "";
    const maxAge = (control.match(/max-age=([0-9]+)/) ?? [])[1];

    return maxAge === undefined ? FALLBACK_TTL_MS : Number(maxAge) * 1000;
};

/* -------------------------------------------------------------------------
 * Odds and ends
 * ---------------------------------------------------------------------- */

/**
 * What a `tool.call` hook is allowed to answer with.
 *
 * Core validates the result against the tool's output shape, which is a string,
 * an array of content blocks, or nothing; an object answered raw is refused
 * with `a result that does not match its output shape` and the model is told
 * the call failed. These tools answer documents rather than prose, so they are
 * serialised here in one place rather than at each `return`.
 */
const asToolResult = (value) => JSON.stringify(value, null, 2);

const setView = async ($, view) => {
    const current = (await $.store.get(VIEW_KEY)) ?? {};

    await $.store.set(VIEW_KEY, { ...current, ...view });
};

/** A string argument that was actually given, trimmed, or nothing. */
const text = (raw) => {
    const value = typeof raw === "string" ? raw.trim() : "";

    return value === "" ? undefined : value;
};

/** A number argument, held inside the range the site will accept. */
const bounded = (raw, fallback, min, max) => {
    const value = Math.trunc(Number(raw));

    return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
};

/** A query string, with every argument nobody gave left out of it. */
const query = (params) =>
    Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join("&");

/**
 * What went wrong, in the site's own words where it said any.
 *
 * The site answers a malformed argument with a 422 carrying `error`, the
 * parameter's name and what it would have accepted, and an unknown release or
 * entry with a 404 carrying the same shape. Passing that through is the whole
 * point: a model told "Unusable tier: urgent" with the four real tiers beside
 * it fixes its own call, where "answered 422" only tells it to give up.
 */
const problem = (url, response) => {
    const said = parsedJson(response.text);

    return {
        error: typeof said?.error === "string" ? said.error : `${url} answered ${response.status}.`,
        ...(Array.isArray(said?.allowed) ? { allowed: said.allowed } : {}),
    };
};

const parsedJson = (raw) => {
    try {
        return JSON.parse(raw ?? "");
    } catch {
        return undefined;
    }
};

const clip = (text, chars) => (text.length <= chars ? text : `${text.slice(0, chars - 1)}…`);
