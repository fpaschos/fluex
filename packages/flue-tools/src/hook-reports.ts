/** What a tool hook did to one call — reported by {@link claudeHooks}, shown by `logToolCalls`. */
export interface HookReport {
	toolCallId: string;
	tool: string;
	event: 'PreToolUse' | 'PostToolUse';
	outcome: 'blocked' | 'feedback';
	text: string;
}

const listeners = new Set<(report: HookReport) => void>();

/** Subscribe to hook reports (process-wide). Returns an unsubscribe function. */
export function onHookReport(listener: (report: HookReport) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function reportHook(report: HookReport): void {
	for (const listener of listeners) listener(report);
}

/** One hook script run by {@link claudeHooks}, whatever its outcome — shown by `logToolCalls`. */
export interface HookRun {
	toolCallId: string;
	tool: string;
	event: 'PreToolUse' | 'PostToolUse';
	command: string;
	exitCode: number;
	durationMs: number;
}

const runListeners = new Set<(run: HookRun) => void>();

/** Subscribe to hook script runs (process-wide). Returns an unsubscribe function. */
export function onHookRun(listener: (run: HookRun) => void): () => void {
	runListeners.add(listener);
	return () => runListeners.delete(listener);
}

export function reportHookRun(run: HookRun): void {
	for (const listener of runListeners) listener(run);
}
