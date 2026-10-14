import {
	createBashTool,
	createEditTool,
	createGlobTool,
	createGrepTool,
	createReadTool,
	createWriteTool,
	type Sandbox,
} from '@flue/runtime';
import { beforeAll, expect, it } from 'vitest';
import { docker } from '../src/index.ts';
import { describeIntegration, removeTestContainersAfterAll, TEST_IMAGE, TEST_USER, tempWorkspace, testKey } from './support/integration.ts';

/** The text a Flue tool hands back to the model. */
const output = (result: { content: { type: string; text?: string }[] }) =>
	result.content.map((part) => part.text ?? '').join('\n');

describeIntegration("Flue's built-in tools on the Docker sandbox", () => {
	removeTestContainersAfterAll();

	let sandbox: Sandbox;
	beforeAll(async () => {
		sandbox = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace: await tempWorkspace() }).createSandbox({
			id: testKey('flue-tools'),
		});
	});

	it('write creates a file and its parent directories', async () => {
		await createWriteTool(sandbox).execute('w', { path: 'src/app/Main.kt', content: 'fun main() = println("hi")\n' });

		expect(await sandbox.readFile('src/app/Main.kt')).toBe('fun main() = println("hi")\n');
	});

	it('read returns the file with line numbers', async () => {
		await sandbox.writeFile('read-me.txt', 'alpha\nbeta\n');

		const text = output(await createReadTool(sandbox).execute('r', { path: 'read-me.txt' }));

		expect(text).toContain('alpha');
		expect(text).toContain('beta');
	});

	it('edit replaces a unique region in place', async () => {
		await sandbox.writeFile('edit-me.kt', 'val greeting = "hello"\n');

		await createEditTool(sandbox).execute('e', { path: 'edit-me.kt', oldText: '"hello"', newText: '"hej"' });

		expect(await sandbox.readFile('edit-me.kt')).toBe('val greeting = "hej"\n');
	});

	it('grep finds matching lines with file and line number', async () => {
		await sandbox.writeFile('search/a.kt', 'one\nneedle here\n');
		await sandbox.writeFile('search/b.txt', 'needle too\n');

		const text = output(await createGrepTool(sandbox).execute('g', { pattern: 'needle', path: 'search', include: '*.kt' }));

		expect(text).toBe('search/a.kt:2:needle here');
	});

	it('glob finds files by name', async () => {
		await sandbox.writeFile('globbed/x/One.kt', '');
		await sandbox.writeFile('globbed/Two.kt', '');
		await sandbox.writeFile('globbed/three.md', '');

		const text = output(await createGlobTool(sandbox).execute('f', { pattern: '*.kt', path: 'globbed' }));

		expect(text.split('\n').sort()).toEqual(['globbed/Two.kt', 'globbed/x/One.kt']);
	});

	it('bash runs in /workspace inside the container and reports the exit code', async () => {
		const ok = output(await createBashTool(sandbox).execute('b', { command: 'pwd; cat /etc/debian_version' }));
		const failed = output(await createBashTool(sandbox).execute('b', { command: 'echo oops >&2; exit 3' }));

		expect(ok).toMatch(/^\/workspace\n\d+\.\d+/);
		expect(failed).toBe('oops\n\nCommand exited with code 3');
	});
});
