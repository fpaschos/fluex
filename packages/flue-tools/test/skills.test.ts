import type { FlueObservation } from '@flue/runtime';
import { describe, expect, it } from 'vitest';
import { SkillActivations } from '../src/skills.ts';

const start = (instanceId: string, toolCallId: string, toolName: string, args: unknown) =>
	({ type: 'tool_start', instanceId, toolCallId, toolName, args }) as unknown as FlueObservation;
const end = (instanceId: string, toolCallId: string, toolName: string, isError = false) =>
	({ type: 'tool', instanceId, toolCallId, toolName, isError, durationMs: 1 }) as unknown as FlueObservation;

describe('SkillActivations', () => {
	it('records a skill by name once its activate_skill call succeeds', () => {
		const log = new SkillActivations();
		log.record(start('a', 't1', 'activate_skill', { name: 'ast-grep' }));
		expect(log.take('a')).toEqual([]);
		log.record(end('a', 't1', 'activate_skill'));
		expect(log.take('a')).toEqual(['ast-grep']);
		expect(log.take('a')).toEqual([]);
	});

	it('ignores failed activations and other tools', () => {
		const log = new SkillActivations();
		log.record(start('a', 't1', 'activate_skill', { name: 'jira' }));
		log.record(end('a', 't1', 'activate_skill', true));
		log.record(start('a', 't2', 'bash', { command: 'ls' }));
		log.record(end('a', 't2', 'bash'));
		expect(log.take('a')).toEqual([]);
	});

	it('keeps concurrent instances apart', () => {
		const log = new SkillActivations();
		log.record(start('a', 't1', 'activate_skill', { name: 'ast-grep' }));
		log.record(start('b', 't2', 'activate_skill', { name: 'commit' }));
		log.record(end('b', 't2', 'activate_skill'));
		log.record(end('a', 't1', 'activate_skill'));
		expect(log.take('a')).toEqual(['ast-grep']);
		expect(log.take('b')).toEqual(['commit']);
	});
});
