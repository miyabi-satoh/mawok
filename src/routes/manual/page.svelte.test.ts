import { invoke } from '@tauri-apps/api/core';
import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { m } from '$lib/paraglide/messages';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import { settings } from '$lib/settings.svelte';
import { settingsView } from '$lib/test-support/settings-view';
import Page from './+page.svelte';

// ウィンドウの操作は Rust 側にあるので、呼ばれた内容だけを見る
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));

const invoked = vi.mocked(invoke);

describe('使い方のウィンドウ', () => {
	beforeEach(() => {
		invoked.mockClear();
		// 画面と同じく、言語は設定の $state から読む (hooks.client.ts の initSettings)
		overwriteGetLocale(() => settings.locale);
		settings.current = settingsView({ locale: 'ja' });
	});

	it('描いたら表示させ、目次から節の見出しへ移ってフォーカスを置き、Esc で閉じる', async () => {
		const screen = await render(Page, { props: { data: { platform: 'macos' } } as never });
		await expect.poll(() => invoked.mock.calls).toContainEqual(['show_manual_window']);

		const links = screen.getByRole('navigation', { name: m.manual_contents() }).getByRole('link');
		await expect.poll(() => links.all().length).toBeGreaterThan(1);
		const second = links.nth(1);
		const title = (await second.element()).textContent;
		await second.click();
		await expect.poll(() => document.activeElement?.textContent).toBe(title);
		expect(document.activeElement?.tagName).toBe('H2');

		await userEvent.keyboard('{Escape}');
		expect(invoked).toHaveBeenCalledWith('close_manual_window');
	});

	it('開いたまま表示言語を変えると、本文と目次がその言語に替わる', async () => {
		const screen = await render(Page, { props: { data: { platform: 'macos' } } as never });
		await expect
			.element(screen.getByRole('heading', { level: 1 }))
			.toHaveTextContent('Mawok の使い方');

		settings.current = settingsView({ locale: 'en' });
		await expect
			.element(screen.getByRole('heading', { level: 1 }))
			.toHaveTextContent('How to use Mawok');
		await expect.element(screen.getByRole('navigation', { name: 'Contents' })).toBeVisible();
	});
});
