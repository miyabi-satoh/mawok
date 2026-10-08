import { describe, expect, it } from 'vitest';
import { safeNext } from '../src/util';

describe('safeNext', () => {
	it('only allows paths on this site', () => {
		expect(safeNext('/account/link?code=ABC')).toBe('/account/link?code=ABC');
		expect(safeNext('//evil.test')).toBe('/account/');
		expect(safeNext('https://evil.test')).toBe('/account/');
		expect(safeNext('/\\evil.test')).toBe('/account/');
		expect(safeNext('/\t/evil.test')).toBe('/account/');
		expect(safeNext('/\n/evil.test')).toBe('/account/');
		expect(safeNext('/ /evil.test')).toBe('/account/');
		expect(safeNext(undefined)).toBe('/account/');
	});
});
