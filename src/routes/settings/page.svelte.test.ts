import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { formatKeys } from '$lib/keys';
import { EVENTS } from '$lib/bindings/constants';
import type { PairingOffer } from '$lib/bindings/PairingOffer';
import type { UpdateView } from '$lib/bindings/UpdateView';
import { draftGuidance } from '$lib/guidance';
import { m } from '$lib/paraglide/messages';
import {
	settings,
	type PunctuationStyle,
	type Replacement,
	type Action,
	type SettingsView,
	type Snippet
} from '$lib/settings.svelte';
import { callsOf } from '$lib/test-support/calls';
import { aiAction as ai, DEFAULT_DRAFT_KEYS, settingsView } from '$lib/test-support/settings-view';
import Page from './+page.svelte';

// 設定を変えるコマンドは Rust 側にあるので、呼ばれた内容だけを見る
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const invoked = vi.mocked(invoke);

function view(
	replacements: Replacement[] = [],
	punctuationStyle: PunctuationStyle = 'keep',
	font: { family?: string; size?: number } = {},
	guidance: string | null = null
): SettingsView {
	return settingsView({
		replacements,
		punctuationStyle,
		textFontFamily: font.family ?? '',
		textFontSize: font.size ?? 16,
		inputGuidance: guidance
	});
}

/** set_replacements が呼ばれたときに渡された辞書を、呼ばれた順に並べたもの */
function savedReplacements(): Replacement[][] {
	return callsOf(invoked, 'set_replacements').map(
		([, args]) => (args as { replacements: Replacement[] }).replacements
	);
}

/** set_replacements に最後に渡された辞書。呼ばれていなければ null */
function lastSavedReplacements(): Replacement[] | null {
	return savedReplacements().at(-1) ?? null;
}

/** キーを添える名前のうち、キーより前の部分に当たる正規表現。今のキーはテストの中で変わるため */
function labelBeforeKey(label: (key: string) => string) {
	const [before] = label('\u0000').split('\u0000');
	return new RegExp('^' + before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

const hotkeyButtonName = labelBeforeKey((key) => m.settings_hotkey_change_label({ key }));

/** 定型文・アクションの閉じている行をすべて開く。閉じた行には、名前と本文の欄が無い */
async function openRows(screen: Awaited<ReturnType<typeof render>>) {
	// 直前に足した行が描かれてから探す
	await tick();
	for (const button of screen.container.querySelectorAll<HTMLButtonElement>(
		'button[aria-expanded="false"][aria-controls^="row-"]'
	)) {
		button.click();
	}
	await tick();
}

/** 名前が name の行の「…」メニューを開き、項目を選ぶ */
async function chooseFromRowMenu(
	screen: Awaited<ReturnType<typeof render>>,
	name: string,
	item: string
) {
	await screen.getByRole('button', { name: m.settings_row_menu({ name }) }).click();
	await screen.getByRole('menuitem', { name: item }).click();
}

/** 設定画面を描き、サイドバーで分類を選ぶ。開いたときは「一般」なので、ほかの分類の項目は選ぶまで隠れている */
async function renderAt(category: () => string) {
	const screen = await render(Page);
	await screen.getByRole('tab', { name: category() }).click();
	return screen;
}

beforeEach(() => {
	invoked.mockClear();
	invoked.mockImplementation(() => Promise.resolve(undefined));
	vi.mocked(listen).mockReset();
	vi.mocked(listen).mockImplementation(() => Promise.resolve(() => {}));
	settings.current = view();
});

describe('設定画面の置き換え辞書', () => {
	it('設定ファイルにある辞書を表に出す', async () => {
		settings.current = view([{ from: '濃度', to: 'Node.js', enabled: true }]);
		const screen = await renderAt(m.settings_category_copy);

		await expect.element(screen.getByLabelText(m.settings_replacements_from())).toHaveValue('濃度');
		await expect
			.element(screen.getByLabelText(m.settings_replacements_to()))
			.toHaveValue('Node.js');
	});

	const sixReplacements = () =>
		['a', 'b', 'c', 'd', 'e', '濃度'].map((from) => ({
			from,
			to: from.toUpperCase(),
			enabled: true
		}));

	it('絞り込んだ行の前の文字列を書き換えて当たらなくなっても、語を変えるまで出したままにする', async () => {
		settings.current = view(sixReplacements());
		const screen = await renderAt(m.settings_category_copy);
		await screen.getByRole('searchbox', { name: m.settings_replacements_filter() }).fill('濃度');

		await screen.getByLabelText(m.settings_replacements_from()).fill('x');

		await expect.element(screen.getByLabelText(m.settings_replacements_from())).toHaveValue('x');
	});

	it('絞り込んだまま件数が減っても欄を出し続け、当たる行がなければその旨を出す', async () => {
		settings.current = view(sixReplacements());
		const screen = await renderAt(m.settings_category_copy);
		const filter = screen.getByRole('searchbox', { name: m.settings_replacements_filter() });
		await filter.fill('濃度');

		await screen.getByRole('button', { name: m.settings_replacements_remove() }).click();

		await expect.element(screen.getByText(m.settings_filter_no_match())).toBeVisible();
		await expect.element(filter).toHaveValue('濃度');
	});

	it('辞書が空のときは行を出さない', async () => {
		const screen = await renderAt(m.settings_category_copy);

		await expect.element(screen.getByText(m.settings_replacements())).toBeInTheDocument();
		expect(screen.getByLabelText(m.settings_replacements_from()).elements()).toHaveLength(0);
	});

	it('追加すると、空の行のまま保存する', async () => {
		const screen = await renderAt(m.settings_category_copy);

		await screen.getByRole('button', { name: m.settings_replacements_add() }).click();

		await expect.element(screen.getByLabelText(m.settings_replacements_from())).toBeInTheDocument();
		expect(lastSavedReplacements()).toEqual([{ from: '', to: '', enabled: true }]);
	});

	it('打った内容をそのつど保存する', async () => {
		settings.current = view([{ from: '滑ると', to: 'svelte', enabled: true }]);
		const screen = await renderAt(m.settings_category_copy);
		await screen.getByRole('button', { name: m.settings_replacements_add() }).click();

		// 2行目に打つ。1行目に書き込んでしまう取り違えを見つけるため
		await screen.getByLabelText(m.settings_replacements_from()).nth(1).fill('濃度');
		await screen.getByLabelText(m.settings_replacements_to()).nth(1).fill('Node.js');

		expect(lastSavedReplacements()).toEqual([
			{ from: '滑ると', to: 'svelte', enabled: true },
			{ from: '濃度', to: 'Node.js', enabled: true }
		]);
	});

	it('スイッチを切ると、その行だけを無効にして保存する', async () => {
		settings.current = view([
			{ from: '濃度', to: 'Node.js', enabled: true },
			{ from: '滑ると', to: 'svelte', enabled: true }
		]);
		const screen = await renderAt(m.settings_category_copy);

		// 2行目を切る。1行目を切ってしまう取り違えを見つけるため
		await screen.getByLabelText(m.settings_replacements_enabled()).nth(1).click();

		expect(lastSavedReplacements()).toEqual([
			{ from: '濃度', to: 'Node.js', enabled: true },
			{ from: '滑ると', to: 'svelte', enabled: false }
		]);
	});

	it('削除すると、その行を除いて保存する', async () => {
		settings.current = view([
			{ from: '濃度', to: 'Node.js', enabled: true },
			{ from: '滑ると', to: 'svelte', enabled: true }
		]);
		const screen = await renderAt(m.settings_category_copy);

		// 2行目を消す。1行目を消してしまう取り違えを見つけるため
		await screen.getByLabelText(m.settings_replacements_remove()).nth(1).click();

		expect(lastSavedReplacements()).toEqual([{ from: '濃度', to: 'Node.js', enabled: true }]);
		await expect.element(screen.getByLabelText(m.settings_replacements_from())).toHaveValue('濃度');
	});

	it('保存が終わる前に打ち足しても、保存を重ねず、終わってから最後の内容で保存し直す', async () => {
		settings.current = view([{ from: '仮', to: '', enabled: true }]);
		// 最初の保存だけ、わざと終わらせずに待たせる。
		// mockImplementationOnce だと、設定ウィンドウを表示する show_settings_window に先に使われてしまう
		let finishFirst: (() => void) | undefined;
		invoked.mockImplementation((command) => {
			if (command !== 'set_replacements' || finishFirst) return Promise.resolve(undefined);
			return new Promise<undefined>((resolve) => (finishFirst = () => resolve(undefined)));
		});
		const screen = await renderAt(m.settings_category_copy);

		const from = screen.getByLabelText(m.settings_replacements_from());
		await from.fill('濃');
		await from.fill('濃度');

		// 最初の保存が終わるまでは、2回目を投げない（古い内容で上書きしないため）
		expect(savedReplacements()).toEqual([[{ from: '濃', to: '', enabled: true }]]);

		finishFirst?.();

		await vi.waitFor(() =>
			expect(savedReplacements()).toEqual([
				[{ from: '濃', to: '', enabled: true }],
				[{ from: '濃度', to: '', enabled: true }]
			])
		);
	});

	it('保存に失敗したら、その旨を表示する', async () => {
		invoked.mockImplementation((command) =>
			command === 'set_replacements'
				? Promise.reject(new Error('disk full'))
				: Promise.resolve(undefined)
		);
		const screen = await renderAt(m.settings_category_copy);

		await screen.getByRole('button', { name: m.settings_replacements_add() }).click();

		await expect
			.element(screen.getByText(m.settings_failed({ error: 'Error: disk full' })))
			.toBeInTheDocument();
	});
});

describe('設定画面の下書きの履歴', () => {
	it('履歴を消すボタンで履歴を消すコマンドを呼ぶ', async () => {
		const screen = await renderAt(m.settings_category_general);

		await screen.getByRole('button', { name: m.settings_draft_history_clear() }).click();

		expect(invoked).toHaveBeenCalledWith('clear_draft_history', undefined);
	});
});

describe('設定画面の定型文', () => {
	/** set_snippets に最後に渡された定型文。呼ばれていなければ null */
	function lastSavedSnippets(): Snippet[] | null {
		const last = callsOf(invoked, 'set_snippets').at(-1);
		return last ? (last[1] as { snippets: Snippet[] }).snippets : null;
	}

	const confirm = { name: '確認', body: '一つずつ質問してください。\n以上です。' };

	it('設定ファイルにある定型文を、名前と本文の欄に出す', async () => {
		settings.current = { ...view(), snippets: [confirm] };
		const screen = await renderAt(m.settings_category_snippets);

		// 閉じた行には、名前と本文の1行目を出す
		await expect
			.element(screen.getByRole('button', { name: '確認 一つずつ質問してください。' }))
			.toHaveAttribute('aria-expanded', 'false');
		await openRows(screen);
		await expect.element(screen.getByLabelText(m.settings_snippets_name())).toHaveValue('確認');
		await expect
			.element(screen.getByLabelText(m.settings_snippets_body()))
			.toHaveValue(confirm.body);
	});

	it('説明に、一覧を出すキーを書く', async () => {
		const screen = await renderAt(m.settings_category_snippets);

		await expect
			.element(screen.getByText(m.settings_snippets_description({ key: '⌘J' })))
			.toBeInTheDocument();
	});

	it('追加すると、名前も本文も空の1件のまま保存し、名前の欄にフォーカスを移す', async () => {
		const screen = await renderAt(m.settings_category_snippets);

		await screen.getByRole('button', { name: m.settings_snippets_add() }).click();

		await expect.element(screen.getByLabelText(m.settings_snippets_name())).toHaveFocus();
		expect(lastSavedSnippets()).toEqual([{ name: '', body: '' }]);
	});

	it('空の行が残っていれば、追加しても足さずにその行へ戻り、分類を離れると捨てる', async () => {
		settings.current = { ...view(), snippets: [confirm] };
		const screen = await renderAt(m.settings_category_snippets);

		await screen.getByRole('button', { name: m.settings_snippets_add() }).click();
		await screen.getByRole('button', { name: m.settings_snippets_add() }).click();
		expect(lastSavedSnippets()).toEqual([confirm, { name: '', body: '' }]);

		await screen.getByRole('tab', { name: m.settings_category_general() }).click();
		await vi.waitFor(() => expect(lastSavedSnippets()).toEqual([confirm]));
	});

	it('名前と本文を打つと、そのつど保存する', async () => {
		settings.current = { ...view(), snippets: [confirm] };
		const screen = await renderAt(m.settings_category_snippets);

		await screen.getByRole('button', { name: m.settings_snippets_add() }).click();
		// 足した行だけが開いている
		await expect.element(screen.getByLabelText(m.settings_snippets_name())).toHaveValue('');
		await openRows(screen);
		await screen.getByLabelText(m.settings_snippets_name()).nth(1).fill('状態');
		expect(lastSavedSnippets()).toEqual([confirm, { name: '状態', body: '' }]);
		await screen.getByLabelText(m.settings_snippets_body()).nth(1).fill('git status\ngit diff');

		expect(lastSavedSnippets()).toEqual([confirm, { name: '状態', body: 'git status\ngit diff' }]);
	});

	it('下書きウィンドウから足した定型文を、開いている画面の並びにも足し、並び全体を保存し直す', async () => {
		settings.current = { ...view(), snippets: [confirm] };
		// 前のテストで描いた画面の受け口を呼ばないよう、この画面の分だけにする
		vi.mocked(listen).mockClear();
		const screen = await renderAt(m.settings_category_snippets);

		const added = { name: '', body: 'よろしくお願いします' };
		for (const [name, handler] of vi.mocked(listen).mock.calls) {
			if (name === EVENTS.SNIPPET_ADDED) handler({ event: name, id: 0, payload: added });
		}
		await openRows(screen);

		await expect
			.element(screen.getByLabelText(m.settings_snippets_body()).nth(1))
			.toHaveValue(added.body);
		expect(lastSavedSnippets()).toEqual([confirm, added]);
	});

	it('削除すると、その1件を除いて保存する', async () => {
		settings.current = { ...view(), snippets: [confirm, { name: '状態', body: 'git status' }] };
		const screen = await renderAt(m.settings_category_snippets);

		// 2件目を消す。1件目を消してしまう取り違えを見つけるため
		await chooseFromRowMenu(screen, '状態', m.settings_row_remove());

		expect(lastSavedSnippets()).toEqual([confirm]);
		await openRows(screen);
		await expect.element(screen.getByLabelText(m.settings_snippets_name())).toHaveValue('確認');
	});

	it('下へ移動で、その1件を1つ下げて保存する', async () => {
		const a = { name: 'A', body: 'a' };
		const b = { name: 'B', body: 'b' };
		const c = { name: 'C', body: 'c' };
		settings.current = { ...view(), snippets: [a, b, c] };
		const screen = await renderAt(m.settings_category_snippets);

		// 1件目を1つ下げる → [B, A, C]
		await chooseFromRowMenu(screen, 'A', m.settings_reorder_down());

		expect(lastSavedSnippets()).toEqual([b, a, c]);
		await openRows(screen);
		await expect.element(screen.getByLabelText(m.settings_snippets_name()).nth(0)).toHaveValue('B');
	});

	it('上へ移動で、その1件を1つ上げて保存する', async () => {
		const a = { name: 'A', body: 'a' };
		const b = { name: 'B', body: 'b' };
		const c = { name: 'C', body: 'c' };
		settings.current = { ...view(), snippets: [a, b, c] };
		const screen = await renderAt(m.settings_category_snippets);

		// 3件目を1つ上げる → [A, C, B]
		await chooseFromRowMenu(screen, 'C', m.settings_reorder_up());

		expect(lastSavedSnippets()).toEqual([a, c, b]);
	});

	it('先頭へ・末尾へ移動で、その1件を端へ動かして保存する', async () => {
		const a = { name: 'A', body: 'a' };
		const b = { name: 'B', body: 'b' };
		const c = { name: 'C', body: 'c' };
		settings.current = { ...view(), snippets: [a, b, c] };
		const screen = await renderAt(m.settings_category_snippets);

		// 3件目を先頭へ → [C, A, B]
		await chooseFromRowMenu(screen, 'C', m.settings_reorder_top());
		expect(lastSavedSnippets()).toEqual([c, a, b]);

		// 1件目(C)を末尾へ → [A, B, C]
		await chooseFromRowMenu(screen, 'C', m.settings_reorder_bottom());
		expect(lastSavedSnippets()).toEqual([a, b, c]);
	});

	it('先頭の行では上への移動を、末尾の行では下への移動を押せなくする', async () => {
		settings.current = {
			...view(),
			snippets: [
				{ name: 'A', body: 'a' },
				{ name: 'B', body: 'b' }
			]
		};
		const screen = await renderAt(m.settings_category_snippets);

		await screen.getByRole('button', { name: m.settings_row_menu({ name: 'A' }) }).click();
		await expect
			.element(screen.getByRole('menuitem', { name: m.settings_reorder_up() }))
			.toHaveAttribute('aria-disabled', 'true');
		await expect
			.element(screen.getByRole('menuitem', { name: m.settings_reorder_top() }))
			.toHaveAttribute('aria-disabled', 'true');
		await expect
			.element(screen.getByRole('menuitem', { name: m.settings_reorder_bottom() }))
			.toHaveAttribute('aria-disabled', 'false');
		await userEvent.keyboard('{Escape}');

		await screen.getByRole('button', { name: m.settings_row_menu({ name: 'B' }) }).click();
		await expect
			.element(screen.getByRole('menuitem', { name: m.settings_reorder_down() }))
			.toHaveAttribute('aria-disabled', 'true');
		await expect
			.element(screen.getByRole('menuitem', { name: m.settings_reorder_bottom() }))
			.toHaveAttribute('aria-disabled', 'true');
	});

	it('移動したら、動かした行の「…」にフォーカスを戻す', async () => {
		settings.current = {
			...view(),
			snippets: [
				{ name: 'A', body: 'a' },
				{ name: 'B', body: 'b' },
				{ name: 'C', body: 'c' }
			]
		};
		const screen = await renderAt(m.settings_category_snippets);

		// 1件目(A)を1つ下げる → [B, A, C]。キーボードで続けて動かせるよう、A の行の「…」に戻る
		await chooseFromRowMenu(screen, 'A', m.settings_reorder_down());

		await expect
			.element(screen.getByRole('button', { name: m.settings_row_menu({ name: 'A' }) }))
			.toHaveFocus();
	});

	it('メニューの中の Esc は、メニューだけを閉じ、設定ウィンドウは閉じない', async () => {
		settings.current = { ...view(), snippets: [{ name: 'A', body: 'a' }] };
		const screen = await renderAt(m.settings_category_snippets);
		await screen.getByRole('button', { name: m.settings_row_menu({ name: 'A' }) }).click();
		await expect.element(screen.getByRole('menu')).toBeVisible();

		await userEvent.keyboard('{Escape}');

		await expect.element(screen.getByRole('menu')).not.toBeInTheDocument();
		expect(callsOf(invoked, 'close_settings_window')).toHaveLength(0);
	});

	it('メニューを開いた直後、フォーカスがまだメニューに移っていなくても、Esc で設定ウィンドウを閉じない', async () => {
		settings.current = { ...view(), snippets: [{ name: 'A', body: 'a' }] };
		const screen = await renderAt(m.settings_category_snippets);
		await screen.getByRole('button', { name: m.settings_row_menu({ name: 'A' }) }).click();
		await expect.element(screen.getByRole('menu')).toBeVisible();
		(document.activeElement as HTMLElement | null)?.blur();

		await userEvent.keyboard('{Escape}');

		await expect.element(screen.getByRole('menu')).not.toBeInTheDocument();
		expect(callsOf(invoked, 'close_settings_window')).toHaveLength(0);
	});

	it('メニューを Esc で閉じた直後の次の Esc では、設定ウィンドウを閉じる', async () => {
		settings.current = { ...view(), snippets: [{ name: 'A', body: 'a' }] };
		const screen = await renderAt(m.settings_category_snippets);
		await screen.getByRole('button', { name: m.settings_row_menu({ name: 'A' }) }).click();
		await expect.element(screen.getByRole('menu')).toBeVisible();

		await userEvent.keyboard('{Escape}');
		await userEvent.keyboard('{Escape}');

		expect(callsOf(invoked, 'close_settings_window')).toHaveLength(1);
	});

	it('メニューを開いたままでも、Cmd+W では設定ウィンドウを閉じる', async () => {
		settings.current = { ...view(), platform: 'macos', snippets: [{ name: 'A', body: 'a' }] };
		const screen = await renderAt(m.settings_category_snippets);
		await screen.getByRole('button', { name: m.settings_row_menu({ name: 'A' }) }).click();
		await expect.element(screen.getByRole('menu')).toBeVisible();

		await userEvent.keyboard('{Meta>}w{/Meta}');

		expect(callsOf(invoked, 'close_settings_window')).toHaveLength(1);
	});

	it('削除したら、次の行の「…」に、末尾なら前の行の「…」にフォーカスを移す', async () => {
		settings.current = {
			...view(),
			snippets: [
				{ name: 'A', body: 'a' },
				{ name: 'B', body: 'b' },
				{ name: 'C', body: 'c' }
			]
		};
		const screen = await renderAt(m.settings_category_snippets);

		await chooseFromRowMenu(screen, 'A', m.settings_row_remove());
		await expect
			.element(screen.getByRole('button', { name: m.settings_row_menu({ name: 'B' }) }))
			.toHaveFocus();

		await chooseFromRowMenu(screen, 'C', m.settings_row_remove());
		await expect
			.element(screen.getByRole('button', { name: m.settings_row_menu({ name: 'B' }) }))
			.toHaveFocus();
	});

	it('1件だけなら、メニューに移動を出さず削除だけにする', async () => {
		settings.current = { ...view(), snippets: [{ name: 'A', body: 'a' }] };
		const screen = await renderAt(m.settings_category_snippets);

		await screen.getByRole('button', { name: m.settings_row_menu({ name: 'A' }) }).click();

		await expect
			.element(screen.getByRole('menuitem', { name: m.settings_row_remove() }))
			.toBeVisible();
		expect(screen.getByRole('menuitem').all()).toHaveLength(1);
	});
});

describe('設定画面の下書きのフォント', () => {
	it('設定ファイルにある値を出す', async () => {
		settings.current = view([], 'keep', { family: 'HackGen Console NF', size: 22 });
		const screen = await renderAt(m.settings_category_draft);

		await expect
			.element(screen.getByLabelText(m.settings_draft_font()))
			.toHaveValue('HackGen Console NF');
		await expect.element(screen.getByLabelText(m.settings_draft_font_size())).toHaveValue(22);
	});

	it('フォント名を打つと、大きさと一緒に保存する', async () => {
		const screen = await renderAt(m.settings_category_draft);

		await screen.getByLabelText(m.settings_draft_font()).fill('Menlo');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_font', { family: 'Menlo', size: 16 })
		);
	});

	it('大きさを変えると、フォント名と一緒に保存する', async () => {
		settings.current = view([], 'keep', { family: 'Menlo', size: 16 });
		const screen = await renderAt(m.settings_category_draft);

		await screen.getByLabelText(m.settings_draft_font_size()).fill('22');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_font', { family: 'Menlo', size: 22 })
		);
	});

	it('大きさを消した途中の状態では保存しない', async () => {
		// 打ち直すために消すと一瞬 0 件になる。そこで保存すると、範囲外の値が飛ぶ
		const screen = await renderAt(m.settings_category_draft);

		await screen.getByLabelText(m.settings_draft_font_size()).fill('');

		expect(invoked).not.toHaveBeenCalledWith('set_draft_font', expect.anything());
	});
});

describe('設定画面の履歴の件数', () => {
	it('設定ファイルにある値を出す', async () => {
		settings.current = { ...view(), textHistorySize: 20 };
		const screen = await render(Page);

		await expect.element(screen.getByLabelText(m.settings_draft_history_size())).toHaveValue(20);
	});

	it('打っている途中では保存せず、欄から離れたときに保存する', async () => {
		// 打つたびに保存すると、50 を 30 に打ち直す途中の 3 で、下書きの履歴がその場で消えてしまう
		const screen = await render(Page);

		await screen.getByLabelText(m.settings_draft_history_size()).fill('3');
		await tick();
		expect(invoked).not.toHaveBeenCalledWith('set_draft_history_size', expect.anything());

		await userEvent.keyboard('{Tab}');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_history_size', { size: 3 })
		);
	});

	it('0 は履歴を使わない値として保存する', async () => {
		const screen = await render(Page);

		await screen.getByLabelText(m.settings_draft_history_size()).fill('0');
		await userEvent.keyboard('{Tab}');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_history_size', { size: 0 })
		);
	});

	it('上限を超えたら、上限に収めて保存し、欄も上限にする', async () => {
		const screen = await render(Page);
		const input = screen.getByLabelText(m.settings_draft_history_size());

		await input.fill('500');
		await userEvent.keyboard('{Tab}');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_history_size', { size: 100 })
		);
		await expect.element(input).toHaveValue(100);
	});

	it('保存に失敗したら、その旨を出し、欄を今の件数に戻す', async () => {
		invoked.mockImplementation((command) =>
			command === 'set_draft_history_size'
				? Promise.reject(new Error('disk full'))
				: Promise.resolve(undefined)
		);
		const screen = await render(Page);
		const input = screen.getByLabelText(m.settings_draft_history_size());

		await input.fill('10');
		await userEvent.keyboard('{Tab}');

		await expect
			.element(screen.getByText(m.settings_failed({ error: 'Error: disk full' })))
			.toBeInTheDocument();
		await expect.element(input).toHaveValue(50);
	});

	it('保存を待つ間に別の値を入れたら、先の保存が失敗しても、後の値を保存し直す', async () => {
		// 最初の保存だけ、待たせてから失敗させる
		let failFirst: (() => void) | undefined;
		invoked.mockImplementation((command) => {
			if (command !== 'set_draft_history_size' || failFirst) return Promise.resolve(undefined);
			return new Promise<undefined>(
				(_, reject) => (failFirst = () => reject(new Error('disk full')))
			);
		});
		const screen = await render(Page);
		const input = screen.getByLabelText(m.settings_draft_history_size());

		await input.fill('10');
		await userEvent.keyboard('{Tab}');
		await vi.waitFor(() => expect(failFirst).toBeDefined());
		await input.fill('20');
		await userEvent.keyboard('{Tab}');
		failFirst?.();

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_history_size', { size: 20 })
		);
		await expect.element(input).toHaveValue(20);
	});

	it('保存を待つ間に入れ直して同じ値に戻っても、先の保存が失敗したときに巻き戻さない', async () => {
		let failFirst: (() => void) | undefined;
		invoked.mockImplementation((command) => {
			if (command !== 'set_draft_history_size' || failFirst) return Promise.resolve(undefined);
			return new Promise<undefined>(
				(_, reject) => (failFirst = () => reject(new Error('disk full')))
			);
		});
		const screen = await render(Page);
		const input = screen.getByLabelText(m.settings_draft_history_size());

		// 10 → 20 → 10 と入れ直す。最後の 10 は、失敗した最初の 10 とは別の入力
		for (const value of ['10', '20', '10']) {
			await input.fill(value);
			await userEvent.keyboard('{Tab}');
			await vi.waitFor(() => expect(failFirst).toBeDefined());
		}
		failFirst?.();

		await vi.waitFor(() =>
			expect(callsOf(invoked, 'set_draft_history_size').map(([, args]) => args)).toEqual([
				{ size: 10 },
				{ size: 10 }
			])
		);
		await expect.element(input).toHaveValue(10);
	});

	it('空のまま離れたら保存せず、今の件数に戻す', async () => {
		const screen = await render(Page);
		const input = screen.getByLabelText(m.settings_draft_history_size());

		await input.fill('');
		await userEvent.keyboard('{Tab}');
		await tick();

		expect(invoked).not.toHaveBeenCalledWith('set_draft_history_size', expect.anything());
		await expect.element(input).toHaveValue(50);
	});
});

describe('設定画面の下書きの文字色', () => {
	/** hex の欄。見出しの「ライト」「ダーク」と区別するため、完全一致で探す */
	function hexInput(screen: Awaited<ReturnType<typeof renderAt>>, label: string) {
		return screen.getByLabelText(label, { exact: true });
	}

	it('既定のままなら、欄にも色見本にも標準の色を出す', async () => {
		const screen = await renderAt(m.settings_category_draft);

		await expect
			.element(hexInput(screen, m.settings_draft_text_color_light()))
			.toHaveValue('#222222');
		await expect
			.element(screen.getByLabelText(m.settings_draft_text_color_pick_light()))
			.toHaveValue('#222222');
		await expect
			.element(screen.getByLabelText(m.settings_draft_text_color_pick_dark()))
			.toHaveValue('#d7d7d7');
	});

	it('#rgb を書くと、#rrggbb に揃えてライトとダークを一緒に保存する', async () => {
		settings.current = { ...view(), textColorDark: '#e0e0e0' };
		const screen = await renderAt(m.settings_category_draft);

		await hexInput(screen, m.settings_draft_text_color_light()).fill('#ABC');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_text_color', {
				light: '#aabbcc',
				dark: '#e0e0e0'
			})
		);
		await expect
			.element(screen.getByLabelText(m.settings_draft_text_color_pick_light()))
			.toHaveValue('#aabbcc');
	});

	it('色として読めない値は保存せず、その旨を出す', async () => {
		const screen = await renderAt(m.settings_category_draft);

		await hexInput(screen, m.settings_draft_text_color_light()).fill('red');

		await expect
			.element(screen.getByText(m.settings_draft_text_color_invalid({ value: 'red' })))
			.toBeInTheDocument();
		expect(invoked).not.toHaveBeenCalledWith('set_draft_text_color', expect.anything());
	});

	it('色見本で選ぶと、その色を欄に入れて保存する', async () => {
		const screen = await renderAt(m.settings_category_draft);

		await screen.getByLabelText(m.settings_draft_text_color_pick_dark()).fill('#123456');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_text_color', { light: '', dark: '#123456' })
		);
		await expect
			.element(hexInput(screen, m.settings_draft_text_color_dark()))
			.toHaveValue('#123456');
	});
});

describe('設定画面の入力欄の案内', () => {
	const defaultGuidance = () =>
		draftGuidance(null, 'CommandOrControl+Shift+Space', DEFAULT_DRAFT_KEYS, 'macos');

	it('既定のままなら既定の案内を出し、既定に戻すは押せない', async () => {
		const screen = await renderAt(m.settings_category_draft);

		await expect
			.element(screen.getByLabelText(m.settings_draft_guidance()))
			.toHaveValue(defaultGuidance());
		await expect
			.element(screen.getByRole('button', { name: m.settings_draft_guidance_reset(), exact: true }))
			.toBeDisabled();
	});

	it('自分で書いた案内を出し、既定に戻せる', async () => {
		settings.current = view([], 'keep', {}, '自分用のメモ');
		const screen = await renderAt(m.settings_category_draft);

		await expect
			.element(screen.getByLabelText(m.settings_draft_guidance()))
			.toHaveValue('自分用のメモ');
		await expect
			.element(screen.getByRole('button', { name: m.settings_draft_guidance_reset(), exact: true }))
			.toBeEnabled();
	});

	it('書き換えると、その文を保存する', async () => {
		const screen = await renderAt(m.settings_category_draft);

		await screen.getByLabelText(m.settings_draft_guidance()).fill('自分用のメモ');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_guidance', { guidance: '自分用のメモ' })
		);
	});

	it('空にすると、出さない設定として空文字を保存する', async () => {
		const screen = await renderAt(m.settings_category_draft);

		await screen.getByLabelText(m.settings_draft_guidance()).fill('');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_guidance', { guidance: '' })
		);
		// 空は既定ではないので、既定の案内を入れ直さない
		await expect.element(screen.getByLabelText(m.settings_draft_guidance())).toHaveValue('');
	});

	it('既定に戻すと、既定の案内に戻して保存する', async () => {
		settings.current = view([], 'keep', {}, '自分用のメモ');
		const screen = await renderAt(m.settings_category_draft);

		await screen
			.getByRole('button', { name: m.settings_draft_guidance_reset(), exact: true })
			.click();

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_guidance', { guidance: null })
		);
		await expect
			.element(screen.getByLabelText(m.settings_draft_guidance()))
			.toHaveValue(defaultGuidance());
		await expect
			.element(screen.getByRole('button', { name: m.settings_draft_guidance_reset(), exact: true }))
			.toBeDisabled();
	});
});

describe('設定画面の句読点を揃える', () => {
	it('設定ファイルにある選択を選んだ状態で出す', async () => {
		settings.current = view([], 'comma');
		const screen = await renderAt(m.settings_category_copy);

		await expect
			.element(screen.getByRole('radio', { name: '，．' }))
			.toHaveAttribute('aria-checked', 'true');
		await expect
			.element(
				screen
					.getByRole('group', { name: m.settings_char_width_punctuation() })
					.getByRole('radio', { name: m.settings_char_width_keep() })
			)
			.toHaveAttribute('aria-checked', 'false');
	});

	it('選ぶと、その選択を保存する', async () => {
		const screen = await renderAt(m.settings_category_copy);

		await screen.getByRole('radio', { name: '、。' }).click();

		expect(invoked).toHaveBeenCalledWith('set_punctuation_style', { style: 'kutouten' });
	});

	it('選んでいるものをもう一度押しても、揃えないには戻さない', async () => {
		// ToggleGroup は同じものを押すと選択が外れるが、外れた状態は設定として持たない
		settings.current = view([], 'kutouten');
		const screen = await renderAt(m.settings_category_copy);

		await screen.getByRole('radio', { name: '、。' }).click();

		expect(invoked).not.toHaveBeenCalledWith('set_punctuation_style', expect.anything());
		// 押した後も、選ばれている見た目のまま (関数バインディングの getter が描き直しの拠り所になる)
		await expect
			.element(screen.getByRole('radio', { name: '、。' }))
			.toHaveAttribute('aria-checked', 'true');
		await expect
			.element(screen.getByRole('radio', { name: '、。' }))
			.toHaveAttribute('data-state', 'on');
	});
});

describe('設定画面の全角・半角を揃える', () => {
	it('種類ごとに選ぶと、ほかの種類はそのままで保存する', async () => {
		const widths = {
			alphabet: 'half',
			digit: 'keep',
			space: 'keep',
			symbol: 'keep',
			katakana: 'full'
		} as const;
		settings.current = { ...view(), charWidths: widths };
		const screen = await renderAt(m.settings_category_copy);

		await screen
			.getByRole('group', { name: m.settings_char_width_digit() })
			.getByRole('radio', { name: m.settings_char_width_full() })
			.click();

		expect(invoked).toHaveBeenCalledWith('set_char_widths', {
			widths: { ...widths, digit: 'full' }
		});
	});

	it('カタカナには半角を出さない', async () => {
		const screen = await renderAt(m.settings_category_copy);

		const katakana = screen.getByRole('group', { name: m.settings_char_width_katakana() });
		await expect
			.element(katakana.getByRole('radio', { name: m.settings_char_width_full() }))
			.toBeInTheDocument();
		await expect
			.element(katakana.getByRole('radio', { name: m.settings_char_width_half() }))
			.not.toBeInTheDocument();
	});
});

describe('設定画面のこのアプリについて', () => {
	it('Rust 側から受け取ったバージョンを出す', async () => {
		settings.current = { ...view(), version: '1.2.3' };
		const screen = await renderAt(m.settings_category_about);

		await expect
			.element(screen.getByText(m.settings_version({ version: '1.2.3' })))
			.toBeInTheDocument();
	});

	it('名前、キャッチコピー、規約・プライバシー・問い合わせのリンクを出す', async () => {
		const screen = await renderAt(m.settings_category_about);

		await expect.element(screen.getByText(m.settings_app_name_macos())).toBeInTheDocument();
		await expect.element(screen.getByText(m.settings_app_catchphrase())).toBeInTheDocument();
		await expect
			.element(screen.getByText(m.settings_version({ version: '0.1.0' })))
			.toBeInTheDocument();
		await screen.getByRole('button', { name: m.settings_terms() }).click();
		await screen.getByRole('button', { name: m.settings_privacy() }).click();
		await screen.getByRole('button', { name: m.settings_contact() }).click();

		expect(invoked).toHaveBeenCalledWith('open_terms_page', undefined);
		expect(invoked).toHaveBeenCalledWith('open_privacy_page', undefined);
		expect(invoked).toHaveBeenCalledWith('open_contact_page', undefined);
	});

	it('ログを表示する', async () => {
		const screen = await renderAt(m.settings_category_about);

		await screen.getByRole('button', { name: m.settings_reveal_log_macos() }).click();

		expect(invoked.mock.calls.map(([command]) => command)).toContain('reveal_log_file');
	});

	it('Windows ではエクスプローラーの文言にする', async () => {
		settings.current = { ...view(), platform: 'windows' };
		const screen = await renderAt(m.settings_category_about);

		await expect
			.element(screen.getByRole('button', { name: m.settings_reveal_log_windows() }))
			.toBeInTheDocument();
	});

	it('ログの表示に失敗したら、その旨を表示する', async () => {
		invoked.mockImplementation((command) =>
			command === 'reveal_log_file'
				? Promise.reject(new Error('no such folder'))
				: Promise.resolve(undefined)
		);
		const screen = await renderAt(m.settings_category_about);

		await screen.getByRole('button', { name: m.settings_reveal_log_macos() }).click();

		await expect
			.element(screen.getByText(m.settings_failed({ error: 'Error: no such folder' })))
			.toBeInTheDocument();
	});
});

describe('設定画面のホットキー', () => {
	const commands = () => invoked.mock.calls.map(([command]) => command);

	/** 「キー操作」を開き、ホットキーの「変更」を押して、キーの記録を始める */
	async function startRecording() {
		const screen = await renderAt(m.settings_category_keys);
		await screen.getByRole('button', { name: hotkeyButtonName }).click();
		await expect.element(screen.getByText(m.settings_hotkey_recording())).toBeVisible();
		return screen;
	}

	it('変更を押すと記録を始め、押したキーで下書きが出ないよう今のホットキーを止める', async () => {
		await startRecording();

		expect(commands()).toContain('pause_hotkey');
	});

	it('修飾キーと組み合わせて押すと、そのキーを登録して記録を終える', async () => {
		const screen = await startRecording();

		await userEvent.keyboard('{Meta>}{Shift>}J{/Shift}{/Meta}');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_hotkey', {
				accelerator: 'CommandOrControl+Shift+KeyJ'
			})
		);
		await expect.element(screen.getByRole('button', { name: hotkeyButtonName })).toBeVisible();
	});

	it('修飾キーなしのキーでは登録せず、次のキーを待つ', async () => {
		const screen = await startRecording();

		await userEvent.keyboard('j');

		expect(commands()).not.toContain('set_hotkey');
		await expect.element(screen.getByText(m.settings_hotkey_recording())).toBeVisible();
	});

	it('記録中の Esc は記録をやめてホットキーを戻すだけで、設定ウィンドウは閉じない', async () => {
		const screen = await startRecording();

		await userEvent.keyboard('{Escape}');

		await vi.waitFor(() => expect(commands()).toContain('resume_hotkey'));
		await expect.element(screen.getByRole('button', { name: hotkeyButtonName })).toBeVisible();
		expect(commands()).not.toContain('set_hotkey');
		expect(commands()).not.toContain('close_settings_window');
	});

	it('記録中でないときの Esc は、設定ウィンドウを閉じる', async () => {
		await render(Page);

		await userEvent.keyboard('{Escape}');

		expect(commands()).toContain('close_settings_window');
	});

	it('キャンセルを押すと、記録をやめてホットキーを戻す', async () => {
		const screen = await startRecording();

		await screen.getByRole('button', { name: m.settings_hotkey_cancel() }).click();

		await vi.waitFor(() => expect(commands()).toContain('resume_hotkey'));
		await expect.element(screen.getByRole('button', { name: hotkeyButtonName })).toBeVisible();
	});

	it('記録中にウィンドウからフォーカスが外れたら、記録をやめてホットキーを戻す', async () => {
		const screen = await startRecording();

		window.dispatchEvent(new FocusEvent('blur'));

		await vi.waitFor(() => expect(commands()).toContain('resume_hotkey'));
		await expect.element(screen.getByRole('button', { name: hotkeyButtonName })).toBeVisible();
	});

	it('登録できなければ、押したキーと今のホットキーを添えて、その旨を出す', async () => {
		invoked.mockImplementation((command) =>
			command === 'set_hotkey' ? Promise.reject(new Error('in use')) : Promise.resolve(undefined)
		);
		const screen = await startRecording();

		await userEvent.keyboard('{Meta>}J{/Meta}');

		await expect
			.element(screen.getByText(m.settings_hotkey_unavailable({ keys: '⌘J', current: '⌘⇧Space' })))
			.toBeVisible();
	});

	it('もう一度記録を始めると、前に出した登録できなかった旨を消す', async () => {
		invoked.mockImplementation((command) =>
			command === 'set_hotkey' ? Promise.reject(new Error('in use')) : Promise.resolve(undefined)
		);
		const screen = await startRecording();
		await userEvent.keyboard('{Meta>}J{/Meta}');
		const unavailable = screen.getByText(
			m.settings_hotkey_unavailable({ keys: '⌘J', current: '⌘⇧Space' })
		);
		await expect.element(unavailable).toBeVisible();

		await screen.getByRole('button', { name: hotkeyButtonName }).click();

		await expect.element(unavailable).not.toBeInTheDocument();
	});
});

describe('設定画面のキー操作', () => {
	const changeButton = (screen: Awaited<ReturnType<typeof render>>, action: () => string) =>
		screen.getByRole('button', {
			name: labelBeforeKey((key) => m.settings_key_change({ action: action(), key }))
		});

	it('操作ごとに今のキーを出し、割り当てのない操作は「なし」と出す', async () => {
		settings.current = {
			...view(),
			textWindowKeys: { ...DEFAULT_DRAFT_KEYS, snippets: '' }
		};
		const screen = await renderAt(m.settings_category_keys);

		await expect.element(screen.getByText(m.settings_key_insertReceived())).toBeVisible();
		await expect.element(screen.getByText(m.settings_key_none())).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: m.settings_key_reset_action() }))
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: m.settings_key_clear_action() }))
			.not.toBeInTheDocument();
	});

	it('キーの表示のボタンの名前に、今のキーを入れる。割り当てがなければ「なし」を入れる', async () => {
		settings.current = { ...view(), textWindowKeys: { ...DEFAULT_DRAFT_KEYS, snippets: '' } };
		const screen = await renderAt(m.settings_category_keys);
		const { hotkey, platform } = settings.current;

		await expect
			.element(
				screen.getByRole('button', {
					name: m.settings_hotkey_change_label({ key: formatKeys(hotkey, platform) }),
					exact: true
				})
			)
			.toBeVisible();
		await expect
			.element(
				screen.getByRole('button', {
					name: m.settings_key_change({
						action: m.settings_key_snippets(),
						key: m.settings_key_none()
					}),
					exact: true
				})
			)
			.toBeVisible();
	});

	it('変更を押して修飾キーと組み合わせて押すと、その操作にキーを割り当て、止めていたホットキーを戻す', async () => {
		const screen = await renderAt(m.settings_category_keys);
		await changeButton(screen, m.settings_key_historyOlder).click();
		await expect.element(screen.getByText(m.settings_hotkey_recording())).toBeVisible();
		expect(invoked).toHaveBeenCalledWith('pause_hotkey');

		await userEvent.keyboard('{Meta>}{Shift>}J{/Shift}{/Meta}');

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_key', {
				action: 'historyOlder',
				key: 'CommandOrControl+Shift+KeyJ'
			})
		);
		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('resume_hotkey'));
	});

	it('操作のキーの記録中の Esc は、記録をやめて止めていたホットキーを戻す', async () => {
		const screen = await renderAt(m.settings_category_keys);
		await changeButton(screen, m.settings_key_copy).click();
		await expect.element(screen.getByText(m.settings_hotkey_recording())).toBeVisible();

		await userEvent.keyboard('{Escape}');

		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('resume_hotkey'));
		expect(invoked).not.toHaveBeenCalledWith('set_draft_key', expect.anything());
		await expect.element(changeButton(screen, m.settings_key_copy)).toBeVisible();
	});

	it('ほかの操作と重なって断られたら、どの操作で使っているかをその行に出す', async () => {
		invoked.mockImplementation((command) =>
			command === 'set_draft_key'
				? Promise.reject('keys.action.snippets')
				: Promise.resolve(undefined)
		);
		const screen = await renderAt(m.settings_category_keys);
		await changeButton(screen, m.settings_key_copy).click();

		await userEvent.keyboard('{Meta>}j{/Meta}');

		await expect
			.element(
				screen.getByText(
					m.settings_key_used_by_action({ keys: '⌘J', action: m.settings_key_snippets() })
				)
			)
			.toBeVisible();
	});

	it('記録中だけ既定に戻すと外すを表示し、操作できる', async () => {
		settings.current = {
			...view(),
			textWindowKeys: { ...DEFAULT_DRAFT_KEYS, send: 'CommandOrControl+KeyJ', snippets: '' }
		};
		const screen = await renderAt(m.settings_category_keys);

		await changeButton(screen, m.settings_key_send).click();
		await expect
			.element(screen.getByRole('button', { name: m.settings_key_reset_action() }))
			.toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: m.settings_key_clear_action() }))
			.toBeVisible();
		await screen.getByRole('button', { name: m.settings_key_reset_action() }).click();
		await changeButton(screen, m.settings_key_settings).click();
		await screen.getByRole('button', { name: m.settings_key_clear_action() }).click();

		expect(invoked).toHaveBeenCalledWith('reset_draft_key', { action: 'send' });
		expect(invoked).toHaveBeenCalledWith('set_draft_key', { action: 'settings', key: '' });
	});

	it('ホットキーも記録中だけ既定に戻すと外すを出し、既定に戻すと外すを Rust に頼む', async () => {
		settings.current = { ...view(), hotkey: 'CommandOrControl+Alt+KeyK' };
		const screen = await renderAt(m.settings_category_keys);

		await screen.getByRole('button', { name: hotkeyButtonName }).click();
		await screen.getByRole('button', { name: m.settings_key_reset_action() }).click();
		expect(invoked).toHaveBeenCalledWith('set_hotkey', {
			accelerator: 'CommandOrControl+Shift+Space'
		});

		await screen.getByRole('button', { name: hotkeyButtonName }).click();
		await screen.getByRole('button', { name: m.settings_key_clear_action() }).click();
		expect(invoked).toHaveBeenCalledWith('set_hotkey', { accelerator: '' });
	});

	it('ホットキーを外していたら「なし」と出し、外すは押せない', async () => {
		settings.current = { ...view(), hotkey: '' };
		const screen = await renderAt(m.settings_category_keys);

		const change = screen.getByRole('button', {
			name: m.settings_hotkey_change_label({ key: m.settings_key_none() })
		});
		await expect.element(change).toHaveTextContent(m.settings_key_none());
		await change.click();
		await expect
			.element(screen.getByRole('button', { name: m.settings_key_clear_action() }))
			.toBeDisabled();
	});

	it('ホットキーが下書きの操作と重なって断られたら、登録できない旨ではなく重なりを出す', async () => {
		invoked.mockImplementation((command) =>
			command === 'set_hotkey'
				? Promise.reject('keys.action.sendTargets')
				: Promise.resolve(undefined)
		);
		const screen = await renderAt(m.settings_category_keys);
		await screen.getByRole('button', { name: hotkeyButtonName }).click();

		await userEvent.keyboard('{Meta>}l{/Meta}');

		await expect
			.element(
				screen.getByText(
					m.settings_key_used_by_action({ keys: '⌘L', action: m.settings_key_sendTargets() })
				)
			)
			.toBeVisible();
	});
});

describe('設定画面のサイドバー', () => {
	it('開くと「一般」を選んだ状態で、その分類の項目だけを出す', async () => {
		const screen = await render(Page);

		await expect
			.element(screen.getByRole('tab', { name: m.settings_category_general() }))
			.toHaveAttribute('aria-selected', 'true');
		await expect.element(screen.getByText(m.settings_autostart(), { exact: true })).toBeVisible();
		await expect
			.element(screen.getByText(m.settings_replacements(), { exact: true }))
			.not.toBeVisible();
	});

	it('分類を選ぶと、その分類の項目に切り替える', async () => {
		const screen = await render(Page);

		await screen.getByRole('tab', { name: m.settings_category_copy() }).click();

		await expect
			.element(screen.getByText(m.settings_replacements(), { exact: true }))
			.toBeVisible();
		await expect
			.element(screen.getByText(m.settings_autostart(), { exact: true }))
			.not.toBeVisible();
	});

	it('分類を切り替えても、打ちかけの内容は残る', async () => {
		settings.current = view([{ from: '仮', to: '', enabled: true }]);
		const screen = await renderAt(m.settings_category_copy);
		await screen.getByLabelText(m.settings_replacements_from()).fill('濃度');

		await screen.getByRole('tab', { name: m.settings_category_general() }).click();
		await screen.getByRole('tab', { name: m.settings_category_copy() }).click();

		await expect.element(screen.getByLabelText(m.settings_replacements_from())).toHaveValue('濃度');
	});

	it('ホットキーの記録中に分類を切り替えたら、記録をやめて止めていたホットキーを戻す', async () => {
		const screen = await renderAt(m.settings_category_keys);
		await screen.getByRole('button', { name: hotkeyButtonName }).click();
		await expect.element(screen.getByText(m.settings_hotkey_recording())).toBeVisible();

		await screen.getByRole('tab', { name: m.settings_category_draft() }).click();

		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('resume_hotkey'));
		await screen.getByRole('tab', { name: m.settings_category_keys() }).click();
		await expect.element(screen.getByRole('button', { name: hotkeyButtonName })).toBeVisible();
	});

	it('描いたら、設定ウィンドウを1回だけ表示させる', async () => {
		await render(Page);
		await tick();

		expect(callsOf(invoked, 'show_settings_window')).toHaveLength(1);
	});
});

describe('設定画面のクリップボードの履歴に残さない', () => {
	it('設定ファイルにある値を出す', async () => {
		settings.current = { ...view(), excludeFromClipboardHistory: false };
		const screen = await renderAt(m.settings_category_copy);

		await expect.element(screen.getByLabelText(m.settings_exclude_history())).not.toBeChecked();
	});

	it('切り替えると、その値を保存する', async () => {
		const screen = await renderAt(m.settings_category_copy);

		await screen.getByLabelText(m.settings_exclude_history()).click();

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_exclude_from_clipboard_history', { enabled: false })
		);
	});
});

describe('設定画面の下書きを常に最前面に表示', () => {
	it('設定ファイルにある値を出す', async () => {
		settings.current = { ...view(), textWindowAlwaysOnTop: false };
		const screen = await render(Page);

		await expect.element(screen.getByLabelText(m.settings_draft_always_on_top())).not.toBeChecked();
	});

	it('切り替えると、その値を保存する', async () => {
		const screen = await render(Page);

		await screen.getByLabelText(m.settings_draft_always_on_top()).click();

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_draft_always_on_top', { enabled: false })
		);
	});
});

describe('設定画面の下書きにボタンを表示', () => {
	it('設定ファイルにある値を出す', async () => {
		settings.current = { ...view(), showTextWindowButtons: false };
		const screen = await render(Page);

		await expect.element(screen.getByLabelText(m.settings_draft_buttons())).not.toBeChecked();
	});

	it('切り替えると、その値を保存する', async () => {
		const screen = await render(Page);

		await screen.getByLabelText(m.settings_draft_buttons()).click();

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_show_draft_buttons', { enabled: false })
		);
	});
});

describe('設定画面のほかのアプリに移ったら下書きを隠す', () => {
	it('設定ファイルにある値を出す', async () => {
		settings.current = { ...view(), hideTextWindowOnBlur: false };
		const screen = await render(Page);

		await expect.element(screen.getByLabelText(m.settings_hide_draft_on_blur())).not.toBeChecked();
	});

	it('切り替えると、その値を保存する', async () => {
		const screen = await render(Page);

		await screen.getByLabelText(m.settings_hide_draft_on_blur()).click();

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_hide_draft_on_blur', { enabled: false })
		);
	});
});

describe('設定画面の機器', () => {
	const devices = [
		{ name: 'mac-mini', publicKey: 'de03ffff', address: '', sendTo: true },
		{ name: 'mac-mini', publicKey: 'a1b2ffff', address: '', sendTo: true },
		{ name: 'living-room-pc', publicKey: 'c3d4ffff', address: '', sendTo: true }
	];

	beforeEach(() => {
		settings.current = {
			...view(),
			devices,
			proAvailable: true,
			accountKeyStatus: 'ready',
			mawokAccountSignedIn: true
		};
	});

	it('同じ名前の機器は公開鍵の先頭4文字で見分け、一覧から消す操作はその機器に対して行う', async () => {
		const screen = await renderAt(m.settings_category_devices);

		await expect.element(screen.getByLabelText('mac-mini (a1b2)')).toBeChecked();
		await screen.getByLabelText('mac-mini (a1b2)').click();
		expect(invoked).toHaveBeenCalledWith('set_send_targets', {
			publicKeys: ['de03ffff', 'c3d4ffff']
		});

		await screen.getByRole('button', { name: m.settings_devices_remove() }).nth(1).click();

		expect(invoked).toHaveBeenCalledWith('forget_device', { publicKey: 'a1b2ffff' });
	});

	it('機器が見つかっていなければ、その理由を出す', async () => {
		settings.current = { ...view(), proAvailable: true, accountKeyStatus: 'ready' };
		const screen = await renderAt(m.settings_category_devices);

		await expect.element(screen.getByText(m.settings_devices_empty())).toBeVisible();
	});

	it('Pro でなければサインイン前の案内だけを出す', async () => {
		settings.current = { ...view(), devices };
		const screen = await renderAt(m.settings_category_devices);

		await expect.element(screen.getByText(m.settings_devices_pro_sign_in())).toBeVisible();
		expect(screen.getByLabelText(m.settings_devices_join()).query()).toBeNull();
	});

	it('Pro でないサインイン済みの人には料金のページを開く操作を出す', async () => {
		settings.current = { ...view(), mawokAccountSignedIn: true };
		const screen = await renderAt(m.settings_category_devices);

		await expect.element(screen.getByText(m.settings_devices_pro_description())).toBeVisible();
		await screen.getByRole('button', { name: m.settings_devices_pro_buy() }).click();
		await vi.waitFor(() => expect(callsOf(invoked, 'open_mawok_pro_page')).toHaveLength(1));
	});

	it('鍵がない機器では、コードを入れて加えられる', async () => {
		settings.current = { ...view(), proAvailable: true, accountKeyStatus: 'needsPairing' };
		const screen = await renderAt(m.settings_category_devices);

		await expect.element(screen.getByText(m.settings_devices_needs_pairing())).toBeVisible();
		await screen.getByLabelText(m.settings_devices_join()).fill('123456');
		await screen.getByRole('button', { name: m.settings_devices_join_submit() }).click();

		expect(invoked).toHaveBeenCalledWith('join_pairing', { code: '123456' });
	});

	it('鍵を確認できなければ、設定を開き直す案内を出す', async () => {
		settings.current = { ...view(), proAvailable: true, accountKeyStatus: 'none' };
		const screen = await renderAt(m.settings_category_devices);

		await expect.element(screen.getByText(m.settings_devices_not_ready())).toBeVisible();
	});

	it('鍵を作り直す前に確かめる', async () => {
		const screen = await renderAt(m.settings_category_devices);

		await screen
			.getByRole('button', { name: m.settings_devices_reset_key_start(), exact: true })
			.click();
		await expect
			.element(
				screen.getByRole('alertdialog', { name: m.settings_devices_reset_key_confirm_title() })
			)
			.toBeVisible();
		expect(invoked).not.toHaveBeenCalledWith('reset_account_key', undefined);
		await screen.getByRole('button', { name: m.settings_devices_reset_key(), exact: true }).click();
		expect(invoked).toHaveBeenCalledWith('reset_account_key', undefined);
	});

	it('新しい機器を見つけて自動でコードを出したときは、その案内を出す', async () => {
		invoked.mockImplementation((command) =>
			Promise.resolve(
				command === 'pairing_offer'
					? { code: '123456', remainingSeconds: 120, automatic: true }
					: undefined
			)
		);
		const screen = await renderAt(m.settings_category_devices);

		await expect.element(screen.getByText('123456')).toBeVisible();
		await expect.element(screen.getByText(m.settings_devices_offer_automatic())).toBeVisible();
		expect(
			screen.getByRole('button', { name: m.settings_devices_offer_cancel() }).query()
		).toBeNull();
	});

	it('自動でコードを出したイベントを受け取り、ポーリングせずに表示する', async () => {
		let offered: ((event: { payload: PairingOffer }) => void) | undefined;
		vi.mocked(listen).mockImplementation((event, handler) => {
			if (event === EVENTS.PAIRING_CODE_OFFERED) {
				offered = handler as unknown as (event: { payload: PairingOffer }) => void;
			}
			return Promise.resolve(() => {});
		});
		const screen = await renderAt(m.settings_category_devices);

		offered?.({ payload: { code: '654321', remainingSeconds: 120, automatic: true } });
		await tick();

		await expect.element(screen.getByText('654321')).toBeVisible();
		expect(callsOf(invoked, 'pairing_offer')).toHaveLength(1);
	});

	it('コードの残り秒を減らし、取り消すとタイマーを止める', async () => {
		vi.useFakeTimers();
		invoked.mockImplementation((command) =>
			command === 'start_pairing'
				? Promise.resolve({ code: '123456', remainingSeconds: 120, automatic: false })
				: Promise.resolve(undefined)
		);
		const screen = await renderAt(m.settings_category_devices);
		const timersBeforeOffer = vi.getTimerCount();
		await screen.getByRole('button', { name: m.settings_devices_offer_start() }).click();
		await tick();
		await expect
			.element(screen.getByText(m.settings_devices_offer_waiting({ seconds: 120 })))
			.toBeInTheDocument();

		vi.advanceTimersByTime(1_000);
		await tick();
		await expect
			.element(screen.getByText(m.settings_devices_offer_waiting({ seconds: 119 })))
			.toBeInTheDocument();
		await screen.getByRole('button', { name: m.settings_devices_offer_cancel() }).click();
		await tick();
		expect(vi.getTimerCount()).toBe(timersBeforeOffer);
		vi.advanceTimersByTime(2_000);
		expect(screen.getByText(m.settings_devices_offer_description())).toBeInTheDocument();
		vi.useRealTimers();
	});

	it('残り秒が0になったら、コードごと消す', async () => {
		vi.useFakeTimers();
		invoked.mockImplementation((command) =>
			command === 'start_pairing'
				? Promise.resolve({ code: '123456', remainingSeconds: 3, automatic: false })
				: Promise.resolve(undefined)
		);
		const screen = await renderAt(m.settings_category_devices);
		await screen.getByRole('button', { name: m.settings_devices_offer_start() }).click();
		await tick();
		await expect
			.element(screen.getByText(m.settings_devices_offer_waiting({ seconds: 3 })))
			.toBeInTheDocument();

		vi.advanceTimersByTime(3_500);
		await tick();
		await expect
			.element(screen.getByText(m.settings_devices_offer_description()))
			.toBeInTheDocument();
		vi.useRealTimers();
	});
});

describe('設定画面のアクション', () => {
	let responses: Record<string, unknown>;

	beforeEach(() => {
		responses = { has_ai_key: false };
		invoked.mockImplementation((command) =>
			command in responses ? Promise.resolve(responses[command]) : Promise.resolve(undefined)
		);
	});

	/** 絞り込みの欄が出る6件。当てる行は「要約」 */
	const sixActions = () => [
		...['A', 'B', 'C', 'D', 'E'].map((name) => ai(name, name.toLowerCase())),
		ai('要約', 'まとめて')
	];

	it('設定画面を開いただけではキーを確かめず、アクションの分類を開くと確かめる', async () => {
		settings.current = { ...view(), aiService: 'gemini' };
		const screen = await render(Page);
		await tick();
		expect(invoked).not.toHaveBeenCalledWith('has_ai_key', undefined);

		await screen.getByRole('tab', { name: m.settings_category_actions() }).click();

		await expect
			.element(screen.getByText(m.settings_ai_key_absent(), { exact: true }))
			.toBeVisible();
		expect(invoked).toHaveBeenCalledWith('has_ai_key', undefined);
	});

	it('AI サービスの選択肢を「使わない」から表示し、選んだサービスの説明を出す', async () => {
		const screen = await renderAt(m.settings_category_actions);

		const service = screen.getByRole('combobox', { name: m.settings_ai_service() });
		await expect.element(service).toHaveValue('none');
		await expect.element(service).toHaveDisplayValue(m.settings_ai_service_none());
		await expect.element(screen.getByText(m.settings_ai_service_description_none())).toBeVisible();

		settings.current = { ...view(), aiService: 'anthropic' };
		await expect.element(service).toHaveDisplayValue('Anthropic');
		await expect
			.element(screen.getByText(m.settings_ai_service_description_anthropic()))
			.toBeVisible();
	});

	it('「使わない」ではキーとモデルを隠し、サービスを選ぶと表示する', async () => {
		const screen = await renderAt(m.settings_category_actions);

		await expect
			.element(screen.getByText(m.settings_ai_key(), { exact: true }))
			.not.toBeInTheDocument();
		await expect.element(screen.getByLabelText(m.settings_ai_model())).not.toBeInTheDocument();

		settings.current = { ...view(), aiService: 'gemini' };
		await expect.element(screen.getByText(m.settings_ai_key(), { exact: true })).toBeVisible();
		await expect.element(screen.getByLabelText(m.settings_ai_model())).toBeVisible();

		await screen
			.getByRole('combobox', { name: m.settings_ai_service() })
			.selectOptions(m.settings_ai_service_none());
		expect(invoked).toHaveBeenCalledWith('set_ai_service', { service: 'none' });
	});

	it('キーを保存すると、了解だけのダイアログを出し、了解を保存する', async () => {
		settings.current = { ...view(), aiService: 'gemini' };
		invoked.mockImplementation((command) => {
			if (command === 'set_ai_key') {
				responses.has_ai_key = true;
				settings.current = { ...settings.current!, aiConsent: null };
				return Promise.resolve(undefined);
			}
			if (command === 'consent_ai') {
				settings.current = { ...settings.current!, aiConsent: 'gemini' };
				return Promise.resolve(undefined);
			}
			return command in responses
				? Promise.resolve(responses[command])
				: Promise.resolve(undefined);
		});
		const screen = await renderAt(m.settings_category_actions);

		await screen.getByRole('button', { name: m.settings_ai_key_enter() }).click();
		await screen.getByLabelText(m.settings_ai_key_input()).fill('secret-key');
		responses.has_ai_key = true;
		await screen.getByRole('button', { name: m.settings_ai_key_save() }).click();
		await expect
			.element(screen.getByText(m.settings_ai_key_present(), { exact: true }))
			.toBeVisible();
		await expect.element(screen.getByLabelText(m.settings_ai_key_input())).not.toBeInTheDocument();

		const dialog = screen.getByRole('alertdialog');
		await expect.element(dialog).toHaveFocus();
		await expect.element(dialog.getByText(m.settings_ai_consent_where_gemini())).toBeVisible();
		await expect.element(dialog.getByText(m.settings_ai_consent_handling_gemini())).toBeVisible();
		await expect
			.element(dialog.getByRole('button'))
			.toMatchTextContent(m.settings_ai_consent_accept());
		expect(dialog.getByRole('button').elements()).toHaveLength(1);
		await dialog.getByRole('button', { name: m.settings_ai_consent_accept() }).click();

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('consent_ai', { service: 'gemini' })
		);
		await expect.element(screen.getByRole('alertdialog')).not.toBeInTheDocument();
	});

	it('キーがあり了解の記録が無ければ、分類を開いたときに了解を求める', async () => {
		settings.current = { ...view(), aiService: 'gemini', aiConsent: null };
		responses.has_ai_key = true;
		const screen = await renderAt(m.settings_category_actions);

		const dialog = screen.getByRole('alertdialog');
		await expect.element(dialog).toHaveFocus();
		await expect
			.element(dialog.getByRole('button'))
			.toMatchTextContent(m.settings_ai_consent_accept());
		expect(dialog.getByRole('button').elements()).toHaveLength(1);
	});

	it('了解済みのサービスでは、キーを入れ直すと了解をもう一度出す', async () => {
		settings.current = {
			...view(),
			aiService: 'gemini',
			aiConsent: 'gemini',
			aiModels: { gemini: 'custom-model' }
		};
		responses.has_ai_key = true;
		invoked.mockImplementation((command) => {
			if (command === 'set_ai_key') {
				settings.current = { ...settings.current!, aiConsent: null };
				return Promise.resolve(undefined);
			}
			return command in responses
				? Promise.resolve(responses[command])
				: Promise.resolve(undefined);
		});
		const screen = await renderAt(m.settings_category_actions);

		await expect.element(screen.getByLabelText(m.settings_ai_model())).toHaveValue('custom-model');
		await screen.getByRole('button', { name: m.settings_ai_key_replace() }).click();
		await screen.getByLabelText(m.settings_ai_key_input()).fill('secret-key');
		await screen.getByRole('button', { name: m.settings_ai_key_save() }).click();
		await expect.element(screen.getByRole('alertdialog')).toBeVisible();
	});

	it('了解を出している間に「使わない」を選ぶと、了解を送らずに閉じる', async () => {
		settings.current = { ...view(), aiService: 'gemini' };
		responses.has_ai_key = true;
		const screen = await renderAt(m.settings_category_actions);

		await expect.element(screen.getByRole('alertdialog')).toBeVisible();
		settings.current = view();
		await expect.element(screen.getByRole('alertdialog')).not.toBeInTheDocument();
		expect(invoked).not.toHaveBeenCalledWith('consent_ai', expect.anything());
	});

	it('モデルは既定のときも既定のモデルを欄に出し、打つと保存し、空にすると既定に戻す', async () => {
		settings.current = { ...view(), aiService: 'gemini' };
		const screen = await renderAt(m.settings_category_actions);
		const model = screen.getByLabelText(m.settings_ai_model());

		await expect.element(model).toHaveValue('gemini-3.5-flash-lite');
		await model.fill('gemini-3.8-flash');
		expect(invoked).toHaveBeenLastCalledWith('set_ai_model', {
			service: 'gemini',
			model: 'gemini-3.8-flash'
		});

		// 打って消している途中は空のまま。離れたら既定を出す
		await model.fill('');
		await expect.element(model).toHaveValue('');
		expect(invoked).toHaveBeenLastCalledWith('set_ai_model', { service: 'gemini', model: '' });
		(model.element() as HTMLInputElement).blur();
		await expect.element(model).toHaveValue('gemini-3.5-flash-lite');
	});

	it('既定のアクションを追加すると、今のアクションの後ろに追加して保存する', async () => {
		const mine = ai('要約', '要約してください。');
		const defaults = [ai('ビジネス向け', '丁寧に書き直してください。')];
		settings.current = { ...view(), actions: [mine] };
		responses.default_actions = defaults;
		const screen = await renderAt(m.settings_category_actions);

		await screen.getByRole('button', { name: m.settings_actions_add_defaults() }).click();

		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('set_actions', {
				actions: [mine, ...defaults]
			})
		);
		await expect.element(screen.getByRole('button', { name: /^ビジネス向け/ })).toBeVisible();
	});

	it('アクションを打って別の分類へ移り、戻っても、打った内容が残り、続けて打った内容で保存する', async () => {
		settings.current = { ...view(), actions: [ai('', '')] };
		const screen = await renderAt(m.settings_category_actions);
		await openRows(screen);

		await screen.getByLabelText(m.settings_actions_name()).fill('要約');
		await screen.getByRole('tab', { name: m.settings_category_snippets() }).click();
		await screen.getByRole('tab', { name: m.settings_category_actions() }).click();

		await expect.element(screen.getByLabelText(m.settings_actions_name())).toHaveValue('要約');
		await screen.getByLabelText(m.settings_actions_command()).fill('@ai 要約してください。');

		const saved = callsOf(invoked, 'set_actions').map(
			([, args]) => (args as { actions: Action[] }).actions
		);
		expect(saved.at(-1)).toEqual([ai('要約', '要約してください。')]);
		expect(saved.every((actions) => actions.length === 1)).toBe(true);
	});

	it('説明は並びの上に一度だけ出し、Windows の ! と ^ の注意は {{t}} のあるシェルの行にだけ出す', async () => {
		const command = (text: string): Action => ({
			name: '',
			command: text,
			output: 'replace',
			encoding: 'utf-8',
			enabled: true
		});
		// 注意を出す行と出さない行を1つずつ。どの行に出すかの決まりは hasDelayedExpansionChars の単体テストで見る
		const actions = [command('echo {{t}}!'), command('echo {{t}}')];
		const special = m.settings_actions_command_special_chars({ mark: '{{t}}' });
		const description = m.settings_actions_description({ mark: '{{t}}' });

		settings.current = { ...view(), platform: 'windows', actions };
		const screen = await renderAt(m.settings_category_actions);
		await openRows(screen);
		await expect
			.element(screen.getByText(m.settings_actions_description({ mark: '{{t}}' })))
			.toBeVisible();
		expect(screen.getByText(m.settings_actions_description({ mark: '{{t}}' })).all()).toHaveLength(
			1
		);
		const fields = screen.getByLabelText(m.settings_actions_command()).all();
		expect(fields).toHaveLength(2);
		await expect.element(fields[0]).toHaveAccessibleDescription(`${description} ${special}`);
		await expect.element(fields[1]).toHaveAccessibleDescription(description);
		expect(screen.getByText(special).all()).toHaveLength(1);
		screen.unmount();

		settings.current = { ...view(), platform: 'macos', actions };
		const mac = await renderAt(m.settings_category_actions);
		await openRows(mac);
		await expect.element(mac.getByLabelText(m.settings_actions_command()).first()).toBeVisible();
		expect(mac.getByText(special).all()).toHaveLength(0);
	});

	it('追加すると、コマンドの欄と結果の出し方と文字コードを持つ1件を足し、打ったコマンドと出し方と文字コードを保存する', async () => {
		settings.current = { ...view(), actions: [] };
		const screen = await renderAt(m.settings_category_actions);

		await screen.getByRole('button', { name: m.settings_actions_add() }).click();

		const command = screen.getByLabelText(m.settings_actions_command());
		await command.fill('tr a-z A-Z');
		// コマンドは1行なので、Enter では改行を入れない
		await userEvent.type(command, '{Enter}');
		await expect.element(command).toHaveValue('tr a-z A-Z');
		await screen.getByRole('radio', { name: m.settings_actions_output_none() }).click();
		await screen
			.getByRole('combobox', { name: m.settings_actions_encoding() })
			.selectOptions('Shift_JIS');

		await vi.waitFor(() => {
			const saved = callsOf(invoked, 'set_actions').map(
				([, args]) => (args as { actions: Action[] }).actions
			);
			expect(saved.at(-1)).toEqual([
				{ name: '', command: 'tr a-z A-Z', output: 'none', encoding: 'shift_jis', enabled: true }
			]);
		});

		// 文字コードはコマンドの標準入力と標準出力にだけ効くので、`@ai` の行では出さない
		await command.fill('@ai 訳して');
		await expect
			.element(screen.getByRole('combobox', { name: m.settings_actions_encoding() }))
			.not.toBeInTheDocument();
	});

	it('開いたまま表示言語を替えたら、画面で変えていないアクションは新しい言語のアクションに写し直す', async () => {
		settings.current = { ...view(), actions: [ai('ビジネス向け', '丁寧に')] };
		const screen = await renderAt(m.settings_category_actions);
		await expect.element(screen.getByRole('button', { name: /^ビジネス向け/ })).toBeVisible();

		settings.current = {
			...settings.current,
			revision: settings.current.revision + 1,
			locale: 'en',
			actions: [ai('Business', 'Politely')]
		};

		await expect.element(screen.getByRole('button', { name: /^Business/ })).toBeVisible();
		expect(callsOf(invoked, 'set_actions')).toEqual([]);
	});

	it('表示言語を替えて写し直しても、開いていた行は開いたままにする', async () => {
		settings.current = { ...view(), actions: [ai('ビジネス向け', '丁寧に')] };
		const screen = await renderAt(m.settings_category_actions);
		await openRows(screen);

		settings.current = {
			...settings.current,
			revision: settings.current.revision + 1,
			locale: 'en',
			actions: [ai('Business', 'Politely')]
		};

		await expect.element(screen.getByLabelText(m.settings_actions_name())).toHaveValue('Business');
	});

	it('アクションを画面で変えていたら、表示言語を替えても写し直さない', async () => {
		settings.current = { ...view(), actions: [ai('', '')] };
		const screen = await renderAt(m.settings_category_actions);
		await openRows(screen);
		await screen.getByLabelText(m.settings_actions_name()).fill('要約');

		settings.current = {
			...settings.current,
			revision: settings.current.revision + 1,
			locale: 'en',
			actions: [ai('Business', 'Politely')]
		};

		await tick();
		await expect.element(screen.getByLabelText(m.settings_actions_name())).toHaveValue('要約');
	});

	it('スイッチを切ると、消さずに使わないアクションとして保存する', async () => {
		const a = ai('A', 'a');
		settings.current = { ...view(), actions: [a] };
		const screen = await renderAt(m.settings_category_actions);

		await screen.getByRole('switch', { name: m.settings_actions_enabled({ name: 'A' }) }).click();

		expect(invoked).toHaveBeenLastCalledWith('set_actions', {
			actions: [{ ...a, enabled: false }]
		});
	});

	it('6件からは絞り込みの欄を出し、名前かコマンドで絞り込む。絞り込んでいる間は並べ替えを出さない', async () => {
		settings.current = { ...view(), actions: sixActions() };
		const screen = await renderAt(m.settings_category_actions);
		await screen.getByRole('searchbox', { name: m.settings_actions_filter() }).fill('まとめ');

		await expect.element(screen.getByRole('button', { name: /^要約/ })).toBeVisible();
		expect(screen.getByRole('button', { name: 'A @ai a' }).all()).toHaveLength(0);
		expect(screen.getByLabelText(m.settings_reorder_drag()).all()).toHaveLength(0);
		// 絞り込んでいる間は、メニューに移動を出さず削除だけにする
		await screen.getByRole('button', { name: m.settings_row_menu({ name: '要約' }) }).click();
		await expect
			.element(screen.getByRole('menuitem', { name: m.settings_row_remove() }))
			.toBeVisible();
		expect(screen.getByRole('menuitem').all()).toHaveLength(1);
	});

	it('絞り込んだ行を書き換えて当たらなくなっても、語を変えるまで出したままにする', async () => {
		settings.current = { ...view(), actions: sixActions() };
		const screen = await renderAt(m.settings_category_actions);
		await screen.getByRole('searchbox', { name: m.settings_actions_filter() }).fill('まとめ');
		await screen.getByRole('button', { name: /^要約/ }).click();

		await screen.getByLabelText(m.settings_actions_name()).fill('短く');
		await screen.getByLabelText(m.settings_actions_command()).fill('@ai 短く');

		await expect.element(screen.getByLabelText(m.settings_actions_name())).toHaveValue('短く');
	});

	it('絞り込んだまま件数が減っても欄を出し続け、当たる行がなければその旨を出す', async () => {
		settings.current = { ...view(), actions: sixActions() };
		const screen = await renderAt(m.settings_category_actions);
		const filter = screen.getByRole('searchbox', { name: m.settings_actions_filter() });
		await filter.fill('まとめ');

		await chooseFromRowMenu(screen, '要約', m.settings_row_remove());

		await expect.element(screen.getByText(m.settings_filter_no_match())).toBeVisible();
		await expect.element(filter).toHaveValue('まとめ');
	});

	it('既定のアクションを追加すると、絞り込みを解いて足した行を見せる', async () => {
		settings.current = { ...view(), actions: sixActions() };
		responses.default_actions = [ai('ビジネス向け', '丁寧に書き直してください。')];
		const screen = await renderAt(m.settings_category_actions);
		await screen.getByRole('searchbox', { name: m.settings_actions_filter() }).fill('まとめ');

		await screen.getByRole('button', { name: m.settings_actions_add_defaults() }).click();

		await expect.element(screen.getByRole('button', { name: /^ビジネス向け/ })).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'A @ai a' })).toBeVisible();
	});

	it('名前もコマンドも空の行は、「未入力」と出す', async () => {
		settings.current = { ...view(), actions: [] };
		const screen = await renderAt(m.settings_category_actions);
		await screen.getByRole('button', { name: m.settings_actions_add() }).click();

		await expect
			.element(screen.getByRole('button', { name: m.settings_row_empty(), exact: true }))
			.toBeVisible();
	});

	it('アクションを削除すると、その1件を除いて保存する', async () => {
		const a = ai('A', 'a');
		const b = ai('B', 'b');
		settings.current = { ...view(), actions: [a, b] };
		const screen = await renderAt(m.settings_category_actions);

		await chooseFromRowMenu(screen, 'B', m.settings_row_remove());

		expect(invoked).toHaveBeenCalledWith('set_actions', { actions: [a] });
	});

	it('アクションを下へ移動すると、その1件を1つ下げて保存する', async () => {
		const a = ai('A', 'a');
		const b = ai('B', 'b');
		const c = ai('C', 'c');
		settings.current = { ...view(), actions: [a, b, c] };
		const screen = await renderAt(m.settings_category_actions);

		// 1件目を1つ下げる → [B, A, C]
		await chooseFromRowMenu(screen, 'A', m.settings_reorder_down());

		expect(invoked).toHaveBeenLastCalledWith('set_actions', { actions: [b, a, c] });
	});
});

describe('設定画面の更新（Mac）', () => {
	/** update_status が返す様子 */
	let current: UpdateView;

	beforeEach(() => {
		current = { status: { state: 'available', version: '1.0.1' }, draftHasText: false };
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'update_status' ? current : undefined)
		);
	});

	it('新しい版があれば「更新して再起動」で入れる', async () => {
		const screen = await renderAt(m.settings_category_about);

		await expect
			.element(screen.getByText(m.settings_update_available({ version: '1.0.1' })))
			.toBeVisible();
		await expect.element(screen.getByText(m.settings_update_draft_lost())).not.toBeInTheDocument();
		await screen.getByRole('button', { name: m.settings_update_install() }).click();

		expect(callsOf(invoked, 'install_update')).toHaveLength(1);
	});

	it('下書きに書きかけがあるときだけ、再起動で消えることを添える', async () => {
		current = { ...current, draftHasText: true };
		const screen = await renderAt(m.settings_category_about);

		await expect.element(screen.getByText(m.settings_update_draft_lost())).toBeVisible();
	});

	it('Rust 側からの知らせで様子を変え、最新なら確かめ直せる', async () => {
		const screen = await renderAt(m.settings_category_about);
		await expect
			.element(screen.getByText(m.settings_update_available({ version: '1.0.1' })))
			.toBeVisible();

		const handler = vi
			.mocked(listen)
			.mock.calls.findLast(([event]) => event === EVENTS.UPDATE_CHANGED)?.[1];
		handler?.({
			event: EVENTS.UPDATE_CHANGED,
			id: 0,
			payload: { status: { state: 'upToDate' }, draftHasText: false }
		});

		await expect.element(screen.getByText(m.settings_update_up_to_date())).toBeVisible();
		await screen.getByRole('button', { name: m.settings_update_check() }).click();
		expect(callsOf(invoked, 'check_for_update')).toHaveLength(1);
	});

	it('Windows では出さない', async () => {
		settings.current = { ...view(), platform: 'windows' };
		const screen = await renderAt(m.settings_category_about);

		await expect
			.element(screen.getByRole('button', { name: m.settings_reveal_log_windows() }))
			.toBeVisible();
		await expect
			.element(screen.getByText(m.settings_update(), { exact: true }))
			.not.toBeInTheDocument();
		expect(callsOf(invoked, 'update_status')).toHaveLength(0);
	});
});
