import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, type SandboxFactory } from '@flue/runtime';
import * as v from 'valibot';
import { local } from '@flue/runtime/node';
import { beforeEach, describe, expect, it } from 'vitest';
import { blocked, type ToolInterceptor, withContext, withInterceptors } from '../src/interceptors.ts';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fluex-interceptors-'));
});

/** The intercepted tool set over a real local sandbox rooted at `dir`. */
async function toolsOf(factory: SandboxFactory) {
	const sandbox = await factory.createSandbox({ id: 'test' });
	const tools = factory.tools!(sandbox, { subagents: {} });
	const call = (name: string, params: Record<string, unknown>) => tools.find((t) => t.name === name)!.execute(`call-${name}`, params as never);
	return { tools, call };
}
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text ?? '').join('');

describe('withInterceptors on a SandboxFactory', () => {
	it('blocks a call before it runs and passes the reason to the model', async () => {
		const noRm: ToolInterceptor = {
			intercept: async (call, next) => (String(call.input.command).includes('rm ') ? blocked('no rm') : next()),
		};
		const { call } = await toolsOf(withInterceptors(local({ cwd: dir }), noRm));
		writeFileSync(join(dir, 'keep.txt'), 'x');
		await expect(call('bash', { command: 'rm keep.txt' })).rejects.toMatchObject({ name: 'ToolBlockedError', code: 'FLUEX_TOOL_BLOCKED', message: 'no rm' });
		expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('x');
		expect(text(await call('bash', { command: 'echo ok' }))).toContain('ok');
	});

	it('rewrites the input through next(input)', async () => {
		const safer: ToolInterceptor = { intercept: async (call, next) => next({ ...call.input, command: 'echo rewritten' }) };
		const { call } = await toolsOf(withInterceptors(local({ cwd: dir }), safer));
		expect(text(await call('bash', { command: 'echo original' }))).toContain('rewritten');
	});

	it('adds context after the tool ran, recorded in details.fluex', async () => {
		const note: ToolInterceptor = { intercept: async (call, next) => withContext(await next(), `${call.tool} touched ${call.input.path}`) };
		const { call } = await toolsOf(withInterceptors(local({ cwd: dir }), note));
		const result = await call('write', { path: 'a.txt', content: 'hi' });
		expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hi');
		expect(text(result)).toContain('Successfully wrote');
		expect(text(result)).toContain('write touched a.txt');
		expect(result.details).toMatchObject({ fluex: { context: ['write touched a.txt'] } });
	});

	it('applies an interceptor only to the named tools; without `tools`, to every one', async () => {
		const seen: string[] = [];
		const onlyBash: ToolInterceptor = { tools: ['bash'], intercept: async (call, next) => (seen.push(`bash-only:${call.tool}`), next()) };
		const all: ToolInterceptor = { intercept: async (call, next) => (seen.push(`all:${call.tool}`), next()) };
		const { call } = await toolsOf(withInterceptors(local({ cwd: dir }), onlyBash, all));
		await call('bash', { command: 'echo hi' });
		await call('write', { path: 'a.txt', content: 'x' });
		expect(seen).toEqual(['bash-only:bash', 'all:bash', 'all:write']);
	});

	it('runs interceptors in argument order, and nested calls as an onion (outer first before, last after)', async () => {
		const order: string[] = [];
		const tracer = (name: string): ToolInterceptor => ({
			intercept: async (_call, next) => {
				order.push(`${name} before`);
				const result = await next();
				order.push(`${name} after`);
				return result;
			},
		});
		const factory = withInterceptors(withInterceptors(local({ cwd: dir }), tracer('inner')), tracer('outer 1'), tracer('outer 2'));
		const { call } = await toolsOf(factory);
		await call('bash', { command: 'echo hi' });
		expect(order).toEqual(['outer 1 before', 'outer 2 before', 'inner before', 'inner after', 'outer 2 after', 'outer 1 after']);
	});

	it('intercepts the default six tools of a factory that has none', async () => {
		const seen: string[] = [];
		const factory: SandboxFactory = { createSandbox: (options) => local({ cwd: dir }).createSandbox(options) };
		const { tools, call } = await toolsOf(withInterceptors(factory, { intercept: async (call, next) => (seen.push(call.tool), next()) }));
		expect(tools.map((t) => t.name)).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'glob']);
		await call('glob', { pattern: '*' });
		expect(seen).toEqual(['glob']);
	});

	it('passes the object createSandbox() returned as call.session, the same for every tools() call of it', async () => {
		const sessions: (object | undefined)[] = [];
		const factory = withInterceptors(local({ cwd: dir }), { intercept: async (call, next) => (sessions.push(call.session), next()) });
		const runAll = async () => {
			const sandbox = await factory.createSandbox({ id: 'test' });
			for (let turn = 0; turn < 2; turn++) {
				// Flue passes tools() a fresh object derived from the session's sandbox (cwd, skill overlays).
				const tools = factory.tools!(Object.create(sandbox), { subagents: {} });
				await tools.find((t) => t.name === 'bash')!.execute(`call-${turn}`, { command: 'echo hi' } as never);
			}
			return sandbox;
		};
		const first = await runAll();
		const second = await runAll();
		expect(sessions.map((s) => (s === first ? 'first' : s === second ? 'second' : 'other'))).toEqual(['first', 'first', 'second', 'second']);
	});
});

describe('withInterceptors on a ToolDefinition', () => {
	const runs: string[] = [];
	const greet = defineTool({
		name: 'greet',
		description: 'Greet someone.',
		input: v.object({ name: v.string() }),
		run: async ({ data }) => (runs.push(data.name), `hello ${data.name}`),
	});
	/** Call `run` the way Flue does, with a validated input. */
	const run = (tool: typeof greet, name: string) =>
		tool.run({ toolCallId: 'call-greet', log: console as never, data: { name } }) as Promise<string | { output?: unknown; terminate?: boolean }>;
	beforeEach(() => {
		runs.length = 0;
	});

	it('keeps the definition and intercepts run: block, rewrite the input, add context', async () => {
		const guard: ToolInterceptor = {
			tools: ['greet'],
			intercept: async (call, next) => {
				if (call.input.name === 'mallory') blocked('not mallory');
				const result = await next({ name: String(call.input.name).toUpperCase() });
				return withContext(result, 'be polite');
			},
		};
		const guarded = withInterceptors(greet, guard);
		expect({ name: guarded.name, description: guarded.description, input: guarded.input }).toEqual({ name: 'greet', description: 'Greet someone.', input: greet.input });

		await expect(run(guarded, 'mallory')).rejects.toMatchObject({ name: 'ToolBlockedError', code: 'FLUEX_TOOL_BLOCKED', message: 'not mallory' });
		expect(runs).toEqual([]);
		expect(await run(guarded, 'ada')).toEqual({ output: 'hello ADA\n\nbe polite' });
		expect(runs).toEqual(['ADA']);
	});

	it('returns the run output unchanged when no interceptor alters it, and skips interceptors for other tools', async () => {
		const seen: string[] = [];
		const elsewhere: ToolInterceptor = { tools: ['bash'], intercept: async (call, next) => (seen.push(call.tool), next()) };
		const passing: ToolInterceptor = { intercept: async (call, next) => (seen.push(call.tool), next()) };
		expect(await run(withInterceptors(greet, elsewhere, passing), 'ada')).toEqual({ output: 'hello ada' });
		expect(seen).toEqual(['greet']);
	});
});
