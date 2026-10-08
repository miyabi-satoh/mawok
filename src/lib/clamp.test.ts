import { describe, expect, it } from 'vitest';
import { clamp } from './clamp';

describe('clamp', () => {
	it('範囲の中ならそのまま返す', () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});

	it('範囲の外なら端に収める', () => {
		expect(clamp(-1, 0, 10)).toBe(0);
		expect(clamp(11, 0, 10)).toBe(10);
	});

	it('max が min より小さければ max を返す', () => {
		expect(clamp(1, 0, -1)).toBe(-1);
	});
});
