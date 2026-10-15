import { posix } from 'node:path';
import type { Sandbox, SandboxFactory, SandboxToolFactory } from '@flue/runtime';
import { sandboxToolsOf } from './sandbox-tools.ts';

/** Keep `only` the listed names, or keep all but those in `exclude`. */
export type NameFilter = { only: string[]; exclude?: never } | { exclude: string[]; only?: never };

/** Whether `filter` lets `name` through. */
function allows(filter: NameFilter, name: string): boolean {
	if (filter.only) return filter.only.includes(name);
	return !filter.exclude.includes(name);
}

/**
 * Narrow the sandbox tools a factory offers, by Flue tool name (`read`, `write`, `edit`, `bash`, `grep`,
 * `glob`): `{ exclude: ['write', 'edit'] }` for a read-only role, or `{ only: [...] }` for an exact set.
 *
 * Filters the factory's `tools` slot, or Flue's default six when it has none. Framework tools (`task`,
 * `activate_skill`) are not sandbox tools and are never removed. Composes with every other `with*` in
 * any order; repeated, `exclude`s combine as a union and `only`s as an intersection.
 *
 * Not a security boundary: without `write` and `edit`, `bash` can still write files.
 */
export function withSandboxTools(factory: SandboxFactory, filter: NameFilter): SandboxFactory {
	const baseTools = sandboxToolsOf(factory);

	const tools: SandboxToolFactory = (sandbox, options) => {
		const all = baseTools(sandbox, options);
		const allowed = (tool: (typeof all)[number]) => allows(filter, tool.name);
		return all.filter(allowed);
	};

	return { ...factory, tools };
}

/** Whether `path` (absolute, as the sandbox resolves it) is a `.agents/skills` directory. */
function isSkillsDir(path: string): boolean {
	const normalized = posix.normalize(path);
	const trimmed = normalized.replace(/\/+$/, '');
	return trimmed.endsWith('/.agents/skills');
}

/**
 * Narrow the workspace skills an agent is offered, by skill directory name: `{ only: ['ast-grep'] }`, or
 * `{ exclude: [...] }`. A hidden skill is missing both from the skill catalog and from `activate_skill`.
 *
 * Wraps `createSandbox`, so that listing a `.agents/skills` directory returns only the allowed skill
 * directories; Flue's discovery reads the catalog through that listing. Only workspace skills are
 * filtered: skills the agent mounts itself with `useSkill` are always offered. Composes with every other
 * `with*` in any order; repeated, `exclude`s combine as a union and `only`s as an intersection.
 *
 * Not a security boundary: `read`, `bash` and `glob` still reach a hidden `SKILL.md` by its path.
 * Relies on Flue discovering workspace skills through the sandbox's `readdir` (Flue 2.3.0).
 */
export function withSkills(factory: SandboxFactory, filter: NameFilter): SandboxFactory {
	async function createSandbox(options: { id: string }): Promise<Sandbox> {
		const sandbox = await factory.createSandbox(options);

		async function readdir(path: string): Promise<string[]> {
			const entries = await sandbox.readdir(path);
			const resolved = sandbox.resolvePath(path);
			if (!isSkillsDir(resolved)) return entries;
			const allowed = (entry: string) => allows(filter, entry);
			return entries.filter(allowed);
		}

		// A spread, as Flue itself copies a sandbox (packaged-skill overlay): sandboxes are plain objects.
		return { ...sandbox, readdir };
	}

	return { ...factory, createSandbox };
}
