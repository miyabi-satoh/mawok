import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '$lib/bindings/constants';
import type { PickedSettingsDir } from '$lib/bindings/PickedSettingsDir';
import { m } from '$lib/paraglide/messages';
import { settings } from '$lib/settings.svelte';
import { callsOf } from '$lib/test-support/calls';
import { settingsView } from '$lib/test-support/settings-view';
import { renderAt } from './render-at';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const invoked = vi.mocked(invoke);

const CLOUD = '/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Mawok';
const DEFAULT = '/Users/me/Library/Application Support/com.amiiby.mawok';

/** フォルダーを選ぶ窓と既定の置き場の答え。set_settings_dir は失敗させるときだけ符号を返す */
function answer(
	picked: PickedSettingsDir | null,
	defaultDir: PickedSettingsDir = { path: DEFAULT, hasSettings: false },
	setError?: string
) {
	invoked.mockImplementation((command) => {
		if (command === 'pick_settings_dir') return Promise.resolve(picked);
		if (command === 'default_settings_dir') return Promise.resolve(defaultDir);
		if (command === 'set_settings_dir' && setError) return Promise.reject(setError);
		return Promise.resolve(undefined);
	});
}

const change = () => m.settings_folder_change();

describe('設定の置き場', () => {
	beforeEach(() => {
		invoked.mockReset();
		settings.current = settingsView({ settingsDir: DEFAULT, settingsDirIsDefault: true });
	});

	it('今の置き場を出し、既定のままなら「既定に戻す」を出さない', async () => {
		const screen = await renderAt(m.settings_category_sync);
		await expect.element(screen.getByText(DEFAULT)).toBeVisible();
		expect(screen.getByRole('button', { name: m.settings_folder_reset() }).elements()).toEqual([]);
	});

	it('設定の無いフォルダーを選ぶと、聞かずにこのデバイスの設定で替える', async () => {
		answer({ path: CLOUD, hasSettings: false });
		const screen = await renderAt(m.settings_category_sync);
		await screen.getByRole('button', { name: change() }).click();
		await vi.waitFor(() =>
			expect(callsOf(invoked, 'set_settings_dir')).toEqual([
				['set_settings_dir', { path: CLOUD, useExisting: false }]
			])
		);
		expect(screen.getByRole('alertdialog').elements()).toEqual([]);
	});

	it('設定のあるフォルダーを選ぶと聞き、選んだほうで替える', async () => {
		answer({ path: CLOUD, hasSettings: true });
		const screen = await renderAt(m.settings_category_sync);
		await screen.getByRole('button', { name: change() }).click();
		const dialog = screen.getByRole('alertdialog', {
			name: m.settings_folder_has_settings_title()
		});
		await expect.element(dialog.getByText(CLOUD)).toBeVisible();
		await dialog.getByRole('button', { name: m.settings_folder_use_existing() }).click();
		expect(callsOf(invoked, 'set_settings_dir')).toEqual([
			['set_settings_dir', { path: CLOUD, useExisting: true }]
		]);
	});

	it('既定に戻すときも、既定の置き場に設定があれば聞く', async () => {
		settings.current = settingsView({ settingsDir: CLOUD, settingsDirIsDefault: false });
		answer(null, { path: DEFAULT, hasSettings: true });
		const screen = await renderAt(m.settings_category_sync);
		await screen.getByRole('button', { name: m.settings_folder_reset() }).click();
		const dialog = screen.getByRole('alertdialog', {
			name: m.settings_folder_has_settings_title()
		});
		await dialog.getByRole('button', { name: m.settings_folder_overwrite() }).click();
		expect(callsOf(invoked, 'set_settings_dir')).toEqual([
			['set_settings_dir', { path: null, useExisting: false }]
		]);
	});

	it('選んだフォルダーの設定のファイルを読めなければ、その旨を出す', async () => {
		answer({ path: CLOUD, hasSettings: true }, undefined, ERROR_CODES.SETTINGS_FILE_UNREADABLE);
		const screen = await renderAt(m.settings_category_sync);
		await screen.getByRole('button', { name: change() }).click();
		await screen.getByRole('button', { name: m.settings_folder_use_existing() }).click();
		await expect.element(screen.getByText(m.settings_folder_unreadable())).toBeVisible();
	});
});
