import * as v from 'valibot';
import { checked, type DockerCli, dockerCli, parsed, text } from './docker-cli.ts';
import { containerIds, oneAtATime } from './containers.ts';
import { LABEL } from './identity.ts';

/**
 * Removes the container of sandbox `key`, running or not; does nothing when there is none. In this process it waits for
 * a `createSandbox` of the same key in flight, so the container that call makes is removed too.
 */
export function removeSandbox(key: string, cli: DockerCli = dockerCli): Promise<void> {
	return oneAtATime(cli, key, async () => {
		const ids = await containerIds(cli, `label=${LABEL.sandbox}=${key}`);
		if (ids.length > 0) await removeContainers(cli, ids);
	});
}

/** A fluex sandbox container, as `listSandboxes` reports it. */
export interface SandboxInfo {
	/** The container id. */
	id: string;
	/** The sandbox key, from the container's `fluex.sandbox` label. */
	key: string;
	/** The container name, `fluex-<sha256(key)[:12]>`. */
	name: string;
	/** Docker's state: `running`, `exited`, `created`, `paused`, `dead`, … */
	state: string;
	/** When fluex created it, by the host's clock (its `fluex.created` label), else Docker's. */
	created: Date;
	/** The image id the container runs. */
	image: string;
}

export interface PruneOptions {
	/** Only containers created more than this many milliseconds ago. */
	olderThan?: number;
	/** Only containers in this Docker state, e.g. `exited`. */
	state?: string;
	/** Only containers whose sandbox key passes this test. */
	key?: (key: string) => boolean;
}

/**
 * Removes the fluex sandbox containers matching every filter given (all of them when none is), running or not, and
 * returns them. Only containers carrying the fluex sandbox label are ever considered.
 */
export async function pruneSandboxes(options: PruneOptions = {}, cli: DockerCli = dockerCli): Promise<SandboxInfo[]> {
	const { olderThan, state, key } = options;
	const now = Date.now();
	const matching = (await listSandboxes(cli)).filter(
		(sandbox) =>
			(olderThan === undefined || now - sandbox.created.getTime() > olderThan) &&
			(state === undefined || sandbox.state === state) &&
			(key === undefined || key(sandbox.key)),
	);
	if (matching.length > 0) await removeContainers(cli, matching.map((sandbox) => sandbox.id));
	return matching;
}

/** Every container, running or not, carrying the fluex sandbox label. */
export async function listSandboxes(cli: DockerCli = dockerCli): Promise<SandboxInfo[]> {
	const ids = await containerIds(cli, `label=${LABEL.sandbox}`);
	if (ids.length === 0) return [];
	const inspected = await cli(['inspect', '--type', 'container', ...ids]);
	// Docker still prints the others when some were removed since `docker ps` listed them.
	const gone = (line: string) => !line.trim() || /No such (object|container)/i.test(line);
	if (!inspected.stderr.split('\n').every(gone)) checked(inspected, 'docker inspect');
	// Some Docker versions print nothing at all when every one is gone.
	return parsed(ContainersSchema, text(inspected).trim() || '[]', 'docker inspect').map(({ Id, Name, Created, State, Config }) => ({
		id: Id,
		key: Config.Labels[LABEL.sandbox]!,
		name: Name.replace(/^\//, ''),
		state: State.Status,
		created: new Date(Config.Labels[LABEL.created] ?? Created),
		image: Config.Image,
	}));
}

const ContainersSchema = v.array(
	v.object({
		Id: v.string(),
		Name: v.string(),
		Created: v.string(),
		State: v.object({ Status: v.string() }),
		Config: v.object({ Image: v.string(), Labels: v.record(v.string(), v.string()) }),
	}),
);

/** `docker rm --force` of `ids`; one already gone is not an error. */
async function removeContainers(cli: DockerCli, ids: string[]): Promise<void> {
	const removed = await cli(['rm', '--force', ...ids]);
	const lines = removed.stderr.split('\n').filter((line) => line.trim());
	const allGone = lines.length > 0 && lines.every((line) => /No such container/i.test(line));
	if (!allGone) checked(removed, 'docker rm');
}
