# fluex

Extensions for [Flue](https://github.com/withastro/flue) that run coding agents unattended on real projects: a target app's issues are implemented, tested and committed by an agent.
Packages: `pi-auth` (models through a pi subscription), `flue-docker` (a Docker sandbox), `flue-tools` (tool interceptors with Claude-compatible hooks, tool and skill filters, tool logs).
Goal: a daily agent loop built on upstream Flue plus these packages, sandboxed in Docker over git worktrees; a decision layer comes later.
Plan and progress: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
