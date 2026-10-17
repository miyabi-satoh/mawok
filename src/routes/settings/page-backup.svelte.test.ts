import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backup } from '$lib/bindings/Backup';
import { m } from '$lib/paraglide/messages';
import { settings } from '$lib/settings.svelte';
import { callsOf } from '$lib/test-support/calls';
import { settingsView } from '$lib/test-support/settings-view';
import { renderAt } from './render-at';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const invoked = vi.mocked(invoke);

const backups: Backup[] = [
	{
		name: '20261017T123456Z.json',
		changes: [
			{
				id: 's_theme',
				current: { type: 'theme', value: 'dark' },
				restored: { type: 'theme', value: 'light' }
			}
		]
	},
	{ name: '20261016T000000Z.json', changes: [] }
];

const dateOf = (
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number
) =>
	new Intl.DateTimeFormat('ja', {
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit'
	}).format(new Date(Date.UTC(year, month - 1, day, hour, minute, second)));

// 差分の言い方は src/lib/backup-changes.test.ts が見る。ここは、窓を開いて選んで戻す流れの代表を見る
describe('設定のバックアップ', () => {
	beforeEach(() => {
		invoked.mockReset();
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'settings_backups' ? backups : undefined)
		);
		settings.current = settingsView();
	});

	it('選んだバックアップに戻せる。今と同じバックアップは選べない', async () => {
		const screen = await renderAt(m.settings_category_about);
		await screen.getByRole('button', { name: m.settings_backup_restore_open() }).click();
		const dialog = screen.getByRole('alertdialog', { name: m.backup_restore_title() });
		const backup = dialog.getByRole('radio', {
			name: new RegExp(
				`${dateOf(2026, 10, 17, 12, 34, 56)}.*${m.backup_restore_changes({ names: m.settings_theme() })}`
			)
		});
		const same = dialog.getByRole('radio', {
			name: new RegExp(`${dateOf(2026, 10, 16, 0, 0, 0)}.*${m.backup_restore_same()}`)
		});
		await expect.element(same).toBeDisabled();
		const confirm = dialog.getByRole('button', { name: m.backup_restore_confirm() });
		await expect.element(confirm).toBeDisabled();
		await backup.click();
		await confirm.click();
		expect(callsOf(invoked, 'restore_settings_backup')).toEqual([
			['restore_settings_backup', { name: '20261017T123456Z.json' }]
		]);
		// 閉じずに読み直し、戻せたことを出す
		await expect.element(dialog.getByText(m.backup_restored())).toBeVisible();
	});

	it('バックアップが無ければ、無いことを出す', async () => {
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'settings_backups' ? [] : undefined)
		);
		const screen = await renderAt(m.settings_category_about);
		await screen.getByRole('button', { name: m.settings_backup_restore_open() }).click();
		await expect.element(screen.getByText(m.backup_restore_empty())).toBeVisible();
	});

	it('今すぐバックアップすると、書いたか、もう書いてあったかを出す', async () => {
		let written = true;
		invoked.mockImplementation((command) =>
			Promise.resolve(command === 'back_up_settings' ? written : undefined)
		);
		const screen = await renderAt(m.settings_category_about);
		const button = screen.getByRole('button', { name: m.settings_backup_now() });
		await button.click();
		await expect.element(screen.getByText(m.settings_backup_done())).toBeVisible();
		written = false;
		await button.click();
		await expect.element(screen.getByText(m.settings_backup_unchanged())).toBeVisible();
	});
});
