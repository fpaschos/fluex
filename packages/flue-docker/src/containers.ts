import * as v from 'valibot';
import { checked, type DockerCli, parsed, text } from './docker-cli.ts';

/** The tail of the work queued per key, per `DockerCli`: every factory in the process on the same `docker` shares it. */
const queues = new WeakMap<DockerCli, Map<string, Promise<unknown>>>();

/** Runs `work` once the previous work queued for `key` has settled, so one process never races itself for a container. */
export function oneAtATime<T>(cli: DockerCli, key: string, work: () => Promise<T>): Promise<T> {
	const queue = queues.get(cli) ?? new Map<string, Promise<unknown>>();
	queues.set(cli, queue);
	const result = (queue.get(key) ?? Promise.resolve()).then(work, work);
	const tail = result.catch(() => {});
	queue.set(key, tail);
	void tail.then(() => {
		if (queue.get(key) === tail) queue.delete(key);
	});
	return result;
}

const PsLineSchema = v.object({ ID: v.string() });

/** Ids of the containers, running or not, that match a `docker ps` label filter. */
export async function containerIds(cli: DockerCli, filter: string): Promise<string[]> {
	const listed = await cli(['ps', '--all', '--filter', filter, '--format', '{{json .}}']);
	return text(checked(listed, 'docker ps'))
		.split('\n')
		.filter(Boolean)
		.map((line) => parsed(PsLineSchema, line, 'docker ps').ID);
}
