import type { Status } from '$lib/bindings/Status';

/** 設定の「デバイス」に出す操作。Pro でなければ、鍵の状態より Pro の案内を優先する。 */
export type DevicesPanel = 'pro' | 'needsPairing' | 'ready' | 'none';

export function devicesPanel(proAvailable: boolean, sharedKeyStatus: Status): DevicesPanel {
	if (!proAvailable) return 'pro';
	if (sharedKeyStatus === 'needsPairing') return 'needsPairing';
	if (sharedKeyStatus === 'ready') return 'ready';
	return 'none';
}
