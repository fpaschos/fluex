# Workspaces: a git worktree per issue, local first (design)

Date: 2026-10-15, re-read against the code 2026-10-23 (fpaschos/hd-auto#7) · git 2.56.0 (host), 2.39.5 (sandbox
image) · Flue 2.3 · Builds on fluex [IMPLEMENTATION_PLAN.md](../../IMPLEMENTATION_PLAN.md) §6 `git`, §9 M5–M6, §18,
and research [composition.md](composition.md), [flows.md](flows.md), [deployment.md](deployment.md),
[sandbox-security.md](sandbox-security.md), [server.md](server.md). This is the next milestone (fluex M5).

Paths: fluex `../../`, automaton `../../../automaton/packages/core/src/`, the app (sidecar) `auto/superapp-flue/src/`.

**Where things stand (2026-10-23):** agents and `run-issue` run in the Flue Vite app ([server.md](server.md)). A
sandbox is keyed by the run id: a flow run's agents share `sandbox: <runId>`, and `@fluex/server`'s flow routes
remove it when the run ends; `pnpm agent` keys its own and removes it through `DELETE /sandboxes/<key>`. Every
sandbox mounts the live `TARGET_REPO` checkout, so the flow routes take one run at a time (409 otherwise).
Workspaces, below, are not built yet.
"Verified" means run in this session against a scratch repo and the `superapp-flue-sandbox` image.

## 1. Question and decisions

How does a flow give a group of agents (implement → review → implement) their own checkout of the target
repo, keep it between runs, and bring the work back, so the same flow code later runs on a server?

| Decision | Detail |
|---|---|
| **A workspace is a resource, not an agent concern** | Opened and closed by the flow; agents only get its key. Several agents and conversations use one workspace. |
| **Local backend first** | Host git worktree, mounted into the Docker sandbox. Remote backend (clone in the container, push + MR) later, same interface. |
| **Host git only inside the workspace resource** | Flows and agents never call git on the host. The workspace package does (create, check, merge, remove); agents commit inside the sandbox. Refines the earlier rule "only agents run git". |
| **The composition root picks the backend** | Explicit config where the app composes its sandboxes (superapp: `src/sandboxes.ts`, loaded at app startup). Never auto-detected. Local vs remote checkout is the axis (§4.4). |

## 2. What a worktree is, and what the container must mount

| Fact | Source |
|---|---|
| A linked worktree has a `.git` **file** at its top: `gitdir: <repo>/.git/worktrees/<name>`. Inside it `$GIT_DIR` is that private dir and `$GIT_COMMON_DIR` the main `.git`. | `git help worktree` DETAILS; verified (`.git` = `gitdir: …/repo/.git/worktrees/issue-1`) |
| The private dir holds `HEAD`, `index`, `logs`, `refs`, `commondir`, and `gitdir`, a **back-pointer** to the worktree's `.git` file. | verified (`ls .git/worktrees/issue-1`) |
| Refs are shared: `refs/heads/*` resolve in `$GIT_COMMON_DIR`, except `refs/bisect`, `refs/worktree`, `refs/rewritten`. A commit in the worktree moves `refs/heads/agent/<key>` in the main repo. | `git help worktree` DETAILS |
| Paths are absolute by default. `--relative-paths` / `worktree.useRelativePaths` link with relative paths and set the repo extension `extensions.relativeWorktrees`. | `git help worktree` (`--relative-paths`), `git help config` (`worktree.useRelativePaths`, `relativeWorktrees`); verified |
| **Relative paths are unusable here:** git 2.39.5 in the image refuses the whole repo once the extension is set (`fatal: unknown repository extension found: relativeworktrees`), and `/workspace/../../repo/.git` does not exist in the container anyway. | verified |
| **Container mounts:** the worktree at `/workspace` (rw) and the main `.git` at its **same absolute host path** (rw), so the absolute `gitdir:` line resolves. Commits inside the container land on the host branch. | automaton `sandbox/docker.ts:114-157` (`resolveGitMounts`), `:162-185`; verified |
| No `safe.directory` problem on Docker Desktop: files show as uid 1000, the image's `agent`. | verified (`ls -ln`, `git status` without `safe.directory`) |
| **Prune hazard:** inside the container every worktree's back-pointer names a host path that does not exist, so `git worktree list` marks all of them `prunable` and `git worktree prune` would delete their metadata, this workspace's included. | verified (`prune -n -v`: "gitdir file points to non-existent location" for both) |
| `git worktree lock` (or `add --lock`) stops that: a locked entry is never pruned. `git gc` prunes only after `gc.worktreePruneExpire` (default 3 months). | `git help worktree` (`lock`, `--lock`), `git help config` (`gc.worktreePruneExpire`); verified (locked `issue-2` not listed by `prune -n`) |
| `git worktree repair` re-links after a move. `remove` refuses an unclean worktree without `--force`, a locked one without `--force --force`. | `git help worktree` (`repair`, `--force`) |
| `git fetch . agent/x:main` **refuses** while `main` is checked out (`refusing to fetch into branch … checked out at …`). `git merge --ff-only agent/x`, run in the checkout that has `main`, fast-forwards it. | verified |
| A worktree is a fresh checkout: gitignored files (`.env`, `local.properties`) are absent. automaton seeds them with `copyToWorktree` (copy-on-write `cp -cR` / `--reflink=auto`); Claude Code with `.worktreeinclude`. | automaton `internal/copy-to-worktree.ts:126-168`; [Claude Code worktrees](https://code.claude.com/docs/en/worktrees) |

### What automaton did (the reference)

| Item | automaton | Source |
|---|---|---|
| Storage | `<repo>/.automaton/worktrees/<runId>` (for superapp `.automaton` → `auto/superapp-project`, so `superapp-project/worktrees/`) | `run/index.ts:163-166`; `ls -la superapp/.automaton` |
| Strategies | `merge-to-head` (temp branch, `--no-ff` merge, delete), `branch` (named branch kept, no merge), `no-worktree` (mount the repo) | `worktree/branch-strategy.ts:7-23` |
| Reuse | `branch` strategy reuses an existing branch only if HEAD is its ancestor; diverged → error | `worktree/branch-strategy.ts:99-125` |
| Preflight | named branch (no detached HEAD); clean tree except `.automaton/` | `worktree/git.ts:65-92` |
| Merge guard | `merge-base --is-ancestor baseline head` before merging | `worktree/git.ts:214-229` |
| Failure | worktree and branch preserved, path in the error and `result.json` | `run/index.ts:68-71, 204, 411-421` |
| superapp's `run.ts` | `branch` strategy, then its own `git merge --ff-only <branch>` in the script when any iteration committed | `../superapp-project/build/run.ts` (end) |

## 3. What others do

| Tool | Where the code lives | Delivery | Scope | Source |
|---|---|---|---|---|
| Claude Code `--worktree` | `.claude/worktrees/<name>/` in the repo, branch `worktree-<name>`; reuses a name's directory | Clean worktree removed on exit; one with work kept or removed on prompt; you merge or open a PR | Session; subagents with `isolation: worktree` get a temporary one; a `git worktree lock` held while an agent runs | [worktrees](https://code.claude.com/docs/en/worktrees) |
| Conductor | Git worktree per workspace, own branch; location not documented | Review diff → PR → merge → archive | Workspace, archived by hand | [workspaces and branches](https://www.conductor.build/docs/concepts/workspaces-and-branches), [docs](https://www.conductor.build/docs/) |
| Dagger container-use | "a fresh container in its own git branch"; mechanism not documented on the README | `git checkout <branch>` to review | Environment | [README](https://github.com/dagger/container-use) |
| OpenAI Codex cloud | Own workspace per task in a set-up environment; clone mechanics not documented | Review, then commit or open a PR | Task | [Codex cloud](https://learn.chatgpt.com/docs/cloud) |
| GitHub Copilot cloud agent | Ephemeral environment powered by GitHub Actions; one branch at a time | Pushes, one PR per task (a `copilot/` prefix: **unverified**) | Task | [about](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent), [environment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment) |
| Cursor cloud agents | Clone from the git host in a VM, separate branch (`cursor/…` by default via the API) | Push → PR | Run | [cloud agents](https://cursor.com/docs/cloud-agent), [API](https://cursor.com/docs/cloud-agent/api/endpoints) |

Pattern: local tools use host worktrees; hosted tools clone inside the sandbox and deliver only through the
remote. Only local orchestrators (automaton, container-use) merge for you.

## 4. Design

### 4.1 Interface

```ts
interface Workspaces {
	open(key: string, opts: { base: string }): Promise<Workspace>; // create, or reuse the one with this key
	get(key: string): Promise<Workspace | undefined>;
	list(): Promise<WorkspaceInfo[]>;
}

interface Workspace extends AsyncDisposable {
	readonly key: string;      // e.g. issue-65; also the sandbox (container) key
	readonly branch: string;   // agent/<key>
	readonly base: string;     // branch it started from and merges back into
	readonly baseline: string; // base's sha at open: the ancestry check's anchor
	sandbox(): SandboxFactory; // the project sandbox with this workspace's mounts
	commits(): Promise<Commit[]>; // baseline..branch, oldest first: facts, not the model's report
	close(how: 'merge' | 'keep' | 'discard'): Promise<CloseResult>;
	// [Symbol.asyncDispose] = close('keep'): a crash never deletes work
}

type CloseResult =
	| { outcome: 'merged'; commits: Commit[] }
	| { outcome: 'nothing_to_merge' }
	| { outcome: 'merge_blocked'; reason: string } // worktree and branch kept
	| { outcome: 'kept' | 'discarded' };
```

### 4.2 Local backend (`localWorktrees`)

| Step | Does | Why |
|---|---|---|
| Storage | `~/.fluex/worktrees/<project>/<key>/`, **outside** the repo | Gradle, the IDE and agents' searches in the main checkout never see other workspaces; differs from automaton (`.automaton/worktrees`) and Claude Code (`.claude/worktrees`) on purpose |
| `open`: preflight | `base` is a branch, not detached; for a new branch nothing more (the live checkout is not touched) | automaton `git.ts:65-92`; a clean tree is needed only at merge time |
| `open`: create | `git worktree add --lock --reason fluex:<key> -b agent/<key> <dir> <base>`, absolute paths | `--lock` closes the prune hazard (§2); relative paths are out (§2) |
| `open`: reuse | Directory and branch exist → reuse if `base`'s sha is an ancestor of the branch; diverged → error; branch without directory → `worktree add --lock <dir> agent/<key>` | automaton `branch-strategy.ts:115-124` |
| `open`: seed | Copy-on-write copy of a configured list of gitignored files (e.g. `local.properties`) | automaton `copy-to-worktree.ts`; Claude Code `.worktreeinclude` |
| `sandbox()` | `superapp`'s config with `workspace: <dir>` plus mount `{ host: <repo>/.git, container: <repo>/.git, readonly: false }`, key `<key>` | Mount rules: flue-docker `spec.ts:144-150` accepts it today (§7) |
| `commits()` | `git log --reverse baseline..agent/<key>` on the host | Replaces the model-reported `impl.commits` (gaps row 10) |
| `close('merge')` | Ancestry check `baseline` → branch; no commits → `nothing_to_merge`; base checked out in the live checkout → require clean tree, `git -C <repo> merge --ff-only agent/<key>`; else `git update-ref` on base after the ancestry check; then `unlock`, `worktree remove`, `branch -d` | `fetch . a:b` refuses a checked-out base (§2); automaton `git.ts:189-229` |
| merge failure | `merge_blocked` with the reason; worktree, branch and lock kept | automaton `run/index.ts:68-71` |
| `close('keep')` | Nothing; the workspace and its container stay for `open`/`get` later | Reuse by key |
| `close('discard')` | `unlock`, `worktree remove --force`, `branch -D`, `removeSandbox(key)` | — |
| Host git hygiene | Every host git call: `execFile` with argv, plus `-c core.hooksPath=/dev/null -c core.fsmonitor=false` | The agent can write `.git/config` and hooks (§6); fluex plan §6 `git` ("`execFile` with argument arrays only") |

### 4.3 Remote backend (`remoteClones`, later)

Same interface. `open` starts the container with an empty `/workspace` and runs
`git clone --branch <base>` + `git switch -c agent/<key>` **inside** it (`sandbox.exec`); `commits()` is
`git log` through `sandbox.exec`; `close('merge')` = `git push origin agent/<key>` + open an MR
(deployment.md step 2 already pushes `HEAD:agent/<issue>` from CI); `keep` keeps the container; `discard`
removes it. No host git at all. Needs a token that can push (sandbox-security fix A's Reporter token cannot).

### 4.4 Who picks the backend

The composition root, from explicit config, once per process:

```ts
const workspaces = localWorktrees({ repo: TARGET_REPO, dir: join(homedir(), '.fluex/worktrees/superapp'), sandbox: superappConfig });
// later: remoteClones({ remote: GITLAB_REMOTE, sandbox: superappConfig })
```

The axis is "is the target checkout on this machine and should work merge into it", not script vs server:
a server on the Mac (deployment.md step 3) uses `localWorktrees`; a CI job or a remote server uses
`remoteClones`. Auto-detection (TTY, `CI=true`) is rejected: a wrong guess merges into the wrong place.

### 4.5 Agents get a key, not an object

- Initial data is "validated exactly once … recorded once, readable forever via `useInitialData()`" and
  ignored on later sends (Flue `reference/agent-api.md:98, :176`). Only serializable data survives a
  restart or a continuation from another process (`pnpm agent --id …`, a server route).
- A sandbox factory is lazy; `createSandbox()` runs once per initialized agent, and adapters "key durable
  resources on the instance id" (Flue `reference/agent-hooks-api.md:111`, `guide/sandboxes.md:109, :170`).
- So `AgentData.sandbox` (today the run id, `src/agents/agent-data.ts`) becomes the workspace key, and
  agents resolve it through a registry the composition root fills:
  `superapp(key)` → `workspaces.sandboxFor(key)`. One container per workspace, as the fluex plan intends
  (§6 `flue-docker`: ``key: () => `ticket-${n}` `` so implement → review → refine share one container).
- The key must also resolve when the workspace was opened by an earlier process: `get(key)` reads the
  worktree list (`git worktree list --porcelain`, locked with reason `fluex:<key>`), no in-memory state.

## 5. The flow

Today a flow's step is `run.ask(agent, step, data)` (`@fluex/server`'s `FlowRun`): conversation `<runId>-<step>`,
idempotency key `<runId>:<step>`. The sketch below names conversations by workspace key instead, so `FlowRun` needs
a way to ask under another id (open, §8).

```ts
// src/flows/run-issue.ts (sketch)
const pick = readPlan(await ask(Planner, `${runId}-plan`, { sandbox: runId })).issue;   // outside (§8 open: which checkout)
if (!pick) return { picked: null };

await using ws = await workspaces.open(`issue-${pick.number}`, { base: currentBranch });
const data = { sandbox: ws.key, issue: pick.number };
let impl = readImplementation(await ask(Implementer, `${ws.key}-impl`, data));
const review = readReview(await ask(Reviewer, `${ws.key}-review`, { sandbox: ws.key }));
if (review.changes) impl = readImplementation(await ask(Implementer, `${ws.key}-impl`, undefined, review.text));
const closed = await ws.close(impl.outcome === 'complete' ? 'merge' : 'keep');

return { pick, impl, review, commits: await ws.commits(), closed };                      // report outside: data only
```

- Inside: every agent gets `sandbox: ws.key`, so all three share the worktree and the container.
- The second implement call continues the same conversation (no initial data: it keeps its key).
- Reuse later: `workspaces.get('issue-65')`, then `pnpm agent implementer --id issue-65-impl -m "…"`; the
  conversation's recorded key finds the same worktree and container.
- `currentBranch` comes from the workspace package (`workspaces.currentBranch()`), not from `git()` in the flow.
- The flow routes' removal of the run's sandbox at the end of a run (`flowRoutes`, keyed by the run id) stays only
  for the planner's run-scoped container; workspace containers live and die with the workspace.

## 6. Security: what changes

| Today (`src/sandboxes.ts`, `workspace: TARGET_REPO`) | With workspaces |
|---|---|
| The live checkout is mounted rw at `/workspace`: uncommitted work, gitignored secrets, `.git` (sandbox-security findings 2, 3, 5) | The worktree is mounted. Uncommitted work in the live checkout is out of reach; gitignored files are absent unless seeded (finding 3 narrows) |
| `.git` writable inside the checkout | The main `.git` is still mounted **rw** (commits need `objects/`, `refs/`, `logs/`, `worktrees/<name>/`). `.git/config` and `.git/hooks` stay writable unless overlaid (finding 2) |
| — | **New:** the host now runs git on that `.git` (merge, remove). A planted `core.fsmonitor` or hook in `.git/config` would run on the Mac at `close()`. Hence the per-call `-c core.hooksPath=/dev/null -c core.fsmonitor=false` (§4.2) **and** read-only overlays: `<repo>/.git/config` and `<repo>/.git/hooks` mounted `readonly: true` over the rw `.git` mount (sandbox-security fix F, here without a flue-docker change, §7) |
| Model can delete the live checkout (finding 5) | It can delete the worktree and rewrite the branch; the ancestry check at merge refuses rewritten history. `.git/objects` remains deletable (rw) |

Moves sandbox-security fix J ("worktree per ticket", planned M5) into this milestone, and the `.git` part of
fix F with it.

## 7. Changes against fluex plan and research

| Where | Was | Now |
|---|---|---|
| Plan §6 `git` | "Worktree create/reuse/remove keyed on conversation or ticket ID"; strategies `merge-to-head`, `branch`, `none` | Keyed on a **workspace key** (issue), opened by the flow, shared by several conversations. Strategies collapse into `close('merge' \| 'keep' \| 'discard')`; `none` stays as "no workspace" (the planner) |
| Plan §6 `git` merge | `--ff-only` or `--no-ff` | `--ff-only` only (superapp `run.ts`); `--no-ff` (automaton core) dropped until needed |
| Plan §6 `runner` | `runAgent({ …, strategy })` owns sandbox lifecycle + merge | The flow owns lifecycle through `await using ws`; `runAgent` does not merge |
| Plan §9 M5 | `scripts/run.ts` with `strategy: 'branch'`, **no merge** | Local merge in M5 (`close('merge')`), since the run-issue flow already exists and the live checkout is mounted today |
| Plan §18 "Automaton features still to build" | Worktree "around `init()`" | Around a group of `ask()` calls (a workspace), not one agent |
| deployment.md:118-119 | `packages/git` needs a "current checkout" strategy for CI | Replaced by the `remoteClones` backend (§4.3) |
| composition.md:36 | `useResult(…, { facts })` adds commits via `harness` | `ws.commits()` on the host after the agents; agents keep model-only reports |
| composition.md:27 | "the branch is the only cross-step state" | The workspace (key → worktree + branch + container) is the cross-step state |
| sandbox-security.md fixes F, J | F small (flue-docker spec change), J milestone | `.git/config`, `.git/hooks` overlays need no spec change (nested under an extra mount, not `/workspace`); J lands here. `.claude/` overlays under `/workspace` still need the spec change |

flue-docker: nothing required for the basic case. `containerPathProblem` rejects only paths overlapping
`/workspace` and duplicates (`packages/flue-docker/src/spec.ts:143-151`); a `.git` mount at its host path
passes; host-path checks reject only `/`, home, sockets, devices (`spec.ts:98-117`); extra mounts default to
read-only, so the `.git` mount must say `readonly: false` (`spec.ts:20-21, 93`). The spec hash includes
mounts, so a workspace's container is recreated if its mounts change (plan §6 `flue-docker`).

## 8. Milestone

Tasks:

1. fluex `packages/git` (or `packages/workspaces`): `localWorktrees` per §4.1–4.2, unit tests on a temp repo
   (create, reuse, diverged refusal, `nothing_to_merge`, `merge_blocked` keeps everything, locked against
   prune, ancestry refusal after a force-reset), `INTEGRATION=1` test committing from the
   `debian:bookworm-slim` container through the two mounts.
2. Sidecar: `src/workspaces.ts` composition (`localWorktrees` + `superapp` config), the key registry, the
   `.git` overlays; `superapp(key)` resolves workspace keys.
3. `run-issue.ts` per §5; implementer report drops `commits` (back to `ws.commits()`).
4. `pnpm workspace ls|rm <key>` beside `pnpm sandbox`.

Gate: issue #65 through `POST /flows/run-issue` on a throwaway base branch: the live checkout untouched during
the run (`git status` unchanged), commits on `agent/issue-65`, `close('merge')` fast-forwards base, no
worktree, branch, lock or container left after `discard`; a second run with `keep` then `get` resumes in the
same worktree and container; `git worktree prune` run inside the container removes nothing.

Open:

- **Planner checkout.** It still mounts the live checkout rw (`src/sandboxes.ts`; flue-docker mounts the
  workspace rw, `spec.ts:50, :175`). Options: a detached `base` worktree (`worktree add --detach`), or a
  read-only workspace option in flue-docker.
- **Base when the live checkout is dirty:** refuse at `close('merge')` (automaton) or merge into a base not
  checked out (`update-ref`) and let the user fast-forward.
- **Seed list** for superapp's gitignored files, and Gradle cost of a cold build per worktree.
- **Concurrent workspaces** share `~/.gradle-fluex` (sandbox-security finding 8); the flow routes' one-run-at-a-time
  rule can lift only once runs no longer share a checkout.
- **Conversation ids per workspace:** `FlowRun.ask` names a step's conversation `<runId>-<step>`; the §5 sketch
  needs `<key>-impl`.
- **Key format** (`issue-65` vs run-scoped) and what `discard` does with a conversation that still names it.
- Remote backend token and MR creation (§4.3).

## Sources

- git: `git help worktree`, `git help config` (git 2.56.0, local man pages; online at
  [git-worktree](https://git-scm.com/docs/git-worktree), [git-config](https://git-scm.com/docs/git-config));
  experiments in a scratch repo and in `superapp-flue-sandbox` (git 2.39.5).
- automaton `packages/core/src/`: `worktree/git.ts`, `worktree/branch-strategy.ts`, `run/index.ts`,
  `sandbox/docker.ts`, `internal/copy-to-worktree.ts`; `auto/superapp-project/build/run.ts`.
- fluex: `IMPLEMENTATION_PLAN.md` §6, §9, §18; `docs/research/{composition,deployment,sandbox-security,flows}.md`;
  `packages/flue-docker/src/spec.ts`.
- Flue docs (`../flue/apps/docs/src/content/docs/`): `reference/agent-api.md`, `reference/agent-hooks-api.md`,
  `guide/sandboxes.md`, `guide/durability.md`.
- The app (`auto/superapp-flue/`): `src/sandboxes.ts`, `src/flows/run-issue.ts`, `src/agents/agent-data.ts`;
  since moved to fluex: `src/sandbox.ts` (`flue-docker`'s `defineSandbox`), `src/cli/agent.ts` (`@fluex/cli`).
- Others: [Claude Code worktrees](https://code.claude.com/docs/en/worktrees),
  [Conductor](https://www.conductor.build/docs/concepts/workspaces-and-branches),
  [container-use](https://github.com/dagger/container-use), [Codex cloud](https://learn.chatgpt.com/docs/cloud),
  [Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent),
  [Cursor cloud agents](https://cursor.com/docs/cloud-agent).
