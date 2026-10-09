import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { pricing } from '../src/pricing';

describe('pricing', () => {
	it('reads the values, with the monthly cap in milli_yen', () => {
		const values = {
			PURCHASE_GRANT_MILLI_YEN: '1000',
			FREE_GRANT_MILLI_YEN: '200',
			FREE_MONTHLY_CAP_YEN: '3',
			PRO_MONTHLY_GRANT_MILLI_YEN: '400',
			PRO_YEARLY_GRANT_MILLI_YEN: '500',
			USD_JPY: '120.5',
			INPUT_USD_PER_MTOK: '0.5',
			OUTPUT_USD_PER_MTOK: '2'
		};
		expect(pricing({ ...env, ...values } as Env)).toEqual({
			purchaseGrant: 1000,
			freeGrant: 200,
			freeMonthlyCap: 3000,
			proMonthlyGrant: 400,
			proYearlyGrant: 500,
			rates: { usdJpy: 120.5, inputUsdPerMtok: 0.5, outputUsdPerMtok: 2 }
		});
	});

	it('refuses a missing or unusable value, naming it', () => {
		for (const [name, value] of [
			['USD_JPY', undefined],
			['USD_JPY', ''],
			['USD_JPY', 'abc'],
			['USD_JPY', '0'],
			['INPUT_USD_PER_MTOK', '-1'],
			['PURCHASE_GRANT_MILLI_YEN', '1.5'],
			['FREE_GRANT_MILLI_YEN', 'Infinity'],
			['FREE_MONTHLY_CAP_YEN', undefined],
			['PRO_MONTHLY_GRANT_MILLI_YEN', '1.5'],
			['PRO_YEARLY_GRANT_MILLI_YEN', undefined],
			['OUTPUT_USD_PER_MTOK', 'x']
		]) {
			expect(() => pricing({ ...env, [name!]: value } as Env), `${name}=${value}`).toThrow(name!);
		}
	});
});
