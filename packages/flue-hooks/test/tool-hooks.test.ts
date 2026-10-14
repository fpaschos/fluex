import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxFactory } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { beforeEach, describe, expect, it } from 'vitest';
import { claudeHooks } from '../src/claude-hooks.ts';
import { type HookRun, onHookRun } from '../src/hook-reports.ts';
import { type ToolHooks, withToolHooks } from '../src/tool-hooks.ts';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fluex-hooks-'));
});

/** The hooked tool set over a real local sandbox rooted at `dir`. */
async function toolsWith(hooks: ToolHooks, factory: SandboxFactory = local({ cwd: dir })) {
	const hooked = withToolHooks(factory, hooks);
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

describe('withToolHooks', () => {
	it('keeps the default six tools', async () => {
		const { tools } = await toolsWith({});
		expect(tools.map((t) => t.name)).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'glob']);
	});

	it('blocks a call before it runs and passes the reason to the model', async () => {
		const { call } = await toolsWith({ pre: [async ({ input }) => (String(input.command).includes('rm ') ? { block: 'no rm' } : undefined)] });
		writeFileSync(join(dir, 'keep.txt'), 'x');
		await expect(call('bash', { command: 'rm keep.txt' })).rejects.toThrow('Blocked by PreToolUse hook:\nno rm');
		expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('x');
		expect(text(await call('bash', { command: 'echo ok' }))).toContain('ok');
	});

	it('appends post feedback to a successful result', async () => {
		const { call } = await toolsWith({ post: [async ({ tool, input }) => ({ feedback: `${tool} touched ${input.path}` })] });
		const result = await call('write', { path: 'a.txt', content: 'hi' });
		expect(text(result)).toContain('Successfully wrote');
		expect(text(result)).toContain('PostToolUse hook feedback:\nwrite touched a.txt');
	});
});

describe('claudeHooks', () => {
	it('blocks with stderr when a PreToolUse script exits 2, using Claude stdin', async () => {
		claudeProject(
			{ PreToolUse: [{ matcher: 'Bash', hooks: [command('guard.sh')] }] },
			{ 'guard.sh': `cmd="$(jq -r .tool_input.command)"; [[ "$cmd" == find* ]] && { echo "use fd" >&2; exit 2; }; exit 0` },
		);
		const { call } = await toolsWith(claudeHooks(dir));
		await expect(call('bash', { command: 'find .' })).rejects.toThrow('use fd');
		expect(text(await call('bash', { command: 'echo fine' }))).toContain('fine');
	});

	it('feeds PostToolUse stderr back after an edit, with an absolute file_path', async () => {
		claudeProject(
			{ PostToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [command('lint.sh')] }] },
			{ 'lint.sh': `f="$(jq -r .tool_input.file_path)"; grep -q TODO "$f" && { echo "TODO left in $f" >&2; exit 2; }; exit 0` },
		);
		const { call } = await toolsWith(claudeHooks(dir));
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
		const { call } = await toolsWith(claudeHooks(dir));
		await expect(call('write', { path: 'b.txt', content: 'x' })).rejects.toThrow('read-only');
		expect(text(await call('bash', { command: 'echo free' }))).toContain('free');
	});

	it('treats other exit codes as non-blocking warnings', async () => {
		claudeProject({ PreToolUse: [{ hooks: [command('broken.sh')] }] }, { 'broken.sh': 'echo oops >&2; exit 1' });
		const warnings: string[] = [];
		const { call } = await toolsWith(claudeHooks(dir, { warn: (m) => warnings.push(m) }));
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
			const { call } = await toolsWith(claudeHooks(dir, { warn: () => {} }));
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
	])('rejects a settings file where %s, naming the file', (_case, hooks) => {
		claudeProject(hooks, {});
		expect(() => claudeHooks(dir)).toThrow(`[fluex] invalid Claude hooks in ${join(dir, '.claude', 'settings.json')}: `);
	});

	it('rejects a settings file that is not JSON, naming the file', () => {
		claudeProject({}, {});
		writeFileSync(join(dir, '.claude', 'settings.json'), '{ "hooks": {}, }');
		expect(() => claudeHooks(dir)).toThrow(`[fluex] invalid Claude hooks in ${join(dir, '.claude', 'settings.json')}: `);
	});

	it('ignores events and hooks it does not run', () => {
		claudeProject({ Stop: 'anything', PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'ok?' }] }] }, {});
		expect(() => claudeHooks(dir)).not.toThrow();
	});
});
