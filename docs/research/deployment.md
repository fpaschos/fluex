# Deployment: local, server, and GitLab CI (proposal)

Date: 2026-10-14 · Flue 2.2.2 · Builds on `packages/flue-docker`,
[composition.md](composition.md), [observability.md](observability.md), [run-cli.md](run-cli.md).

## Question

Where do the target-app agents run once `flue-docker` exists, how does the team trigger them, how
is a run watched from elsewhere, and how does the setup move to Kubernetes, without building ahead
of what `auto/target-app-flue` has today?

## Where we stand

| Piece | Today (`auto/target-app-flue`) |
|---|---|
| Agents | `smoke`, `implementer`, each `'use agent'`; run by `flue run` (`pnpm implement --data '{"issue":65}'`) |
| Sandbox | `withInterceptors(local({ cwd: TARGET_REPO, env: gradleEnv }), claudeHooks())` |
| Model auth | `usePiSubscription('openai-codex')` at agent-module top level |
| Records | `runs/<id>/events.jsonl` (`observe(toolLog())`), `runs/<id>/result.json` (implementer `useAgentFinish`) |
| Database | `src/db.ts` → `sqlite('./data/flue.db')` |
| Next | `flue-docker` (Milestones 3–4, [spec](../tickets/m3-m4-flue-docker/spec.md)) |

No `app.ts`, no server, no CI job, no composition script, no viewer.

## What Flue offers (docs in `../flue/apps/docs/src/content/docs/`)

- **Server.** `vite build` → `node dist/server.mjs`, a long-running Node server for whatever
  `app.ts` mounts; `vite dev` for development (`guide/node-target.md`). One live process must own a
  conversation; a shared db allows replacement, not two owners at once.
- **CI.** `flue run` in a job with `local()`: "use `local()` only when the runner itself provides
  the isolation boundary" (`ecosystem/deploy/gitlab-ci.md`). No Docker-in-Docker. GitLab can't start
  a pipeline from issue events; the doc's answer is a webhook relay to the trigger API.
- **Channels.** Verified HTTP ingress that calls `dispatch(...)`; outbound through the provider's
  own SDK (`guide/channels.md`). Slack: events, interactions, slash commands; `instanceId()` maps a
  thread to a conversation; `event_id` as `idempotencyKey`. Socket Mode is left to the application
  (`ecosystem/channels/slack.md`). **No GitLab channel**; a hand-written one is `createChannelRouter`.
- **Schedules.** Cron in `app.ts` (e.g. `croner`) → `dispatch` (`guide/schedules.md`).
- **Telemetry.** `@flue/opentelemetry` emits GenAI spans; exporter and flushing are the
  application's job, automatic only in generated Node servers (`ecosystem/tooling/opentelemetry.md`).

## Decisions

- **Auth by environment.** Subscription (`pi-auth`) locally; provider API keys in GitLab CI as masked
  variables. `openai-codex/*` is OAuth-only, so CI uses a different model id.
- **Sandbox by environment.** `docker(...)` locally (Milestones 3–4); `local()` in CI, where the job
  container is the boundary.
- **Your work on your Mac, team work in GitLab.** Team runs never go to the Mac: it is not always on,
  needs a tunnel, and would bill team work to a personal subscription.
- **Grow by need.** Each step below is useful alone; stop at any of them.

## Proposal: five steps

### 1. Two switches (with Milestone 4)

- `src/sandbox.ts`: `withInterceptors(SANDBOX === 'local' ? local(…) : docker(…), hooks)`.
- `src/model.ts`: `CI === 'true'` → API model; otherwise `usePiSubscription` + subscription model.

`smoke.ts` and `implementer.ts` import both. Commands do not change.

### 2. GitLab runs the same command

One job, no server:

```yaml
spec:
  inputs:
    issue: { description: "Issue IID to implement" }
---
implement:
  image: $CI_REGISTRY_IMAGE/target-app-flue:<digest>   # Milestone 4 Dockerfile + node/pnpm
  rules: [{ if: $CI_PIPELINE_SOURCE == "web" }]
  variables: { SANDBOX: local, GIT_DEPTH: 0 }
  script:
    - pnpm install --frozen-lockfile
    - pnpm implement --data "{\"issue\":$[[ inputs.issue ]]}"
    - git push origin HEAD:agent/$[[ inputs.issue ]]   # then open an MR; no local merge
  artifacts: { when: always, paths: [runs/] }
```

Teammates start it from **Run pipeline**. Later, without a relay: a scheduled pipeline lists
`agent-ready` issues with `glab` and starts one child pipeline each.

### 3. A local server, when Slack is wanted

The same sidecar served (`vite dev`, or `vite build` + `node dist/server.mjs`); agents and `db.ts`
already fit. Add `src/app.ts` and `flue add channel slack`:

- your mention → `dispatch(Implementer, { id, initialData: { issue } })` on the Mac;
- a teammate's → GitLab trigger API (step 2's job), reply with the pipeline link.

Reachability: a tunnel for the Events API, or Bolt Socket Mode (outbound only) beside the channel.
When the team depends on the Slack trigger, move that part to a small always-on host; it runs no
agents.

### 4. A second agent means a script

When a reviewer exists, chain agents in a plain script (`scripts/implement-review.ts`) with Flue's
`start()` → `init()` → `dispatch()`/`read()` and a bounded `for` for refine rounds, as in
[composition.md](composition.md). The same script runs on the Mac and as the CI job's command. Split
into GitLab stages only for a real need (manual approval, parallel jobs). Worktrees come with
Milestone 5; CI uses the job's checkout instead.

### 5. A React monitor over existing files

- **5a, local.** A Vite + React page served by step 3's server: list `runs/*/result.json`, stream
  `runs/<id>/events.jsonl` over SSE.
- **5b, CI.** The same page reads finished CI runs' `runs/` artifacts through the GitLab API. Live CI
  runs only if the job also POSTs its event lines to the server, which then must be reachable from CI.

| Step | New files | New infra |
|---|---|---|
| 1 | `src/sandbox.ts`, `src/model.ts` | none |
| 2 | `.gitlab-ci.yml`, CI image | CI variables, registry |
| 3 | `src/app.ts`, `src/channels/slack.ts` | Slack app; server on the Mac |
| 4 | `scripts/<name>.ts` per composition | none |
| 5 | `monitor/` page + two routes | none (5b live: reachable server) |

fluex changes: none beyond `flue-docker` (planned) and `packages/git` (Milestone 5), which needs a
"current checkout" strategy for CI next to "new worktree".

## Hosting beyond the Mac: Kubernetes

Goal: the local model, moved. One server owns every conversation in its db, `flue-docker` runs a
container per ticket, and `@flue/react` shows any run live.

### What a DinD pod is

DinD (Docker-in-Docker) runs a Docker daemon inside a container. A **DinD pod** is a Kubernetes
pod with two containers side by side:

- **server**: the sidecar's Flue server (`node dist/server.mjs`). `flue-docker` calls the `docker`
  CLI as on the Mac, but `DOCKER_HOST` points it at the daemon next door instead of Docker Desktop.
- **dind**: the official `docker:dind` image, a full Docker daemon. It builds the sandbox image and
  runs the per-ticket sandbox containers *inside the pod*.

The pod thus acts as a small Linux Docker host that Kubernetes schedules, restarts, and gives
volumes and secrets. The code is the same as on the Mac.

```
StatefulSet (1 replica)
└─ pod
   ├─ server  (node dist/server.mjs, flue-docker → docker CLI)
   │    env DOCKER_HOST=tcp://127.0.0.1:2376, DOCKER_TLS_VERIFY=1, DOCKER_CERT_PATH=/certs/client
   ├─ dind    (docker:dind, privileged or Sysbox) → sandbox containers, image builds
   └─ volumes
        /work            PVC, same path in both containers (repos, worktrees, Gradle cache)
        /var/lib/docker  PVC on dind, block storage (images and keyed containers survive restarts)
        /certs           emptyDir (dind writes TLS certs, server reads the client part)
```

```yaml
containers:
  - name: server
    image: …/target-app-flue-server
    env:
      - { name: DOCKER_HOST, value: tcp://127.0.0.1:2376 }
      - { name: DOCKER_TLS_VERIFY, value: "1" }
      - { name: DOCKER_CERT_PATH, value: /certs/client }
      - { name: TARGET_REPO, value: /work/target-app }
    volumeMounts: [{ name: work, mountPath: /work }, { name: certs, mountPath: /certs }]
  - name: dind
    image: docker:<pinned>-dind
    securityContext: { privileged: true }   # or runtimeClassName: sysbox-runc on the pod, unprivileged
    env: [{ name: DOCKER_TLS_CERTDIR, value: /certs }]
    volumeMounts:
      - { name: work, mountPath: /work }
      - { name: docker, mountPath: /var/lib/docker }
      - { name: certs, mountPath: /certs }
```

Requirements:

- **Privileged pods or Sysbox.** `docker:dind` needs `privileged: true` (root-equivalent on the node;
  forbidden by Pod Security baseline/restricted). Sysbox (`runtimeClassName: sysbox-runc`) runs Docker
  in an unprivileged pod but must be installed on the nodes. Never mount the node's `docker.sock`.
- **Same paths in both containers.** `flue-docker` bind-mounts host paths, and the daemon resolves
  them in its own filesystem; the shared volume at `/work` makes them identical.
- **`DOCKER_*` pass-through.** `flue-docker`'s `DockerCli` must forward `DOCKER_HOST`,
  `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH` from the server's environment to the `docker` child, never
  to the sandbox. Add to the Milestone 3 spec (it lists remote Docker hosts as out of scope).
- **Block storage** (RWO, ext4/xfs) for `/var/lib/docker`: overlay2 does not work on NFS-like volumes.
- **Pod size = sum of sandboxes** (6 GB / 6 CPUs each by default), and one replica: keyed containers
  live in that pod's daemon.

Risks: model-written commands run in a sandbox inside a privileged container on a shared node, so
one escape reaches the node (Sysbox removes most of this). The threat model today is local
dogfooding; multi-user on shared nodes needs a fresh review. dind's disk needs scheduled
`pnpm sandbox prune` and `docker system prune`.

### Job per run, and why it is the fallback

The server creates a Kubernetes Job per run; the Job runs `flue run … --id <ticket>` with `local()`
in the Milestone 4 image, and the pod is the isolation boundary (the CI shape). No privileges needed,
but no single process owns all conversations:

- Jobs *can* share the server's Postgres `db.ts`, but Flue's Node coordinator is lease-based: owners
  heartbeat a ~30 s lease and every coordinator scans every 15 s for expired leases "from other
  coordinators" and reclaims them (`guide/durability.md`, `packages/runtime/src/node/agent-coordinator.ts`).
  A dead Job's conversation would continue **in the server pod**, without repo or toolchain.
  Unverified: whether a server that doesn't register those agents skips them.
- So the coordinator becomes a fluex-owned run registry (a `runs` table written at launch, updated
  from events the Job posts and from Job status), not Flue's db.

### Comparison

| | One coordinator with all runs in its db | Live UI with `@flue/react` | Platform needs |
|---|---|---|---|
| Server + DinD pod | ✅ Flue's own | ✅ | privileged or Sysbox |
| Linux VM in the VPN | ✅ Flue's own | ✅ | a VM |
| Job per run | ⚠️ only through our own registry; a shared Flue db has the lease-reclaim risk | ❌ (our own event feed) | nothing special |

Preference: server + DinD pod, or a VM in the VPN if the platform prefers (same code, less ceremony);
Job per run only if both privileged pods and Sysbox are refused.

### Questions for the platform team

1. Privileged pods or Sysbox, in which namespace or node pool?
2. A block storage class for `/var/lib/docker`?
3. Egress from pods to Nexus and GitLab?
4. Pod size limits (CPU, RAM)?
5. Postgres available, or SQLite on a PVC?

## Collisions between Mac and CI

- **Label as lock.** Whoever picks a ticket swaps `agent-ready` → `agent-running`; both sides check it.
- **One branch per ticket** (`agent/<iid>`); if it exists on the remote, stop.
- **Same outputs** from both: MR, issue comment via `glab`, Slack message.

## Open

- **CI model id** for the API route; subscription and API runs are not directly comparable.
- **Platform permissions:** custom job image, trigger token, bot push and MR rights on the
  platform-managed GitLab components.
- **Worktrees in Docker:** git stores absolute host paths in the worktree's `.git` file and in
  `.git/worktrees/<id>/gitdir`. Either mount both at their host paths (cwd not `/workspace`) or use
  relative worktree paths, which need a recent git in the image too. Decide in Milestone 5.
- **Conversation ownership:** `run-cli.md`'s `fluex run` assumes `flue run` owns the conversation; a
  server owns its own. Don't run both on one db at once.
- **GitLab ChatOps** (`/gitlab <project> run <job>`) could replace a custom Slack trigger for CI;
  availability on the self-hosted instance unchecked.
- **OpenTelemetry** remains Milestone 9; under `flue run` call `disposeInstrumentation()` and shut the
  exporter down before exit.
