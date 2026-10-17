import { invoke } from '@tauri-apps/api/core';
import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { draftGuidance } from '$lib/guidance';
import { m } from '$lib/paraglide/messages';
import { type Platform } from '$lib/keys';
import {
	settings,
	type ActionEncoding,
	type ActionOutput,
	type SettingsView,
	type Snippet
} from '$lib/settings.svelte';
import { EVENTS } from '$lib/bindings/constants';
import { callsOf } from '$lib/test-support/calls';
import { newSnippet } from '$lib/snippets';
import { aiSnippet as ai, DEFAULT_DRAFT_KEYS, settingsView } from '$lib/test-support/settings-view';
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

function snippet(id: string, name: string, body: string): Snippet {
	return { ...newSnippet(name, body), id };
}

/** Rust 側から届くイベントを起こす */
function emit(
	name:
		| typeof EVENTS.SHOWN
		| typeof EVENTS.HIDE_REQUESTED
		| typeof EVENTS.DRAFT_HIDDEN
		| typeof EVENTS.DRAFT_HISTORY_SYNCED,
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

/** 入力欄。宛先の候補を出すので role は combobox で、一覧の絞り込みの欄と重なる。ラベルで引く */
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

		emit(EVENTS.DRAFT_HISTORY_SYNCED);
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
	const confirm = snippet('confirm', '確認', '一つずつ質問してください。\n以上です。');
	const status = snippet('status', '', 'git status');

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
			snippets: [confirm, status, snippet('diff', 'git diff', 'git diff')]
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
		settings.current = { ...view(), snippets: [snippet('sudo', '管理者で', 'sudo ')] };
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
		settings.current = { ...view(), snippets: [snippet('confirm', '確認', '以上です。')] };
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

		// フォルダーを移る欄を出すキー。定型文の一覧の中では、一覧の操作でも閉じるキーでもない
		const event = new KeyboardEvent('keydown', {
			code: 'KeyD',
			key: 'd',
			metaKey: true,
			bubbles: true,
			cancelable: true
		});
		search.element().dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		await expect.element(search).toBeVisible();
		expect(commandsCalled()).not.toContain('current_folder');
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
});

describe('宛先へ出す', () => {
	const business = ai('ビジネス向け', '丁寧な文に書き直してください。');
	const fix = ai('', '誤字を直してください。');

	type RunArgs = {
		request: number;
		text: string;
		line: string;
		output: ActionOutput;
		encoding: ActionEncoding;
	};
	/** 返事を後から返せる run_action の呼び出し */
	let actionRuns: {
		args: RunArgs;
		resolve: (text: string) => void;
		reject: (error: unknown) => void;
	}[];
	let nextRequest: number;

	beforeEach(() => {
		actionRuns = [];
		nextRequest = 1;
		invoked.mockImplementation((command, args) => {
			if (command === 'begin_action') return Promise.resolve(nextRequest++);
			if (command === 'run_action') {
				return new Promise((resolve, reject) =>
					actionRuns.push({ args: args as RunArgs, resolve, reject })
				);
			}
			return Promise.resolve(command === 'commit' ? true : undefined);
		});
		settings.current = {
			...view(),
			aiService: 'gemini',
			snippets: [business, fix]
		};
	});

	/** 入力欄に書き、範囲を選んでから Cmd+K で定型文の一覧を出す */
	const openAt = (screen: Screen, value: string, start = 0, end = start) =>
		openListAt(screen, value, start, end);

	/** 定型文を選び、run_action が呼ばれるまで待つ */
	async function pick(index = 0) {
		for (let i = 0; i < index; i++) await userEvent.keyboard('{ArrowDown}');
		await userEvent.keyboard('{Enter}');
		await vi.waitFor(() => expect(actionRuns).toHaveLength(1));
		return actionRuns[0];
	}

	it('1行目が @sh のテキストは、コピーのキーで、コピーせずに2行目から下を渡して実行し、結果でテキスト全体を置き換えて、出す前のテキストを履歴に積む', async () => {
		settings.current = view();
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('@sh sort\nb\na');
		// コピーのボタンは、実行の表示に変わる
		await expect
			.element(screen.getByRole('button', { name: m.draft_run(), exact: false }))
			.toBeVisible();
		expect(screen.getByRole('button', { name: m.draft_copy(), exact: false }).query()).toBeNull();

		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await vi.waitFor(() => expect(actionRuns).toHaveLength(1));
		expect(commandsCalled()).not.toContain('commit');
		expect(actionRuns[0].args).toEqual({
			request: 1,
			text: 'b\na',
			line: '@sh sort',
			output: 'replace',
			encoding: 'utf-8'
		});
		actionRuns[0].resolve('a\nb');

		await expect.element(textarea).toHaveValue('a\nb');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('@sh sort\nb\na');
	});

	it('1行目が @ai・@sh でないテキストでは、ボタンはコピーの表示のままで、コピーのキーでコピーする', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('@all\nあとで見る');
		expect(screen.getByRole('button', { name: m.draft_run(), exact: false }).query()).toBeNull();

		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('commit', { text: '@all\nあとで見る' })
		);
		expect(commandsCalled()).not.toContain('begin_action');
	});

	it('1行目で @ を打つと宛先の候補を出し、Esc では候補だけを閉じ、Tab で選んだ候補を1行目に入れる', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		const candidates = screen.getByRole('listbox', { name: m.draft_address_list() });
		await textarea.click();

		await userEvent.keyboard('@');
		await expect.element(candidates).toBeVisible();
		expect(candidates.getByRole('option').elements()).toHaveLength(2);

		await userEvent.keyboard('{Escape}');
		await expect.element(candidates).not.toBeInTheDocument();
		expect(commandsCalled()).not.toContain('dismiss');

		// 続けて打つと、また候補を出す
		await userEvent.keyboard('s');
		await expect.element(candidates.getByRole('option')).toMatchTextContent('@sh');
		await userEvent.keyboard('{Tab}');

		await expect.element(textarea).toHaveValue('@sh ');
		await expect.element(textarea).toHaveFocus();
		await expect.element(candidates).not.toBeInTheDocument();
	});

	it('一覧で、1行だけで宛先から始まる定型文を選ぶと実行し、ほかの定型文を選ぶと挿入する。AI サービスが「使わない」でも一覧に出す', async () => {
		const upper = newSnippet('大文字に', '@sh tr a-z A-Z');
		const greeting = newSnippet('挨拶', 'お疲れさまです。');
		settings.current = {
			...settings.current!,
			aiService: 'none',
			snippets: [business, upper, greeting]
		};
		const screen = await render(Page);
		const textarea = await openAt(screen, 'abc');
		// 3件と、テキストを定型文に登録する項目
		expect(screen.getByRole('option').elements()).toHaveLength(4);

		const call = await pick(1);
		expect(call.args).toEqual({
			request: 1,
			text: 'abc',
			line: '@sh tr a-z A-Z',
			output: 'replace',
			encoding: 'utf-8'
		});
		call.resolve('ABC');
		await expect.element(textarea).toHaveValue('ABC');

		await userEvent.keyboard('{Meta>}k{/Meta}');
		await expect.element(snippetSearch(screen)).toHaveFocus();
		await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
		await expect.element(textarea).toHaveValue('ABCお疲れさまです。');
		expect(actionRuns).toHaveLength(1);
	});

	it('切った定型文は、一覧に出さない', async () => {
		settings.current = {
			...settings.current!,
			snippets: [business, { ...newSnippet('大文字に', '@sh tr a-z A-Z'), enabled: false }]
		};
		const screen = await render(Page);
		await openAt(screen, 'abc');

		const options = screen.getByRole('option');
		expect(options.elements()).toHaveLength(2);
		await expect.element(options.nth(0)).toMatchTextContent('ビジネス向け');
		// 残りは、テキストを定型文に登録する項目
		await expect.element(options.nth(1)).toMatchTextContent(m.snippets_register_draft());
	});

	it('AI が使えない状態で @ai の定型文を選ぶと、失敗の帯で AI を使える状態にするよう知らせ、入力欄は元のまま', async () => {
		settings.current = { ...settings.current!, aiService: 'none' };
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう');

		const call = await pick();
		expect(call.args.line).toBe(business.body);
		call.reject({ code: 'action.disabled', detail: 'AI is not set up' });

		await expect
			.element(screen.getByText(m.action_error_disabled(), { exact: false }))
			.toBeInTheDocument();
		await expect.element(textarea).toHaveValue('あいう');
	});

	it('Cmd+K で一覧を出し、宛先で始まる定型文を選ぶと全体を渡して実行し、結果で差し替えて前の文を履歴に積む', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'えーと、明日なんですけど');

		const call = await pick();
		expect(call.args).toEqual({
			request: 1,
			text: 'えーと、明日なんですけど',
			line: business.body,
			output: 'replace',
			encoding: 'utf-8'
		});
		call.resolve('明日の件でご相談です。');

		await expect.element(textarea).toHaveValue('明日の件でご相談です。');
		await expect.element(textarea).toHaveFocus();
		expect(commandsCalled()).not.toContain('commit');
		// 先頭で上キーを押すと、差し替える前の文が出る
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('えーと、明日なんですけど');
	});

	it('範囲を選んでいたら、その範囲だけを渡して差し替える', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいうえお', 1, 3);

		const call = await pick(1);
		expect(call.args.text).toBe('いう');
		expect(call.args.line).toBe(fix.body);
		call.resolve('イウ');

		await expect.element(textarea).toHaveValue('あイウえお');
	});

	it('選んだ範囲の前後の改行は、書き直した文の前後に残す', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう\n\nえお', 0, 5);

		const call = await pick(1);
		// 前後の空白と改行は渡さない
		expect(call.args.text).toBe('あいう');
		call.resolve('アイウ');

		await expect.element(textarea).toHaveValue('アイウ\n\nえお');
	});

	it('実行する文が空でも実行する', async () => {
		const screen = await render(Page);
		await openAt(screen, '  \n');

		const call = await pick();

		expect(call.args.text).toBe('');
	});

	it('出し方が「挿入」なら、範囲を選んでいればその後ろに、なければカーソルの位置に結果を入れる', async () => {
		settings.current = {
			...settings.current!,
			snippets: [{ ...newSnippet('日付', '@sh date'), output: 'insert' }]
		};
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいうえお', 1, 3);
		const call = await pick();
		expect(call.args.text).toBe('いう');
		expect(call.args.output).toBe('insert');
		call.resolve('[結果]');
		await expect.element(textarea).toHaveValue('あいう[結果]えお');

		actionRuns = [];
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(1, 1);
		await userEvent.keyboard('{Meta>}k{/Meta}');
		const second = await pick();
		second.resolve('!');
		await expect.element(textarea).toHaveValue('あ!いう[結果]えお');
	});

	it('出し方が「出さない」なら、下書きを変えず、実行したことを知らせる', async () => {
		settings.current = {
			...settings.current!,
			snippets: [{ ...newSnippet('記録', '@sh cat >> ~/log.txt'), output: 'none' }]
		};
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう');
		const call = await pick();
		call.resolve('');

		await expect
			.element(screen.getByText(m.draft_action_done({ action: '記録' })))
			.toBeInTheDocument();
		await expect.element(textarea).toHaveValue('あいう');
		await expect.element(textarea).not.toHaveAttribute('readonly');
	});

	it('実行している間は、入力欄を編集できず、状態を出し、ほかのキーとボタンは効かない', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう');
		await pick();

		await expect.element(textarea).toHaveAttribute('readonly');
		await expect
			.element(screen.getByText(m.draft_running_action({ action: 'ビジネス向け' })))
			.toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: m.draft_copy(), exact: false }))
			.toBeDisabled();
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await userEvent.keyboard('{Meta>}k{/Meta}');
		await tick();

		expect(commandsCalled()).not.toContain('commit');
		expect(snippetSearch(screen).elements()).toHaveLength(0);
	});

	it('Esc で取り消し、元の文のまま編集できる状態に戻す。隠さず、遅れて届いた結果は入れない', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう');
		const call = await pick();

		await userEvent.keyboard('{Escape}');

		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('cancel_action', { request: 1 }));
		expect(commandsCalled()).not.toContain('dismiss');
		await expect.element(textarea).not.toHaveAttribute('readonly');
		await expect
			.element(screen.getByText(m.draft_running_action({ action: 'ビジネス向け' })))
			.not.toBeInTheDocument();

		call.resolve('遅れて届いた結果');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();
		await expect.element(textarea).toHaveValue('あいう');
	});

	it('実行中の表示の「取り消す」ボタンでも取り消し、入力欄に戻る', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう');
		await pick();

		await screen.getByRole('button', { name: m.draft_cancel_action() }).click();

		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('cancel_action', { request: 1 }));
		await expect.element(textarea).not.toHaveAttribute('readonly');
		await expect.element(textarea).toHaveFocus();
		expect(screen.getByRole('button', { name: m.draft_cancel_action() }).elements()).toHaveLength(
			0
		);
	});

	it('取り消しで返った失敗は、知らせない', async () => {
		const screen = await render(Page);
		await openAt(screen, 'あいう');
		const call = await pick();

		call.reject({ code: 'action.cancelled', detail: null });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();

		expect(screen.getByText(m.action_failed()).elements()).toHaveLength(0);
	});

	it('失敗したら、元の文のまま帯で知らせて入力欄にフォーカスを戻し、次の実行を始めると帯を消す', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう');
		(await pick()).reject({ code: 'action.invalid_key', detail: null });

		await expect.element(screen.getByText(m.action_failed())).toBeVisible();
		await expect.element(screen.getByText(m.action_error_invalid_key())).toBeVisible();
		await expect.element(textarea).toHaveValue('あいう');
		await expect.element(textarea).toHaveFocus();
		await expect.element(textarea).not.toHaveAttribute('readonly');

		actionRuns = [];
		await userEvent.keyboard('{Meta>}k{/Meta}');
		await expect.element(snippetSearch(screen)).toHaveFocus();
		await pick();

		await expect.element(screen.getByText(m.action_failed())).not.toBeInTheDocument();
	});

	it('残高が尽きたときは、帯から料金ページを開ける', async () => {
		const screen = await render(Page);
		await openAt(screen, 'あいう');
		(await pick()).reject({ code: 'action.no_credit', detail: null });

		await screen.getByRole('button', { name: m.settings_mawok_buy() }).click();
		expect(callsOf(invoked, 'open_mawok_buy_page')).toHaveLength(1);
	});

	it('AI を使える状態でないときは、帯から設定の「AI」を開ける', async () => {
		const screen = await render(Page);
		await openAt(screen, 'あいう');
		(await pick()).reject({ code: 'action.disabled', detail: null });

		await screen.getByRole('button', { name: m.action_open_ai_settings() }).click();
		expect(callsOf(invoked, 'open_ai_settings')).toHaveLength(1);
	});

	it('失敗の帯は、コピーが成功したら消える', async () => {
		const screen = await render(Page);
		await openAt(screen, 'あいう');
		(await pick()).reject({ code: 'action.network', detail: null });
		await expect.element(screen.getByText(m.action_failed())).toBeVisible();

		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

		await expect.element(screen.getByText(m.action_failed())).not.toBeInTheDocument();
	});

	it('実行している間に隠すよう言われたら（前面で押したホットキー）、取り消さずにコピーせずに隠す', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう');
		await pick();

		emit(EVENTS.HIDE_REQUESTED);

		await vi.waitFor(() => expect(commandsCalled()).toContain('dismiss'));
		expect(commandsCalled()).not.toContain('cancel_action');
		expect(commandsCalled()).not.toContain('commit');
		await expect.element(textarea).toHaveValue('あいう');
	});

	it('隠れても実行は取り消さず、隠れている間に届いた結果は、出し直したときに差し替える', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう');
		const call = await pick();

		emit(EVENTS.DRAFT_HIDDEN);
		call.resolve('アイウ');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();

		expect(commandsCalled()).not.toContain('cancel_action');
		await expect.element(textarea).toHaveValue('あいう');

		// 隠れている間に終わったことを、OS の通知で知らせる
		expect(invoked).toHaveBeenCalledWith('notify_action_finished', {
			message: m.action_notify_done({ action: 'ビジネス向け' })
		});

		emit(EVENTS.SHOWN);

		await expect.element(textarea).toHaveValue('アイウ');
		await expect.element(textarea).toHaveFocus();
	});

	it('隠れている間に失敗したら、失敗を OS の通知で知らせる。見ている間に終わったら通知しない', async () => {
		const screen = await render(Page);
		await openAt(screen, 'あいう');
		const first = await pick();
		first.resolve('アイウ');
		await expect.element(draftField(screen)).toHaveValue('アイウ');
		expect(commandsCalled()).not.toContain('notify_action_finished');

		actionRuns = [];
		await openAt(screen, 'えお');
		const second = await pick();
		emit(EVENTS.DRAFT_HIDDEN);
		second.reject({ code: 'action.network', detail: null });

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('notify_action_finished', {
				message: m.action_notify_failed({ action: 'ビジネス向け' })
			})
		);
	});

	it('番号を受け取る前に取り消したら、受け取った番号で取り消しを伝え、実行を始めない', async () => {
		let beginAction: (request: number) => void = () => {};
		const base = invoked.getMockImplementation()!;
		invoked.mockImplementation((command, args) =>
			command === 'begin_action'
				? new Promise((resolve) => (beginAction = resolve))
				: base(command, args)
		);
		const screen = await render(Page);
		await openAt(screen, 'あいう');
		await userEvent.keyboard('{Enter}');
		await vi.waitFor(() => expect(commandsCalled()).toContain('begin_action'));

		await userEvent.keyboard('{Escape}');
		beginAction(7);

		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('cancel_action', { request: 7 }));
		expect(commandsCalled()).not.toContain('run_action');
	});

	it('差し替えは、入力欄の取り消しで戻せる', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう');
		(await pick()).resolve('アイウ');
		await expect.element(textarea).toHaveValue('アイウ');

		document.execCommand('undo');

		await expect.element(textarea).toHaveValue('あいう');
	});

	it('履歴から呼び出して書き換えていない文を実行したら、履歴に積まず、たどるのをやめる', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await expect.element(textarea).toHaveValue('');
		await textarea.fill('書きかけ');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');

		await userEvent.keyboard('{Meta>}k{/Meta}');
		await expect.element(snippetSearch(screen)).toHaveFocus();
		(await pick()).resolve('Git Status');
		await expect.element(textarea).toHaveValue('Git Status');

		// たどるのをやめたので、下キーで「書きかけ」に戻らない
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowDown}');
		await tick();
		await expect.element(textarea).toHaveValue('Git Status');
		// 積んでいないので、上キーで出るのはコピーした git status だけ
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');
		await userEvent.keyboard('{ArrowUp}');
		await tick();
		await expect.element(textarea).toHaveValue('git status');
	});
});

describe('書きかけのあるなしを知らせる', () => {
	beforeEach(() => {
		invoked.mockImplementation(() => Promise.resolve(undefined));
	});

	const reported = () =>
		callsOf(invoked, 'set_draft_has_text').map(
			([, args]) => (args as { hasText: boolean }).hasText
		);

	it('Mac では、空かどうかが変わったときだけ知らせる', async () => {
		settings.current = view('macos');
		const screen = await render(Page);
		const textarea = draftField(screen);

		await vi.waitFor(() => expect(reported()).toEqual([false]));
		await textarea.fill('書きかけ');
		await textarea.fill('書きかけの文');
		await vi.waitFor(() => expect(reported()).toEqual([false, true]));
		await textarea.fill('');
		await vi.waitFor(() => expect(reported()).toEqual([false, true, false]));
	});

	it('Windows では知らせない', async () => {
		settings.current = view('windows');
		const screen = await render(Page);

		await draftField(screen).fill('書きかけ');
		await tick();
		expect(reported()).toEqual([]);
	});
});

describe('作業フォルダー', () => {
	let changeResult: () => Promise<unknown>;
	let menuResult: unknown;

	beforeEach(() => {
		changeResult = () => Promise.resolve(undefined);
		menuResult = {
			current: { name: 'notes', display: '~/notes', path: '/home/notes' },
			atHome: false,
			recent: [
				{ name: 'notes', display: '~/notes', path: '/home/notes' },
				{ name: 'work', display: '~/work', path: '/home/work' }
			]
		};
		invoked.mockImplementation((command, args) => {
			if (command === 'current_folder') return Promise.resolve('~/notes');
			if (command === 'change_folder') return changeResult();
			if (command === 'pick_folder') return Promise.resolve(true);
			if (command === 'folder_menu') return Promise.resolve(menuResult);
			if (command === 'complete_folder') {
				const { input } = args as { input: string };
				if (input === '~/notes/d')
					return Promise.resolve({
						input: '~/notes/Do',
						base: '~/notes/',
						candidates: ['Documents/', 'Downloads/'],
						total: 102
					});
				if (input === '~/notes/wo')
					return Promise.resolve({
						input: '~/notes/Work/',
						base: '~/notes/',
						candidates: [],
						total: 0
					});
				return Promise.resolve({ input, base: '', candidates: [], total: 0 });
			}
			return Promise.resolve(undefined);
		});
		settings.current = view();
	});

	it('キーで、今のフォルダーを選んだ状態の欄を出し、打ったパスで Enter を押すと移って入力欄に戻る', async () => {
		const screen = await render(Page);
		const textarea = draftField(screen);
		await textarea.fill('あいう');
		await userEvent.keyboard('{Meta>}d{/Meta}');

		const input = screen.getByRole('combobox', { name: m.folder_input() });
		await expect.element(input).toHaveFocus();
		await expect.element(input).toHaveValue('~/notes');
		const element = input.element() as HTMLInputElement;
		expect([element.selectionStart, element.selectionEnd]).toEqual([0, '~/notes'.length]);

		await userEvent.keyboard('work{Enter}');

		await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
		expect(callsOf(invoked, 'change_folder').at(-1)?.[1]).toEqual({ input: 'work' });
		await expect.element(textarea).toHaveFocus();
	});

	it('移れなければ欄を出したまま理由を出し、打ち直すと消す', async () => {
		changeResult = () => Promise.reject('folder.not_found');
		const screen = await render(Page);
		await userEvent.keyboard('{Meta>}d{/Meta}');
		await expect.element(screen.getByRole('combobox', { name: m.folder_input() })).toHaveFocus();

		await userEvent.keyboard('nowhere{Enter}');

		await expect.element(screen.getByRole('alert')).toHaveTextContent(m.folder_error_not_found());
		await expect.element(screen.getByRole('dialog')).toBeInTheDocument();
		await userEvent.keyboard('x');
		await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
	});

	it('Tab で補って候補を欄の下に出し、欄にとどまる。打ち直すと候補を消す', async () => {
		const screen = await render(Page);
		await userEvent.keyboard('{Meta>}d{/Meta}');
		const input = screen.getByRole('combobox', { name: m.folder_input() });
		await expect.element(input).toHaveFocus();
		await userEvent.keyboard('{End}/d{Tab}');

		expect(callsOf(invoked, 'complete_folder').at(-1)?.[1]).toEqual({ input: '~/notes/d' });
		await expect.element(input).toHaveValue('~/notes/Do');
		await expect.element(input).toHaveFocus();
		const element = input.element() as HTMLInputElement;
		expect([element.selectionStart, element.selectionEnd]).toEqual([10, 10]);
		const list = screen.getByRole('listbox', { name: m.folder_candidates() });
		await expect.element(list).toHaveTextContent('Documents/Downloads/');
		await expect
			.element(screen.getByText(m.folder_candidates_more({ count: 100 })))
			.toBeInTheDocument();
		await expect
			.element(screen.getByText(m.folder_candidates_count({ count: 102 })))
			.toBeInTheDocument();

		await userEvent.keyboard('c');
		await expect.element(list).not.toBeInTheDocument();
	});

	it('候補が並んだら Tab と Shift+Tab で順に選んで欄に入れ、Enter で決める。Esc で選ぶ前に戻す', async () => {
		const screen = await render(Page);
		await userEvent.keyboard('{Meta>}d{/Meta}');
		const input = screen.getByRole('combobox', { name: m.folder_input() });
		await expect.element(input).toHaveFocus();
		await userEvent.keyboard('{End}/d{Tab}');
		await expect.element(input).toHaveValue('~/notes/Do');

		await userEvent.keyboard('{Tab}');
		await expect.element(input).toHaveValue('~/notes/Documents/');
		await expect
			.element(screen.getByRole('option', { name: 'Documents/' }))
			.toHaveAttribute('aria-selected', 'true');
		await userEvent.keyboard('{Tab}');
		await expect.element(input).toHaveValue('~/notes/Downloads/');
		await userEvent.keyboard('{Escape}');
		await expect.element(input).toHaveValue('~/notes/Do');
		await expect.element(screen.getByRole('dialog')).toBeInTheDocument();

		await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
		await expect.element(input).toHaveValue('~/notes/Downloads/');
		await userEvent.keyboard('{Escape}{Escape}');
		// 選んでいなければ、一覧だけを閉じて打ったパスを残す
		await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument();
		await expect.element(input).toHaveValue('~/notes/Do');
		await expect.element(screen.getByRole('dialog')).toBeInTheDocument();
		await userEvent.keyboard('{Backspace}{Backspace}d{Tab}{Tab}{Shift>}{Tab}{/Shift}');
		await expect.element(input).toHaveValue('~/notes/Downloads/');
		await userEvent.keyboard('{Enter}');
		await expect.element(input).toHaveValue('~/notes/Downloads/');
		await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument();
		await expect.element(screen.getByRole('dialog')).toBeInTheDocument();
		expect(commandsCalled()).not.toContain('change_folder');
	});

	it('打っている間は1つに決まる続きを薄く出し、→ で受け入れる', async () => {
		const screen = await render(Page);
		await userEvent.keyboard('{Meta>}d{/Meta}');
		const input = screen.getByRole('combobox', { name: m.folder_input() });
		await expect.element(input).toHaveFocus();
		await userEvent.keyboard('{End}/wo');

		await expect
			.element(screen.getByTestId('folder-suggestion'))
			.toHaveTextContent('~/notes/work/');
		// カーソルが末尾から離れたら消し、→ はカーソルを動かすだけにする。末尾に戻れば出し直す
		await userEvent.keyboard('{ArrowLeft}');
		await expect.element(screen.getByTestId('folder-suggestion')).not.toBeInTheDocument();
		await userEvent.keyboard('{ArrowRight}');
		await expect.element(input).toHaveValue('~/notes/wo');
		await expect.element(screen.getByTestId('folder-suggestion')).toBeInTheDocument();
		await userEvent.keyboard('{Home}');
		await expect.element(screen.getByTestId('folder-suggestion')).not.toBeInTheDocument();
		await userEvent.keyboard('{End}');
		await expect.element(screen.getByTestId('folder-suggestion')).toBeInTheDocument();
		// 受け入れると、打った所も実際の名前の書き方になる
		await userEvent.keyboard('{ArrowRight}');
		await expect.element(input).toHaveValue('~/notes/Work/');
		await expect.element(screen.getByTestId('folder-suggestion')).not.toBeInTheDocument();
	});

	it('左下のボタンに今のフォルダーを出し、メニューで最近のフォルダーへ移るか、選ぶ画面を開く', async () => {
		const screen = await render(Page);
		const button = screen.getByRole('button', { name: m.folder_button({ path: '~/notes' }) });
		await expect.element(button).toHaveTextContent('notes');

		// 移らずに閉じたら、ボタンでなく入力欄にフォーカスを戻す（下書きのキーが効くように）
		await button.click();
		await expect.element(screen.getByRole('menu')).toBeInTheDocument();
		await userEvent.keyboard('{Escape}');
		await expect.element(draftField(screen)).toHaveFocus();

		// 移ると最近のフォルダーの順が入れ替わる。並べ直しても、入力欄にフォーカスを戻す
		await button.click();
		menuResult = {
			current: { name: 'work', display: '~/work', path: '/home/work' },
			atHome: false,
			recent: [
				{ name: 'work', display: '~/work', path: '/home/work' },
				{ name: 'notes', display: '~/notes', path: '/home/notes' }
			]
		};
		await screen.getByRole('menuitem', { name: /work/ }).click();
		await vi.waitFor(() =>
			expect(callsOf(invoked, 'change_folder').at(-1)?.[1]).toEqual({ input: '/home/work' })
		);
		const workButton = screen.getByRole('button', { name: m.folder_button({ path: '~/work' }) });
		await expect.element(workButton).toBeInTheDocument();
		await expect.element(screen.getByRole('menu')).not.toBeInTheDocument();
		await expect.element(draftField(screen)).toHaveFocus();

		await workButton.click();
		await screen.getByRole('menuitem', { name: m.folder_menu_pick() }).click();
		await vi.waitFor(() => expect(commandsCalled()).toContain('pick_folder'));
	});

	it('ホームにいて最近のフォルダーが無ければ、ボタンですぐ選ぶ画面を開く', async () => {
		menuResult = {
			current: { name: 'someone', display: '~', path: '/home' },
			atHome: true,
			recent: []
		};
		const screen = await render(Page);
		const button = screen.getByRole('button', { name: m.folder_button({ path: '~' }) });
		await expect.element(button).toHaveTextContent(m.folder_home());
		await button.click();
		await vi.waitFor(() => expect(commandsCalled()).toContain('pick_folder'));
		await expect.element(screen.getByRole('menu')).not.toBeInTheDocument();
	});

	it('Esc とキーのもう一押しで、移らずに閉じる', async () => {
		const screen = await render(Page);
		for (const close of ['{Escape}', '{Meta>}d{/Meta}']) {
			await userEvent.keyboard('{Meta>}d{/Meta}');
			await expect.element(screen.getByRole('dialog')).toBeInTheDocument();
			await userEvent.keyboard(close);
			await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
		}
		expect(commandsCalled()).not.toContain('change_folder');
	});
});
