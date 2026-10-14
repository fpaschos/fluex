import { type FlueObservation, observe, useAgentFinish, usePersistentState } from '@flue/runtime';

/**
 * Successful `activate_skill` calls per agent instance, collected from live tool events.
 * `useAgentFinish` only reports tool names, never arguments, so the skill name has to
 * come from `observe()`.
 */
export class SkillActivations {
	private readonly pending = new Map<string, { instanceId: string; skill: string }>();
	private readonly activated = new Map<string, Set<string>>();

	record(event: FlueObservation): void {
		if (event.toolCallId === undefined || event.instanceId === undefined) return;
		if (event.type === 'tool_start' && event.toolName === 'activate_skill') {
			const skill = (event.args as { name?: unknown } | undefined)?.name;
			if (typeof skill === 'string') this.pending.set(event.toolCallId, { instanceId: event.instanceId, skill });
		} else if (event.type === 'tool') {
			const call = this.pending.get(event.toolCallId);
			if (!call) return;
			this.pending.delete(event.toolCallId);
			if (event.isError) return;
			const skills = this.activated.get(call.instanceId) ?? new Set<string>();
			this.activated.set(call.instanceId, skills.add(call.skill));
		}
	}

	/** Skills activated by an instance since the last take, then forgets them. */
	take(instanceId: string): string[] {
		const skills = [...(this.activated.get(instanceId) ?? [])];
		this.activated.delete(instanceId);
		return skills;
	}
}

// One process-wide observer, registered at module load (renders must stay pure reads).
const activations = new SkillActivations();
observe((event) => activations.record(event));

/**
 * Fail the response unless every named skill has been activated in this conversation.
 *
 * Checks the skill **name** passed to `activate_skill`, which `useAgentFinish` alone cannot
 * see. Activations are persisted on the instance, so a continued conversation (`--id`, a
 * new process) still counts skills activated earlier. `id` is the agent's instance id (its
 * `AgentProps`): Flue's finish hook does not carry it.
 */
export function useRequiredSkills(id: string, ...names: string[]): void {
	const [, setActivated] = usePersistentState<string[]>('fluex.activatedSkills', []);
	useAgentFinish(() => {
		const live = activations.take(id);
		let all: string[] = [];
		setActivated((previous) => (all = [...new Set([...previous, ...live])].sort()));
		const missing = names.filter((name) => !all.includes(name));
		if (missing.length > 0) {
			throw new Error(`[fluex] required skills not activated: ${missing.join(', ')}`);
		}
	});
}
