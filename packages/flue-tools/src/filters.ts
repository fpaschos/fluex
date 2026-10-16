import type { Sandbox, SandboxFactory, SandboxToolFactory } from '@flue/runtime';
import { defaultTools } from './interceptors.ts';

/** Keep `only` the listed names, or keep all but those in `exclude`. */
export type NameFilter = { only: string[]; exclude?: never } | { exclude: string[]; only?: never };

function allows(filter: NameFilter, name: string): boolean {
	if (filter.only) return filter.only.includes(name);
	return !filter.exclude.includes(name);
}

/**
 * Narrow the sandbox tools a factory offers (its `tools`, or Flue's default six) by Flue tool name:
 * `{ exclude: ['write', 'edit'] }` for a read-only role, or `{ only: [...] }`. Framework tools (`task`,
 * `activate_skill`) are never removed. Composes with every `with*` in any order; repeated, `exclude`s
 * combine as a union and `only`s as an intersection.
 *
 * Not a security boundary: without `write` and `edit`, `bash` can still write files.
 */
export function withSandboxTools(factory: SandboxFactory, filter: NameFilter): SandboxFactory {
	const baseTools = factory.tools ?? defaultTools;

	const tools: SandboxToolFactory = (sandbox, options) => {
		const all = baseTools(sandbox, options);
		const allowed = (tool: (typeof all)[number]) => allows(filter, tool.name);
		return all.filter(allowed);
	};

	return { ...factory, tools };
}

/**
 * Narrow the workspace skills an agent is offered, by skill directory name: `{ only: ['ast-grep'] }`, or
 * `{ exclude: [...] }`. A hidden skill is missing from both the catalog and `activate_skill`; skills
 * mounted with `useSkill` are not filtered. Composes like {@link withSandboxTools}.
 *
 * Wraps `createSandbox` so that listing a `.agents/skills` directory returns only the allowed entries:
 * Flue 2.3.0 discovers workspace skills through the sandbox's `readdir`.
 *
 * Not a security boundary: `read`, `bash` and `glob` still reach a hidden `SKILL.md` by its path.
 */
export function withSkills(factory: SandboxFactory, filter: NameFilter): SandboxFactory {
	async function createSandbox(options: { id: string }): Promise<Sandbox> {
		const sandbox = await factory.createSandbox(options);

		async function readdir(path: string): Promise<string[]> {
			const entries = await sandbox.readdir(path);
			const resolved = sandbox.resolvePath(path);
			if (!resolved.endsWith('/.agents/skills')) return entries;
			const allowed = (entry: string) => allows(filter, entry);
			return entries.filter(allowed);
		}

		// A spread, as Flue itself copies a sandbox (packaged-skill overlay): sandboxes are plain objects.
		return { ...sandbox, readdir };
	}

	return { ...factory, createSandbox };
}
