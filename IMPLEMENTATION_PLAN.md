# fluex implementation plan

Status: Milestones 0–3 done; Milestone 4 (target-app in Docker) in progress — see [Progress](#progress)  
Prepared: 2026-10-12 (re-ordered the same day: automaton replacement first, Jev later); updated 2026-10-13 (Milestones 3–5 re-scoped after the Docker grilling)  
Goal: replace `@fpaschos/automaton` (the Sandcastle-style orchestrator running pi in Docker over git worktrees) with upstream Flue plus fluex extensions, first consumer `target-app`. What survives of the original handoff notes (retired 2026-10-14) is in [§18](#18-carried-over-from-the-handoff). The Jev/TypeSafe decision layer from the "Open source agent harnesses" chat is a **later** addition (Milestones 7–8) and must not block the automaton replacement.

Original code snippets from the user-supplied chat transcript are embedded in [ORIGINAL_CHAT_SNIPPETS.md](ORIGINAL_CHAT_SNIPPETS.md). See [original chat snippet references](#16-original-chat-snippet-references) for their relationship to this plan.

## Progress

| Milestone | Status | Where |
|---|---|---|
| 0 — bootstrap, pinned Flue, subscription hello | done 2026-10-13 | fluex `a165f69`, `fb0a987` |
| 1 — harness smoke on target-app (host) | done 2026-10-13 | `auto/target-app-flue` (smoke), fluex `6001ad9` |
| 2 — implement on the host (go/no-go) | done 2026-10-13: **go** | `auto/target-app-flue` (implementer), fluex `b9971e8`, `8952a5f` |
| 3 — `flue-docker` package (driver, factory, cleanup) | done 2026-10-14 | `packages/flue-docker` |
| 4 — target-app in Docker | in progress: smoke green in Docker (ticket 07); gate (#65) next | `auto/target-app-flue` |

What changed against the plan, and why, is recorded under each milestone in §9.
Work deferred along the way is in [§17 Backlog](#17-backlog).

## 1. Outcome

Build `fluex` as an apps-first TypeScript pnpm monorepo that extends upstream Flue without a fork, delivered in this order:

1. **Subscription auth** — Flue runs on the pi OAuth subscription (`~/.pi/agent/auth.json`), shared with the pi CLI.
2. **Harness proof on the host** — Flue's own tools handle `target-app` (Kotlin/Gradle) tasks acceptably before any Docker work.
3. **Docker sandbox** — a reusable `SandboxFactory`/`SandboxDriver` with secure defaults and explicit cleanup, over the target repo mounted as is.
4. **Git orchestration** — worktree per conversation or ticket, branch strategies, ancestry-checked merge, preflight.
5. **Automaton replacement** — the target-app sidecar's daily loop runs on fluex; automaton retires after the gate.
6. **Later: Jev decisions** — framework-neutral decision client, deterministic policy, a thin Flue tool, and an app service / HTTP API.

Flue owns the agent loop. fluex supplies auth, sandbox, and git lifecycle. Apps and sidecar scripts own composition and lifecycle. When Jev arrives, Jev supplies typed judgments and deterministic policy owns authorization.

## 2. Source-of-truth hierarchy

When sources disagree, use this order:

1. Current user requirements in the conversation.
2. Source code for the exact pinned Flue (and pi-ai) release/revision.
3. This plan's [§18](#18-carried-over-from-the-handoff) for the automaton feature inventory and standing decisions; `docs/verified-contracts.md` for checked Flue and pi-ai facts.
4. Authoritative Jev/TypeSafe API specification (once supplied), for Milestones 7–8 only.
5. Tests and executable contracts in this repository.

## 3. Verified repository facts

### Local `fluex` project

- pnpm workspace (Milestone 0): `packages/pi-auth`, `packages/flue-hooks`; Vitest suites (the Flue contract test is `packages/pi-auth/test/flue-contract.test.ts`); `docs/verified-contracts.md` and `docs/research/` (observability, run-cli, composition, deployment, sandbox-security, flows).
- No in-repo app: `apps/playground` was removed after Milestone 2. The sidecars under `auto/` exercise the packages; an `examples/` folder comes later (§8).
- Sidecars consume fluex packages as packed tarballs (`pnpm run pack` → `packs/`, sidecar `fluex:sync`), not `link:`/`file:` directories: `catalog:` versions only resolve after `pnpm pack`, and a linked package loads a second `@flue/runtime`.
- Tooling present: Node v24.15.0, pnpm 12.11.2. pi CLI 0.81.1 installed globally (via bun); `~/.pi/agent/auth.json` holds an `openai-codex` OAuth credential.
- No Jev or TypeSafe implementation or contract was found in the inspected sibling work tree.

### Inspected Flue version

The official `withastro/flue` repository was shallow-cloned locally and inspected on 2026-10-12.

- Commit: `658325942b0f4eecd888f9698ab0bebb3b749163`
- `@flue/runtime`: `2.2.2`
- Node engine: `>=22.19.0`
- Relevant runtime dependencies: `@earendil-works/pi-ai ^0.87.1`, `@earendil-works/pi-agent-core ^0.87.1`, `valibot ^1.1.0`

Verified public interfaces at that revision:

- `SandboxFactory` is exported from `@flue/runtime`. Its primary method is `createSandbox({ id }): Promise<Sandbox>`. Multiple harnesses may call it with the same agent instance ID, so a durable adapter must make lookup/creation idempotent.
- `SandboxDriver` is exported from `@flue/runtime` and requires `readFile`, `readFileBuffer`, `writeFile`, `stat`, `readdir`, `exists`, `mkdir`, `rm`, and `exec`.
- `SandboxDriver.exec(command, options)` accepts `cwd`, `env`, `timeoutMs`, and `signal`, and returns `ShellResult`.
- `sandboxFromDriver(driver, cwd, options?)` is the supported wrapper. It owns caller-facing abort races and can report orphaned command settlements.
- An adapter that detects sandbox death should throw Flue's exported `SandboxDiedError`.
- `useSandbox(factory, { cwd? })` attaches one sandbox to an agent render. It is unavailable inside a subagent render; subagents share the parent's environment.
- `defineTool` and `useTool` accept `name`, `description`, optional Valibot `input` and `output` schemas, optional `harness`, `durable`, `timeoutMs`, and `annotations`, plus `run`.
- Tool definitions reject unknown fields. The earlier speculative `{ parameters, execute }` shape is not the current Flue contract.
- `setProvider(provider)` remains public and replaces a provider with the same ID.
- For standalone Node composition, `start({ agents, db?, providers?, env? })` accepts an explicit `providers` list. If `providers` is omitted, defaults are registered; if supplied, the list is exhaustive.

Source locations inspected in the pinned revision:

- `packages/runtime/package.json`
- `packages/runtime/src/types.ts`
- `packages/runtime/src/sandbox.ts`
- `packages/runtime/src/hooks/use-sandbox.ts`
- `packages/runtime/src/tool.ts`
- `packages/runtime/src/hooks/use-tool.ts`
- `packages/runtime/src/runtime/providers.ts`
- `packages/runtime/src/node/start.ts`

Before implementation begins, add the exact Flue version to the workspace and repeat these checks against the installed package declarations. Treat a mismatch as a stop-the-line contract change.

### Not yet verified against Flue 2.2.2 / pi-ai 0.87

From the original handoff notes (checked against Flue 2.1.0 / pi-ai 0.81–0.83). Re-verified in Milestone 0; results in `docs/verified-contracts.md`:

- pi-ai `createProvider`, `Provider.auth.oauth.{refresh,toAuth}`, whether `Provider.api` is public, and the `getModels()` return type.
- Export subpaths `@earendil-works/pi-ai/providers/*` and `/api/*-responses.lazy`.
- Whether `setProvider` at agent-module top level still works under `flue run` (which does not load `app.ts`), versus passing `providers` to `start()`.
- `~/.pi/agent/auth.json` shape (`{ type: "oauth", access, refresh, expires }`) as written by the installed pi CLI.
- Model IDs available on the `openai-codex` provider.

## 4. Assumptions and unknowns

### Working assumptions

- TypeScript, ESM, pnpm workspaces, Node 22.19 or newer, Vitest, and Valibot.
- Every dependency is installed with `pnpm add` (no Bun, no npm). `auto/target-app-project` migrates off Bun when it adopts fluex.
- Local Docker Engine is available to developers and integration-test runners (from Milestone 3).
- Each sidecar (`auto/<project>-project/`) stays a standalone Flue project that consumes fluex packages; the target repo is a parameter (`TARGET_REPO`). No `.flue/` and no symlink in target repos: what the *agent* must read lives in the target repo (`AGENTS.md`, `.agents/skills/`); how you *run* agents lives in the sidecar (`coding-instructions.md` via `useInstruction`).
- From Milestone 5: worktrees live in the sidecar (`worktrees/<id>`); the target repo's `.git` is mounted read-write (automaton found read-only fails for commits from linked worktrees). Milestones 3–4 mount the target repo itself.
- `/workspace` is the container workspace root.

### Unknowns that must not be guessed

- Flue's coding-harness quality on Kotlin/Gradle — the go/no-go question, measured in Milestones 1–2.
- Concurrency of `auth.json` refreshes when fluex and the pi CLI (or parallel fluex runs) overlap — needs a file lock compatible with pi's `AuthStorage`.
- Package scope and publishing destination (candidate: GitHub Packages under `@fpaschos`, changesets, `RELEASING.md`, as automaton publishes).
- Jev/TypeSafe base URL, endpoints, auth, schemas, errors, retries, rate limits, versioning, and data-handling policy — blocks Milestone 7's live client only.

## 5. Architecture

### Dependency direction

```text
auto/target-app-flue (sidecar) ───┐
examples/* (later) ──────────────┼──> runner (M5) ──> git (M5)
                                 │        └─────────> flue-docker
                                 ├──> flue-hooks
                                 └──> pi-auth

later (Milestones 7–8):
examples/*, apps/api ──> app-core ──> flue-jev ──> jev-client
                                  └──────> policy ──> contracts

pi-auth, flue-hooks, flue-docker, runner, flue-jev ──> pinned @flue/runtime
git, jev-client, policy, contracts ──X──> @flue/runtime
```

Framework-neutral packages must not import Flue. Sidecars, examples, and apps are composition roots.

`flue-docker` is one package on purpose (owner's call, 2026-10-13): Docker lifecycle and the Flue adapter live together, one concern per file, with a single `DockerCli` seam. Split out a Flue-free core only if a second consumer appears.

### Workspace — created incrementally

Only create a package when the milestone that fills it starts.

```text
fluex/
├── examples/                       # later: one runnable Flue agent per extension use (see §8)
├── apps/
│   └── api/                        # M8 (optional)
├── packages/
│   ├── pi-auth/                    # M0: Flue provider from ~/.pi/agent/auth.json
│   ├── flue-hooks/                 # M1–2: agent add-ons — required skills, tool hooks (Claude-compatible), tool log
│   ├── flue-docker/                # M3: Docker SandboxFactory/SandboxDriver, image build, cleanup
│   ├── git/                        # M5: preflight, worktree, branch strategy, merge
│   ├── runner/                     # M5: runAgent lifecycle, records, teardown, CLI
│   ├── contracts/                  # M7: decision/policy/audit types
│   ├── policy/                     # M7: deterministic allow/deny/review
│   ├── jev-client/                 # M7: verified HTTP client
│   ├── flue-jev/                   # M7: defineTool/useTool adapter
│   ├── app-core/                   # M8: shared application service
│   └── testkit/                    # when two packages need shared fakes
├── docs/
│   └── verified-contracts.md       # M0
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
└── vitest.config.ts
```

Start with private packages. Publish only after boundaries prove reusable.

## 6. Component contracts

### `pi-auth`

- Export `piSubscriptionProvider(id, { authPath? })` returning a pi-ai `Provider`, plus a convenience `usePiSubscription(id)` that calls `setProvider` (for `flue run` modules) — the provider object must also be passable to `start({ providers })`.
- Supported IDs initially: `openai-codex`. `anthropic` only after re-checking Anthropic's subscription terms.
- Read `auth.json` per request; refresh via the provider's own OAuth flow when expired; write back with mode `0600` under a file lock; never log tokens.
- Fail with a clear, actionable error when the credential is missing (`run pi /login`).
- Unit tests with a temp `auth.json` and a fake OAuth flow; no network.

### `flue-docker`

Decided in the Milestone 3–4 grilling (2026-10-13).

- `docker({ image, workspace, mounts?, env?, user?, resources?, network?, key? })` returns a `SandboxFactory`. `createSandbox({ id })` finds or creates one long-lived container per key (default: the Flue instance id; a script passes e.g. ``key: () => `ticket-${n}` `` so implement → review → refine share one container). The container runs `--init sleep infinity`; every operation is a `docker exec`.
- Deterministic name `fluex-<sha256(key)[:12]>`, labels `fluex.sandbox`, `fluex.version`, `fluex.created`, `fluex.spec`. A stored spec hash (image ID, mounts, env keys, resources, network, user) that differs from the requested one → the container is recreated and the differing fields are logged. A stopped container is started. In-process creates share one promise per key; a cross-process name conflict re-runs the lookup.
- `workspace` (a host path) is bind-mounted read-write at `/workspace`, the sandbox `cwd`. No git-dir special cases until worktrees (M5).
- Driver: file operations through `docker exec` with paths as positional arguments (`writeFile` over stdin, binary-safe); `exec` runs `bash -c` (not a login shell) under a wrapper that records the process group, so `timeoutMs` and `signal` kill the command inside the container (TERM → 5 s → KILL, exit 124); stdout/stderr capped at 64 MB each; container gone → `SandboxDiedError`; every internal Docker call has its own operation timeout.
- Env: explicit only, never the host environment; values reach `docker` through the CLI child's environment (`-e KEY`), never argv; known values redacted from errors and logs.
- `buildImage({ dockerfile, context, tag })` runs `docker build -q` and returns the image ID (Docker's layer cache keeps it cheap).
- `removeSandbox(key)`, `listSandboxes()`, `pruneSandboxes({ olderThan?, state? })` select by exact fluex labels only. No exit or signal handlers: Flue forbids adapter teardown, and a keyed container is meant to outlive the process.
- Composes with `flue-hooks`: `withToolHooks(docker(…), claudeHooks())` reads `.claude/settings.json` and runs Claude hooks inside the container through `sandbox.exec`.

Not ported from automaton (questioned during the grilling): `tail -f /dev/null` keep-alive, `-e K=V` in argv, the `~/.gitconfig` mount (git identity goes in as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`), Dockerfile-hash image tags, `rm -f` on process exit, the three sandbox lifecycle hook slots (backlog).

### `git`

- Preflight: dirty tree, detached HEAD.
- Worktree create/reuse/remove keyed on conversation or ticket ID (moved here from the Docker milestones); the Docker sandbox then mounts the worktree plus the repo's `.git`.
- Branch strategies `merge-to-head`, `branch`, `none`; refuse diverged branches.
- Merge: `merge-base --is-ancestor` baseline→head, `--ff-only` or `--no-ff`, `merge_blocked` outcome, preserve worktree + branch on failure.
- Framework-neutral; uses `execFile` with argument arrays only. Port from automaton `packages/core/src/worktree/*` and merge logic in `run/index.ts`.

### `runner`

- `runAgent({ agent, id, message, data, strategy })` = `start` / `init` / `dispatch` / `read` + sandbox lifecycle + merge + teardown.
- Optional `runs/<id>/{prompt.txt,result.json}` record.
- CLI: `fluex merge <id>`, `fluex clean [<id>]`, `fluex ls`.

### Later — `contracts`, `policy`, `jev-client`, `flue-jev`, `app-core`

Unchanged in intent from the original plan; scheduled for Milestones 7–8:

- `contracts`: normalized decision, evidence/provenance, typed errors, policy result, audit events, the `DecisionClient` port, redaction wrappers.
- `policy`: deterministic `allow` / `deny` / `require_review` with rule IDs and policy version; fail closed on missing/malformed/timed-out/low-confidence decisions; non-overridable prohibitions. Prompts are not authorization controls.
- `jev-client`: `decide(request, context)`, config and response validation, wire DTOs isolated from domain types, bounded documented retries, deadline/cancellation, typed errors, redaction, injectable transport. No live client until the contract is authoritative.
- `flue-jev`: a narrow `defineTool` (e.g. `assess_change_review`) with Valibot `input`/`output`, factory-injected client/policy context, normalized output, no secrets or globals.
- `app-core`: validate → correlate → decide → policy → stop on deny/review → init Flue → dispatch/read → audit → cleanup. A natural first integration point is the runner: a review gate before merge.

## 7. Security baseline (Docker sandbox, Milestones 3–4)

Decided 2026-10-13. Defaults of `flue-docker`; only `user`, `resources`, and `network` are overridable.

- `--init`, `sleep infinity`; the image's non-root user, with a preflight that refuses UID 0 (`user` overridable, for Linux hosts that need the host UID);
- `--cap-drop ALL`, `--security-opt no-new-privileges` (no `sudo` in the sandbox);
- `--memory 6g --cpus 6 --pids-limit 1024` — the Docker Desktop VM has 8 GB / 10 CPUs; raising the VM to 12 GB is optional;
- network explicit per profile; the target-app local profile is `bridge` with full egress (Maven Central, Google, two internal Nexus hosts, `services.gradle.org`, GitLab). An allowlisting egress proxy is backlog;
- no Docker or other `*.sock`, no `--privileged`, no host PID/IPC, no devices;
- mounts validated: absolute existing host path; reject `/`, `$HOME` itself, sockets, `/dev/*`; reject destinations at or under `/workspace` and duplicates; read-only unless stated;
- containment is the container itself: every file operation runs inside it, so host symlinks are never followed;
- bounded stdout/stderr capture with a truncation marker; an operation timeout on every internal Docker call in addition to the caller's `timeoutMs`;
- env explicit only, values never in argv, redacted from errors and logs;
- labels make stale containers identifiable without broad deletion.

Not yet: read-only root filesystem with tmpfs (Gradle and the JDK write widely — revisit with a slimmer image), image digest pinning for CI.

Docker isolation is not a complete security boundary against a hostile kernel-level workload. The threat model is local dogfooding.

## 8. Examples and API

- **Now:** the sidecars under `auto/` (e.g. `auto/target-app-flue`) exercise fluex packages against real projects; there is no in-repo playground (`apps/playground` was removed after Milestone 2).
- **Later:** an `examples/` folder with many small, runnable Flue agents, each showing one way to use the extensions — pi subscription provider, required skills, tool hooks (incl. Claude Code's), tool log, and later the Docker sandbox, worktrees, git orchestration, runner, and Jev. Examples double as smoke tests for the public API.
- **M8 (optional):** examples cover fake/live Jev modes, dry-run, approval, persistent/disposable sandbox modes; `apps/api` adds `POST /v1/runs`, `GET /v1/runs/:id`, `POST /v1/runs/:id/approval`, `DELETE /v1/runs/:id/sandbox`, health endpoints — thin handlers over `app-core`, authenticated, idempotent, rate-limited, never exposing arbitrary Docker controls.

## 9. Implementation milestones

Milestones 0–6 replace automaton. Milestones 7–8 add Jev.

### Milestone 0 — bootstrap, pinned Flue, subscription hello

Tasks:

- create the pnpm workspace with only what this milestone fills: root `package.json` (private, `packageManager: pnpm@12.11.2`, `engines.node >=22.19`), `pnpm-workspace.yaml`, strict `tsconfig.base.json`, `vitest.config.ts`, `typecheck` / `test` scripts;
- `pnpm add` exact pins: `@flue/runtime@2.2.2`, `@flue/cli` (matching release), `@earendil-works/pi-ai` at the version Flue resolves (`pnpm why @earendil-works/pi-ai`), `valibot`; dev: `typescript`, `vitest`, `@types/node`;
- re-verify every item in §3 "Not yet verified" against the installed declarations; record results in `docs/verified-contracts.md`;
- add a compile-only contract test importing the Flue symbols fluex uses (`setProvider`, `SandboxFactory`, `SandboxDriver`, `SandboxDiedError`, `sandboxFromDriver`, `useSandbox`, `useModel`, `start`, `init`);
- implement `packages/pi-auth` (§6) with unit tests;
- add `apps/playground/agents/hello.ts`: `openai-codex` model via pi-auth, `local()` sandbox, asks for `uname -a`;
- run it with `pnpm exec flue run apps/playground/agents/hello.ts`.

(The playground was removed after Milestone 2; the hello agent returns as the first entry in `examples/`, §8.)

Gate:

- clean `pnpm install`, `pnpm typecheck`, `pnpm test`;
- installed Flue declarations match §3;
- the hello agent prints the kernel line **through the ChatGPT subscription** (no API key in env);
- `auth.json` remains readable by the pi CLI afterwards (`pi` still works).

### Milestone 1 — harness smoke on target-app (host)

Tasks (in `auto/target-app-project`):

- `pnpm init`, remove `bun.lock` / `@types/bun`, add `@flue/runtime`, `@flue/cli`, `valibot`, and fluex `pi-auth` via a workspace path dependency;
- `.env` with `TARGET_REPO`;
- `agents/smoke.ts` on `local({ cwd: TARGET_REPO, env: { GRADLE_USER_HOME: ~/.gradle-automaton } })`, the target-app ast-grep skill via `useSkill`, a result schema;
- run with `flue run … --json`.

Gate: ast-grep actually invoked (not grep); Gradle flags correct; tool-call count sane versus `runs/smoke-*/result.json` from pi.

Result (2026-10-13): met. 6 tool calls (pi: 5), ~28 s, all checks true.

Changed against the plan:

- A new sidecar `auto/target-app-flue` (`flue init --target node`, pnpm) instead of migrating `auto/target-app-project`, which keeps running automaton until retirement.
- Skills come from target-app's `.agents/skills/` (Flue workspace discovery), not `useSkill(import …)`.
- The result is reported through a terminating tool whose input is the Valibot schema; facts (cwd, branch, Java) come from the sandbox, not the model.
- Added `@fluex/flue-hooks` `useRequiredSkills(id, 'ast-grep')`: hooks only see tool names, so the skill name is checked through `observe()`.

### Milestone 2 — golden issue (host)

Tasks: pick a small, already-closed target-app issue; worktree at its parent commit in `auto/target-app-project/worktrees/golden`; `agents/implementer.ts` with `useInstruction(coding-instructions.md)` and the implement template; run with two models.

Gate: diff ≈ the real fix; `./gradlew :app:jvmTest -x :app-testsuite:jvmTest -Pkotlin.native.ignoreDisabledTargets=true --no-daemon` green. **This is the go/no-go for the whole project.**

Result (2026-10-13): **go.** Two runs (`impl-65-1`, `impl-65-2`) on issue #65 completed: real RED → GREEN
cycles, ast-grep used, `ktlintCheck` + `jvmTest` green, one correctly formatted commit each
(🤖 subject, `Fluex-Conversation`, `Closes #65`), labels swapped. 4–6 min, 28–30 turns, 43–48 tool
calls. Known miss in both: the header is also set on error responses although the ticket says
"successful" (backlog: acceptance check).

Changed against the plan:

- **Mock issue instead of a golden issue.** The closed target-app issues are too old for the current code. Issue #65 (a small change to public endpoints) was written for the purpose and is reset and reused per run.
- **No worktree.** Runs commit on a throwaway branch of target-app's current branch, reverted afterwards; worktrees arrive with Milestones 4–5.
- **No two-model comparison** (owner's call). Model: `openai-codex/gpt-5.6-sol`.
- `implementer.ts`: `useInstruction(coding-instructions.md)`; the prompt is filled in TypeScript, and the model reads the issue through `glab` itself; `report_implementation` terminates the run and `useAgentFinish` writes `runs/<id>/result.json` (report, git facts, usage, tool counts).

Pulled forward:

- **Tool hooks, Claude-compatible** (`withToolHooks`, `claudeHooks` in `@fluex/flue-hooks`): target-app's `.claude/settings.json` hooks run unchanged on every sandbox tool call (`find`/`jar`/`javap` blocked, ast-grep lint after each `.kt` edit), through Flue's documented `SandboxFactory.tools` slot.
- **Tool log and run folder** (`logToolCalls`): automaton-style lines (`bash(cmd) ✓ exit 0 · 0.1s`, `edit(path, +1 -0)`, `skill(ast-grep) ✓`, hook blocks/feedback, a cost summary) and `runs/<id>/events.jsonl` — observability.md step 1.
- **target-app test logging** (target-app `chore/test-logging-failures-only`): failures only on the console by default (`-PtestLog=verbose` for the old log); with `-w --console=plain`, a single-class test run dropped from 15 kB to under 4 kB of agent context.

### Milestone 3 — `flue-docker` package

Re-scoped 2026-10-13 (grilling): one package, no `docker-core`; no worktrees, no git, no sandbox lifecycle hooks.

Tasks: `packages/flue-docker` (§6) — `DockerCli` seam, spec and mount validation, identity and find-or-create, driver (exec + files), `buildImage`, cleanup; unit tests on a fake `DockerCli`; `INTEGRATION=1` tests on `debian:bookworm-slim` pinned by digest; a Flue contract test running Flue's real `read`/`write`/`edit`/`grep`/`glob`/`bash` tools on the driver.

Gate: unit and integration green; `pnpm typecheck` clean; five concurrent creates with one key → one container; a changed spec recreates; a killed container → `SandboxDiedError`; `timeoutMs` kills the process inside the container; `prune` touches only fluex-labelled containers and none remain after the suite; no Flue patch.

Result 2026-10-14: **gate met.** 157 unit tests and 39 `INTEGRATION=1` tests green (Docker 29.6.1, Docker Desktop); `pnpm typecheck` clean; no fluex-labelled containers or test images left after the suite; no Flue patch. Changed against the plan: `pruneSandboxes` also takes a `key` predicate, so the suite prunes only its own containers; the container runs `--entrypoint sleep`, overriding the image's entrypoint.

### Milestone 4 — target-app in Docker

Tasks (in `auto/target-app-flue`): `docker/Dockerfile` from `target-app-project/Dockerfile.impl` without pi, claude-code, and bun; `src/sandbox.ts` building the factory (`workspace: TARGET_REPO`, a dedicated `~/.gradle-fluex` seeded once by CoW copy from `~/.gradle-automaton`, env `GITLAB_TOKEN`, `GITLAB_HOST`, `GITLAB_API_HOST`, git identity); `smoke.ts` and `implementer.ts` switch from `local()` (hooks and tool log unchanged); `gradleEnv` drops the host `JAVA_HOME`; `pnpm sandbox ls|rm|prune`.

Gate: smoke green in Docker; impl #65 rerun in Docker with `openai-codex/gpt-5.6-sol` from the same base commit: `:app:jvmTest` green, diff comparable to impl-65-2, wall time and tokens within ~1.5× of the host run, hooks fired (`events.jsonl`), no fluex-labelled containers left after `pnpm sandbox rm`. Record the result here and in Progress.

Constraint until Milestone 5: every container mounts the same `TARGET_REPO`, so fan-out over several tickets is not safe.

### Milestone 5 — worktrees, git orchestration, and runner

Tasks: `packages/git` (worktrees keyed on conversation or ticket ID, preflight, strategies, merge) and `packages/runner` (`step`, `verify`, records, CLI); `flue-docker` mounts a worktree plus the repo's `.git`; sidecar `scripts/run.ts` one cycle with `strategy: 'branch'`, **no merge**; run 3–5 real issues. Graphs are TypeScript over separate Flue instances (plan → implement → review → refine, bounded loops), sharing one container per ticket through `key`; subagents stay inside a step for side jobs.

Gate: branches reviewable; no worktree, branch, or container leaks.

### Milestone 6 — automaton replacement

Tasks: enable merge; sidecar `scripts/run-loop.ts`; switch the daily loop to fluex; keep automaton installed for a week; then remove `target-app/.automaton`, the automaton dependency, `.pi/settings.json`, and the planner `Dockerfile`.

Gate: a week of green cycles; explicit retirement approval.

### Milestone 7 — Jev foundations (later)

Prerequisite for the live client only: authoritative Jev contract.

Tasks:

- `packages/contracts`, `packages/policy`, fake `DecisionClient` (in `testkit`), redaction and audit types, exhaustive policy tests;
- `packages/jev-client` against recorded fixtures: auth, deadline, cancellation, documented retries;
- `packages/flue-jev`: narrow `defineTool` with Valibot `input`/`output`, mounted via `useTool` in an example agent.

Gate: all allow/deny/review/error transitions tested; `contracts`, `policy`, `jev-client` import neither Flue nor Docker; malformed responses fail safely; no unverified endpoint or field in production code.

### Milestone 8 — Jev in the workflow, app service, optional API (later)

Tasks: `app-core` composing Flue, Jev, policy, and the Docker/worktree sandbox; first use case a review gate in the runner (e.g. block or require approval before merge for high-risk changes); dry-run and approval examples; optional `apps/api`.

Gate: denial never starts a sandbox or merges; approval resumes exactly once; API and examples share one service; replayed requests create no duplicate runs or containers.

### Milestone 9 — hardening and publication

Tasks: security matrix on macOS and Linux Docker; dependency, licence, secret, and image scanning; runbooks (cleanup, credential refresh, Flue upgrade, Jev outage); publish only packages with demonstrated reuse (changesets, `RELEASING.md`); fan-out / graph / GitLab CI ([§18](#18-carried-over-from-the-handoff)) as scripts, not a framework.

Gate: threat model reviewed; public APIs documented; recovery exercise succeeds.

## 10. Test strategy

- **Compile-time contracts:** import every Flue and pi-ai symbol fluex uses from the pinned packages so drift fails typecheck; lockfile policy test for exact pins.
- **Unit (offline, no Docker):** pi-auth refresh/lock/missing-credential; container name/label derivation; mount, path, env, image, network, resource validation; output truncation; git strategy and merge decisions on temp repos; lifecycle and cleanup selection; later policy truth tables and Jev error mapping.
- **Harness quality (Milestones 1–2, 4):** same task across Flue-on-host, Flue-in-Docker, and pi-in-Docker; keep `--json` envelopes for comparison.
- **Docker integration (`INTEGRATION=1`):** filesystem ops incl. symlinks and binary round-trip, cwd/env, exit codes, large output, timeout/abort killing the in-container process, persistent reuse, spec-change recreate, killed container → `SandboxDiedError`, concurrent creates, label-scoped prune; Flue's real tools on the driver.
- **End-to-end:** golden issue; run → branch → merge; interrupted run leaves discoverable resources that `fluex clean` recovers; later allow/deny/review flows with Jev.

## 11. Observability and audit

Emit structured events for run lifecycle, sandbox lifecycle, command metadata, git/merge outcomes, cleanup, and failures (later: decision and policy results). Include run ID, conversation ID, sandbox ID hash, durations, outcome class, and truncation markers.

Do not log credentials, OAuth tokens, raw authorization headers, or full command output by default.

Metrics should distinguish model/Flue failure, Docker infrastructure failure, task command failure, merge blocked, and cleanup failure (later: application denial, Jev failure, policy failure).

## 12. Upgrade policy

- Pin Flue and pi-ai exactly; no open ranges for adapter contract validation.
- For every upgrade, re-inspect the §3 source locations, run compile-time contract tests, Docker integration tests, and the hello / smoke agents.
- Record version, commit/tag, behaviour changes, and migration decision in `docs/verified-contracts.md`.
- Never use deprecated aliases (`SandboxApi`, `createSessionEnv`, `createSandboxSessionEnv`) in new code.
- Keep Flue-specific types at adapter boundaries.

## 13. Explicit non-goals

- forking or patching Flue;
- a workflow/graph engine or DSL;
- making Jev the primary chat/model provider;
- exposing arbitrary Jev schemas or Docker controls to the model or HTTP clients;
- replacing automaton before the golden-issue and one-week gates;
- a browser UI before the shared application service exists;
- claiming Docker alone makes hostile code safe.

## 14. Decisions required from the owner

1. Package scope and registry (`@fpaschos/*` on GitHub Packages as automaton, or other) — needed before Milestone 9, not before 0.
2. ~~The golden target-app issue for Milestone 2.~~ Resolved: mock issue #65 instead (§9, Milestone 2).
3. ~~The target-app sandbox network allowlist (Milestone 4).~~ Resolved: full egress on the local dev profile; an egress-proxy allowlist is backlog (§7).
4. Whether `anthropic` subscription auth is in scope (terms check).
5. For Jev (Milestone 7+): authoritative contract and test environment, the first decision use case, and its fail-closed behaviour.

## 15. Definition of done

**Automaton replacement (Milestones 0–6):**

- upstream Flue consumed unchanged at an explicitly pinned version;
- Flue runs on the pi subscription with `auth.json` shared safely with the pi CLI;
- the git package is independent of Flue; `flue-docker` implements the verified `SandboxFactory`/`SandboxDriver` contract behind a single `DockerCli` seam;
- offline tests need neither network nor Docker; opt-in integration suites cover Docker;
- cleanup and recovery are documented and tested;
- the target-app daily loop has run green on fluex for a week and automaton is retired.

**Jev extension (Milestones 7–8):**

- Jev and policy cores are independent of Flue; the wire client is backed by an authoritative, versioned contract;
- the Flue tool uses the verified `defineTool`/`useTool` contract;
- deterministic policy gates all decision-controlled execution and merges.

## 16. Original chat snippet references

Source: the user-supplied pasted transcript of “Open source agent harnesses”, conversation ID `6ac7b16a-a8d4-83eb-8ded-ec9bc5a42bef`. All seven original code/layout snippets are embedded in the local companion file [ORIGINAL_CHAT_SNIPPETS.md](ORIGINAL_CHAT_SNIPPETS.md).

The following local links open the extracted snippets directly. Their bodies are preserved from the supplied transcript; they are illustrative sketches with unverified Jev API assumptions.

| Original message | Snippet to consult | Related implementation work |
| --- | --- | --- |
| Apps-first and Docker request | [Suggested repository layout](ORIGINAL_CHAT_SNIPPETS.md#apps-first-repository-layout) | Section 5: apps-first workspace and dependency direction |
| Same request; “Docker sandbox adapter” | [External Docker factory/driver skeleton](ORIGINAL_CHAT_SNIPPETS.md#docker-sandbox-adapter) | Sections 6–7 and Milestones 3–4: lifecycle, driver, security, and Flue wrapper |
| Same request; “Apps-first Flue integration” | [Coding agent wiring](ORIGINAL_CHAT_SNIPPETS.md#apps-first-coding-agent) | Section 8 and Milestone 8: composition and examples |
| “Show jev adapter example”; “Package structure” | [Standalone Jev adapter package layout](ORIGINAL_CHAT_SNIPPETS.md#jev-adapter-package-structure) | Sections 5–6: reusable client and thin Flue adapter (Milestone 7) |
| Same request; “Jev HTTP client” | [TypeSafe System One HTTP client sketch](ORIGINAL_CHAT_SNIPPETS.md#jev-http-client) | Milestone 7: verify the Jev contract before implementing the wire client |
| Same request; “Flue tool adapter” | [Narrow change-review decision tool](ORIGINAL_CHAT_SNIPPETS.md#jev-review-tool) | Milestone 7: `flue-jev` with Valibot `input`/`output` schemas and `run` |
| Same request; “Application wiring” | [Jev client/tool composition](ORIGINAL_CHAT_SNIPPETS.md#application-wiring) | Milestone 8: shared application service and end-to-end examples |

These snippets preserve the original design intent and are illustrative starting points. Apply the verified Flue 2.2.2 interfaces in Section 3 when implementing them. Adapt the original framework-neutral `parameters`/`execute` sketch to Flue's `input`/`output`/`run` contract, and verify all Jev HTTP fields against its authoritative API specification.

## 17. Backlog

Deferred during Milestones 1–2; each is small unless noted. Evidence: `auto/target-app-flue/runs/impl-65-2/events.jsonl`.

**Agent efficiency and accuracy** (impl-65-2: 63k fresh + 877k cached input tokens over 28 turns)

- Gradle daemon on the host (drop `--no-daemon` outside Docker): 18–25 s per test run is mostly JVM startup.
- Baseline on the host before the agent starts (automaton's `onSandboxReady`), its summary passed into the prompt.
- Prompt: batch independent reads, edits and commands per turn — cached input scales with turns × context.
- Acceptance check before commit: name the code and test per criterion; qualifiers ("successful", "only") need a test of the opposite case.
- Read less up front: task-scoped docs (impl-65-2 read ~45 kB, incl. unrelated ADRs); target-app could give each doc a "read when" line. Larger: an exploration subagent returning a brief.
- Role skill allowlist: Flue cannot filter workspace skills; a `withSkillFilter` sandbox wrapper hiding `.agents/skills/*` from discovery (unverified).

**Composition** ([composition.md](docs/research/composition.md))

- `useResult` (result tool + `useDataWriter` + run record), `fillTemplate`, `useCodingRole`.
- Planner agent and `scripts/cycle.ts` (plan → implement → verify); issue label check (`agent-ready`, not `agent-complete`, not PRD/HITL) before implementing.

**Observability** ([observability.md](docs/research/observability.md), [run-cli.md](docs/research/run-cli.md))

- `fluex run` / `fluex runs ls|tail|show|stop` over `runs/<id>/`.
- Tool hooks: `session_id` (empty today), Claude lifecycle events (`Stop`, `SessionStart`, `UserPromptSubmit`).

**Docker sandbox** (deferred by the Milestone 3–4 grilling, 2026-10-13)

- Sandbox lifecycle hook slots (automaton's `host.onWorktreeReady`, `host.onSandboxReady`, `sandbox.onSandboxReady`) — only if a real need appears; Flue hooks and host scripts cover today's uses.
- Read-only root filesystem with tmpfs mounts; a slimmer target-app image (drop node if ast-grep ships a binary).
- Network allowlist through an egress proxy (CI profile).
- Host-UID mapping for Linux hosts (`user` is already overridable).
- Hybrid file operations (host `fs` under `/workspace` with realpath containment) — only if #65 in Docker measures slow.

**Examples** (§8)

- `examples/`: many small runnable Flue agents, one per extension use — start with `hello` (pi subscription), required skills, tool hooks (Claude Code's included), tool log; add Docker/worktree, git and runner examples as those packages land. Medium: needs a workspace entry, a shared `flue.config.ts`/db setup, and a run script per example.

## 18. Carried over from the handoff

`HANDOFF.md` (2026-09-22) was retired on 2026-10-14; this section keeps what no other document holds. The rest (Flue/pi facts, code sketches, step plan) was superseded by this plan and `docs/verified-contracts.md`, and stays in git history.

### Automaton features still to build (Milestones 5–6)

Source: `automaton/.docs/design/reference/*.md`, `usage.md`, `directions.md`. Flue already covers the rest of automaton (model and effort, structured results, durability and re-dispatch, initial data, sessions, usage, logging, skills, compaction).

| Feature | Where in fluex | Port from automaton |
|---|---|---|
| Worktree keyed on conversation or ticket; `branchStrategy` `merge-to-head` / `branch` / `none`; refuse a diverged branch | `packages/git`, around `init()` | `worktree/*.ts` |
| Ancestry check (`merge-base --is-ancestor` baseline→head), `--no-ff` or `--ff-only`, `merge_blocked`, keep worktree and branch on failure | `packages/git`, after `read()` | merge logic in `run/index.ts` |
| Dirty-tree / detached-HEAD preflight | `packages/git` | |
| `copyToWorktree` copy-on-write seeding (`cp -cR` on macOS, `--reflink=auto` on Linux) for `node_modules` / Gradle | worktree creation | `internal/copy-to-worktree.ts` |
| `runs/<id>/{prompt.txt,log,result.json}` | `packages/runner` records | `run/run-record.ts` |

Lost on purpose, decide consciously at Milestone 6: pi as the agent (pi extensions, pi sessions, `pi -r`), and the `claudeCode()` provider with `CLAUDE_CODE_OAUTH_TOKEN`.

### Standing decisions

- fluex is a library only (sandbox, git, auth extensions): no graph engine, no workflow DSL (§13).
- Subscription login stays pi's: `pi /login` writes `~/.pi/agent/auth.json`, which fluex shares. An upstream Flue provider for it is optional, only after `pi-auth` has proven itself.
- Adoption is incremental: automaton keeps running the real backlog until the Milestone 6 gate; `target-app/.automaton` is deleted only when automaton retires.

### target-app conventions

The rules the agent follows in target-app (Gradle flags, lint scope, library sources, ast-grep, branch and commit rules, `glab` labels) live in `auto/target-app-flue/src/prompts/coding-instructions.md`. At Milestone 6, rename automaton's `Automaton-Run:` commit trailer to `Fluex-Conversation: <id>`.

### Later: graph, fan-out and CI (Milestone 9)

Three seams, not a framework: a deterministic test gate (code, not a model) routing failures back to the implementer with a bounded retry; parallel read-only reviewers on a different model; fan-out across issues with sequential merge. Locally, `scripts/graph.ts` over `init()` handles (`Promise.all`, `if` on `reply.data`, a counted `for`). In CI, a GitLab pipeline DAG: `plan` → `implement` (`parallel: matrix`) → `test` → `review` (matrix) → `gate`, with `needs:` as edges, artifacts as state and `retry:` as the bounded cycle.
