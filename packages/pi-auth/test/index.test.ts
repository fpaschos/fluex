import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { hasProvider, resetModelsForTests } from '@flue/runtime/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { piSubscription, piSubscriptionProvider } from '../src/index.ts';

vi.mock('@earendil-works/pi-ai/api/openai-codex-responses', async (importOriginal) => ({
	...(await importOriginal<object>()),
	closeOpenAICodexWebSocketSessions: vi.fn(),
}));

afterEach(() => {
	resetModelsForTests();
	vi.mocked(closeOpenAICodexWebSocketSessions).mockClear();
});

describe('piSubscriptionProvider', () => {
	it('keeps the built-in catalog and streaming but authenticates only through auth.json', () => {
		const builtin = openaiCodexProvider();
		const provider = piSubscriptionProvider('openai-codex', { authPath: '/nonexistent/auth.json' });

		expect(provider.id).toBe('openai-codex');
		expect(provider.baseUrl).toBe(builtin.baseUrl);
		expect(provider.getModels().map((m) => m.id)).toEqual(builtin.getModels().map((m) => m.id));
		expect(typeof provider.streamSimple).toBe('function');
		expect(provider.auth.oauth).toBeUndefined();
		expect(provider.auth.apiKey?.name).toMatch(/pi auth\.json/);
	});
});

describe('piSubscription', () => {
	it('carries the subscription provider without registering it', () => {
		resetModelsForTests();
		const subscription = piSubscription('openai-codex', { authPath: '/nonexistent/auth.json' });
		expect(subscription.provider.id).toBe('openai-codex');
		expect(subscription.provider.auth.apiKey?.name).toMatch(/pi auth\.json/);
		expect(hasProvider('openai-codex')).toBe(false);
	});

	it('closes the cached codex WebSockets when disposed', async () => {
		{
			await using _subscription = piSubscription('openai-codex', { authPath: '/nonexistent/auth.json' });
			expect(closeOpenAICodexWebSocketSessions).not.toHaveBeenCalled();
		}
		expect(closeOpenAICodexWebSocketSessions).toHaveBeenCalledOnce();
	});
});

describe('usePiSubscription', () => {
	// A fresh module per test: the ids it registered live in module state.
	const load = async () => {
		vi.resetModules();
		const runtime = await import('@flue/runtime/internal');
		const { usePiSubscription } = await import('../src/index.ts');
		runtime.resetModelsForTests();
		return { usePiSubscription, hasProvider: runtime.hasProvider };
	};

	it('registers the provider with the Flue runtime', async () => {
		const { usePiSubscription, hasProvider } = await load();
		expect(hasProvider('openai-codex')).toBe(false);
		usePiSubscription('openai-codex', { authPath: '/nonexistent/auth.json' });
		expect(hasProvider('openai-codex')).toBe(true);
	});

	it('registers each id once per process', async () => {
		const { usePiSubscription, hasProvider } = await load();
		usePiSubscription('openai-codex', { authPath: '/nonexistent/auth.json' });
		const runtime = await import('@flue/runtime/internal');
		runtime.resetModelsForTests();
		usePiSubscription('openai-codex', { authPath: '/nonexistent/auth.json' });
		expect(hasProvider('openai-codex')).toBe(false);
	});
});
