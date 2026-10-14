import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe } from 'vitest';
import { pruneSandboxes } from '../../src/cleanup.ts';

/** Integration suites need a real Docker daemon and run only with `INTEGRATION=1`. */
export const describeIntegration = describe.runIf(process.env.INTEGRATION === '1');

/** Pinned by digest: Debian has the coreutils/findutils/procps the driver relies on; busybox does not. */
export const TEST_IMAGE =
	'debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587';

/** The test image runs as root, which the sandbox refuses: run as the host's own user, which may write the temp workspaces. */
export const TEST_USER = `${process.getuid!()}:${process.getgid!()}`;

const runPrefix = `it-${randomUUID().slice(0, 8)}-`;

/** A sandbox key unique to this test run; its container is removed after the suite. */
export const testKey = (name: string) => `${runPrefix}${name}`;

/** A fresh host directory to mount as the workspace (real path, so Docker Desktop can share it). */
export const tempWorkspace = async () => realpath(await mkdtemp(join(tmpdir(), 'fluex-docker-')));

/** Whether `key` is a sandbox key of this test run. */
export const isTestKey = (key: string) => key.startsWith(runPrefix);

/** Remove every fluex-labelled container whose key belongs to this test run. */
export function removeTestContainersAfterAll() {
	afterAll(async () => {
		await pruneSandboxes({ key: isTestKey });
	});
}
