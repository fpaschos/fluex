# Docker sandbox: what the model can reach, and how to close it

Date: 2026-10-14 · Flue 2.3.0 · glab 1.123.0 · git 2.56 · After ticket 07 (`auto/target-app-flue`
`129e206`, fluex `f26019d`) · Builds on `packages/flue-docker` and the
[M3–M4 spec](../tickets/m3-m4-flue-docker/spec.md).

## Question

With smoke and implementer running in `@fluex/flue-docker`, what can a model command — normal, or
steered by prompt injection (an issue body, a README, a web page) — read, change, delete or send
out? Which of those matter, and what closes each, in what order?

## Where we stand

The agent loop, model calls and the pi subscription token stay on the host (`flue run`); only
tool calls and target-app's Claude hooks run in the container, through `docker exec`.

| Piece | Today |
|---|---|
| Mounts | target-app checkout read-write at `/workspace`; `~/.gradle-fluex` read-write at `/home/agent/.gradle` (`target-app-flue/src/sandbox.ts:67-68`) |
| Container env | `GITLAB_TOKEN` (personal), `GITLAB_HOST`, `GITLAB_API_HOST`, `GLAB_CHECK_UPDATE`, `GIT_AUTHOR_*`/`GIT_COMMITTER_*` (host identity), `GRADLE_OPTS` (`sandbox.ts:42-54`) |
| Network | `bridge`, full egress (`sandbox.ts:70`; default in `flue-docker/src/spec.ts:83`) |
| Confinement | image user `agent` (uid 1000), `--cap-drop ALL`, `no-new-privileges`, 6 GB / 6 CPU / 1024 PIDs (`spec.ts:154-171`); no socket, `/`, `$HOME` or `/dev` mounts (`spec.ts:97-117`); no mount at or under `/workspace` (`spec.ts:147`) |
| Secrets in argv | none: env goes through an owner-only `--env-file` deleted after the call (`flue-docker/src/docker-cli.ts:18-21,68-81`) |
| Hooks | settings read through the sandbox from `/workspace/.claude/`, once per submission on its first tool call (`flue-tools/src/claude-hooks.ts:78`); scripts run in the container from `/workspace/.claude/hooks` (`claude-hooks.ts:275`) |

Checked on 2026-10-14 (names only, no values read): the container reaches
`nexus-a.internal.example` (200), `nexus-b.internal.example` (200) and `gitlab.internal.example` (302) through the
Mac's connection, VPN included.

## What the sources say

- **Flue:** `local()` "binds the agent directly to the host … There is no isolation, by design …
  Do not use it as an isolation boundary for untrusted requests" (`@flue/cli` docs
  `guide/sandboxes.md:115`). "Before widening the shell's credentials, consider whether a narrow
  application tool can perform the privileged action instead — a model-directed shell should hold
  as little as possible" (`guide/sandboxes.md:133`).
- **Docker bind mounts:** "write access to files on the host by default … you can change the host
  filesystem via processes running in a container, including creating, modifying, or deleting";
  a mount over an existing container path obscures what was there
  ([bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)).
- **Docker networks:** containers "can make outgoing connections" by default; `none` "completely
  isolate[s]" a container ([networking](https://docs.docker.com/engine/network/)); `--internal`
  networks let containers talk to each other "but not with any other network", though the gateway
  IP stays reachable ([network create](https://docs.docker.com/reference/cli/docker/network/create/)).
  Docker itself offers no egress allowlist.
- **Docker Desktop (Mac):** only the shared paths (`/Users`, `/Volumes`, `/private`, `/tmp`,
  `/var/folders` by default) can be bind-mounted
  ([settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/)). Unmounted
  host paths are invisible to the container.
- **git:** hooks are executables in `$GIT_DIR/hooks` or `core.hooksPath` (`githooks(5)`);
  `core.fsmonitor` may hold "the pathname of the 'fsmonitor' hook command", run to refresh the
  index, e.g. on `git status` (`git-config(1)`). Both live in the repo's `.git/`, which the
  container can write.
- **GitLab tokens:** `api` "grants complete read and write access to the API for the token's
  scope"; `write_repository` grants pull and push and "does not support API authentication"
  ([scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)). A personal token
  "can access all groups and projects available to the user" (same page). The Commits API creates
  commits and, with `start_branch`, new branches ([commits API](https://docs.gitlab.com/api/commits/)).
- **GitLab project access tokens:** a bot user, member of that one project, "with permissions
  matching the token's role and scope"; actions show as the bot; expiry 365 days max by default;
  Premium+ on GitLab.com, any license on self-managed (gitlab.internal.example is self-managed); creating
  one needs Maintainer ([project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/)).
  Reporter: view issues, leave comments, "edit issues, including metadata" (labels) — yes; push,
  create branches — no ("Cannot push code") ([permissions](https://docs.gitlab.com/user/permissions/)).
- **Gradle:** the cache's file locking works across processes "only … if the different Gradle
  processes can communicate together", which is "usually *not the case* for containerized
  builds". The read-only cache (`GRADLE_RO_DEP_CACHE`) is read without locks, must not be written
  while read, should be seeded by a build rather than from an existing installation, and is
  incubating. When copying a cache, "do not copy the `*.lock` or `gc.properties` files"
  ([dependency caching](https://docs.gradle.org/current/userguide/dependency_caching.html)).

## Findings

Ranked by impact × likelihood. "Injection" means the model was steered by content it read.

| # | Finding | Impact | Needs |
|---|---|---|---|
| 1 | **GitLab token exfiltration.** A personal token with `api` is in the container env and egress is open; anything the model runs can read and send it. With it: every project the user can access, read and write, including commits and branches via the API. | high | injection |
| 2 | **Host execution through the checkout.** The model can write `.git/config` (`core.fsmonitor`, `core.hooksPath`), `.git/hooks/*`, Gradle scripts (`build.gradle.kts`, `settings.gradle.kts`, `gradlew`, `gradle/wrapper/`), `.claude/settings.json` and `.claude/hooks/*`, `.idea/` run configs. They run **on the Mac** when the user next runs git, Gradle, the IDE or Claude Code there. This is the only path from the container to personal files. | high | injection |
| 3 | **Gitignored secrets are mounted.** `target-app/docker/.env` (`IDP_CLIENT_SECRET`, `IDP_PLUGIN_CLIENT_SECRET`), `partner-service/.env` (`PARTNER_API_KEY`), `scripts/http-client.private.env.json` (`partner-stage.api_key`). None is in git history; `target-app/.env` holds only comments. Gitignored is not hidden: the whole checkout is mounted. | high if real values | injection |
| 4 | **Internal network reach.** Egress goes through the Mac's VPN: internal Nexus and GitLab answer, and any other unauthenticated internal service could be probed or used to exfiltrate. Source code and Nexus artifacts in the Gradle cache can be uploaded. | medium–high | injection |
| 5 | **Destruction of the live checkout.** `rm -rf`, `git reset --hard`, deleting `.git` hit the real repo: uncommitted work and unpushed commits and branches are lost. The rest of the Mac is not reachable (not mounted). | medium | mistake or injection |
| 6 | **Hooks are not a boundary.** target-app's guard and lint scripts run from `/workspace/.claude/hooks`, which the model can edit or delete; a changed `.claude/settings.json` takes effect on the next submission (read once per submission, `claude-hooks.ts:78`). | medium | injection |
| 7 | **Commit rules are prompt-only.** Current branch only, no branch creation or push, `🤖 ` prefix, `Fluex-Conversation:` trailer (`target-app-flue/src/prompts/implement.md:37-38,53,56`). Nothing enforces them; commits carry the user's identity (`sandbox.ts:50-53`), and `result.json` lists only commits with the trailer (`agents/implementer.ts:39`). Push fails today only for lack of credentials (no SSH key; HTTPS needs the token, see 1). | medium | mistake or injection |
| 8 | **Shared writable Gradle home.** All containers share `~/.gradle-fluex`. Two builds at once may time out on cache locks (Gradle: no cross-container lock handoff). A planted `init.d/*.gradle` runs in every later sandbox build (not on the host, which uses `~/.gradle`). The seed copied 15 `*.lock`/`gc.properties` files Gradle says not to copy. | low–medium | concurrency / injection |
| 9 | **Leftover containers.** One per instance id, never removed automatically, each up to 6 GB and possibly an idle Gradle daemon. | low | time |
| 10 | **Env values visible to Docker users.** `docker inspect` shows the container's env, token included, to anyone with Docker access on the Mac (today: only the user). | low | host access |

**Not reachable:** anything outside the two mounts — `~/.ssh`, `~/.pi` (model login), Keychain,
browsers, other repos, the system. Leaving the container would need a kernel or Docker Desktop
exploit against a non-root, capability-less, `no-new-privileges` process without the socket.

## Fixes

Effort: **now** = settings or habit, minutes; **small** = one ticket; **milestone** = planned work.

| Fix | Closes | Effort | Lives in | Trade-off |
|---|---|---|---|---|
| A. **Project access token, role Reporter, scope `api`, expiry set**, in `.env` as `GITLAB_TOKEN`; then `pnpm sandbox prune` | 1 (blast radius: one project, no push, no branches) | now | GitLab settings, sidecar `.env` | notes and label changes show as the bot user; needs Maintainer to create. Whether Reporter can create MRs is unclear from the docs; the prompt doesn't need it |
| B. **Habit:** commit or push own work before a run; run on a throwaway branch; review the whole diff, including `.git/config`, `.git/hooks`, `.claude/`, `*.gradle.kts`, `gradle/`, before using git, Gradle or the IDE on the host | 2, 5 (detects, doesn't prevent) | now | user | manual |
| C. **Check the secret files** in finding 3: local dev values or shared staging ones? Rotate shared ones, keep them out of the checkout | 3 | now | target-app, owners of the identity provider and the partner API | — |
| D. **Post-run tamper check:** snapshot hashes before the run, compare after, warn on changes to `.git/config`, `.git/hooks/`, `.claude/`, `gradlew`, `gradle/wrapper/`, `*.gradle.kts`; write the result into `result.json` | 2, 6 (detects) | small | sidecar (`useAgentFinish`) | warns after the fact; needs a run-start hook |
| E. **Git guard hook:** a tool interceptor in the sidecar blocking `git push`, `git checkout -b`, `git switch`, `git branch`, `git remote`, `git config` in bash; plus a distinct committer (e.g. `fluex-bot`), keeping the user as author | 7 | small | sidecar (`withInterceptors`) | command matching is bypassable by obfuscation; a guard, not a boundary |
| F. **Read-only overlays under `/workspace`:** allow `readonly: true` mounts at or under `/workspace` (today rejected, `spec.ts:147`). Then mount `.git/hooks`, `.git/config`, `.claude/` read-only, and an empty read-only file over each secret file | 2, 3, 6 (prevents) | small | flue-docker (spec decision changes), sidecar | `git config` writes fail (the model doesn't need them); must list paths; a new secret file is exposed until listed |
| G. **GitLab through host-side tools:** `useTool` for issue view, note and label swap, calling the GitLab API from the host; no token and no `glab` in the container (Flue `guide/sandboxes.md:133`) | 1 (removes the token from the container) | small | sidecar, prompt | prompt and tool work; the model loses ad-hoc `glab` |
| H. **Per-container Gradle home** plus `GRADLE_RO_DEP_CACHE` on a read-only seeded cache; or reseed `~/.gradle-fluex` without `*.lock`/`gc.properties` | 8 | small | sidecar | read-only cache is incubating; new dependencies download per container |
| I. **Prune policy:** `pnpm sandbox prune --older-than` (add `olderThan` to the CLI) or prune exited containers at run start | 9 | small | sidecar | — |
| J. **Worktree per ticket:** mount a fresh worktree, not the live checkout | 5; most of 3 (gitignored files are absent in a fresh worktree); narrows 2 | milestone | M5, `packages/git` | already planned |
| K. **Egress allowlist:** an `--internal` network plus a proxy container allowing Maven Central, Google, the two Nexus hosts, `services.gradle.org`, GitLab | 1, 3, 4 (exfiltration and probing) | milestone | flue-docker, sidecar | spec Out of Scope today; proxy upkeep; gateway still reachable on internal networks |

## Order

1. **Now:** A, C, B. A alone turns finding 1 from "everything the user can access" into "comment
   and relabel issues in target-app".
2. **Next small tickets:** F (flue-docker), then D and E (sidecar). F prevents what D and E only
   detect or guard.
3. **Then:** G, H, I as needed.
4. **Planned:** J in Milestone 5; K when runs move off the Mac (CI or Kubernetes,
   [deployment.md](deployment.md)) or untrusted issue authors appear.

Suggested for `IMPLEMENTATION_PLAN.md` §17 Backlog: D, E, F, G, H, I; and move K from the spec's
Out of Scope to the backlog with a trigger (first run off the Mac).

## Corrections to what was said in the session

- **Token scopes:** dropping `write_repository` does not stop writes. That scope doesn't even
  authenticate API calls; `api` alone allows commits and branches through the Commits API. The
  role (Reporter) is what blocks them.
- **Env passing:** the spec says values go as `-e KEY` with the value in the child env; the code
  passes them through an owner-only temporary `--env-file` (`docker-cli.ts:18-21,68-81`). Neither
  puts values in argv; both leave them in `docker inspect` (finding 10).
- **Hooks as protection:** target-app's guard runs from the writable workspace, so it guards
  against mistakes, not against a steered model (finding 6).
- **Gradle seed:** the README's `cp -c -R ~/.gradle-automaton ~/.gradle-fluex` also copies lock
  files that Gradle says to leave out (finding 8).
