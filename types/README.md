> **AI-written from operator direction.** The intent is the operator's; the wording and scope are an agent's.
> `session: 6a501c72-fa3b-4836-9a4d-bbd91a27ec9c | 2026-09-11 | source: op:2026-09-11-0409-2a5c`

# claude-code.d.ts

450 KB of TypeScript declarations for Claude Code's function-hooks plugin
runtime: every event's input and result, every noun and method on `$`, every
element each surface draws and the props it takes.

## Where it came from

Nobody wrote it. Claude Code writes it, from the build you are running, when
you type `/plugin-types` in a session. The copy here is what build **2.1.278**
ships, read out of its binary on 2026-09-18 (the same text the command
writes, with the version line the command adds), and its own header says the
rest:

> Written by Claude Code 2.1.278.
> EARLY ACCESS: this surface may change between releases without notice.
> Written by `/plugin-types`; regenerate with that command after an update
> rather than editing. The first line names the Claude Code version that
> wrote it. TypeScript 5.4 or newer reads it.

It is checked in because a plugin is no use to anybody who cannot see the API
it is written against, and at the time this was published no page of
`code.claude.com/docs` mentioned the runtime at all. Not one of the 192
documentation pages captured on 2026-09-11 names `modules`, `surface`,
`$.ui.render` or `register`.

## Read it against your own build, not against this one

**The copy your build writes is the authority. This one is a convenience and a
historical record.** The surface is early access and the header says it may
move between releases without notice, so a declaration here that disagrees
with your editor is this file being old rather than your build being wrong.

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
# then, in the session:
/plugin-types
```

It takes an optional directory and defaults to `.claude/types`. It writes two
files: this one, and `claude-code-mcp.d.ts`, which declares the inputs of the
MCP tools connected to *that* session, so `e` narrows per tool. Only the first
is here, because the second is a description of somebody else's machine.

`/plugin-types` and the `plugin-authoring` skill are both gated on the same
switch as the runtime itself, so a build with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`
unset has neither and will tell you the command does not exist.

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

In TypeScript, `import type { Register, On, EngineInterface } from 'claude-code'`.
At run time that import is empty: the module exists for its types.

One shape worth knowing before you read: the types are the **engine's** own,
not the Messages API's. `$.session.messages()` answers `SessionMessage` rows of
`{ role, text, toolUses }`, not content blocks.
