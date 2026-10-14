import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { type Sandbox, SandboxDiedError } from '@flue/runtime';
import { expect, it } from 'vitest';
import { type DockerCli, docker, dockerCli } from '../src/index.ts';
import { describeIntegration, removeTestContainersAfterAll, TEST_IMAGE, TEST_USER, tempWorkspace, testKey } from './support/integration.ts';

/** Command lines of the container's processes matching `pattern` (the image has no `ps`, so read `/proc`). */
async function processes(sandbox: Sandbox, pattern: string): Promise<string[]> {
	const listing = await sandbox.exec(
		`for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < "$f" 2>/dev/null; echo; done | grep -e "$PATTERN" || true`,
		{ env: { PATTERN: pattern } },
	);
	return listing.stdout.split('\n').filter(Boolean);
}

/** Ids of the containers labelled with `key`. */
async function containersOf(key: string): Promise<string[]> {
	const listed = await dockerCli(['ps', '--all', '--quiet', '--filter', `label=fluex.sandbox=${key}`]);
	return new TextDecoder().decode(listed.stdout).split('\n').filter(Boolean);
}

describeIntegration('docker() against real Docker', () => {
	removeTestContainersAfterAll();

	it('runs a command in /workspace, writing through to the host workspace', async () => {
		const workspace = await tempWorkspace();
		const sandbox = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace }).createSandbox({ id: testKey('exec') });

		const result = await sandbox.exec('pwd && echo hi > f && cat f');

		expect(result).toEqual({ stdout: '/workspace\nhi\n', stderr: '', exitCode: 0 });
		expect(existsSync(join(workspace, 'f'))).toBe(true);
	});

	it('honours cwd and per-call env', async () => {
		const workspace = await tempWorkspace();
		const sandbox = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace }).createSandbox({ id: testKey('cwd-env') });
		await sandbox.exec('mkdir -p sub');

		const result = await sandbox.exec('echo "$(pwd) $GREETING"', { cwd: 'sub', env: { GREETING: 'hello there' } });

		expect(result.stdout).toBe('/workspace/sub hello there\n');
	});

	it('timeoutMs stops the command inside the container and returns exit code 124', async () => {
		const sandbox = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace: await tempWorkspace() }).createSandbox({ id: testKey('timeout') });

		const started = Date.now();
		const result = await sandbox.exec('echo started; sleep 60', { timeoutMs: 1000 });

		expect(result.exitCode).toBe(124);
		expect(result.stdout).toBe('started\n');
		expect(Date.now() - started).toBeLessThan(7000);
		expect(await processes(sandbox, '^sleep 60')).toEqual([]);
	});

	it('a command that ignores TERM is killed 5 s after its timeout', async () => {
		const sandbox = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace: await tempWorkspace() }).createSandbox({ id: testKey('ignores-term') });

		const started = Date.now();
		await sandbox.exec('trap "" TERM; sleep 60', { timeoutMs: 1000 });

		expect(Date.now() - started).toBeGreaterThan(5000);
		expect(Date.now() - started).toBeLessThan(9000);
		expect(await processes(sandbox, '^sleep 60')).toEqual([]);
	}, 15_000);

	it('aborting mid-command stops it inside the container', async () => {
		const sandbox = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace: await tempWorkspace() }).createSandbox({ id: testKey('abort') });
		const controller = new AbortController();

		const result = sandbox.exec('sleep 60', { signal: controller.signal });
		await expect.poll(() => processes(sandbox, '^sleep 60'), { timeout: 5000 }).toHaveLength(1);
		controller.abort();

		await expect(result).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
		await expect.poll(() => processes(sandbox, '^sleep 60'), { timeout: 7000 }).toEqual([]);
	});

	it('refuses an image that runs as root, leaving no container, unless user is a non-root user', async () => {
		const key = testKey('root');
		const workspace = await tempWorkspace();

		await expect(docker({ image: TEST_IMAGE, workspace }).createSandbox({ id: key })).rejects.toThrow(/runs as root \(uid 0\)/);
		expect(await containersOf(key)).toEqual([]);
		await expect(docker({ image: TEST_IMAGE, workspace, user: '0:0' }).createSandbox({ id: key })).rejects.toThrow(/runs as root/);

		const sandbox = await docker({ image: TEST_IMAGE, workspace, user: TEST_USER }).createSandbox({ id: key });
		expect((await sandbox.exec('id -u')).stdout).not.toBe('0\n');
	});

	it('runs with no effective capabilities', async () => {
		const sandbox = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace: await tempWorkspace() }).createSandbox({ id: testKey('caps') });

		const status = await sandbox.exec('grep -E "^(CapEff|CapPrm|NoNewPrivs):" /proc/self/status');

		expect(status.stdout).toBe('CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\n');
	});

	it('gives the container exactly its env, values intact, without disturbing the docker client', async () => {
		const sandbox = await docker({
			image: TEST_IMAGE,
			user: TEST_USER,
			workspace: await tempWorkspace(),
			env: { GREETING: ' a b=c ', PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' },
		}).createSandbox({ id: testKey('env') });

		const result = await sandbox.exec('printf "%s|%s|%s|%s" "$GREETING" "$PATH" "$HOME" "$CALL"', { env: { CALL: 'x=1 ' } });

		expect(result.stdout).toBe(' a b=c |/usr/local/bin:/usr/bin:/bin|/tmp|x=1 ');
		expect((await sandbox.exec('printenv USER LOGNAME SHELL || true')).stdout).toBe('');
	});

	it('mounts extra host paths read-only unless readonly: false', async () => {
		const host = await tempWorkspace();
		await mkdir(join(host, 'ro'));
		await mkdir(join(host, 'rw'));
		const sandbox = await docker({
			image: TEST_IMAGE,
			user: TEST_USER,
			workspace: await tempWorkspace(),
			mounts: [
				{ host: join(host, 'ro'), container: '/mnt/ro' },
				{ host: join(host, 'rw'), container: '/mnt/rw', readonly: false },
			],
		}).createSandbox({ id: testKey('mounts') });

		expect((await sandbox.exec('touch /mnt/ro/f')).stderr).toMatch(/Read-only file system/);
		expect((await sandbox.exec('touch /mnt/rw/f')).exitCode).toBe(0);
		expect(existsSync(join(host, 'rw', 'f'))).toBe(true);
	});

	it('a container killed mid-command fails the command with SandboxDiedError', async () => {
		const key = testKey('killed');
		const sandbox = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace: await tempWorkspace() }).createSandbox({ id: key });

		const result = sandbox.exec('sleep 60');
		await expect.poll(() => processes(sandbox, '^sleep 60'), { timeout: 5000 }).toHaveLength(1);
		await dockerCli(['kill', `fluex-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`]);

		await expect(result).rejects.toBeInstanceOf(SandboxDiedError);
		const again = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace: await tempWorkspace() }).createSandbox({ id: key });
		expect((await again.exec('echo back')).stdout).toBe('back\n');
	});

	it('concurrent creates with one key end with one container, within a process and across factories that do not share a queue', async () => {
		const key = testKey('concurrent');
		const workspace = await tempWorkspace();
		// A distinct `DockerCli` has its own in-process queue, so its factory races the others as another process would.
		const otherProcess: DockerCli = (args, options) => dockerCli(args, options);
		const factories = [docker({ image: TEST_IMAGE, user: TEST_USER, workspace }), docker({ image: TEST_IMAGE, user: TEST_USER, workspace }, otherProcess)];

		const sandboxes = await Promise.all([0, 1, 0, 1, 0].map((i) => factories[i]!.createSandbox({ id: key })));

		expect(await containersOf(key)).toHaveLength(1);
		for (const sandbox of sandboxes) expect((await sandbox.exec('hostname')).exitCode).toBe(0);
	});

	it('instances with different ids and the same key share one container', async () => {
		const workspace = await tempWorkspace();
		const key = () => testKey('shared-key');
		const implementer = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace, key }).createSandbox({ id: 'implementer' });
		await implementer.exec('echo warm > /tmp/marker');

		const reviewer = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace, key }).createSandbox({ id: 'reviewer' });

		expect((await reviewer.exec('cat /tmp/marker')).stdout).toBe('warm\n');
		expect(await containersOf(testKey('shared-key'))).toHaveLength(1);
	});

	it('reuses a container with an unchanged spec and recreates it when a mount or env key changes, naming the fields', async () => {
		const key = testKey('respec');
		const workspace = await tempWorkspace();
		const cache = await tempWorkspace();
		const warnings: string[] = [];
		const create = (options: { env?: Record<string, string>; mounts?: { host: string; container: string }[] }) =>
			docker({ image: TEST_IMAGE, user: TEST_USER, workspace, warn: (m) => warnings.push(m), ...options }).createSandbox({ id: key });

		await (await create({ env: { A: '1' } })).exec('echo kept > /tmp/marker');
		expect((await (await create({ env: { A: 'another value' } })).exec('cat /tmp/marker')).stdout).toBe('kept\n');
		const [first] = await containersOf(key);

		const remounted = await create({ env: { A: '1', B: '2' }, mounts: [{ host: cache, container: '/cache' }] });

		expect((await remounted.exec('cat /tmp/marker')).exitCode).not.toBe(0);
		expect(await containersOf(key)).not.toContain(first);
		expect(warnings).toEqual([expect.stringMatching(/^\[fluex\] sandbox .*: recreating container fluex-\w+, its spec changed: mounts, env$/)]);
	});

	it('starts a stopped container instead of replacing it, and it passes the user check', async () => {
		const key = testKey('stopped');
		const workspace = await tempWorkspace();
		const sandbox = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace }).createSandbox({ id: key });
		await sandbox.exec('echo kept > /tmp/marker');
		const [container] = await containersOf(key);
		await dockerCli(['stop', '--time', '0', container!]);

		const restarted = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace }).createSandbox({ id: key });

		expect((await restarted.exec('cat /tmp/marker')).stdout).toBe('kept\n');
		expect(await containersOf(key)).toEqual([container]);
	});
});
