import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlueObservation } from '@flue/runtime';
import { describe, expect, it } from 'vitest';
import { lineDiff, ToolLog, toolLog } from '../src/tool-log.ts';

const ev = (e: Record<string, unknown>) => ({ instanceId: 'impl-1', timestamp: '2026-10-13T10:00:00.000Z', ...e }) as unknown as FlueObservation;
const start = (toolCallId: string, toolName: string, args: unknown) => ev({ type: 'tool_start', toolCallId, toolName, args });
const end = (toolCallId: string, toolName: string, result: unknown, isError = false, durationMs = 1500) =>
	ev({ type: 'tool', toolCallId, toolName, isError, result, durationMs });
const text = (t: string, exitCode?: number, fluex?: object) => ({
	content: [{ type: 'text', text: t }],
	details: { ...(exitCode === undefined ? {} : { exitCode }), ...(fluex ? { fluex } : {}) },
});
/** A call an interceptor blocked, as Flue observes it: the error text as result, the error in `errorInfo`. */
const blockedEnd = (toolCallId: string, toolName: string, message: string) =>
	({
		...end(toolCallId, toolName, text(message), true),
		errorInfo: { type: 'FLUEX_TOOL_BLOCKED', name: 'ToolBlockedError', code: 'FLUEX_TOOL_BLOCKED', message },
	}) as FlueObservation;

function setup() {
	const runsDir = mkdtempSync(join(tmpdir(), 'fluex-log-'));
	const lines: string[] = [];
	const log = new ToolLog({ runsDir, write: (l) => lines.push(l) });
	const events = () => readFileSync(join(runsDir, 'impl-1', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	return { log, lines, events };
}

describe('ToolLog', () => {
	it('prints one automaton-style line per call, when it ends', () => {
		const { log, lines } = setup();
		log.record(start('a', 'bash', { command: './gradlew jvmTest' }));
		log.record(end('a', 'bash', text('BUILD FAILED\n\nCommand exited with code 1', 1), false, 19_500));
		log.record(start('b', 'edit', { path: 'A.kt', oldText: 'x\ny', newText: 'x\ny\nz' }));
		log.record(end('b', 'edit', text('Successfully edited A.kt')));
		log.record(start('c', 'write', { path: 'B.kt', content: '1\n2\n3' }));
		log.record(end('c', 'write', text('Successfully wrote'), false, 20));
		log.record(start('d', 'activate_skill', { name: 'ast-grep' }));
		log.record(end('d', 'activate_skill', text('<skill_instructions>…')));
		log.record(start('e', 'read', { path: 'C.kt', offset: 25 }));
		log.record(end('e', 'read', { message: 'ENOENT: C.kt' }, true));
		expect(lines).toEqual([
			'[impl-1] #1 bash(./gradlew jvmTest) ✗ exit 1 · 19.5s · 40B',
			'[impl-1] #2 edit(A.kt, +1 -0) ✓ 1.5s',
			'[impl-1] #3 write(B.kt, 3 lines) ✓ 0.0s',
			'[impl-1] #4 skill(ast-grep) ✓ 1.5s',
			'[impl-1] #5 read(C.kt @25) ✗ 1.5s · ENOENT: C.kt',
		]);
	});

	it('cuts a long call short but always keeps how it ended', () => {
		const { log, lines } = setup();
		const command = `glab issue list --output json | jq '${'x'.repeat(300)}'`;
		log.record(start('a', 'bash', { command }));
		log.record(end('a', 'bash', text('[]', 0), false, 785));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toHaveLength(200);
		expect(lines[0]).toMatch(/^\[impl-1\] #1 bash\(glab issue list .*x… ✓ exit 0 · 0\.8s · 2B$/);
	});

	it('shows hook blocks and feedback on the call they belong to', () => {
		const { log, lines, events } = setup();
		log.record(start('a', 'bash', { command: 'find . -name x' }));
		log.record(blockedEnd('a', 'bash', "Blocked by PreToolUse hook:\nBlocked: use 'fd' instead of 'find'"));
		log.record(start('b', 'edit', { path: 'A.kt', oldText: 'a', newText: 'b' }));
		const feedback = 'PostToolUse hook feedback:\nast-grep findings in A.kt:\nwarning[no-println]\nline 3';
		log.record(end('b', 'edit', text('Successfully edited A.kt', undefined, { context: [feedback] })));
		log.record(ev({ type: 'submission_settled', outcome: 'completed' }));
		expect(lines.slice(0, -1)).toEqual([
			"[impl-1] #1 hook PreToolUse BLOCKED bash: Blocked: use 'fd' instead of 'find'",
			"[impl-1] #1 bash(find . -name x) ✗ exit ? · 1.5s · 63B · Blocked by PreToolUse hook:",
			'[impl-1] #2 hook PostToolUse feedback edit: ast-grep findings in A.kt: (+2 lines)',
			'[impl-1] #2 edit(A.kt, +1 -1) ✓ 1.5s',
		]);
		expect(lines.at(-1)).toMatch(/^\[impl-1\] done completed · 0 turns · 2 tools \(1 errors, 1 blocked\) · /);
		expect(events().filter((e) => e.type === 'hook').map((e) => e.outcome)).toEqual(['blocked', 'feedback']);
	});

	it('shows blocks and context from any interceptor', () => {
		const { log, lines, events } = setup();
		log.record(start('a', 'bash', { command: 'rm x' }));
		log.record(blockedEnd('a', 'bash', 'no rm'));
		log.record(start('b', 'write', { path: 'a.txt', content: 'hi' }));
		log.record(end('b', 'write', text('Successfully wrote', undefined, { context: ['write touched a.txt'] }), false, 20));
		expect(lines).toEqual([
			'[impl-1] #1 BLOCKED bash: no rm',
			'[impl-1] #1 bash(rm x) ✗ exit ? · 1.5s · 5B · no rm',
			'[impl-1] #2 context write: write touched a.txt',
			'[impl-1] #2 write(a.txt, 1 lines) ✓ 0.0s',
		]);
		const notes = events().filter((e) => e.type === 'blocked' || e.type === 'context');
		expect(notes.map((e) => [e.type, e.text])).toEqual([
			['blocked', 'no rm'],
			['context', 'write touched a.txt'],
		]);
	});

	it('is mounted as an observe() subscriber', () => {
		const runsDir = mkdtempSync(join(tmpdir(), 'fluex-log-'));
		const lines: string[] = [];
		const subscriber = toolLog({ runsDir, write: (l) => lines.push(l) });
		const context = {} as Parameters<typeof subscriber>[1];
		subscriber(start('a', 'bash', { command: 'ls' }), context);
		subscriber(end('a', 'bash', text('a.txt', 0)), context);
		expect(lines).toEqual(['[impl-1] #1 bash(ls) ✓ exit 0 · 1.5s · 5B']);
	});

	it('logs every hook script run on its call, and counts them when settled', () => {
		const { log, lines, events } = setup();
		const lint = '${CLAUDE_PROJECT_DIR}/.claude/hooks/kotlin-lint.sh';
		const lintRun = { event: 'PostToolUse', command: lint, exitCode: 0, durationMs: 312 };
		log.record(start('a', 'edit', { path: 'A.kt', oldText: 'a', newText: 'b' }));
		log.record(end('a', 'edit', text('Successfully edited A.kt', undefined, { hookRuns: [lintRun] })));
		const guardRun = { event: 'PreToolUse', command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.sh', exitCode: 1, durationMs: 40 };
		log.record(start('b', 'bash', { command: 'ls' }));
		log.record(end('b', 'bash', text('a.txt', 0, { hookRuns: [guardRun] })));
		log.record(ev({ type: 'submission_settled', outcome: 'completed' }));
		expect(lines).toEqual([
			'[impl-1] #1 hook PostToolUse kotlin-lint.sh ✓ exit 0 · 0.3s',
			'[impl-1] #1 edit(A.kt, +1 -1) ✓ 1.5s',
			'[impl-1] #2 hook PreToolUse guard.sh ✗ exit 1 · 0.0s',
			'[impl-1] #2 bash(ls) ✓ exit 0 · 1.5s · 5B',
			expect.stringMatching(/^\[impl-1\] done completed · 0 turns · 2 tools · 2 hooks · /),
		]);
		expect(events().find((e) => e.type === 'hook_run')).toMatchObject({ n: 1, toolCallId: 'a', tool: 'edit', event: 'PostToolUse', command: lint, exitCode: 0, durationMs: 312 });
		expect(events().at(-1)).toMatchObject({ type: 'settled', hooks: 2 });
	});

	it('sums turns and usage into a settle summary and writes events.jsonl', () => {
		const { log, lines, events } = setup();
		const usage = (input: number, output: number, total: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
		log.record(ev({ type: 'turn', turnId: 't1', durationMs: 10, isError: false, response: { usage: usage(5000, 200, 0.03) }, submissionId: 's1' }));
		log.record(start('a', 'bash', { command: 'ls' }));
		log.record(end('a', 'bash', text('a.txt', 0)));
		log.record(ev({ type: 'turn', turnId: 't2', durationMs: 10, isError: false, response: { usage: usage(6000, 100, 0.04) } }));
		log.record({ ...ev({ type: 'submission_settled', submissionId: 's1', outcome: 'completed' }), instanceId: undefined } as unknown as FlueObservation);
		expect(lines.at(-1)).toMatch(/^\[impl-1\] done completed · 2 turns · 1 tools · 11\.0k in \/ 300 out · \$0\.0700 list · /);
		expect(events().map((e) => e.type)).toEqual(['turn', 'tool_start', 'tool', 'turn', 'settled']);
		expect(events()[2]).toMatchObject({ tool: 'bash', exitCode: 0, failed: false, output: 'a.txt' });
	});

	it('counts edit lines by content, not position', () => {
		expect(lineDiff('a\nb', 'a\nb\nc')).toEqual({ added: 1, removed: 0 });
		expect(lineDiff('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
		expect(lineDiff('x = 1', 'x = 2')).toEqual({ added: 1, removed: 1 });
	});
});
