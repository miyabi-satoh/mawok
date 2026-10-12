import type { SettingsView } from '$lib/settings.svelte';

/** 既定から変えた設定なら、その名前（行に印を付け、data-modified に出す）。変えていなければ undefined */
export function modifiedName(
	view: Pick<SettingsView, 'modifiedSettings'>,
	name: string
): string | undefined {
	return view.modifiedSettings.includes(name) ? name : undefined;
}
