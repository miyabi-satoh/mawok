import type { Status } from '$lib/bindings/Status';

/** 設定の「機器」に出す操作。Pro でなければ、鍵の状態より Pro の案内を優先する。 */
export type DevicesPanel = 'pro' | 'needsPairing' | 'ready' | 'none';

export function devicesPanel(proAvailable: boolean, accountKeyStatus: Status): DevicesPanel {
	if (!proAvailable) return 'pro';
	if (accountKeyStatus === 'needsPairing') return 'needsPairing';
	if (accountKeyStatus === 'ready') return 'ready';
	return 'none';
}
