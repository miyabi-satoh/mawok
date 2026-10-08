import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { updateButton, updateStatusText } from './update-status';

describe('更新の行', () => {
	it('様子ごとに文とボタンを選ぶ', () => {
		expect([
			updateStatusText({ state: 'unchecked' }),
			updateButton({ state: 'unchecked' })
		]).toEqual(['', 'check']);
		expect([updateStatusText({ state: 'checking' }), updateButton({ state: 'checking' })]).toEqual([
			m.settings_update_checking(),
			null
		]);
		expect([updateStatusText({ state: 'upToDate' }), updateButton({ state: 'upToDate' })]).toEqual([
			m.settings_update_up_to_date(),
			'check'
		]);
		expect([
			updateStatusText({ state: 'checkFailed' }),
			updateButton({ state: 'checkFailed' })
		]).toEqual([m.settings_update_check_failed(), 'check']);
	});

	it('新しい版があれば、版を添えて「更新して再起動」を出し、入れられなければもう一度押せる', () => {
		const version = '1.0.1';
		expect([
			updateStatusText({ state: 'available', version }),
			updateButton({ state: 'available', version })
		]).toEqual([m.settings_update_available({ version }), 'install']);
		expect([
			updateStatusText({ state: 'installing', version }),
			updateButton({ state: 'installing', version })
		]).toEqual([m.settings_update_installing({ version }), 'installing']);
		expect([
			updateStatusText({ state: 'installFailed', version }),
			updateButton({ state: 'installFailed', version })
		]).toEqual([m.settings_update_install_failed({ version }), 'install']);
	});
});
