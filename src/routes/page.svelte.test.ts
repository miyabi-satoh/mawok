import { invoke } from '@tauri-apps/api/core';
import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { draftGuidance } from '$lib/guidance';
import { m } from '$lib/paraglide/messages';
import { type Platform } from '$lib/keys';
import { settings, type SettingsView } from '$lib/settings.svelte';
import { EVENTS } from '$lib/bindings/constants';
import { callsOf } from '$lib/test-support/calls';
import { newSnippet } from '$lib/snippets';
import { DEFAULT_DRAFT_KEYS, settingsView } from '$lib/test-support/settings-view';
import Page from './+page.svelte';
// 一覧と入力欄の重なり順を見るテストのために、画面と同じ CSS を当てる
import './layout.css';

// Rust 側とのやり取りは、呼ばれた内容と、こちらから起こすイベントだけを見る
const { listeners } = vi.hoisted(() => ({
	listeners: new Map<string, Set<(event: { payload: unknown }) => void>>()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
		const handlers = listeners.get(name) ?? new Set();
		handlers.add(handler);
		listeners.set(name, handlers);
		return Promise.resolve(() => handlers.delete(handler));
	})
}));

const invoked = vi.mocked(invoke);

/** Rust 側から届くイベントを起こす */
function emit(
	name: typeof EVENTS.SHOWN | typeof EVENTS.HIDE_REQUESTED | typeof EVENTS.DRAFT_HISTORY_MERGED,
	payload?: unknown
) {
	for (const handler of listeners.get(name) ?? []) handler({ payload });
}

function view(
	platform: Platform = 'macos',
	font: { family?: string; size?: number } = {},
	guidance: string | null = null
): SettingsView {
	return settingsView({
		platform,
		textFontFamily: font.family ?? '',
		textFontSize: font.size ?? 16,
		inputGuidance: guidance
	});
}

/** commit に渡された下書き。呼ばれていなければ null */
function committedText(): string | null {
	const last = callsOf(invoked, 'commit').at(-1);
	return last ? (last[1] as { text: string }).text : null;
}

type Screen = Awaited<ReturnType<typeof render>>;

/** 入力欄。一覧の絞り込みの欄と見分けるため、ラベルで引く */
const draftField = (screen: Screen) => screen.getByLabelText(m.draft_label(), { exact: true });

/** 定型文の一覧の、絞り込みの欄 */
const snippetSearch = (screen: Screen) =>
	screen.getByRole('combobox', { name: m.snippets_search() });

/** 入力欄に書き、カーソル（と選択範囲）を置いてから、Cmd+K で定型文の一覧を出す */
async function openListAt(screen: Screen, value: string, start: number, end: number) {
	const textarea = draftField(screen);
	await textarea.fill(value);
	(textarea.element() as HTMLTextAreaElement).setSelectionRange(start, end);
	await userEvent.keyboard('{Meta>}k{/Meta}');
	await expect.element(snippetSearch(screen)).toHaveFocus();
	return textarea;
}

function commandsCalled(): string[] {
	return invoked.mock.calls.map(([command]) => command as string);
}

/** IME の変換中のキーは、この形で届く（isComposing は userEvent では作れない） */
function pressWhileComposing(element: Element, key: string, modifiers: KeyboardEventInit = {}) {
	element.dispatchEvent(
		new KeyboardEvent('keydown', {
			key,
			isComposing: true,
			keyCode: 229,
			bubbles: true,
			...modifiers
		})
	);
}

beforeEach(() => {
	listeners.clear();
	invoked.mockClear();
});

describe('下書きウィンドウ', () => {
	beforeEach(() => {
		invoked.mockImplementation(() => Promise.resolve(undefined));
		settings.current = view();
	});

	/**
	 * style 属性そのものを見る。toHaveStyle は期待値も受け取り値も getComputedStyle で比べるので、
	 * var(--font-sans) がテスト文書で解決できず、どちらも同じ継承値へ潰れて必ず一致してしまう
	 */
	function draftStyle(screen: Screen) {
		return draftField(screen).element().getAttribute('style') ?? '';
	}

	it('設定のフォントと大きさを入力欄に当てる', async () => {
		settings.current = view('macos', { family: 'HackGen Console NF', size: 22 });
		const screen = await render(Page);

		const style = draftStyle(screen);
		expect(style).toContain('font-family: "HackGen Console NF", var(--font-sans');
		expect(style).toContain('font-size: 22px');
	});

	it('Mac では Cmd+Enter でコピーして、入力欄を空にする', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);

		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

		await vi.waitFor(() => expect(committedText()).toBe('git status'));
		await expect.element(textarea).toHaveValue('');
	});

	it('変換中の Cmd+Enter ではコピーしない（変換の確定を横取りしない）', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);

		await textarea.fill('のうど');
		pressWhileComposing(textarea.element(), 'Enter', { metaKey: true });

		expect(commandsCalled()).not.toContain('commit');
	});

	it('Esc ではコピーせずに隠し、書きかけを残す', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);

		await textarea.fill('書きかけ');
		await userEvent.keyboard('{Escape}');

		await vi.waitFor(() => expect(commandsCalled()).toContain('dismiss'));
		expect(commandsCalled()).not.toContain('commit');
		await expect.element(textarea).toHaveValue('書きかけ');
	});

	it('Esc で隠した後に出し直しても、書きかけを残す', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);

		await textarea.fill('書きかけ');
		await userEvent.keyboard('{Escape}');
		await vi.waitFor(() => expect(commandsCalled()).toContain('dismiss'));
		emit(EVENTS.SHOWN);

		await expect.element(textarea).toHaveFocus();
		await expect.element(textarea).toHaveValue('書きかけ');
	});

	it('Esc で隠している途中に Cmd+Enter を押しても、コピーしない', async () => {
		// 隠す処理はネイティブ側で行うので、完了を待つ間にキーが届きうる
		invoked.mockImplementation((command) =>
			command === 'dismiss' ? new Promise(() => {}) : Promise.resolve(undefined)
		);
		const screen = await render(Page);
		const textarea = draftField(screen);

		await textarea.fill('書きかけ');
		await userEvent.keyboard('{Escape}');
		await vi.waitFor(() => expect(commandsCalled()).toContain('dismiss'));
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await tick();

		expect(commandsCalled()).not.toContain('commit');
		await expect.element(textarea).toHaveValue('書きかけ');
	});

	it('Mac では Cmd+, で設定ウィンドウを開く（開いていれば閉じる）', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);

		await textarea.fill('書きかけ');
		await userEvent.keyboard('{Meta>},{/Meta}');

		await vi.waitFor(() => expect(commandsCalled()).toContain('toggle_settings_window'));
		// 設定を見るだけなので、下書きはコピーせず、そのまま残す
		expect(commandsCalled()).not.toContain('commit');
		await expect.element(textarea).toHaveValue('書きかけ');
	});

	it('表示されたら入力欄にフォーカスを移す', async () => {
		const screen = await render(Page);

		emit(EVENTS.SHOWN);

		await expect.element(draftField(screen)).toHaveFocus();
	});

	it('隠すよう言われたら（前面で押したホットキー）、コピーして入力欄を空にする', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);

		await textarea.fill('git status');
		emit(EVENTS.HIDE_REQUESTED);

		await vi.waitFor(() => expect(committedText()).toBe('git status'));
		await expect.element(textarea).toHaveValue('');
	});

	it('コピーできなかったら、その旨を表示して下書きを残す', async () => {
		invoked.mockImplementation((command) =>
			command === 'commit'
				? Promise.reject(new Error('clipboard busy'))
				: Promise.resolve(undefined)
		);
		const screen = await render(Page);
		const textarea = draftField(screen);

		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

		await expect.element(screen.getByText(m.copy_failed())).toBeInTheDocument();
		await expect.element(screen.getByText('Error: clipboard busy')).toBeInTheDocument();
		await expect.element(textarea).toHaveValue('git status');
	});

	it('コピーの途中で表示し直されたら、そこで打ち直した下書きを消さない', async () => {
		// コピーはネイティブ側でウィンドウを隠すので、完了を待つ間にホットキーで出し直されうる
		let finishCommit: (() => void) | undefined;
		const commitCall = new Promise<undefined>(
			(resolve) => (finishCommit = () => resolve(undefined))
		);
		invoked.mockImplementation((command) =>
			command === 'commit' ? commitCall : Promise.resolve(undefined)
		);
		const screen = await render(Page);
		const textarea = draftField(screen);

		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await vi.waitFor(() => expect(committedText()).toBe('git status'));

		// 出し直されて、そこで打ち直す
		emit(EVENTS.SHOWN);
		await expect.element(textarea).toHaveValue('');
		await textarea.fill('打ち直した下書き');

		finishCommit?.();
		// コピーの完了と、それに続く画面の更新を待ってから見る。
		// 待たずに見ると、入力欄を空にしてしまう作りでも通ってしまう
		await commitCall;
		await tick();

		// 打ち直した内容は、前のコピーの後始末で消さない
		await expect.element(textarea).toHaveValue('打ち直した下書き');
	});

	function placeholderOf(screen: Screen) {
		return draftField(screen).element().getAttribute('placeholder');
	}

	it('案内の設定がなければ、既定の案内を今のホットキーで出す', async () => {
		const screen = await render(Page);

		expect(placeholderOf(screen)).toBe(
			draftGuidance(null, 'CommandOrControl+Shift+Space', DEFAULT_DRAFT_KEYS, 'macos')
		);
	});

	it('設定した文字色を、ライトとダークの変数として当てる', async () => {
		settings.current = { ...view(), textColorLight: '#2f4f4f', textColorDark: '#e0e0e0' };
		const screen = await render(Page);

		const style = screen.container.querySelector('main')?.getAttribute('style') ?? '';
		expect(style).toContain('--draft-text-light: #2f4f4f');
		expect(style).toContain('--draft-text-dark: #e0e0e0');
	});

	it('文字色が空なら変数を当てず、標準の文字色に任せる', async () => {
		const screen = await render(Page);

		const style = screen.container.querySelector('main')?.getAttribute('style') ?? '';
		expect(style).not.toContain('--draft-text');
	});

	it('案内を空にしていたら、何も出さない', async () => {
		settings.current = view('macos', {}, '');
		const screen = await render(Page);

		expect(placeholderOf(screen)).toBeNull();
	});
});

describe('下書きの履歴', () => {
	beforeEach(() => {
		// commit は、クリップボードへ渡したら true を返す
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'commit' ? true : undefined)
		);
		settings.current = view();
	});

	type Textbox = ReturnType<Awaited<ReturnType<typeof render>>['getByRole']>;

	/** 書いてコピーし、入力欄が空に戻るまで待つ */
	async function copy(textarea: Textbox, text: string) {
		await textarea.fill(text);
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await expect.element(textarea).toHaveValue('');
	}

	it('先頭の上キーで古い方へ出し、末尾の下キーで最後まで戻ると打っていた内容に戻す', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copy(textarea, 'git status');
		await copy(textarea, 'git diff');
		await textarea.fill('書きかけ');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);

		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git diff');
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');
		await userEvent.keyboard('{ArrowDown}');
		await expect.element(textarea).toHaveValue('git status');
		await userEvent.keyboard('{ArrowDown}');
		await expect.element(textarea).toHaveValue('git diff');
		await userEvent.keyboard('{ArrowDown}');
		await expect.element(textarea).toHaveValue('書きかけ');
	});

	it('同期で履歴が替わった知らせで読み直し、読み直している間にコピーした分を足して保存する', async () => {
		let finishReload: (entries: string[]) => void = () => {};
		let loads = 0;
		invoked.mockImplementation((command) => {
			if (command === 'commit') return Promise.resolve(true);
			if (command !== 'load_draft_history') return Promise.resolve(undefined);
			loads += 1;
			// 1回目は起動のときの読み込み
			if (loads === 1) return Promise.resolve(['git status']);
			return new Promise((resolve) => (finishReload = resolve));
		});
		const screen = await render(Page);
		const textarea = draftField(screen);
		await vi.waitFor(() => expect(loads).toBe(1));
		await tick();

		emit(EVENTS.DRAFT_HISTORY_MERGED);
		await vi.waitFor(() => expect(loads).toBe(2));
		invoked.mockClear();
		await copy(textarea, 'git push');
		// 読み直す前の一覧は保存しない
		expect(commandsCalled()).not.toContain('save_draft_history');

		finishReload(['git log', 'git status']);
		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('save_draft_history', {
				entries: ['git log', 'git status', 'git push']
			})
		);
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git push');
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git log');
	});

	it('1行目の途中の上キーは先頭へ移り、もう一度押すと履歴を出す', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copy(textarea, 'git status');
		await textarea.fill('1行目の途中');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(3, 3);

		await userEvent.keyboard('{ArrowUp}');
		await tick();
		await expect.element(textarea).toHaveValue('1行目の途中');
		expect((textarea.element() as HTMLTextAreaElement).selectionStart).toBe(0);

		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');
	});

	it('2行目以降の上キーでは履歴を出さない', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copy(textarea, 'git status');
		const text = '1行目\n2行目';
		await textarea.fill(text);
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(text.length, text.length);

		await userEvent.keyboard('{ArrowUp}');
		await tick();
		await expect.element(textarea).toHaveValue(text);
	});

	it('最終行の途中の下キーは末尾へ移り、もう一度押すと新しい履歴へ戻る', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		const element = textarea.element() as HTMLTextAreaElement;
		// 改行はないが、入力欄の幅で折り返して見た目は複数行になる
		const long = 'あ'.repeat(200);
		await copy(textarea, long);
		await textarea.fill('書きかけ');
		element.setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue(long);
		await tick();
		element.setSelectionRange(long.length - 1, long.length - 1);

		await userEvent.keyboard('{ArrowDown}');
		await tick();
		expect(element.selectionStart).toBe(long.length);
		await userEvent.keyboard('{ArrowDown}');
		await expect.element(textarea).toHaveValue('書きかけ');
	});

	it('空の入力欄では、上キー1回で履歴へ移る', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copy(textarea, 'git status');
		await textarea.fill('');

		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');
	});

	it('移る先がないときは、見た目の端へアプリからは移さない', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		const element = textarea.element() as HTMLTextAreaElement;
		await copy(textarea, 'git status');
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');
		element.setSelectionRange(2, 2);

		await userEvent.keyboard('{ArrowUp}');
		await tick();
		await expect.element(textarea).toHaveValue('git status');
		element.setSelectionRange(2, 2);
		const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
		element.dispatchEvent(up);
		expect(up.defaultPrevented).toBe(false);
		expect(element.selectionStart).toBe(2);
	});

	it('出した履歴を書き換えると、たどるのをやめ、下キーで打っていた内容に戻さない', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copy(textarea, 'git status');
		await textarea.fill('書きかけ');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);

		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');
		// 出したときのカーソルは先頭
		await userEvent.keyboard('!');
		await expect.element(textarea).toHaveValue('!git status');
		await userEvent.keyboard('{ArrowDown}');
		await tick();

		await expect.element(textarea).toHaveValue('!git status');
	});

	it('クリップボードを変えなかったコピーは覚えない', async () => {
		// 整えた結果が空になったとき
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'commit' ? false : undefined)
		);
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copy(textarea, '   ');

		await userEvent.keyboard('{ArrowUp}');
		await tick();

		await expect.element(textarea).toHaveValue('');
	});

	it('変換中の上キーでは履歴を出さない（変換候補の選択を横取りしない）', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copy(textarea, 'git status');

		pressWhileComposing(textarea.element(), 'ArrowUp');
		await tick();

		await expect.element(textarea).toHaveValue('');
	});

	it('下キーで戻したときは、カーソルを末尾に置く', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copy(textarea, 'git status');
		await textarea.fill('書きかけ');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);

		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');
		// 出した直後のカーソルは先頭なので、1回目の下キーは末尾へ移るだけ
		await userEvent.keyboard('{ArrowDown}');
		await userEvent.keyboard('{ArrowDown}');
		await expect.element(textarea).toHaveValue('書きかけ');

		const element = textarea.element() as HTMLTextAreaElement;
		await vi.waitFor(() => expect(element.selectionStart).toBe('書きかけ'.length));
	});

	it('実行中に件数を減らすと、その場で古いものから忘れる', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copy(textarea, '1');
		await copy(textarea, '2');
		await copy(textarea, '3');

		settings.current = { ...view(), textHistorySize: 1 };
		await tick();

		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('3');
		await userEvent.keyboard('{ArrowUp}');
		await tick();
		await expect.element(textarea).toHaveValue('3');
	});

	it('クリップボードを変えなかったコピーでも、たどっていた状態は終える', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copy(textarea, 'git status');
		await textarea.fill('書きかけ');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');

		// 出した履歴をコピーしたが、整えた結果が空になって、クリップボードを変えなかったとき
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'commit' ? false : undefined)
		);
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await expect.element(textarea).toHaveValue('');
		await userEvent.keyboard('{ArrowDown}');
		await tick();

		// たどり始める前の「書きかけ」は戻さない
		await expect.element(textarea).toHaveValue('');
	});

	it('コピーの完了を待つ間に打ち直しても、覚えるのはコピーに渡した内容', async () => {
		let finishCommit: (() => void) | undefined;
		invoked.mockImplementation((command) =>
			command === 'commit'
				? new Promise<boolean>((resolve) => (finishCommit = () => resolve(true)))
				: Promise.resolve(undefined)
		);
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await vi.waitFor(() => expect(finishCommit).toBeDefined());

		// 出し直されて、そこで打ち直す
		emit(EVENTS.SHOWN);
		await expect.element(textarea).toHaveValue('');
		await textarea.fill('打ち直し');
		finishCommit?.();
		await tick();
		await expect.element(textarea).toHaveValue('打ち直し');

		// カーソルは末尾なので、1回目の上キーは先頭へ移るだけ
		await userEvent.keyboard('{ArrowUp}');
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');
	});
});

describe('定型文', () => {
	const confirm = newSnippet('確認', '一つずつ質問してください。\n以上です。');
	const status = newSnippet('', 'git status');

	beforeEach(() => {
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'commit' ? true : undefined)
		);
		settings.current = { ...view(), snippets: [confirm, status] };
	});

	/** 入力欄に書き、カーソル（と選択範囲）を置いてから Cmd+K で一覧を出す */
	const openAt = (screen: Screen, value: string, start: number, end = start) =>
		openListAt(screen, value, start, end);

	function selectionOf(textarea: ReturnType<Screen['getByRole']>) {
		const element = textarea.element() as HTMLTextAreaElement;
		return [element.selectionStart, element.selectionEnd];
	}

	it('切った定型文は、一覧に出さない', async () => {
		settings.current = {
			...settings.current!,
			snippets: [confirm, { ...status, enabled: false }]
		};
		const screen = await render(Page);
		await openAt(screen, 'abc', 0);

		const options = screen.getByRole('option');
		expect(options.elements()).toHaveLength(2);
		await expect.element(options.nth(0)).toMatchTextContent('確認');
		// 残りは、テキストを定型文に登録する項目
		await expect.element(options.nth(1)).toMatchTextContent(m.snippets_register_draft());
	});

	it('Cmd+K で一覧を出し、名前と本文の1行目を並べる。名前が空なら本文の行を出す', async () => {
		const screen = await render(Page);
		await openAt(screen, '', 0);

		const options = screen.getByRole('option');
		expect(options.elements()).toHaveLength(2);
		await expect.element(options.nth(0)).toMatchTextContent('確認');
		await expect.element(options.nth(0)).toMatchTextContent('一つずつ質問してください。');
		await expect.element(options.nth(0)).not.toMatchTextContent('以上です。');
		await expect.element(options.nth(1)).toMatchTextContent('git status');
	});

	it('一覧は入力欄より手前に描き、下書きの文字が一覧の上に出ない', async () => {
		const screen = await render(Page);
		await openAt(screen, 'あいう\nえお\nかき\nくけこ', 0);

		const option = screen.getByRole('option').nth(0).element();
		const rect = option.getBoundingClientRect();
		const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		expect(screen.getByRole('dialog').element().contains(hit)).toBe(true);
	});

	it('絞り込んで Enter で、出したときのカーソルの位置に差し込み、カーソルを末尾に置く', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 2);

		await snippetSearch(screen).fill('以上');
		await userEvent.keyboard('{Enter}');

		await expect.element(textarea).toHaveValue(`あい${confirm.body}う`);
		await expect.element(textarea).toHaveFocus();
		expect(snippetSearch(screen).elements()).toHaveLength(0);
		const end = 'あい'.length + confirm.body.length;
		expect(selectionOf(textarea)).toEqual([end, end]);
	});

	it('範囲を選んでいたら、その範囲を置き換える', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 1, 2);

		await userEvent.keyboard('{Enter}');

		await expect.element(textarea).toHaveValue(`あ${confirm.body}う`);
	});

	it('↓ で次の定型文を選んで差し込む', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, '', 0);

		await userEvent.keyboard('{ArrowDown}');
		await expect
			.element(screen.getByRole('option').nth(1))
			.toHaveAttribute('aria-selected', 'true');
		await userEvent.keyboard('{Enter}');

		await expect.element(textarea).toHaveValue('git status');
	});

	it('絞り込みを変えたら、先頭を選んだ状態に戻す', async () => {
		settings.current = {
			...view(),
			snippets: [confirm, status, newSnippet('git diff', 'git diff')]
		};
		const screen = await render(Page);
		const textarea = await openAt(screen, '', 0);

		await userEvent.keyboard('{ArrowDown}{ArrowDown}');
		await snippetSearch(screen).fill('git');
		await userEvent.keyboard('{Enter}');

		await expect.element(textarea).toHaveValue('git status');
	});

	it('クリックで差し込む', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, '', 0);

		await screen.getByRole('option').nth(1).click();

		await expect.element(textarea).toHaveValue('git status');
	});

	it('Esc で一覧だけを閉じ、カーソルと範囲を出したときのまま戻す。下書きは隠さない', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 1, 2);

		await userEvent.keyboard('{Escape}');

		await expect.element(textarea).toHaveFocus();
		expect(snippetSearch(screen).elements()).toHaveLength(0);
		expect(selectionOf(textarea)).toEqual([1, 2]);
		await expect.element(textarea).toHaveValue('あいう');
		expect(commandsCalled()).not.toContain('dismiss');
	});

	it('もう一度 Cmd+K を押すと、差し込まずに閉じる', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 3);

		await userEvent.keyboard('{Meta>}k{/Meta}');

		await expect.element(textarea).toHaveFocus();
		await expect.element(textarea).toHaveValue('あいう');
	});

	it('一覧の外を押すと、差し込まずに閉じる', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 3);

		screen.container
			.querySelector('main > div[aria-hidden="true"]')
			?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

		await expect.element(textarea).toHaveFocus();
		await expect.element(textarea).toHaveValue('あいう');
	});

	it('変換中の Enter と Esc では、差し込みも閉じもしない', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 3);
		const combobox = snippetSearch(screen);

		pressWhileComposing(combobox.element(), 'Enter');
		pressWhileComposing(combobox.element(), 'Escape');
		await tick();

		await expect.element(combobox).toHaveFocus();
		await expect.element(textarea).toHaveValue('あいう');
	});

	it('一覧を出している間の Cmd+Enter では、コピーも差し込みもしない', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'git status', 0);

		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await tick();

		expect(commandsCalled()).not.toContain('commit');
		// 一覧の Enter として受け取って差し込むこともしない
		await expect.element(snippetSearch(screen)).toHaveFocus();
		await expect.element(textarea).toHaveValue('git status');
	});

	it('Tab と Shift+Tab では、一覧の外へフォーカスを移さない', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 3);

		await userEvent.keyboard('{Tab}');
		await expect.element(snippetSearch(screen)).toHaveFocus();
		await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
		await expect.element(snippetSearch(screen)).toHaveFocus();
		await expect.element(textarea).toHaveValue('あいう');
	});

	it('一致する定型文がなければ、その旨を出す', async () => {
		const screen = await render(Page);
		await openAt(screen, '', 0);

		await snippetSearch(screen).fill('zzz');

		await expect.element(screen.getByText(m.snippets_no_match())).toBeInTheDocument();
	});

	it('一覧を出したまま隠れて出し直すと、入力欄から始める', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 3);

		emit(EVENTS.SHOWN);

		await expect.element(textarea).toHaveFocus();
		expect(snippetSearch(screen).elements()).toHaveLength(0);
	});

	/** add_snippet の返事（足したか）を決める。ほかのコマンドは既定のまま */
	function answerAddSnippet(added: boolean) {
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'add_snippet' ? added : command === 'commit' ? true : undefined)
		);
	}

	/** add_snippet に渡された定型文 */
	function addedSnippets() {
		return callsOf(invoked, 'add_snippet').map(
			([, args]) => (args as { snippet: unknown }).snippet
		);
	}

	it('下書きがあれば、一覧の末尾に登録の項目を出し、選ぶと下書き全体を名前なしで登録して知らせる。下書きとカーソルはそのまま', async () => {
		answerAddSnippet(true);
		const screen = await render(Page);
		const textarea = await openAt(screen, 'よろしく\nお願いします', 2);

		const options = screen.getByRole('option');
		expect(options.elements()).toHaveLength(3);
		await expect.element(options.nth(2)).toMatchTextContent(m.snippets_register_draft());
		// 登録する本文の1行目を添える
		await expect.element(options.nth(2)).toMatchTextContent('よろしく');
		await options.nth(2).click();

		await vi.waitFor(() =>
			expect(addedSnippets()).toEqual([newSnippet('', 'よろしく\nお願いします')])
		);
		await expect.element(screen.getByText(m.draft_snippet_registered())).toBeInTheDocument();
		expect(snippetSearch(screen).elements()).toHaveLength(0);
		await expect.element(textarea).toHaveFocus();
		await expect.element(textarea).toHaveValue('よろしく\nお願いします');
		expect(selectionOf(textarea)).toEqual([2, 2]);
	});

	it('表示言語が変わったら、前の言語で出した知らせとエラーを消す', async () => {
		invoked.mockImplementation((command) =>
			command === 'add_snippet' ? Promise.reject('broken') : Promise.resolve(undefined)
		);
		const screen = await render(Page);
		await openAt(screen, 'あいう', 3);
		await screen.getByRole('option').nth(2).click();
		await expect.element(screen.getByRole('alert')).toBeInTheDocument();

		settings.current = { ...settings.current!, locale: 'en' };

		await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
	});

	it('範囲を選んでいたら、その範囲を登録する', async () => {
		answerAddSnippet(true);
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいうえお', 1, 3);

		await expect
			.element(screen.getByRole('option').nth(2))
			.toMatchTextContent(m.snippets_register_selection());
		await screen.getByRole('option').nth(2).click();

		await vi.waitFor(() => expect(addedSnippets()).toEqual([newSnippet('', 'いう')]));
		expect(selectionOf(textarea)).toEqual([1, 3]);
	});

	it('絞り込みに打った文字を名前にする。当たる定型文がなければ、その旨と登録の項目を出し、Enter で登録する', async () => {
		answerAddSnippet(true);
		const screen = await render(Page);
		await openAt(screen, 'あいう', 3);

		await snippetSearch(screen).fill(' 挨拶 ');

		await expect.element(screen.getByText(m.snippets_no_match())).toBeInTheDocument();
		const options = screen.getByRole('option');
		expect(options.elements()).toHaveLength(1);
		await expect
			.element(options.nth(0))
			.toMatchTextContent(m.snippets_register_draft_named({ name: '挨拶' }));
		await userEvent.keyboard('{Enter}');

		await vi.waitFor(() => expect(addedSnippets()).toEqual([newSnippet('挨拶', 'あいう')]));
	});

	it('当たる定型文があれば、Enter では定型文を差し込み、登録しない', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 3);

		await snippetSearch(screen).fill('git');
		await userEvent.keyboard('{Enter}');

		await expect.element(textarea).toHaveValue('あいうgit status');
		expect(commandsCalled()).not.toContain('add_snippet');
	});

	it('同じ本文の定型文がもうあれば、そう知らせる', async () => {
		answerAddSnippet(false);
		const screen = await render(Page);
		await openAt(screen, 'git status', 0);

		await screen.getByRole('option').nth(2).click();

		await expect
			.element(screen.getByText(m.draft_snippet_already_registered()))
			.toBeInTheDocument();
	});

	it('下書きが空か空白だけなら、登録の項目を出さない', async () => {
		const screen = await render(Page);
		await openAt(screen, ' \n　', 0);

		expect(screen.getByRole('option').elements()).toHaveLength(2);
		expect(screen.getByText(m.snippets_register_draft()).elements()).toHaveLength(0);
	});

	it('定型文がなくても、下書きがあれば登録を促す文と登録の項目を出す', async () => {
		settings.current = { ...view(), snippets: [] };
		const screen = await render(Page);
		await openAt(screen, 'あいう', 3);

		await expect
			.element(screen.getByText(m.snippets_empty({ settings: '⌘,' })))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole('option').nth(0))
			.toMatchTextContent(m.snippets_register_draft());
	});

	it('登録できなければ、エラーの帯で知らせる', async () => {
		invoked.mockImplementation((command) =>
			command === 'add_snippet' ? Promise.reject('disk full') : Promise.resolve(undefined)
		);
		const screen = await render(Page);
		await openAt(screen, 'あいう', 3);

		await screen.getByRole('option').nth(2).click();

		await expect.element(screen.getByText(m.draft_snippet_register_failed())).toBeInTheDocument();
		expect(screen.getByText(m.draft_snippet_registered()).elements()).toHaveLength(0);
	});

	it('登録した知らせは、出し直したら消す', async () => {
		answerAddSnippet(true);
		const screen = await render(Page);
		await openAt(screen, 'あいう', 3);
		await screen.getByRole('option').nth(2).click();
		await expect.element(screen.getByText(m.draft_snippet_registered())).toBeInTheDocument();

		emit(EVENTS.SHOWN);

		await expect.element(screen.getByText(m.draft_snippet_registered())).not.toBeInTheDocument();
	});

	it('差し込みは、入力欄の取り消しで戻せる', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 2);
		await userEvent.keyboard('{Enter}');
		await expect.element(textarea).toHaveValue(`あい${confirm.body}う`);

		document.execCommand('undo');

		await expect.element(textarea).toHaveValue('あいう');
	});

	it('差し込むと、履歴をたどっている途中ならそこでやめる', async () => {
		settings.current = { ...view(), snippets: [newSnippet('管理者で', 'sudo ')] };
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await expect.element(textarea).toHaveValue('');
		await textarea.fill('書きかけ');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');

		// 出した履歴のカーソルは先頭。そこに差し込む
		await userEvent.keyboard('{Meta>}k{/Meta}');
		await expect.element(snippetSearch(screen)).toHaveFocus();
		await userEvent.keyboard('{Enter}');
		await expect.element(textarea).toHaveValue('sudo git status');
		// 1行だけなので、たどっている途中なら下キーで「書きかけ」に戻ってしまう
		await userEvent.keyboard('{ArrowDown}');
		await tick();

		await expect.element(textarea).toHaveValue('sudo git status');
	});
});

describe('下書きのボタン', () => {
	beforeEach(() => {
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'commit' ? true : undefined)
		);
		settings.current = { ...view(), snippets: [newSnippet('確認', '以上です。')] };
	});

	const copyButton = (screen: Screen) =>
		screen.getByRole('button', { name: m.draft_copy(), exact: false });
	const olderButton = (screen: Screen) =>
		screen.getByRole('button', { name: m.draft_history_older(), exact: true });
	const newerButton = (screen: Screen) =>
		screen.getByRole('button', { name: m.draft_history_newer(), exact: true });

	/** 書いてコピーのボタンを押し、入力欄が空に戻るまで待つ */
	async function copyWithButton(screen: Screen, text: string) {
		const textarea = draftField(screen);
		await textarea.fill(text);
		await copyButton(screen).click();
		await expect.element(textarea).toHaveValue('');
	}

	it('コピーを押すと、書いた内容でコピーする', async () => {
		const screen = await render(Page);

		await copyWithButton(screen, 'git status');

		expect(committedText()).toBe('git status');
	});

	it('コピーには、コピーのキーを添える', async () => {
		const screen = await render(Page);

		await expect.element(copyButton(screen)).toMatchTextContent('⌘');
		await expect.element(copyButton(screen)).toMatchTextContent('Enter');
	});

	it('定型文を押すと一覧を出し、押す前のカーソルの位置に差し込んで、入力欄にフォーカスを戻す', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('あいう');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(2, 2);

		await screen.getByRole('button', { name: m.draft_snippets(), exact: true }).click();
		await expect.element(snippetSearch(screen)).toHaveFocus();
		await userEvent.keyboard('{Enter}');

		await expect.element(textarea).toHaveValue('あい以上です。う');
		await expect.element(textarea).toHaveFocus();
	});

	it('設定を押すと、設定ウィンドウを開く', async () => {
		const screen = await render(Page);

		await screen.getByRole('button', { name: m.draft_settings(), exact: true }).click();

		expect(commandsCalled()).toContain('open_settings_window');
	});

	it('定型文と設定の説明に、キーを出す', async () => {
		const screen = await render(Page);

		await expect
			.element(screen.getByRole('button', { name: m.draft_snippets(), exact: true }))
			.toHaveAttribute('title', m.key_hint({ label: m.draft_snippets_hint(), keys: '⌘K' }));
		await expect
			.element(screen.getByRole('button', { name: m.draft_settings(), exact: true }))
			.toHaveAttribute('title', m.key_hint({ label: m.draft_settings_hint(), keys: '⌘,' }));
	});

	it('コピーのキーを外したら、コピーのボタンにキーを添えない', async () => {
		settings.current = { ...view(), textWindowKeys: { ...DEFAULT_DRAFT_KEYS, copy: '' } };
		const screen = await render(Page);

		await expect
			.element(screen.getByRole('button', { name: m.draft_copy(), exact: true }))
			.toBeVisible();
	});

	it('覚えている履歴がなければ前と次を出さず、コピーすると出す', async () => {
		const screen = await render(Page);
		await expect.element(copyButton(screen)).toBeVisible();
		expect(olderButton(screen).elements()).toHaveLength(0);

		await copyWithButton(screen, 'git status');

		await expect.element(olderButton(screen)).toBeVisible();
		await expect.element(newerButton(screen)).toBeVisible();
	});

	it('前と次で、カーソルの行にかかわらず履歴を移り、入力欄にフォーカスを戻す。移る先がなければ押せない', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copyWithButton(screen, 'git status');
		await copyWithButton(screen, 'git diff');
		// カーソルは最終行（2行目）にあり、↑ キーなら行を移るだけの位置
		await textarea.fill('1行目\n2行目');
		await expect.element(newerButton(screen)).toBeDisabled();

		await olderButton(screen).click();
		await expect.element(textarea).toHaveValue('git diff');
		await expect.element(textarea).toHaveFocus();
		await olderButton(screen).click();
		await expect.element(textarea).toHaveValue('git status');
		await expect.element(olderButton(screen)).toBeDisabled();

		await newerButton(screen).click();
		await expect.element(textarea).toHaveValue('git diff');
		await newerButton(screen).click();
		await expect.element(textarea).toHaveValue('1行目\n2行目');
		await expect.element(newerButton(screen)).toBeDisabled();
		await expect.element(olderButton(screen)).toBeEnabled();
	});

	it('設定でオフにすると、上下どちらのボタンも出さない', async () => {
		settings.current = { ...view(), showTextWindowButtons: false };
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await expect.element(textarea).toHaveValue('');

		expect(screen.getByRole('button').elements()).toHaveLength(0);
	});

	it('コピーを押して失敗したら、入力欄にフォーカスを戻す', async () => {
		invoked.mockImplementation((command) =>
			command === 'commit'
				? Promise.reject(new Error('clipboard busy'))
				: Promise.resolve(undefined)
		);
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('git status');

		await copyButton(screen).click();

		await expect.element(screen.getByText(m.copy_failed())).toBeVisible();
		await expect.element(textarea).toHaveFocus();
	});

	it('Tab と Shift+Tab では、ボタンにフォーカスを移さない', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await copyWithButton(screen, 'git status');
		await expect.element(olderButton(screen)).toBeVisible();
		const buttons = screen.getByRole('button').elements();

		for (const key of ['{Tab}', '{Shift>}{Tab}{/Shift}']) {
			(textarea.element() as HTMLTextAreaElement).focus();
			await userEvent.keyboard(key);
			expect(buttons, key).not.toContain(document.activeElement);
		}
	});
});

describe('キー操作', () => {
	beforeEach(() => {
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'commit' ? true : undefined)
		);
		settings.current = view();
	});

	it('設定で変えたキーでコピーし、元のキーではコピーしない', async () => {
		settings.current = {
			...view(),
			textWindowKeys: { ...DEFAULT_DRAFT_KEYS, copy: 'CommandOrControl+KeyK', snippets: '' }
		};
		const screen = await render(Page);
		const textarea = draftField(screen);

		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		expect(invoked).not.toHaveBeenCalledWith('commit', expect.anything());

		await userEvent.keyboard('{Meta>}k{/Meta}');
		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('commit', { text: 'git status' }));
	});

	it('前の履歴・次の履歴のキーは、カーソルの行にかかわらず移る', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await expect.element(textarea).toHaveValue('');

		// カーソルは2行目の末尾にあり、↑ なら行を移るだけの位置
		await textarea.fill('one\ntwo');
		await userEvent.keyboard('{Alt>}{Meta>}{ArrowUp}{/Meta}{/Alt}');
		await expect.element(textarea).toHaveValue('git status');

		await userEvent.keyboard('{Alt>}{Meta>}{ArrowDown}{/Meta}{/Alt}');
		await expect.element(textarea).toHaveValue('one\ntwo');
	});

	it('今は使えない操作のキー（履歴が無いときの前の履歴）では何もせず、既定の動作も止める', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('draft');

		const event = new KeyboardEvent('keydown', {
			code: 'ArrowUp',
			key: 'ArrowUp',
			metaKey: true,
			altKey: true,
			bubbles: true,
			cancelable: true
		});
		textarea.element().dispatchEvent(event);

		// WebView の既定のキーに渡さない（WebView2 の Ctrl+J のように、下書きからフォーカスが外れることがある）
		expect(event.defaultPrevented).toBe(true);
		await expect.element(textarea).toHaveValue('draft');
		expect(commandsCalled()).not.toContain('commit');
	});

	it('Windows では、印刷・ページ内検索・キャレットブラウズのキーの既定の動作を止める', async () => {
		settings.current = view('windows');
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('draft');
		const press = (init: KeyboardEventInit) => {
			const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
			textarea.element().dispatchEvent(event);
			return event.defaultPrevented;
		};

		for (const init of [
			{ code: 'KeyP', key: 'p', ctrlKey: true },
			{ code: 'KeyF', key: 'f', ctrlKey: true },
			{ code: 'KeyG', key: 'g', ctrlKey: true },
			{ code: 'F3', key: 'F3' },
			{ code: 'F7', key: 'F7' }
		]) {
			expect(press(init), init.key).toBe(true);
		}
	});

	it('macOS では、Ctrl+F・Ctrl+P を入力欄のカーソル移動に残す', async () => {
		settings.current = view('macos');
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('draft');
		const event = new KeyboardEvent('keydown', {
			code: 'KeyF',
			key: 'f',
			ctrlKey: true,
			bubbles: true,
			cancelable: true
		});
		textarea.element().dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
	});

	it('読み込み直すキー（F5・Ctrl+R）は、入力欄でも一覧でも既定の動作を止め、下書きを残す', async () => {
		settings.current = view('windows');
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('draft');
		const reloadKeys = [
			{ code: 'F5', key: 'F5' },
			{ code: 'F5', key: 'F5', ctrlKey: true },
			{ code: 'KeyR', key: 'r', ctrlKey: true },
			{ code: 'KeyR', key: 'R', ctrlKey: true, shiftKey: true }
		];
		const press = (target: Element, init: KeyboardEventInit) => {
			const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
			target.dispatchEvent(event);
			return event.defaultPrevented;
		};

		for (const init of reloadKeys) expect(press(textarea.element(), init), init.key).toBe(true);
		await textarea.click();
		await userEvent.keyboard('{Control>}k{/Control}');
		const search = snippetSearch(screen);
		await expect.element(search).toHaveFocus();
		for (const init of reloadKeys) expect(press(search.element(), init), init.key).toBe(true);

		await expect.element(textarea).toHaveValue('draft');
	});

	it('一覧を開いている間も、ほかの操作のキーの既定の動作を止める', async () => {
		const screen = await render(Page);
		await draftField(screen).click();
		await userEvent.keyboard('{Meta>}k{/Meta}');
		const search = snippetSearch(screen);
		await expect.element(search).toHaveFocus();

		// 設定を開くキー。定型文の一覧の中では、一覧の操作でも閉じるキーでもない
		const event = new KeyboardEvent('keydown', {
			code: 'Comma',
			key: ',',
			metaKey: true,
			bubbles: true,
			cancelable: true
		});
		search.element().dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		await expect.element(search).toBeVisible();
		expect(commandsCalled()).not.toContain('toggle_settings_window');
	});

	it('余白をクリックして入力欄からフォーカスが外れても、Esc で隠し、操作のキーでコピーする', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('git status');
		(document.activeElement as HTMLElement).blur();
		expect(document.activeElement).toBe(document.body);

		await userEvent.keyboard('{Escape}');
		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('dismiss'));

		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('commit', { text: 'git status' }));
	});

	it('入力欄の Tab はタブ文字を入れ、フォーカスを入力欄に残す', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('a');

		await userEvent.keyboard('{Tab}b');

		await expect.element(textarea).toHaveValue('a\tb');
		expect(document.activeElement).toBe(textarea.element());
	});

	it('打っている最中に余白を押しても、入力欄からフォーカスを外さない', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.click();

		const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
		document.querySelector('main')!.dispatchEvent(press);

		expect(press.defaultPrevented).toBe(true);
	});

	it('余白をクリックしてフォーカスが外れた後に打った文字は、入力欄に入る', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('git');
		(document.activeElement as HTMLElement).blur();

		await userEvent.keyboard(' status');

		await expect.element(textarea).toHaveValue('git status');
		expect(document.activeElement).toBe(textarea.element());
	});
});
