import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { resetMode, setMode } from 'mode-watcher';
import type { SettingsView as GeneratedSettingsView } from '$lib/bindings/SettingsView';
import { EVENTS } from '$lib/bindings/constants';
import { baseLocale, overwriteGetLocale, type Locale } from '$lib/paraglide/runtime';

export type { Action } from '$lib/bindings/Action';
export type { ActionOutput } from '$lib/bindings/ActionOutput';
export type { ActionEncoding } from '$lib/bindings/ActionEncoding';
export type { AiService } from '$lib/bindings/AiService';
export type { CharWidths } from '$lib/bindings/CharWidths';
export type { PairedDevice } from '$lib/bindings/PairedDevice';
export type { PunctuationStyle } from '$lib/bindings/PunctuationStyle';
export type { Replacement } from '$lib/bindings/Replacement';
export type { Snippet } from '$lib/bindings/Snippet';

/** Rust 側の get_settings と settings-changed が返す設定。locale は表示言語の設定と OS の言語から Rust 側で決めたもの */
export type SettingsView = Omit<GeneratedSettingsView, 'locale'> & { locale: Locale };

class AppSettings {
	// 丸ごと差し替えるだけなので、深い反応性は要らない
	current = $state.raw<SettingsView | null>(null);

	get locale(): Locale {
		return this.current?.locale ?? baseLocale;
	}
}

export const settings = new AppSettings();

function apply(view: SettingsView) {
	// Rust 側で別々のスレッドから知らせると、届く順が中身を作った順と入れ替わりうる。前に受け取ったものより古ければ捨てる
	if (settings.current && view.revision < settings.current.revision) return;
	settings.current = view;
	if (view.theme === 'system') {
		resetMode();
	} else {
		setMode(view.theme);
	}
}

/**
 * 起動時に一度だけ呼ぶ。設定を Rust 側から読み、変更を待ち受ける。
 * 文言は getLocale() を通して $state の言語を読むので、言語が変わると画面を読み込み直さずに描き直される（入力途中の下書きを消さない）
 */
export async function initSettings() {
	overwriteGetLocale(() => settings.locale);
	// 先に待ち受ける。読む前に始めると、読んでから待ち受けるまでの間に変わった知らせを取り逃がす。
	// 読んだものより先に届いた新しい知らせは、revision で古い方を捨てる
	await listen<SettingsView>(EVENTS.SETTINGS_CHANGED, (event) => apply(event.payload));
	apply(await invoke<SettingsView>('get_settings'));
}
