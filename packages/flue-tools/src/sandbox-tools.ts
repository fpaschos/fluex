import {
	createBashTool,
	createEditTool,
	createGlobTool,
	createGrepTool,
	createReadTool,
	createWriteTool,
	type SandboxFactory,
	type SandboxToolFactory,
} from '@flue/runtime';

/** Flue's default sandbox tool set — what the runtime installs when a factory has no `tools`. */
const defaultTools: SandboxToolFactory = (sandbox) => [
	createReadTool(sandbox),
	createWriteTool(sandbox),
	createEditTool(sandbox),
	createBashTool(sandbox),
	createGrepTool(sandbox),
	createGlobTool(sandbox),
];

/** The sandbox tools a factory offers: its `tools` slot, or Flue's default six when it has none. */
export function sandboxToolsOf(factory: SandboxFactory): SandboxToolFactory {
	return factory.tools ?? defaultTools;
}
