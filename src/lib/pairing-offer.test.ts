import { describe, expect, it } from 'vitest';
import { pairingOfferDescription, pairingOfferRemainingSeconds } from './pairing-offer';

describe('pairingOfferDescription', () => {
	it('自動表示、手動表示、違うコードの後を分ける', () => {
		expect(pairingOfferDescription(false, false)).toBe('waiting');
		expect(pairingOfferDescription(true, false)).toBe('automatic');
		expect(pairingOfferDescription(false, true)).toBe('wrongCode');
		expect(pairingOfferDescription(true, true)).toBe('wrongCode');
	});
});

describe('pairingRemainingSeconds', () => {
	it('次のコードが届くまで、残り秒を0にせず表示を続ける', () => {
		expect(pairingOfferRemainingSeconds(10_000, 9_001)).toBe(1);
		expect(pairingOfferRemainingSeconds(10_000, 10_000)).toBe(1);
		expect(pairingOfferRemainingSeconds(10_000, 10_500)).toBe(1);
	});
});
