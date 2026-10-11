import { invoke } from '@tauri-apps/api/core';
import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
					return Promise.resolve(conflicts);
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

	it('Pro なら同期する種類を切り替えられ、別々に変えた設定が無ければ知らせを出さない', async () => {
		settings.current = settingsView({ mawokAccountSignedIn: true, proAvailable: true });
		const screen = await openAccount();
		await screen.getByRole('switch', { name: m.settings_sync_settings() }).click();
		expect(callsOf(invoked, 'set_sync_settings')).toEqual([
			['set_sync_settings', { enabled: false }]
		]);
		await screen.getByRole('switch', { name: m.settings_sync_history() }).click();
		expect(callsOf(invoked, 'set_sync_history')).toEqual([
			['set_sync_history', { enabled: false }]
		]);
		await expect
			.element(screen.getByRole('button', { name: m.settings_sync_choice_open() }))
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
		await screen.getByRole('radio', { name: sideName(m.settings_theme(), 'other_device') }).click();
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
			if (command === 'sync_conflicts') return Promise.resolve(conflicts);
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
