# Hooks API: composing, filtering and naming `@fluex/flue-hooks` the Flue way

Date: 2026-10-15 · Flue 2.3.0 (`@flue/runtime`, installed) · Consumer: `target-app-flue` · Builds on
[composition.md](composition.md), [flows.md](flows.md), [sandbox-security.md](sandbox-security.md).

Docs paths below are relative to `node_modules/.pnpm/node_modules/@flue/runtime/docs/`; `dist/` paths to the
same package. Line numbers are from the installed files. fluex paths are relative to `packages/flue-hooks/src/`.

## Problem

Today an agent opts into Claude-compatible hooks like this (`target-app-flue/src/agents/smoke/smoke.ts`):

```ts
logToolCalls();                       // module scope, process-wide, first call wins
const hooks = claudeHooks();          // module scope, returns { pre: [fn], post: [fn] }
export function Smoke({ id }: AgentProps) {
	return useSmoke({ sandbox: withToolHooks(targetApp(sandbox), hooks), id }); // useRequiredSkills(id, 'ast-grep') inside
}
```

Complaints: one wrapper takes every hook at once; nothing can be excluded (hooks, tools, skills);
"tool hooks" is the wrong noun next to skills; other mismatches. This note checks each against Flue.

## 1. Flue's design principles (verified)

| Principle | Evidence |
|---|---|
| An agent is a function, not a config object; capabilities come from `use*` hooks | `guide/why-flue.md:46-48`; `guide/agent-hooks.md:13` ("hooks … all start with `use`") |
| React-like re-render before every model call; hooks re-run each time | `reference/agent-hooks-api.md:30`; `guide/building-agents.md:36,47` |
| Hooks only during render; module scope throws; renders are pure reads | `reference/agent-hooks-api.md:34-36` |
| **Reuse unit = custom hook**: plain `use*` function, no registration, no wrapper | `reference/agent-hooks-api.md:377`; `guide/agent-hooks.md:259-277` (`useGitHub()` bundles tools, skills, instructions) |
| **Many calls stack** (`useTool`, `useSkill`, `useSubagent`, `useInstruction`, event hooks); **single owners throw on a 2nd call** (`useModel`, `useSandbox`) | `reference/agent-hooks-api.md:40-43`; `guide/sandboxes.md:108` |
| Resources are conditional; **exclusion = don't mount**. "An unmounted tool can't be called — a stronger guarantee than an instruction" | `guide/tools.md:192-222`; `reference/agent-api.md:713` (Dynamic resources) |
| Overrides by **spread**: `{ ...def, field }` for tools, MCP, subagents | `reference/agent-hooks-api.md:380-388` (`useRetention` wraps `offerCredit.run`); `reference/agent-api.md:614,648` |
| Wrapping a tool = spread the definition and replace `run` inside a custom hook | `reference/agent-hooks-api.md:380-388`; `guide/mcp.md:140-152` (`createMcpConnection` returns `ToolDefinition`s "so trusted application code can filter or wrap them before mounting") |
| Naming: `use*` = render hook; `define*` = validate-and-freeze at module load (`defineTool/Skill/Subagent/McpConnection`); `create*` = build a runtime value (`createReadTool`, `createMcpConnection`); bare lowercase factories for sandboxes (`local()`, `bash()`) | `reference/agent-api.md:493-510,575-581,648,686`; `reference/sandbox-api.md:322-333` |
| Module-scope, process-wide registration is reserved for observation: `observe()`, `instrument()` (with a `key` to prevent double install) | `reference/events.md:11-31,601-621` |
| Event hooks stack, run in declaration order (`useAgentFinish`) or concurrently (`useAgentStart`) | `reference/agent-hooks-api.md:287,328` |

### Filter / allowlist mechanisms Flue has (and lacks)

| Resource | Native include/exclude | Evidence |
|---|---|---|
| `useTool` tools | conditional mount only | `guide/tools.md:192` |
| MCP tools | `tools: [...]` allowlist on the connection; or `createMcpConnection` + filter + `useTool` | `guide/mcp.md:99-112,140`; `reference/agent-api.md:682` |
| Sandbox tools (`read`…`glob`) | `SandboxFactory.tools` **replaces** the six; compose from `create*Tool` to "add, drop, or swap" | `reference/sandbox-api.md:277-299,333`; `guide/sandboxes.md:174-176` |
| Framework tools (`task`, `activate_skill`, `read_skill_resource`) | none; reserved names, appended separately | `reference/sandbox-api.md:295-299`; `guide/tools.md:94` |
| Declared skills | conditional `useSkill` | `guide/skills.md:96` |
| Workspace skills (`<cwd>/.agents/skills/`) | **none**: every valid `SKILL.md` joins; a name clash with a declared skill throws | `guide/skills.md:166-178`; `dist/conversation-stream-store-*.mjs:370-414` (`discoverLocalSkills`, `mergeSkillCatalog`) |
| Skill `allowed-tools` | accepted, **not enforced** | `guide/skills.md:58-60` |
| Subagents | conditional `useSubagent`; `task` always present but inert with no roster | `reference/agent-hooks-api.md:173` |
| Tool-call interception | no render hook. Two seams: `SandboxFactory.tools` (sandbox tools only), and `instrument()`'s interceptor (every tool, process-wide, see §4) | `reference/sandbox-api.md:290`; `reference/events.md:623-659` |

## 2. Current fluex API vs Flue idiom

| fluex today | Flue idiom? | Mismatch | Idiomatic shape |
|---|---|---|---|
| `withToolHooks(factory, { pre: [], post: [] })` (`tool-hooks.ts:55`) | Partly: a factory wrapper is the right seam (the interception slot lives on `SandboxFactory`), but one call owns every hook | Bundles; pre/post split into two arrays; no per-hook matcher | One interceptor per wrapper, composable by nesting or a variadic call; matcher per interceptor (§3) |
| `ToolHooks { pre, post }`, `PreToolHook`, `PostToolHook` | No | In Flue "hook" means a `use*` render function (`guide/agent-hooks.md:13`); these are callbacks around execution, which Flue calls an **interceptor** (`reference/events.md:653`) or a guard/gate (`guide/tools.md:228`) | `ToolInterceptor = (call, next) => Promise<result>`, matching `FlueExecutionInterceptor`'s shape (`reference/events.md:626-630`) |
| `ToolCall` covers only `read/write/edit/bash/grep/glob` | Name over-promises | `activate_skill`, `task`, `read_skill_resource`, `useTool` and MCP tools are not sandbox tools and are never seen (`tool-hooks.ts` docblock; `reference/sandbox-api.md:295-299`) | Say "sandbox tools" in the names (`SandboxToolCall`) |
| `claudeHooks()` at module scope | OK: a plain value factory, like `define*` | Its cache is keyed on the wrong object (bug below) | Keep as a value; rename the return type |
| `useRequiredSkills(id, ...names)` | Yes: a real custom hook built on `useAgentFinish` | `id` must be threaded because `AgentFinishContext.response.toolCalls` has only `{ tool, isError }` (`dist/agent-execution-store-*.d.mts:653-658`) and Flue has no `useAgentId()`; `FlueHarness` carries no id (`dist/types-*.d.mts:858-893`). Only `AgentProps.id` has it (`:745-751`) | Keep `id`; it is the honest contract. Optional spike in §6 |
| `observe(...)` at `skills.ts:37` module load | Yes: `observe` is meant for module scope (`reference/events.md:26`) | — | — |
| `logToolCalls()` with an `installed` flag (`tool-log.ts:254-260`) | Mostly | First call wins, later options silently ignored; Flue's own pattern is `instrument({ key })`, newest wins in dev (`reference/events.md:616`) | Keyed install, or `observe` returning an unsubscribe |
| `onHookReport` / `onHookRun` (`hook-reports.ts`) | No | A second, fluex-only event bus beside Flue's events | Put hook outcomes on the tool result (`details`) and the thrown error (`name`), so `observe()` `tool` events carry them (unverified that `details` reaches `FlueObservation.result`) |
| Package name `flue-hooks` | Confusing | Mixes a Flue hook (`useRequiredSkills`), Claude Code hooks, and a logger | Open question (§7) |

### Bug found while verifying: settings are re-read every turn, not once per sandbox

`claudeHooks` caches settings in `WeakMap<Sandbox, …>` keyed on `call.sandbox` (`claude-hooks.ts:63`), the
object `SandboxFactory.tools` receives. That object is **rebuilt on every tool-list assembly**:
`overlayPackagedSkills` returns `{ ...env, readFile }` (`dist/result-*.mjs:22-32`), called from
`createBuiltinToolGroups` (`dist/conversation-stream-store-*.mjs:3564-3581`), which runs at init and at every
turn in `prepareRerenderTurn` (`:1267-1277`). The docs say the same: `tools` "is invoked each time the runtime
assembles the model's tool list — at initialization and again at every turn boundary" (`reference/sandbox-api.md:292`),
and the sandbox it gets "is not the identical object `harness.sandbox` exposes" (`:293`).

Effect: `.claude/settings*.json` is read on the first hooked call of **every turn**. Read from the code, not
run. So the `claudeHooks` docblock ("once per sandbox") is wrong, and so is `sandbox-security.md` row 6: a
model edit to `settings.json` takes effect **next turn**, not next sandbox. Fix: key the cache on the object
`createSandbox()` returns (stable per harness, `reference/sandbox-api.md:24`), captured by wrapping
`createSandbox` in the factory wrapper.

### Smaller gaps against Claude Code's hook semantics

Claude Code reference: <https://code.claude.com/docs/en/hooks> (fetched 2026-10-15).

| Claude Code | fluex `claudeHooks` | Gap |
|---|---|---|
| Matcher: `*`/empty = all; only `[A-Za-z0-9_\- ,\|]` = exact name or `\|`/`,` list; anything else = **unanchored** JS regex | Always `new RegExp('^(?:m)$')` (`claude-hooks.ts:118`) | `"Edit, Write"` matches nothing in fluex; unanchored regexes differ |
| Per-handler `if` (permission-rule syntax, e.g. `Bash(git *)`) | ignored | Hooks run more often than in Claude Code |
| PreToolUse also matches `Skill`, `Agent`, `mcp__*` tools | `CLAUDE_TOOL` maps only the six (`claude-hooks.ts:9`) | Hooks on `Skill`/`Agent`/MCP silently never run |
| Matching hooks run in parallel; decisions `deny > defer > ask > allow` | `Promise.all`, any block wins | Same in practice |
| Skills and subagents can carry `hooks:` in frontmatter, active after the skill is invoked | — | Flue ignores unknown `SKILL.md` frontmatter (`guide/skills.md:62`), so skill-scoped hooks would be fluex's job |

## 3. Options: composition

Constraints (verified):
- `useSandbox` at most once per render; it throws in subagent renders (`reference/agent-hooks-api.md:115`).
  Subagents share the parent's sandbox and its tools (`guide/subagents.md:61`), so interceptors on the factory
  also cover subagents' sandbox calls.
- The factory and its `tools` are **submission-scoped**: read once when a submission starts, not per render
  (`reference/agent-hooks-api.md:47`; `guide/sandboxes.md:214`). A per-render `useToolHook()` cannot
  add or remove an interceptor mid-submission through this seam.
- `tools()` must be synchronous and return a fresh array on every call (`reference/sandbox-api.md:292`).
- Every tool, whatever its source, runs through `wrapModelTool` → `interceptExecution({ type: 'tool' })`, after
  `tool_start` (with `args`) has been emitted synchronously (`dist/conversation-stream-store-*.mjs:3283-3341`,
  `:3450-3467` for custom tools).

| Option | Sketch | For | Against |
|---|---|---|---|
| **A. Nesting (works today)** | `withToolHooks(withToolHooks(f, a), b)` | No change: `base = factory.tools ?? defaultTools` (`tool-hooks.ts:56`) wraps what is already wrapped | Onion order (outer pre first, inner post first) is implicit; `{pre, post}` stays |
| **B. Middleware, variadic** | `interceptSandboxTools(f, claudeHooks(), denyGitPush, lintKotlin)`; each `(call, next) => …` | One concept instead of pre/post; block = don't call `next`; post = edit `await next()`; order = argument order; same shape as Flue's `FlueExecutionInterceptor` | Breaking rename; Claude's parallel-run semantics live inside `claudeHooks` only |
| **C. Render-scoped `useToolHook(h)` + `useHookedSandbox(f)`** | hooks recorded in a render list, read by the factory | Looks like Flue (`use*`, stacks) | Flue exposes no render-frame storage to custom hooks; the factory is submission-scoped, so conditional hooks would apply one submission late; order between `useToolHook` and `useHookedSandbox` in one render matters. A `use*` name would promise per-render semantics the seam cannot give |
| **D. Process-wide `instrument()` interceptor** | `instrument({ key, observe: stashArgs, interceptor: (op, ctx, next) => op.type === 'tool' ? guard(op, ctx, next) : next() })` | Covers **all** tools: `activate_skill` (Claude `Skill`), `task` (Claude `Agent`), MCP, `useTool`; documented skip/replace: "Not calling it skips the wrapped work … the interceptor's return value becomes the operation's result" (`reference/events.md:656`) | Built for tracing; no args on the operation (only `toolCallId`, `toolName`), so args come from the preceding `tool_start` observation (`reference/events.md:27,584`); process-wide, scoped only by `ctx.agentName`/`instanceId`; not a render hook. Not run |
| **E. Tool-definition wrapper for `useTool`/MCP** | `useTool(guardTool(def, interceptor))` = `{ ...def, run: (ctx) => … def.run(ctx) }` | The documented Flue idiom (`useRetention`, `reference/agent-hooks-api.md:380`) | Only for `ToolDefinition`s, not sandbox tools |

```ts
// Option B, typed
type SandboxToolCall = { tool: string; toolCallId: string; input: Record<string, unknown>; sandbox: Sandbox; signal?: AbortSignal };
type ToolInterceptor = (call: SandboxToolCall, next: () => Promise<AgentToolResult>) => Promise<AgentToolResult>;
export function interceptSandboxTools(factory: SandboxFactory, ...interceptors: ToolInterceptor[]): SandboxFactory;

const denyGitPush: ToolInterceptor = onTools(['bash'], async (call, next) =>
	/\bgit\s+push\b/.test(String(call.input.command)) ? blocked('git push is the orchestrator\'s job') : next());
```

## 4. Options: filtering and exclusion

| What | Flue gives | fluex would add | Sketch |
|---|---|---|---|
| Which interceptor applies to which call | — | A matcher per interceptor, like Claude's `matcher` | `onTools(['edit', 'write'], i)` or `{ match: /^(edit\|write)$/, run }`; `claudeHooks({ events: ['PreToolUse'], exclude: [/kotlin-lint/] })` to drop a repo's scripts |
| Which sandbox tools exist | `tools` slot + `create*Tool` (`reference/sandbox-api.md:333`) | `withSandboxTools(f, { exclude: ['write', 'edit'] })`, the base for read-only roles | Planner is "read-only by prompt" today (`use-planner.ts`); dropping `write`/`edit` makes it mechanical (bash can still write) |
| Which workspace skills are offered | nothing | `withSkills(f, { only \| exclude })`: wrap `createSandbox` and filter `readdir(<cwd>/.agents/skills)` | Discovery goes through `env.exists/readdir/stat/readFile` on the attached sandbox (`dist/conversation-stream-store-*.mjs:370-404,464-465`), and activation resolves only names in the catalog (`:3264-3266`), so hiding works at both points. Not a boundary: the model can still `read` the hidden `SKILL.md`. Not run |
| Which declared skills / tools / subagents / MCP tools | conditional mount; MCP `tools` allowlist | nothing: role hooks decide what they mount | — |
| Required skills | `useAgentFinish` (names only) | exists: `useRequiredSkills` | — |

## 5. Naming: tools, skills, hooks

| Term | In Flue | In Claude Code | Consequence for fluex |
|---|---|---|---|
| **tool** | Model-callable function; sandbox brings six, framework adds `task`/`activate_skill`/`read_skill_resource`, plus `useTool` and MCP (`guide/tools.md:79-96`) | Same, incl. `Skill`, `Agent`, `mcp__*` | "tool" is the right noun for what is intercepted, but fluex covers only **sandbox** tools: say so |
| **skill** | Procedure text, disclosed through the `activate_skill` **tool** (`guide/skills.md:143-147`) | Same, through the `Skill` tool; skills may also carry hooks | Skills are not intercepted; they are *a tool call* (`activate_skill`) plus catalog contents. "Skill hooks" would mean either intercepting `activate_skill` (needs option D) or skill-scoped hooks from frontmatter |
| **hook** | `use*` render function; "event hooks" = `useAgentStart/Finish`, `useResponseStart/Finish` (`guide/agent-hooks.md:112-153`) | Shell command on a lifecycle event (`PreToolUse`, …) | Collision. In Flue, `PreToolHook` reads as a kind of `use*`. Keep "hooks" only for the Claude compat layer (`claudeHooks`, where it is Claude's word); call fluex's own callbacks interceptors |

Answer to "why tools and not skills": the interception point is the tool call, and a skill reaches the
model only as a tool call (`activate_skill`). The problem is not the noun "tool" but that fluex hooks only the
six sandbox tools while the names promise all tools.

## 6. Fit with fluex's roles philosophy

- fluex is a library, not a framework; no DSL (`IMPLEMENTATION_PLAN.md` §13, §18 "Standing decisions").
- "Flue's reuse unit is the custom hook. A role hook bundles model, sandbox, instructions, prompt, and result"
  ([composition.md](composition.md) §2); `useCodingRole` is in the backlog (`IMPLEMENTATION_PLAN.md:462`);
  `usePlanner`/`useImplementer`/`useSmoke` already follow it in `target-app-flue`.
- Because `useSandbox` has one owner per render, the **role hook** owns it. Interceptors and filters are
  values passed to the role, composed into the factory there. The agent file only picks values.

## 7. Recommendation (proposal, not decided)

1. **Rename and simplify the core** (option B): `interceptSandboxTools(factory, ...interceptors)`, `ToolInterceptor = (call, next)`.
   Remove `{pre, post}`. Nesting stays valid. Keep `withToolHooks` as a deprecated alias for one release, or drop it (no external users).
2. **Matchers as plain helpers**, not options: `onTools(names | RegExp, interceptor)`; `claudeHooks()` gains Claude's
   real matcher semantics (exact list vs unanchored regex) and an `exclude` filter for scripts.
3. **Filters as factory wrappers**: `withSandboxTools(f, { only | exclude })`, `withSkills(f, { only | exclude })`
   (replaces backlog `withSkillFilter`, `IMPLEMENTATION_PLAN.md:458`). Order inside a role: `interceptSandboxTools(withSandboxTools(withSkills(base, …), …), …)`.
4. **Role hook as the composition point**:
   ```ts
   export function useCodingRole({ model, sandbox, interceptors = [], skills, readOnly, prompt, result }: CodingRole) {
   	useModel(model);
   	useSandbox(interceptSandboxTools(withSandboxTools(withSkills(sandbox, skills), readOnly ? { exclude: ['write', 'edit'] } : {}), ...interceptors));
   	useStructuredResult(result.name, result.schema);
   	return prompt;
   }
   // agent file
   return useCodingRole({ model, sandbox: targetApp(key), interceptors: [claudeHooks(), denyGitPush], skills: { only: ['ast-grep'] }, … });
   ```
5. **Drop `hook-reports.ts`**: carry outcomes on the result `details` / a `ToolBlockedError` name, and let
   `ToolLog` read them from `observe()`. Needs a check that `details` reaches the `tool` observation.
6. **Fix the settings cache** (§2 bug) and update `sandbox-security.md` row 6.
7. **Keep `useRequiredSkills(id, …)`**; rename nothing there.
8. **Spike option D** only if all-tool coverage (`Skill`/`Agent`/MCP matchers in `.claude/settings.json`) becomes a need.

## 8. Open questions

- Package name: `flue-hooks` → e.g. `flue-guards`, `flue-tools`, or split (`claude-hooks`, `tool-log`, roles)?
- Should `claudeHooks` warn when a settings matcher targets a tool fluex cannot see (`Skill`, `Agent`, `mcp__*`, `NotebookEdit`)?
- Is the interceptor's `next()` result for sandbox tools the raw `AgentToolResult`, so option D can append feedback the way post hooks do? (Unverified.)
- Do `useAgentFinish` callbacks run inside the `agent` interceptor's async context ("Scopes nest", `reference/events.md:655`)?
  If yes, an `AsyncLocalStorage` set by an interceptor could drop the `id` argument of `useRequiredSkills`. (Unverified.)
- Skill-scoped hooks (Claude's `hooks:` in `SKILL.md` frontmatter): wanted for target repos, or out of scope?
- `withSandboxTools` default set: rebuild from `create*Tool` (as `defaultTools` does, `tool-hooks.ts:39`), which moves
  the six tools from Flue's `builtin` group to `adapter`, so observations report `origin: 'adapter'` instead of `'model'`
  (`dist/conversation-stream-store-*.mjs:3279`; `reference/events.md:582`). Acceptable?

## 9. Decisions (grilling, 2026-10-15)

These supersede the proposal in §7 where they differ. Not decided, left open: stopping the whole agent from an
interceptor (Claude's `continue: false`); skill-scoped hooks from `SKILL.md` frontmatter.

**D1. Interceptor shape: middleware `(call, next)`, variadic, `next(input?)`.** One concept replaces `{pre, post}`;
order = argument order; same shape as Flue's `instrument()` interceptor. `claudeHooks()` becomes one interceptor
on this layer; "hooks" stays only for Claude's own vocabulary. Name of the generic layer: open.

How an interceptor maps to Claude Code's PreToolUse (keep for user docs):

| Claude PreToolUse | Interceptor `(call, next)` | `claudeHooks` today |
|---|---|---|
| **Allow / continue** (exit 0) | `return next()` | ✓ |
| **Block** (exit 2, `permissionDecision: "deny"`) | `return blocked(reason)` without calling `next`; the model sees the reason as the tool error | ✓ |
| **Add context** (`additionalContext`) | `const r = await next(); return withContext(r, text)` | ✗ ignored on Pre (only Post feedback is read) |
| **Change the input** (`updatedInput`) | `return next({ ...call.input, command: safer })` | ✗ not supported |
| **Stop the whole agent** (`continue: false`) | no clean equivalent: a thrown error becomes a tool error and the model continues; needs Flue's abort or an `instrument()` `agent` interceptor (unverified) | ✗ |
| **Ask the user** (`ask`) | n/a in unattended runs | — |

```ts
const guard: ToolInterceptor = async (call, next) => {
	if (isGitPush(call)) return blocked('the orchestrator pushes');            // block
	if (isGradle(call)) call = { ...call, input: withOfflineFlag(call.input) }; // change the input
	const result = await next(call.input);                                      // continue
	return withContext(result, 'Note: tests run via ./gradlew jvmTest');        // add context
};
```

The model reads nothing while a tool runs; Claude Code also delivers `additionalContext` with the tool result,
so appending to the result is equivalent.

**D2. Coverage: per agent, two entry points, same interceptor values. No `instrument()` layer.**

| Tool the model calls | Comes from | Intercepted by |
|---|---|---|
| `read` `write` `edit` `bash` `grep` `glob` | `SandboxFactory.tools` | `interceptSandboxTools(factory, …)` |
| `useTool(def)` tools, MCP tools | host `ToolDefinition` | `useTool(interceptTool(def, …))` (spread, Flue idiom) |
| `activate_skill`, `read_skill_resource`, `task` | Flue framework | not intercepted — by design |

Why not the framework row: every use has a better tool — hide skills with `withSkills({ exclude })`, check them
with `useRequiredSkills`, log them via `observe()`, limit subagents by not mounting them. What a skill makes the
model *do* (bash, edit) is still intercepted. Only gap: `Skill` / `Agent` matchers in `.claude/settings.json`;
`claudeHooks` warns that they are not covered.

**D3. Composition happens in the agent body — the general pattern for every fluex extension.** fluex ships
*values* (factory wrappers, interceptors, definitions) and small `use*` hooks; the agent body is a flat list of
`use*` calls that mounts them. Shared fragments become small custom hooks that each do one thing (Flue's
`useEscalation()` pattern, `guide/agent-hooks.md` "Custom hooks"). No config-object role hook: Flue agents are
functions, not config (`guide/why-flue.md`). Exclusion = delete the line. Supersedes `useCodingRole`
([composition.md](composition.md) §2, `IMPLEMENTATION_PLAN.md` backlog) — revise those later.

```ts
const guards = [claudeHooks(), denyGitPush];                 // module scope, values

export function Implementer({ id }: AgentProps) {
	useModel('anthropic/claude-sonnet-4-6');
	useSandbox(interceptSandboxTools(withSkills(targetApp(key), { only: ['ast-grep'] }), ...guards));
	useTool(interceptTool(reportImplementation, ...guards));
	useRequiredSkills(id, 'ast-grep');
	return implementPrompt;
}

function useTargetAppSandbox(key: string, guards: ToolInterceptor[]) {   // shared fragment: one thing only
	useSandbox(interceptSandboxTools(withSkills(targetApp(key), { only: ['ast-grep'] }), ...guards));
}
```

**D4. Naming: "interceptor", one overloaded `with*` wrapper.** `ToolInterceptor = (call, next) => …` uses Flue's
own word for the `next` shape (`FlueExecutionInterceptor`, `reference/events.md`). Every value wrapper is `with*`
(`withInterceptors`, `withSkills`, `withSandboxTools`); every mount is `use*`. Reading rule for the agent body:
**`with*` wraps a value, `use*` mounts it.** `withInterceptors` accepts a `SandboxFactory` (has `createSandbox`)
or a `ToolDefinition` (has `run`) and returns the same kind. This replaces the names `interceptSandboxTools` /
`interceptTool` used in D1–D3 above.

```ts
useSandbox(withInterceptors(withSkills(targetApp(key), { only: ['ast-grep'] }), ...guards)); // SandboxFactory → SandboxFactory
useTool(withInterceptors(reportImplementation, ...guards));                                 // ToolDefinition → ToolDefinition
```

**D5. An interceptor is an object: one matcher list, one `intercept`.** Chosen over Flue's branch-inside style
(`reference/events.md:31`) for readability: what an interceptor applies to is visible at a glance. `tools`
omitted = every intercepted tool. Before/after is decided by where the code sits relative to `next()`.

```ts
interface ToolInterceptor {
	tools?: string[];                                         // matcher; omitted = all
	intercept(call: ToolCall, next: (input?: Record<string, unknown>) => Promise<ToolResult>): Promise<ToolResult>;
}

const denyGitPush: ToolInterceptor = {
	tools: ['bash'],
	intercept: async (call, next) =>
		/\bgit push\b/.test(call.input.command) ? blocked('orchestrator pushes') : next(), // before: decide, maybe skip
};

const lintKotlin: ToolInterceptor = {
	tools: ['edit', 'write'],
	intercept: async (call, next) => {
		const result = await next();                                  // the tool runs here
		return withContext(result, await lint(call));                 // after: inspect / extend the result
	},
};
```

The D1 table's `(call, next)` column now reads as the body of `intercept`.

**D6. Outcomes travel on Flue's events; `hook-reports.ts` is deleted.** A block throws `ToolBlockedError`
(`code: 'FLUEX_TOOL_BLOCKED'`; `name`/`code`/`message` reach the `tool` observation's `errorInfo`); context and
script runs go in `result.details.fluex`. `ToolLog` reads both from `observe()`. Verified by a run (2026-10-15):
`details` and error `name`/`code` reach the observation; other error properties are dropped. Accepted loss: script
runs behind a *blocked* call appear only in the error message.

**D7. `claudeHooks` reads settings once per submission (run).** Fixes the §2 bug (verified by a run: `tools()` got
5 distinct sandbox objects over 3 turns; `createSandbox()` runs once per submission, not per conversation).
`withInterceptors` captures the object `createSandbox()` returns and passes it to interceptors as `call.session`;
`claudeHooks` caches on it. A model edit to `.claude/settings*.json` takes effect on the **next submission**, not
the next turn. Not chosen: reading from `HEAD` (edits persist on disk across runs; left to the orchestrator's
review/reset of the worktree). Update `sandbox-security.md` row 6 and the `claudeHooks` docblock to say this.

**D8. `claudeHooks` behaves like Claude Code wherever the layer can.** (1) Matchers per Claude: `*`/empty = all;
only `[A-Za-z0-9_\- ,|]` = exact names, `|` or `,` separated; anything else = unanchored regex. (2) Pre
`additionalContext` → appended to the result. (3) Pre `updatedInput` → `next(updatedInput)`. (4) A matcher on a
tool fluex does not intercept (`Skill`, `Agent`, `mcp__*`, `NotebookEdit`, …) → one warning at load.

Tool names (for docs): `.claude/settings.json` uses **Claude names** (`Edit`, `Write`, `Bash`) so the file works
unchanged in Claude Code; `claudeHooks` maps Flue → Claude (`edit → Edit`). TypeScript interceptors use **Flue
names** (`tools: ['edit', 'write']`), the value of `call.tool`; `useTool` tools have no Claude name.

**D9. Filters: `withSandboxTools(f, { only | exclude })`, `withSkills(f, { only | exclude })` — fully composable.**
Rule for every `with*`: `SandboxFactory → SandboxFactory`; it **narrows or wraps what it receives, never rebuilds
it**. Hence any subset works, order does not matter, and repeating stacks (two `exclude` = union, two `only` =
intersection). `withSkills` wraps `createSandbox` (filters the `.agents/skills` listing); `withSandboxTools`
filters `tools` by name; `withInterceptors` wraps the `tools` it finds. Enforced by a test per wrapper: compose in
both orders, assert both effects. Guarantees: `withSandboxTools` removes the tool (but `bash` can still write);
`withSkills` hides a skill from the catalog and `activate_skill`, not from `read` — not a security boundary.
Replaces the backlog's `withSkillFilter` (`IMPLEMENTATION_PLAN.md:458`).

**D10. Drop `useRequiredSkills`.** Its only use was smoke (`target-app-flue/.../use-smoke.ts:53`). Delete
`skills.ts`, `skills.test.ts`, its export, and the smoke line; the `id` question goes with it. Instead the smoke
agent's structured result reports skills itself (a self-report, accepted for smoke), e.g.
`skills: [{ name: 'ast-grep', found: boolean, used: boolean }]`. `ToolLog` still shows `skill(name)` per
activation in the log and `events.jsonl`, for a host-side check later if ever needed.

**D11. Tool log: fluex exports a subscriber value; the app mounts it with Flue's `observe()`.** Replaces
`logToolCalls()` and its first-call-wins `installed` flag. Mount once in a shared module (ES modules evaluate
once, so no flag); agent files import it. General rule, same as D4: **fluex gives values, Flue mounts them** —
`observe(toolLog(…))`, `useSandbox(withInterceptors(…))`, `useTool(withInterceptors(…))`.

```ts
// <app>-flue/src/observability.ts
import { observe } from '@flue/runtime';
import { toolLog } from '@fluex/flue-tools';
observe(toolLog({ runsDir: 'runs' }));

// each agent file
import '../observability.ts';
```

```ts
useSandbox(withSkills(targetApp(key), { only: ['ast-grep'] }));                                   // one alone
useSandbox(withInterceptors(withSkills(withSandboxTools(targetApp(key), { exclude: ['write', 'edit'] }), { only: ['ast-grep'] }), ...guards));
```

**D12. Package renamed `@fluex/flue-hooks` → `@fluex/flue-tools`.** Everything in it concerns tools
(intercept, filter, log); "hooks" stays Claude's word only, and no `use*` hooks remain. One package; split later
if `claudeHooks` gets a consumer that needs nothing else. Rename via `pnpm pkg set name=…`, then
`pnpm run fluex:sync` in the consumer. `withToolHooks` is removed, no deprecated alias (no external users).

### Example: the whole design in one agent

```ts
// target-app-flue/src/observability.ts — mounted once
import { observe } from '@flue/runtime';
import { toolLog } from '@fluex/flue-tools';
observe(toolLog({ runsDir: 'runs' }));                                        // D11

// target-app-flue/src/agents/planner.ts
import { type AgentProps, useModel, useSandbox, useTool } from '@flue/runtime';
import { blocked, claudeHooks, type ToolInterceptor, withInterceptors, withSandboxTools, withSkills } from '@fluex/flue-tools';
import '../observability.ts';

const denyGitPush: ToolInterceptor = {
	tools: ['bash'],                                                           // D5, D8: Flue names here; settings.json uses Claude names
	intercept: async (call, next) =>
		/\bgit push\b/.test(String(call.input.command)) ? blocked('the orchestrator pushes') : next(),
};
const guards: ToolInterceptor[] = [claudeHooks(), denyGitPush];                // D1, D7, D8: module-scope values

export function Planner({ id }: AgentProps) {
	useModel('anthropic/claude-sonnet-4-6');
	useSandbox(                                                                // D3: a flat list of use* calls
		withInterceptors(                                                      // D4: with* wraps a value, use* mounts it
			withSkills(withSandboxTools(targetApp(id), { exclude: ['write', 'edit'] }), { only: ['ast-grep'] }), // D9
			...guards,
		),
	);
	useTool(withInterceptors(reportPlan, ...guards));                          // D2: host tools are intercepted too
	return planPrompt;
}
```

## Sources

Flue 2.3.0 docs: `guide/why-flue.md`, `guide/building-agents.md`, `guide/agent-hooks.md`, `guide/tools.md`,
`guide/skills.md`, `guide/sandboxes.md`, `guide/subagents.md`, `guide/mcp.md`, `reference/agent-hooks-api.md`,
`reference/agent-api.md`, `reference/sandbox-api.md`, `reference/events.md`. Flue 2.3.0 dist:
`conversation-stream-store-CXrgv-b0.mjs`, `result-e-IUH4HT.mjs`, `types-B1PuLhZt.d.mts`,
`agent-execution-store-TmGF9yZ1.d.mts`, `observation-CCQRUQQq.d.mts`, `instrumentation-AVC-Q5Hv.d.mts`.
Claude Code: <https://code.claude.com/docs/en/hooks> (matcher patterns, hook handler fields, `if`, hooks in
skills and agents, PreToolUse decision precedence). fluex: `packages/flue-hooks/src/*`, `IMPLEMENTATION_PLAN.md`,
`docs/research/{composition,flows,sandbox-security}.md`. Consumer: `target-app-flue/src/agents/*`, `src/sandbox.ts`, `src/sandboxes.ts`.
