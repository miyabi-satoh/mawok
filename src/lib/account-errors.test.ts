import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '$lib/bindings/constants';
import { m } from '$lib/paraglide/messages';
import { accountErrorMessage } from './account-errors';

describe('accountErrorMessage', () => {
	it('アカウントの符号を、何をすればよいかの案内にする', () => {
		expect(accountErrorMessage(ERROR_CODES.ACCOUNT_SIGN_IN_REQUIRED)).toBe(
			m.account_error_sign_in_required()
		);
		expect(accountErrorMessage(ERROR_CODES.UNEXPECTED)).toBe(m.account_error_unexpected());
	});

	it('符号でなければ null を返す', () => {
		expect(accountErrorMessage('the token is empty')).toBeNull();
		expect(accountErrorMessage('toString')).toBeNull();
	});
});
