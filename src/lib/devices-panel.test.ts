import { describe, expect, it } from 'vitest';
import { devicesPanel } from '$lib/devices-panel';

describe('devicesPanel', () => {
	it('同期の鍵を受け取り直すデバイスでは、追加済みのデバイスがあっても確認コードの入力を出す', () => {
		expect(devicesPanel('needsPairing', 0)).toBe('needsPairing');
		expect(devicesPanel('needsPairing', 2)).toBe('needsPairing');
	});

	it('追加したデバイスが無ければ、確認コードの表示と入力の両方を出す', () => {
		expect(devicesPanel('none', 0)).toBe('start');
		expect(devicesPanel('ready', 0)).toBe('start');
	});

	it('追加したデバイスがあれば、一覧と追加・解除を出す', () => {
		expect(devicesPanel('none', 1)).toBe('devices');
		expect(devicesPanel('ready', 1)).toBe('devices');
	});
});
