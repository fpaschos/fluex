import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Sandbox } from '@flue/runtime';
import * as v from 'valibot';
import { reportHook, reportHookRun } from './hook-reports.ts';
import { blocked, type ToolCall, type ToolInterceptor, withContext } from './interceptors.ts';

/** Flue sandbox tool → Claude Code tool name, as hook matchers see it. */
const CLAUDE_TOOL: Record<string, string> = { read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash', grep: 'Grep', glob: 'Glob' };

/** A matcher of only these characters is a tool name, or a list of names; anything else is a regex. */
const NAME_LIST = /^[A-Za-z0-9_\- ,|]*$/;

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
/** Whether `matcher`, when it is a regex (not a plain name list), compiles. */
function validMatcher(matcher: string): boolean {
	if (matcher === '*' || NAME_LIST.test(matcher)) return true;
	try {
		new RegExp(matcher);
		return true;
	} catch {
		return false;
	}
}
/** A matcher group. */
const MatcherGroupSchema = v.object({
	matcher: v.optional(v.pipe(v.string(), v.check(validMatcher, 'a matcher must be a tool name list or a valid regex'))),
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
 * non-blocking warning. A PreToolUse `additionalContext` is appended to the result and an
 * `updatedInput` is what the tool runs with. Other events and non-`command` hooks are ignored.
 *
 * Matchers follow Claude Code and use Claude tool names (`Edit`, not `edit`): `*` or empty
 * matches all; a matcher of only `[A-Za-z0-9_\- ,|]` is an exact name or a `|`/`,` list;
 * anything else is an unanchored regex. A matcher on a tool fluex does not intercept
 * (`Skill`, `Agent`, `mcp__*`, …) gets one warning when the settings load.
 *
 * The settings are read through the sandbox, once per submission (one `createSandbox()`), on its
 * first tool call: settings and scripts come from the same checkout, whether it is mounted from the
 * host or cloned inside. A model's edit to `.claude/settings*.json` takes effect on the next
 * submission. An invalid settings file fails every tool call of that submission, naming the file.
 */
export function claudeHooks(options: ClaudeHooksOptions = {}): ToolInterceptor {
	const { files = ['settings.json', 'settings.local.json'], warn = (m) => console.warn(m) } = options;
	// Keyed by submission (`call.session`): each has its own sandbox, so concurrent agents read their own
	// checkout. Not by `call.sandbox`, which Flue rebuilds at every turn. The promise is cached, so parallel
	// first calls share one read.
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

			const preOutcomes = await run('PreToolUse', sandboxCall, {});
			const blocks: string[] = [];
			const preContext: string[] = [];
			let input = call.input;
			for (const outcome of preOutcomes) {
				if (outcome?.block) blocks.push(outcome.block);
				if (outcome?.context) preContext.push(outcome.context);
				if (outcome?.updatedInput) {
					const updated = flueInput(call.tool, outcome.updatedInput);
					input = { ...input, ...updated };
				}
			}
			if (blocks.length > 0) {
				const text = blocks.join('\n');
				reportHook({
					toolCallId: call.toolCallId,
					tool: call.tool,
					event: 'PreToolUse',
					outcome: 'blocked',
					text,
				});
				blocked(`Blocked by PreToolUse hook:\n${text}`);
			}

			const toolResult = await next(input);
			const contextText = `PreToolUse hook context:\n${preContext.join('\n')}`;
			const result = preContext.length === 0 ? toolResult : withContext(toolResult, contextText);

			// PostToolUse sees the input the tool ran with and the tool's own response, as in Claude Code.
			const ranCall = { ...sandboxCall, input };
			const toolResponse = { content: toolResult.content, details: toolResult.details };
			const postOutcomes = await run('PostToolUse', ranCall, { tool_response: toolResponse });
			const feedback: string[] = [];
			for (const outcome of postOutcomes) {
				if (outcome?.feedback) feedback.push(outcome.feedback);
			}
			if (feedback.length === 0) return result;

			const text = feedback.join('\n');
			reportHook({
				toolCallId: call.toolCallId,
				tool: call.tool,
				event: 'PostToolUse',
				outcome: 'feedback',
				text,
			});
			return withContext(result, `PostToolUse hook feedback:\n${text}`);
		},
	};
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
	const skippedOf = ({ matcher }: MatcherGroup) => notIntercepted(matcher);
	const skipped = allGroups.flatMap(skippedOf);
	if (skipped.length > 0) {
		const list = [...new Set(skipped)].join(', ');
		warn(`[fluex] Claude hooks on tools fluex does not intercept never run: ${list}`);
	}
	return groups;
}

/** Claude Code tools fluex has no Flue tool for, to test regex matchers against; `mcp__*` tools aside. */
const OTHER_CLAUDE_TOOLS = ['Agent', 'Task', 'Skill', 'NotebookEdit', 'MultiEdit', 'WebFetch', 'WebSearch', 'TodoWrite', 'LS', 'ExitPlanMode'];

/** The tools `matcher` targets that fluex does not intercept, as `matcher` (tool) or the name itself. */
function notIntercepted(matcher: string | undefined): string[] {
	if (!matcher || matcher === '*') return [];
	const intercepted = Object.values(CLAUDE_TOOL);
	if (NAME_LIST.test(matcher)) {
		const names = toolNames(matcher);
		return names.filter((name) => !intercepted.includes(name));
	}
	const regex = new RegExp(matcher);
	// A regex matching every intercepted tool (`.*`) is a catch-all, like `*`.
	const matchesName = (name: string) => regex.test(name);
	if (intercepted.every(matchesName)) return [];
	const candidates = [...OTHER_CLAUDE_TOOLS, 'mcp__server__tool'];
	const hits = candidates.filter(matchesName);
	return hits.map((name) => `${matcher} (${name})`);
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

/**
 * Claude Code's matcher rules: `*` or empty matches every tool; a plain matcher is an exact name,
 * or names separated by `|` or `,`; anything else is an unanchored regex.
 */
function matches(matcher: string | undefined, name: string): boolean {
	if (!matcher || matcher === '*') return true;
	if (!NAME_LIST.test(matcher)) return new RegExp(matcher).test(name);
	return toolNames(matcher).includes(name);
}

/** The tool names of a plain matcher, separated by `|` or `,`. */
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

/**
 * A hook's `updatedInput`, in Claude's shape, back to the Flue tool's: the inverse of {@link claudeInput}.
 * Only the fields given are returned, so they are merged over the call's own input.
 */
function flueInput(tool: string, updated: Record<string, unknown>): Record<string, unknown> {
	const renames: Record<string, Record<string, string>> = {
		read: { file_path: 'path' },
		write: { file_path: 'path' },
		edit: { file_path: 'path', old_string: 'oldText', new_string: 'newText', replace_all: 'replaceAll' },
	};
	const names = renames[tool] ?? {};
	const input: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(updated)) {
		input[names[key] ?? key] = value;
	}
	// Claude's Bash `timeout` is in milliseconds, Flue's in seconds.
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
): Promise<HookOutcome | undefined> {
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

/** What one script asks of the call: block it, add context before it runs, or feed back after it ran. */
interface HookOutcome {
	block?: string;
	context?: string;
	/** In Claude's `tool_input` shape. */
	updatedInput?: Record<string, unknown>;
	feedback?: string;
}

/** A script's exit-0 stdout JSON, as far as fluex reads it. */
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

/**
 * Exit-0 JSON output: `decision: "block"` and `hookSpecificOutput.permissionDecision: "deny"` block;
 * `hookSpecificOutput.additionalContext` is context (pre) or feedback (post); pre `updatedInput` rewrites the input.
 */
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
		const outcome: HookOutcome = {};
		if (specific?.additionalContext) outcome.context = specific.additionalContext;
		const updated = specific?.updatedInput;
		const isObject = typeof updated === 'object' && updated !== null && !Array.isArray(updated);
		if (isObject) outcome.updatedInput = updated;
		return outcome;
	}
	const feedback = [out.decision === 'block' ? out.reason : undefined, specific?.additionalContext].filter(Boolean).join('\n');
	return feedback ? { feedback } : undefined;
}
