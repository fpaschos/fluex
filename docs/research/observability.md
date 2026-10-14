# Observability: monitoring Flue runs (research)

Date: 2026-10-13 · Flue 2.2.2 installed, master v2.3.0 (`../flue`) — same surface (2.3.0: pi-ai bump + fixes).

## Finding

Flue has **no built-in run inspection**: no `flue inspect/logs/history`, no dev UI, no API that
lists conversations. The building blocks exist; the automaton `runs/<id>/` equivalent is ours to build.

| Need | Flue 2.2.2 | Limits |
|---|---|---|
| Live events | `observe()` — turns, tool start/finish with args/result, usage + cost per turn, `log`, settlement | Live only, in-process, no replay; under `flue run` register it in the agent module |
| Full prompt | `turn_request` event (system prompt, messages, tools) | **Never persisted**; live `observe()` only |
| Durable history | `data/flue.db`: messages, tool calls + args/results, `usePersistentState` writes | **No listing API**; read by id via `init(Agent,{id}).read(…,{onEvent})` or HTTP `?view=history` |
| Traces | `@flue/opentelemetry` (not installed): `invoke_agent`, `chat <model>`, `execute_tool` spans, token metrics | Bring your own exporter; flushing under `flue run` undocumented |
| Terminal | `flue run` stderr: `tool <name>` / `tool done`, text, thinking | **No tool inputs/outputs, no verbose flag** |
| React UI | `@flue/sdk` + `@flue/react` (`useFlueAgent`): messages, reasoning, live tool calls; `../flue/examples/react-chat` | Needs a server (`createAgentRouter` + `vite dev`) |

**React UI over `flue run` conversations:** a `vite dev` server on the same `data/flue.db` can show a
conversation by id. Safe **after** a run; risky **during** one — the server runs recovery/lease scans
and Flue expects one live owner per conversation. Cross-process SSE lags up to 30 s; long-poll (250 ms) works.

## Proposal

1. **Run recorder** (now) — `useRunRecord()` in `@fluex/flue-hooks`, built on `observe()`, writes
   `runs/<conversationId>/`:
   - `events.jsonl` — turns, tool calls (args + truncated result), usage, logs; one line each
   - `prompt.txt` — system prompt + tools from the first `turn_request` (Flue never stores it)
   - `result.json` — outcome, error (the real reason; `--json` shows only `internal_error`),
     duration, tokens/cost, tool counts, agent result (e.g. `report_smoke`)

   Writes queued off the hot path (`observe()` is synchronous).
2. **`fluex runs` CLI** — automaton `inspect` replacement over our own files (stable across Flue
   upgrades, unlike the internal DB schema): `ls`, `show <id>`, `tail <id>`. Detailed in
   [run-cli.md](run-cli.md) (`fluex run` wrapper, run folder, attach model).
3. **Web viewer** (M5, with the runner) — either Flue-native (`apps/viewer`: `createAgentRouter` +
   `@flue/react` on the db, for finished or runner-owned conversations) or a light page streaming
   `events.jsonl` over SSE (safe live).
4. **OpenTelemetry** (M9) — `instrument(createOpenTelemetryInstrumentation())` once an exporter
   (Jaeger / Langfuse) is chosen.

## Sources

`../flue/apps/docs/src/content/docs/`: `guide/observability.md`, `reference/events.md`,
`ecosystem/tooling/opentelemetry.md`, `reference/agent-api.md`, `reference/streaming-protocol.md`,
`guide/react.md`, `guide/node-target.md`, `guide/durability.md`, `cli/run.md`.
Code: `packages/runtime/src/runtime/conversation-observer.ts` (250 ms poll),
`handle-conversation-routes.ts` (SSE wake), `packages/cli/src/lib/line-event-presenter.ts`.
