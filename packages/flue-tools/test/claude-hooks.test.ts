import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxFactory } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { beforeEach, describe, expect, it } from 'vitest';
import { claudeHooks } from '../src/claude-hooks.ts';
import { type HookRun, onHookRun } from '../src/hook-reports.ts';
import { type ToolInterceptor, withInterceptors } from '../src/interceptors.ts';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fluex-hooks-'));
});

/** The intercepted tool set over a real local sandbox rooted at `dir`. */
async function toolsWith(interceptor: ToolInterceptor, factory: SandboxFactory = local({ cwd: dir })) {
	const hooked = withInterceptors(factory, interceptor);
	const sandbox = await hooked.createSandbox({ id: 'test' });
	const tools = hooked.tools!(sandbox, { subagents: {} });
	const call = (name: string, params: Record<string, unknown>) => tools.find((t) => t.name === name)!.execute(`call-${name}`, params as never);
	return { tools, call };
}
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text ?? '').join('');

/** Write `.claude/settings.json` and executable hook scripts into `dir`. */
function claudeProject(hooks: object, scripts: Record<string, string>) {
	mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true });
	writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks }));
	for (const [name, body] of Object.entries(scripts)) {
		const path = join(dir, '.claude', 'hooks', name);
		writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
		chmodSync(path, 0o755);
	}
}
const command = (script: string) => ({ type: 'command', command: `\${CLAUDE_PROJECT_DIR}/.claude/hooks/${script}` });

describe('claudeHooks', () => {
	it('blocks with stderr when a PreToolUse script exits 2, using Claude stdin', async () => {
		claudeProject(
			{ PreToolUse: [{ matcher: 'Bash', hooks: [command('guard.sh')] }] },
			{ 'guard.sh': `cmd="$(jq -r .tool_input.command)"; [[ "$cmd" == find* ]] && { echo "use fd" >&2; exit 2; }; exit 0` },
		);
		const { call } = await toolsWith(claudeHooks());
		await expect(call('bash', { command: 'find .' })).rejects.toMatchObject({ code: 'FLUEX_TOOL_BLOCKED', message: 'Blocked by PreToolUse hook:\nuse fd' });
		expect(text(await call('bash', { command: 'echo fine' }))).toContain('fine');
	});

	it('feeds PostToolUse stderr back after an edit, with an absolute file_path', async () => {
		claudeProject(
			{ PostToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [command('lint.sh')] }] },
			{ 'lint.sh': `f="$(jq -r .tool_input.file_path)"; grep -q TODO "$f" && { echo "TODO left in $f" >&2; exit 2; }; exit 0` },
		);
		const { call } = await toolsWith(claudeHooks());
		writeFileSync(join(dir, 'A.kt'), 'fun a() = 1\n');
		const result = await call('edit', { path: 'A.kt', oldText: '= 1', newText: '= 1 // TODO' });
		expect(text(result)).toContain(`TODO left in ${join(dir, 'A.kt')}`);
		expect(text(await call('read', { path: 'A.kt' }))).not.toContain('PostToolUse');
	});

	it('honours exit-0 JSON permissionDecision deny and ignores non-matching tools', async () => {
		claudeProject(
			{ PreToolUse: [{ matcher: 'Write', hooks: [command('deny.sh')] }] },
			{ 'deny.sh': `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"read-only"}}'` },
		);
		const { call } = await toolsWith(claudeHooks());
		await expect(call('write', { path: 'b.txt', content: 'x' })).rejects.toThrow('read-only');
		expect(text(await call('bash', { command: 'echo free' }))).toContain('free');
	});

	it('appends PreToolUse additionalContext to the result the model sees', async () => {
		claudeProject(
			{ PreToolUse: [{ matcher: 'Bash', hooks: [command('context.sh')] }] },
			{ 'context.sh': `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"prefer rg"}}'` },
		);
		const { call } = await toolsWith(claudeHooks());
		const result = await call('bash', { command: 'echo ran' });
		expect(text(result)).toContain('ran');
		expect(text(result)).toContain('prefer rg');
		expect(result.details).toMatchObject({ fluex: { context: [expect.stringContaining('prefer rg')] } });
	});

	it('runs the tool with a PreToolUse updatedInput, given in Claude\'s shape', async () => {
		claudeProject(
			{
				PreToolUse: [
					{ matcher: 'Bash', hooks: [command('rewrite-bash.sh')] },
					{ matcher: 'Write', hooks: [command('rewrite-write.sh')] },
				],
			},
			{
				'rewrite-bash.sh': `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"echo rewritten"}}}'`,
				'rewrite-write.sh': `echo "{\\"hookSpecificOutput\\":{\\"updatedInput\\":{\\"file_path\\":\\"$CLAUDE_PROJECT_DIR/moved.txt\\",\\"content\\":\\"safe\\"}}}"`,
			},
		);
		const { call } = await toolsWith(claudeHooks());
		expect(text(await call('bash', { command: 'echo original' }))).toContain('rewritten');
		await call('write', { path: 'asked.txt', content: 'unsafe' });
		expect(readFileSync(join(dir, 'moved.txt'), 'utf8')).toBe('safe');
		expect(existsSync(join(dir, 'asked.txt'))).toBe(false);
	});

	it('treats other exit codes as non-blocking warnings', async () => {
		claudeProject({ PreToolUse: [{ hooks: [command('broken.sh')] }] }, { 'broken.sh': 'echo oops >&2; exit 1' });
		const warnings: string[] = [];
		const { call } = await toolsWith(claudeHooks({ warn: (m) => warnings.push(m) }));
		expect(text(await call('bash', { command: 'echo still' }))).toContain('still');
		expect(warnings.join()).toContain('exited 1 (non-blocking)');
	});

	it('reports every script it runs, whatever the outcome', async () => {
		claudeProject(
			{ PreToolUse: [{ matcher: 'Bash', hooks: [command('ok.sh'), command('broken.sh')] }] },
			{ 'ok.sh': 'exit 0', 'broken.sh': 'exit 1' },
		);
		const runs: HookRun[] = [];
		const stop = onHookRun((run) => runs.push(run));
		try {
			const { call } = await toolsWith(claudeHooks({ warn: () => {} }));
			await call('bash', { command: 'echo hi' });
			await call('read', { path: '.claude/settings.json' });
		} finally {
			stop();
		}
		// Scripts of one event run in parallel, so they report in completion order.
		const byCommand = runs.toSorted((x, y) => y.command.localeCompare(x.command));
		expect(byCommand.map(({ toolCallId, tool, event, command, exitCode }) => ({ toolCallId, tool, event, command, exitCode }))).toEqual([
			{ toolCallId: 'call-bash', tool: 'bash', event: 'PreToolUse', command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/ok.sh', exitCode: 0 },
			{ toolCallId: 'call-bash', tool: 'bash', event: 'PreToolUse', command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/broken.sh', exitCode: 1 },
		]);
		expect(runs.every((r) => r.durationMs >= 0)).toBe(true);
	});

	it.each([
		['PreToolUse is not an array', { PreToolUse: { matcher: 'Bash', hooks: [command('guard.sh')] } }],
		['a group has no hooks', { PostToolUse: [{ matcher: 'Edit' }] }],
		['a hook has no command', { PreToolUse: [{ hooks: [{ type: 'command' }] }] }],
		['a matcher is not a valid regex', { PreToolUse: [{ matcher: 'Bash(', hooks: [command('guard.sh')] }] }],
	])('fails tool calls when a settings file is invalid (%s), naming the file', async (_case, hooks) => {
		claudeProject(hooks, {});
		const { call } = await toolsWith(claudeHooks());
		await expect(call('bash', { command: 'echo hi' })).rejects.toThrow(`[fluex] invalid Claude hooks in ${join(dir, '.claude', 'settings.json')}: `);
	});

	it('fails tool calls when a settings file is not JSON, naming the file', async () => {
		claudeProject({}, {});
		writeFileSync(join(dir, '.claude', 'settings.json'), '{ "hooks": {}, }');
		const { call } = await toolsWith(claudeHooks());
		await expect(call('bash', { command: 'echo hi' })).rejects.toThrow(`[fluex] invalid Claude hooks in ${join(dir, '.claude', 'settings.json')}: `);
	});

	it.each([
		['*', 'bash', true],
		['', 'bash', true],
		['Edit', 'edit', true],
		['Edit', 'write', false],
		['Edit', 'bash', false],
		['Edit, Write', 'write', true],
		['Edit, Write', 'bash', false],
		['Edit|Write', 'edit', true],
		['Edit|Write', 'bash', false],
		['dit', 'edit', false],
		['dit$', 'edit', true],
		['dit$', 'write', false],
		['^Ba', 'bash', true],
		['Wr.*', 'write', true],
		['Wr.*', 'read', false],
	])('matcher %j on %s runs the hook: %s', async (matcher, tool, runs) => {
		claudeProject({ PreToolUse: [{ matcher, hooks: [command('stop.sh')] }] }, { 'stop.sh': 'echo matched >&2; exit 2' });
		writeFileSync(join(dir, 'a.txt'), 'x');
		const inputs: Record<string, Record<string, unknown>> = {
			bash: { command: 'echo ran' },
			edit: { path: 'a.txt', oldText: 'x', newText: 'y' },
			write: { path: 'b.txt', content: 'x' },
			read: { path: 'a.txt' },
		};
		const { call } = await toolsWith(claudeHooks({ warn: () => {} }));
		const outcome = call(tool, inputs[tool]!);
		if (runs) await expect(outcome).rejects.toThrow('matched');
		else await expect(outcome).resolves.toBeDefined();
	});

	it('warns once, when settings load, about matchers on tools fluex does not intercept', async () => {
		claudeProject(
			{
				PreToolUse: [
					{ matcher: 'Skill', hooks: [command('ok.sh')] },
					{ matcher: 'Agent', hooks: [command('ok.sh')] },
				],
				PostToolUse: [{ matcher: 'mcp__x', hooks: [command('ok.sh')] }],
			},
			{ 'ok.sh': 'exit 0' },
		);
		const warnings: string[] = [];
		const { call } = await toolsWith(claudeHooks({ warn: (m) => warnings.push(m) }));
		await Promise.all([call('bash', { command: 'echo 1' }), call('bash', { command: 'echo 2' })]);
		await call('read', { path: '.claude/settings.json' });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('Skill');
		expect(warnings[0]).toContain('Agent');
		expect(warnings[0]).toContain('mcp__x');
	});

	it('does not warn about matchers on tools it intercepts', async () => {
		claudeProject(
			{ PreToolUse: [{ matcher: '*', hooks: [command('ok.sh')] }, { matcher: 'Edit, Write', hooks: [command('ok.sh')] }, { matcher: 'Bash', hooks: [command('ok.sh')] }] },
			{ 'ok.sh': 'exit 0' },
		);
		const warnings: string[] = [];
		const { call } = await toolsWith(claudeHooks({ warn: (m) => warnings.push(m) }));
		await call('bash', { command: 'echo 1' });
		expect(warnings).toEqual([]);
	});

	it('ignores events and hooks it does not run', async () => {
		claudeProject({ Stop: 'anything', PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'ok?' }] }] }, {});
		const { call } = await toolsWith(claudeHooks());
		expect(text(await call('bash', { command: 'echo fine' }))).toContain('fine');
	});

	it('runs no scripts for a sandbox without settings', async () => {
		const { call } = await toolsWith(claudeHooks());
		expect(text(await call('bash', { command: 'echo bare' }))).toContain('bare');
	});

	it('reads each sandbox\'s own settings, so concurrent agents in different checkouts get their own hooks', async () => {
		const hooks = claudeHooks();
		const strict = dir;
		claudeProject({ PreToolUse: [{ matcher: 'Bash', hooks: [command('deny.sh')] }] }, { 'deny.sh': 'echo "strict checkout" >&2; exit 2' });
		const open = mkdtempSync(join(tmpdir(), 'fluex-hooks-'));
		const [a, b] = await Promise.all([toolsWith(hooks, local({ cwd: strict })), toolsWith(hooks, local({ cwd: open }))]);
		const [blocked, passed] = await Promise.allSettled([a.call('bash', { command: 'echo a' }), b.call('bash', { command: 'echo b' })]);
		expect(blocked).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('strict checkout') } });
		expect(passed).toMatchObject({ status: 'fulfilled' });
	});

	it('reads the settings once per submission, over every turn and parallel first calls', async () => {
		claudeProject({ PreToolUse: [{ matcher: 'Bash', hooks: [command('ok.sh')] }] }, { 'ok.sh': 'exit 0' });
		const reads: string[] = [];
		const counting: SandboxFactory = {
			async createSandbox(options) {
				const sandbox = await local({ cwd: dir }).createSandbox(options);
				return new Proxy(sandbox, {
					get(target, key) {
						const value = Reflect.get(target, key, target);
						if (key === 'readFile') return (path: string) => (reads.push(path), target.readFile(path));
						return typeof value === 'function' ? value.bind(target) : value;
					},
				});
			},
		};
		const hooked = withInterceptors(counting, claudeHooks());
		const settingsReads = () => reads.filter((path) => path.endsWith('settings.json'));

		// Flue passes `tools()` a new object derived from the sandbox at every turn.
		const turn = async (sandbox: object, commands: string[]) => {
			const derived = new Proxy(sandbox, {}) as Parameters<NonNullable<SandboxFactory['tools']>>[0];
			const tools = hooked.tools!(derived, { subagents: {} });
			const bash = tools.find((t) => t.name === 'bash')!;
			const calls = commands.map((cmd, i) => bash.execute(`call-${i}`, { command: cmd } as never));
			await Promise.all(calls);
		};

		const first = await hooked.createSandbox({ id: 'first' });
		await turn(first, ['echo 1', 'echo 2', 'echo 3']);
		await turn(first, ['echo 4']);
		await turn(first, ['echo 5']);
		expect(settingsReads()).toEqual([join(dir, '.claude', 'settings.json')]);

		const second = await hooked.createSandbox({ id: 'second' });
		await turn(second, ['echo 6']);
		expect(settingsReads()).toHaveLength(2);
	});

	it('reads the settings from projectDir and exports it as CLAUDE_PROJECT_DIR', async () => {
		const project = join(dir, 'app');
		mkdirSync(join(project, '.claude'), { recursive: true });
		writeFileSync(
			join(project, '.claude', 'settings.json'),
			JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "project=$CLAUDE_PROJECT_DIR" >&2; exit 2' }] }] } }),
		);
		const { call } = await toolsWith(claudeHooks({ projectDir: 'app' }));
		await expect(call('bash', { command: 'echo hi' })).rejects.toThrow(`project=${project}`);
	});
});
