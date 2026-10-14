import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '@earendil-works/pi-ai';
import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { setProvider } from '@flue/runtime';
import { authFileApiKeyAuth } from './auth-file.ts';

export { PiAuthError } from './auth-file.ts';

/** The pi CLI's credential file. */
export const DEFAULT_PI_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json');

/** Each subscription provider, and how to close what it keeps open between requests. */
const SUBSCRIPTION_PROVIDERS = {
	'openai-codex': {
		create: openaiCodexProvider,
		// Caches each session's WebSocket for 5 minutes after the last request, on an idle timer.
		close: () => closeOpenAICodexWebSocketSessions(),
	},
} as const satisfies Record<string, { create: () => Provider; close: () => void }>;

export type PiSubscriptionProviderId = keyof typeof SUBSCRIPTION_PROVIDERS;

export interface PiSubscriptionOptions {
	/** Defaults to `~/.pi/agent/auth.json`. */
	authPath?: string;
}

/**
 * A pi-ai built-in provider that authenticates with the OAuth subscription the pi CLI
 * stored in `auth.json`. Scripts use {@link piSubscription}, which also closes it.
 *
 * Flue's runtime `Models` has no credential store, so the built-in OAuth path never
 * resolves; this swaps the provider's auth for an `apiKey` resolver backed by the file.
 * Model catalog and streaming are the built-in provider's own.
 */
export function piSubscriptionProvider(id: PiSubscriptionProviderId, options: PiSubscriptionOptions = {}): Provider {
	const base: Provider = SUBSCRIPTION_PROVIDERS[id].create();
	const oauth = base.auth.oauth;
	if (!oauth) throw new Error(`[fluex] pi-ai provider "${id}" has no OAuth flow`);
	return {
		...base,
		name: `${base.name} (pi subscription)`,
		auth: { apiKey: authFileApiKeyAuth({ providerId: id, authPath: options.authPath ?? DEFAULT_PI_AUTH_PATH, oauth }) },
	};
}

/** A pi subscription provider that closes what it keeps open when disposed. */
export interface PiSubscription extends AsyncDisposable {
	/** Register it for one runtime: `start({ providers: [subscription.provider] })`. */
	readonly provider: Provider;
}

/**
 * The pi subscription for `id`, for scripts that boot Flue with `start()`. Dispose it after the
 * runtime stops, or the provider's open connections keep the process alive:
 *
 * ```ts
 * await using codex = piSubscription('openai-codex');
 * await using flue = await start({ agents, providers: [codex.provider] }); // disposed first
 * ```
 */
export function piSubscription(id: PiSubscriptionProviderId, options?: PiSubscriptionOptions): PiSubscription {
	return {
		provider: piSubscriptionProvider(id, options),
		async [Symbol.asyncDispose]() {
			SUBSCRIPTION_PROVIDERS[id].close();
		},
	};
}

/** The ids {@link usePiSubscription} has registered in this process. */
const registered = new Set<PiSubscriptionProviderId>();

/**
 * Register {@link piSubscriptionProvider} with the process-wide Flue registry, once per id and
 * process: later calls do nothing (their `options` are ignored), so an agent function may call it
 * on every render. Not a Flue hook despite the name. For `flue run`, which loads only the agent
 * module and ends the process itself; scripts pass {@link piSubscription} to `start()` instead.
 */
export function usePiSubscription(id: PiSubscriptionProviderId, options?: PiSubscriptionOptions): void {
	if (registered.has(id)) return;
	setProvider(piSubscriptionProvider(id, options));
	registered.add(id);
}
