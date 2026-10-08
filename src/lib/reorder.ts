/** 並べ替えの flip アニメーションの既定の長さ（ms）。動きを減らす設定では 0 にして使う */
export const REORDER_FLIP_DURATION = 150;

/**
 * 配列の from の要素を to の位置へ動かした新しい配列を返す。
 * from か to が範囲外なら、元の配列をそのまま返す（端を越える指定で並びを崩さないため）。
 * 呼ぶ側は、返りが元と同じ参照なら「動かなかった」とみなして保存を省ける
 */
export function reorder<T>(items: T[], from: number, to: number): T[] {
	if (from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
	if (from === to) return items;
	const next = [...items];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}
