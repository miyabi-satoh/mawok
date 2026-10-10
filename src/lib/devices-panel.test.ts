import { describe, expect, it } from 'vitest';
import { devicesPanel } from '$lib/devices-panel';

describe('devicesPanel', () => {
	it('Pro でなければ鍵の状態にかかわらず Pro の案内を出す', () => {
		expect(devicesPanel(false, 'none')).toBe('pro');
		expect(devicesPanel(false, 'ready')).toBe('pro');
		expect(devicesPanel(false, 'needsPairing')).toBe('pro');
	});

	it('Pro では鍵の状態に応じた操作を出す', () => {
		expect(devicesPanel(true, 'none')).toBe('none');
		expect(devicesPanel(true, 'needsPairing')).toBe('needsPairing');
		expect(devicesPanel(true, 'ready')).toBe('ready');
	});
});
