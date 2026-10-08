import { describe, expect, it, vi } from 'vitest';
import { ReplacementPreview, previewSegments } from './replacement-preview.svelte';

describe('previewSegments', () => {
	it('一致が無ければ、全体を1つの未ハイライトの区間にする', () => {
		expect(previewSegments('高濃度の溶液', [])).toEqual([
			{ text: '高濃度の溶液', highlighted: false }
		]);
	});

	it('空文字列は空の並びにする', () => {
		expect(previewSegments('', [])).toEqual([]);
	});

	it('一致した範囲だけをハイライトの区間にする', () => {
		expect(previewSegments('高濃度の溶液', [{ start: 1, len: 2, to: 'Node.js' }])).toEqual([
			{ text: '高', highlighted: false },
			{ text: '濃度', highlighted: true, to: 'Node.js' },
			{ text: 'の溶液', highlighted: false }
		]);
	});

	it('先頭からの一致は、前に未ハイライトの区間を作らない', () => {
		expect(previewSegments('濃度の溶液', [{ start: 0, len: 2, to: 'Node.js' }])).toEqual([
			{ text: '濃度', highlighted: true, to: 'Node.js' },
			{ text: 'の溶液', highlighted: false }
		]);
	});

	it('末尾までの一致は、後ろに未ハイライトの区間を作らない', () => {
		expect(previewSegments('高濃度', [{ start: 1, len: 2, to: 'Node.js' }])).toEqual([
			{ text: '高', highlighted: false },
			{ text: '濃度', highlighted: true, to: 'Node.js' }
		]);
	});

	it('複数の一致を、それぞれ別の区間にする', () => {
		expect(
			previewSegments('濃度と濃度のバージョン', [
				{ start: 0, len: 2, to: 'Node.js' },
				{ start: 3, len: 2, to: 'Node.js' }
			])
		).toEqual([
			{ text: '濃度', highlighted: true, to: 'Node.js' },
			{ text: 'と', highlighted: false },
			{ text: '濃度', highlighted: true, to: 'Node.js' },
			{ text: 'のバージョン', highlighted: false }
		]);
	});

	it('サロゲートペアの文字も、コードポイント単位の位置として扱う', () => {
		// 𠮟る（U+20B9F、サロゲートペア）の直後の2文字をハイライトする
		expect(previewSegments('𠮟る濃度', [{ start: 2, len: 2, to: 'Node.js' }])).toEqual([
			{ text: '𠮟る', highlighted: false },
			{ text: '濃度', highlighted: true, to: 'Node.js' }
		]);
	});
});

describe('ReplacementPreview', () => {
	it('呼び出し結果を matches に反映する', async () => {
		const call = vi.fn().mockResolvedValue([{ start: 0, len: 2, to: 'Node.js' }]);
		const preview = new ReplacementPreview(call);
		preview.update('濃度の溶液', false);
		await vi.waitFor(() => expect(preview.matches).toEqual([{ start: 0, len: 2, to: 'Node.js' }]));
		expect(call).toHaveBeenCalledWith('濃度の溶液');
	});

	it('IME 変換中は呼ばない', () => {
		const call = vi.fn().mockResolvedValue([]);
		const preview = new ReplacementPreview(call);
		preview.update('へんかんちゅう', true);
		expect(call).not.toHaveBeenCalled();
	});

	it('IME 変換が始まったら、前の結果が本文とずれないよう matches を空にする', () => {
		const call = vi.fn().mockResolvedValue([{ start: 0, len: 2, to: 'Node.js' }]);
		const preview = new ReplacementPreview(call);
		preview.update('濃度', false);
		preview.matches = [{ start: 0, len: 2, to: 'Node.js' }];
		preview.update('のうど', true);
		expect(preview.matches).toEqual([]);
	});

	it('求めている間にテキストが空になったら、遅れて届いた結果で matches を巻き戻さない', async () => {
		let resolveCall: (matches: { start: number; len: number; to: string }[]) => void;
		const call = vi.fn().mockReturnValue(
			new Promise<{ start: number; len: number; to: string }[]>((resolve) => {
				resolveCall = resolve;
			})
		);
		const preview = new ReplacementPreview(call);
		preview.update('濃度の溶液', false);
		preview.update('', false);
		expect(preview.matches).toEqual([]);
		resolveCall!([{ start: 0, len: 2, to: 'Node.js' }]);
		// resolveCall 後の続き（matches への代入判定）が動く分だけ待つ
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(preview.matches).toEqual([]);
	});

	it('本文が変わらないまま IME 変換に入っても、遅れて届いた結果で matches を復活させない', async () => {
		let resolveCall: (matches: { start: number; len: number; to: string }[]) => void;
		const call = vi.fn().mockReturnValue(
			new Promise<{ start: number; len: number; to: string }[]>((resolve) => {
				resolveCall = resolve;
			})
		);
		const preview = new ReplacementPreview(call);
		preview.update('濃度', false);
		preview.update('濃度', true);
		expect(preview.matches).toEqual([]);
		resolveCall!([{ start: 0, len: 2, to: 'Node.js' }]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(preview.matches).toEqual([]);
	});

	it('空文字列になったら、呼ばずに matches を空にする', async () => {
		const call = vi.fn().mockResolvedValue([{ start: 0, len: 2, to: 'Node.js' }]);
		const preview = new ReplacementPreview(call);
		preview.update('濃度', false);
		await vi.waitFor(() => expect(preview.matches).toEqual([{ start: 0, len: 2, to: 'Node.js' }]));
		call.mockClear();
		preview.update('', false);
		expect(preview.matches).toEqual([]);
		expect(call).not.toHaveBeenCalled();
	});
});
