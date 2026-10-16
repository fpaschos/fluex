import { describe, expect, it } from 'vitest';
import * as flueTools from '../src/index.ts';

describe('@fluex/flue-tools', () => {
	it('exports values to mount, no use* hooks', () => {
		const names = Object.keys(flueTools);
		const isHook = (name: string) => /^use[A-Z]/.test(name);
		const hooks = names.filter(isHook);
		expect(hooks).toEqual([]);
	});
});
