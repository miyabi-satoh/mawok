import { describe, expect, it } from 'vitest';
import { DraftHistory, historyDirection } from './history.svelte';

describe('DraftHistory', () => {
	it('新しいものから古い方へたどり、最後まで戻ると打っていた内容を返す', () => {
		const history = new DraftHistory();
		history.record('git status');
		history.record('git diff');

		expect(history.older('書きかけ')).toBe('git diff');
		expect(history.older('git diff')).toBe('git status');
		expect(history.newer()).toBe('git diff');
		expect(history.newer()).toBe('書きかけ');
		// 戻りきったら、たどっていない状態
		expect(history.newer()).toBeNull();
	});

	it('いちばん古いものより先はない', () => {
		const history = new DraftHistory();
		history.record('git status');

		expect(history.older('')).toBe('git status');
		expect(history.older('git status')).toBeNull();
		// 行き止まりで押しても、位置は動かない
		expect(history.newer()).toBe('');
	});

	it('履歴が空なら何も出さず、打っていた内容も覚えない', () => {
		const history = new DraftHistory();

		expect(history.older('書きかけ')).toBeNull();
		expect(history.newer()).toBeNull();
	});

	it('直前と同じ内容は足さない', () => {
		const history = new DraftHistory();
		history.record('git status');
		history.record('git status');

		expect(history.older('')).toBe('git status');
		expect(history.older('git status')).toBeNull();
	});

	it('直前でなければ、同じ内容でも足す', () => {
		const history = new DraftHistory();
		history.record('git status');
		history.record('git diff');
		history.record('git status');

		expect(history.older('')).toBe('git status');
		expect(history.older('')).toBe('git diff');
		expect(history.older('')).toBe('git status');
	});

	it('件数を超えたら古いものから忘れる', () => {
		const history = new DraftHistory(2);
		history.record('1');
		history.record('2');
		history.record('3');

		expect(history.older('')).toBe('3');
		expect(history.older('')).toBe('2');
		expect(history.older('')).toBeNull();
	});

	it('件数が 0 なら覚えない', () => {
		const history = new DraftHistory(0);
		history.record('git status');

		expect(history.older('')).toBeNull();
	});

	it('件数を減らすと、その場で古いものから忘れ、たどるのをやめる', () => {
		const history = new DraftHistory();
		history.record('1');
		history.record('2');
		history.record('3');
		expect(history.older('書きかけ')).toBe('3');

		history.resize(1);

		expect(history.newer()).toBeNull();
		expect(history.older('')).toBe('3');
		expect(history.older('')).toBeNull();
	});

	it('件数を増やしても、覚えているものは残す', () => {
		const history = new DraftHistory(2);
		history.record('1');
		history.record('2');

		history.resize(5);

		expect(history.older('')).toBe('2');
		expect(history.older('')).toBe('1');
	});

	it('たどるのをやめると、打っていた内容は忘れ、次は新しいものから始める', () => {
		const history = new DraftHistory();
		history.record('git status');
		history.record('git diff');
		expect(history.older('書きかけ')).toBe('git diff');
		expect(history.older('')).toBe('git status');

		history.stopBrowsing();

		expect(history.newer()).toBeNull();
		expect(history.older('直した内容')).toBe('git diff');
		expect(history.newer()).toBe('直した内容');
	});

	it('覚えると、たどるのをやめる', () => {
		const history = new DraftHistory();
		history.record('git status');
		expect(history.older('書きかけ')).toBe('git status');

		history.record('git diff');

		expect(history.newer()).toBeNull();
		expect(history.older('')).toBe('git diff');
	});

	it('保存した履歴を読み込める', () => {
		const history = new DraftHistory();
		history.load(['古い下書き', '新しい下書き']);

		expect(history.older('')).toBe('新しい下書き');
		expect(history.older('')).toBe('古い下書き');
	});

	it('読み込み前に覚えた履歴は、読み込んだ履歴の後ろに残る', () => {
		const history = new DraftHistory();
		history.record('読み込み前');
		history.load(['保存済み']);

		expect(history.older('')).toBe('読み込み前');
		expect(history.older('')).toBe('保存済み');
	});

	it('読み込んだ履歴も件数の上限で切り詰める', () => {
		const history = new DraftHistory(2);
		history.load(['1', '2', '3']);

		expect(history.older('')).toBe('3');
		expect(history.older('')).toBe('2');
		expect(history.older('')).toBeNull();
	});

	it('件数 0 では読み込んでも履歴を持たない', () => {
		const history = new DraftHistory(0);
		history.load(['保存済み']);

		expect(history.hasEntries).toBe(false);
		expect(history.older('')).toBeNull();
	});
});

describe('DraftHistory の移れるかどうか', () => {
	it('空なら、どちらへも移れない', () => {
		const history = new DraftHistory();

		expect(history.hasEntries).toBe(false);
		expect(history.canGoOlder).toBe(false);
		expect(history.canGoNewer).toBe(false);
	});

	it('覚えたら古い方へだけ移れ、たどり始めたら新しい方へも移れる', () => {
		const history = new DraftHistory();
		history.record('git status');
		history.record('git diff');

		expect(history.hasEntries).toBe(true);
		expect(history.canGoOlder).toBe(true);
		expect(history.canGoNewer).toBe(false);

		history.older('書きかけ');
		expect(history.canGoOlder).toBe(true);
		expect(history.canGoNewer).toBe(true);

		// いちばん古いものでは、古い方へは移れない
		history.older('');
		expect(history.canGoOlder).toBe(false);
		expect(history.canGoNewer).toBe(true);

		// 打っていた内容まで戻りきったら、たどっていない状態
		history.newer();
		history.newer();
		expect(history.canGoOlder).toBe(true);
		expect(history.canGoNewer).toBe(false);
	});

	it('たどっている途中かを返す。最後まで戻るか、やめるか、覚えると、たどっていない', () => {
		const history = new DraftHistory();
		history.record('git status');
		expect(history.isBrowsing).toBe(false);

		history.older('書きかけ');
		expect(history.isBrowsing).toBe(true);
		history.newer();
		expect(history.isBrowsing).toBe(false);

		history.older('書きかけ');
		history.stopBrowsing();
		expect(history.isBrowsing).toBe(false);

		history.older('書きかけ');
		history.record('git diff');
		expect(history.isBrowsing).toBe(false);
	});

	it('件数を 0 にすると、覚えていたものを忘れて移れなくなる', () => {
		const history = new DraftHistory();
		history.record('git status');

		history.resize(0);

		expect(history.hasEntries).toBe(false);
		expect(history.canGoOlder).toBe(false);
	});

	describe('同期で替わった履歴の読み直し', () => {
		function recorded(...texts: string[]): DraftHistory {
			const history = new DraftHistory(5);
			for (const text of texts) history.record(text);
			return history;
		}

		it('読み直した履歴に入れ替える', () => {
			const history = recorded('git status');
			history.beginReload();
			expect(history.isReloading).toBe(true);

			expect(history.finishReload(['git log', 'git status', 'git diff'])).toBe(false);
			expect(history.isReloading).toBe(false);
			expect(history.entries).toEqual(['git log', 'git status', 'git diff']);
		});

		it('読み直している間に覚えたものは、読み直した履歴の後ろに残し、保存が要ると返す', () => {
			const history = recorded('git status');
			history.beginReload();
			history.record('git push');

			expect(history.finishReload(['git log', 'git status'])).toBe(true);
			expect(history.entries).toEqual(['git log', 'git status', 'git push']);
		});

		it('読み直した履歴の最後と同じ内容を覚えていたら、重ねない', () => {
			const history = recorded('git status');
			history.beginReload();
			history.record('git push');

			history.finishReload(['git status', 'git push']);
			expect(history.entries).toEqual(['git status', 'git push']);
		});

		it('読み直した履歴も、件数を超えた分は古いものから忘れる', () => {
			const history = new DraftHistory(2);
			history.beginReload();
			history.record('git push');

			history.finishReload(['git log', 'git status']);
			expect(history.entries).toEqual(['git status', 'git push']);
		});

		it('たどっている途中なら、たどり終えてから入れ替える', () => {
			const history = recorded('git status', 'git diff');
			expect(history.older('書きかけ')).toBe('git diff');
			history.beginReload();
			history.finishReload(['git log', 'git status', 'git diff', 'git push']);

			// 出している履歴の位置は、読み直す前の一覧のまま
			expect(history.older('git diff')).toBe('git status');
			expect(history.older('git status')).toBeNull();
			expect(history.newer()).toBe('git diff');
			expect(history.newer()).toBe('書きかけ');
			expect(history.isBrowsing).toBe(false);
			expect(history.older('書きかけ')).toBe('git push');
		});

		it('たどり終えるのを待っている間も、保存する履歴は読み直した方にする', () => {
			const history = recorded('git status');
			history.older('');
			history.beginReload();
			history.finishReload(['git log', 'git status']);

			expect(history.entries).toEqual(['git log', 'git status']);
		});

		it('たどっている途中で覚えたら、読み直した履歴に入れ替えてから足す', () => {
			const history = recorded('git status');
			history.older('');
			history.beginReload();
			history.finishReload(['git log', 'git status']);

			history.record('git push');
			expect(history.entries).toEqual(['git log', 'git status', 'git push']);
		});

		it('読み直している間に消したら、消す前に覚えたものを戻さない', () => {
			const history = recorded('git status');
			history.beginReload();
			history.record('git push');
			history.clear();
			history.record('git pull');

			expect(history.finishReload([])).toBe(true);
			expect(history.entries).toEqual(['git pull']);
		});

		it('たどり終えるのを待っている間に消したら、読み直した履歴を入れない', () => {
			const history = recorded('git status');
			history.older('');
			history.beginReload();
			history.finishReload(['git log', 'git status']);
			history.clear();

			expect(history.entries).toEqual([]);
			expect(history.hasEntries).toBe(false);
		});

		it('読み直せなかったら、今の一覧のまま続ける', () => {
			const history = recorded('git status');
			history.beginReload();
			history.record('git push');
			history.cancelReload();

			expect(history.isReloading).toBe(false);
			expect(history.entries).toEqual(['git status', 'git push']);
		});
	});
});

describe('historyDirection', () => {
	const key = (init: Partial<KeyboardEvent>) => ({
		key: '',
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		isComposing: false,
		keyCode: 0,
		...init
	});

	it('上キーで古い方、下キーで新しい方', () => {
		expect(historyDirection(key({ key: 'ArrowUp' }))).toBe('older');
		expect(historyDirection(key({ key: 'ArrowDown' }))).toBe('newer');
		expect(historyDirection(key({ key: 'ArrowLeft' }))).toBeNull();
	});

	it('修飾キーを押しているときは移らない', () => {
		for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
			expect(historyDirection(key({ key: 'ArrowUp', [modifier]: true })), modifier).toBeNull();
		}
	});

	it('IME の変換中は移らない', () => {
		expect(historyDirection(key({ key: 'ArrowUp', isComposing: true }))).toBeNull();
		expect(historyDirection(key({ key: 'ArrowDown', keyCode: 229 }))).toBeNull();
	});
});
