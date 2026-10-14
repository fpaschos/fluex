import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authFileApiKeyAuth, PiAuthError } from '../src/auth-file.ts';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const ctx = { env: async () => undefined, fileExists: async () => false };
const signal = new AbortController().signal;

function credential(access: string, expires: number): OAuthCredential {
	return { type: 'oauth', access, refresh: `refresh-${access}`, expires, accountId: 'acct' };
}

function fakeOAuth(refreshed = credential('fresh', NOW + HOUR)) {
	return {
		name: 'Fake OAuth',
		login: vi.fn(),
		refresh: vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return refreshed;
		}),
		toAuth: vi.fn(async (c: OAuthCredential) => ({ apiKey: c.access })),
	} satisfies OAuthAuth;
}

let dir: string;
let authPath: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'fluex-pi-auth-'));
	authPath = join(dir, 'auth.json');
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeAuth(data: unknown) {
	await writeFile(authPath, JSON.stringify(data), { mode: 0o600 });
}

function resolver(oauth: OAuthAuth) {
	return authFileApiKeyAuth({ providerId: 'openai-codex', authPath, oauth, now: () => NOW });
}

describe('authFileApiKeyAuth', () => {
	it('uses a valid stored credential without refreshing or writing', async () => {
		await writeAuth({ 'openai-codex': credential('valid', NOW + HOUR) });
		const before = await readFile(authPath, 'utf8');
		const oauth = fakeOAuth();

		const result = await resolver(oauth).resolve({ ctx, signal });

		expect(result?.auth).toEqual({ apiKey: 'valid' });
		expect(oauth.refresh).not.toHaveBeenCalled();
		expect(await readFile(authPath, 'utf8')).toBe(before);
	});

	it('refreshes an expiring credential and writes it back with mode 0600, keeping other entries', async () => {
		const other = { type: 'api_key', key: 'other-key' };
		await writeAuth({ anthropic: other, 'openai-codex': credential('stale', NOW + 60_000) });
		const oauth = fakeOAuth();

		const result = await resolver(oauth).resolve({ ctx, signal });

		expect(result?.auth).toEqual({ apiKey: 'fresh' });
		expect(oauth.refresh).toHaveBeenCalledTimes(1);
		const saved = JSON.parse(await readFile(authPath, 'utf8'));
		expect(saved).toEqual({ anthropic: other, 'openai-codex': credential('fresh', NOW + HOUR) });
		expect((await stat(authPath)).mode & 0o777).toBe(0o600);
	});

	it('refreshes once when concurrent requests find the same expired credential', async () => {
		await writeAuth({ 'openai-codex': credential('stale', NOW - 1) });
		const oauth = fakeOAuth();
		const auth = resolver(oauth);

		const results = await Promise.all([1, 2, 3].map(() => auth.resolve({ ctx, signal })));

		expect(results.map((r) => r?.auth.apiKey)).toEqual(['fresh', 'fresh', 'fresh']);
		expect(oauth.refresh).toHaveBeenCalledTimes(1);
	});

	it('leaves the file untouched when refresh fails', async () => {
		await writeAuth({ 'openai-codex': credential('stale', NOW - 1) });
		const before = await readFile(authPath, 'utf8');
		const oauth = fakeOAuth();
		oauth.refresh.mockRejectedValueOnce(new Error('invalid_grant'));

		await expect(resolver(oauth).resolve({ ctx, signal })).rejects.toThrow('invalid_grant');
		expect(await readFile(authPath, 'utf8')).toBe(before);
	});

	it('tells the user to log in with pi when the file is missing', async () => {
		await expect(resolver(fakeOAuth()).resolve({ ctx, signal })).rejects.toThrow(/not found.*\/login/);
	});

	it('tells the user to log in with pi when the provider entry is missing', async () => {
		await writeAuth({ anthropic: { type: 'api_key', key: 'k' } });
		const error = await resolver(fakeOAuth())
			.resolve({ ctx, signal })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PiAuthError);
		expect(String(error)).toMatch(/openai-codex.*\/login/);
	});

	it('does not echo file contents for malformed JSON', async () => {
		await writeFile(authPath, '{"openai-codex": {"access": "secret-token"');
		const error = await resolver(fakeOAuth())
			.resolve({ ctx, signal })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PiAuthError);
		expect(String(error)).not.toContain('secret-token');
	});

	it('check() reports availability without refreshing', async () => {
		const oauth = fakeOAuth();
		expect(await resolver(oauth).check?.({ ctx, signal })).toBeUndefined();
		await writeAuth({ 'openai-codex': credential('stale', NOW - 1) });
		expect(await resolver(oauth).check?.({ ctx, signal })).toEqual({ type: 'oauth', source: authPath });
		expect(oauth.refresh).not.toHaveBeenCalled();
	});
});
