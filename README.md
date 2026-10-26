# fluex

Extensions for [Flue](https://github.com/withastro/flue) that run coding agents unattended on real projects: a target app's issues are implemented, tested and committed by an agent.
Packages: `pi-auth` (models through a pi subscription), `flue-docker` (a Docker sandbox, `defineSandbox`, the `pnpm sandbox` CLI), `flue-tools` (tool interceptors with Claude-compatible hooks, tool and skill filters, tool logs), and for apps served by the Flue Vite app: `sdk` (the browser-safe client layer over `@flue/sdk`), `server` (flow and sandbox routes, test helpers), `cli` (`pnpm agent` over HTTP).

```
@fluex/cli ────► @fluex/sdk ────► @flue/sdk
@fluex/server ─► @fluex/sdk
```

Research notes: [docs/research/](docs/research/) ([server.md](docs/research/server.md) for the app and its routes).
Goal: a daily agent loop built on upstream Flue plus these packages, sandboxed in Docker over git worktrees; a decision layer comes later.
Plan and progress: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Setup

Node 24, pnpm 12. `pnpm install` also installs the lefthook pre-commit.

Editor: install the **Oxc** plugin/extension and turn on format/fix on save; disable Prettier, skip ⌥⌘L in IntelliJ
(Settings → Tools → Oxfmt / Oxlint → Run 'Fix All' on Save).

## Tooling

- Node 24, pnpm 12, TypeScript 7 (Go `tsc`), vitest.
- oxlint (type-aware) and oxfmt: 2 spaces, no semicolons, sorted imports.
- lefthook pre-commit fixes and formats staged files.
- pnpm installs only day-old versions with no trust downgrade; exceptions in `pnpm-workspace.yaml`.
