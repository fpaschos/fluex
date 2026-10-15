import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Sandbox } from '@flue/runtime';
import * as v from 'valibot';
import { reportHook, reportHookRun } from './hook-reports.ts';
import { blocked, type ToolCall, type ToolInterceptor, withContext } from './interceptors.ts';

/** Flue sandbox tool → Claude Code tool name, as hook matchers see it. */
const CLAUDE_TOOL: Record<string, string> = { read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash', grep: 'Grep', glob: 'Glob' };

/** A hook entry; only `command` hooks are run, others (`prompt`, `agent`) are ignored. */
const HookSchema = v.pipe(
	v.looseObject({
		type: v.string(),
		command: v.optional(v.string()),
		/** Seconds; Claude Code's default is 60. */
		timeout: v.optional(v.number()),
	}),
	v.check((hook) => hook.type !== 'command' || hook.command !== undefined, 'a command hook needs a `command`'),
);
/** A matcher group. */
const MatcherGroupSchema = v.object({
	matcher: v.optional(v.string()),
	hooks: v.array(HookSchema),
});
/** The parts of a Claude settings file fluex runs; other keys and events are left unchecked. */
const SettingsSchema = v.looseObject({
	hooks: v.optional(
		v.looseObject({ PreToolUse: v.optional(v.array(MatcherGroupSchema)), PostToolUse: v.optional(v.array(MatcherGroupSchema)) }),
	),
});

type CommandHook = v.InferOutput<typeof HookSchema> & { type: 'command'; command: string };
type MatcherGroup = v.InferOutput<typeof MatcherGroupSchema>;
type HookEvent = 'PreToolUse' | 'PostToolUse';
type Groups = Record<HookEvent, MatcherGroup[]>;
type SandboxCall = ToolCall & { sandbox: Sandbox };

export interface ClaudeHooksOptions {
	/** Settings files under `<projectDir>/.claude/`, merged in order. */
	files?: string[];
	/** The project inside the sandbox: where the settings are read, and `CLAUDE_PROJECT_DIR`. Defaults to the sandbox `cwd`. */
	projectDir?: string;
	/** Where non-blocking hook failures go. Defaults to `console.warn`. */
	warn?: (message: string) => void;
}

/**
 * Load Claude Code `PreToolUse` / `PostToolUse` command hooks from a project's
 * `.claude/settings.json` (+ `settings.local.json`) as a {@link ToolInterceptor}, for
 * {@link withInterceptors}. Scripts run unchanged, inside the sandbox, with Claude's stdin
 * JSON and exit-code contract: 0 passes (stdout JSON `decision`/`permissionDecision`
 * honoured), 2 blocks (pre) or feeds stderr back to the model (post), anything else is a
 * non-blocking warning. Other events and non-`command` hooks are ignored.
 *
 * The settings are read through the sandbox, once per sandbox, on its first tool call: settings and
 * scripts come from the same checkout, whether it is mounted from the host or cloned inside.
 * An invalid settings file fails every tool call of that sandbox, naming the file.
 */
export function claudeHooks(options: ClaudeHooksOptions = {}): ToolInterceptor {
	const { files = ['settings.json', 'settings.local.json'], warn = (m) => console.warn(m) } = options;
	// Keyed by sandbox: each agent instance has its own, so concurrent agents read their own checkout.
	// The promise is cached, so parallel first calls share one read.
	const loaded = new WeakMap<Sandbox, Promise<Groups>>();
	const run = async (event: HookEvent, call: SandboxCall, extra: object) => {
		const projectDir = options.projectDir === undefined ? call.sandbox.cwd : call.sandbox.resolvePath(options.projectDir);
		let groups = loaded.get(call.sandbox);
		if (!groups) {
			groups = load(call.sandbox, projectDir, files);
			loaded.set(call.sandbox, groups);
		}
		return Promise.all(matching((await groups)[event], call.tool).map((hook) => runHook(hook, event, call, extra, projectDir, warn)));
	};

	return {
		tools: Object.keys(CLAUDE_TOOL),
		async intercept(call, next) {
			// Only sandbox tools have a sandbox to read settings from and run scripts in.
			if (!call.sandbox) return next();
			const sandboxCall = { ...call, sandbox: call.sandbox };
			const blocks = (await run('PreToolUse', sandboxCall, {})).flatMap((r) => (r?.block ? [r.block] : []));
			if (blocks.length > 0) {
				const text = blocks.join('\n');
				reportHook({ toolCallId: call.toolCallId, tool: call.tool, event: 'PreToolUse', outcome: 'blocked', text });
				blocked(`Blocked by PreToolUse hook:\n${text}`);
			}

			const result = await next();
			const toolResponse = { content: result.content, details: result.details };
			const feedback = (await run('PostToolUse', sandboxCall, { tool_response: toolResponse })).flatMap((r) => (r?.feedback ? [r.feedback] : []));
			if (feedback.length === 0) return result;
			const text = feedback.join('\n');
			reportHook({ toolCallId: call.toolCallId, tool: call.tool, event: 'PostToolUse', outcome: 'feedback', text });
			return withContext(result, `PostToolUse hook feedback:\n${text}`);
		},
	};
}

/** The matcher groups of every settings file present under `<projectDir>/.claude/`, merged in order. */
async function load(sandbox: Sandbox, projectDir: string, files: string[]): Promise<Groups> {
	const groups: Groups = { PreToolUse: [], PostToolUse: [] };
	for (const file of files) {
		const path = posix.join(projectDir, '.claude', file);
		if (!(await sandbox.exists(path))) continue;
		const hooks = settings(path, await sandbox.readFile(path)).hooks ?? {};
		groups.PreToolUse.push(...(hooks.PreToolUse ?? []));
		groups.PostToolUse.push(...(hooks.PostToolUse ?? []));
	}
	return groups;
}

/** The settings in `text` (read from `path`), or an error naming the file and what is wrong with it. */
function settings(path: string, text: string): v.InferOutput<typeof SettingsSchema> {
	const invalid = (problem: string) => new Error(`[fluex] invalid Claude hooks in ${path}: ${problem}`);
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		throw invalid((error as Error).message);
	}
	const parsed = v.safeParse(SettingsSchema, json);
	if (!parsed.success) throw invalid(v.summarize(parsed.issues));
	return parsed.output;
}

function matching(groups: MatcherGroup[], tool: string): CommandHook[] {
	const name = CLAUDE_TOOL[tool];
	if (!name) return [];
	return groups
		.filter(({ matcher }) => !matcher || matcher === '*' || new RegExp(`^(?:${matcher})$`).test(name))
		.flatMap(({ hooks }) => hooks.filter((hook): hook is CommandHook => hook.type === 'command'));
}

/** Claude Code's `tool_input` shape: absolute `file_path`, snake_case edit fields, `timeout` in ms. */
function claudeInput(tool: string, input: Record<string, unknown>, sandbox: Sandbox): Record<string, unknown> {
	const abs = (p: unknown) => (typeof p === 'string' ? sandbox.resolvePath(p) : p);
	switch (tool) {
		case 'bash':
			return { command: input.command, ...(typeof input.timeout === 'number' ? { timeout: input.timeout * 1000 } : {}) };
		case 'read':
			return { file_path: abs(input.path), offset: input.offset, limit: input.limit };
		case 'write':
			return { file_path: abs(input.path), content: input.content };
		case 'edit':
			return { file_path: abs(input.path), old_string: input.oldText, new_string: input.newText, replace_all: input.replaceAll ?? false };
		default:
			return { ...input, ...(input.path === undefined ? {} : { path: abs(input.path) }) };
	}
}

async function runHook(
	hook: CommandHook,
	event: HookEvent,
	call: SandboxCall,
	extra: object,
	projectDir: string,
	warn: (message: string) => void,
): Promise<{ block?: string; feedback?: string } | undefined> {
	const { sandbox } = call;
	const stdin = JSON.stringify({
		session_id: '',
		transcript_path: '',
		cwd: sandbox.cwd,
		hook_event_name: event,
		tool_name: CLAUDE_TOOL[call.tool],
		tool_input: claudeInput(call.tool, call.input, sandbox),
		...extra,
	});
	// stdin goes through a file in the sandbox: no shell quoting, no argv size limit.
	const stdinFile = `/tmp/fluex-hook-${randomUUID()}.json`;
	await sandbox.writeFile(stdinFile, stdin);
	try {
		const started = performance.now();
		const { stdout, stderr, exitCode } = await sandbox.exec(`(${hook.command}) < ${stdinFile}`, {
			env: { CLAUDE_PROJECT_DIR: projectDir },
			timeoutMs: (hook.timeout ?? 60) * 1000,
			signal: call.signal,
		});
		const durationMs = Math.round(performance.now() - started);
		reportHookRun({ toolCallId: call.toolCallId, tool: call.tool, event, command: hook.command, exitCode, durationMs });
		if (exitCode === 2) return event === 'PreToolUse' ? { block: stderr.trim() } : { feedback: stderr.trim() };
		if (exitCode !== 0) {
			warn(`[fluex] ${event} hook exited ${exitCode} (non-blocking): ${hook.command}\n${stderr.trim()}`);
			return undefined;
		}
		return decision(event, stdout);
	} finally {
		await sandbox.rm(stdinFile, { force: true }).catch(() => {});
	}
}

/** Exit-0 JSON output: `decision: "block"` and `hookSpecificOutput.permissionDecision: "deny"`. */
function decision(event: HookEvent, stdout: string): { block?: string; feedback?: string } | undefined {
	const text = stdout.trim();
	if (!text.startsWith('{')) return undefined;
	let out: { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };
	try {
		out = JSON.parse(text);
	} catch {
		return undefined;
	}
	const specific = out.hookSpecificOutput;
	if (event === 'PreToolUse') {
		if (specific?.permissionDecision === 'deny') return { block: specific.permissionDecisionReason ?? 'denied by hook' };
		if (out.decision === 'block') return { block: out.reason ?? 'blocked by hook' };
		return undefined;
	}
	const feedback = [out.decision === 'block' ? out.reason : undefined, specific?.additionalContext].filter(Boolean).join('\n');
	return feedback ? { feedback } : undefined;
}
