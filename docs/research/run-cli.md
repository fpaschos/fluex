# `fluex run`: generic run records and attach (proposal)

Date: 2026-10-13 · Builds on [observability.md](observability.md) (proposal steps 1–2).

## Problem

`flue run` prints progress to stderr and the result to stdout, then forgets both. There is no
per-run folder, no list of runs, and no way to follow a run from another terminal. Automaton had
`runs/<id>/{log, prompt.txt, result.json}` and `inspect`.

## Proposal

A `fluex` CLI in a new package `@fluex/runner` (the start of the M5 runner). It wraps `flue run` for
any agent, with no agent code changes, and is consumed by sidecars via `fluex:sync`.

**Name:** `fluex run`. It matches `flue run` and automaton's runs. `exec` would collide with `pnpm exec`
(start a binary) and `sandbox.exec` (shell inside the sandbox).

### Run folder

```
runs/<agent>-<conversationId>/
  command.txt   flue run command + start time
  log           stderr, teed live (tool calls, text, thinking)
  result.json   stdout --json envelope (id, agent, outcome, message | error)
  pid           while running; removed on exit
```

Later, from the recorder hook ([observability.md](observability.md) step 1): `events.jsonl`, `prompt.txt`, richer `result.json`.

### Commands

| Command | Does |
|---|---|
| `fluex run <agent.ts> -m "…" [--id <id>] [--detach] [flue run args]` | Pre-mints `--id` (or uses the given one → same folder, continues the conversation); runs `flue run … --json`; tees stderr to `log`, stdout to `result.json`; exits with Flue's code (0 / 1 / 130). `--detach` runs in the background and prints the id. |
| `fluex runs ls` | id, agent, status (`running` from `pid`, else `result.json` outcome), duration |
| `fluex runs tail <id>` | Follow `log` live (like `tail -f`); prints the full log for finished runs |
| `fluex runs show <id>` | `result.json` + summary (tool calls, cost once `events.jsonl` exists) |
| `fluex runs stop <id>` | SIGINT to `pid` → Flue aborts cleanly, outcome `aborted` |

### Attach model

Attaching means **following the run's files**, not connecting to Flue. Any terminal, any time,
any number of watchers; closing one never stops the run. Flue's own re-attach (`handle.read()`)
needs a second runtime on the same db. Under `flue run` the CLI process owns the conversation, and
Flue expects one owner ([observability.md](observability.md), "React UI over `flue run`").

### Flow

```sh
pnpm fluex run src/agents/smoke.ts -m go                 # foreground, live + recorded
pnpm fluex run src/agents/impl.ts -m "Implement #57" --detach
pnpm fluex runs ls
pnpm fluex runs tail <id>
pnpm fluex runs show <id>
pnpm fluex run src/agents/impl.ts -m "Fix the test" --id <id>   # continue
pnpm fluex runs stop <id>
```

## Order

1. `@fluex/runner`: `fluex run` (+ `--detach`), `runs ls|tail|stop` (~150 lines, Node only, no deps).
2. Recorder hook in `@fluex/flue-hooks` adds `events.jsonl`/`prompt.txt`; `runs show` gains tool calls and cost;
   `report_smoke` writes into the run folder instead of `runs/smoke-<timestamp>.json`.
3. Web viewer (M5) reads the same folders ([observability.md](observability.md) step 3).
