import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '$lib/bindings/constants';
import { m } from '$lib/paraglide/messages';
import { settings } from '$lib/settings.svelte';
import { callsOf } from '$lib/test-support/calls';
import { settingsView } from '$lib/test-support/settings-view';
import Page from './+page.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const invoked = vi.mocked(invoke);
const listened = vi.mocked(listen);

/** サインインしているかと、窓口が返すアカウントの様子 */
let signedIn: boolean;
let status: unknown;

function accountStatus(remainingPercent = 42, pro = false) {
	return {
		email: 'me@example.com',
		accountId: '0123456789abcdef0123456789abcdef',
		remainingPercent,
		pro: { active: pro, until: null, plan: null, trial: false }
	};
}

function setSettings(options: { proAvailable?: boolean } = {}) {
	settings.current = settingsView({
		aiService: 'mawok',
		aiConsent: 'mawok',
		mawokAccountSignedIn: signedIn,
		...options
	});
}

/** MAWOK_SIGN_IN_ENDED を受け取る関数。画面が listen したときに受け取る */
function signInEnded(signedInNow: boolean, id = 1) {
	const handler = listened.mock.calls.findLast(
		([event]) => event === EVENTS.MAWOK_SIGN_IN_ENDED
	)?.[1];
	if (!handler) throw new Error('not listening');
	signedIn = signedInNow;
	setSettings();
	handler({ event: EVENTS.MAWOK_SIGN_IN_ENDED, id: 0, payload: { id, signedIn: signedInNow } });
}

async function openAccount() {
	const screen = await render(Page);
	await screen.getByRole('tab', { name: m.settings_category_account() }).click();
	return screen;
}

describe('設定画面の Mawok のアカウント', () => {
	beforeEach(() => {
		invoked.mockReset();
		listened.mockClear();
		signedIn = false;
		status = accountStatus();
		invoked.mockImplementation((command) => {
			switch (command) {
				case 'mawok_account_status':
					return Promise.resolve(signedIn ? status : null);
				case 'start_mawok_sign_in':
					return Promise.resolve({ id: 1 });
				default:
					return Promise.resolve(undefined);
			}
		});
		setSettings();
	});

	it('アカウントの区分にサインインを出し、設定を載せたときに状態を問い合わせる', async () => {
		const screen = await openAccount();
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
		await vi.waitFor(() => expect(callsOf(invoked, 'mawok_account_status')).not.toHaveLength(0));
	});

	it('ウィンドウに戻ると、答えが来るまで前の残りを出したまま問い合わせ直す', async () => {
		signedIn = true;
		setSettings();
		const screen = await openAccount();
		await expect
			.element(screen.getByText(m.settings_mawok_remaining({ percent: 42 })))
			.toBeVisible();
		const { promise, resolve } = Promise.withResolvers<unknown>();
		status = promise;
		window.dispatchEvent(new Event('focus'));
		await vi.waitFor(() => expect(callsOf(invoked, 'mawok_account_status')).toHaveLength(2));
		await expect
			.element(screen.getByText(m.settings_mawok_remaining({ percent: 42 })))
			.toBeVisible();
		resolve(accountStatus(97));
		await expect
			.element(screen.getByText(m.settings_mawok_remaining({ percent: 97 })))
			.toBeVisible();
	});

	it('サインインを始めるとブラウザでの手順を出し、結ばれたらアカウントと残りを出す', async () => {
		const screen = await openAccount();
		await screen.getByRole('button', { name: m.settings_mawok_sign_in() }).click();
		await expect.element(screen.getByText(m.settings_mawok_signing_in())).toBeVisible();

		await screen.getByRole('button', { name: m.settings_mawok_open_again() }).click();
		expect(callsOf(invoked, 'reopen_mawok_sign_in_page')).toHaveLength(1);

		signInEnded(true);
		await expect.element(screen.getByText('me@example.com')).toBeVisible();
		await expect
			.element(screen.getByText(m.settings_mawok_remaining({ percent: 42 })))
			.toBeVisible();
		await screen.getByRole('button', { name: m.settings_mawok_buy() }).click();
		expect(callsOf(invoked, 'open_mawok_buy_page')).toHaveLength(1);
	});

	it('Pro ならその状態を出す', async () => {
		signedIn = true;
		status = accountStatus(42, true);
		setSettings();
		const screen = await openAccount();
		await expect.element(screen.getByText(m.settings_mawok_pro())).toBeVisible();
	});

	it('窓口につながらなくても、猶予中の Pro を出す', async () => {
		signedIn = true;
		invoked.mockImplementation((command) => {
			if (command === 'mawok_account_status') return Promise.reject('account.unreachable');
			return Promise.resolve(undefined);
		});
		setSettings({ proAvailable: true });
		const screen = await openAccount();
		await expect.element(screen.getByText(m.settings_mawok_pro())).toBeVisible();
	});

	it('結べなかったら、もう一度サインインするよう出す', async () => {
		const screen = await openAccount();
		await screen.getByRole('button', { name: m.settings_mawok_sign_in() }).click();
		await expect.element(screen.getByText(m.settings_mawok_signing_in())).toBeVisible();
		signInEnded(false);
		await expect.element(screen.getByText(m.settings_mawok_sign_in_expired())).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
	});

	it('前の申し込みの終わりでは、サインインの途中の表示を消さない', async () => {
		const screen = await openAccount();
		await screen.getByRole('button', { name: m.settings_mawok_sign_in() }).click();
		await expect.element(screen.getByText(m.settings_mawok_signing_in())).toBeVisible();
		signInEnded(false, 0);
		await expect.element(screen.getByText(m.settings_mawok_signing_in())).toBeVisible();
		await expect
			.element(screen.getByText(m.settings_mawok_sign_in_expired()))
			.not.toBeInTheDocument();
	});

	it('開き直すと、続いている申し込みを出し直し、閉じても打ち切らない', async () => {
		invoked.mockImplementation((command) => {
			if (command === 'mawok_sign_in_pending') return Promise.resolve({ id: 5 });
			if (command === 'mawok_account_status') return Promise.resolve(null);
			return Promise.resolve(undefined);
		});
		const screen = await openAccount();
		await expect.element(screen.getByText(m.settings_mawok_signing_in())).toBeVisible();
		await screen.getByRole('tab', { name: m.settings_category_general() }).click();
		expect(callsOf(invoked, 'cancel_mawok_sign_in')).toHaveLength(0);
	});

	it('やめると、待ち続けているサインインを打ち切る', async () => {
		const screen = await openAccount();
		await screen.getByRole('button', { name: m.settings_mawok_sign_in() }).click();
		await screen.getByRole('button', { name: m.settings_mawok_sign_in_cancel() }).click();
		expect(callsOf(invoked, 'cancel_mawok_sign_in')).toHaveLength(1);
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
	});

	it('サインアウトすると、サインインしていない表示に戻る', async () => {
		signedIn = true;
		setSettings();
		invoked.mockImplementation((command) => {
			if (command === 'sign_out_mawok') {
				signedIn = false;
				setSettings();
			}
			if (command === 'mawok_account_status') return Promise.resolve(signedIn ? status : null);
			return Promise.resolve(undefined);
		});
		const screen = await openAccount();
		await expect.element(screen.getByText('me@example.com')).toBeVisible();
		await screen.getByRole('button', { name: m.settings_mawok_sign_out() }).click();
		expect(callsOf(invoked, 'sign_out_mawok')).toHaveLength(1);
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
	});

	it('窓口でトークンが外されていたら、サインインしていない表示にする', async () => {
		signedIn = true;
		setSettings();
		invoked.mockImplementation((command) => {
			if (command === 'mawok_account_status') {
				// 窓口で外されていたので、Rust 側が手元のトークンも消した
				signedIn = false;
				setSettings();
				return Promise.resolve(null);
			}
			return Promise.resolve(undefined);
		});
		const screen = await openAccount();
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
	});

	it('残りを確かめられなかったら、そう出す', async () => {
		signedIn = true;
		setSettings();
		invoked.mockImplementation((command) => {
			if (command === 'mawok_account_status') return Promise.reject('account.unreachable');
			return Promise.resolve(undefined);
		});
		const screen = await openAccount();
		await expect.element(screen.getByText(m.settings_mawok_status_unknown())).toBeVisible();
		// 裏の確かめ直しなので、どの区分を開いていても出る画面のエラーにはしない
		await expect.element(screen.getByText(m.account_error_unreachable())).not.toBeInTheDocument();
	});

	it('アクションからアカウントを開ける', async () => {
		const screen = await render(Page);
		await screen.getByRole('tab', { name: m.settings_category_actions() }).click();
		await expect.element(screen.getByText(m.settings_actions_mawok_sign_in())).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.not.toBeInTheDocument();
		await screen.getByRole('button', { name: m.settings_account_open() }).click();
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
	});

	it('機器からアカウントを開ける', async () => {
		const screen = await render(Page);
		await screen.getByRole('tab', { name: m.settings_category_devices() }).click();
		await expect.element(screen.getByText(m.settings_devices_pro_sign_in())).toBeVisible();
		await screen.getByRole('button', { name: m.settings_account_open() }).click();
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
	});
});
