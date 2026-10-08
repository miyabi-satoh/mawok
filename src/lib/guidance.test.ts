import { afterEach, describe, expect, it } from 'vitest';
import { baseLocale, overwriteGetLocale, type Locale } from '$lib/paraglide/runtime';
import { draftGuidance } from './guidance';
import { DEFAULT_DRAFT_KEYS } from '$lib/test-support/settings-view';

const HOTKEY = 'CommandOrControl+Shift+Space';

function inLocale(locale: Locale) {
	overwriteGetLocale(() => locale);
}

afterEach(() => inLocale(baseLocale));

describe('draftGuidance', () => {
	it('設定がなければ、既定の案内を今のキーで作る', () => {
		inLocale('ja');
		expect(draftGuidance(null, HOTKEY, DEFAULT_DRAFT_KEYS, 'macos')).toBe(
			'ここに書いて ⌘Enter を押すと、コピーして元のアプリに戻ります。あとは貼るだけです。⌘⇧Space でいつでも呼び出せます。\nこの案内は設定（⌘,）で変えたり消したりできます。'
		);
	});

	it('英語では、文の間を空白で区切る。Windows では Ctrl でつないだキーで作る', () => {
		inLocale('en');
		expect(draftGuidance(null, HOTKEY, DEFAULT_DRAFT_KEYS, 'windows')).toBe(
			'Write here and press Ctrl+Enter to copy it and go back to your app, ready to paste. Bring this back anytime with Ctrl+Shift+Space.\nChange or remove this hint in Settings (Ctrl+,).'
		);
	});

	it('コピー・設定のキーやホットキーを外していたら、そのキーを書かない文にする', () => {
		inLocale('ja');
		const without = (hotkey: string, copy: string, settings: string) =>
			draftGuidance(null, hotkey, { ...DEFAULT_DRAFT_KEYS, copy, settings }, 'macos');

		expect(without(HOTKEY, '', DEFAULT_DRAFT_KEYS.settings)).toBe(
			'ここに書いてコピーすると、元のアプリに戻ります。あとは貼るだけです。⌘⇧Space でいつでも呼び出せます。\nこの案内は設定（⌘,）で変えたり消したりできます。'
		);
		expect(without(HOTKEY, DEFAULT_DRAFT_KEYS.copy, '')).toBe(
			'ここに書いて ⌘Enter を押すと、コピーして元のアプリに戻ります。あとは貼るだけです。⌘⇧Space でいつでも呼び出せます。\nこの案内は設定で変えたり消したりできます。'
		);
		expect(without('', '', '')).toBe(
			'ここに書いてコピーすると、元のアプリに戻ります。あとは貼るだけです。\nこの案内は設定で変えたり消したりできます。'
		);
	});

	it('自分で書いた案内は、キーを差し込まずにそのまま返す。空文字も空のまま', () => {
		expect(draftGuidance('自分用のメモ {copy}', HOTKEY, DEFAULT_DRAFT_KEYS, 'macos')).toBe(
			'自分用のメモ {copy}'
		);
		expect(draftGuidance('', HOTKEY, DEFAULT_DRAFT_KEYS, 'macos')).toBe('');
	});
});
