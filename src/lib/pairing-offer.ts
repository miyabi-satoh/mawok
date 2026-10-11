/** 表示中の確認コードに添える案内。コードの作り直しを画面の時計で始めないよう、Rust 側から届いた状態で選ぶ。 */
export type PairingOfferDescription = 'waiting' | 'automatic' | 'wrongCode';

export function pairingOfferDescription(
	automatic: boolean,
	previousCodeWasWrong: boolean
): PairingOfferDescription {
	if (previousCodeWasWrong) return 'wrongCode';
	return automatic ? 'automatic' : 'waiting';
}

/** Rust が次のコードを届けるまで、期限切れのコードをボタンへ替えない。 */
export function pairingOfferRemainingSeconds(deadline: number, now: number): number {
	return Math.max(1, Math.ceil((deadline - now) / 1000));
}
