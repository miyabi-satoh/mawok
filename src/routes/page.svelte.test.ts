import { invoke } from '@tauri-apps/api/core';
import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { draftGuidance } from '$lib/guidance';
import { m } from '$lib/paraglide/messages';
import { type Platform } from '$lib/keys';
import { settings, type Action, type SettingsView } from '$lib/settings.svelte';
import { EVENTS } from '$lib/bindings/constants';
import { callsOf } from '$lib/test-support/calls';
import { newAction as commandAction } from '$lib/action-target';
import { aiAction as ai, DEFAULT_DRAFT_KEYS, settingsView } from '$lib/test-support/settings-view';
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
	name:
		| typeof EVENTS.SHOWN
		| typeof EVENTS.HIDE_REQUESTED
		| typeof EVENTS.DRAFT_HIDDEN
		| typeof EVENTS.DRAFT_RECEIVED,
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
	function draftStyle(screen: { getByRole: (role: string) => { element: () => Element } }) {
		return screen.getByRole('textbox').element().getAttribute('style') ?? '';
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
		const textarea = screen.getByRole('textbox');

		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

		await vi.waitFor(() => expect(committedText()).toBe('git status'));
		await expect.element(textarea).toHaveValue('');
	});

	it('変換中の Cmd+Enter ではコピーしない（変換の確定を横取りしない）', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');

		await textarea.fill('のうど');
		pressWhileComposing(textarea.element(), 'Enter', { metaKey: true });

		expect(commandsCalled()).not.toContain('commit');
	});

	it('Esc ではコピーせずに隠し、書きかけを残す', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');

		await textarea.fill('書きかけ');
		await userEvent.keyboard('{Escape}');

		await vi.waitFor(() => expect(commandsCalled()).toContain('dismiss'));
		expect(commandsCalled()).not.toContain('commit');
		await expect.element(textarea).toHaveValue('書きかけ');
	});

	it('Esc で隠した後に出し直しても、書きかけを残す', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');

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
		const textarea = screen.getByRole('textbox');

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
		const textarea = screen.getByRole('textbox');

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

		await expect.element(screen.getByRole('textbox')).toHaveFocus();
	});

	it('隠すよう言われたら（前面で押したホットキー）、コピーして入力欄を空にする', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');

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
		const textarea = screen.getByRole('textbox');

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
		const textarea = screen.getByRole('textbox');

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

	function placeholderOf(screen: { getByRole: (role: string) => { element: () => Element } }) {
		return screen.getByRole('textbox').element().getAttribute('placeholder');
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
		const textarea = screen.getByRole('textbox');
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

	it('1行目の途中の上キーは先頭へ移り、もう一度押すと履歴を出す', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
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
		const textarea = screen.getByRole('textbox');
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
		const textarea = screen.getByRole('textbox');
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
		const textarea = screen.getByRole('textbox');
		await copy(textarea, 'git status');
		await textarea.fill('');

		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');
	});

	it('移る先がないときは、見た目の端へアプリからは移さない', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
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
		const textarea = screen.getByRole('textbox');
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
		const textarea = screen.getByRole('textbox');
		await copy(textarea, '   ');

		await userEvent.keyboard('{ArrowUp}');
		await tick();

		await expect.element(textarea).toHaveValue('');
	});

	it('変換中の上キーでは履歴を出さない（変換候補の選択を横取りしない）', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
		await copy(textarea, 'git status');

		pressWhileComposing(textarea.element(), 'ArrowUp');
		await tick();

		await expect.element(textarea).toHaveValue('');
	});

	it('下キーで戻したときは、カーソルを末尾に置く', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
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
		const textarea = screen.getByRole('textbox');
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
		const textarea = screen.getByRole('textbox');
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
		const textarea = screen.getByRole('textbox');
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
	const confirm = { name: '確認', body: '一つずつ質問してください。\n以上です。' };
	const status = { name: '', body: 'git status' };

	beforeEach(() => {
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'commit' ? true : undefined)
		);
		settings.current = { ...view(), snippets: [confirm, status] };
	});

	type Screen = Awaited<ReturnType<typeof render>>;

	/** 入力欄に書き、カーソル（と選択範囲）を置いてから Cmd+J で一覧を出す */
	async function openAt(screen: Screen, value: string, start: number, end = start) {
		const textarea = screen.getByRole('textbox');
		await textarea.fill(value);
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(start, end);
		await userEvent.keyboard('{Meta>}j{/Meta}');
		await expect.element(screen.getByRole('combobox')).toHaveFocus();
		return textarea;
	}

	function selectionOf(textarea: ReturnType<Screen['getByRole']>) {
		const element = textarea.element() as HTMLTextAreaElement;
		return [element.selectionStart, element.selectionEnd];
	}

	it('Cmd+J で一覧を出し、名前と本文の1行目を並べる。名前が空なら本文の行を出す', async () => {
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

		await screen.getByRole('combobox').fill('以上');
		await userEvent.keyboard('{Enter}');

		await expect.element(textarea).toHaveValue(`あい${confirm.body}う`);
		await expect.element(textarea).toHaveFocus();
		expect(screen.getByRole('combobox').elements()).toHaveLength(0);
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
			snippets: [confirm, status, { name: 'git diff', body: 'git diff' }]
		};
		const screen = await render(Page);
		const textarea = await openAt(screen, '', 0);

		await userEvent.keyboard('{ArrowDown}{ArrowDown}');
		await screen.getByRole('combobox').fill('git');
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
		expect(screen.getByRole('combobox').elements()).toHaveLength(0);
		expect(selectionOf(textarea)).toEqual([1, 2]);
		await expect.element(textarea).toHaveValue('あいう');
		expect(commandsCalled()).not.toContain('dismiss');
	});

	it('もう一度 Cmd+J を押すと、差し込まずに閉じる', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 3);

		await userEvent.keyboard('{Meta>}j{/Meta}');

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
		const combobox = screen.getByRole('combobox');

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
		await expect.element(screen.getByRole('combobox')).toHaveFocus();
		await expect.element(textarea).toHaveValue('git status');
	});

	it('Tab と Shift+Tab では、一覧の外へフォーカスを移さない', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 3);

		await userEvent.keyboard('{Tab}');
		await expect.element(screen.getByRole('combobox')).toHaveFocus();
		await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
		await expect.element(screen.getByRole('combobox')).toHaveFocus();
		await expect.element(textarea).toHaveValue('あいう');
	});

	it('一致する定型文がなければ、その旨を出す', async () => {
		const screen = await render(Page);
		await openAt(screen, '', 0);

		await screen.getByRole('combobox').fill('zzz');

		await expect.element(screen.getByText(m.snippets_no_match())).toBeInTheDocument();
	});

	it('一覧を出したまま隠れて出し直すと、入力欄から始める', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 3);

		emit(EVENTS.SHOWN);

		await expect.element(textarea).toHaveFocus();
		expect(screen.getByRole('combobox').elements()).toHaveLength(0);
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
			expect(addedSnippets()).toEqual([{ name: '', body: 'よろしく\nお願いします' }])
		);
		await expect.element(screen.getByText(m.draft_snippet_registered())).toBeInTheDocument();
		expect(screen.getByRole('combobox').elements()).toHaveLength(0);
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

		await vi.waitFor(() => expect(addedSnippets()).toEqual([{ name: '', body: 'いう' }]));
		expect(selectionOf(textarea)).toEqual([1, 3]);
	});

	it('絞り込みに打った文字を名前にする。当たる定型文がなければ、その旨と登録の項目を出し、Enter で登録する', async () => {
		answerAddSnippet(true);
		const screen = await render(Page);
		await openAt(screen, 'あいう', 3);

		await screen.getByRole('combobox').fill(' 挨拶 ');

		await expect.element(screen.getByText(m.snippets_no_match())).toBeInTheDocument();
		const options = screen.getByRole('option');
		expect(options.elements()).toHaveLength(1);
		await expect
			.element(options.nth(0))
			.toMatchTextContent(m.snippets_register_draft_named({ name: '挨拶' }));
		await userEvent.keyboard('{Enter}');

		await vi.waitFor(() => expect(addedSnippets()).toEqual([{ name: '挨拶', body: 'あいう' }]));
	});

	it('当たる定型文があれば、Enter では定型文を差し込み、登録しない', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう', 3);

		await screen.getByRole('combobox').fill('git');
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
		settings.current = { ...view(), snippets: [{ name: '管理者で', body: 'sudo ' }] };
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await expect.element(textarea).toHaveValue('');
		await textarea.fill('書きかけ');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');

		// 出した履歴のカーソルは先頭。そこに差し込む
		await userEvent.keyboard('{Meta>}j{/Meta}');
		await expect.element(screen.getByRole('combobox')).toHaveFocus();
		await userEvent.keyboard('{Enter}');
		await expect.element(textarea).toHaveValue('sudo git status');
		// 1行だけなので、たどっている途中なら下キーで「書きかけ」に戻ってしまう
		await userEvent.keyboard('{ArrowDown}');
		await tick();

		await expect.element(textarea).toHaveValue('sudo git status');
	});
});

describe('組み合わせた機器へ送る', () => {
	const device = { name: 'Mac', publicKey: 'ab', address: '', sendTo: true };

	/** Rust 側に溜まっている、届いた下書き（take_received_drafts で渡す） */
	let pending: { from: string; text: string }[] = [];

	beforeEach(() => {
		pending = [];
		invoked.mockImplementation((command) => {
			if (command === 'take_received_drafts') {
				const drafts = pending;
				pending = [];
				return Promise.resolve(drafts);
			}
			return Promise.resolve(command === 'send_draft' || command === 'commit' ? true : undefined);
		});
		settings.current = { ...view(), pairedDevices: [device] };
	});

	/** 組み合わせた機器から下書きが届く。Rust 側に溜めてから、画面に知らせる */
	function receive(...drafts: { from: string; text: string }[]) {
		pending.push(...drafts);
		emit(EVENTS.DRAFT_RECEIVED);
	}

	type Screen = Awaited<ReturnType<typeof render>>;

	const sendButton = (screen: Screen) =>
		screen.getByRole('button', { name: m.draft_send(), exact: true });

	it('組み合わせた機器がなければ、送るのボタンを出さない', async () => {
		settings.current = view();
		const screen = await render(Page);

		await expect
			.element(screen.getByRole('button', { name: m.draft_copy(), exact: false }))
			.toBeVisible();
		expect(sendButton(screen).query()).toBeNull();
	});

	it('送るを押すと、書いた内容で送り、入力欄を空にする', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');

		await textarea.fill('git status');
		await sendButton(screen).click();

		await expect.element(textarea).toHaveValue('');
		expect(invoked).toHaveBeenCalledWith('send_draft', { text: 'git status' });
	});

	it('送るキーで送る', async () => {
		settings.current = { ...view('windows'), pairedDevices: [device] };
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');

		await textarea.fill('ls');
		await userEvent.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}');

		await expect.element(textarea).toHaveValue('');
		expect(invoked).toHaveBeenCalledWith('send_draft', { text: 'ls' });
		expect(commandsCalled()).not.toContain('commit');
	});

	it('送っている間は、入力欄を書き換えられない', async () => {
		let finish: (sent: boolean) => void = () => {};
		invoked.mockImplementation((command) =>
			command === 'send_draft'
				? new Promise((resolve) => (finish = resolve))
				: Promise.resolve(undefined)
		);
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');

		await textarea.fill('git status');
		await sendButton(screen).click();

		await expect.element(textarea).toHaveAttribute('readonly');
		await expect.element(screen.getByRole('button', { name: m.draft_sending() })).toBeDisabled();
		finish(true);
		await expect.element(textarea).toHaveValue('');
		await expect.element(textarea).not.toHaveAttribute('readonly');
	});

	/** send_draft だけ、返した関数で終えるまで待たせる。ほかは beforeEach のまま */
	function holdSend() {
		const settle: { finish: (sent: boolean) => void; fail: (error: unknown) => void } = {
			finish: () => {},
			fail: () => {}
		};
		const fallback = invoked.getMockImplementation();
		invoked.mockImplementation((command, ...rest) =>
			command === 'send_draft'
				? new Promise((resolve, reject) => {
						settle.finish = resolve;
						settle.fail = reject;
					})
				: fallback!(command, ...rest)
		);
		return settle;
	}

	it('送っている間に出し直しても空にせず、送れなければ書きかけを残す', async () => {
		const send = holdSend();
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
		await textarea.fill('git status');
		await sendButton(screen).click();
		await expect.element(textarea).toHaveAttribute('readonly');

		emit(EVENTS.SHOWN);
		await tick();
		await expect.element(textarea).toHaveValue('git status');
		send.fail('lan.unreachable');

		await expect.element(screen.getByText(m.send_failed())).toBeVisible();
		await expect.element(textarea).toHaveValue('git status');
	});

	it('送っている間に出し直しても、送れたら空にし、後で書いた下書きは次に出したときも残す', async () => {
		const send = holdSend();
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
		await textarea.fill('git status');
		await sendButton(screen).click();
		await expect.element(textarea).toHaveAttribute('readonly');

		emit(EVENTS.SHOWN);
		send.finish(true);
		await expect.element(textarea).toHaveValue('');

		await textarea.fill('次の下書き');
		emit(EVENTS.SHOWN);
		await tick();
		await expect.element(textarea).toHaveValue('次の下書き');
	});

	it('送っている間は、履歴・定型文・届いた下書きの差し込みが効かない', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
		// 履歴を1件作る（コピーは待たせない）
		await textarea.fill('git diff');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await expect.element(textarea).toHaveValue('');
		const send = holdSend();
		await textarea.fill('git status');
		await sendButton(screen).click();
		await expect.element(textarea).toHaveAttribute('readonly');
		receive({ from: 'Mac', text: '届いた' });
		await expect.element(screen.getByText(m.draft_received({ device: 'Mac' }))).toBeVisible();

		await expect
			.element(screen.getByRole('button', { name: m.draft_history_older(), exact: true }))
			.toBeDisabled();
		await expect
			.element(screen.getByRole('button', { name: m.draft_snippets(), exact: true }))
			.toBeDisabled();
		await expect
			.element(screen.getByRole('button', { name: m.draft_received_insert() }))
			.toBeDisabled();
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowUp}');
		await userEvent.keyboard('{Meta>}{Alt>}{ArrowUp}{/Alt}{/Meta}');
		await userEvent.keyboard('{Meta>}i{/Meta}');
		await userEvent.keyboard('{Meta>}j{/Meta}');
		await tick();
		await expect.element(textarea).toHaveValue('git status');
		expect(screen.getByRole('listbox').query()).toBeNull();

		send.finish(true);
		await expect.element(textarea).toHaveValue('');
	});

	it('送れなければ、書きかけを残して知らせる', async () => {
		invoked.mockImplementation((command) =>
			command === 'send_draft' ? Promise.reject('lan.unreachable') : Promise.resolve(undefined)
		);
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');

		await textarea.fill('git status');
		await sendButton(screen).click();

		await expect.element(screen.getByText(m.send_failed())).toBeVisible();
		// Rust 側の符号ではなく、何をすればよいかの案内を出す
		await expect.element(screen.getByText(m.lan_error_unreachable())).toBeVisible();
		await expect.element(textarea).toHaveValue('git status');
	});

	it('送り先にチェックした機器がなければ、送らずに送り先の一覧を開く', async () => {
		settings.current = { ...view(), pairedDevices: [{ ...device, sendTo: false }] };
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');

		await textarea.fill('git status');
		await sendButton(screen).click();

		await expect
			.element(screen.getByRole('listbox', { name: m.draft_send_targets_list() }))
			.toBeVisible();
		expect(commandsCalled()).not.toContain('send_draft');
		await expect.element(textarea).toHaveValue('git status');
	});

	it('一部の機器に届かなかったら、隠さずに届かなかった機器の名前を出す', async () => {
		const windows = { name: 'Windows', publicKey: 'cd', address: '', sendTo: true };
		settings.current = { ...view(), pairedDevices: [device, windows] };
		invoked.mockImplementation((command) =>
			command === 'send_draft'
				? Promise.reject({ code: 'lan.partial', devices: ['cd'] })
				: Promise.resolve(undefined)
		);
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');

		await textarea.fill('git status');
		await sendButton(screen).click();

		await expect.element(screen.getByText(m.send_partial())).toBeVisible();
		await expect
			.element(screen.getByText(m.send_partial_devices({ devices: 'Windows' })))
			.toBeVisible();
		await expect.element(textarea).toHaveValue('git status');
	});

	it('送り先の一覧では、つながらない機器はチェックできず、Enter でチェックした機器へ送る', async () => {
		const windows = { name: 'Windows', publicKey: 'cd', address: '', sendTo: true };
		settings.current = { ...view(), pairedDevices: [device, windows] };
		invoked.mockImplementation((command) => {
			// Mac（ab）だけがつながる
			if (command === 'probe_devices') return Promise.resolve(['ab']);
			return Promise.resolve(command === 'send_draft' ? true : undefined);
		});
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
		await textarea.fill('git status');

		await screen.getByRole('button', { name: m.draft_send_targets() }).click();

		const mac = screen.getByRole('option', { name: 'Mac' });
		const unreachable = screen.getByRole('option', { name: /Windows/ });
		await expect.element(mac).toHaveAttribute('aria-selected', 'true');
		await expect.element(unreachable).toHaveAttribute('aria-disabled', 'true');
		await expect.element(unreachable).toHaveAttribute('aria-selected', 'false');

		// つながらない機器を押しても、チェックは変えない。
		// aria-disabled の要素は locator.click が押せるようになるまで待ち続けるので、要素を直接押す
		(unreachable.element() as HTMLElement).click();
		await tick();
		expect(commandsCalled()).not.toContain('set_send_targets');

		await userEvent.keyboard('{Enter}');

		await expect.element(textarea).toHaveValue('');
		expect(invoked).toHaveBeenCalledWith('send_draft', { text: 'git status', targets: ['ab'] });
	});

	it('送り先の一覧でチェックを外すと、設定に覚える', async () => {
		const windows = { name: 'Windows', publicKey: 'cd', address: '', sendTo: true };
		settings.current = { ...view(), pairedDevices: [device, windows] };
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'probe_devices' ? ['ab', 'cd'] : undefined)
		);
		const screen = await render(Page);

		await screen.getByRole('button', { name: m.draft_send_targets() }).click();
		await expect
			.element(screen.getByRole('option', { name: /Windows/ }))
			.not.toHaveAttribute('aria-disabled', 'true');
		await userEvent.keyboard('{ArrowDown}{ }');

		expect(invoked).toHaveBeenCalledWith('set_send_targets', { publicKeys: ['ab'] });
	});

	it('設定に反映される前に続けて押しても、前に押したチェックを消さない', async () => {
		const windows = { name: 'Windows', publicKey: 'cd', address: '', sendTo: true };
		settings.current = { ...view(), pairedDevices: [device, windows] };
		// set_send_targets を呼んでも settings-changed は届かない（設定は古いまま）
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'probe_devices' ? ['ab', 'cd'] : undefined)
		);
		const screen = await render(Page);

		await screen.getByRole('button', { name: m.draft_send_targets() }).click();
		await expect
			.element(screen.getByRole('option', { name: /Windows/ }))
			.not.toHaveAttribute('aria-disabled', 'true');
		await userEvent.keyboard('{ }{ArrowDown}{ }');

		await expect
			.poll(() => invoked.mock.lastCall)
			.toEqual(['set_send_targets', { publicKeys: [] }]);
		await expect
			.element(screen.getByRole('option', { name: 'Mac' }))
			.toHaveAttribute('aria-selected', 'false');
	});

	it('続けて押したチェックは、前の保存が終わってから押した順に覚える', async () => {
		const windows = { name: 'Windows', publicKey: 'cd', address: '', sendTo: true };
		settings.current = { ...view(), pairedDevices: [device, windows] };
		let finishFirst: () => void = () => {};
		let saveCount = 0;
		invoked.mockImplementation((command) => {
			// 1つめの保存だけ、終わるのを止めておく
			if (command === 'set_send_targets' && saveCount++ === 0) {
				return new Promise((resolve) => (finishFirst = () => resolve(undefined)));
			}
			return Promise.resolve(command === 'probe_devices' ? ['ab', 'cd'] : undefined);
		});
		const saves = () => callsOf(invoked, 'set_send_targets');
		const screen = await render(Page);

		await screen.getByRole('button', { name: m.draft_send_targets() }).click();
		await expect
			.element(screen.getByRole('option', { name: /Windows/ }))
			.not.toHaveAttribute('aria-disabled', 'true');
		await userEvent.keyboard('{ }{ArrowDown}{ }');

		// 1つめが終わるまで、2つめは投げない
		expect(saves()).toEqual([['set_send_targets', { publicKeys: ['cd'] }]]);
		finishFirst();
		await expect.poll(() => saves().length).toBe(2);
		expect(saves()[1]).toEqual(['set_send_targets', { publicKeys: [] }]);
	});

	it('前の保存が失敗したら、後に押した分の保存では、戻したチェックを書き戻さない', async () => {
		const windows = { name: 'Windows', publicKey: 'cd', address: '', sendTo: true };
		settings.current = { ...view(), pairedDevices: [device, windows] };
		let failFirst: () => void = () => {};
		let saveCount = 0;
		invoked.mockImplementation((command) => {
			// 1つめの保存だけ、止めておいてから失敗させる
			if (command === 'set_send_targets' && saveCount++ === 0) {
				return new Promise((_, reject) => (failFirst = () => reject('permission denied')));
			}
			return Promise.resolve(command === 'probe_devices' ? ['ab', 'cd'] : undefined);
		});
		const saves = () => callsOf(invoked, 'set_send_targets');
		const screen = await render(Page);

		await screen.getByRole('button', { name: m.draft_send_targets() }).click();
		await expect
			.element(screen.getByRole('option', { name: /Windows/ }))
			.not.toHaveAttribute('aria-disabled', 'true');
		// Mac を外し（保存が止まる）、その間に Windows も外す
		await userEvent.keyboard('{ }{ArrowDown}{ }');
		failFirst();

		// Mac のチェックは戻り、2つめの保存では Windows だけを外す
		await expect.poll(() => saves().length).toBe(2);
		expect(saves()[1]).toEqual(['set_send_targets', { publicKeys: ['ab'] }]);
		await expect
			.element(screen.getByRole('option', { name: 'Mac' }))
			.toHaveAttribute('aria-selected', 'true');
	});

	it('同じ機器を続けて切り替え、後の保存だけ失敗したら、前に保存できた状態に戻す', async () => {
		let saveCount = 0;
		// set_send_targets を呼んでも settings-changed は届かない（設定は古いまま）
		invoked.mockImplementation((command) => {
			// 1つめの保存は通り、2つめは失敗する
			if (command === 'set_send_targets' && saveCount++ === 1) {
				return Promise.reject('permission denied');
			}
			return Promise.resolve(command === 'probe_devices' ? ['ab'] : undefined);
		});
		const screen = await render(Page);

		await screen.getByRole('button', { name: m.draft_send_targets() }).click();
		const mac = screen.getByRole('option', { name: 'Mac' });
		await expect.element(mac).not.toHaveAttribute('aria-disabled', 'true');
		// 外して（保存できる）、また入れる（保存できない）
		await userEvent.keyboard('{ }{ }');

		await expect.element(screen.getByText(m.draft_send_targets_save_failed())).toBeVisible();
		await expect.element(mac).toHaveAttribute('aria-selected', 'false');
	});

	it('送り先を覚えられなければ、チェックを戻して知らせる', async () => {
		settings.current = { ...view(), pairedDevices: [device] };
		invoked.mockImplementation((command) => {
			if (command === 'set_send_targets') return Promise.reject('permission denied');
			return Promise.resolve(command === 'probe_devices' ? ['ab'] : undefined);
		});
		const screen = await render(Page);

		await screen.getByRole('button', { name: m.draft_send_targets() }).click();
		const mac = screen.getByRole('option', { name: 'Mac' });
		await expect.element(mac).not.toHaveAttribute('aria-disabled', 'true');
		await userEvent.keyboard('{ }');

		await expect.element(screen.getByText(m.draft_send_targets_save_failed())).toBeVisible();
		await expect.element(mac).toHaveAttribute('aria-selected', 'true');
	});

	it('送り先の一覧を出したまま隠れたら、出し直したときは閉じて入力欄から始める', async () => {
		const screen = await render(Page);
		await screen.getByRole('button', { name: m.draft_send_targets() }).click();
		const list = screen.getByRole('listbox', { name: m.draft_send_targets_list() });
		await expect.element(list).toBeVisible();

		emit(EVENTS.SHOWN);

		await expect.poll(() => list.query()).toBeNull();
		await expect.element(screen.getByRole('textbox')).toHaveFocus();
	});

	it('画面の読み込み中に届いた下書きも、読み込み後に入れる', async () => {
		pending = [{ from: 'Mac', text: '起動中に届いた' }];

		const screen = await render(Page);

		await expect.element(screen.getByRole('textbox')).toHaveValue('起動中に届いた');
	});

	it('届いた下書きは、入力欄が空ならそのまま入れる', async () => {
		const screen = await render(Page);

		receive({ from: 'Mac', text: '届いた' });

		await expect.element(screen.getByRole('textbox')).toHaveValue('届いた');
	});

	it('書きかけがあれば帯で知らせ、差し込むか捨てるかを選ぶ', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
		await textarea.fill('書きかけ');

		receive({ from: 'Mac', text: '届いた' }, { from: 'Mac', text: '2通目' });

		const notice = screen.getByText(m.draft_received({ device: 'Mac' }));
		await expect.element(notice).toBeVisible();
		await expect.element(textarea).toHaveValue('書きかけ');

		await screen.getByRole('button', { name: m.draft_received_insert() }).click();
		await expect.element(textarea).toHaveValue('書きかけ届いた');

		// 2通目は、1通目を片付けてから知らせる
		await screen.getByRole('button', { name: m.draft_received_discard() }).click();
		await expect.element(textarea).toHaveValue('書きかけ届いた');
		expect(notice.query()).toBeNull();
	});
});

describe('下書きのボタン', () => {
	beforeEach(() => {
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'commit' ? true : undefined)
		);
		settings.current = { ...view(), snippets: [{ name: '確認', body: '以上です。' }] };
	});

	type Screen = Awaited<ReturnType<typeof render>>;

	const copyButton = (screen: Screen) =>
		screen.getByRole('button', { name: m.draft_copy(), exact: false });
	const olderButton = (screen: Screen) =>
		screen.getByRole('button', { name: m.draft_history_older(), exact: true });
	const newerButton = (screen: Screen) =>
		screen.getByRole('button', { name: m.draft_history_newer(), exact: true });

	/** 書いてコピーのボタンを押し、入力欄が空に戻るまで待つ */
	async function copyWithButton(screen: Screen, text: string) {
		const textarea = screen.getByRole('textbox');
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
		const textarea = screen.getByRole('textbox');
		await textarea.fill('あいう');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(2, 2);

		await screen.getByRole('button', { name: m.draft_snippets(), exact: true }).click();
		await expect.element(screen.getByRole('combobox')).toHaveFocus();
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
			.toHaveAttribute('title', m.key_hint({ label: m.draft_snippets_hint(), keys: '⌘J' }));
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
		const textarea = screen.getByRole('textbox');
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
		const textarea = screen.getByRole('textbox');
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
		const textarea = screen.getByRole('textbox');
		await textarea.fill('git status');

		await copyButton(screen).click();

		await expect.element(screen.getByText(m.copy_failed())).toBeVisible();
		await expect.element(textarea).toHaveFocus();
	});

	it('Tab と Shift+Tab では、ボタンにフォーカスを移さない', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
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
	const device = { name: 'Mac', publicKey: 'ab', address: '', sendTo: true };

	/** Rust 側に溜まっている、届いた下書き（take_received_drafts で渡す） */
	let pending: { from: string; text: string }[] = [];

	beforeEach(() => {
		pending = [];
		invoked.mockImplementation((command) => {
			if (command === 'take_received_drafts') {
				const drafts = pending;
				pending = [];
				return Promise.resolve(drafts);
			}
			if (command === 'probe_devices') return Promise.resolve(['ab']);
			return Promise.resolve(command === 'commit' ? true : undefined);
		});
		settings.current = view();
	});

	it('設定で変えたキーでコピーし、元のキーではコピーしない', async () => {
		settings.current = {
			...view(),
			textWindowKeys: { ...DEFAULT_DRAFT_KEYS, copy: 'CommandOrControl+KeyJ', snippets: '' }
		};
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');

		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		expect(invoked).not.toHaveBeenCalledWith('commit', expect.anything());

		await userEvent.keyboard('{Meta>}j{/Meta}');
		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('commit', { text: 'git status' }));
	});

	it('前の履歴・次の履歴のキーは、カーソルの行にかかわらず移る', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
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

	it('送り先の一覧を開くキーで一覧を出し、もう一度押すと閉じる', async () => {
		settings.current = { ...view(), pairedDevices: [device] };
		const screen = await render(Page);
		await screen.getByRole('textbox').click();

		await userEvent.keyboard('{Meta>}l{/Meta}');
		const list = screen.getByRole('dialog', { name: m.draft_send_targets_list() });
		await expect.element(list).toBeVisible();

		await userEvent.keyboard('{Meta>}l{/Meta}');
		await expect.element(list).not.toBeInTheDocument();
		await expect.element(screen.getByRole('textbox')).toHaveFocus();
	});

	it('届いた下書きがなければ、差し込むキーと捨てるキーでは何もせず、既定の動作も止める', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
		await textarea.fill('draft');

		for (const init of [
			{ code: 'KeyI', key: 'i', metaKey: true },
			{ code: 'Backspace', key: 'Backspace', metaKey: true, shiftKey: true }
		]) {
			const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
			textarea.element().dispatchEvent(event);
			// WebView の既定のキーに渡さない（WebView2 の Ctrl+J のように、下書きからフォーカスが外れることがある）
			expect(event.defaultPrevented, init.code).toBe(true);
		}
		await expect.element(textarea).toHaveValue('draft');
	});

	it('読み込み直すキー（F5・Ctrl+R）は、入力欄でも一覧でも既定の動作を止め、下書きを残す', async () => {
		settings.current = view('windows');
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
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
		await userEvent.keyboard('{Control>}j{/Control}');
		const search = screen.getByRole('combobox');
		await expect.element(search).toHaveFocus();
		for (const init of reloadKeys) expect(press(search.element(), init), init.key).toBe(true);

		await expect.element(textarea).toHaveValue('draft');
	});

	it('一覧を開いている間も、ほかの操作のキーの既定の動作を止める', async () => {
		settings.current = { ...view(), pairedDevices: [device] };
		const screen = await render(Page);
		await screen.getByRole('textbox').click();
		await userEvent.keyboard('{Meta>}j{/Meta}');
		const search = screen.getByRole('combobox');
		await expect.element(search).toHaveFocus();

		// 送り先の一覧を開くキー。定型文の一覧の中では、一覧の操作でも閉じるキーでもない
		const event = new KeyboardEvent('keydown', {
			code: 'KeyL',
			key: 'l',
			metaKey: true,
			bubbles: true,
			cancelable: true
		});
		search.element().dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		await expect.element(search).toBeVisible();
		expect(invoked).not.toHaveBeenCalledWith('probe_devices');
	});

	it('余白をクリックして入力欄からフォーカスが外れても、Esc で隠し、操作のキーでコピーする', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
		await textarea.fill('git status');
		(document.activeElement as HTMLElement).blur();
		expect(document.activeElement).toBe(document.body);

		await userEvent.keyboard('{Escape}');
		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('dismiss'));

		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('commit', { text: 'git status' }));
	});

	it('組み合わせた機器がなければ、送り先の一覧を開くキーでは何もしない', async () => {
		const screen = await render(Page);
		await screen.getByRole('textbox').click();

		await userEvent.keyboard('{Meta>}l{/Meta}');

		expect(screen.getByRole('dialog').query()).toBeNull();
		expect(invoked).not.toHaveBeenCalledWith('probe_devices');
	});

	it('届いた下書きを、差し込むキーで差し込み、捨てるキーで捨てる', async () => {
		settings.current = { ...view(), pairedDevices: [device] };
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox');
		await textarea.fill('draft ');

		pending.push({ from: 'Mac', text: 'hello' }, { from: 'Mac', text: 'bye' });
		emit(EVENTS.DRAFT_RECEIVED);
		await expect.element(screen.getByText(m.draft_received({ device: 'Mac' }))).toBeVisible();

		await userEvent.keyboard('{Meta>}i{/Meta}');
		await expect.element(textarea).toHaveValue('draft hello');

		await userEvent.keyboard('{Meta>}{Shift>}{Backspace}{/Shift}{/Meta}');
		await expect
			.element(screen.getByText(m.draft_received({ device: 'Mac' })))
			.not.toBeInTheDocument();
		await expect.element(textarea).toHaveValue('draft hello');
	});
});

describe('アクション', () => {
	const business = ai('ビジネス向け', '丁寧な文に書き直してください。');
	const fix = ai('', '誤字を直してください。\n意味は変えないでください。');

	/** 返事を後から返せる run_action の呼び出し */
	let actionRuns: {
		args: { request: number; text: string; action: Action };
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
					actionRuns.push({
						args: args as { request: number; text: string; action: Action },
						resolve,
						reject
					})
				);
			}
			return Promise.resolve(command === 'commit' ? true : undefined);
		});
		settings.current = {
			...view(),
			aiService: 'gemini',
			aiConsent: 'gemini',
			actions: [business, fix]
		};
	});

	type Screen = Awaited<ReturnType<typeof render>>;

	/** 入力欄に書き、範囲を選んでから Cmd+K でアクションの一覧を出す */
	async function openAt(screen: Screen, value: string, start = 0, end = start) {
		const textarea = screen.getByRole('textbox');
		await textarea.fill(value);
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(start, end);
		await userEvent.keyboard('{Meta>}k{/Meta}');
		await expect.element(screen.getByRole('combobox')).toHaveFocus();
		return textarea;
	}

	/** アクションを選び、run_action が呼ばれるまで待つ */
	async function pick(index = 0) {
		for (let i = 0; i < index; i++) await userEvent.keyboard('{ArrowDown}');
		await userEvent.keyboard('{Enter}');
		await vi.waitFor(() => expect(actionRuns).toHaveLength(1));
		return actionRuns[0];
	}

	it('アクションが1件もなく AI サービスが「使わない」でも、ボタンを出し、キーで一覧を出して、足し方を案内する', async () => {
		settings.current = { ...view(), actions: [] };
		const screen = await render(Page);
		await screen.getByRole('textbox').fill('あいう');

		expect(screen.getByRole('button', { name: m.draft_actions() }).elements()).toHaveLength(1);
		await userEvent.keyboard('{Meta>}k{/Meta}');

		await expect.element(screen.getByRole('combobox')).toHaveFocus();
		expect(screen.getByRole('option').elements()).toHaveLength(0);
		await expect
			.element(screen.getByText(m.actions_empty({ settings: '⌘,' }), { exact: false }))
			.toBeInTheDocument();
		expect(commandsCalled()).not.toContain('begin_action');
	});

	it('アクションのボタンを押すと一覧を出す', async () => {
		const screen = await render(Page);
		await screen.getByRole('textbox').fill('あいう');

		await screen.getByRole('button', { name: m.draft_actions() }).click();

		await expect.element(screen.getByRole('combobox')).toHaveFocus();
		const options = screen.getByRole('option');
		expect(options.elements()).toHaveLength(2);
		await expect.element(options.nth(0)).toMatchTextContent('ビジネス向け');
		// 名前が空のアクションは、指示文の最初の行を名前の代わりに出す
		await expect.element(options.nth(1)).toMatchTextContent('誤字を直してください。');
	});

	it('スイッチを切ったアクションは、一覧に出さない', async () => {
		settings.current = {
			...settings.current!,
			actions: [business, { ...commandAction('大文字に', 'tr a-z A-Z'), enabled: false }]
		};
		const screen = await render(Page);
		await openAt(screen, 'abc');

		const options = screen.getByRole('option');
		expect(options.elements()).toHaveLength(1);
		await expect.element(options.nth(0)).toMatchTextContent('ビジネス向け');
	});

	it('AI サービスが「使わない」でも、AI のアクションもコマンドのアクションも一覧に出し、見出しの下にコマンドの行を添える', async () => {
		const upper = commandAction('大文字に', 'tr a-z A-Z');
		settings.current = {
			...settings.current!,
			aiService: 'none',
			aiConsent: null,
			actions: [business, upper]
		};
		const screen = await render(Page);
		await openAt(screen, 'abc');

		const options = screen.getByRole('option');
		expect(options.elements()).toHaveLength(2);
		await expect.element(options.nth(0)).toMatchTextContent('ビジネス向け');
		await expect.element(options.nth(1)).toMatchTextContent('大文字に');
		await expect.element(options.nth(1)).toMatchTextContent('tr a-z A-Z');
		// 打つと、打った行をその場で実行する項目を先頭に出す
		await screen.getByRole('combobox').fill('大');
		expect(screen.getByRole('option').elements()).toHaveLength(2);
		await expect
			.element(screen.getByRole('option').nth(0))
			.toMatchTextContent(m.actions_free_input());
		await screen.getByRole('combobox').fill('');

		const call = await pick(1);
		expect(call.args.action).toEqual(upper);
		call.resolve('ABC');
		await expect.element(screen.getByRole('textbox')).toHaveValue('ABC');
	});

	it('AI が使えない状態で AI のアクションを選ぶと、失敗の帯で AI を使える状態にするよう知らせ、入力欄は元のまま', async () => {
		settings.current = { ...settings.current!, aiService: 'none', aiConsent: null };
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいう');

		const call = await pick();
		expect(call.args.action).toEqual(business);
		call.reject({ code: 'action.disabled', detail: 'AI is not set up' });

		await expect
			.element(screen.getByText(m.action_error_disabled(), { exact: false }))
			.toBeInTheDocument();
		await expect.element(textarea).toHaveValue('あいう');
	});

	it('AI のアクションも、見出しの下に `@ai` の行を添える', async () => {
		const screen = await render(Page);
		await openAt(screen, 'あいう');

		const option = screen.getByRole('option').nth(0);
		await expect.element(option).toMatchTextContent('ビジネス向け');
		await expect.element(option).toMatchTextContent(business.command);
	});

	it('Cmd+K で一覧を出し、アクションを選ぶと全体を送り、届いたら差し替えて前の文を履歴に積む', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'えーと、明日なんですけど');

		const call = await pick();
		expect(call.args).toEqual({
			request: 1,
			text: 'えーと、明日なんですけど',
			action: business
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

	it('範囲を選んでいたら、その範囲だけを送って差し替える', async () => {
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいうえお', 1, 3);

		const call = await pick(1);
		expect(call.args.text).toBe('いう');
		expect(call.args.action).toEqual(fix);
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

	it('絞り込みに打つと、一覧の先頭に打った行で実行する項目を出し、選ぶと打った行を置き換えで実行して状態の行にも出す', async () => {
		const screen = await render(Page);
		await openAt(screen, 'あいう');

		await screen.getByRole('combobox').fill('@ai 関西弁に');
		const options = screen.getByRole('option');
		expect(options.elements()).toHaveLength(1);
		await expect.element(options.nth(0)).toMatchTextContent(m.actions_free_input());
		await expect.element(options.nth(0)).toMatchTextContent('@ai 関西弁に');
		// 当たるアクションがないことも出す
		await expect.element(screen.getByText(m.actions_no_match())).toBeInTheDocument();

		const call = await pick();
		expect(call.args.action).toEqual({
			name: '',
			command: '@ai 関西弁に',
			output: 'replace',
			encoding: 'utf-8',
			enabled: true
		});
		await expect
			.element(screen.getByText(m.draft_running_action({ action: '@ai 関西弁に' })))
			.toBeInTheDocument();
	});

	it('実行する文が空でも実行する', async () => {
		const screen = await render(Page);
		await openAt(screen, '  \n');

		const call = await pick();

		expect(call.args.text).toBe('');
	});

	it('出し方が「差し込む」なら、範囲を選んでいればその後ろに、なければカーソルの位置に結果を入れる', async () => {
		settings.current = {
			...settings.current!,
			actions: [
				{ name: '日付', command: 'date', output: 'insert', encoding: 'utf-8', enabled: true }
			]
		};
		const screen = await render(Page);
		const textarea = await openAt(screen, 'あいうえお', 1, 3);
		const call = await pick();
		expect(call.args.text).toBe('いう');
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
			actions: [
				{
					name: '記録',
					command: 'cat >> ~/log.txt',
					output: 'none',
					encoding: 'utf-8',
					enabled: true
				}
			]
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
		await userEvent.keyboard('{Meta>}j{/Meta}');
		await tick();

		expect(commandsCalled()).not.toContain('commit');
		expect(screen.getByRole('combobox').elements()).toHaveLength(0);
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
		await expect.element(screen.getByRole('combobox')).toHaveFocus();
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
		await expect.element(screen.getByRole('textbox')).toHaveValue('アイウ');
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
		const textarea = screen.getByRole('textbox');
		await textarea.fill('git status');
		await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
		await expect.element(textarea).toHaveValue('');
		await textarea.fill('書きかけ');
		(textarea.element() as HTMLTextAreaElement).setSelectionRange(0, 0);
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(textarea).toHaveValue('git status');

		await userEvent.keyboard('{Meta>}k{/Meta}');
		await expect.element(screen.getByRole('combobox')).toHaveFocus();
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

	it('実行している間に届いた下書きは、終わってから知らせる', async () => {
		const device = { name: 'Mac', publicKey: 'aa', address: '192.168.0.2', sendTo: true };
		settings.current = { ...settings.current!, pairedDevices: [device] };
		invoked.mockImplementation((command, args) => {
			if (command === 'take_received_drafts')
				return Promise.resolve([{ from: 'Mac', text: 'hello' }]);
			if (command === 'begin_action') return Promise.resolve(nextRequest++);
			if (command === 'run_action') {
				return new Promise((resolve, reject) =>
					actionRuns.push({
						args: args as { request: number; text: string; action: Action },
						resolve,
						reject
					})
				);
			}
			return Promise.resolve(undefined);
		});
		const screen = await render(Page);
		await openAt(screen, 'あいう');
		const call = await pick();

		emit(EVENTS.DRAFT_RECEIVED);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();
		expect(screen.getByText(m.draft_received({ device: 'Mac' })).elements()).toHaveLength(0);

		call.resolve('アイウ');
		await expect.element(screen.getByText(m.draft_received({ device: 'Mac' }))).toBeVisible();
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
		const textarea = screen.getByRole('textbox');

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

		await screen.getByRole('textbox').fill('書きかけ');
		await tick();
		expect(reported()).toEqual([]);
	});
});

describe('作業フォルダー', () => {
	let changeResult: () => Promise<unknown>;

	beforeEach(() => {
		changeResult = () => Promise.resolve(undefined);
		invoked.mockImplementation((command) => {
			if (command === 'current_folder') return Promise.resolve('~/notes');
			if (command === 'change_folder') return changeResult();
			return Promise.resolve(undefined);
		});
		settings.current = view();
	});

	it('キーで、今のフォルダーを選んだ状態の欄を出し、打ったパスで Enter を押すと移って入力欄に戻る', async () => {
		const screen = await render(Page);
		const textarea = screen.getByRole('textbox', { name: m.draft_label() });
		await textarea.fill('あいう');
		await userEvent.keyboard('{Meta>}d{/Meta}');

		const input = screen.getByRole('textbox', { name: m.folder_input() });
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
		await expect.element(screen.getByRole('textbox', { name: m.folder_input() })).toHaveFocus();

		await userEvent.keyboard('nowhere{Enter}');

		await expect.element(screen.getByRole('alert')).toHaveTextContent(m.folder_error_not_found());
		await expect.element(screen.getByRole('dialog')).toBeInTheDocument();
		await userEvent.keyboard('x');
		await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
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
