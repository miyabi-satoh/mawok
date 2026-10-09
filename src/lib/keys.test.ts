import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { DEFAULT_DRAFT_KEYS } from '$lib/test-support/settings-view';
import {
	DRAFT_ACTIONS,
	DRAFT_ACTIONS_IN_SETTINGS,
	draftActionFor,
	isCloseWindowKey,
	isDismissKey,
	keyHint,
	keyLabels,
	keyRejectionMessage,
	platformFromUrl,
	toAccelerator
} from './keys';

describe('DRAFT_ACTIONS_IN_SETTINGS', () => {
	it('設定画面に、どの操作も1回ずつ並ぶ', () => {
		expect([...DRAFT_ACTIONS_IN_SETTINGS].sort()).toEqual([...DRAFT_ACTIONS].sort());
	});
});

describe('keyLabels', () => {
	it('Mac では CommandOrControl+Shift+Space を ⌘ ⇧ Space に分けて表示する', () => {
		expect(keyLabels('CommandOrControl+Shift+Space', 'macos')).toEqual(['⌘', '⇧', 'Space']);
	});

	it('Windows では CommandOrControl を Ctrl と表示する', () => {
		expect(keyLabels('CommandOrControl+Shift+Space', 'windows')).toEqual([
			'Ctrl',
			'Shift',
			'Space'
		]);
	});

	it('Mac では Control を ⌃、Alt を ⌥ と表示する', () => {
		expect(keyLabels('Control+Alt+Space', 'macos')).toEqual(['⌃', '⌥', 'Space']);
	});

	it('Windows では Super を Win と表示する', () => {
		expect(keyLabels('Super+Alt+Space', 'windows')).toEqual(['Win', 'Alt', 'Space']);
	});

	it('英字と数字のキーは Key と Digit を外して表示する', () => {
		expect(keyLabels('CommandOrControl+KeyK', 'windows')).toEqual(['Ctrl', 'K']);
		expect(keyLabels('CommandOrControl+Digit1', 'macos')).toEqual(['⌘', '1']);
	});

	it('記号と矢印のキーは刻印と同じ見た目にし、Mac の Backspace は ⌫ にする', () => {
		expect(keyLabels('CommandOrControl+Comma', 'macos')).toEqual(['⌘', ',']);
		expect(keyLabels('CommandOrControl+Alt+ArrowUp', 'windows')).toEqual(['Ctrl', 'Alt', '↑']);
		expect(keyLabels('CommandOrControl+Shift+Backspace', 'macos')).toEqual(['⌘', '⇧', '⌫']);
		expect(keyLabels('CommandOrControl+Shift+Backspace', 'windows')).toEqual([
			'Ctrl',
			'Shift',
			'Backspace'
		]);
	});
});

const keydown = (
	code: string,
	mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}
) => ({
	code,
	metaKey: mods.meta ?? false,
	ctrlKey: mods.ctrl ?? false,
	altKey: mods.alt ?? false,
	shiftKey: mods.shift ?? false
});

describe('toAccelerator', () => {
	it('Mac で ⌘⇧K を押すと CommandOrControl+Shift+KeyK になる', () => {
		expect(toAccelerator(keydown('KeyK', { meta: true, shift: true }), 'macos')).toBe(
			'CommandOrControl+Shift+KeyK'
		);
	});

	it('Windows で Ctrl+Shift+K を押すと CommandOrControl+Shift+KeyK になる', () => {
		expect(toAccelerator(keydown('KeyK', { ctrl: true, shift: true }), 'windows')).toBe(
			'CommandOrControl+Shift+KeyK'
		);
	});

	it('Mac の ⌃ と ⌥ は Control と Alt になり、修飾キーは決まった順に並ぶ', () => {
		expect(
			toAccelerator(keydown('Space', { meta: true, ctrl: true, alt: true, shift: true }), 'macos')
		).toBe('CommandOrControl+Control+Alt+Shift+Space');
	});

	it('Windows の Win キーは Super になる', () => {
		expect(toAccelerator(keydown('KeyD', { meta: true, alt: true }), 'windows')).toBe(
			'Super+Alt+KeyD'
		);
	});

	it('修飾キーなしや Shift だけでは、普段の文字の入力を奪うので受け付けない', () => {
		expect(toAccelerator(keydown('KeyK'), 'macos')).toBeNull();
		expect(toAccelerator(keydown('KeyK', { shift: true }), 'macos')).toBeNull();
	});

	it('修飾キーを押し始めただけでは、本体のキーを待つので受け付けない', () => {
		expect(toAccelerator(keydown('MetaLeft', { meta: true }), 'macos')).toBeNull();
	});

	it('ホットキーとして登録できないキー（JIS キーボードの ¥ など）は受け付けない', () => {
		expect(toAccelerator(keydown('IntlYen', { meta: true }), 'macos')).toBeNull();
	});
});

describe('isDismissKey', () => {
	it('変換中でない Esc で隠す', () => {
		expect(isDismissKey({ key: 'Escape', isComposing: false, keyCode: 27 })).toBe(true);
	});

	it('変換中の Esc では隠さない', () => {
		expect(isDismissKey({ key: 'Escape', isComposing: true, keyCode: 27 })).toBe(false);
	});

	it('IME が処理した Esc（keyCode 229）では隠さない', () => {
		expect(isDismissKey({ key: 'Escape', isComposing: false, keyCode: 229 })).toBe(false);
	});

	it('Esc 以外のキーでは隠さない', () => {
		expect(isDismissKey({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(false);
	});
});

describe('draftActionFor', () => {
	const press = (
		code: string,
		mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
		ime: { isComposing?: boolean; keyCode?: number } = {}
	) => ({
		...keydown(code, mods),
		isComposing: ime.isComposing ?? false,
		keyCode: ime.keyCode ?? 0
	});

	it('Mac では ⌘Enter でコピー、⌘⇧Enter で送る', () => {
		expect(draftActionFor(press('Enter', { meta: true }), DEFAULT_DRAFT_KEYS, 'macos')).toBe(
			'copy'
		);
		expect(
			draftActionFor(press('Enter', { meta: true, shift: true }), DEFAULT_DRAFT_KEYS, 'macos')
		).toBe('send');
	});

	it('Windows では Ctrl で同じ操作になり、Mac の ⌘ に当たる Win キーでは呼ばない', () => {
		expect(draftActionFor(press('KeyJ', { ctrl: true }), DEFAULT_DRAFT_KEYS, 'windows')).toBe(
			'snippets'
		);
		expect(draftActionFor(press('KeyJ', { meta: true }), DEFAULT_DRAFT_KEYS, 'windows')).toBeNull();
	});

	it('Mac の ⌃ は ⌘ と別のキーとして扱う（⌃K は行末まで消す操作）', () => {
		expect(draftActionFor(press('KeyK', { ctrl: true }), DEFAULT_DRAFT_KEYS, 'macos')).toBeNull();
	});

	it('修飾キーのないキーや、割り当てのないキーでは呼ばない', () => {
		expect(draftActionFor(press('Enter'), DEFAULT_DRAFT_KEYS, 'macos')).toBeNull();
		expect(draftActionFor(press('KeyM', { meta: true }), DEFAULT_DRAFT_KEYS, 'macos')).toBeNull();
	});

	it('設定で変えたキーで呼び、元のキーでは呼ばない', () => {
		const keys = { ...DEFAULT_DRAFT_KEYS, copy: 'CommandOrControl+KeyJ', snippets: '' };
		expect(draftActionFor(press('KeyJ', { meta: true }), keys, 'macos')).toBe('copy');
		expect(draftActionFor(press('Enter', { meta: true }), keys, 'macos')).toBeNull();
	});

	it('テンキーの Enter は Enter として扱う', () => {
		expect(
			draftActionFor(press('NumpadEnter', { ctrl: true }), DEFAULT_DRAFT_KEYS, 'windows')
		).toBe('copy');
	});

	it('割り当てを外した操作は呼ばない', () => {
		const keys = { ...DEFAULT_DRAFT_KEYS, settings: '' };
		expect(draftActionFor(press('Comma', { meta: true }), keys, 'macos')).toBeNull();
	});

	it('変換中は呼ばない', () => {
		expect(
			draftActionFor(
				press('Enter', { meta: true }, { isComposing: true }),
				DEFAULT_DRAFT_KEYS,
				'macos'
			)
		).toBeNull();
		expect(
			draftActionFor(
				press('Enter', { ctrl: true }, { keyCode: 229 }),
				DEFAULT_DRAFT_KEYS,
				'windows'
			)
		).toBeNull();
	});
});

describe('keyHint', () => {
	it('キーがあれば説明に添え、なければ説明だけにする', () => {
		expect(keyHint('設定を開く', 'CommandOrControl+Comma', 'macos')).toBe(
			m.key_hint({ label: '設定を開く', keys: '⌘,' })
		);
		expect(keyHint('設定を開く', '', 'macos')).toBe('設定を開く');
	});
});

describe('keyRejectionMessage', () => {
	it('理由の符号を、キーと重なっている相手を書いた文にする', () => {
		expect(keyRejectionMessage('keys.action.snippets', 'CommandOrControl+KeyJ', 'macos')).toBe(
			m.settings_key_used_by_action({ keys: '⌘J', action: m.settings_key_snippets() })
		);
		expect(keyRejectionMessage('keys.hotkey', 'CommandOrControl+Shift+Space', 'windows')).toBe(
			m.settings_key_used_by_hotkey({ keys: 'Ctrl+Shift+Space' })
		);
		expect(keyRejectionMessage('keys.editing', 'CommandOrControl+KeyV', 'macos')).toBe(
			m.settings_key_editing({ keys: '⌘V' })
		);
		expect(keyRejectionMessage('keys.invalid', 'Alt+KeyV', 'macos')).toBe(
			m.settings_key_invalid({ keys: '⌥V' })
		);
	});

	it('符号でなければ、受け取ったものをそのまま出す', () => {
		expect(keyRejectionMessage('keys.action.unknown', 'Alt+KeyV', 'macos')).toBe(
			'keys.action.unknown'
		);
		expect(keyRejectionMessage('saving failed', 'Alt+KeyV', 'macos')).toBe('saving failed');
	});
});

describe('isCloseWindowKey', () => {
	const key = (key: string, overrides: Partial<KeyboardEvent> = {}) => ({
		key,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		isComposing: false,
		keyCode: 0,
		...overrides
	});

	it('Esc で閉じる', () => {
		expect(isCloseWindowKey(key('Escape'), 'macos')).toBe(true);
		expect(isCloseWindowKey(key('Escape'), 'windows')).toBe(true);
	});

	it('Mac では Cmd+W で閉じる', () => {
		expect(isCloseWindowKey(key('w', { metaKey: true }), 'macos')).toBe(true);
	});

	it('Windows では Ctrl+W で閉じる', () => {
		expect(isCloseWindowKey(key('w', { ctrlKey: true }), 'windows')).toBe(true);
	});

	it('Shift を押していて大文字で届く W でも閉じる', () => {
		expect(isCloseWindowKey(key('W', { metaKey: true }), 'macos')).toBe(true);
	});

	it('修飾キーなしの W では閉じない（入力欄に文字を打てなくなるため）', () => {
		expect(isCloseWindowKey(key('w'), 'macos')).toBe(false);
	});

	it('別の OS の組み合わせでは閉じない', () => {
		expect(isCloseWindowKey(key('w', { ctrlKey: true }), 'macos')).toBe(false);
		expect(isCloseWindowKey(key('w', { metaKey: true }), 'windows')).toBe(false);
	});

	it('修飾キー付きの Esc では閉じない', () => {
		expect(isCloseWindowKey(key('Escape', { metaKey: true }), 'macos')).toBe(false);
	});

	it('変換中は閉じない（変換の取り消しを横取りしない）', () => {
		expect(isCloseWindowKey(key('Escape', { isComposing: true }), 'macos')).toBe(false);
	});

	it('IME が処理したキー（keyCode 229）では閉じない', () => {
		expect(isCloseWindowKey(key('Escape', { keyCode: 229 }), 'macos')).toBe(false);
	});

	it('関係のないキーでは閉じない', () => {
		expect(isCloseWindowKey(key('Enter'), 'macos')).toBe(false);
	});
});

describe('platformFromUrl', () => {
	it('?platform=macos なら macOS', () => {
		expect(platformFromUrl(new URL('http://localhost/manual?platform=macos'))).toBe('macos');
	});

	it('windows・無い・知らない値は Windows', () => {
		expect(platformFromUrl(new URL('http://localhost/manual?platform=windows'))).toBe('windows');
		expect(platformFromUrl(new URL('http://localhost/manual'))).toBe('windows');
		expect(platformFromUrl(new URL('http://localhost/manual?platform=linux'))).toBe('windows');
	});
});
