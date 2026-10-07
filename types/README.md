> **AI-written from operator direction.** The intent is the operator's; the wording and scope are an agent's.
> `session: 6a501c72-fa3b-4836-9a4d-bbd91a27ec9c | 2026-09-11 | source: op:2026-09-11-0409-2a5c`

# claude-code.d.ts

599 KB of TypeScript declarations for Claude Code's function-hooks plugin
runtime: every event's input and result, every noun and method on `$`, every
element each surface draws and the props it takes.

## Where it came from

Nobody wrote it. Claude Code writes it, from the build you are running, each time it loads a mod from a folder you own, beside that mod as `.claude-plugin/types/claude-code/index.d.ts`. Up to 2.1.286 you typed `/plugin-types` in a session for it, and that command is gone at 2.1.287. The copy here is what build **2.1.293** ships, read out of its binary on 2026-10-07 (the same text the engine writes, with the version line it adds), and its own header opens:

> Written by Claude Code 2.1.293.
> EARLY ACCESS: this surface may change between releases without notice.

It was checked in because a plugin is no use to anybody who cannot see the API it is written against, and at the time this was published no page of `code.claude.com/docs` mentioned the runtime at all. Not one of the 192 documentation pages captured on 2026-09-11 names `modules`, `surface`, `$.ui.render` or `register`. Anthropic published [their mods docs](https://code.claude.com/docs/en/plugins/mods/overview) with 2.1.287, and [Create a mod](https://code.claude.com/docs/en/plugins/mods/create) lists every file the engine writes into `.claude-plugin/types/`.

## Read it against your own build, not against this one

**The copy your build writes is the authority. This one is a convenience and a historical record.** The surface is early access and the header says it may move between releases without notice, so a declaration here that disagrees with your editor is this file being old rather than your build being wrong.

To get your build's copy, point Claude Code at a mod folder and let it load:

```bash
claude --plugin-dir ./my-mod
# then look in ./my-mod/.claude-plugin/types/
```

Beside this file it writes `claude-code-tools/index.d.ts` and `claude-code-mcp/index.d.ts`, which declare the built-in tools and the MCP tools connected to *that* session, a directory for each plugin your `plugin.json` lists under `dependencies`, and a `tsconfig.json`. Only this one is here, because the others describe somebody else's machine.

## Terms

This file is Anthropic's, not this repository's, and the MIT licence at the
root does not cover it. It is redistributed here unmodified, for reference.
If that is not something Anthropic wants published, say so and it comes out.

## Using it

`jsconfig.json` at the root of this repo is the configuration the file's own
header recommends, already filled in. In a JavaScript hooks module:

```js
/** @type {import('claude-code').Register} */
export const register = (on, options) => { /* ... */ }
```

In TypeScript, `import type { Register, On, EngineInterface } from 'claude-code'`. At run time that import holds only the state helpers (`atom`, `derive`, `memberOf`, `read`, `update`); everything else in it is types.

One shape worth knowing before you read: the types are the **engine's** own,
not the Messages API's. `$.session.messages()` answers `SessionMessage` rows of
`{ role, text, toolUses }`, not content blocks.
