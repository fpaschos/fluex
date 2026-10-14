import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import { type ContainerSpec, IDLE, WORKSPACE } from './spec.ts';

export const LABEL = {
	sandbox: 'fluex.sandbox',
	version: 'fluex.version',
	created: 'fluex.created',
	spec: 'fluex.spec',
	/** Per-field hashes behind `fluex.spec`, so a mismatch can name what changed. */
	specFields: 'fluex.spec.fields',
} as const;

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** What a container's identity covers; a change to any of them recreates it. */
const SPEC_FIELDS = ['image', 'entrypoint', 'mounts', 'env', 'resources', 'network', 'user'] as const;
type SpecField = (typeof SPEC_FIELDS)[number];

/** The spec as it identifies a container: the image id, not its tag; env keys, not values; order-free. */
export interface SpecIdentity {
	hash: string;
	fields: Record<SpecField, string>;
}

export function specIdentity(spec: ContainerSpec, imageId: string): SpecIdentity {
	const mounts = [{ host: spec.workspace, container: WORKSPACE, readonly: false }, ...spec.mounts]
		.map(({ host, container, readonly }) => ({ host, container, readonly }))
		.sort((a, b) => (a.container < b.container ? -1 : 1));
	const { memory, cpus, pids } = spec.resources;
	const normalized: Record<SpecField, unknown> = {
		image: imageId,
		entrypoint: IDLE,
		mounts,
		env: Object.keys(spec.env ?? {}).sort(),
		resources: { memory, cpus, pids },
		network: spec.network,
		user: spec.user ?? null,
	};
	const fields = Object.fromEntries(SPEC_FIELDS.map((field) => [field, sha256(JSON.stringify(normalized[field]))])) as Record<
		SpecField,
		string
	>;
	return { hash: sha256(JSON.stringify(fields)), fields };
}

/** `--label` flags for a new container of `key`. */
export function labelArgs(key: string, identity: SpecIdentity): string[] {
	return Object.entries({
		[LABEL.sandbox]: key,
		[LABEL.version]: VERSION,
		[LABEL.created]: new Date().toISOString(),
		[LABEL.spec]: identity.hash,
		[LABEL.specFields]: JSON.stringify(identity.fields),
	}).flatMap(([name, value]) => ['--label', `${name}=${value}`]);
}

const SpecFieldsSchema = v.record(v.string(), v.string());

/**
 * Why a container labelled `labels` does not match `identity`, or `undefined` when it does.
 * A container without a spec label predates spec tracking (and the security defaults), so it never matches.
 */
export function specMismatch(labels: Record<string, string>, identity: SpecIdentity): string | undefined {
	const hash = labels[LABEL.spec];
	if (hash === undefined) return 'it has no spec label';
	if (hash === identity.hash) return undefined;
	let recorded: Record<string, string> = {};
	try {
		recorded = v.parse(SpecFieldsSchema, JSON.parse(labels[LABEL.specFields] ?? ''));
	} catch {
		// Unreadable field hashes: every field counts as changed.
	}
	const changed = SPEC_FIELDS.filter((field) => recorded[field] !== identity.fields[field]);
	return `its spec changed: ${(changed.length > 0 ? changed : SPEC_FIELDS).join(', ')}`;
}

/** `fluex-<sha256(key)[:12]>`: the same key always names the same container. */
export function containerName(key: string): string {
	return `fluex-${sha256(key).slice(0, 12)}`;
}

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
