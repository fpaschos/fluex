// Compile-time contract for the Flue 2.2.2 / pi-ai 0.87.1 surface fluex depends on.
// If an upgrade renames or reshapes any of these, `pnpm typecheck` fails here first.
import type { Provider } from '@earendil-works/pi-ai';
import {
	sandboxFromDriver,
	SandboxDiedError,
	setProvider,
	useModel,
	useSandbox,
	type SandboxDriver,
	type SandboxFactory,
} from '@flue/runtime';
import { local, start } from '@flue/runtime/node';
import { piSubscriptionProvider } from '../src/index.ts';
import { describe, expectTypeOf, it } from 'vitest';

describe('Flue contract', () => {
	it('accepts a pi subscription provider in setProvider and start({ providers })', () => {
		expectTypeOf(piSubscriptionProvider).returns.toEqualTypeOf<Provider>();
		expectTypeOf(setProvider).parameter(0).toExtend<Provider>();
		expectTypeOf<Parameters<typeof start>[0]>().toHaveProperty('providers');
	});

	it('exposes the sandbox seams fluex adapters implement', () => {
		expectTypeOf<SandboxFactory>().toHaveProperty('createSandbox');
		expectTypeOf<keyof SandboxDriver>().toEqualTypeOf<
			'readFile' | 'readFileBuffer' | 'writeFile' | 'stat' | 'readdir' | 'exists' | 'mkdir' | 'rm' | 'exec'
		>();
		expectTypeOf(sandboxFromDriver).toBeFunction();
		// Not a message string: adapters report which operation found the sandbox gone, and why.
		expectTypeOf(SandboxDiedError).toBeConstructibleWith({ operation: 'exec', reason: 'stopped' });
		expectTypeOf(useSandbox).toBeFunction();
		expectTypeOf(useModel).toBeFunction();
		expectTypeOf(local).toBeFunction();
	});
});
