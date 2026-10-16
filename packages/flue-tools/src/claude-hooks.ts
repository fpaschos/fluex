import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Sandbox } from '@flue/runtime';
import * as v from 'valibot';
import {
	blocked,
	type FluexDetails,
	type HookRun,
	type ToolCall,
	type ToolInterceptor,
	type ToolResult,
	withContext,
} from './interceptors.ts';

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
 * Claude Code `PreToolUse` / `PostToolUse` command hooks from `.claude/settings*.json`, as a
 * {@link ToolInterceptor}. Scripts run in the sandbox with Claude's stdin JSON and exit codes:
 * 0 passes (stdout JSON honoured: `deny`/`block`, pre `additionalContext` and `updatedInput`),
 * 2 blocks (pre) or feeds stderr back (post), anything else warns. Matchers use Claude tool
 * names and Claude's rules; a plain matcher naming a tool fluex does not intercept warns once.
 *
 * Settings are read once per submission, so a model's edit to them takes effect on the next
 * submission. An invalid settings file fails every call of that submission, naming the file.
 */
export function claudeHooks(options: ClaudeHooksOptions = {}): ToolInterceptor {
	const { files = ['settings.json', 'settings.local.json'], warn = (m) => console.warn(m) } = options;
	// Per submission, not per `call.sandbox` (rebuilt every turn); the promise covers parallel first calls.
	const loaded = new WeakMap<object, Promise<Groups>>();
	const run = async (event: HookEvent, call: SandboxCall, extra: object) => {
		const projectDir = options.projectDir === undefined ? call.sandbox.cwd : call.sandbox.resolvePath(options.projectDir);
		const key = call.session ?? call.sandbox;
		let groups = loaded.get(key);
		if (!groups) {
			groups = load(call.sandbox, projectDir, files, warn);
			loaded.set(key, groups);
		}
		return Promise.all(matching((await groups)[event], call.tool).map((hook) => runHook(hook, event, call, extra, projectDir, warn)));
	};

	return {
		tools: Object.keys(CLAUDE_TOOL),
		async intercept(call, next) {
			// Only sandbox tools have a sandbox to read settings from and run scripts in.
			if (!call.sandbox) return next();
			const sandboxCall = { ...call, sandbox: call.sandbox };

			const preRuns = await run('PreToolUse', sandboxCall, {});
			const blocks: string[] = [];
			const preContext: string[] = [];
			let input = call.input;
			for (const scriptRun of preRuns) {
				const { outcome } = scriptRun;
				if (outcome?.block) blocks.push(caught('blocked', call.tool, scriptRun, outcome.block));
				if (outcome?.context) preContext.push(caught('context', call.tool, scriptRun, outcome.context));
				if (outcome?.updatedInput) {
					const updated = flueInput(call.tool, outcome.updatedInput);
					input = { ...input, ...updated };
				}
			}
			// A call that throws (blocked here, or failing in the tool) has no result to record script runs on.
			if (blocks.length > 0) blocked(blocks.join('\n\n'));

			const toolResult = await next(input);
			const result = preContext.reduce(withContext, toolResult);

			// As in Claude Code: the input the tool ran with, and its own response.
			const ranCall = { ...sandboxCall, input };
			const toolResponse = { content: toolResult.content, details: toolResult.details };
			const postRuns = await run('PostToolUse', ranCall, { tool_response: toolResponse });
			const feedback: string[] = [];
			for (const scriptRun of postRuns) {
				const { outcome } = scriptRun;
				if (outcome?.context) feedback.push(caught('feedback', call.tool, scriptRun, outcome.context));
			}
			const withFeedback = feedback.reduce(withContext, result);

			const scriptRuns = [...preRuns, ...postRuns];
			const hookRunOf = ({ hookRun }: ScriptRun) => hookRun;
			const hookRuns = scriptRuns.map(hookRunOf);
			if (hookRuns.length === 0) return withFeedback;
			return withHookRuns(withFeedback, hookRuns);
		},
	};
}

/** One script's catch, headed as Claude Code names hooks: `PreToolUse:Bash hook blocked [<command>] (exit 2):`; `ToolLog` parses it. */
function caught(kind: 'blocked' | 'context' | 'feedback', tool: string, { hookRun }: ScriptRun, text: string): string {
	const { event, command, exitCode } = hookRun;
	return `${event}:${CLAUDE_TOOL[tool]} hook ${kind} [${command}] (exit ${exitCode}):\n${text}`;
}

/** Append `runs` to `result.details.fluex.hookRuns`, for observers; the text the model reads is unchanged. */
function withHookRuns(result: ToolResult, runs: HookRun[]): ToolResult {
	const details = (result.details ?? {}) as { fluex?: FluexDetails };
	const hookRuns = [...(details.fluex?.hookRuns ?? []), ...runs];
	const fluex = { ...details.fluex, hookRuns };
	return { ...result, details: { ...details, fluex } };
}

/** The matcher groups of every settings file present under `<projectDir>/.claude/`, merged in order. */
async function load(sandbox: Sandbox, projectDir: string, files: string[], warn: (message: string) => void): Promise<Groups> {
	const groups: Groups = { PreToolUse: [], PostToolUse: [] };
	for (const file of files) {
		const path = posix.join(projectDir, '.claude', file);
		if (!(await sandbox.exists(path))) continue;
		const hooks = settings(path, await sandbox.readFile(path)).hooks ?? {};
		groups.PreToolUse.push(...(hooks.PreToolUse ?? []));
		groups.PostToolUse.push(...(hooks.PostToolUse ?? []));
	}
	const allGroups = [...groups.PreToolUse, ...groups.PostToolUse];
	const skipped = new Set(allGroups.flatMap(notIntercepted));
	if (skipped.size > 0) warn(`[fluex] Claude hooks on tools fluex does not intercept never run: ${[...skipped].join(', ')}`);
	return groups;
}

/** Tools a plain matcher names that fluex does not intercept; regexes are not checked. */
function notIntercepted({ matcher }: MatcherGroup): string[] {
	if (!matcher || !NAME_LIST.test(matcher)) return [];
	const intercepted = Object.values(CLAUDE_TOOL);
	const names = toolNames(matcher);
	return names.filter((name) => !intercepted.includes(name));
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
	const isCommand = (hook: MatcherGroup['hooks'][number]): hook is CommandHook => hook.type === 'command';
	const selected = groups.filter(({ matcher }) => matches(matcher, name));
	return selected.flatMap(({ hooks }) => hooks.filter(isCommand));
}

/** A matcher of only these characters is a name or a `|`/`,` list; anything else is a regex. */
const NAME_LIST = /^[A-Za-z0-9_\- ,|]*$/;

/** Claude Code's rules: `*` or empty is all, a plain matcher is exact names, else an unanchored regex. */
function matches(matcher: string | undefined, name: string): boolean {
	if (!matcher || matcher === '*') return true;
	if (!NAME_LIST.test(matcher)) return new RegExp(matcher).test(name);
	return toolNames(matcher).includes(name);
}

function toolNames(matcher: string): string[] {
	const names = matcher.split(/[|,]/).map((part) => part.trim());
	return names.filter((part) => part !== '');
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

/** Claude `tool_input` field → Flue input field, per tool: the renames {@link claudeInput} makes. */
const FLUE_FIELD: Record<string, Record<string, string>> = {
	read: { file_path: 'path' },
	write: { file_path: 'path' },
	edit: { file_path: 'path', old_string: 'oldText', new_string: 'newText', replace_all: 'replaceAll' },
};

/** A hook's `updatedInput` (Claude shape) as Flue input fields, to merge over the call's own. */
function flueInput(tool: string, updated: Record<string, unknown>): Record<string, unknown> {
	const names = FLUE_FIELD[tool] ?? {};
	const input: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(updated)) {
		input[names[key] ?? key] = value;
	}
	// Claude's Bash `timeout` is in ms, Flue's in seconds.
	if (tool === 'bash' && typeof input.timeout === 'number') input.timeout = input.timeout / 1000;
	return input;
}

async function runHook(
	hook: CommandHook,
	event: HookEvent,
	call: SandboxCall,
	extra: object,
	projectDir: string,
	warn: (message: string) => void,
): Promise<ScriptRun> {
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
		const hookRun: HookRun = {
			event,
			command: hook.command,
			exitCode,
			durationMs,
		};
		if (exitCode === 2) {
			const outcome = event === 'PreToolUse' ? { block: stderr.trim() } : { context: stderr.trim() };
			return { hookRun, outcome };
		}
		if (exitCode !== 0) {
			warn(`[fluex] ${event} hook exited ${exitCode} (non-blocking): ${hook.command}\n${stderr.trim()}`);
			return { hookRun };
		}
		return { hookRun, outcome: decision(event, stdout) };
	} finally {
		await sandbox.rm(stdinFile, { force: true }).catch(() => {});
	}
}

/** One script that ran, and what it asked for, if anything. */
interface ScriptRun {
	hookRun: HookRun;
	outcome?: HookOutcome;
}

/** What one script asks: block the call, append `context` to its result, or rewrite its input (Claude shape). */
interface HookOutcome {
	block?: string;
	context?: string;
	updatedInput?: Record<string, unknown>;
}

/** The exit-0 stdout JSON fields fluex reads. */
interface HookOutput {
	decision?: string;
	reason?: string;
	hookSpecificOutput?: {
		permissionDecision?: string;
		permissionDecisionReason?: string;
		additionalContext?: string;
		updatedInput?: Record<string, unknown>;
	};
}

function decision(event: HookEvent, stdout: string): HookOutcome | undefined {
	const text = stdout.trim();
	if (!text.startsWith('{')) return undefined;
	let out: HookOutput;
	try {
		out = JSON.parse(text);
	} catch {
		return undefined;
	}
	const specific = out.hookSpecificOutput;
	if (event === 'PreToolUse') {
		if (specific?.permissionDecision === 'deny') return { block: specific.permissionDecisionReason ?? 'denied by hook' };
		if (out.decision === 'block') return { block: out.reason ?? 'blocked by hook' };
		return { context: specific?.additionalContext, updatedInput: specific?.updatedInput };
	}
	const context = [out.decision === 'block' ? out.reason : undefined, specific?.additionalContext].filter(Boolean).join('\n');
	return context ? { context } : undefined;
}
