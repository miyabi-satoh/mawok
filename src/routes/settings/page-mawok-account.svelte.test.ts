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

/** サインインしているか（has_ai_key の返事）と、窓口が返すアカウントの様子 */
let signedIn: boolean;
let status: unknown;

/** MAWOK_SIGN_IN_ENDED を受け取る関数。画面が listen したときに受け取る */
function signInEnded(signedInNow: boolean, id = 1) {
	const handler = listened.mock.calls.findLast(
		([event]) => event === EVENTS.MAWOK_SIGN_IN_ENDED
	)?.[1];
	if (!handler) throw new Error('not listening');
	signedIn = signedInNow;
	handler({ event: EVENTS.MAWOK_SIGN_IN_ENDED, id: 0, payload: { id, signedIn: signedInNow } });
}

async function openActions() {
	const screen = await render(Page);
	await screen.getByRole('tab', { name: m.settings_category_actions() }).click();
	return screen;
}

describe('設定画面の Mawok のアカウント', () => {
	beforeEach(() => {
		invoked.mockReset();
		listened.mockClear();
		signedIn = false;
		status = { email: 'me@example.com', remainingPercent: 42 };
		invoked.mockImplementation((command) => {
			switch (command) {
				case 'has_ai_key':
					return Promise.resolve(signedIn);
				case 'mawok_account_status':
					return Promise.resolve(signedIn ? status : null);
				case 'start_mawok_sign_in':
					return Promise.resolve({ id: 1 });
				default:
					return Promise.resolve(undefined);
			}
		});
		settings.current = settingsView({ aiService: 'mawok', aiConsent: 'mawok' });
	});

	it('サインインしていなければ、キーとモデルの代わりにサインインを出す', async () => {
		const screen = await openActions();
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
		await expect
			.element(screen.getByText(m.settings_ai_key(), { exact: true }))
			.not.toBeInTheDocument();
		await expect.element(screen.getByLabelText(m.settings_ai_model())).not.toBeInTheDocument();
	});

	it('ウィンドウに戻ると、答えが来るまで前の残りを出したまま問い合わせ直す', async () => {
		signedIn = true;
		const screen = await openActions();
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
		resolve({ email: 'me@example.com', remainingPercent: 97 });
		await expect
			.element(screen.getByText(m.settings_mawok_remaining({ percent: 97 })))
			.toBeVisible();
	});

	it('サインインを始めるとブラウザでの手順を出し、結ばれたらアカウントと残りを出す', async () => {
		const screen = await openActions();
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

	it('結べなかったら、もう一度サインインするよう出す', async () => {
		const screen = await openActions();
		await screen.getByRole('button', { name: m.settings_mawok_sign_in() }).click();
		await expect.element(screen.getByText(m.settings_mawok_signing_in())).toBeVisible();
		signInEnded(false);
		await expect.element(screen.getByText(m.settings_mawok_sign_in_expired())).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
	});

	it('前の申し込みの終わりでは、サインインの途中の表示を消さない', async () => {
		const screen = await openActions();
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
			if (command === 'has_ai_key') return Promise.resolve(false);
			if (command === 'mawok_sign_in_pending') return Promise.resolve({ id: 5 });
			return Promise.resolve(undefined);
		});
		const screen = await openActions();
		await expect.element(screen.getByText(m.settings_mawok_signing_in())).toBeVisible();
		await screen.getByRole('tab', { name: m.settings_category_general() }).click();
		expect(callsOf(invoked, 'cancel_mawok_sign_in')).toHaveLength(0);
	});

	it('やめると、待ち続けているサインインを打ち切る', async () => {
		const screen = await openActions();
		await screen.getByRole('button', { name: m.settings_mawok_sign_in() }).click();
		await screen.getByRole('button', { name: m.settings_mawok_sign_in_cancel() }).click();
		expect(callsOf(invoked, 'cancel_mawok_sign_in').length).toBeGreaterThan(0);
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
	});

	it('サインアウトすると、サインインしていない表示に戻る', async () => {
		signedIn = true;
		const screen = await openActions();
		await expect.element(screen.getByText('me@example.com')).toBeVisible();
		signedIn = false;
		await screen.getByRole('button', { name: m.settings_mawok_sign_out() }).click();
		expect(callsOf(invoked, 'sign_out_mawok')).toHaveLength(1);
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
	});

	it('窓口でトークンが外されていたら、サインインしていない表示にする', async () => {
		signedIn = true;
		invoked.mockImplementation((command) => {
			if (command === 'has_ai_key') return Promise.resolve(signedIn);
			if (command === 'mawok_account_status') {
				// 窓口で外されていたので、Rust 側が手元のトークンも消した
				signedIn = false;
				return Promise.resolve(null);
			}
			return Promise.resolve(undefined);
		});
		const screen = await openActions();
		await expect
			.element(screen.getByRole('button', { name: m.settings_mawok_sign_in() }))
			.toBeVisible();
	});

	it('残りを確かめられなかったら、そう出す', async () => {
		signedIn = true;
		invoked.mockImplementation((command) => {
			if (command === 'has_ai_key') return Promise.resolve(true);
			if (command === 'mawok_account_status') return Promise.reject('account.unreachable');
			return Promise.resolve(undefined);
		});
		const screen = await openActions();
		await expect.element(screen.getByText(m.settings_mawok_status_unknown())).toBeVisible();
		await expect.element(screen.getByText(m.account_error_unreachable())).toBeVisible();
	});
});
