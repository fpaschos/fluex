# AGENTS.md

## Dependencies and manifests

Change `package.json` and `pnpm-lock.yaml` only through the pnpm CLI, so the manifest and the lockfile always move together:

- Add dependencies at their latest version, pinned exactly: `pnpm add -E <pkg>` (`-D` for dev, `--save-peer` for peer). Versions are bare (`1.2.3`), never ranges (`^`, `~`).
- Shared versions (`@flue/*`, `pi-ai`) live in the `catalog:` of `pnpm-workspace.yaml`: reference one with `pnpm add <pkg>@catalog:`, add a new one with `pnpm add -E --save-catalog <pkg>`.
- Upgrade with `pnpm update -L -E <pkg>`, remove with `pnpm remove <pkg>`, scaffold a package with `pnpm init`, and set other fields with `pnpm pkg set` / `pnpm pkg delete`.
- `pnpm pkg set` rejects `:` in a key path; set such keys as JSON: `pnpm pkg set --json 'scripts={"check:types":"tsc --noEmit"}'`.
- Every dependency version, including `catalog:` entries in `pnpm-workspace.yaml`, changes through a pnpm command. When no command covers a change, stop and ask the user. The lockfile is always generated.

## Commands

- `pnpm test`, `pnpm test:integration` — unit tests; integration tests (need Docker).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` — typecheck, oxlint, oxfmt; `pnpm lint:fix`, `pnpm format` to fix. A lefthook pre-commit fixes staged files.
- `pnpm pack` — pack every package into `packs/` for the target app.

## Linting and formatting

- After changing code, run `pnpm lint:fix`, then `pnpm format`.
- Before finishing, run `pnpm typecheck` and `pnpm lint --format=agent`.

## Code style

Write code that reads top to bottom, one step per line: name each intermediate value in a `const`, define a callback on its own lines before passing it, and `return` a name or a single plain call. Spell out object literals with more than three fields one field per line.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `fpaschos/fluex`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default role names, except `ready-for-agent` → `agent-ready` and `ready-for-human` → `human-ready`; plus `agent-complete` (agent finished its step, issue open, waiting on the user). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root, shared by all packages. See `docs/agents/domain.md`.
