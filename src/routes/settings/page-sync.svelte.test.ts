import { invoke } from '@tauri-apps/api/core';
import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSTANTS } from '$lib/bindings/constants';
import type { SyncConflict } from '$lib/bindings/SyncConflict';
import type { SyncBackup } from '$lib/bindings/SyncBackup';
import { m } from '$lib/paraglide/messages';
import { settings } from '$lib/settings.svelte';
import { newSnippet } from '$lib/snippets';
import { sideName } from '$lib/sync-choices';
import { callsOf } from '$lib/test-support/calls';
import { settingsView } from '$lib/test-support/settings-view';
import Page from './+page.svelte';
import { renderAt } from './render-at';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const invoked = vi.mocked(invoke);

const conflicts: SyncConflict[] = [
	{
		id: 's_theme',
		seq: 7,
		thisDevice: { type: 'theme', value: 'dark' },
		otherDevice: { type: 'theme', value: 'light' }
	},
	{
		id: 's_text_history_size',
		seq: 9,
		thisDevice: { type: 'text_history_size', value: 50 },
		otherDevice: { type: 'text_history_size', value: 10 }
	}
];

const backups: SyncBackup[] = [
	{
		name: '20261011T123456Z.toml',
		changes: [
			{
				id: 's_theme',
				current: { type: 'theme', value: 'dark' },
				restored: { type: 'theme', value: 'light' }
			}
		]
	}
];

/** トレイから、選ぶ画面を頼まれているか */
let requested: boolean;

describe('設定画面の同期', () => {
	beforeEach(() => {
		invoked.mockReset();
		requested = false;
		invoked.mockImplementation((command) => {
			switch (command) {
				case 'take_sync_choice_request':
					return Promise.resolve(requested);
				case 'sync_conflicts':
					return Promise.resolve({ items: conflicts, unreadable: false });
				case 'sync_backups':
					return Promise.resolve(backups);
				case 'resolve_sync_conflicts':
					return Promise.resolve({ stale: false, rejected: [] });
				default:
					return Promise.resolve(undefined);
			}
		});
	});

	it('Pro でなければ、同期のまとまりを出さない', async () => {
		settings.current = settingsView({ mawokAccountSignedIn: true });
		const screen = await renderAt(m.settings_category_account);
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_out() }))
			.toBeVisible();
		await expect
			.element(screen.getByRole('switch', { name: m.settings_sync_settings() }))
			.not.toBeInTheDocument();
	});

	it('Pro なら同期する種類を切り替えられる', async () => {
		settings.current = settingsView({ mawokAccountSignedIn: true, proAvailable: true });
		const screen = await renderAt(m.settings_category_account);
		await screen.getByRole('switch', { name: m.settings_sync_settings() }).click();
		expect(callsOf(invoked, 'set_sync_kind')).toEqual([
			['set_sync_kind', { kind: 'settings', enabled: false }]
		]);
		await screen.getByRole('switch', { name: m.settings_sync_keys() }).click();
		await screen.getByRole('switch', { name: m.settings_sync_replacements() }).click();
		await screen.getByRole('switch', { name: m.settings_sync_snippets() }).click();
		await screen.getByRole('switch', { name: m.settings_sync_history() }).click();
		expect(callsOf(invoked, 'set_sync_kind')).toEqual(
			expect.arrayContaining([
				['set_sync_kind', { kind: 'keys', enabled: false }],
				['set_sync_kind', { kind: 'replacements', enabled: false }],
				['set_sync_kind', { kind: 'snippets', enabled: false }],
				['set_sync_kind', { kind: 'history', enabled: false }]
			])
		);
		await expect
			.element(screen.getByRole('button', { name: m.settings_sync_choice_open() }))
			.not.toBeInTheDocument();
	});

	it('Pro なら同期前の設定を選んで戻せる', async () => {
		settings.current = settingsView({ mawokAccountSignedIn: true, proAvailable: true });
		const screen = await renderAt(m.settings_category_account);
		await screen.getByRole('button', { name: m.settings_sync_restore_open() }).click();
		const dialog = screen.getByRole('alertdialog', { name: m.sync_restore_title() });
		const backupDate = new Intl.DateTimeFormat('ja', {
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit'
		}).format(new Date(Date.UTC(2026, 9, 11, 12, 34, 56)));
		const backup = dialog.getByRole('radio', {
			name: new RegExp(`${backupDate}.*${m.sync_restore_changes({ names: m.settings_theme() })}`)
		});
		await expect.element(backup).toBeVisible();
		const confirm = dialog.getByRole('button', { name: m.sync_restore_confirm() });
		await expect.element(confirm).toBeDisabled();
		await backup.click();
		await expect.element(confirm).toBeEnabled();
		await confirm.click();
		expect(callsOf(invoked, 'restore_sync_backup')).toEqual([
			['restore_sync_backup', { name: '20261011T123456Z.toml' }]
		]);
	});

	it('戻せる同期前の設定が無ければ、その理由を出す', async () => {
		settings.current = settingsView({ mawokAccountSignedIn: true, proAvailable: true });
		invoked.mockImplementation((command) =>
			Promise.resolve(
				command === 'sync_backups' ? [] : command === 'take_sync_choice_request' ? false : undefined
			)
		);
		const screen = await renderAt(m.settings_category_account);
		await screen.getByRole('button', { name: m.settings_sync_restore_open() }).click();
		await expect.element(screen.getByText(m.sync_restore_empty())).toBeVisible();
	});

	it('Pro で設定の同期がオンなら、設定の雲の印でその項目を外せる', async () => {
		settings.current = settingsView({ proAvailable: true, aiService: 'openai' });
		const screen = await render(Page);
		const toggle = screen.getByRole('button', {
			name: m.settings_sync_item({ name: m.settings_theme() })
		});
		await expect.element(toggle).toHaveAttribute('aria-pressed', 'true');
		await toggle.click();
		expect(callsOf(invoked, 'set_sync_excluded_setting')).toEqual([
			['set_sync_excluded_setting', { name: 'theme', sync: false }]
		]);
	});

	it('同期から外した設定は、オフの雲の印で出す', async () => {
		settings.current = settingsView({ proAvailable: true, syncExcludedSettings: ['theme'] });
		const screen = await render(Page);
		await expect
			.element(
				screen.getByRole('button', { name: m.settings_sync_item({ name: m.settings_theme() }) })
			)
			.toHaveAttribute('aria-pressed', 'false');
	});

	it('「文字を揃える」は行ごとに雲の印を出し、押した行だけを外す', async () => {
		settings.current = settingsView({ proAvailable: true });
		const screen = await renderAt(m.settings_category_copy);
		for (const name of [
			m.settings_char_width_punctuation(),
			m.settings_char_width_alphabet(),
			m.settings_char_width_digit(),
			m.settings_char_width_space(),
			m.settings_char_width_symbol(),
			m.settings_char_width_katakana()
		]) {
			await expect
				.element(screen.getByRole('button', { name: m.settings_sync_item({ name }) }))
				.toBeVisible();
		}
		await expect
			.element(
				screen.getByRole('button', {
					name: m.settings_sync_item({ name: m.settings_char_width() })
				})
			)
			.not.toBeInTheDocument();
		await screen
			.getByRole('button', {
				name: m.settings_sync_item({ name: m.settings_char_width_digit() })
			})
			.click();
		expect(callsOf(invoked, 'set_sync_excluded_setting')).toEqual([
			['set_sync_excluded_setting', { name: 'digit_width', sync: false }]
		]);
	});

	it('設定の同期がオフ、または Pro でなければ、設定の雲の印を出さない', async () => {
		settings.current = settingsView({
			proAvailable: true,
			syncKinds: {
				settings: false,
				keys: true,
				replacements: true,
				snippets: true,
				history: true
			}
		});
		let screen = await render(Page);
		expect(screen.container.querySelector('[data-sync-setting="theme"]')).toBeNull();

		settings.current = settingsView();
		screen = await render(Page);
		expect(screen.container.querySelector('[data-sync-setting="theme"]')).toBeNull();
	});

	it('同期から外せる設定はすべて、その場所に雲の印を出す', async () => {
		settings.current = settingsView({ proAvailable: true, aiService: 'openai' });
		const screen = await render(Page);
		const found = new Set<string>();
		const collect = () => {
			for (const toggle of screen.container.querySelectorAll<HTMLElement>('[data-sync-setting]')) {
				const name = toggle.dataset.syncSetting;
				if (name) found.add(name);
			}
		};

		collect();
		for (const label of [
			m.settings_category_draft(),
			m.settings_category_copy(),
			m.settings_category_snippets(),
			m.settings_category_ai()
		]) {
			await screen.getByRole('tab', { name: label }).click();
			collect();
		}

		expect(found.size).toBe(CONSTANTS.SYNCABLE_SETTINGS.length);
		expect([...found].sort()).toEqual([...CONSTANTS.SYNCABLE_SETTINGS].sort());
	});

	it('定型文の同期がオフなら、雲の印の代わりにオフの説明を出す', async () => {
		settings.current = settingsView({
			proAvailable: true,
			syncKinds: {
				settings: true,
				keys: true,
				replacements: true,
				snippets: false,
				history: true
			},
			snippets: [newSnippet('挨拶', 'こんにちは')]
		});
		const screen = await render(Page);
		await screen.getByRole('tab', { name: m.settings_category_snippets() }).click();
		await expect.element(screen.getByText(m.settings_sync_snippets_off())).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: m.settings_sync_item({ name: '挨拶' }) }))
			.not.toBeInTheDocument();
	});

	it('別々に変えた設定があると、選ぶ画面を開いて、選んだ項目だけを適用できる', async () => {
		settings.current = settingsView({
			mawokAccountSignedIn: true,
			proAvailable: true,
			syncConflicts: 2
		});
		const screen = await renderAt(m.settings_category_account);
		await expect.element(screen.getByText(m.settings_sync_choice_notice())).toBeVisible();
		await screen.getByRole('button', { name: m.settings_sync_choice_open() }).click();
		await expect
			.element(screen.getByRole('alertdialog', { name: m.sync_choice_title() }))
			.toBeVisible();
		const apply = screen.getByRole('button', { name: m.sync_choice_apply() });
		await expect.element(apply).toBeDisabled();
		await expect
			.element(screen.getByRole('alertdialog').getByText(m.settings_theme_light(), { exact: true }))
			.toBeVisible();
		const side = (name: Parameters<typeof sideName>[1]) =>
			screen.getByRole('radio', { name: sideName(m.settings_theme(), name) });
		await expect.element(side('later')).toBeChecked();
		await expect
			.element(side('other_device'))
			.toHaveAccessibleDescription(m.settings_theme_light());
		// 選んだ項目を「あとで選ぶ」に戻すと、適用するものが無くなる
		await side('this_device').click();
		await expect.element(apply).toBeEnabled();
		await side('later').click();
		await expect.element(apply).toBeDisabled();
		await side('other_device').click();
		await apply.click();
		expect(callsOf(invoked, 'resolve_sync_conflicts')).toEqual([
			['resolve_sync_conflicts', { choices: [{ id: 's_theme', seq: 7, side: 'other_device' }] }]
		]);
		await expect.element(screen.getByRole('alertdialog')).not.toBeInTheDocument();
	});

	it('選んでいる間に設定がまた変わっていたら、知らせて読み直す', async () => {
		settings.current = settingsView({
			mawokAccountSignedIn: true,
			proAvailable: true,
			syncConflicts: 2
		});
		invoked.mockImplementation((command) => {
			if (command === 'sync_conflicts')
				return Promise.resolve({ items: conflicts, unreadable: false });
			if (command === 'resolve_sync_conflicts')
				return Promise.resolve({ stale: true, rejected: [] });
			return Promise.resolve(undefined);
		});
		const screen = await renderAt(m.settings_category_account);
		await screen.getByRole('button', { name: m.settings_sync_choice_open() }).click();
		await screen.getByRole('radio', { name: sideName(m.settings_theme(), 'this_device') }).click();
		await screen.getByRole('button', { name: m.sync_choice_apply() }).click();
		await expect.element(screen.getByText(m.sync_choice_stale())).toBeVisible();
		expect(callsOf(invoked, 'sync_conflicts')).toHaveLength(2);
	});

	it('ほかのデバイスの設定を読めなければ、選ばせずに知らせる', async () => {
		settings.current = settingsView({
			mawokAccountSignedIn: true,
			proAvailable: true,
			syncConflicts: 1
		});
		invoked.mockImplementation((command) =>
			command === 'sync_conflicts' ? Promise.reject('sync.unreachable') : Promise.resolve(undefined)
		);
		const screen = await renderAt(m.settings_category_account);
		await screen.getByRole('button', { name: m.settings_sync_choice_open() }).click();
		await expect.element(screen.getByText(m.sync_choice_unreachable())).toBeVisible();
		await expect.element(screen.getByRole('radio')).not.toBeInTheDocument();
	});

	it('このバージョンで読めない設定だけが残っていれば、更新を案内する', async () => {
		settings.current = settingsView({
			mawokAccountSignedIn: true,
			proAvailable: true,
			syncConflicts: 1
		});
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'sync_conflicts' ? { items: [], unreadable: true } : undefined)
		);
		const screen = await renderAt(m.settings_category_account);
		await screen.getByRole('button', { name: m.settings_sync_choice_open() }).click();
		await expect.element(screen.getByText(m.sync_choice_unreadable())).toBeVisible();
	});

	it('開いたときに選ぶものが残っていなければ、閉じる', async () => {
		settings.current = settingsView({
			mawokAccountSignedIn: true,
			proAvailable: true,
			syncConflicts: 1
		});
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'sync_conflicts' ? { items: [], unreadable: false } : undefined)
		);
		const screen = await renderAt(m.settings_category_account);
		await screen.getByRole('button', { name: m.settings_sync_choice_open() }).click();
		await vi.waitFor(() => expect(callsOf(invoked, 'sync_conflicts')).toHaveLength(1));
		await expect.element(screen.getByRole('alertdialog')).not.toBeInTheDocument();
	});

	it('トレイから頼まれたら、「アカウント」に移って選ぶ画面を出す', async () => {
		requested = true;
		settings.current = settingsView({
			mawokAccountSignedIn: true,
			proAvailable: true,
			syncConflicts: 2
		});
		const screen = await render(Page);
		await expect
			.element(screen.getByRole('alertdialog', { name: m.sync_choice_title() }))
			.toBeVisible();
	});
});

// 決まりの中身（文字数・一致・符号の振り分け）は src/lib/sync-password.test.ts が見る。ここは、状態ごとの出し分けと流れの代表を見る。
describe('設定画面の同期のパスワード', () => {
	/** 同期のパスワードのコマンドが返す失敗。無ければ成功する */
	let failures: Record<string, string>;

	beforeEach(() => {
		invoked.mockReset();
		failures = {};
		invoked.mockImplementation((command) =>
			command in failures ? Promise.reject(failures[command]) : Promise.resolve(undefined)
		);
	});

	function pro(syncKeyStatus: 'notStarted' | 'needsPassword' | 'ready') {
		settings.current = settingsView({
			mawokAccountSignedIn: true,
			proAvailable: true,
			syncKeyStatus
		});
	}

	it('始めていなければ、パスワードを2回入れて同期を開始する', async () => {
		pro('notStarted');
		const screen = await renderAt(m.settings_category_account);
		const form = screen.getByRole('form', { name: m.settings_sync_password_create_title() });
		await expect.element(form.getByText(m.settings_sync_password_warning())).toBeVisible();
		await expect
			.element(screen.getByRole('switch', { name: m.settings_sync_settings() }))
			.not.toBeInTheDocument();
		await form.getByLabelText(m.settings_sync_password(), { exact: true }).fill('password1');
		await form.getByLabelText(m.settings_sync_password_confirm()).fill('password2');
		await form.getByRole('button', { name: m.settings_sync_start() }).click();
		await expect.element(form.getByText(m.sync_password_error_mismatch())).toBeVisible();
		// 欄に戻ったときも、読み上げで間違いが分かる
		await expect
			.element(form.getByLabelText(m.settings_sync_password_confirm()))
			.toHaveAccessibleDescription(m.sync_password_error_mismatch());
		expect(callsOf(invoked, 'start_sync')).toHaveLength(0);

		await form.getByLabelText(m.settings_sync_password_confirm()).fill('password1');
		await form.getByRole('button', { name: m.settings_sync_start() }).click();
		await vi.waitFor(() =>
			expect(invoked).toHaveBeenCalledWith('start_sync', { password: 'password1', replace: false })
		);
	});

	it('ほかのデバイスで始めていれば、パスワードを入れる。違えば欄の下に出す', async () => {
		pro('needsPassword');
		failures.unlock_sync = 'sync.wrong_password';
		const screen = await renderAt(m.settings_category_account);
		const form = screen.getByRole('form', { name: m.settings_sync_password_enter_title() });
		await form.getByLabelText(m.settings_sync_password()).fill('wrong-password');
		await form.getByRole('button', { name: m.settings_sync_start() }).click();
		await expect.element(form.getByText(m.sync_password_error_incorrect())).toBeVisible();
		expect(invoked).toHaveBeenCalledWith('unlock_sync', { password: 'wrong-password' });
	});

	it('パスワードを忘れたら、確かめてから新しいパスワードで始め直す', async () => {
		pro('needsPassword');
		const screen = await renderAt(m.settings_category_account);
		await screen.getByRole('button', { name: m.settings_sync_password_forgot() }).click();
		const dialog = screen.getByRole('alertdialog', { name: m.settings_sync_reset_confirm_title() });
		await dialog.getByRole('button', { name: m.settings_sync_reset_confirm_start() }).click();
		const form = screen.getByRole('form', { name: m.settings_sync_password_create_title() });
		await expect.element(form).toBeVisible();
		// 作るのをやめたら、入れる欄に戻る（窓口の写しは、作り終えるまで消さない）
		await form.getByRole('button', { name: m.common_cancel() }).click();
		await expect
			.element(screen.getByRole('form', { name: m.settings_sync_password_enter_title() }))
			.toBeVisible();
		expect(callsOf(invoked, 'start_sync')).toHaveLength(0);
	});

	it('同期していれば、今のパスワードを確かめて変える', async () => {
		pro('ready');
		const screen = await renderAt(m.settings_category_account);
		await expect
			.element(screen.getByRole('switch', { name: m.settings_sync_settings() }))
			.toBeVisible();
		await screen.getByRole('button', { name: m.settings_sync_password_change() }).click();
		const form = screen.getByRole('form', { name: m.settings_sync_password_change_title() });
		await form.getByLabelText(m.settings_sync_password_current()).fill('old-password');
		await form.getByLabelText(m.settings_sync_password_new(), { exact: true }).fill('new-password');
		await form.getByLabelText(m.settings_sync_password_new_confirm()).fill('new-password');
		await form.getByRole('button', { name: m.settings_sync_password_save() }).click();
		await expect.element(screen.getByText(m.settings_sync_password_changed())).toBeVisible();
		expect(invoked).toHaveBeenCalledWith('change_sync_password', {
			current: 'old-password',
			password: 'new-password'
		});
	});

	it('窓口の状態が変わっていたら、エラーを出さずに欄を閉じる', async () => {
		pro('ready');
		failures.change_sync_password = 'sync.state_changed';
		const screen = await renderAt(m.settings_category_account);
		await screen.getByRole('button', { name: m.settings_sync_password_change() }).click();
		const form = screen.getByRole('form', { name: m.settings_sync_password_change_title() });
		await form.getByLabelText(m.settings_sync_password_current()).fill('old-password');
		await form.getByLabelText(m.settings_sync_password_new(), { exact: true }).fill('new-password');
		await form.getByLabelText(m.settings_sync_password_new_confirm()).fill('new-password');
		await form.getByRole('button', { name: m.settings_sync_password_save() }).click();
		await expect.element(form).not.toBeInTheDocument();
		expect(screen.getByText('sync.state_changed').query()).toBeNull();
		expect(screen.getByText(m.settings_sync_password_changed()).query()).toBeNull();
	});

	it('同期していない状態に移ったら、書きかけの変更の欄を閉じる', async () => {
		pro('ready');
		const screen = await renderAt(m.settings_category_account);
		await screen.getByRole('button', { name: m.settings_sync_password_change() }).click();
		const form = screen.getByRole('form', { name: m.settings_sync_password_change_title() });
		await expect.element(form).toBeVisible();
		// ほかのデバイスのリセットで「入力」へ移り、入れ直して戻る
		pro('needsPassword');
		await expect
			.element(screen.getByRole('form', { name: m.settings_sync_password_enter_title() }))
			.toBeVisible();
		pro('ready');
		await expect
			.element(screen.getByRole('button', { name: m.settings_sync_password_change() }))
			.toBeVisible();
		expect(form.query()).toBeNull();
	});
});
