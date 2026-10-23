# Server: a Flue Vite app with its own host, REST flows (research)

Date: 2026-10-16 · Flue 2.3 (`@flue/vite` 2.3.0, vite 8.3.4) · Node 24 · Builds on
[workspaces.md](workspaces.md), fluex research
[flows.md](../../../fluex/docs/research/flows.md), [deployment.md](../../../fluex/docs/research/deployment.md).

Paths: flue `../../../flue/` (`vite/` = `packages/vite/src/`, `cli/` = `packages/cli/src/`, `rt/` =
`packages/runtime/src/`, `docs/` = `apps/docs/src/content/docs/`), fluex `../../../fluex/`, sidecar `src/`.
"Verified" means run in the spike [`fluex/spikes/custom-host`](../../../fluex/spikes/custom-host/README.md) on 2026-10-16
(offline faux provider). Everything else is read from source.

## 1. Question and decisions

How do we run agents and multi-agent flows (`run-issue`) from one codebase locally and deployed, with Flue's
ergonomics (`.md` imports, agent discovery), and room to extend the server (REST, then SSE/WS/CLI)?

| Decision | Detail |
|---|---|
| **The Flue Vite app is the only loader** | `vite.config.ts` with `flue()`. No tsx entry points for agents or flows. `vite dev` locally, `vite build` for deploy. |
| **The app owns the server** | Own host around `dist/app.mjs` (§4), not Flue's `dist/server.mjs`. One extension point: `extend(server)`. |
| **REST first** | Agent routers + flow routes. No WS, no SSE of our own yet. |
| **Flows are code in a map, not routes** | One generic `POST /flows/:name`; a new flow is a new file. |
| **Own db for flow state** | Flow runs in our own sqlite file. Flue's db stays Flue's (conversations). |
| **fluex = generic libraries, auto = the app** | fluex knows nothing about superapp (§8). |
| **Incubate, then extract** | Host and flows kit start in `src/platform/` (no app imports), move to `@fluex/server` once `run-issue` runs. |

## 2. How Flue loads and runs code

| | tsx script (today) | Flue Vite pipeline |
|---|---|---|
| `.md` imports | No: hence `readFileSync(new URL('./x.md', import.meta.url))` (`agents/planner/planner.ts:16`, `implementer.ts:18-19`, `smoke.ts:16`) | `X/SKILL.md` → packaged skill directory; other `.md` → text module (`vite/markdown-import-plugin.ts:1-19`, `:114`) |
| Agent discovery | Manual `agents` map (`runtime.ts`) | Scan of `'use agent'` files (core plugin, `vite/flue-plugin.ts`) |
| Runtime boot | `start()` in `withFlue` | Generated entry (`vite/bootstrap/node-server.ts:61`) |

`flue run <path>` (`cli/commands/run.ts:29`): one agent module, in process, no HTTP (`cli/lib/run-bootstrap.ts:19`).
It creates a non-listening Vite server (`cli/lib/run-local.ts:302-318`, `watch: null`) with three plugins from the
non-public `@flue/vite/internal` (`:32`, `:321`), loads the bootstrap and the agent with `ssrLoadModule` (`:340`), and
assembles the runtime with `assembleNodeAgentRuntime` (`run-bootstrap.ts:260`), the same assembly `start()` uses.
No workflow support. `--json` prints `{ id, agent, submissionId, outcome, message }`, no `data`
(`commands/run.ts:174`), so shell-chained `flue run`s lose structured results. Flue's own position: "Workflows are not a
Flue feature per se" (`docs/guide/workflows.md:7`).

## 3. The Flue Vite app

| Flue owns (configure) | App owns (write) |
|---|---|
| `flue()`: loading, `.md`, discovery, `.env` in dev | `vite.config.ts`, `flue.config.ts` |
| Runtime assembly, db connect, recovery (`node-server.ts:61-127`) | `src/app.ts`: Hono app, default export with `fetch` (`node-server.ts:119-121`) |
| `createAgentRouter(Agent)`: `POST /:id`, `/:id/abort`, `GET /:id` (`rt/runtime/registration.ts:267`, `:281`, `:314`) | Which routers, where; flow routes; auth/CORS middleware |
| `@flue/sdk` (HTTP client library) | Host, own db, flows, CLI |

**Dev** (`vite dev`):
- **Every save swaps the app.** It loads a new copy, then stops the old one with `previous.stop(30_000)` (`vite/node-dev.ts:100-119`).
  - The trigger is Vite's watcher, for files in the app's module graph (`vite/flue-plugin.ts:655-674`).
  - A flow awaiting `read()` in the old app dies; its agent turn is recovered by the new runtime (§6).
  - `server: { watch: null }` stops the swaps. It's a standard Vite option, the same one `flue run` uses (`run-local.ts:318`). Flue only forces `server.cors` (`flue-plugin.ts:366`). Verified (§4): no reload on saves to an agent, `app.ts` or a `.md`; new agents need a restart.
- **`.env` is loaded before user modules** (`flue-plugin.ts:605`; `vite/dev-env.ts:1-19`). Top-level `required(...)` works.
- **Module-scope side effects re-run on every swap.** `observe()` adds to a runtime-level Set (`rt/runtime/events.ts:19`, `:47`), so `observe(toolLog())` at module scope stacks one subscriber per edit.

**Build** (`vite build`):
- **Output:** `dist/server.mjs` (self-starting, PORT 3000, SIGINT/SIGTERM, `vite/bootstrap/node-entry.ts:7-25`) plus `dist/app.mjs` (no listener; "what a custom host can import", `docs/guide/node-target.md:13`). Input at `flue-plugin.ts:408`.
- **No `.env` loading** (`dev-env.ts:17`). No CORS layer (`node-target.md:33`).
- **Externals:** `package.json` dependencies stay external (`flue-plugin.ts:411`, `vite/dependency-resolver.ts:31-46`).
  - The resolver says `@flue/runtime` "is bundled into `server.mjs`" (`dependency-resolver.ts:16`, `:37`).
  - **Verified otherwise:** the spike's bundle is ~8 KB and imports `@flue/runtime`, `/internal`, `/node` and `/routing` from `node_modules`. Treat the runtime as external.

## 4. Spike results (verified)

```
              ┌──────────────── host.mjs (ours) ─────────────────┐
HTTP  ───────►│ @hono/node-server ─► application.fetch ──────────┼─► app.ts (Hono) ─► Flue runtime ─► agents
WS /ws ──────►│ ws ─► bridge ─► application.fetch (POST, SSE GET) ┘    dist/app.mjs (vite build)
SIGTERM ─────►│ stop(): close ws, close http, application.stop()
              └───────────────────────────────────────────────────┘
```
`host.mjs`:
- `loadFlueNodeApplication()` → `serve({ fetch })` → `server.on('upgrade')`. The same steps as `startFlueNodeServer` (`node-server.ts:189-208`) plus a WebSocket.
- It never imports `@flue/runtime`: the WebSocket side calls the app's own routes.

| Check | Result |
|---|---|
| `node dist/server.mjs`, `GET /health`, agent POST + stream | ✅ `completed`, `echo: hello echo over HTTP` |
| `ws://…/ws` on Flue's server | 404: no upgrade handling |
| Own host: HTTP agents | ✅ same results as Flue's server |
| Own host: WS → agent, streamed back | ✅ `message-delta`… `submission-settled` (`completed`) |
| Own host: SIGTERM | ✅ `[host] stopped cleanly`, exit |
| External **JS** package calling `setProvider` (stand-in for `@fluex/pi-auth`) | ✅ `ext provider reached`: same runtime instance, no second copy |
| External package exporting **raw `.ts`** | ❌ boot crash `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` (built server only) |
| `vite dev` + `flue()` with the fluex packs' raw `.ts` (2026-10-19) | ✅ boots: Vite externalizes only JS entries, so the `.ts` packs are compiled in |
| `vite dev` with `server: { watch: null }` (2026-10-19) | ✅ saves to an agent, `app.ts` or `.md` cause no reload; with the watcher on, a save reloads the app |
| Agent POST without `initialData`, `v.object` schema (2026-10-19) | 400 `invalid_request`: "requires creation data matching its initialData schema"; no conversation created |
| Mounting from `scannedAgents` (`virtual:flue/agents`) in `app.ts` | ✅ one `createAgentRouter` per agent, no hand map; identity is the function name (`Smoke`) unless `X.agentName` is set |
| Agent POST body | Flat `{ kind: 'user', body, initialData?, uid?, idempotencyKey? }` (`rt/runtime/schemas.ts:156-180`). A `{ message: … }` wrapper → 400. |
| `POST …?wait=result` | 400: "fire-and-forget" (`rt/runtime/handle-agent.ts:98`). Response is 202 `{ streamUrl, offset, submissionId, uid }`; read `GET …?view=updates&offset=-1&live=sse`. |
| SSE frames | `data:` carries an array of chunks |

## 5. Capabilities on `target: 'node'`

| Available | Cloudflare-only (not for us) |
|---|---|
| Routes, `@flue/sdk`, SSE/long-poll conversation streams | Workers AI models (`cloudflare/*`) |
| Channels: inbound verified HTTP only (`docs/guide/channels.md:7`) | Cloudflare Sandbox / Computer |
| `observe` / `instrument` | Durable Object wake / one owner per conversation |
| Durability via leases, one process per db | Cron Triggers, Cloudflare Workflows |
| Sandboxes (our Docker), schedules via `croner` in `app.ts` | |

Node is forced anyway:
- flue-docker runs the `docker` CLI and bind-mounts the host repo.
- `sandboxes.ts` runs host `git config`.
- `db.ts` is a hard error on Cloudflare (`docs/reference/configuration.md:100-104`).

No built-in auth on either target: it's Hono middleware in `app.ts`.

**WebSockets:**
- Flue has none. Channels are HTTP. "Discord Gateway is a persistent WebSocket transport and remains outside the channel model" (`docs/ecosystem/channels/discord.md:127-129`).
- Options:
  1. A separate port started from `app.ts`.
  2. **Own host** (chosen, §4).
  3. A Vite plugin that hooks `httpServer` `upgrade` in dev (unverified).

## 6. Durability of flows

| Survives a restart | Does not |
|---|---|
| Admitted agent turns, with a durable `db.ts` (`docs/guide/durability.md:17`, `:130`). Startup reconciliation: `assemble.ts:178` → `agent-coordinator.ts:408`, `:578`. | The flow's position: "a workflow that dies between two dispatches re-runs from its start" (`workflows.md:110`). No TypeScript checkpointing (`durability.md:158`). |

**Restartable flows without an engine:**
- Each step uses a fixed id `${runId}-${step}` and `idempotencyKey: ${runId}:${step}`.
- The key becomes the submission id `sub_ik_<sha256(agent, id, key)>` (`rt/runtime/ids.ts:82-106`, `rt/runtime/dispatch.ts:21-28`), and the handle accepts it (`rt/agent-client.ts:76`, `:226-227`).
- On a re-run, a step already sent returns its original receipt (`deduplicated: true`, `rt/types.ts:116`, `:157`) and `read()` resolves from the stream.

**Limits:**
- The key names the delivery, not the outcome: a `failed` step stays failed, so retry with a new key.
- The same key with a different payload → 409 `submission_conflict` (`types.ts:119`). Build messages deterministically.
- `idempotencyKey` is absent from `docs/reference/agent-api.md` (0 mentions), so treat it as less stable than the documented API.

## 7. Required changes

**fluex**

| Package | Change | Source |
|---|---|---|
| all three | Ship compiled JS. Today `"exports": "./src/index.ts"` crashes the built server (§4). | `packages/*/package.json:4-5` |
| flue-tools | `toolLog` must survive reloads: keep the unsubscribe `observe()` returns, or a `globalThis` guard | `rt/runtime/events.ts:47` |
| flue-tools | `instanceOfSubmission` is never pruned, so it grows in a long-running server | `src/tool-log.ts:56`, `:68` vs `:137` |
| flue-tools | `interceptFactory` holds one mutable `session`; safe only when built per agent body | `src/interceptors.ts:116-126` |
| flue-docker | Reads `../package.json` via `import.meta.url`: wrong file if bundled. Inline the version. | `src/identity.ts:15` |
| pi-auth | Servers: `setProvider(piSubscriptionProvider(...))` at load. `piSubscription`'s `asyncDispose` is for scripts only. | `src/index.ts:38`, `:64-67`, `:84` |

**superapp-flue**

| File | Action |
|---|---|
| `runtime.ts` | Delete (keep `newRunId`). Discovery and the generated entry replace `start()` and the `agents` map. |
| `cli/agent.ts` | Delete. Its `.env`-before-import trick (`:39`, `:43`) is moot under Vite. |
| `ask.ts` | Becomes a plain dispatch + read helper. `process.once('SIGINT')` (`:56-59`) does not belong in a server. |
| `utils.ts` `isMain`, `flows/run-issue.ts:39` | Delete; `runIssue` is called by the flows router. |
| `agents/*/*.ts` | `readFileSync` → `import x from './x.md'`; `readFileSync` crashes after `vite build` (the `.md` files aren't copied into `dist/`, inferred, not run). Drop `import '../../observability.ts'` (`:6-7`). |
| `observability.ts` | Register once from `app.ts`, reload-safe (`observe` at `:7`). |
| `sandboxes.ts` | Env and host git are read at boot (`:12`, `:44-46`), so the server needs them at startup: `node --env-file=.env` in prod. |
| `db.ts` | Keep. Picked up by convention; `./data/flue.db` is relative to the working directory. |
| `X.initialData` (`planner.ts:31`, `implementer.ts:44`, `smoke.ts:31`) | Keep. Over HTTP send `initialData` (incl. `subscription`) when creating; omitting it fails the `v.object` schema with 400 (verified, §4); give the schema a `{}` default. |
| `cli/sandbox.ts` | Keep as tsx: it doesn't import agents. |
| add | `vite.config.ts`, `src/app.ts`, `src/platform/`, deps `vite`, `@flue/vite`, `hono`, `@hono/node-server` |

**Concurrency** (two flows at once):
- Every container mounts the same `TARGET_REPO` working tree.
- They share the Gradle home (`sandboxes.ts:19`, `:32`).
- Both planners read the same backlog and can pick the same issue.

→ One flow at a time until [workspaces.md](workspaces.md) lands.

## 8. Target split and plan

| fluex (generic) | auto/superapp-flue (the app, owns the server) |
|---|---|
| `flue-docker`, `flue-tools`, `pi-auth` (compiled JS) | agents + `.md` prompts, `sandboxes.ts` (`TARGET_REPO`, mounts, image) |
| later `@fluex/server`: `createHost()`, `defineFlow`, `createFlowRouter` | flows (`run-issue`), `app.ts`, host entry, own db, env |
| later `@fluex/cli`: HTTP client | |

```
1. Vite app skeleton (auto)
   vite.config.ts + flue(); app.ts: GET /health + agents mounted from one map;
   prompts → `.md` imports; provider registration in a module the agents import;
   observability registered once, reload-safe
   verify: `vite dev`; POST /agents/smoke/<id> {kind:'user',body:'go'} → 202;
           GET …?view=updates&offset=-1 shows submission-settled + data.smoke

2. fluex packs ship compiled JS (tsc in the pack step; exports → dist/*.js)
   verify: `vite build && node dist/server.mjs` starts; step 1's requests work the same

3. Own host (src/platform/host.ts)
   loadFlueNodeApplication + serve + SIGTERM, with an `extend(server)` hook
   verify: same requests against the host; SIGTERM → clean exit

4. Flows kit (src/platform/flows.ts)
   defineFlow({ name, run(ctx) }); ctx = { runId, step(name, agent, input) }:
     dispatch with id `${runId}-${name}`, idempotencyKey `${runId}:${name}`, then read
   flows found with import.meta.glob('../flows/*.ts'); one router:
     POST /flows/:name        → 202 { runId }, runs in background
     GET  /flows/runs/:runId  → { flow, status, step, result | error }   (in memory)
   port run-issue onto ctx.step
   verify: POST /flows/run-issue; poll GET until done; issue implemented, commits in TARGET_REPO

5. Flows survive restarts
   flow runs saved in our own sqlite file; POST /flows/runs/:runId/resume
   verify: kill the host mid-implement, restart, resume → finished steps skipped, flow completes

6. Cleanup: delete runtime.ts, cli/agent.ts, ask.ts, isMain, the tsx agent/flow scripts
   verify: typecheck + steps 1–5's checks still pass

7. Extract src/platform → @fluex/server
   verify: auto imports it from fluex; all checks still pass
```

**Later:**
- SSE flow status (a route in the flows router).
- `@fluex/cli` on the same REST routes.
- WebSockets through `extend(server)`.
- Auth middleware in `app.ts`.

## 9. Open

- **Flow progress for clients:** a status endpoint vs an SSE stream of step events (the only piece Flue doesn't provide).
- **WebSockets under `vite dev`:** option 3 in §5, unverified.
- **No `app.ts`:** whether Flue mounts default agent routes without one. Unverified, and moot for us.
- **`idempotencyKey` stability:** undocumented in the API reference (§6).
- **No app-level startup or shutdown hook in Flue:** provider and socket cleanup are ours. It belongs in the host's `stop()`.

## 10. MVP path

Goal: the Flue Vite app is the only loader (`.md` imports, discovery), and the console and the server run the same
code: the console is an HTTP client of the app. A cut of §8, not a new plan.

```
1. Vite app skeleton (§8 step 1, in full: `.md` imports, no manual agents map: mount `scannedAgents`, `X.agentName`
   lowercase so routes match the CLI names)
   verify: POST /agents/smoke/<id> → 202; the updates stream shows submission-settled + data.smoke

2. One hand-written flow route in app.ts, no flows kit
   POST /flows/run-issue    → 202 { runId }; runIssue(runId) runs in the background
   GET  /flows/runs/:runId  → { status, result | error }   (an in-memory Map)
   ask.ts: drop process.once('SIGINT'); runIssue no longer runs as a script (drop isMain, withFlue)
   verify: POST, poll GET until done; commits in TARGET_REPO

3. Console client
   `pnpm run-issue` / `pnpm agent <name>`: thin scripts that POST to the running app and poll or stream until done.
   They import no agents, so they need no Vite (like cli/sandbox.ts). Seed of `@fluex/cli` (§8 Later).
   verify: `pnpm dev` in one terminal, `pnpm run-issue` in another prints the result
```

MVP risks:
- **A save kills a running flow:** `vite dev` swaps the app (§3); `run-issue` dies mid-step, its `finally` never runs,
  the sandbox is orphaned. `pnpm dev` runs with `server: { watch: null }` (verified, §4); `pnpm dev:watch` for
  editing agents.
- **One flow at a time** (§7 concurrency): the route answers 409 while a run is in flight.
- **Provider registration:** pi-auth's provider is set today via `withFlue`/`runtime.ts`; under Vite, in a module the
  agents import (§8 step 1).
- **Observability once:** `observe(toolLog())` at module scope stacks per save (§3); register it from `app.ts`,
  reload-safe.
- **`.md` types:** `declare module '*.md'` for `tsc`, unless `@flue/vite` ships one.
- **`pnpm agent` over HTTP:** the first message carries `initialData` incl. `subscription`; without it the create is a 400
  (verified, §4), so the schema also gets a `{}` default.
- **Client URL:** `FLUE_URL` (default `http://localhost:3000`); dev server bound to localhost with `--strictPort` (else
  Vite moves to 3001 when 3000 is busy), no auth.
- **Docs:** AGENTS.md and README describe tsx commands and per-agent `observability` imports; update with the change.

Not in the MVP:
- **Own host (§8 step 3):** needed for `vite build` deploys and WebSockets, not for `vite dev`.
- **Flows kit (§8 step 4):** `runIssue` already uses fixed step ids (`${runId}-plan`, `${runId}-implement`). `defineFlow`
  adds what a second flow or a restart needs: discovery (`import.meta.glob`), one generic router, one status shape for
  every flow (what a UI lists), and `idempotencyKey` per step (§6), the base for resume (§8 step 5). Build it with the
  second flow or with resume, whichever comes first.
- **Compiled fluex packs** (`vite dev` loads the raw `.ts`, §4; only `vite build` needs them), persistence, extraction.
