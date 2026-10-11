import { invoke } from '@tauri-apps/api/core';
import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSTANTS } from '$lib/bindings/constants';
import type { SyncConflict } from '$lib/bindings/SyncConflict';
import { m } from '$lib/paraglide/messages';
import { settings } from '$lib/settings.svelte';
import { sideName } from '$lib/sync-choices';
import { callsOf } from '$lib/test-support/calls';
import { settingsView } from '$lib/test-support/settings-view';
import Page from './+page.svelte';

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

/** トレイから、選ぶ画面を頼まれているか */
let requested: boolean;

async function openAccount() {
	const screen = await render(Page);
	await screen.getByRole('tab', { name: m.settings_category_account() }).click();
	return screen;
}

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
				case 'resolve_sync_conflicts':
					return Promise.resolve({ stale: false, rejected: [] });
				default:
					return Promise.resolve(undefined);
			}
		});
	});

	it('Pro でなければ、同期のまとまりを出さない', async () => {
		settings.current = settingsView({ mawokAccountSignedIn: true });
		const screen = await openAccount();
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_out() }))
			.toBeVisible();
		await expect
			.element(screen.getByRole('switch', { name: m.settings_sync_settings() }))
			.not.toBeInTheDocument();
	});

	it('Pro なら同期する種類を切り替えられる', async () => {
		settings.current = settingsView({ mawokAccountSignedIn: true, proAvailable: true });
		const screen = await openAccount();
		await screen.getByRole('switch', { name: m.settings_sync_settings() }).click();
		expect(callsOf(invoked, 'set_sync_kind')).toEqual([
			['set_sync_kind', { kind: 'settings', enabled: false }]
		]);
		await screen.getByRole('switch', { name: m.settings_sync_keys() }).click();
		await screen.getByRole('switch', { name: m.settings_sync_replacements() }).click();
		await screen.getByRole('switch', { name: m.settings_sync_snippets() }).click();
		await screen.getByRole('switch', { name: m.settings_sync_actions() }).click();
		await screen.getByRole('switch', { name: m.settings_sync_history() }).click();
		expect(callsOf(invoked, 'set_sync_kind')).toEqual(
			expect.arrayContaining([
				['set_sync_kind', { kind: 'keys', enabled: false }],
				['set_sync_kind', { kind: 'replacements', enabled: false }],
				['set_sync_kind', { kind: 'snippets', enabled: false }],
				['set_sync_kind', { kind: 'actions', enabled: false }],
				['set_sync_kind', { kind: 'history', enabled: false }]
			])
		);
		await expect
			.element(screen.getByRole('button', { name: m.settings_sync_choice_open() }))
			.not.toBeInTheDocument();
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

	it('設定の同期がオフ、または Pro でなければ、設定の雲の印を出さない', async () => {
		settings.current = settingsView({
			proAvailable: true,
			syncKinds: {
				settings: false,
				keys: true,
				replacements: true,
				snippets: true,
				actions: true,
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
			m.settings_category_actions()
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
				actions: true,
				history: true
			},
			snippets: [{ id: 'a', name: '挨拶', body: 'こんにちは', sync: true }]
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
		const screen = await openAccount();
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
		const screen = await openAccount();
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
		const screen = await openAccount();
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
		const screen = await openAccount();
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
		const screen = await openAccount();
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
