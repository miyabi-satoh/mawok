import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import {
	MIN_SYNC_PASSWORD_CHARS,
	newPasswordErrors,
	syncPanel,
	syncPasswordFailure,
	syncStateChanged
} from './sync-password';

const tooShort = () => m.sync_password_error_too_short({ count: MIN_SYNC_PASSWORD_CHARS });

describe('newPasswordErrors', () => {
	it('8 文字から通し、確認の欄と同じかを見る', () => {
		expect(MIN_SYNC_PASSWORD_CHARS).toBe(8);
		expect(newPasswordErrors('1234567', '1234567')).toEqual({ password: tooShort() });
		expect(newPasswordErrors('12345678', '12345678')).toEqual({});
		expect(newPasswordErrors('12345678', '12345679')).toEqual({
			confirm: m.sync_password_error_mismatch()
		});
	});

	it('短すぎるのを、一致しないより先に出す', () => {
		expect(newPasswordErrors('short', 'other')).toEqual({ password: tooShort() });
	});

	it('文字数をコードポイントで数える（Rust 側と同じ）', () => {
		expect(newPasswordErrors('あいうえおかき', 'あいうえおかき')).toEqual({ password: tooShort() });
		expect(newPasswordErrors('🔑🔑🔑🔑🔑🔑🔑🔑', '🔑🔑🔑🔑🔑🔑🔑🔑')).toEqual({});
	});
});

describe('syncPasswordFailure', () => {
	it('違うパスワードは、確かめた欄の下に出す', () => {
		expect(syncPasswordFailure('sync.wrong_password', 'password')).toEqual({
			password: m.sync_password_error_incorrect()
		});
		expect(syncPasswordFailure('sync.wrong_password', 'current')).toEqual({
			current: m.sync_password_error_incorrect()
		});
		expect(syncPasswordFailure('sync.password_too_short', 'current')).toEqual({
			password: tooShort()
		});
	});

	it('ほかの失敗は欄に出さない', () => {
		expect(syncPasswordFailure('account.unreachable', 'password')).toBeUndefined();
		expect(syncPasswordFailure('sync.state_changed', 'password')).toBeUndefined();
	});

	it('窓口の状態が変わっていたことを、ほかの失敗と見分ける', () => {
		expect(syncStateChanged('sync.state_changed')).toBe(true);
		expect(syncStateChanged('account.unreachable')).toBe(false);
	});
});

describe('syncPanel', () => {
	it('鍵の状態から、作る・入れる・同期の設定のどれを出すか決める', () => {
		expect(syncPanel('notStarted')).toBe('create');
		expect(syncPanel('needsPassword')).toBe('enter');
		expect(syncPanel('ready')).toBe('settings');
		// 窓口と照らす前（起動の直後など）は、今の同期の設定を出しておく
		expect(syncPanel('none')).toBe('settings');
	});
});
