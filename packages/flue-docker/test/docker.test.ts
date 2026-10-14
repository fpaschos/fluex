import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Sandbox, SandboxDiedError } from '@flue/runtime';
import type { DockerCallOptions, DockerCli, DockerResult } from '../src/docker-cli.ts';
import { docker } from '../src/docker.ts';
import { buildImage } from '../src/image.ts';
import { listSandboxes, pruneSandboxes, removeSandbox } from '../src/cleanup.ts';
import type { DockerOptions, Mount } from '../src/spec.ts';

const encoder = new TextEncoder();
const reply = (stdout = '', exitCode = 0, stderr = ''): DockerResult => ({
	stdout: encoder.encode(stdout),
	stderr,
	exitCode,
});

interface FakeContainer {
	id: string;
	name: string;
	state: string;
	labels: Record<string, string>;
	image?: string;
	created?: string;
}

/**
 * A scripted `docker`: records every call and answers like a daemon holding `containers` (by name), whose user has id
 * `uid`. It has image `img:1` (id `sha256:img1`) locally; `docker pull` makes any other image local.
 */
function fakeDocker(
	execReply: (args: string[]) => DockerResult | Promise<DockerResult> = () => reply('out\n'),
	inspectReply: () => DockerResult = () => reply('true\n'),
	initialUid = '1000',
) {
	let uid = initialUid;
	let created = 0;
	const calls: ({ args: string[] } & DockerCallOptions)[] = [];
	const containers = new Map<string, FakeContainer>();
	const images = new Map([['img:1', 'sha256:img1']]);
	const byId = (args: string[]) => [...containers.values()].find((container) => args.includes(container.id));
	const cli: DockerCli = async (args, options) => {
		calls.push({ args, ...options });
		const [command, subcommand] = args;
		if (command === 'image' && subcommand === 'inspect') {
			const id = images.get(args.at(-1)!);
			return id ? reply(JSON.stringify([{ Id: id }])) : reply('[]', 1, `Error response from daemon: No such image: ${args.at(-1)}`);
		}
		if (command === 'pull') {
			images.set(args.at(-1)!, `sha256:pulled-${args.at(-1)}`);
			return reply();
		}
		if (command === 'ps') {
			// Docker's `label=<name>` filter matches any value, `label=<name>=<value>` only that value.
			const [, name, value] = /^label=([^=]+)(?:=(.*))?$/s.exec(args[args.indexOf('--filter') + 1] ?? '')!;
			const found = [...containers.values()].filter(
				(container) => container.labels[name!] !== undefined && (value === undefined || container.labels[name!] === value),
			);
			return reply(found.map((container) => `${JSON.stringify({ ID: container.id, Names: container.name })}\n`).join(''));
		}
		if (command === 'inspect' && !args.includes('--format')) {
			const found = [...containers.values()].filter((container) => args.includes(container.id));
			if (found.length === 0) return reply('[]', 1, `Error: No such object: ${args.at(-1)}`);
			return reply(
				JSON.stringify(
					found.map((container) => ({
						Id: container.id,
						Name: `/${container.name}`,
						Created: container.created,
						State: { Status: container.state },
						Config: { Image: container.image, Labels: container.labels, Env: ['TOKEN=s3cret'] },
					})),
				),
			);
		}
		if (command === 'run') {
			const name = args[args.indexOf('--name') + 1]!;
			if (containers.has(name)) {
				return reply('', 125, `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${containers.get(name)!.id}". You have to remove (or rename) that container to be able to reuse that name.`);
			}
			const labels = Object.fromEntries(
				args.flatMap((arg, i) => (args[i - 1] === '--label' ? [arg.split(/=(.*)/s).slice(0, 2) as [string, string]] : [])),
			);
			const id = `ctr${++created}`;
			containers.set(name, { id, name, state: 'running', labels, image: args.at(-2)!, created: '2026-10-14T00:00:00.000000000Z' });
			return reply(`${id}\n`);
		}
		if (command === 'start' || command === 'unpause') {
			byId(args)!.state = 'running';
			return reply(`${args.at(-1)}\n`);
		}
		if (command === 'exec' && args.slice(-2).join(' ') === 'id -u') return reply(`${uid}\n`);
		if (command === 'exec') return execReply(args);
		if (command === 'rm') {
			for (const container of [...containers.values()].filter((container) => args.includes(container.id))) containers.delete(container.name);
			return reply();
		}
		if (command === 'build') {
			const tag = args[args.indexOf('--tag') + 1]!;
			images.set(tag, `sha256:${'b'.repeat(64)}`);
			return reply(`sha256:${'b'.repeat(64)}\n`);
		}
		if (command === 'inspect') return inspectReply();
		throw new Error(`unexpected docker ${command}`);
	};
	const runs = () => calls.filter((call) => call.args[0] === 'run');
	/** `docker exec` calls for the sandbox's work, without the user check on creation. */
	const execs = () => calls.filter((call) => call.args[0] === 'exec' && call.args.slice(-2).join(' ') !== 'id -u');
	/** Makes the containers' user `id` from now on, as if their image changed under them. */
	const setUid = (id: string) => {
		uid = id;
	};
	/** The one container labelled with `key`. */
	const containerOf = (key: string) => [...containers.values()].find((container) => container.labels['fluex.sandbox'] === key)!;
	return { cli, calls, runs, execs, setUid, containers, images, containerOf };
}

/** A fresh, empty host directory. */
const hostDir = (name = 'dir') => {
	const dir = join(mkdtempSync(join(tmpdir(), 'fluex-docker-unit-')), name);
	mkdirSync(dir);
	return dir;
};

const repo = hostDir('repo');

const nameFor = (key: string) => `fluex-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;

describe('docker()', () => {
	it('creates the container for a new key with --init, its label, its name and the workspace mount', async () => {
		const fake = fakeDocker();
		await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

		expect(fake.runs()).toHaveLength(1);
		const args = fake.runs()[0]!.args;
		expect(args).toContain('--init');
		expect(args.slice(args.indexOf('--label'), args.indexOf('--label') + 2)).toEqual(['--label', 'fluex.sandbox=conv-a']);
		expect(args.slice(args.indexOf('--name'), args.indexOf('--name') + 2)).toEqual(['--name', nameFor('conv-a')]);
		expect(args.slice(args.indexOf('--mount'), args.indexOf('--mount') + 2)).toEqual([
			'--mount',
			`type=bind,"source=${repo}","target=/workspace"`,
		]);
		expect(args.slice(-2)).toEqual(['sha256:img1', 'infinity']);
	});

	it("runs sleep as the entrypoint, whatever the image's own entrypoint", async () => {
		const fake = fakeDocker();
		await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

		const args = fake.runs()[0]!.args;
		expect(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 2)).toEqual(['--entrypoint', 'sleep']);
		expect(args.slice(-2)).toEqual(['sha256:img1', 'infinity']);
	});

	it('mounts a workspace whose path contains mount separators intact', async () => {
		const fake = fakeDocker();
		const workspace = hostDir('a:b,"c"');
		await docker({ image: 'img:1', workspace }, fake.cli).createSandbox({ id: 'conv-a' });

		const args = fake.runs()[0]!.args;
		expect(args[args.indexOf('--mount') + 1]).toBe(`type=bind,"source=${workspace.replace('"c"', '""c""')}","target=/workspace"`);
	});

	it.each([
		['/', '/', /host path is \/ /],
		['the home directory', homedir(), /host path is the home directory/],
		['missing', '/no/such/fluex/workspace', /host path does not exist/],
	])('rejects a workspace that is %s, naming it', (_case, workspace, reason) => {
		expect(() => docker({ image: 'img:1', workspace }, fakeDocker().cli)).toThrow(reason);
		expect(() => docker({ image: 'img:1', workspace }, fakeDocker().cli)).toThrow(`[fluex] workspace ${workspace}: `);
	});

	it('accepts a workspace when the home directory does not exist', () => {
		vi.stubEnv('HOME', '/no/such/fluex/home');
		try {
			expect(() => docker({ image: 'img:1', workspace: repo }, fakeDocker().cli)).not.toThrow();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	describe('mounts', () => {
		const mountsOf = (args: string[]) => args.flatMap((arg, i) => (args[i - 1] === '--mount' ? [arg] : [])).slice(1);

		it('binds each extra mount read-only unless it says readonly: false', async () => {
			const gradle = hostDir('gradle');
			const cache = hostDir('cache, "x"');
			const fake = fakeDocker();
			await docker(
				{
					image: 'img:1',
					workspace: repo,
					mounts: [
						{ host: gradle, container: '/home/agent/.gradle' },
						{ host: cache, container: '/cache', readonly: false },
					],
				},
				fake.cli,
			).createSandbox({ id: 'conv-a' });

			expect(mountsOf(fake.runs()[0]!.args)).toEqual([
				`type=bind,"source=${gradle}","target=/home/agent/.gradle",readonly`,
				`type=bind,"source=${cache.replace('"x"', '""x""')}","target=/cache"`,
			]);
		});

		describe('rejects', () => {
			let socket: string;
			let server: Server;
			beforeAll(async () => {
				socket = join(hostDir('sock'), 's');
				server = createServer();
				await new Promise<void>((resolve) => server.listen(socket, resolve));
			});
			afterAll(() => server.close());

			const linkTo = (target: string) => {
				const link = join(hostDir(), 'link');
				symlinkSync(target, link);
				return link;
			};

			it.each<[string, () => Mount[], RegExp]>([
				['a relative host path', () => [{ host: 'cache', container: '/cache' }], /host path must be absolute/],
				['a missing host path', () => [{ host: join(hostDir(), 'missing'), container: '/cache' }], /host path does not exist/],
				['/', () => [{ host: '/', container: '/cache' }], /host path is \/ /],
				['/ through a symlink', () => [{ host: linkTo('/'), container: '/cache' }], /host path is \/ /],
				['the home directory', () => [{ host: homedir(), container: '/cache' }], /host path is the home directory/],
				['a parent of the home directory', () => [{ host: dirname(homedir()), container: '/cache' }], /host path contains the home directory/],
				['/var/run, holding the Docker socket', () => [{ host: '/var/run', container: '/cache' }], /host path contains the Docker socket/],
				['/var, above the Docker socket', () => [{ host: '/var', container: '/cache' }], /host path contains the Docker socket/],
				['a *.sock path', () => [{ host: hostDir('docker.sock'), container: '/cache' }], /host path is a socket/],
				['a socket', () => [{ host: socket, container: '/cache' }], /host path is a socket/],
				['a device', () => [{ host: '/dev/null', container: '/cache' }], /host path is a device/],
				['a relative container path', () => [{ host: hostDir(), container: 'cache' }], /container path must be absolute/],
				['/workspace', () => [{ host: hostDir(), container: '/workspace' }], /container path overlaps \/workspace/],
				['a path under /workspace', () => [{ host: hostDir(), container: '/workspace/../workspace/x' }], /container path overlaps \/workspace/],
				['/, above /workspace', () => [{ host: hostDir(), container: '/' }], /container path overlaps \/workspace/],
				['a duplicate container path', () => [{ host: hostDir(), container: '/cache' }, { host: hostDir(), container: '/cache/' }], /container path is mounted twice/],
			])('%s, naming the mount', (_case, mounts, reason) => {
				const all = mounts();
				const named = all.at(-1)!;
				expect(() => docker({ image: 'img:1', workspace: repo, mounts: all }, fakeDocker().cli)).toThrow(reason);
				expect(() => docker({ image: 'img:1', workspace: repo, mounts: all }, fakeDocker().cli)).toThrow(
					`[fluex] mount ${named.host} -> ${named.container}: `,
				);
			});
		});
	});

	describe('env', () => {
		const leaks = (call: { args: string[] } & DockerCallOptions) =>
			call.args.some((arg) => arg.includes('s3cret')) || call.args.includes('-e');

		it('gives the container only the env it is told, by file, never in argv', async () => {
			const fake = fakeDocker();
			await docker({ image: 'img:1', workspace: repo, env: { GITLAB_TOKEN: 's3cret', PATH: '/opt/bin' } }, fake.cli).createSandbox({
				id: 'conv-a',
			});

			const run = fake.runs()[0]!;
			expect(run.envFile).toEqual({ GITLAB_TOKEN: 's3cret', PATH: '/opt/bin' });
			expect(leaks(run)).toBe(false);
		});

		it('passes no env file to a container without env', async () => {
			const fake = fakeDocker();
			await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			expect(fake.runs()[0]!.envFile).toBeUndefined();
		});

		it('redacts every env value from the error of a failing docker call', async () => {
			const fake = fakeDocker();
			const cli: DockerCli = async (args, options) =>
				args[0] === 'run' ? reply('', 125, 'docker: bad value "s3cret" (also 0p3n)\n') : fake.cli(args, options);
			const factory = docker({ image: 'img:1', workspace: repo, env: { TOKEN: 's3cret', OTHER: '0p3n', EMPTY: '' } }, cli);

			const error = (await factory.createSandbox({ id: 'conv-a' }).catch((caught: unknown) => caught)) as Error;

			expect(error.message).toBe('[fluex] docker run failed (exit 125): docker: bad value "***" (also ***)');
		});

		it("passes a command's per-call env by file, never in argv", async () => {
			const fake = fakeDocker();
			const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });
			await sandbox.exec('make', { env: { TOKEN: 's3cret' } });

			const exec = fake.calls.find((call) => call.args.at(-1) === 'make')!;
			expect(exec.envFile).toEqual({ TOKEN: 's3cret' });
			expect(leaks(exec)).toBe(false);
		});
	});

	describe('security', () => {
		it('refuses an image that runs as root, removing the container it created', async () => {
			const fake = fakeDocker(undefined, undefined, '0');

			await expect(docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' })).rejects.toThrow(
				'[fluex] image img:1 runs as root (uid 0); set `user` to a non-root user',
			);
			expect(fake.calls.at(-1)!.args).toEqual(['rm', '--force', 'ctr1']);
		});

		it('refuses a container it finds that runs as root, removing it', async () => {
			const fake = fakeDocker();
			const factory = docker({ image: 'img:1', workspace: repo }, fake.cli);
			await factory.createSandbox({ id: 'conv-a' });
			fake.setUid('0');

			await expect(factory.createSandbox({ id: 'conv-a' })).rejects.toThrow(/runs as root/);
			expect(fake.calls.at(-1)!.args).toEqual(['rm', '--force', 'ctr1']);
		});

		it('refuses and removes a container whose user cannot be checked', async () => {
			const fake = fakeDocker();
			const cli: DockerCli = async (args, options) =>
				args.slice(-2).join(' ') === 'id -u' ? reply('', 127, 'exec: "id": executable file not found') : fake.cli(args, options);

			await expect(docker({ image: 'img:1', workspace: repo }, cli).createSandbox({ id: 'conv-a' })).rejects.toThrow(
				'[fluex] could not check the user of image img:1 (exit 127): exec: "id": executable file not found',
			);
			expect(fake.calls.at(-1)!.args).toEqual(['rm', '--force', 'ctr1']);
		});

		it('keeps the default of a resource passed as undefined', async () => {
			const fake = fakeDocker();
			await docker({ image: 'img:1', workspace: repo, resources: { memory: undefined, cpus: 2 } }, fake.cli).createSandbox({ id: 'conv-a' });

			const args = fake.runs()[0]!.args;
			expect(args.slice(args.indexOf('--memory'), args.indexOf('--memory') + 4)).toEqual(['--memory', '6g', '--cpus', '2']);
		});

		it('checks the user of a container it creates, under the operation timeout', async () => {
			const fake = fakeDocker();
			await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			const check = fake.calls.find((call) => call.args.at(-1) === '-u')!;
			expect(check.args).toEqual(['exec', 'ctr1', 'id', '-u']);
			expect(check.timeoutMs).toBeUndefined();
		});

		/** The value following `flag` in the `docker run` argv, or `undefined`. */
		const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

		it('drops every capability, forbids new privileges and limits memory, CPUs, PIDs and the network by default', async () => {
			const fake = fakeDocker();
			await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			const args = fake.runs()[0]!.args;
			expect(flag(args, '--cap-drop')).toBe('ALL');
			expect(flag(args, '--security-opt')).toBe('no-new-privileges');
			expect(flag(args, '--memory')).toBe('6g');
			expect(flag(args, '--cpus')).toBe('6');
			expect(flag(args, '--pids-limit')).toBe('1024');
			expect(flag(args, '--network')).toBe('bridge');
			expect(args).not.toContain('--user');
		});

		it.each([
			['user', { user: '1000:1000' }, ['--user', '1000:1000']],
			['memory', { resources: { memory: '12g' } }, ['--memory', '12g']],
			['cpus', { resources: { cpus: 2.5 } }, ['--cpus', '2.5']],
			['pids', { resources: { pids: 4096 } }, ['--pids-limit', '4096']],
			['network', { network: 'none' }, ['--network', 'none']],
		])('an override of %s changes only its own flag', async (_name, override, [name, value]) => {
			// Labels carry the creation time and the spec hash, which an override changes too.
			const withoutLabels = (args: string[]) => args.filter((arg, i) => arg !== '--label' && args[i - 1] !== '--label');
			const defaults = fakeDocker();
			await docker({ image: 'img:1', workspace: repo }, defaults.cli).createSandbox({ id: 'conv-a' });
			const overridden = fakeDocker();
			await docker({ image: 'img:1', workspace: repo, ...override }, overridden.cli).createSandbox({ id: 'conv-a' });

			const expected = withoutLabels(defaults.runs()[0]!.args);
			if (expected.includes(name!)) expected[expected.indexOf(name!) + 1] = value!;
			else expected.splice(expected.indexOf('sha256:img1'), 0, name!, value!);
			expect(withoutLabels(overridden.runs()[0]!.args)).toEqual(expected);
		});
	});

	it('finds the container of a known key by its label instead of running another', async () => {
		const fake = fakeDocker();
		const factory = docker({ image: 'img:1', workspace: repo }, fake.cli);
		await factory.createSandbox({ id: 'conv-a' });
		const sandbox = await factory.createSandbox({ id: 'conv-a' });
		await sandbox.exec('true');

		expect(fake.runs()).toHaveLength(1);
		expect(fake.calls.at(-1)!.args).toContain('ctr1');
	});

	describe('identity and reuse', () => {
		const label = (args: string[], name: string) =>
			args.flatMap((arg, i) => (args[i - 1] === '--label' && arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []))[0];
		const quiet = { warn: () => {} };

		it('labels the container with its key, the fluex version, its creation time and its spec hash', async () => {
			const fake = fakeDocker();
			const before = Date.now();
			await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			const args = fake.runs()[0]!.args;
			expect(label(args, 'fluex.sandbox')).toBe('conv-a');
			expect(label(args, 'fluex.version')).toBe('0.0.0');
			expect(Date.parse(label(args, 'fluex.created')!)).toBeGreaterThanOrEqual(before - 1000);
			expect(label(args, 'fluex.spec')).toMatch(/^[0-9a-f]{64}$/);
		});

		it('runs the local image id, never pulling, under the operation timeout', async () => {
			const fake = fakeDocker();
			await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			const run = fake.runs()[0]!;
			expect(run.args.slice(-2)).toEqual(['sha256:img1', 'infinity']);
			expect(run.args.slice(run.args.indexOf('--pull'), run.args.indexOf('--pull') + 2)).toEqual(['--pull', 'never']);
			expect(run.timeoutMs).toBeUndefined();
		});

		it('pulls an image it lacks explicitly, without the operation timeout, before running it', async () => {
			const fake = fakeDocker();
			await docker({ image: 'other:2', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			const pull = fake.calls.find((call) => call.args[0] === 'pull')!;
			expect(pull.args).toEqual(['pull', 'other:2']);
			expect(pull.timeoutMs).toBe(Number.POSITIVE_INFINITY);
			expect(fake.runs()[0]!.args.at(-2)).toBe('sha256:pulled-other:2');
		});

		const specOf = async (options: Partial<DockerOptions>) => {
			const fake = fakeDocker();
			await docker({ image: 'img:1', workspace: repo, ...options }, fake.cli).createSandbox({ id: 'conv-a' });
			return label(fake.runs()[0]!.args, 'fluex.spec');
		};

		it('hashes the spec stably across the order of env keys and of mounts, ignoring env values', async () => {
			const [a, b] = [hostDir('a'), hostDir('b')];
			const hash = await specOf({ env: { A: '1', B: '2' }, mounts: [{ host: a, container: '/a' }, { host: b, container: '/b' }] });

			expect(await specOf({ env: { B: 'other', A: 'values' }, mounts: [{ host: b, container: '/b' }, { host: a, container: '/a' }] })).toBe(hash);
			expect(await specOf({ env: { A: '1', C: '2' }, mounts: [{ host: a, container: '/a' }, { host: b, container: '/b' }] })).not.toBe(hash);
		});

		it.each<[string, Partial<DockerOptions>]>([
			['image', { image: 'other:2' }],
			['workspace', { workspace: hostDir('elsewhere') }],
			['mounts', { mounts: [{ host: hostDir(), container: '/cache' }] }],
			['env', { env: { TOKEN: 'x' } }],
			['resources', { resources: { cpus: 2 } }],
			['network', { network: 'none' }],
			['user', { user: '1000:1000' }],
		])('changes the spec hash when %s changes', async (_field, options) => {
			expect(await specOf(options)).not.toBe(await specOf({}));
		});

		it('recreates a container whose spec changed, warning which fields differ', async () => {
			const fake = fakeDocker();
			const warnings: string[] = [];
			await docker({ image: 'img:1', workspace: repo, warn: (m) => warnings.push(m) }, fake.cli).createSandbox({ id: 'conv-a' });
			await docker({ image: 'img:1', workspace: repo, env: { TOKEN: 's3cret' }, network: 'none', warn: (m) => warnings.push(m) }, fake.cli).createSandbox({ id: 'conv-a' });

			expect(fake.runs()).toHaveLength(2);
			expect(fake.calls.map((call) => call.args.slice(0, 3).join(' '))).toContain('rm --force ctr1');
			expect(fake.containerOf('conv-a').id).toBe('ctr2');
			expect(warnings).toEqual([`[fluex] sandbox conv-a: recreating container ${nameFor('conv-a')}, its spec changed: env, network`]);
			expect(warnings.join()).not.toContain('s3cret');
		});

		it('recreates a container made before its entrypoint was part of the spec, naming the field', async () => {
			const fake = fakeDocker();
			const warnings: string[] = [];
			const factory = docker({ image: 'img:1', workspace: repo, warn: (m) => warnings.push(m) }, fake.cli);
			await factory.createSandbox({ id: 'conv-a' });
			const { labels } = fake.containerOf('conv-a');
			const { entrypoint: _, ...older } = JSON.parse(labels['fluex.spec.fields']!) as Record<string, string>;
			Object.assign(labels, { 'fluex.spec': 'older', 'fluex.spec.fields': JSON.stringify(older) });

			await factory.createSandbox({ id: 'conv-a' });

			expect(fake.runs()).toHaveLength(2);
			expect(warnings).toEqual([`[fluex] sandbox conv-a: recreating container ${nameFor('conv-a')}, its spec changed: entrypoint`]);
		});

		it('removes and recreates a container that has no spec label', async () => {
			const fake = fakeDocker();
			const warnings: string[] = [];
			const factory = docker({ image: 'img:1', workspace: repo, warn: (m) => warnings.push(m) }, fake.cli);
			await factory.createSandbox({ id: 'conv-a' });
			delete fake.containerOf('conv-a').labels['fluex.spec'];

			await factory.createSandbox({ id: 'conv-a' });

			expect(fake.runs()).toHaveLength(2);
			expect(fake.containerOf('conv-a').id).toBe('ctr2');
			expect(warnings).toEqual([`[fluex] sandbox conv-a: recreating container ${nameFor('conv-a')}, it has no spec label`]);
		});

		it.each(['created', 'exited'])('starts a %s container, then checks its user, instead of replacing it', async (state) => {
			const fake = fakeDocker();
			const factory = docker({ image: 'img:1', workspace: repo }, fake.cli);
			await factory.createSandbox({ id: 'conv-a' });
			fake.containerOf('conv-a').state = state;
			const before = fake.calls.length;

			await factory.createSandbox({ id: 'conv-a' });

			const after = fake.calls.slice(before).map((call) => call.args.join(' '));
			expect(after.filter((call) => /^(start|exec|run|rm)/.test(call))).toEqual(['start ctr1', 'exec ctr1 id -u']);
			expect(fake.containerOf('conv-a').state).toBe('running');
		});

		it.each(['dead', 'removing'])('removes and recreates a %s container', async (state) => {
			const fake = fakeDocker();
			const factory = docker({ image: 'img:1', workspace: repo }, fake.cli);
			await factory.createSandbox({ id: 'conv-a' });
			fake.containerOf('conv-a').state = state;

			await factory.createSandbox({ id: 'conv-a' });

			expect(fake.runs()).toHaveLength(2);
			expect(fake.containerOf('conv-a')).toMatchObject({ id: 'ctr2', state: 'running' });
		});

		it('unpauses a paused container instead of removing it', async () => {
			const fake = fakeDocker();
			const factory = docker({ image: 'img:1', workspace: repo }, fake.cli);
			await factory.createSandbox({ id: 'conv-a' });
			fake.containerOf('conv-a').state = 'paused';

			await factory.createSandbox({ id: 'conv-a' });

			expect(fake.calls.map((call) => call.args.join(' '))).toContain('unpause ctr1');
			expect(fake.containerOf('conv-a')).toMatchObject({ id: 'ctr1', state: 'running' });
		});

		it('removes and recreates a stopped container that fails to start', async () => {
			const fake = fakeDocker();
			const factory = docker({ image: 'img:1', workspace: repo }, fake.cli);
			await factory.createSandbox({ id: 'conv-a' });
			fake.containerOf('conv-a').state = 'created';
			const cli: DockerCli = async (args, options) =>
				args[0] === 'start' ? reply('', 1, 'Error response from daemon: error mounting') : fake.cli(args, options);

			await docker({ image: 'img:1', workspace: repo }, cli).createSandbox({ id: 'conv-a' });

			expect(fake.containerOf('conv-a')).toMatchObject({ id: 'ctr2', state: 'running' });
		});

		it('fails with the daemon error when a container it must replace cannot be removed', async () => {
			const fake = fakeDocker();
			await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });
			fake.containerOf('conv-a').state = 'dead';
			const cli: DockerCli = async (args, options) =>
				args[0] === 'rm' ? reply('', 1, 'Error response from daemon: device or resource busy') : fake.cli(args, options);

			await expect(docker({ image: 'img:1', workspace: repo }, cli).createSandbox({ id: 'conv-a' })).rejects.toThrow(
				'[fluex] docker rm failed (exit 1): Error response from daemon: device or resource busy',
			);
		});

		it('reuses the container another process created under the same name', async () => {
			const fake = fakeDocker();
			await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });
			// The other process's container appears between our lookup and our `docker run`.
			let racing = true;
			const cli: DockerCli = async (args, options) =>
				args[0] === 'ps' && racing ? ((racing = false), reply('')) : fake.cli(args, options);

			const sandbox = await docker({ image: 'img:1', workspace: repo }, cli).createSandbox({ id: 'conv-a' });
			await sandbox.exec('true');

			expect(fake.containers.size).toBe(1);
			expect(fake.calls.at(-1)!.args).toContain('ctr1');
		});

		it('creates one container for concurrent calls with one key, across factories', async () => {
			const fake = fakeDocker();
			const factories = [docker({ image: 'img:1', workspace: repo }, fake.cli), docker({ image: 'img:1', workspace: repo }, fake.cli)];

			await Promise.all([0, 1, 0, 1, 0].map((i) => factories[i]!.createSandbox({ id: 'conv-a' })));

			expect(fake.runs()).toHaveLength(1);
		});

		it('names and labels the container by the key option, not the instance id', async () => {
			const fake = fakeDocker();
			const key = () => 'ticket-65';
			await docker({ image: 'img:1', workspace: repo, key }, fake.cli).createSandbox({ id: 'implementer' });
			await docker({ image: 'img:1', workspace: repo, key }, fake.cli).createSandbox({ id: 'reviewer' });

			const args = fake.runs()[0]!.args;
			expect(fake.runs()).toHaveLength(1);
			expect(label(args, 'fluex.sandbox')).toBe('ticket-65');
			expect(args[args.indexOf('--name') + 1]).toBe(nameFor('ticket-65'));
		});

		it('passes the instance id to the key option', async () => {
			const fake = fakeDocker();
			await docker({ image: 'img:1', workspace: repo, key: (id) => `ticket-${id}` }, fake.cli).createSandbox({ id: '65' });

			expect(fake.containerOf('ticket-65')).toBeDefined();
		});

		it.each<[string, (fake: ReturnType<typeof fakeDocker>) => DockerCli]>([
			['docker inspect', (fake) => async (args, options) => (args[0] === 'inspect' ? reply('[{"Id":"ctr1","State":"running"}]') : fake.cli(args, options))],
			['docker ps', (fake) => async (args, options) => (args[0] === 'ps' ? reply('{"Names":"x"}\n') : fake.cli(args, options))],
			['docker image inspect', (fake) => async (args, options) => (args[0] === 'image' ? reply('not json') : fake.cli(args, options))],
		])('fails with an error naming %s when its output has an unexpected shape', async (call, broken) => {
			const fake = fakeDocker();
			await docker({ image: 'img:1', workspace: repo, ...quiet }, fake.cli).createSandbox({ id: 'conv-a' });

			const error = (await docker({ image: 'img:1', workspace: repo }, broken(fake))
				.createSandbox({ id: 'conv-a' })
				.catch((caught: unknown) => caught)) as Error;

			expect(error).not.toBeInstanceOf(TypeError);
			expect(error.message).toMatch(new RegExp(`^\\[fluex\\] ${call} returned unexpected output`));
		});
	});
});

describe('file operations', () => {
	const path = `/workspace/it's "a" $HOME\nmarker-7f3`;
	const operations: [string, (sandbox: Sandbox) => Promise<unknown>][] = [
		['readFile', (sandbox) => sandbox.readFile(path)],
		['readFileBuffer', (sandbox) => sandbox.readFileBuffer(path)],
		['writeFile', (sandbox) => sandbox.writeFile(path, 'content')],
		['stat', (sandbox) => sandbox.stat(path)],
		['readdir', (sandbox) => sandbox.readdir(path)],
		['exists', (sandbox) => sandbox.exists(path)],
		['mkdir', (sandbox) => sandbox.mkdir(path, { recursive: true })],
		['rm', (sandbox) => sandbox.rm(path, { recursive: true, force: true })],
	];

	it.each(operations)('%s passes the path as a positional argument, never in the script', async (_name, operation) => {
		const fake = fakeDocker(() => reply('regular file|1|0.000|0'));
		const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });
		await operation(sandbox);

		const execs = fake.execs();
		expect(execs.length).toBeGreaterThan(0);
		for (const { args } of execs) {
			expect(args.at(-1)).toBe(path);
			expect(args.slice(0, -1).some((arg) => arg.includes('marker-7f3'))).toBe(false);
		}
	});
});

describe('exec', () => {
	/** The model's command is the exec whose argv ends with it. */
	const commandCall = (fake: ReturnType<typeof fakeDocker>, command: string) =>
		fake.calls.find((call) => call.args[0] === 'exec' && call.args.at(-1) === command)!;

	it('runs the command under its timeout in seconds, or none', async () => {
		const fake = fakeDocker();
		const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });
		await sandbox.exec('make', { timeoutMs: 1500 });
		await sandbox.exec('make test');

		expect(commandCall(fake, 'make').args.slice(-2)).toEqual(['1.5', 'make']);
		expect(commandCall(fake, 'make test').args.slice(-2)).toEqual(['0', 'make test']);
	});

	it('holds stdin open and ends the docker exec client on abort, which stops the command in the container', async () => {
		const fake = fakeDocker((args) => (args.at(-1) === 'sleep 60' ? new Promise<DockerResult>(() => {}) : reply()));
		const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });
		const controller = new AbortController();

		const result = sandbox.exec('sleep 60', { signal: controller.signal });
		await vi.waitFor(() => expect(commandCall(fake, 'sleep 60')).toBeDefined());
		controller.abort();

		await expect(result).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
		const call = commandCall(fake, 'sleep 60');
		expect(call.args.slice(0, 2)).toEqual(['exec', '-i']);
		expect(call.holdStdin).toBe(true);
		expect(call.signal?.aborted).toBe(true);
	});


	describe('output caps', () => {
		const MiB64 = 67_108_864;
		const oversize = `head${'x'.repeat(MiB64)}`;

		it('keeps the last 64 MiB of stdout and of stderr behind a truncation marker', async () => {
			const fake = fakeDocker(() => reply(oversize, 0, oversize));
			const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			const result = await sandbox.exec('yes');

			for (const output of [result.stdout, result.stderr]) {
				expect(output.slice(0, 80)).toBe('[fluex] output truncated: kept the last 67108864 bytes\n' + 'x'.repeat(80 - 55));
				expect(output.length).toBe(55 + MiB64);
			}
		});

		it('leaves output of exactly 64 MiB untouched', async () => {
			const fake = fakeDocker(() => reply('x'.repeat(MiB64)));
			const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			expect((await sandbox.exec('yes')).stdout.length).toBe(MiB64);
		});

		it('asks docker to keep only the tail, so oversize output is never held in full', async () => {
			const fake = fakeDocker();
			const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });
			await sandbox.exec('yes');

			const command = fake.calls.find((call) => call.args.at(-1) === 'yes')!;
			expect(command.tailBytes).toBeGreaterThan(MiB64);
			expect(command.tailBytes).toBeLessThan(2 * MiB64);
		});
	});

	describe('a container that died', () => {
		const died = { name: 'SandboxDiedError', meta: { operation: 'exec', reason: 'stopped' } };

		it.each([
			['is not running', 'Error response from daemon: container ctr1 is not running'],
			['no longer exists', 'Error response from daemon: No such container: ctr1'],
		])('fails the command with SandboxDiedError when docker reports it %s', async (_case, stderr) => {
			const fake = fakeDocker(() => reply('', 1, stderr));
			const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			const error = await sandbox.exec('make').catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(SandboxDiedError);
			expect(error).toMatchObject(died);
		});

		it.each([
			['stopped', reply('false\n')],
			['gone', reply('', 1, 'Error: No such object: ctr1')],
		])('fails a command killed by a signal with SandboxDiedError when inspect shows the container %s', async (_case, inspected) => {
			const fake = fakeDocker(
				() => reply('', 137),
				() => inspected,
			);
			const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			await expect(sandbox.exec('make')).rejects.toMatchObject(died);
			const inspect = fake.calls.find((call) => call.args[0] === 'inspect')!;
			expect(inspect.args).toContain('ctr1');
			expect(inspect.timeoutMs).toBeUndefined(); // bookkeeping: dockerCli's operation timeout applies
		});

		it("does not mistake the command's own stderr quoting the daemon for a dead container", async () => {
			const fake = fakeDocker(() => reply('', 1, 'tool failed:\nError response from daemon: No such container: other\n'));
			const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			expect((await sandbox.exec('tool')).exitCode).toBe(1);
		});

		it('returns a signal exit code as is when inspect shows the container running', async () => {
			const fake = fakeDocker(() => reply('', 137));
			const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			expect((await sandbox.exec('make')).exitCode).toBe(137);
		});

		it('does not probe a command that exited normally', async () => {
			const fake = fakeDocker(() => reply('', 2));
			const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			expect((await sandbox.exec('make')).exitCode).toBe(2);
			expect(fake.calls.some((call) => call.args[0] === 'inspect')).toBe(false);
		});

		it('fails a file operation with SandboxDiedError when docker reports the container gone', async () => {
			const fake = fakeDocker(() => reply('', 1, 'Error response from daemon: container ctr1 is not running'));
			const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

			await expect(sandbox.readFile('a.txt')).rejects.toMatchObject({ name: 'SandboxDiedError', meta: { operation: 'readFile' } });
		});
	});


	it("exempts only the model's command from dockerCli's operation timeout", async () => {
		const fake = fakeDocker();
		const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });
		await sandbox.exec('make', { timeoutMs: 1000 });

		expect(fake.calls.map((call) => [call.args[0], call.timeoutMs])).toEqual([
			['image', undefined],
			['ps', undefined],
			['run', undefined],
			['exec', undefined],
			['exec', Number.POSITIVE_INFINITY],
		]);
	});

	it('does not start a command whose signal is already aborted', async () => {
		const fake = fakeDocker();
		const sandbox = await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' });

		await sandbox.exec('make', { signal: AbortSignal.abort() }).catch(() => {});

		expect(fake.execs()).toEqual([]);
	});
});

describe('buildImage()', () => {
	it('builds quietly from the Dockerfile and context, tags the image and returns its id', async () => {
		const fake = fakeDocker();

		const id = await buildImage({ dockerfile: '/sidecar/docker/Dockerfile', context: '/sidecar/docker', tag: 'sidecar:dev' }, fake.cli);

		expect(id).toBe(`sha256:${'b'.repeat(64)}`);
		expect(fake.calls).toEqual([
			{ args: ['build', '--quiet', '--file', '/sidecar/docker/Dockerfile', '--tag', 'sidecar:dev', '/sidecar/docker'], timeoutMs: Number.POSITIVE_INFINITY },
		]);
	});

	it('fails when the build prints no image id', async () => {
		const loadless: DockerCli = async () => reply('\n');

		await expect(buildImage({ dockerfile: 'Dockerfile', context: '.', tag: 't' }, loadless)).rejects.toThrow(
			'[fluex] docker build printed no image id',
		);
	});

	it("fails with docker's error when the build fails", async () => {
		const failing: DockerCli = async () => reply('', 1, 'ERROR: failed to solve: process "/bin/sh -c false" did not complete successfully\n');

		await expect(buildImage({ dockerfile: 'Dockerfile', context: '.', tag: 't' }, failing)).rejects.toThrow(
			'[fluex] docker build failed (exit 1): ERROR: failed to solve: process "/bin/sh -c false" did not complete successfully',
		);
	});
});

describe('removeSandbox()', () => {
	it('removes the container labelled with exactly that key', async () => {
		const fake = fakeDocker();
		await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'ticket-65' });
		await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'ticket-6' });
		const before = fake.calls.length;

		await removeSandbox('ticket-6', fake.cli);

		expect(fake.calls.slice(before).map((call) => call.args)).toEqual([
			['ps', '--all', '--filter', 'label=fluex.sandbox=ticket-6', '--format', '{{json .}}'],
			['rm', '--force', 'ctr2'],
		]);
		expect([...fake.containers.values()].map((container) => container.labels['fluex.sandbox'])).toEqual(['ticket-65']);
	});

	it('does nothing for a key without a container', async () => {
		const fake = fakeDocker();

		await removeSandbox('unknown', fake.cli);

		expect(fake.calls.map((call) => call.args[0])).toEqual(['ps']);
	});

	it('waits for a createSandbox of the same key in flight, then removes its container', async () => {
		const fake = fakeDocker();

		await Promise.all([docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'conv-a' }), removeSandbox('conv-a', fake.cli)]);

		expect(fake.containers.size).toBe(0);
	});
});

describe('listSandboxes()', () => {
	it('lists every container carrying the fluex sandbox label, and no other', async () => {
		const fake = fakeDocker();
		await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'ticket-65' });
		await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'ticket-66' });
		fake.containerOf('ticket-66').state = 'exited';
		fake.containers.set('fluex-lookalike', { id: 'other1', name: 'fluex-lookalike', state: 'running', labels: { 'com.example': 'x' } });
		for (const key of ['ticket-65', 'ticket-66']) fake.containerOf(key).labels['fluex.created'] = '2026-10-14T00:00:00.000Z';
		const before = fake.calls.length;

		const sandboxes = await listSandboxes(fake.cli);

		expect(fake.calls.slice(before).map((call) => call.args)).toEqual([
			['ps', '--all', '--filter', 'label=fluex.sandbox', '--format', '{{json .}}'],
			['inspect', '--type', 'container', 'ctr1', 'ctr2'],
		]);
		const created = new Date('2026-10-14T00:00:00Z');
		expect(sandboxes).toEqual([
			{ id: 'ctr1', key: 'ticket-65', name: nameFor('ticket-65'), state: 'running', created, image: 'sha256:img1' },
			{ id: 'ctr2', key: 'ticket-66', name: nameFor('ticket-66'), state: 'exited', created, image: 'sha256:img1' },
		]);
	});

	it('lists nothing, without inspecting, when there are no fluex containers', async () => {
		const fake = fakeDocker();

		expect(await listSandboxes(fake.cli)).toEqual([]);
		expect(fake.calls.map((call) => call.args[0])).toEqual(['ps']);
	});

	it('skips a container removed between listing and inspecting', async () => {
		const fake = fakeDocker();
		await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'ticket-65' });
		await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'ticket-66' });
		const racing: DockerCli = async (args, options) => {
			if (args[0] !== 'inspect') return fake.cli(args, options);
			const result = await fake.cli(args.filter((arg) => arg !== 'ctr1'), options);
			return { ...result, exitCode: 1, stderr: 'Error: No such object: ctr1\n' };
		};

		expect((await listSandboxes(racing)).map((sandbox) => sandbox.key)).toEqual(['ticket-66']);
	});

	it('lists nothing when every container was removed before inspecting and docker prints nothing', async () => {
		const fake = fakeDocker();
		await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'ticket-65' });
		const racing: DockerCli = async (args, options) =>
			args[0] === 'inspect' ? reply('', 1, 'Error: No such object: ctr1\n') : fake.cli(args, options);

		expect(await listSandboxes(racing)).toEqual([]);
	});

	it('reports the creation time fluex labelled the container with, not the daemon clock', async () => {
		const fake = fakeDocker();
		await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: 'ticket-65' });
		fake.containerOf('ticket-65').labels['fluex.created'] = '2026-10-01T12:00:00.000Z';

		expect((await listSandboxes(fake.cli))[0]!.created).toEqual(new Date('2026-10-01T12:00:00.000Z'));
	});
});

describe('pruneSandboxes()', () => {
	/** A daemon holding sandboxes `old` (exited, created a day ago) and `new` (running, created now), and a non-fluex container. */
	const daemon = async () => {
		const fake = fakeDocker();
		for (const key of ['old', 'new']) await docker({ image: 'img:1', workspace: repo }, fake.cli).createSandbox({ id: key });
		fake.containerOf('old').state = 'exited';
		fake.containerOf('old').labels['fluex.created'] = new Date(Date.now() - 86_400_000).toISOString();
		// The daemon's clock is a day behind: `olderThan` must not go by it.
		for (const key of ['old', 'new']) fake.containerOf(key).created = new Date(Date.now() - 2 * 86_400_000).toISOString();
		fake.containers.set('fluex-lookalike', { id: 'other1', name: 'fluex-lookalike', state: 'exited', labels: { 'com.example': 'x' } });
		return fake;
	};
	const keysLeft = (fake: ReturnType<typeof fakeDocker>) => [...fake.containers.values()].map((container) => container.labels['fluex.sandbox'] ?? container.name);

	it('removes every fluex container and nothing else, returning what it removed', async () => {
		const fake = await daemon();

		const removed = await pruneSandboxes({}, fake.cli);

		expect(removed.map((sandbox) => sandbox.key)).toEqual(['old', 'new']);
		expect(keysLeft(fake)).toEqual(['fluex-lookalike']);
	});

	it.each<[string, Parameters<typeof pruneSandboxes>[0], string[]]>([
		['olderThan', { olderThan: 3_600_000 }, ['new', 'fluex-lookalike']],
		['state', { state: 'running' }, ['old', 'fluex-lookalike']],
		['key', { key: (key) => key.startsWith('ne') }, ['old', 'fluex-lookalike']],
		['every filter given', { olderThan: 3_600_000, state: 'running' }, ['old', 'new', 'fluex-lookalike']],
	])('removes only the fluex containers matching %s', async (_filter, options, left) => {
		const fake = await daemon();

		await pruneSandboxes(options, fake.cli);

		expect(keysLeft(fake)).toEqual(left);
	});

	it('fails when docker rm fails, even without an error message', async () => {
		const fake = await daemon();
		const failing: DockerCli = async (args, options) => (args[0] === 'rm' ? reply('', 1, '') : fake.cli(args, options));

		await expect(pruneSandboxes({}, failing)).rejects.toThrow('[fluex] docker rm failed (exit 1)');
	});

	it('runs no docker rm when nothing matches', async () => {
		const fake = await daemon();
		const before = fake.calls.length;

		expect(await pruneSandboxes({ state: 'paused' }, fake.cli)).toEqual([]);
		expect(fake.calls.slice(before).map((call) => call.args[0])).not.toContain('rm');
	});
});
