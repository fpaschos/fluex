import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { buildImage, docker, dockerCli, listSandboxes, pruneSandboxes, removeSandbox } from '../src/index.ts';
import { describeIntegration, isTestKey, removeTestContainersAfterAll, TEST_IMAGE, TEST_USER, tempWorkspace, testKey } from './support/integration.ts';

const output = (result: { stdout: Uint8Array }) => new TextDecoder().decode(result.stdout).trim();

/** Ids of the containers labelled with `key`. */
async function containersOf(key: string): Promise<string[]> {
	return output(await dockerCli(['ps', '--all', '--quiet', '--filter', `label=fluex.sandbox=${key}`])).split('\n').filter(Boolean);
}

/** A build context holding `Dockerfile` and the given files. */
async function buildContext(dockerfile: string, files: Record<string, string> = {}): Promise<string> {
	const context = await realpath(await mkdtemp(join(tmpdir(), 'fluex-build-')));
	await writeFile(join(context, 'Dockerfile'), dockerfile);
	for (const [name, content] of Object.entries(files)) await writeFile(join(context, name), content);
	return context;
}

describeIntegration('buildImage and the cleanup API against real Docker', () => {
	removeTestContainersAfterAll();
	const tags: string[] = [];
	/** An image tag unique to this test run; the image is removed after the suite. */
	const testTag = (name: string) => {
		const tag = `${testKey(name)}:latest`;
		tags.push(tag);
		return tag;
	};
	afterAll(async () => {
		// After the containers using them are gone (afterAll hooks run in reverse order).
		await dockerCli(['image', 'rm', '--force', ...tags]);
	});

	it('returns the same id for an unchanged build and a new one for a changed context, which recreates the container', async () => {
		const context = await buildContext(`FROM ${TEST_IMAGE}\nCOPY marker /marker\n`, { marker: 'one\n' });
		const build = () => buildImage({ dockerfile: join(context, 'Dockerfile'), context, tag: testTag('build') });
		const key = testKey('rebuilt');
		const warnings: string[] = [];
		const create = async (image: string) =>
			docker({ image, user: TEST_USER, workspace: await tempWorkspace(), warn: (m) => warnings.push(m) }).createSandbox({ id: key });

		const first = await build();
		expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(await build()).toBe(first);
		expect((await (await create(first)).exec('cat /marker')).stdout).toBe('one\n');
		const [before] = await containersOf(key);

		await writeFile(join(context, 'marker'), 'two\n');
		const second = await build();

		expect(second).not.toBe(first);
		expect((await (await create(testTag('build'))).exec('cat /marker')).stdout).toBe('two\n');
		expect(await containersOf(key)).not.toContain(before);
		expect(warnings.at(-1)).toMatch(/its spec changed: image/);
	});

	it('runs a sandbox from an image whose entrypoint exits immediately', async () => {
		const context = await buildContext(`FROM ${TEST_IMAGE}\nENTRYPOINT ["true"]\nCMD ["exit"]\n`);
		const image = await buildImage({ dockerfile: join(context, 'Dockerfile'), context, tag: testTag('entrypoint') });

		const sandbox = await docker({ image, user: TEST_USER, workspace: await tempWorkspace() }).createSandbox({ id: testKey('entrypoint') });

		expect((await sandbox.exec('echo alive')).stdout).toBe('alive\n');
	});

	it('removeSandbox removes the container of its key and resolves for an unknown key', async () => {
		const key = testKey('removed');
		await docker({ image: TEST_IMAGE, user: TEST_USER, workspace: await tempWorkspace() }).createSandbox({ id: key });
		expect(await containersOf(key)).toHaveLength(1);

		await removeSandbox(key);

		expect(await containersOf(key)).toEqual([]);
		await expect(removeSandbox(testKey('never-created'))).resolves.toBeUndefined();
	});

	it('lists and prunes fluex containers only, leaving a non-fluex container with a similar name untouched', async () => {
		const key = testKey('pruned');
		await docker({ image: TEST_IMAGE, user: TEST_USER, workspace: await tempWorkspace() }).createSandbox({ id: key });
		const lookalike = `fluex-${testKey('lookalike')}`;
		const run = await dockerCli(['run', '--detach', '--name', lookalike, '--label', 'fluex.other=1', TEST_IMAGE, 'sleep', 'infinity']);
		expect(run.exitCode).toBe(0);
		try {
			const listed = await listSandboxes();
			expect(listed.filter((sandbox) => isTestKey(sandbox.key)).map((sandbox) => sandbox.key)).toContain(key);
			expect(listed.map((sandbox) => sandbox.name)).not.toContain(lookalike);
			const seen: string[] = [];

			const pruned = await pruneSandboxes({ key: (k) => (seen.push(k), isTestKey(k)) });

			expect(pruned.map((sandbox) => sandbox.key)).toContain(key);
			expect(seen).not.toContain(lookalike);
			expect(await containersOf(key)).toEqual([]);
			expect(output(await dockerCli(['inspect', '--format', '{{.State.Status}}', lookalike]))).toBe('running');
		} finally {
			await dockerCli(['rm', '--force', lookalike]);
		}
	});
});
