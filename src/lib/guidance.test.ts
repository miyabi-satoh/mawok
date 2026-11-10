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
			'ここに書いて ⌘Enter を押すと、コピーして閉じます。\n⌘⇧Space でいつでも呼び出せます。この案内は設定 (⌘,) で変えたり消したりできます。'
		);
	});

	it('英語では、文の間を空白で区切る。Windows では Ctrl でつないだキーで作る', () => {
		inLocale('en');
		expect(draftGuidance(null, HOTKEY, DEFAULT_DRAFT_KEYS, 'windows')).toBe(
			'Write here and press Ctrl+Enter to copy it and close.\nBring this back anytime with Ctrl+Shift+Space. Change or remove this hint in Settings (Ctrl+,).'
		);
	});

	it('コピー・設定のキーやホットキーを外していたら、そのキーを書かない文にする', () => {
		inLocale('ja');
		const without = (hotkey: string, copy: string, settings: string) =>
			draftGuidance(null, hotkey, { ...DEFAULT_DRAFT_KEYS, copy, settings }, 'macos');

		expect(without(HOTKEY, '', DEFAULT_DRAFT_KEYS.settings)).toBe(
			'ここに書いて「コピー」を押すと、コピーして閉じます。\n⌘⇧Space でいつでも呼び出せます。この案内は設定 (⌘,) で変えたり消したりできます。'
		);
		expect(without(HOTKEY, DEFAULT_DRAFT_KEYS.copy, '')).toBe(
			'ここに書いて ⌘Enter を押すと、コピーして閉じます。\n⌘⇧Space でいつでも呼び出せます。この案内は設定で変えたり消したりできます。'
		);
		expect(without('', '', '')).toBe(
			'ここに書いて「コピー」を押すと、コピーして閉じます。\nこの案内は設定で変えたり消したりできます。'
		);
	});

	it('ホットキーを登録できていなければ、呼び出せると書かずに、登録できないことを書く', () => {
		inLocale('ja');
		expect(draftGuidance(null, HOTKEY, DEFAULT_DRAFT_KEYS, 'macos', true)).toBe(
			'ここに書いて ⌘Enter を押すと、コピーして閉じます。\nホットキー (⌘⇧Space) を登録できません。設定の「キー操作」で別のキーにします。この案内は設定 (⌘,) で変えたり消したりできます。'
		);
	});

	it('自分で書いた案内は、キーを差し込まずにそのまま返す。空文字も空のまま', () => {
		expect(draftGuidance('自分用のメモ {copy}', HOTKEY, DEFAULT_DRAFT_KEYS, 'macos')).toBe(
			'自分用のメモ {copy}'
		);
		expect(draftGuidance('', HOTKEY, DEFAULT_DRAFT_KEYS, 'macos')).toBe('');
	});
});
