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
} from '@flue/runtime';
import { reportHook } from './hook-reports.ts';

/** pi-agent-core's `AgentTool`, which `@flue/runtime` does not re-export. */
type AgentTool = ReturnType<SandboxToolFactory>[number];
type AgentToolResult = Awaited<ReturnType<AgentTool['execute']>>;

/** One model-issued call of a sandbox tool (`read`, `write`, `edit`, `bash`, `grep`, `glob`). */
export interface ToolCall {
	tool: string;
	toolCallId: string;
	input: Record<string, unknown>;
	sandbox: Sandbox;
	signal?: AbortSignal;
}

/** Runs before the tool. Return `{ block }` to stop it: the reason becomes the tool error the model sees. */
export type PreToolHook = (call: ToolCall) => Promise<{ block: string } | void>;

/** Runs after a successful call. Return `{ feedback }` to append text to the result the model sees. */
export type PostToolHook = (call: ToolCall & { result: AgentToolResult }) => Promise<{ feedback: string } | void>;

export interface ToolHooks {
	pre?: PreToolHook[];
	post?: PostToolHook[];
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
 * Wrap a sandbox factory so every sandbox tool call passes through `hooks`.
 *
 * Uses Flue's documented `SandboxFactory.tools` slot ("Sandbox-provided tools"): the
 * factory's own tools, or Flue's default six, with `execute` wrapped. Framework tools
 * (`task`, `activate_skill`) and `useTool` tools are not sandbox tools and are not hooked.
 */
export function withToolHooks(factory: SandboxFactory, hooks: ToolHooks): SandboxFactory {
	const base = factory.tools ?? defaultTools;
	return {
		...factory,
		tools: (sandbox, options) => base(sandbox, options).map((tool) => hookTool(tool, sandbox, hooks)),
	};
}

function hookTool(tool: AgentTool, sandbox: Sandbox, { pre = [], post = [] }: ToolHooks): AgentTool {
	if (pre.length === 0 && post.length === 0) return tool;
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate) {
			const call: ToolCall = { tool: tool.name, toolCallId, input: params as Record<string, unknown>, sandbox, signal };
			const blocks = (await Promise.all(pre.map((hook) => hook(call)))).flatMap((r) => (r ? [r.block] : []));
			// pi-agent-core: tools throw on failure; the message is the tool error the model reads.
			if (blocks.length > 0) {
				const text = blocks.join('\n');
				reportHook({ toolCallId, tool: tool.name, event: 'PreToolUse', outcome: 'blocked', text });
				throw new Error(`Blocked by PreToolUse hook:\n${text}`);
			}

			const result = await tool.execute(toolCallId, params, signal, onUpdate);
			const feedback = (await Promise.all(post.map((hook) => hook({ ...call, result })))).flatMap((r) => (r ? [r.feedback] : []));
			if (feedback.length === 0) return result;
			reportHook({ toolCallId, tool: tool.name, event: 'PostToolUse', outcome: 'feedback', text: feedback.join('\n') });
			return { ...result, content: [...result.content, { type: 'text', text: `\n\nPostToolUse hook feedback:\n${feedback.join('\n')}` }] };
		},
	};
}
