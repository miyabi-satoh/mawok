import { describe, expect, it } from 'vitest';
import { deviceLabels } from './devices';

const device = (name: string, publicKey: string) => ({
	name,
	publicKey,
	address: ''
});

describe('deviceLabels', () => {
	it('名前が重ならなければ、名前だけにする', () => {
		const labels = deviceLabels([device('Mac', 'ab12cd'), device('Windows', 'ef34gh')]);

		expect(labels.get('ab12cd')).toBe('Mac');
		expect(labels.get('ef34gh')).toBe('Windows');
	});

	it('同じ名前のデバイスがあれば、名前の後ろに公開鍵の先頭4文字を添える', () => {
		const labels = deviceLabels([
			device('MacBook Pro', '3f2a9b'),
			device('MacBook Pro', '81c0de'),
			device('Windows', 'ef34gh')
		]);

		expect(labels.get('3f2a9b')).toBe('MacBook Pro (3f2a)');
		expect(labels.get('81c0de')).toBe('MacBook Pro (81c0)');
		expect(labels.get('ef34gh')).toBe('Windows');
	});
});
