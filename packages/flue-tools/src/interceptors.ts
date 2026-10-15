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
	const fluex = { ...details.fluex, context: [...(details.fluex?.context ?? []), text] };
	return { ...result, content: [...result.content, { type: 'text', text: `\n\n${text}` }], details: { ...details, fluex } };
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
	const base = factory.tools ?? defaultTools;
	// Flue passes `tools()` an object derived from the sandbox (cwd, skill overlays), a new one per
	// turn: the factory value is the only link back to the object `createSandbox()` returned.
	let session: object | undefined;
	return {
		...factory,
		async createSandbox(options) {
			const sandbox = await factory.createSandbox(options);
			session = sandbox;
			return sandbox;
		},
		tools: (sandbox, options) => base(sandbox, options).map((tool) => interceptTool(tool, sandbox, session, interceptors)),
	};
}

function interceptTool(tool: AgentTool, sandbox: Sandbox, session: object | undefined, interceptors: ToolInterceptor[]): AgentTool {
	const matching = applicable(interceptors, tool.name);
	if (matching.length === 0) return tool;
	return {
		...tool,
		execute(toolCallId, params, signal, onUpdate) {
			const call: ToolCall = { tool: tool.name, toolCallId, input: params as Record<string, unknown>, sandbox, session, signal };
			return chain(matching, call, (input) => tool.execute(toolCallId, input as never, signal, onUpdate));
		},
	};
}

/** The interceptors whose `tools` include `tool`, or that have none. */
function applicable(interceptors: ToolInterceptor[], tool: string): ToolInterceptor[] {
	return interceptors.filter(({ tools }) => !tools || tools.includes(tool));
}

/** Run `call` through `interceptors` in order; the last `next` runs the tool. */
function chain(interceptors: ToolInterceptor[], call: ToolCall, run: (input: Record<string, unknown>) => Promise<ToolResult>): Promise<ToolResult> {
	const [first, ...rest] = interceptors;
	if (!first) return run(call.input);
	return first.intercept(call, (input = call.input) => chain(rest, { ...call, input }, run));
}

type RunReturn = string | { output?: unknown; terminate?: boolean } | void;

function interceptDefinition<T extends ToolDefinition<any, any, any, any>>(tool: T, interceptors: ToolInterceptor[]): T {
	const matching = applicable(interceptors, tool.name);
	if (matching.length === 0) return tool;
	return {
		...tool,
		async run(context: Parameters<T['run']>[0]) {
			const call: ToolCall = { tool: tool.name, toolCallId: context.toolCallId, input: (context as { data?: Record<string, unknown> }).data ?? {}, signal: context.signal };
			// Flue reads a bare string as `{ output }`, so the result goes back as an envelope even when unchanged.
			return runReturn(tool.name, await chain(matching, call, async (input) => toolResult(await tool.run({ ...context, data: input }))));
		},
	};
}

/** A `run` return as the model sees it: Flue serializes `output` as JSON. */
function toolResult(raw: RunReturn): ToolResult {
	const { output, terminate } = typeof raw === 'string' ? { output: raw } : (raw ?? {});
	return {
		content: [{ type: 'text', text: output === undefined ? 'null' : JSON.stringify(output) }],
		details: { output, ...(terminate ? { terminate } : {}) },
	};
}

/** Back to a `run` return: the result's `output`, with any context appended. */
function runReturn(toolName: string, result: ToolResult): RunReturn {
	const details = (result.details ?? {}) as { output?: unknown; terminate?: boolean; fluex?: FluexDetails };
	const output = 'output' in details ? details.output : result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
	const context = details.fluex?.context ?? [];
	const terminate = details.terminate ? { terminate: true } : {};
	if (context.length === 0) return { output, ...terminate };
	if (output === undefined || typeof output === 'string') return { output: [output, ...context].filter((t) => t !== undefined).join('\n\n'), ...terminate };
	console.warn(`[fluex] context dropped for tool "${toolName}": it has structured output`);
	return { output, ...terminate };
}
