import type { Status } from '$lib/bindings/Status';

/**
 * 設定の「デバイス」に出す操作。
 * needsPairing は、同期の鍵を受け取り直すデバイス（確認コードの入力と、始め直す操作だけを出す）。
 * start は、追加したデバイスがまだ無い（確認コードの表示と入力の両方を出す）。
 */
export type DevicesPanel = 'needsPairing' | 'devices' | 'start';

export function devicesPanel(sharedKeyStatus: Status, deviceCount: number): DevicesPanel {
	if (sharedKeyStatus === 'needsPairing') return 'needsPairing';
	return deviceCount > 0 ? 'devices' : 'start';
}
