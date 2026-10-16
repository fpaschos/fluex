import { fauxAssistantMessage, type FauxResponseFactory, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { init, useModel } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { readStructuredResult, useStructuredResult } from '../src/structured-result.ts';

const Pick = v.object({ issue: v.number() });

/** Run an agent with `useStructuredResult('pick', Pick)` over a scripted model; its reply. */
async function replyOf(responses: FauxResponseFactory[]) {
	const faux = fauxProvider({ provider: 'faux', models: [{ id: 'model' }] });
	faux.setResponses(responses);

	function picker() {
		useModel('faux/model');
		useStructuredResult('pick', Pick);
		return 'Pick an issue.';
	}

	const flue = await start({ agents: [picker], providers: [faux.provider] });
	try {
		const agent = init(picker, { id: 'picker' });
		const receipt = await agent.dispatch({ message: 'go' });
		const reply = await agent.read(receipt);
		return reply;
	} finally {
		await flue.stop();
	}
}

/** The model's `structured_result` call with `{ issue: 7 }`. */
function submission() {
	const call = fauxToolCall('structured_result', { issue: 7 });
	return fauxAssistantMessage(call);
}
const submit: FauxResponseFactory = () => submission();

describe('useStructuredResult', () => {
	it('hands the submitted result to the caller', async () => {
		const reply = await replyOf([submit]);
		const pick = readStructuredResult('pick', reply, Pick);
		expect(pick).toEqual({ issue: 7 });
	});

	it('sends a run that ends with text only back to submit', async () => {
		let nudge = '';
		const textOnly: FauxResponseFactory = () => fauxAssistantMessage('Pick: 7');
		const submitAfterNudge: FauxResponseFactory = (context) => {
			nudge = JSON.stringify(context.messages.at(-1));
			return submission();
		};
		const reply = await replyOf([textOnly, submitAfterNudge]);
		const pick = readStructuredResult('pick', reply, Pick);
		expect(nudge).toContain('You have not called `structured_result`');
		expect(pick).toEqual({ issue: 7 });
	});
});
