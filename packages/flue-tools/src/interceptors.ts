import {
	createBashTool,
	createEditTool,
	createGlobTool,
	createGrepTool,
	createReadTool,
	createWriteTool,
	type Sandbox,
	type SandboxFactory,
	type SandboxToolFactory,
	type ToolDefinition,
} from '@flue/runtime';

/** pi-agent-core's `AgentTool`, which `@flue/runtime` does not re-export. */
type AgentTool = ReturnType<SandboxToolFactory>[number];

/** What the model reads back from a tool: text `content`, plus `details` for observers. */
export type ToolResult = Awaited<ReturnType<AgentTool['execute']>>;

/** One model-issued tool call, as an interceptor sees it. */
export interface ToolCall {
	/** The Flue tool name (`read`, `write`, `edit`, `bash`, `grep`, `glob`, or a `useTool` name). */
	tool: string;
	toolCallId: string;
	input: Record<string, unknown>;
	/** The sandbox the tool runs against; set for sandbox tools, not for `ToolDefinition`s. */
	sandbox?: Sandbox;
	/**
	 * The object `createSandbox()` returned: one per submission, the same for every tool call of it.
	 * Set for sandbox tools, not for `ToolDefinition`s.
	 */
	session?: object;
	signal?: AbortSignal;
}

/** Continue with `input`, or the call's own input when omitted. */
export type Next = (input?: Record<string, unknown>) => Promise<ToolResult>;

/** Middleware around a tool call. Code before `next()` runs before the tool; code after it sees the result. */
export interface ToolInterceptor {
	/** Flue tool names this interceptor applies to; omitted = every intercepted tool. */
	tools?: string[];
	intercept(call: ToolCall, next: Next): Promise<ToolResult>;
}

/** The error a blocked call throws: pi-agent-core turns it into the tool error the model reads. */
export class ToolBlockedError extends Error {
	override readonly name = 'ToolBlockedError';
	readonly code = 'FLUEX_TOOL_BLOCKED';
}

/** Stop the call without running the tool; `reason` is the tool error the model sees. */
export function blocked(reason: string): never {
	throw new ToolBlockedError(reason);
}

/** What fluex adds to `result.details`, under `fluex`, for observers. */
export interface FluexDetails {
	/** Texts appended by {@link withContext}, in order. */
	context?: string[];
}

/** Append `text` to the result the model reads, and record it in `result.details.fluex.context`. */
export function withContext(result: ToolResult, text: string): ToolResult {
	const details = (result.details ?? {}) as { fluex?: FluexDetails };
	const context = [...(details.fluex?.context ?? []), text];
	const fluex = { ...details.fluex, context };
	const content = [...result.content, { type: 'text' as const, text: `\n\n${text}` }];
	return { ...result, content, details: { ...details, fluex } };
}

/** Flue's default sandbox tool set — what the runtime installs when a factory has no `tools`. */
const defaultTools: SandboxToolFactory = (sandbox) => [
	createReadTool(sandbox),
	createWriteTool(sandbox),
	createEditTool(sandbox),
	createBashTool(sandbox),
	createGrepTool(sandbox),
	createGlobTool(sandbox),
];

/**
 * Run every call of a tool through `interceptors`, in argument order; returns the same kind of value.
 *
 * - A `SandboxFactory` (`useSandbox`): every tool of its `tools` slot, or Flue's default six when it has
 *   none, has `execute` wrapped. Framework tools (`task`, `activate_skill`) are not sandbox tools and are
 *   not intercepted. Interceptors get the object `createSandbox()` returned as `call.session`; build the
 *   factory in the agent body, so each submission has its own.
 * - A `ToolDefinition` (`useTool`): the definition, spread, with `run` wrapped. A rewritten input is not
 *   re-validated against the tool's `input` schema. {@link withContext} reaches the model only for a tool
 *   with string (or no) output: Flue validates structured output, so the context is dropped with a warning.
 */
export function withInterceptors(factory: SandboxFactory, ...interceptors: ToolInterceptor[]): SandboxFactory;
export function withInterceptors<T extends ToolDefinition<any, any, any, any>>(tool: T, ...interceptors: ToolInterceptor[]): T;
export function withInterceptors(target: SandboxFactory | ToolDefinition<any, any, any, any>, ...interceptors: ToolInterceptor[]) {
	return 'run' in target ? interceptDefinition(target, interceptors) : interceptFactory(target, interceptors);
}

function interceptFactory(factory: SandboxFactory, interceptors: ToolInterceptor[]): SandboxFactory {
	const baseTools = factory.tools ?? defaultTools;
	// Flue passes `tools()` an object derived from the sandbox (cwd, skill overlays), a new one per
	// turn: the factory value is the only link back to the object `createSandbox()` returned.
	let session: object | undefined;

	async function createSandbox(options: { id: string }): Promise<Sandbox> {
		const sandbox = await factory.createSandbox(options);
		session = sandbox;
		return sandbox;
	}

	const tools: SandboxToolFactory = (sandbox, options) => {
		const original = baseTools(sandbox, options);
		return original.map((tool) => interceptTool(tool, sandbox, session, interceptors));
	};

	return { ...factory, createSandbox, tools };
}

function interceptTool(tool: AgentTool, sandbox: Sandbox, session: object | undefined, interceptors: ToolInterceptor[]): AgentTool {
	const matching = applicable(interceptors, tool.name);
	if (matching.length === 0) return tool;

	return {
		...tool,
		execute(toolCallId, params, signal, onUpdate) {
			const call: ToolCall = {
				tool: tool.name,
				toolCallId,
				input: params as Record<string, unknown>,
				sandbox,
				session,
				signal,
			};
			// What the last interceptor's `next(input)` does: run the real tool.
			const runTool: RunTool = (input) => tool.execute(toolCallId, input as never, signal, onUpdate);
			return chain(matching, call, runTool);
		},
	};
}

/** The interceptors whose `tools` include `tool`, or that have none. */
function applicable(interceptors: ToolInterceptor[], tool: string): ToolInterceptor[] {
	return interceptors.filter((interceptor) => {
		if (!interceptor.tools) return true;
		return interceptor.tools.includes(tool);
	});
}

type RunTool = (input: Record<string, unknown>) => Promise<ToolResult>;

/** Run `call` through `interceptors` in order; when none are left, `runTool` runs the real tool. */
function chain(interceptors: ToolInterceptor[], call: ToolCall, runTool: RunTool): Promise<ToolResult> {
	const [first, ...rest] = interceptors;
	if (!first) return runTool(call.input);

	// `next` continues with the remaining interceptors, using the given input or the current one.
	const next: Next = (input = call.input) => {
		const nextCall = { ...call, input };
		return chain(rest, nextCall, runTool);
	};
	return first.intercept(call, next);
}

type RunReturn = string | { output?: unknown; terminate?: boolean } | void;

function interceptDefinition<T extends ToolDefinition<any, any, any, any>>(tool: T, interceptors: ToolInterceptor[]): T {
	const matching = applicable(interceptors, tool.name);
	if (matching.length === 0) return tool;

	return {
		...tool,
		async run(context: Parameters<T['run']>[0]) {
			const data = (context as { data?: Record<string, unknown> }).data;
			const call: ToolCall = {
				tool: tool.name,
				toolCallId: context.toolCallId,
				input: data ?? {},
				signal: context.signal,
			};

			// What the last interceptor's `next(input)` does: run the original `run`, as a ToolResult.
			const runTool: RunTool = async (input) => {
				const raw: RunReturn = await tool.run({ ...context, data: input });
				return toolResult(raw);
			};

			const result = await chain(matching, call, runTool);
			// Flue reads a bare string as `{ output }`, so returning an envelope is the same even when unchanged.
			return runReturn(tool.name, result);
		},
	};
}

/** A `run` return as the model sees it: Flue serializes `output` as JSON. */
function toolResult(raw: RunReturn): ToolResult {
	let output: unknown;
	let terminate = false;
	if (typeof raw === 'string') {
		output = raw;
	} else if (raw) {
		output = raw.output;
		terminate = raw.terminate === true;
	}

	const text = output === undefined ? 'null' : JSON.stringify(output);
	const details = terminate ? { output, terminate } : { output };
	return { content: [{ type: 'text', text }], details };
}

/** Back to a `run` return: the result's `output`, with any context appended. */
function runReturn(toolName: string, result: ToolResult): RunReturn {
	const details = (result.details ?? {}) as { output?: unknown; terminate?: boolean; fluex?: FluexDetails };
	const envelope = (output: unknown) => (details.terminate ? { output, terminate: true } : { output });

	// A result an interceptor built itself has no `details.output`: its text is the output.
	let output: unknown;
	if ('output' in details) {
		output = details.output;
	} else {
		const texts = result.content.map((part) => (part.type === 'text' ? part.text : ''));
		output = texts.join('');
	}

	const context = details.fluex?.context ?? [];
	if (context.length === 0) return envelope(output);

	if (output === undefined) return envelope(context.join('\n\n'));
	if (typeof output === 'string') return envelope([output, ...context].join('\n\n'));

	console.warn(`[fluex] context dropped for tool "${toolName}": it has structured output`);
	return envelope(output);
}
