import { invoke } from '@tauri-apps/api/core';
import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { settings, type AiService, type SettingsView } from '$lib/settings.svelte';
import { settingsView } from '$lib/test-support/settings-view';
import Page from './+page.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const invoked = vi.mocked(invoke);

function view(service: AiService = 'none'): SettingsView {
	return settingsView({
		aiService: service,
		aiModels: { gemini: 'gemini-model', anthropic: 'anthropic-model' }
	});
}

/** 返事を後から返せるコマンドの呼び出し。呼ばれた順に並ぶ */
type Pending = {
	command: string;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
};
let pending: Pending[];

/** 呼ばれた順で、まだ返事をしていない command の呼び出しを取り出す */
function take(command: string): Pending {
	const index = pending.findIndex((call) => call.command === command);
	if (index < 0) throw new Error(`${command} is not pending`);
	return pending.splice(index, 1)[0];
}

/** 返事の後の effect と、ダイアログの片付けまでを流し切る */
async function flush() {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();
	}
}

/** 返事を待っている command の呼び出しがあるまで待つ */
async function waitPending(command: string) {
	await vi.waitFor(() => expect(pending.some((call) => call.command === command)).toBe(true));
}

/** 設定が替わり、settings-changed が届いたとする */
async function changeSettings(next: SettingsView) {
	settings.current = next;
	await tick();
}

async function openActions() {
	const screen = await render(Page);
	await screen.getByRole('tab', { name: m.settings_category_actions() }).click();
	return screen;
}

describe('設定画面のアクションの AI サービス選択', () => {
	beforeEach(() => {
		invoked.mockClear();
		pending = [];
		invoked.mockImplementation((command) =>
			command === 'has_ai_key' ? Promise.resolve(false) : Promise.resolve(undefined)
		);
		settings.current = view();
	});

	it('サービスを替えると、選んだサービスのモデルを表示する', async () => {
		const screen = await openActions();

		settings.current = { ...view('anthropic'), aiModels: { anthropic: 'anthropic-model' } };
		await expect
			.element(screen.getByLabelText(m.settings_ai_model()))
			.toHaveValue('anthropic-model');
		await expect
			.element(screen.getByRole('combobox', { name: m.settings_ai_service() }))
			.toHaveDisplayValue('Anthropic');
	});

	it('サービスを替えたときの古いキー確認で、今の表示を上書きしない', async () => {
		invoked.mockReset();
		pending = [];
		invoked.mockImplementation((command) => {
			return new Promise((resolve, reject) => pending.push({ command, resolve, reject }));
		});
		settings.current = {
			...view('gemini'),
			aiConsent: 'gemini'
		};
		const screen = await openActions();
		await waitPending('has_ai_key');
		take('has_ai_key').resolve(true);
		await expect
			.element(screen.getByRole('button', { name: m.settings_ai_key_delete() }))
			.toBeVisible();

		await screen.getByRole('button', { name: m.settings_ai_key_delete() }).click();
		const deleting = take('delete_ai_key');
		await changeSettings({
			...view('anthropic'),
			aiConsent: 'anthropic'
		});
		await waitPending('has_ai_key');
		take('has_ai_key').resolve(true);
		deleting.resolve(undefined);
		await flush();

		await expect
			.element(screen.getByText(m.settings_ai_key_present(), { exact: true }))
			.toBeVisible();
		await waitPending('has_ai_key');
		take('has_ai_key').resolve(true);
		await flush();
		await expect
			.element(screen.getByText(m.settings_ai_key_present(), { exact: true }))
			.toBeVisible();
	});

	it('キーを消すと、入っていないと出す', async () => {
		let hasKey = true;
		invoked.mockImplementation((command) => {
			if (command === 'delete_ai_key') {
				hasKey = false;
				return Promise.resolve(undefined);
			}
			return command === 'has_ai_key' ? Promise.resolve(hasKey) : Promise.resolve(undefined);
		});
		settings.current = { ...view('gemini'), aiConsent: 'gemini' };
		const screen = await openActions();

		await screen.getByRole('button', { name: m.settings_ai_key_delete() }).click();

		expect(invoked).toHaveBeenCalledWith('delete_ai_key', undefined);
		await expect
			.element(screen.getByText(m.settings_ai_key_absent(), { exact: true }))
			.toBeVisible();
	});

	it('キーを入れるのに失敗しても、キーがあるかを確かめ直し、表示を空のまま残さない', async () => {
		let checks = 0;
		invoked.mockImplementation((command) => {
			if (command === 'set_ai_key') return Promise.reject("couldn't save");
			if (command === 'has_ai_key') {
				checks += 1;
				return Promise.resolve(false);
			}
			return Promise.resolve(undefined);
		});
		settings.current = { ...view('gemini'), aiConsent: 'gemini' };
		const screen = await openActions();

		await screen.getByRole('button', { name: m.settings_ai_key_enter() }).click();
		await screen.getByLabelText(m.settings_ai_key_input()).fill('secret-key');
		await screen.getByRole('button', { name: m.settings_ai_key_save() }).click();

		await vi.waitFor(() => expect(checks).toBe(2));
		await expect
			.element(screen.getByText(m.settings_failed({ error: "couldn't save" })))
			.toBeVisible();
		await expect.element(screen.getByLabelText(m.settings_ai_key_input())).toBeVisible();
	});

	it('キー保存が符号で断られたら、対応する案内を出す', async () => {
		invoked.mockImplementation((command) => {
			if (command === 'set_ai_key') return Promise.reject('action.no_key');
			return command === 'has_ai_key' ? Promise.resolve(false) : Promise.resolve(undefined);
		});
		settings.current = { ...view('gemini'), aiConsent: 'gemini' };
		const screen = await openActions();

		await screen.getByRole('button', { name: m.settings_ai_key_enter() }).click();
		await screen.getByLabelText(m.settings_ai_key_input()).fill('secret-key');
		await screen.getByRole('button', { name: m.settings_ai_key_save() }).click();

		await expect.element(screen.getByText(m.action_error_no_key())).toBeVisible();
	});
});
