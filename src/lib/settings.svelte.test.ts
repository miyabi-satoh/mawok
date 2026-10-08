import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initSettings, settings } from '$lib/settings.svelte';
import { settingsView } from '$lib/test-support/settings-view';

const { listeners } = vi.hoisted(() => ({
	listeners: new Set<(event: { payload: unknown }) => void>()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn((_name: string, handler: (event: { payload: unknown }) => void) => {
		listeners.add(handler);
		return Promise.resolve(() => listeners.delete(handler));
	})
}));

const invoked = vi.mocked(invoke);

/** Rust 側から settings-changed が届く */
function changed(revision: number, theme: 'light' | 'dark') {
	for (const handler of listeners) handler({ payload: settingsView({ revision, theme }) });
}

describe('設定の受け取り', () => {
	beforeEach(() => {
		listeners.clear();
		settings.current = null;
	});

	it('前に受け取ったものより古い設定が後から届いたら捨てる', async () => {
		invoked.mockResolvedValue(settingsView({ revision: 2, theme: 'light' }));
		await initSettings();

		changed(1, 'dark');
		expect(settings.current?.theme).toBe('light');

		changed(3, 'dark');
		expect(settings.current?.theme).toBe('dark');
	});

	it('読んでいる間に届いた新しい設定を、読んだ古い設定で上書きしない', async () => {
		let answer: (view: unknown) => void = () => {};
		invoked.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const init = initSettings();
		await vi.waitFor(() => expect(listeners.size).toBe(1));

		changed(3, 'dark');
		answer(settingsView({ revision: 2, theme: 'light' }));
		await init;

		expect(settings.current?.revision).toBe(3);
		expect(settings.current?.theme).toBe('dark');
	});
});
