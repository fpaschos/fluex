import { type SandboxDriver, SandboxDiedError } from '@flue/runtime';
import { containerGone, type DockerCli, type DockerResult, text } from './docker-cli.ts';

/** Output kept per stream (stdout, stderr), as `local()` caps it. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Runs command `$2` with timeout `$1` (seconds, `0` for none) and stops it inside the container
 * on that timeout, or when the `docker exec` client ends (our stdin closes).
 * `timeout` signals the command's whole process group: TERM, then KILL 5 s later; exit code 124.
 */
const SCRIPT = `exec 3<&0
timeout -k 5 "$1" bash -c "$2" </dev/null 3<&- &
command=$!
{ while read -r -u 3 _; do :; done; kill -TERM "$command" 2>/dev/null; } &
watcher=$!
exec 3<&-
wait "$command"
code=$?
kill "$watcher" 2>/dev/null
exit "$code"`;

/** The driver's `exec`: runs a shell command in the container, honouring `timeoutMs` and `signal`. */
export function execCommand(cli: DockerCli, container: string, workspace: string): SandboxDriver['exec'] {
	return async (command, options = {}) => {
		const seconds = String((options.timeoutMs ?? 0) / 1000);
		const args = ['exec', '-i', '-w', options.cwd ?? workspace, container, 'bash', '-c', SCRIPT, 'bash', seconds, command];

		const result = await cli(args, {
			envFile: options.env,
			// Ending the client on abort closes its stdin, which stops the command in the container.
			signal: options.signal,
			holdStdin: true,
			// The command has its own timeout, not the operation timeout.
			timeoutMs: Number.POSITIVE_INFINITY,
			// One byte more than we keep, so `capped` can tell that output was dropped.
			tailBytes: MAX_OUTPUT_BYTES + 1,
		});

		if (await containerDied(cli, container, result)) {
			throw new SandboxDiedError({ operation: 'exec', reason: 'stopped' });
		}
		return { stdout: capped(result.stdout), stderr: capped(new TextEncoder().encode(result.stderr)), exitCode: result.exitCode };
	};
}

/**
 * Whether the command failed because the container stopped or vanished under it:
 * Docker says so, or the command was killed by a signal and Docker reports the container not running.
 */
async function containerDied(cli: DockerCli, container: string, result: DockerResult): Promise<boolean> {
	if (containerGone(result.stderr)) return true;
	if (result.exitCode <= 128) return false;
	const inspected = await cli(['inspect', '--format', '{{.State.Running}}', container]);
	return !(inspected.exitCode === 0 && text(inspected).trim() === 'true');
}

/** The output as text; when it is over the cap, only its last `MAX_OUTPUT_BYTES` behind a truncation marker. */
function capped(bytes: Uint8Array): string {
	if (bytes.length <= MAX_OUTPUT_BYTES) return text({ stdout: bytes });
	const tail = text({ stdout: bytes.subarray(bytes.length - MAX_OUTPUT_BYTES) });
	return `[fluex] output truncated: kept the last ${MAX_OUTPUT_BYTES} bytes\n${tail}`;
}
