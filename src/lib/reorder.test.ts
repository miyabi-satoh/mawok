import { describe, expect, it } from 'vitest';
import { reorder } from './reorder';

describe('reorder', () => {
	it('要素を後ろへ動かす', () => {
		expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
	});

	it('要素を前へ動かす', () => {
		expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
	});

	it('隣へ1つ動かす', () => {
		expect(reorder(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
	});

	it('from と to が同じなら、動かさず元の配列をそのまま返す', () => {
		const items = ['a', 'b', 'c'];
		// 同じ参照を返すことで、呼ぶ側は「動かなかった」とみなして保存を省ける
		expect(reorder(items, 1, 1)).toBe(items);
	});

	it('範囲外の指定は、元の配列をそのまま返す', () => {
		const items = ['a', 'b', 'c'];
		expect(reorder(items, 0, 3)).toBe(items);
		expect(reorder(items, -1, 0)).toBe(items);
		expect(reorder(items, 3, 0)).toBe(items);
	});
});
