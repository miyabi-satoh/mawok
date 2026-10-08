/** value を min 以上 max 以下に収める。max が min より小さいときは max を返す（空の一覧の -1 など） */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
