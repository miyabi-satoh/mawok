import type { Device } from '$lib/settings.svelte';

/**
 * 文の中に並べる機器名を、ハイフンのところで改行させない。living-room-pc が「living-」と「room-pc」に分かれると読みにくいため。
 * ハイフンの後ろでの折り返しは CSS では止められないので、改行させない印（WORD JOINER）を挟む。空白では今までどおり折り返す
 */
export function unbrokenAtHyphens(name: string): string {
	return name.replaceAll('-', '-⁠');
}

/** 同じ名前の機器を見分けるために添える、公開鍵の先頭の文字数 */
const KEY_PREFIX_LENGTH = 4;

/**
 * 見つけた同じアカウントの機器の表示名。名前はコンピューター名なので、同じ名前の機器が2台以上あるときだけ、
 * 名前の後ろに公開鍵の先頭4文字を添えて見分ける（docs/lan.md「同じ LAN の自分の機器へ送る」）
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
