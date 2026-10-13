import type { Device } from '$lib/settings.svelte';

/** 同じ名前のデバイスを見分けるために添える、公開鍵の先頭の文字数 */
const KEY_PREFIX_LENGTH = 4;

/**
 * 追加済みのデバイスの表示名。名前はコンピューター名なので、同じ名前のデバイスが2台以上あるときだけ、
 * 名前の後ろに公開鍵の先頭4文字を添えて見分ける（docs/lan.md「デバイスを追加する」）
 */
export function deviceLabels(devices: Device[]): Map<string, string> {
	const counts = new Map<string, number>();
	for (const device of devices) {
		counts.set(device.name, (counts.get(device.name) ?? 0) + 1);
	}
	return new Map(
		devices.map((device) => [
			device.publicKey,
			(counts.get(device.name) ?? 0) > 1
				? `${device.name} (${device.publicKey.slice(0, KEY_PREFIX_LENGTH)})`
				: device.name
		])
	);
}
