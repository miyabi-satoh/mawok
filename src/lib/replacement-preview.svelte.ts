import { coalescedSaver } from '$lib/saver';
import type { ReplacementMatch } from '$lib/bindings/ReplacementMatch';

export type { ReplacementMatch } from '$lib/bindings/ReplacementMatch';

export type PreviewCall = (text: string) => Promise<ReplacementMatch[]>;

/**
 * 下書き入力中、コピー時に置き換え辞書で書き換わる範囲をリアルタイムに保つ。
 * IME 変換中（isComposing）は求めない。ハイライトが変換候補の表示と競合するのを避け、
 * 変換確定前の未確定文字列に対して意味のない結果を計算しないため。変換が確定したら改めて求める
 */
export class ReplacementPreview {
	matches = $state<ReplacementMatch[]>([]);

	private readonly call: PreviewCall;
	private latestText = '';
	private composing = false;
	// update() のたびに進める世代。結果が届いたとき、求めたときと世代が変わっていなければ反映する。
	// テキストの一致だけで判定すると、同じ本文のまま変換に入った・空にした場合を見分けられない
	// （本文は変わらなくても、matches を空にすべき状態には変わっている）
	private generation = 0;

	constructor(call: PreviewCall) {
		this.call = call;
	}

	private readonly refresh = coalescedSaver(async () => {
		// coalescedSaver は待っている間の変更をまとめて次の1回に回すので、そのもう1回が始まる時点で
		// 変換中・空になっていれば、無駄な呼び出しをする前にやめる
		if (this.composing || this.latestText === '') return;
		const requestedGeneration = this.generation;
		const requestedText = this.latestText;
		try {
			const matches = (await this.call(requestedText)) ?? [];
			if (requestedGeneration === this.generation) this.matches = matches;
		} catch {
			// 失敗は Rust 側でログに残す。ハイライトが更新されないだけで、下書きの入力自体は続けられる
		}
	});

	/**
	 * テキストが変わった。IME 変換中は求めない（compositionend で改めて呼ぶこと）。
	 * 変換中は matches も空にする。残したままだと、変換中に本文の長さが変わったとき、
	 * 変換前の文字位置に対するハイライトが新しい本文の上にずれて出てしまう
	 */
	update(text: string, composing: boolean) {
		this.latestText = text;
		this.composing = composing;
		this.generation++;
		if (composing || text === '') {
			this.matches = [];
			return;
		}
		this.refresh();
	}
}

/** highlighted な区間だけ to（置き換えた後の文字列）を持つ */
export type PreviewSegment =
	{ text: string; highlighted: false } | { text: string; highlighted: true; to: string };

/**
 * オーバーレイ表示用に、テキストをハイライトする範囲・しない範囲の並びに分ける。
 * match の start・len は Rust 側と同じくコードポイント単位なので、UTF-16 コード単位（文字列の添字）では
 * ずれうる文字（サロゲートペアを使う絵文字など）を正しく扱うため `Array.from` でコードポイントに割る
 */
export function previewSegments(text: string, matches: ReplacementMatch[]): PreviewSegment[] {
	if (matches.length === 0) return text === '' ? [] : [{ text, highlighted: false }];
	const characters = Array.from(text);
	const segments: PreviewSegment[] = [];
	let position = 0;
	for (const match of matches) {
		if (match.start > position) {
			segments.push({
				text: characters.slice(position, match.start).join(''),
				highlighted: false
			});
		}
		segments.push({
			text: characters.slice(match.start, match.start + match.len).join(''),
			highlighted: true,
			to: match.to
		});
		position = match.start + match.len;
	}
	if (position < characters.length) {
		segments.push({ text: characters.slice(position).join(''), highlighted: false });
	}
	return segments;
}
