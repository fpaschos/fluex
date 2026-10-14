import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type FlueObservation, observe, type PromptUsage } from '@flue/runtime';
import { type HookReport, type HookRun, onHookReport, onHookRun } from './hook-reports.ts';

export interface ToolLogOptions {
	/** Directory for `<runsDir>/<instanceId>/events.jsonl`; `false` disables the file. Default `runs`. */
	runsDir?: string | false;
	/** Where display lines go. Default: stderr, next to `flue run`'s own output. */
	write?: (line: string) => void;
}

interface Call {
	n: number;
	tool: string;
	args: Record<string, unknown>;
}

/** Per agent instance (`flue run --id`): call numbering, open calls, and totals. */
interface Instance {
	started: number;
	next: number;
	calls: Map<string, Call>;
	turns: number;
	tools: number;
	errors: number;
	blocked: number;
	hooks: number;
	usage: { input: number; output: number; cost: number };
}

const MAX_LINE = 200;
const MAX_FIELD = 2000;

/**
 * Automaton-style tool log: one line per tool call (`bash(cmd)`, `edit(path, +N -M)`, …),
 * bash exit/duration/size, skill activations, every hook script run, hook blocks and feedback,
 * and a summary when
 * the submission settles. Lines go to {@link ToolLogOptions.write}; the same activity goes
 * to `runs/<instanceId>/events.jsonl` with stable, fluex-owned field names.
 */
export class ToolLog {
	private readonly instances = new Map<string, Instance>();
	private readonly instanceOfCall = new Map<string, string>();
	private readonly instanceOfSubmission = new Map<string, string>();
	private readonly runsDir: string | false;
	private readonly write: (line: string) => void;

	constructor({ runsDir = 'runs', write = (line) => process.stderr.write(`${line}\n`) }: ToolLogOptions = {}) {
		this.runsDir = runsDir;
		this.write = write;
	}

	record(event: FlueObservation): void {
		const id = event.instanceId ?? (event.submissionId ? this.instanceOfSubmission.get(event.submissionId) : undefined);
		if (id === undefined) return;
		if (event.submissionId) this.instanceOfSubmission.set(event.submissionId, id);
		const run = this.instance(id);
		const ts = event.timestamp;

		switch (event.type) {
			case 'tool_start': {
				if (!event.toolCallId) return;
				const call: Call = { n: ++run.next, tool: event.toolName, args: (event.args ?? {}) as Record<string, unknown> };
				run.calls.set(event.toolCallId, call);
				this.instanceOfCall.set(event.toolCallId, id);
				this.event(id, { ts, type: 'tool_start', n: call.n, toolCallId: event.toolCallId, tool: call.tool, args: clip(call.args) });
				return;
			}
			case 'tool': {
				const call = event.toolCallId ? run.calls.get(event.toolCallId) : undefined;
				if (!call || !event.toolCallId) return;
				run.calls.delete(event.toolCallId);
				this.instanceOfCall.delete(event.toolCallId);
				run.tools++;
				const output = resultText(event.result);
				const exitCode = exitCodeOf(event.result);
				const failed = event.isError || (exitCode !== undefined && exitCode !== 0);
				if (event.isError) run.errors++;
				// One line per call, when it ends: `flue run` already prints a line when it starts.
				this.line(id, call.n, describe(call), ` ${outcome(call, event.isError, exitCode, event.durationMs, output)}`);
				this.event(id, {
					ts,
					type: 'tool',
					n: call.n,
					toolCallId: event.toolCallId,
					tool: call.tool,
					isError: event.isError,
					failed,
					durationMs: event.durationMs,
					...(exitCode === undefined ? {} : { exitCode }),
					bytes: Buffer.byteLength(output),
					output: tail(output),
				});
				return;
			}
			case 'turn': {
				run.turns++;
				const usage = event.response.usage;
				if (usage) add(run.usage, usage);
				this.event(id, { ts, type: 'turn', turnId: event.turnId, durationMs: event.durationMs, isError: event.isError, usage: usage ?? null });
				return;
			}
			case 'log':
				this.event(id, { ts, type: 'log', level: event.level, message: event.message });
				return;
			case 'submission_settled': {
				const minutes = ((Date.parse(ts) - run.started) / 60_000).toFixed(1);
				const { input, output, cost } = run.usage;
				const problems = [run.errors && `${run.errors} errors`, run.blocked && `${run.blocked} blocked`].filter(Boolean).join(', ');
				this.line(
					id,
					undefined,
					`done ${event.outcome} · ${run.turns} turns · ${run.tools} tools${problems ? ` (${problems})` : ''}${run.hooks ? ` · ${run.hooks} hooks` : ''} · ${k(input)} in / ${k(output)} out · $${cost.toFixed(4)} list · ${minutes} min`,
				);
				this.event(id, { ts, type: 'settled', outcome: event.outcome, error: event.error?.message ?? null, turns: run.turns, tools: run.tools, errors: run.errors, blocked: run.blocked, hooks: run.hooks, usage: run.usage, minutes: Number(minutes) });
				this.instances.delete(id);
				return;
			}
		}
	}

	hook(report: HookReport): void {
		const id = this.instanceOfCall.get(report.toolCallId);
		if (id === undefined) return;
		const run = this.instance(id);
		const n = run.calls.get(report.toolCallId)?.n;
		if (report.outcome === 'blocked') run.blocked++;
		const [first = '', ...rest] = report.text.trim().split('\n');
		const more = rest.length > 0 ? ` (+${rest.length} lines)` : '';
		this.line(id, n, `hook ${report.event} ${report.outcome === 'blocked' ? 'BLOCKED' : 'feedback'} ${report.tool}: ${first}${more}`);
		this.event(id, { ts: new Date().toISOString(), type: 'hook', n, toolCallId: report.toolCallId, tool: report.tool, event: report.event, outcome: report.outcome, text: tail(report.text) });
	}

	/** One line per hook script, on the call it ran for: `hook PostToolUse kotlin-lint.sh ✓ exit 0 · 0.3s`. */
	hookRun(report: HookRun): void {
		const id = this.instanceOfCall.get(report.toolCallId);
		if (id === undefined) return;
		const run = this.instance(id);
		const n = run.calls.get(report.toolCallId)?.n;
		run.hooks++;
		const script = report.command.split('/').at(-1) ?? report.command;
		this.line(id, n, `hook ${report.event} ${script} ${report.exitCode === 0 ? '✓' : '✗'} exit ${report.exitCode} · ${(report.durationMs / 1000).toFixed(1)}s`);
		this.event(id, { ts: new Date().toISOString(), type: 'hook_run', n, toolCallId: report.toolCallId, tool: report.tool, event: report.event, command: report.command, exitCode: report.exitCode, durationMs: report.durationMs });
	}

	private instance(id: string): Instance {
		let run = this.instances.get(id);
		if (!run) {
			run = { started: Date.now(), next: 0, calls: new Map(), turns: 0, tools: 0, errors: 0, blocked: 0, hooks: 0, usage: { input: 0, output: 0, cost: 0 } };
			this.instances.set(id, run);
		}
		return run;
	}

	/** `[id] #n <text><end>` on one line of at most MAX_LINE chars: `text` is cut to fit, `end` is always kept. */
	private line(id: string, n: number | undefined, text: string, end = ''): void {
		const flat = (value: string) => value.replace(/\s*\n\s*/g, ' ⏎ ');
		const line = `[${id}] ${n === undefined ? '' : `#${n} `}${flat(text)}`;
		const kept = flat(end);
		const room = Math.max(1, MAX_LINE - kept.length);
		this.write(`${line.length > room ? `${line.slice(0, room - 1)}…` : line}${kept}`);
	}

	private event(id: string, record: Record<string, unknown>): void {
		if (this.runsDir === false) return;
		const dir = join(this.runsDir, id);
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(record)}\n`);
	}
}

/** The call as it was made: `bash(cmd)`, `edit(path, +N -M)`, `skill(name)`, … */
function describe({ tool, args }: Call): string {
	const s = (v: unknown) => (typeof v === 'string' ? v : '');
	switch (tool) {
		case 'bash':
			return `bash(${s(args.command)})`;
		case 'read':
			return `read(${s(args.path)}${typeof args.offset === 'number' ? ` @${args.offset}` : ''})`;
		case 'write':
			return `write(${s(args.path)}, ${lines(s(args.content))} lines)`;
		case 'edit': {
			const { added, removed } = lineDiff(s(args.oldText), s(args.newText));
			return `edit(${s(args.path)}, +${added} -${removed}${args.replaceAll ? ', all' : ''})`;
		}
		case 'grep':
			return `grep(${s(args.pattern)}${args.path ? ` in ${s(args.path)}` : ''})`;
		case 'glob':
			return `glob(${s(args.pattern)}${args.path ? ` in ${s(args.path)}` : ''})`;
		case 'activate_skill':
			return `skill(${s(args.name)})`;
		default:
			return tool;
	}
}

/** How it ended: `✓ 0.1s`; bash adds exit code and output size; failures add the first error line. */
function outcome(call: Call, isError: boolean, exitCode: number | undefined, durationMs: number, output: string): string {
	const failed = isError || (exitCode !== undefined && exitCode !== 0);
	const parts = [failed ? '✗' : '✓'];
	if (call.tool === 'bash') parts.push(`exit ${exitCode ?? (isError ? '?' : 0)} ·`);
	parts.push(`${(durationMs / 1000).toFixed(1)}s`);
	if (call.tool === 'bash') parts.push(`· ${size(Buffer.byteLength(output))}`);
	if (isError) parts.push(`· ${output.trim().split('\n')[0] ?? ''}`);
	return parts.join(' ');
}

/** Text of a tool result (`content` blocks) or of an error-shaped result. */
function resultText(result: unknown): string {
	if (result === undefined || result === null) return '';
	if (typeof result === 'string') return result;
	const r = result as { content?: { type?: string; text?: string }[]; message?: string };
	if (Array.isArray(r.content)) return r.content.map((c) => c.text ?? '').join('');
	if (typeof r.message === 'string') return r.message;
	return JSON.stringify(result);
}

function exitCodeOf(result: unknown): number | undefined {
	const code = (result as { details?: { exitCode?: unknown } } | undefined)?.details?.exitCode;
	return typeof code === 'number' ? code : undefined;
}

/** Added/removed lines between two texts, by line multiset (no alignment). */
export function lineDiff(oldText: string, newText: string): { added: number; removed: number } {
	const counts = new Map<string, number>();
	for (const line of oldText.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
	let added = 0;
	for (const line of newText.split('\n')) {
		const c = counts.get(line) ?? 0;
		if (c > 0) counts.set(line, c - 1);
		else added++;
	}
	const removed = [...counts.values()].reduce((a, b) => a + b, 0);
	return { added, removed };
}

const lines = (text: string) => (text === '' ? 0 : text.split('\n').length);
const tail = (text: string) => (text.length > MAX_FIELD ? `…${text.slice(-MAX_FIELD)}` : text);
const size = (bytes: number) => (bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}kB`);
const k = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);

function add(total: Instance['usage'], usage: PromptUsage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cost += usage.cost.total;
}

/** Strings longer than the field limit are cut, so a large `write` does not bloat the log. */
function clip(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).map(([key, v]) => [key, typeof v === 'string' && v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}…` : v]));
}

let installed = false;

/**
 * Register the process-wide tool log once. Call at agent-module top level (`flue run` never
 * loads `app.ts`); later calls are no-ops.
 */
export function logToolCalls(options: ToolLogOptions = {}): void {
	if (installed) return;
	installed = true;
	const log = new ToolLog(options);
	observe((event) => log.record(event));
	onHookReport((report) => log.hook(report));
	onHookRun((report) => log.hookRun(report));
}
