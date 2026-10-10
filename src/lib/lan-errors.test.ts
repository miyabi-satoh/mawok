import { describe, expect, it } from 'vitest';
import { lanErrorMessage } from './lan-errors';
import { m } from '$lib/paraglide/messages';

describe('lanErrorMessage', () => {
	it('Rust 側の符号を、何をすればよいかの案内にする', () => {
		expect(lanErrorMessage('lan.unreachable')).toBe(m.lan_error_unreachable());
		expect(lanErrorMessage('lan.wrong_code')).toBe(m.lan_error_wrong_code());
		expect(lanErrorMessage('lan.internal')).toBe(m.lan_error_internal());
		expect(lanErrorMessage('lan.pro_required')).toBe(m.lan_error_pro_required());
		expect(lanErrorMessage('lan.receiver_pro_required')).toBe(m.lan_error_receiver_pro_required());
		expect(lanErrorMessage('lan.account_mismatch')).toBe(m.lan_error_account_mismatch());
	});

	it('符号でなければ、受け取った文字列をそのまま出す', () => {
		expect(lanErrorMessage('main window not found')).toBe('main window not found');
	});

	it('オブジェクトの持つ名前を符号と取り違えない', () => {
		expect(lanErrorMessage('toString')).toBe('toString');
		expect(lanErrorMessage('constructor')).toBe('constructor');
	});
});
