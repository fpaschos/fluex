# Flows: chaining agents, structured results, entry points, and provider cleanup

Date: 2026-10-14 · Flue 2.3.0 · pi-ai 1.2.0 · Sidecar `auto/target-app-flue` (uncommitted state of this
date) · Builds on [composition.md](composition.md), [deployment.md](deployment.md), [run-cli.md](run-cli.md).

Docs paths below are relative to `../flue/apps/docs/src/content/docs/`; sidecar paths to `auto/target-app-flue/`.

## Question

How does a planner → implementer → reviewer flow run on Flue, with typed hand-offs between agents,
the same flow code under a script now and a server later, and a script process that exits when the
flow is done?

## 1. Flue has no flow concept

- "Workflows are not a Flue feature per se" (`guide/workflows.md:7`). 2.0.0 removed `defineWorkflow`,
  `invoke` and run stores: "Conversations are the only durable unit: a workflow becomes a program
  that drives an agent" (Flue `CHANGELOG.md:174`;
  [changelog](https://github.com/withastro/flue/blob/main/CHANGELOG.md)).
- Official replacements (`guide/migration.md:186-206`): an awaited `init()` handle; a `durable: true`
  tool; an application-owned orchestrator (Cloudflare Workflows, Inngest, Temporal) whose steps call
  `dispatch` and `read`.
- A flow is code: `init(agent, { id })` → `dispatch({ message, initialData })` → `read(receipt)` →
  `AgentReply { text, data, metadata?, uid?, submissionId }` (`reference/agent-api.md:205`, `:257`).
  A failed or aborted run rejects `read()` with `AgentRunError`.
- No public planner → implementer → reviewer example on Flue 2.x was found (web search, this session).
  The official `examples/` use one-level subagents only.

### Options considered

| Mechanism | Why not for the pipeline |
|---|---|
| Subagents (`useSubagent`, `task`) | "Delegation is model-driven" (`guide/subagents.md:40`); only the child's final message returns, as text; "The prompt is the entire briefing" (`:50`). Kept for side jobs inside a step. |
| Phases as `harness: true` tools calling `harness.prompt` | One agent, one conversation. Reported recursion: each `harness.prompt` inherited the parent's tools and re-ran the pipeline, "23 depth errors… later phases never executed" ([withastro/flue#561](https://github.com/withastro/flue/issues/561), Flue 2.0.3). |
| `flue run --json` chained in shell | The envelope carries `message` (text), not `data` (`cli/run.md:50`). |
| `read(receipt, { onEvent })` catching `tool-input` | Documented for evals (`guide/evals.md`); ties the flow to the event format; rejected calls also appear as events. |
| **`init` / `dispatch` / `read` from code** | **Chosen.** Each step is its own agent, id, history and container. |

## 2. Structured result: one per agent

`reply.data` holds named `useDataWriter` parts, "each an array of writes in order"
(`reference/agent-api.md:257`); the evals guide calls it "the place to assert on structured results"
(`guide/evals.md:80`). The model never sees data parts (`reference/agent-hooks-api.md:252`).

Sidecar helper, `src/agents/use-structured-result.ts`:

| Piece | Does |
|---|---|
| `useStructuredResult(name, schema, description?)` | `useDataWriter(name, { schema })` + tool `structured_result` (input = schema) whose `run` writes the data and returns `{ output: 'Submitted.', terminate: true }` + a `useAgentFinish` check |
| `readStructuredResult(name, reply, schema)` | last write of `reply.data[name]`, parsed again; throws when the agent never called the tool |
| per-agent reader | `use-planner.ts`: private `const RESULT = 'plan'`, `readPlan(reply)` |

Facts behind it:

- A tool's `output` goes to the model only; it never reaches the caller. `terminate: true` ends the
  run once the batch settles, so `reply.text` is `''` (`reference/agent-api.md` `AgentReply`).
- Tool inputs are object schemas: the helper is typed `S extends ToolInputSchema`.
- `useDataWriter` names are part of the render's identity: declare unconditionally, every render
  (`reference/agent-hooks-api.md:252`). One result per agent holds by construction: a second
  `structured_result` tool in one render throws (duplicate tool name).
- **Enforcement.** Observed: the planner (`gpt-6-luna`, low thinking) ended with "Pick: none" and no
  tool call. `useAgentFinish` is "the enforcement seam" (`reference/agent-hooks-api.md:323`): when
  `response.toolCalls` has no successful `structured_result`, the helper `append`s a signal and the
  model gets another turn. Next run: `structured_result ✓`, 5 turns. Flue fails the submission after
  32 continuation cycles (`:331`).
- Verified in storage: `data/flue.db` holds a `message_data_write` record named `plan` with
  `{"issue":null}` (empty backlog).

## 3. Agents as role hooks

- `src/agents/use-planner.ts`: `usePlanner({ model, thinkingLevel, sandbox })`, no project imports.
  The model reads the backlog itself (`glab`, `jq`, `git` in the sandbox) with `src/prompts/plan.md`,
  a port of automaton's `build/plan-prompt.md` without branch naming.
- `src/agents/planner.ts`: thin `'use agent'` file binding model and sandbox. Flue scans only modules
  whose first line is the directive, so the hook file can sit beside it.
- `src/flows/run-issue.ts`: `ask(agent, id, initialData?)` wraps init/dispatch/read. Current state:
  plan step live (`readPlan(plan).issue`); implement and review steps commented out; containers
  removed in `finally`.

## 4. Entry points: the flow never calls `start()`

"One process holds at most one Flue runtime. `start()` throws when a runtime is already configured —
inside a Flue server, call `init()`/`dispatch()` directly" (`reference/agent-api.md:347`;
`guide/building-agents.md:202`). So the process entry point owns the runtime; the flow only calls
`init()`.

`start()` needs the agent list up front. Choices:

| Option | Decision |
|---|---|
| Flow declares its agents (`defineFlow({ agents, run })`) | not chosen: composing flows merges lists |
| **One project-wide list** in `runtime.ts`; `withFlue(main)` starts with it | **chosen**: mirrors a server, which registers every `'use agent'` module; `init()` is an address, registering unused agents costs nothing |
| Discovery of `'use agent'` files | Vite's job; not available under `tsx` |

Since 2026-10: the script entry is history; flows run in the app, through `@fluex/server`'s flow routes
([server.md](server.md)). What follows is kept as the record.

Script entry (built): the flow file runs itself with `if (isMain(import.meta.url)) … withFlue(runIssue)`
(`target-app-flue/src/runtime.ts`). `import.meta.main` is `undefined` under `tsx` 4.23 (checked), so
`isMain` compares `import.meta.url` with `pathToFileURL(process.argv[1])`: true only for the file `tsx`
was started with, false when the module is imported.

Server entry (later): `src/app.ts` mounts `createAgentRouter(Agent)` per agent (`guide/routing.md`),
adds `POST /flows/run-issue` (202, `409` while one runs: one checkout), registers providers once with
`setProvider`, never disposes. Needs `vite`, `@flue/vite`, `hono`.

| | Script | Server |
|---|---|---|
| `runIssue()` | same | same |
| Agents | `runtime.ts` list → `start({ agents })` | `'use agent'` scan |
| Providers | `start({ providers })`, disposed after | `setProvider()` at load, kept |
| End of process | after dispose | never |

## 5. Providers and the pi subscription

- The registry is one per process: "Each call replaces the ID's previous provider… the latest
  `setProvider()` for an ID wins"; "The registry is module-scoped and in-memory"; `flue run` "loads
  only the agent module, never `app.ts`" (`reference/provider-api.md:67-68`).
- Today `usePiSubscription('openai-codex')` (`fluex/packages/pi-auth/src/index.ts:47`) runs at load in
  each agent module. Needed for `flue run`; redundant under a script, where an explicit
  `start({ providers })` "registers unconditionally — an entry here overwrites a same-ID provider"
  (`reference/agent-api.md:301`). Hazard: calls with different options resolve silently,
  last import wins. `logToolCalls` is the opposite, first wins (`installed` flag,
  `fluex/packages/flue-tools/src/tool-log.ts:250-257`).
- **Hang.** `pnpm run-issue` printed its result and did not exit. `start()` + `stop()` alone exits.
  Cause: pi-ai's codex provider caches each session's WebSocket on an idle timer,
  `SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000` (`dist/api/openai-codex-responses.js:650`);
  `closeOpenAICodexWebSocketSessions()` (`:687`) closes them, exported via `./api/*`. `flue run`
  never shows it: "`flue run` may leave db/Vite handles that hold the event loop open after
  settlement", so it calls `process.exit` (Flue `packages/cli/src/main.ts:60-64`).
Decision (built: `piSubscription` in `fluex/packages/pi-auth`, used by `withFlue`):

```ts
// @fluex/pi-auth: provider + its own cleanup, per subscription id
export function piSubscription(id, options?): { provider: Provider } & AsyncDisposable;

// script
await using codex = piSubscription('openai-codex');
await using flue = await start({ agents, db, providers: [codex.provider] });
console.log(await runIssue());
```

`await using` disposes in reverse order on success or throw: `flue.stop()` drains work and closes the
db, then the subscription closes its sockets. No `try/finally`, no `process.exit`: a hang then means
something we opened was not closed. `usePiSubscription` stays only while `flue run` is used.

## 6. `.md` imports need Flue's build

- Under `tsx`, importing an agent module fails: `Unknown file extension ".md"` (verified). The packed
  fluex packages (raw `.ts`) and `@flue/runtime/node` load fine. Flue says the same for evals: an
  agent with build-resolved imports "needs the Flue build" (`guide/evals.md:84`).
- Planner and implementer now read prompts with `readFileSync(new URL('../prompts/x.md', import.meta.url))`.
  Works under `tsx`, `flue run` and `vite dev`; breaks after `vite build`, which moves code into
  `dist/` chunks. Smoke still imports `.md`.

## Open

- Confirm `pnpm run-issue` exits right after its result now that `withFlue` disposes the subscription.
- Implementer on `useStructuredResult` (host facts such as commits by trailer still to place); reviewer agent.
- Deferred: environments (local, CI, server) choosing providers (an open list) and sandbox at script
  level, models not part of the environment; a generic `pnpm agent <name>` runner replacing `flue run`
  and `usePiSubscription`; a durable workflow engine; prompt loading for a built server.

## Sources

Flue docs: `guide/workflows.md`, `guide/migration.md`, `guide/subagents.md`, `guide/evals.md`,
`guide/routing.md`, `guide/building-agents.md`, `cli/run.md`, `reference/agent-api.md`,
`reference/agent-hooks-api.md`, `reference/provider-api.md`. Flue source: `CHANGELOG.md:174`,
`packages/cli/src/main.ts:60-64`. pi-ai 1.2.0: `dist/api/openai-codex-responses.js`, `package.json`
exports. GitHub: [withastro/flue#561](https://github.com/withastro/flue/issues/561). Sidecar:
`src/agents/use-structured-result.ts`, `use-planner.ts`, `planner.ts`, `implementer.ts`,
`src/flows/run-issue.ts`, `src/runtime.ts`, runs `plan-1`…`plan-3` and two `pnpm run-issue` runs.
