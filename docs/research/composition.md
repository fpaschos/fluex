# Composition: roles, steps, and graphs (proposal)

Date: 2026-10-13 · Flue 2.2.2 · Builds on automaton `.docs/directions.md` §B and
`.docs/research/pipelines-generalization.md` §3.3.

## Problem

`target-app-flue/src/agents/implementer.ts` mixes three layers that automaton kept apart, and
the third is missing: nothing picks the ticket (`--data '{"issue":1}'` by hand).

| Layer | automaton | target-app-flue today |
|---|---|---|
| Atom: one agent, one sandbox, typed output, run record | `run()` (library) | re-written inline per agent (`report_smoke`, `report_implementation`) |
| Project config: repo, env, model, prompts | `run.ts` options + `build/*.md` | hard-coded in each agent |
| Composition: plan → implement → verify → merge | plain TS in `run.ts` / `run-loop.ts` | none |

Automaton's planner (haiku, read-only, `plan-prompt.md`) lists `agent-ready` issues, drops done
ones, builds the blocker graph, skips PRD/HITL, and emits a schema-checked `{ issues: [{ number,
title, branch, prd? }] }` that `run.ts` feeds to the implementer.

## Principles (from automaton research)

- **Graphs are compositions, not a framework.** S1 sequential, S2 fan-out (`Promise.allSettled`,
  sequential merge), S3 bounded adversarial rounds (`for` + counter), S4 cross-model review —
  all plain TS over one atom. No DSL (IMPLEMENTATION_PLAN §13).
- **Orchestrator code fills prompts**; nothing is injected implicitly.
- **Typed outputs between steps**; the branch is the only cross-step state.
- **Verify on the host.** The agent's "tests pass" is a self-report; the gate is code.

## Proposal

### 1. Building blocks (fluex packages)

| Piece | Package | Does |
|---|---|---|
| `useResult(name, schema, { facts? })` | `flue-hooks` | Terminating report tool: model fills `schema`; host adds `facts(harness)` (commits by trailer, branch); written with `useDataWriter(name)` so `read()` returns it in `reply.data[name]`, and to the run record |
| `fillTemplate(md, vars)` | `flue-hooks` | `{{KEY}}` substitution; throws on a missing or unused key |
| `useRequiredSkills` | `flue-hooks` | exists |
| `step(Agent, { id, data, message })` | `runner` | `init` → `dispatch` → `read` under one `start()`; returns `{ result, reply, record }`; throws `AgentRunError` on failed/aborted |
| `verify(repo, checks)` | `runner` | Host-side commands (`execFile`, argv arrays), sequential, fail-fast; outcome on the record |

`useDataWriter` is native (verified in 2.2.2: `AgentReply.data: Record<string, unknown[]>`,
optional Valibot `schema`). It replaces writing `runs/*.json` from inside a tool.

### 2. Roles as custom hooks

Flue's reuse unit is the custom hook. A role hook bundles model, sandbox, instructions, prompt,
and result; the sidecar keeps only config:

```ts
// target-app-flue/src/agents/implementer.ts
export function Implementer({ id }: AgentProps) {
	return useCodingRole({ ...targetApp, prompt: implementPrompt, vars: { CONVERSATION_ID: id }, result: ImplementResult });
}
```

Agents stay exported function declarations (Flue's `'use agent'` contract); a factory
`export const X = role(...)` is not relied on.

### 3. Composition (sidecar scripts)

`scripts/cycle.ts` = S1 without merge: `step(Planner)` → `step(Implementer, { data: plan.issues[0] })`
→ `verify(TARGET_REPO, [ktlintCheck, jvmTest])`. Merge, S2 (fan-out), and S3 (review rounds) are
later variants of the same script, not new primitives.

A mock `glab` (sidecar `bin/glab`, first on the sandbox `PATH`) serves `issue list|view` from
`tickets/*.md` and logs `issue note|update` to the run folder, so planner and implementer prompts
stay identical to production.

## Order

1. `useResult` + `fillTemplate` in `flue-hooks`; port `Smoke` to them (no behaviour change).
2. `useCodingRole` in the sidecar (promote to fluex once a second sidecar needs it); mock `glab` + one ticket.
3. `Planner` + `Implementer` on the role hook; `step` + `verify` in `@fluex/runner`; `scripts/cycle.ts`.
4. Run on target-app's current branch (throwaway branch, reverted after).

## Open

- `step()` vs `fluex run` ([run-cli.md](run-cli.md)): both own a run folder — share one record writer.
- Planner sandbox: read-only enforcement on `local()` is prompt-only until Docker (M3–4).
