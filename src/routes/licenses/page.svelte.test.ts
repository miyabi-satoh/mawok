import { invoke } from '@tauri-apps/api/core';
import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { m } from '$lib/paraglide/messages';
import { callsOf } from '$lib/test-support/calls';
import type { LicenseList } from './+page';
import Page from './+page.svelte';
// 条文の折り返しを見るテストのために、画面と同じ CSS を当てる
import '../layout.css';

// ウィンドウの操作とブラウザーで開く処理は Rust 側にあるので、呼ばれた内容だけを見る
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));

const invoked = vi.mocked(invoke);

const rust: LicenseList = {
	texts: [
		{ id: 'Apache-2.0', name: 'Apache License 2.0', text: 'Apache License text' },
		{ id: 'MIT', name: 'MIT License', text: 'MIT License\n\nCopyright (c) serde' },
		{ id: 'ISC', name: 'ISC License', text: 'ISC License text' }
	],
	packages: [
		{
			name: 'no-repo',
			versions: ['0.1.0'],
			license: 'MIT',
			repository: null,
			texts: [1]
		},
		{
			name: 'ring',
			versions: ['0.17.14'],
			license: 'ISC AND Apache-2.0',
			repository: 'https://github.com/briansmith/ring',
			texts: [2, 0]
		},
		{
			name: 'serde',
			versions: ['1.0.0'],
			license: 'MIT OR Apache-2.0',
			repository: 'https://github.com/serde-rs/serde',
			texts: [1]
		},
		{
			name: 'windows-sys',
			versions: ['0.59.0', '0.61.2'],
			license: 'MIT OR Apache-2.0',
			repository: 'https://github.com/microsoft/windows-rs',
			texts: [0]
		}
	]
};

const npm: LicenseList = {
	texts: [{ id: 'MIT', name: 'MIT', text: 'MIT License\n\nCopyright (c) svelte' }],
	packages: [
		{
			name: 'svelte',
			versions: ['5.57.0'],
			license: 'MIT',
			repository: 'https://github.com/sveltejs/svelte',
			texts: [0]
		}
	]
};

function renderPage(
	data: { rust: LicenseList | null; npm: LicenseList | null },
	platform: 'macos' | 'windows' = 'macos'
) {
	// 生成された PageProps は SvelteKit の型を多く含むので、ページが読む値だけを渡す
	return render(Page, { props: { data: { ...data, platform } } as never });
}

/** パッケージの行 (開閉の summary)。名前・版・ライセンスの式が並ぶ */
function row(screen: Awaited<ReturnType<typeof renderPage>>, name: string) {
	return screen.getByText(name, { exact: true });
}

describe('第三者のソフトウェア', () => {
	beforeEach(() => {
		invoked.mockClear();
	});

	it('パッケージごとに1行で、名前・版・ライセンスの式を出す', async () => {
		const screen = await renderPage({ rust, npm });

		await expect.element(screen.getByRole('heading', { name: m.licenses_title() })).toBeVisible();
		await expect.element(row(screen, 'ring')).toBeVisible();
		// 式は語ごとに分けて組むので、行の文字で確かめる
		await expect
			.element(screen.getByRole('group').filter({ hasText: 'ring' }))
			.toMatchTextContent('ISC AND Apache-2.0');
		// 同じ名前の違う版は1行にまとめ、版を並べる
		await expect.element(screen.getByText('0.59.0, 0.61.2', { exact: true })).toBeVisible();
		await expect.element(row(screen, 'svelte')).toBeVisible();
		expect(screen.getByRole('listitem').elements()).toHaveLength(5);
	});

	it('名前は下線の後ろでも折れるようにし、名前の文字は変えない', async () => {
		const msvc = {
			...rust.packages[3],
			name: 'windows_x86_64_msvc',
			versions: ['0.53.1']
		};
		const screen = await renderPage({ rust: { ...rust, packages: [msvc] }, npm });

		const name = row(screen, 'windows_x86_64_msvc');
		await expect.element(name).toBeVisible();
		expect(name.element().querySelectorAll('wbr')).toHaveLength(3);
	});

	it('条文の中の区切り線のような長い連なりも、幅に合わせて折る', async () => {
		const divider = { id: 'BSD', name: 'BSD License', text: `${'='.repeat(72)}\nBSD License text` };
		const pkg = { ...rust.packages[2], texts: [0] };
		const screen = await renderPage({ rust: { texts: [divider], packages: [pkg] }, npm });
		document.body.style.width = '300px';

		try {
			await row(screen, 'serde').click();
			const text = screen.getByText('BSD License text', { exact: false });
			await expect.element(text).toBeVisible();
			const element = text.element();
			expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
		} finally {
			document.body.style.width = '';
		}
	});

	it('描いたらウィンドウを表示させる', async () => {
		await renderPage({ rust, npm });

		await vi.waitFor(() => expect(invoked).toHaveBeenCalledWith('show_licenses_window'));
	});

	it('本文は閉じてあり、行を開くと、そのパッケージの条文を見出し付きで全部出す', async () => {
		const screen = await renderPage({ rust, npm });

		expect(screen.getByText('ISC License text').elements()).toHaveLength(0);
		await row(screen, 'ring').click();

		await expect.element(screen.getByText('ISC License text')).toBeVisible();
		await expect.element(screen.getByText('Apache License text')).toBeVisible();
		await expect.element(screen.getByRole('heading', { name: 'ISC License' })).toBeVisible();
		await expect.element(screen.getByRole('heading', { name: 'Apache License 2.0' })).toBeVisible();
		// ほかの行の本文は開かない
		expect(screen.getByText('Copyright (c) serde', { exact: false }).elements()).toHaveLength(0);
	});

	it('開いた行のソースの置き場所を押すと、ブラウザーで開かせる', async () => {
		const screen = await renderPage({ rust, npm });

		await row(screen, 'serde').click();
		await screen.getByRole('link', { name: 'https://github.com/serde-rs/serde' }).click();

		expect(invoked).toHaveBeenCalledWith('open_license_source', {
			url: 'https://github.com/serde-rs/serde'
		});
	});

	it('置き場所を持たないパッケージは、開いてもリンクを出さない', async () => {
		const screen = await renderPage({ rust, npm });

		await row(screen, 'no-repo').click();

		await expect.element(screen.getByText('Copyright (c) serde', { exact: false })).toBeVisible();
		expect(screen.getByRole('link').elements()).toHaveLength(0);
	});

	it('読み込めなかった側は、その旨だけを出し、もう一方は出す', async () => {
		const screen = await renderPage({ rust, npm: null });

		await expect.element(screen.getByText(m.licenses_unavailable())).toBeVisible();
		await expect.element(row(screen, 'serde')).toBeVisible();
	});

	it('macOS では Esc と Cmd+W で閉じる', async () => {
		await renderPage({ rust, npm }, 'macos');

		await userEvent.keyboard('{Escape}');
		await userEvent.keyboard('{Meta>}w{/Meta}');
		// Ctrl+W は macOS では閉じるキーではない
		await userEvent.keyboard('{Control>}w{/Control}');

		expect(callsOf(invoked, 'close_licenses_window')).toHaveLength(2);
	});

	it('Windows では Ctrl+W で閉じる', async () => {
		await renderPage({ rust, npm }, 'windows');

		await userEvent.keyboard('{Control>}w{/Control}');

		expect(invoked).toHaveBeenCalledWith('close_licenses_window');
	});
});
